'use strict';

const express    = require('express');
const http       = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const puppeteer  = require('puppeteer-core');
const path       = require('path');
const fs         = require('fs');
const Database   = require('better-sqlite3');

const CHROME_PATH =
  process.env.CHROME_PATH ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const PORT     = process.env.PORT || 3000;
const VIEWPORT = { width: 1920, height: 1080 };

// ─── HTTP + WebSocket server setup ───────────────────────────────────────────

const app        = express();
const httpServer = http.createServer(app);
const wss        = new WebSocketServer({ server: httpServer });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── SQLite storage ───────────────────────────────────────────────────────────

const DB_PATH = path.join(__dirname, 'recordings.db');
const db      = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS recordings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    url         TEXT    NOT NULL,
    event_count INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL,
    events      TEXT    NOT NULL DEFAULT '[]',
    responses   TEXT    NOT NULL DEFAULT '[]'
  )
`);
// Add responses column to existing DBs (safe no-op if already present)
try { db.exec(`ALTER TABLE recordings ADD COLUMN responses TEXT NOT NULL DEFAULT '[]'`); } catch {}

const stmts = {
  insertRecording: db.prepare(
    `INSERT INTO recordings (name, url, event_count, created_at, events, responses)
     VALUES (@name, @url, @event_count, @created_at, @events, @responses)`
  ),
  allMeta: db.prepare(
    `SELECT id, name, url, event_count AS eventCount, created_at AS createdAt
     FROM recordings ORDER BY id`
  ),
  getMeta: db.prepare(
    `SELECT id, name, url, event_count AS eventCount, created_at AS createdAt
     FROM recordings WHERE id = ?`
  ),
  getEvents:     db.prepare(`SELECT events    FROM recordings WHERE id = ?`),
  getResponses:  db.prepare(`SELECT responses FROM recordings WHERE id = ?`),
  deleteRecording: db.prepare(`DELETE FROM recordings WHERE id = ?`),
};

// Migrate from old file-based storage (one-time, then ignored)
(function migrate() {
  const META_FILE = path.join(__dirname, 'recordings', 'meta.json');
  if (!fs.existsSync(META_FILE)) return;
  try {
    const oldMeta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    if (!Array.isArray(oldMeta) || oldMeta.length === 0) return;
    const existing = new Set(stmts.allMeta.all().map(r => r.id));
    let migrated = 0;
    const insert = db.transaction(() => {
      for (const rec of oldMeta) {
        if (existing.has(rec.id)) continue;
        const evFile = path.join(__dirname, 'recordings', `${rec.id}.events.json`);
        const events = fs.existsSync(evFile)
          ? fs.readFileSync(evFile, 'utf8')
          : '[]';
        db.prepare(
          `INSERT INTO recordings (id, name, url, event_count, created_at, events)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(rec.id, rec.name, rec.url, rec.eventCount ?? 0, rec.createdAt ?? new Date().toISOString(), events);
        migrated++;
      }
    });
    insert();
    if (migrated > 0)
      console.log(`[Storage] Migrated ${migrated} recording(s) from file storage to SQLite.`);
  } catch (err) {
    console.error('[Storage] Migration error (non-fatal):', err.message);
  }
})();

function dbAllMeta()              { return stmts.allMeta.all(); }
function dbGetMeta(id)            { return stmts.getMeta.get(id) ?? null; }
function dbLoadEvents(id) {
  const row = stmts.getEvents.get(id);
  if (!row) return null;
  try { return JSON.parse(row.events); } catch { return null; }
}
function dbLoadResponses(id) {
  const row = stmts.getResponses.get(id);
  if (!row) return [];
  try { return JSON.parse(row.responses); } catch { return []; }
}
function dbSaveRecording(name, url, eventCount, createdAt, events, responses) {
  const info = stmts.insertRecording.run({
    name, url,
    event_count: eventCount,
    created_at:  createdAt,
    events:      JSON.stringify(events),
    responses:   JSON.stringify(responses),
  });
  return info.lastInsertRowid;
}
function dbDeleteRecording(id) { stmts.deleteRecording.run(id); }

// ─── Puppeteer session state ──────────────────────────────────────────────────

let browser       = null;   // Puppeteer Browser
let activePage    = null;   // current page
let cdpSession    = null;   // CDP session for screencasting
let activeWs      = null;   // connected frontend WebSocket

let isRecording        = false;
let capturedEvents     = [];
let capturedResponses  = [];    // HTTP responses recorded during a session
let recordingStartTime = null;
let currentUrl         = 'about:blank';
let firstNavigateDone  = false; // suppress navigate event on very first load
let sessionCookies     = [];    // cookies applied on every navigation

// ─── Capture script (injected via evaluateOnNewDocument) ─────────────────────
// This runs in EVERY page context regardless of how navigation happened
// (JS redirect, link click, form submit, etc.). Replaces the proxy injection approach.

function buildCaptureScript() {
  return `(function () {
    if (window.__CDP_CAPTURE_ACTIVE__) return;
    window.__CDP_CAPTURE_ACTIVE__ = true;

    const cap = window.__captureEvent;
    if (!cap) return;

    const MOVE_THROTTLE   = 50;
    const SCROLL_THROTTLE = 100;
    let lastMove = 0, lastScroll = 0;

    function btn(b) { return b === 2 ? 'right' : b === 1 ? 'middle' : 'left'; }

    document.addEventListener('click',
      e => cap('click', { x: e.clientX, y: e.clientY, button: btn(e.button) }), true);
    document.addEventListener('dblclick',
      e => cap('dblclick', { x: e.clientX, y: e.clientY }), true);
    document.addEventListener('mousedown',
      e => cap('mousedown', { x: e.clientX, y: e.clientY, button: btn(e.button) }), true);
    document.addEventListener('mouseup',
      e => cap('mouseup',   { x: e.clientX, y: e.clientY, button: btn(e.button) }), true);

    document.addEventListener('mousemove', e => {
      const now = Date.now();
      if (now - lastMove < MOVE_THROTTLE) return;
      lastMove = now;
      cap('mousemove', { x: e.clientX, y: e.clientY });
    }, true);

    document.addEventListener('wheel',
      e => cap('wheel', { x: e.clientX, y: e.clientY, deltaX: e.deltaX, deltaY: e.deltaY }),
      { capture: true, passive: true });

    window.addEventListener('scroll', () => {
      const now = Date.now();
      if (now - lastScroll < SCROLL_THROTTLE) return;
      lastScroll = now;
      cap('scroll', { scrollX: window.scrollX, scrollY: window.scrollY });
    }, true);

    document.addEventListener('keydown',
      e => cap('keydown', {
        key: e.key, code: e.code,
        ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey,
      }), true);
    document.addEventListener('keyup',
      e => cap('keyup', { key: e.key, code: e.code }), true);

    document.addEventListener('input', e => {
      const el = e.target;
      if (!el) return;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        cap('input', { value: el.value });
      } else if (el.isContentEditable) {
        cap('contenteditable', { html: el.innerHTML, text: el.innerText });
      }
    }, true);

    document.addEventListener('change', e => {
      if (e.target && e.target.tagName === 'SELECT')
        cap('select', { value: e.target.value });
    }, true);
  })();`;
}

// ─── Browser session lifecycle ────────────────────────────────────────────────

async function launchSession() {
  console.log('[Browser] Launching Puppeteer …');
  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',          // allow cross-origin iframes if any
      '--disable-features=IsolateOrigins,site-per-process',
    ],
    defaultViewport: VIEWPORT,
  });

  [activePage] = await browser.pages();

  // Expose capture bridge: page JS → Node.js handler
  await activePage.exposeFunction('__captureEvent', (type, data) => {
    if (!isRecording) return;
    const now = Date.now();
    if (recordingStartTime === null) recordingStartTime = now;
    const ev = { type, ...data, t: now - recordingStartTime };
    capturedEvents.push(ev);
    send({ type: 'recording-event', count: capturedEvents.length });
  });

  // Inject capture script on EVERY navigation (JS redirect, meta refresh, link, etc.)
  await activePage.evaluateOnNewDocument(buildCaptureScript());

  // Track URL changes
  activePage.on('framenavigated', frame => {
    if (frame !== activePage.mainFrame()) return;
    const url = frame.url();
    if (url === currentUrl || url === 'about:blank') return;

    if (isRecording && firstNavigateDone) {
      const ev = { type: 'navigate', url, t: Date.now() - recordingStartTime };
      capturedEvents.push(ev);
      send({ type: 'recording-event', count: capturedEvents.length });
    }
    firstNavigateDone = true;
    currentUrl = url;
    send({ type: 'url-changed', url });
  });

  // Capture HTTP responses during recording
  activePage.on('response', response => {
    if (!isRecording) return;
    const url = response.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    const t = Date.now() - (recordingStartTime ?? Date.now());
    capturedResponses.push({ url, status: response.status(), t });
  });

  // Handle page crashes / unexpected closes
  browser.on('disconnected', () => {
    console.log('[Browser] Disconnected');
    browser = null; activePage = null; cdpSession = null;
  });

  // Start CDP screencasting
  await startScreencast();

  console.log('[Browser] Ready');
}

async function startScreencast() {
  cdpSession = await activePage.createCDPSession();
  await cdpSession.send('Page.startScreencast', {
    format:        'jpeg',
    quality:       75,
    maxWidth:      VIEWPORT.width,
    maxHeight:     VIEWPORT.height,
    everyNthFrame: 1,
  });

  cdpSession.on('Page.screencastFrame', async ({ data, sessionId }) => {
    // Forward JPEG frame to the connected frontend
    if (activeWs?.readyState === WebSocket.OPEN) {
      activeWs.send(JSON.stringify({ type: 'frame', data }));
    }
    // Must ack to receive next frame
    await cdpSession.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
}

// ─── WebSocket connection handler ─────────────────────────────────────────────

wss.on('connection', async ws => {
  console.log('[WS] Client connected');
  activeWs = ws;

  try {
    if (!browser) await launchSession();
    ws.send(JSON.stringify({ type: 'ready', viewport: VIEWPORT }));
    ws.send(JSON.stringify({ type: 'url-changed', url: currentUrl }));
    ws.send(JSON.stringify({ type: 'recordings', list: dbAllMeta() }));
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
    console.error('[WS] Session launch error:', err.message);
  }

  ws.on('message', async raw => {
    try { await handleClientMessage(JSON.parse(raw.toString()), ws); }
    catch (err) { console.error('[WS] Handler error:', err.message); }
  });

  ws.on('close', () => {
    if (activeWs === ws) activeWs = null;
    console.log('[WS] Client disconnected');
  });
});

function send(msg) {
  if (activeWs?.readyState === WebSocket.OPEN)
    activeWs.send(JSON.stringify(msg));
}

// ─── Client message dispatcher ────────────────────────────────────────────────

async function handleClientMessage(msg, ws) {
  if (!activePage) {
    ws.send(JSON.stringify({ type: 'error', message: '브라우저 세션이 없습니다.' }));
    return;
  }

  switch (msg.type) {

    // ── Navigation ───────────────────────────────────────────────────────────
    case 'navigate': {
      firstNavigateDone = false;
      if (sessionCookies.length > 0) await activePage.setCookie(...sessionCookies);
      await activePage.goto(msg.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      break;
    }

    // ── Cookie management ────────────────────────────────────────────────────
    case 'set-cookies': {
      sessionCookies = (msg.cookies ?? []).filter(c => c.name && c.value);
      if (sessionCookies.length > 0) {
        await activePage.setCookie(...sessionCookies);
        console.log(`[Cookies] Set ${sessionCookies.length} cookie(s)`);
      }
      ws.send(JSON.stringify({ type: 'cookies-applied', count: sessionCookies.length }));
      break;
    }

    // ── Mouse events ─────────────────────────────────────────────────────────
    case 'mousemove':
      await activePage.mouse.move(msg.x, msg.y);
      break;
    case 'mousedown':
      await activePage.mouse.move(msg.x, msg.y);
      await activePage.mouse.down({ button: msg.button ?? 'left' });
      break;
    case 'mouseup':
      await activePage.mouse.move(msg.x, msg.y);
      await activePage.mouse.up({ button: msg.button ?? 'left' });
      break;
    case 'click':
      await activePage.mouse.click(msg.x, msg.y, { button: msg.button ?? 'left' });
      break;
    case 'dblclick':
      await activePage.mouse.click(msg.x, msg.y, { clickCount: 2 });
      break;
    case 'wheel':
      await activePage.mouse.wheel({ deltaX: msg.deltaX ?? 0, deltaY: msg.deltaY ?? 0 });
      break;

    // ── Keyboard events ───────────────────────────────────────────────────────
    case 'keydown':
      await activePage.keyboard.down(msg.key === ' ' ? 'Space' : msg.key);
      break;
    case 'keyup':
      await activePage.keyboard.up(msg.key === ' ' ? 'Space' : msg.key);
      break;

    // ── Recording ─────────────────────────────────────────────────────────────
    case 'start-recording':
      isRecording        = true;
      capturedEvents     = [];
      capturedResponses  = [];
      recordingStartTime = null;
      firstNavigateDone  = true;
      ws.send(JSON.stringify({ type: 'recording-started' }));
      console.log('[Recording] Started');
      break;

    case 'stop-recording': {
      isRecording = false;
      console.log(`[Recording] Stopped — ${capturedEvents.length} events, ${capturedResponses.length} responses`);
      if (capturedEvents.length === 0) {
        ws.send(JSON.stringify({ type: 'recording-empty' }));
        break;
      }
      const createdAt = new Date().toISOString();
      const newId     = dbSaveRecording(
        `녹화 #?`,
        currentUrl,
        capturedEvents.length,
        createdAt,
        [...capturedEvents],
        [...capturedResponses],
      );
      // Update name to reflect actual auto-increment id
      db.prepare(`UPDATE recordings SET name = ? WHERE id = ?`)
        .run(`녹화 #${newId}`, newId);
      const meta = dbGetMeta(newId);
      ws.send(JSON.stringify({ type: 'recording-saved', recording: meta }));
      ws.send(JSON.stringify({ type: 'recordings', list: dbAllMeta() }));
      console.log(`[Recording] Saved as id=${newId}`);
      break;
    }

    // ── Replay ────────────────────────────────────────────────────────────────
    case 'replay': {
      const meta = dbGetMeta(msg.id);
      if (!meta) break;
      const events    = dbLoadEvents(msg.id);
      if (!events) break;
      const responses = dbLoadResponses(msg.id);
      await runReplay(events, responses, meta.url, msg.speedFactor ?? 1.0, ws);
      break;
    }

    // ── Delete ────────────────────────────────────────────────────────────────
    case 'delete-recording': {
      dbDeleteRecording(msg.id);
      ws.send(JSON.stringify({ type: 'recordings', list: dbAllMeta() }));
      break;
    }
  }
}

// ─── Replay engine ────────────────────────────────────────────────────────────

// Wait until network goes idle (≤2 concurrent requests for idleTime ms).
// Silently absorbs timeout — some pages keep persistent connections.
async function waitNetworkIdle(timeout = 5000) {
  try {
    await activePage.waitForNetworkIdle({ idleTime: 500, timeout });
  } catch {}
}

// Events that typically trigger network requests and warrant idle-waiting
const NETWORK_EVENTS = new Set(['navigate', 'click', 'dblclick']);

// Build a lookup map from URL → [recorded statuses] for comparison
function buildResponseMap(responses) {
  const map = new Map();
  for (const r of responses) {
    const key = normalizeUrl(r.url);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r.status);
  }
  return map;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.search = ''; // strip query params (tokens, timestamps etc. vary per run)
    return u.toString();
  } catch { return url; }
}

function compareResponses(recorded, actual) {
  const recMap = buildResponseMap(recorded);
  const results = [];
  for (const r of actual) {
    const key      = normalizeUrl(r.url);
    const expected = recMap.get(key);
    if (!expected) continue;          // new URL not in recording — skip
    const match = expected.includes(r.status);
    results.push({ url: r.url, expected: expected[0], actual: r.status, pass: match });
  }
  return results;
}

async function runReplay(events, recordedResponses, startUrl, speedFactor, ws) {
  ws.send(JSON.stringify({ type: 'replay-started' }));

  const replayResponses = [];
  const onResponse = response => {
    const url = response.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    replayResponses.push({ url, status: response.status() });
  };
  activePage.on('response', onResponse);

  try {
    firstNavigateDone = false;
    if (sessionCookies.length > 0) await activePage.setCookie(...sessionCookies);
    await activePage.goto(startUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    const total = events.length;
    let lastT   = 0;

    for (let i = 0; i < total; i++) {
      const ev    = events[i];
      const delay = Math.max(0, ((ev.t ?? 0) - lastT) / speedFactor);
      if (delay > 0) await sleep(delay);
      lastT = ev.t ?? 0;

      await dispatchReplayEvent(ev);

      if (NETWORK_EVENTS.has(ev.type)) await waitNetworkIdle(5000);
      if (ev.type === 'keydown' && (ev.key === 'Enter' || ev.code === 'Enter'))
        await waitNetworkIdle(5000);

      if (i % 5 === 0 || i === total - 1)
        ws.send(JSON.stringify({ type: 'replay-progress', done: i + 1, total }));
    }
  } finally {
    activePage.off('response', onResponse);
  }

  // Compare recorded vs actual responses and send result
  const results = recordedResponses.length > 0
    ? compareResponses(recordedResponses, replayResponses)
    : [];

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  ws.send(JSON.stringify({ type: 'replay-done' }));
  ws.send(JSON.stringify({ type: 'replay-result', results, passed, failed, total: results.length }));
  console.log(`[Replay] Done — responses: ${passed} pass / ${failed} fail`);
}

const BTN = b => (b === 'right' ? 'right' : b === 'middle' ? 'middle' : 'left');

async function dispatchReplayEvent(ev) {
  try {
    switch (ev.type) {
      case 'navigate':
        if (sessionCookies.length > 0) await activePage.setCookie(...sessionCookies);
        await activePage.goto(ev.url, { waitUntil: 'networkidle2', timeout: 30000 });
        break;
      case 'click':
        await activePage.mouse.click(ev.x, ev.y, { button: BTN(ev.button) });
        break;
      case 'dblclick':
        await activePage.mouse.click(ev.x, ev.y, { clickCount: 2 });
        break;
      case 'mousedown':
        await activePage.mouse.move(ev.x, ev.y);
        await activePage.mouse.down({ button: BTN(ev.button) });
        break;
      case 'mouseup':
        await activePage.mouse.move(ev.x, ev.y);
        await activePage.mouse.up({ button: BTN(ev.button) });
        break;
      case 'mousemove':
        await activePage.mouse.move(ev.x, ev.y);
        break;
      case 'wheel':
        await activePage.mouse.wheel({ deltaX: ev.deltaX, deltaY: ev.deltaY });
        break;
      case 'scroll':
        await activePage.evaluate((x, y) => window.scrollTo(x, y), ev.scrollX, ev.scrollY);
        break;
      case 'keydown':
        await activePage.keyboard.down(ev.key === ' ' ? 'Space' : ev.key);
        break;
      case 'keyup':
        await activePage.keyboard.up(ev.key === ' ' ? 'Space' : ev.key);
        break;
      case 'input':
        await activePage.keyboard.down('Control');
        await activePage.keyboard.press('a');
        await activePage.keyboard.up('Control');
        await activePage.keyboard.type(ev.value ?? '');
        break;
      case 'contenteditable':
        await activePage.evaluate(
          h => { if (document.activeElement) document.activeElement.innerHTML = h; },
          ev.html
        );
        break;
    }
  } catch {}
}

// ─── REST API — recordings ────────────────────────────────────────────────────

app.get('/api/recordings', (_req, res) => res.json(dbAllMeta()));

app.get('/api/recordings/:id', (req, res) => {
  const meta = dbGetMeta(+req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  const events = dbLoadEvents(meta.id);
  if (!events) return res.status(500).json({ error: 'Events not found' });
  res.json({ ...meta, events });
});

app.delete('/api/recordings/:id', (req, res) => {
  const meta = dbGetMeta(+req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  dbDeleteRecording(meta.id);
  res.json({ ok: true });
});

// ─── REST API — Puppeteer script export ───────────────────────────────────────

app.get('/api/recordings/:id/export/puppeteer', (req, res) => {
  const meta = dbGetMeta(+req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  const events = dbLoadEvents(meta.id);
  if (!events) return res.status(500).json({ error: 'Events not found' });

  const filename = `${meta.name.replace(/[^\w\s-]/g, '_')}.js`;
  res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(generateScript({ ...meta, events }));
});

function generateScript(rec) {
  const BTN = b => b === 'right' ? "'right'" : b === 'middle' ? "'middle'" : "'left'";
  const lines = [
    `'use strict';`,
    `// Generated by Browser Automation Tool`,
    `// Recording : ${rec.name}  |  URL: ${rec.url}  |  Events: ${rec.events.length}`,
    ``,
    `const puppeteer = require('puppeteer');`,
    `(async () => {`,
    `  const browser = await puppeteer.launch({ headless: false, defaultViewport: null });`,
    `  const [page] = await browser.pages();`,
    `  await page.goto(${JSON.stringify(rec.url)}, { waitUntil: 'domcontentloaded' });`,
    ``,
  ];
  let prevT = 0;
  for (const ev of rec.events) {
    const d = Math.max(0, (ev.t ?? 0) - prevT); prevT = ev.t ?? 0;
    if (d > 0) lines.push(`  await new Promise(r => setTimeout(r, ${d}));`);
    switch (ev.type) {
      case 'navigate':    lines.push(`  await page.goto(${JSON.stringify(ev.url)}, { waitUntil: 'domcontentloaded' });`); break;
      case 'click':       lines.push(`  await page.mouse.click(${ev.x}, ${ev.y}, { button: ${BTN(ev.button)} });`); break;
      case 'dblclick':    lines.push(`  await page.mouse.click(${ev.x}, ${ev.y}, { clickCount: 2 });`); break;
      case 'mousemove':   lines.push(`  await page.mouse.move(${ev.x}, ${ev.y});`); break;
      case 'wheel':       lines.push(`  await page.mouse.wheel({ deltaX: ${ev.deltaX}, deltaY: ${ev.deltaY} });`); break;
      case 'scroll':      lines.push(`  await page.evaluate(() => window.scrollTo(${ev.scrollX}, ${ev.scrollY}));`); break;
      case 'keydown':     lines.push(`  await page.keyboard.down(${JSON.stringify(ev.key)});`); break;
      case 'keyup':       lines.push(`  await page.keyboard.up(${JSON.stringify(ev.key)});`); break;
      case 'input':
        lines.push(`  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');`);
        lines.push(`  await page.keyboard.type(${JSON.stringify(ev.value ?? '')});`);
        break;
    }
  }
  lines.push(`  await browser.close();`);
  lines.push(`})().catch(err => { console.error(err); process.exit(1); });`);
  return lines.join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n[Server] Browser Automation Tool → http://localhost:${PORT}\n`);
});
