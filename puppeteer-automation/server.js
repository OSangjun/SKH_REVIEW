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
    responses   TEXT    NOT NULL DEFAULT '[]',
    description TEXT    NOT NULL DEFAULT '',
    tags        TEXT    NOT NULL DEFAULT '[]'
  )
`);
// Safe migrations for existing DBs
for (const col of [
  `ALTER TABLE recordings ADD COLUMN responses   TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE recordings ADD COLUMN description TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE recordings ADD COLUMN tags        TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE recordings ADD COLUMN cookies     TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE recordings ADD COLUMN toasts      TEXT NOT NULL DEFAULT '[]'`,
]) { try { db.exec(col); } catch {} }

db.exec(`
  CREATE TABLE IF NOT EXISTS run_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    recording_id INTEGER NOT NULL,
    run_at       TEXT    NOT NULL,
    passed       INTEGER NOT NULL DEFAULT 0,
    failed       INTEGER NOT NULL DEFAULT 0,
    total        INTEGER NOT NULL DEFAULT 0,
    results      TEXT    NOT NULL DEFAULT '[]',
    duration_ms  INTEGER NOT NULL DEFAULT 0
  )
`);

const stmts = {
  insertRecording: db.prepare(
    `INSERT INTO recordings (name, url, event_count, created_at, events, responses, cookies, toasts)
     VALUES (@name, @url, @event_count, @created_at, @events, @responses, @cookies, @toasts)`
  ),
  updateMeta: db.prepare(
    `UPDATE recordings SET name=@name, description=@description, tags=@tags WHERE id=@id`
  ),
  allMeta: db.prepare(
    `SELECT id, name, url, event_count AS eventCount, created_at AS createdAt,
            description, tags
     FROM recordings ORDER BY id`
  ),
  getMeta: db.prepare(
    `SELECT id, name, url, event_count AS eventCount, created_at AS createdAt,
            description, tags
     FROM recordings WHERE id = ?`
  ),
  getEvents:     db.prepare(`SELECT events    FROM recordings WHERE id = ?`),
  getResponses:  db.prepare(`SELECT responses FROM recordings WHERE id = ?`),
  getCookies:    db.prepare(`SELECT cookies   FROM recordings WHERE id = ?`),
  getToasts:     db.prepare(`SELECT toasts    FROM recordings WHERE id = ?`),
  deleteRecording: db.prepare(`DELETE FROM recordings WHERE id = ?`),
  insertHistory: db.prepare(
    `INSERT INTO run_history (recording_id, run_at, passed, failed, total, results, duration_ms)
     VALUES (@recording_id, @run_at, @passed, @failed, @total, @results, @duration_ms)`
  ),
  getHistory: db.prepare(
    `SELECT id, recording_id AS recordingId, run_at AS runAt, passed, failed, total, duration_ms AS durationMs
     FROM run_history WHERE recording_id = ? ORDER BY id DESC LIMIT 20`
  ),
  allHistory: db.prepare(
    `SELECT id, recording_id AS recordingId, run_at AS runAt, passed, failed, total, duration_ms AS durationMs
     FROM run_history ORDER BY id DESC`
  ),
  deleteHistoryByRecording: db.prepare(`DELETE FROM run_history WHERE recording_id = ?`),
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

function parseMeta(row) {
  if (!row) return null;
  return { ...row, tags: tryJson(row.tags, []) };
}
function tryJson(s, def) { try { return JSON.parse(s); } catch { return def; } }

function dbAllMeta()   { return stmts.allMeta.all().map(parseMeta); }
function dbGetMeta(id) { return parseMeta(stmts.getMeta.get(id)); }

function dbLoadEvents(id) {
  const row = stmts.getEvents.get(id);
  if (!row) return null;
  return tryJson(row.events, null);
}
function dbLoadResponses(id) {
  const row = stmts.getResponses.get(id);
  if (!row) return [];
  return tryJson(row.responses, []);
}
function dbSaveRecording(name, url, eventCount, createdAt, events, responses, cookies, toasts) {
  const info = stmts.insertRecording.run({
    name, url,
    event_count: eventCount,
    created_at:  createdAt,
    events:      JSON.stringify(events),
    responses:   JSON.stringify(responses),
    cookies:     JSON.stringify(cookies ?? []),
    toasts:      JSON.stringify(toasts  ?? []),
  });
  return info.lastInsertRowid;
}
function dbLoadCookies(id) {
  const row = stmts.getCookies.get(id);
  if (!row) return [];
  return tryJson(row.cookies, []);
}
function dbLoadToasts(id) {
  const row = stmts.getToasts.get(id);
  if (!row) return [];
  return tryJson(row.toasts, []);
}
function dbUpdateMeta(id, name, description, tags) {
  stmts.updateMeta.run({ id, name, description, tags: JSON.stringify(tags) });
}
function dbDeleteRecording(id) { stmts.deleteRecording.run(id); }

function dbGetHistory(recId) { return stmts.getHistory.all(recId); }
function dbAllHistory() {
  const map = {};
  for (const r of stmts.allHistory.all()) {
    if (!map[r.recordingId]) map[r.recordingId] = [];
    if (map[r.recordingId].length < 20) map[r.recordingId].push(r);
  }
  return map;
}
function dbSaveHistory(recId, passed, failed, total, results, durationMs) {
  stmts.insertHistory.run({
    recording_id: recId,
    run_at:       new Date().toISOString(),
    passed, failed, total,
    results:      JSON.stringify(results),
    duration_ms:  durationMs,
  });
}

// ─── Puppeteer session state ──────────────────────────────────────────────────

let browser       = null;   // Puppeteer Browser
let activePage    = null;   // current page
let cdpSession    = null;   // CDP session for screencasting
let activeWs      = null;   // connected frontend WebSocket

let isRecording           = false;
let capturedEvents        = [];
let capturedResponses     = [];
let capturedToasts        = [];    // toast messages captured during recording
let pendingRespPromises   = new Set();
let recordingStartTime    = null;
let currentUrl         = 'about:blank';
let firstNavigateDone  = false;
let sessionCookies     = [];
let replayCookies      = [];
let replayToasts       = [];    // toast messages captured during replay
let replayToastActive  = false; // true only while runReplay is running

// ─── Capture script (injected via evaluateOnNewDocument) ─────────────────────
// This runs in EVERY page context regardless of how navigation happened
// (JS redirect, link click, form submit, etc.). Replaces the proxy injection approach.

function buildCaptureScript() {
  return `(function () {
    if (window.__CDP_CAPTURE_ACTIVE__) return;
    window.__CDP_CAPTURE_ACTIVE__ = true;

    const cap = window.__captureEvent;
    if (!cap) return;

    const SCROLL_THROTTLE = 100;
    let lastScroll = 0;

    function btn(b) { return b === 2 ? 'right' : b === 1 ? 'middle' : 'left'; }

    // Build a stable CSS selector for form/interactive elements
    function getSelector(el) {
      if (!el || !el.tagName) return null;
      var tag = el.tagName.toLowerCase();
      if (el.id && /^[a-zA-Z]/.test(el.id) && !el.id.includes(' '))
        return '#' + el.id;
      if (el.name)
        return tag + '[name=' + JSON.stringify(el.name) + ']';
      var testId = el.getAttribute && el.getAttribute('data-testid');
      if (testId) return '[data-testid=' + JSON.stringify(testId) + ']';
      var ariaLabel = el.getAttribute && el.getAttribute('aria-label');
      if (ariaLabel) return tag + '[aria-label=' + JSON.stringify(ariaLabel) + ']';
      if (tag === 'input' && el.type && ['checkbox','radio'].includes(el.type))
        return el.value
          ? tag + '[type=' + JSON.stringify(el.type) + '][value=' + JSON.stringify(el.value) + ']'
          : tag + '[type=' + JSON.stringify(el.type) + ']';
      if (tag === 'input' && el.placeholder)
        return tag + '[placeholder=' + JSON.stringify(el.placeholder) + ']';
      return null;
    }

    // Get visible label text for an element
    function getLabel(el) {
      if (!el) return null;
      var ariaLabel = el.getAttribute && el.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel;
      var labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
      if (labelledBy) {
        var lbEl = document.getElementById(labelledBy);
        if (lbEl) return (lbEl.innerText || lbEl.textContent || '').trim() || null;
      }
      if (el.id) {
        var lEl = document.querySelector('label[for=' + JSON.stringify(el.id) + ']');
        if (lEl) return (lEl.innerText || lEl.textContent || '').trim() || null;
      }
      if (el.placeholder) return el.placeholder;
      return null;
    }

    function isInteractive(el) {
      if (!el || !el.tagName) return false;
      var tag = el.tagName.toUpperCase();
      if (['INPUT','SELECT','TEXTAREA','BUTTON','A','LABEL'].includes(tag)) return true;
      var role = el.getAttribute && el.getAttribute('role');
      return !!(role && ['button','checkbox','radio','combobox','listbox','option','menuitem','tab','link'].includes(role));
    }

    function withTarget(base, el) {
      if (!isInteractive(el)) return base;
      var sel = getSelector(el);
      var lbl = getLabel(el);
      if (sel) base.selector = sel;
      if (lbl) base.label    = lbl;
      return base;
    }

    document.addEventListener('click', e => {
      cap('click', withTarget({ x: e.clientX, y: e.clientY, button: btn(e.button) }, e.target));
    }, true);
    document.addEventListener('dblclick', e => {
      cap('dblclick', withTarget({ x: e.clientX, y: e.clientY }, e.target));
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
      var el = e.target;
      if (!el) return;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        cap('input', withTarget({ value: el.value }, el));
      } else if (el.isContentEditable) {
        cap('contenteditable', { html: el.innerHTML, text: el.innerText });
      }
    }, true);

    document.addEventListener('change', e => {
      var el = e.target;
      if (!el) return;
      if (el.tagName === 'SELECT') {
        var optLabel = el.options && el.selectedIndex >= 0
          ? (el.options[el.selectedIndex].text || '').trim() : '';
        cap('select', withTarget({ value: el.value, optLabel: optLabel }, el));
      } else if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
        cap('check', withTarget({ checked: el.checked, value: el.value }, el));
      }
    }, true);

    // Toast / notification observer (role="alert" or role="status")
    const _toastSeen = new WeakSet();
    const _toastObs  = new MutationObserver(function(muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          var els = (node.matches && node.matches('[role="alert"],[role="status"]'))
            ? [node]
            : (node.querySelectorAll
                ? Array.prototype.slice.call(node.querySelectorAll('[role="alert"],[role="status"]'))
                : []);
          for (var k = 0; k < els.length; k++) {
            var el = els[k];
            if (_toastSeen.has(el)) continue;
            _toastSeen.add(el);
            var text = (el.innerText || el.textContent || '').trim();
            if (text) cap('toast', { text: text });
          }
        }
      }
    });
    (function startToastObs() {
      if (document.body) _toastObs.observe(document.body, { childList: true, subtree: true });
      else document.addEventListener('DOMContentLoaded', startToastObs);
    })();
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
    if (type === 'toast') {
      capturedToasts.push({ text: data.text });
      return;
    }
    const ev = { type, ...data, t: now - recordingStartTime };
    capturedEvents.push(ev);
    send({ type: 'recording-event', count: capturedEvents.length });
  });

  // Expose toast bridge for replay (separate from recording bridge)
  await activePage.exposeFunction('__captureToast', text => {
    if (replayToastActive) replayToasts.push(text);
  });

  // Inject toast observer for replay (runs on every page load, activated by replayToastActive flag)
  await activePage.evaluateOnNewDocument(`(function() {
    if (window.__CDP_TOAST_OBSERVER__) return;
    window.__CDP_TOAST_OBSERVER__ = true;
    var seen = new WeakSet();
    var obs  = new MutationObserver(function(muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          var els = (node.matches && node.matches('[role="alert"],[role="status"]'))
            ? [node]
            : (node.querySelectorAll
                ? Array.prototype.slice.call(node.querySelectorAll('[role="alert"],[role="status"]'))
                : []);
          for (var k = 0; k < els.length; k++) {
            var el = els[k];
            if (seen.has(el)) continue;
            seen.add(el);
            var text = (el.innerText || el.textContent || '').trim();
            if (text && window.__captureToast) window.__captureToast(text);
          }
        }
      }
    });
    function start() {
      if (document.body) obs.observe(document.body, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  })();`);

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

  // Capture HTTP responses (with body) during recording
  activePage.on('response', response => {
    if (!isRecording) return;
    const url = response.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;

    const ct     = (response.headers()['content-type'] || '').toLowerCase();
    const wantBody = /json|text\/plain|xml/.test(ct);
    const status = response.status();
    const t      = Date.now() - (recordingStartTime ?? Date.now());

    if (!wantBody) {
      capturedResponses.push({ url, status, contentType: ct, body: null, t });
      return;
    }

    // Async body read — track promise so stop-recording can await it
    const p = response.buffer()
      .then(buf => {
        const body = buf.length <= 51200 ? buf.toString('utf8') : null;
        capturedResponses.push({ url, status, contentType: ct, body, t });
      })
      .catch(() => {
        capturedResponses.push({ url, status, contentType: ct, body: null, t });
      })
      .finally(() => pendingRespPromises.delete(p));

    pendingRespPromises.add(p);
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
    ws.send(JSON.stringify({ type: 'history-all', map: dbAllHistory() }));
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

// level: 'info' | 'success' | 'fail' | 'warn'
function log(level, message) {
  const ts = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  send({ type: 'log', level, message, ts });
  console.log(`[${ts}] [${level.toUpperCase()}] ${message}`);
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
      capturedToasts     = [];
      pendingRespPromises = new Set();
      recordingStartTime = null;
      firstNavigateDone  = true;
      ws.send(JSON.stringify({ type: 'recording-started' }));
      console.log('[Recording] Started');
      break;

    case 'stop-recording': {
      isRecording = false;
      // Wait for any in-flight body reads (up to 2 s)
      if (pendingRespPromises.size > 0)
        await Promise.race([
          Promise.allSettled([...pendingRespPromises]),
          sleep(2000),
        ]);
      console.log(`[Recording] Stopped — ${capturedEvents.length} events, ${capturedResponses.length} responses`);
      if (capturedEvents.length === 0) {
        ws.send(JSON.stringify({ type: 'recording-empty' }));
        break;
      }
      // Map HTTP responses to the events that triggered them
      const eventsWithMapping = mapResponsesToEvents([...capturedEvents], [...capturedResponses]);
      const triggeredCount = eventsWithMapping.filter(e => e.triggeredUrls?.length).length;
      if (triggeredCount > 0)
        console.log(`[Recording] Event→HTTP mapping: ${triggeredCount} events mapped`);

      const createdAt = new Date().toISOString();
      const newId     = dbSaveRecording(
        `녹화 #?`,
        currentUrl,
        capturedEvents.length,
        createdAt,
        eventsWithMapping,
        [...capturedResponses],
        [...sessionCookies],
        [...capturedToasts],
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
      const cookies   = dbLoadCookies(msg.id);
      const toasts    = dbLoadToasts(msg.id);
      await runReplay(msg.id, events, responses, meta.url, msg.speedFactor ?? 1.0, ws, false, cookies, toasts);
      break;
    }

    // ── Suite (batch replay) ──────────────────────────────────────────────────
    case 'run-suite': {
      const ids = Array.isArray(msg.ids) ? msg.ids.filter(x => typeof x === 'number') : [];
      if (ids.length === 0) break;

      ws.send(JSON.stringify({ type: 'suite-started', total: ids.length }));
      log('info', `━━ 스위트 실행 시작: ${ids.length}개 테스트 ━━`);

      let suitePass = 0, suiteFail = 0;

      for (let i = 0; i < ids.length; i++) {
        const id   = ids[i];
        const meta = dbGetMeta(id);
        if (!meta) { suiteFail++; continue; }
        const events    = dbLoadEvents(id);
        if (!events)  { suiteFail++; continue; }
        const responses = dbLoadResponses(id);
        const cookies   = dbLoadCookies(id);
        const toasts    = dbLoadToasts(id);

        ws.send(JSON.stringify({ type: 'suite-item-started', index: i, total: ids.length, name: meta.name }));
        log('info', `━━ [${i + 1}/${ids.length}] ${meta.name} ━━`);

        const result = await runReplay(id, events, responses, meta.url, msg.speedFactor ?? 1.0, ws, true, cookies, toasts);

        if (result.failed === 0) suitePass++;
        else suiteFail++;

        ws.send(JSON.stringify({
          type: 'suite-item-done', index: i, total: ids.length, name: meta.name,
          passed: result.passed, failed: result.failed, recTotal: result.total,
        }));
      }

      log(suiteFail === 0 ? 'success' : 'fail',
        `━━ 스위트 완료: 성공 ${suitePass} / 실패 ${suiteFail} (총 ${ids.length}개) ━━`);
      ws.send(JSON.stringify({ type: 'suite-done', total: ids.length, passed: suitePass, failed: suiteFail }));
      break;
    }

    // ── Update metadata (name / description / tags) ───────────────────────────
    case 'update-recording': {
      const { id, name, description, tags } = msg;
      if (!dbGetMeta(id)) break;
      dbUpdateMeta(id, (name || '').trim(), (description || '').trim(), Array.isArray(tags) ? tags : []);
      ws.send(JSON.stringify({ type: 'recordings', list: dbAllMeta() }));
      break;
    }

    // ── Delete ────────────────────────────────────────────────────────────────
    case 'delete-recording': {
      stmts.deleteHistoryByRecording.run(msg.id);
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
// Events that never cause HTTP requests — replayed without timing delay
const NO_DELAY_EVENTS = new Set(['keydown', 'keyup', 'input', 'scroll', 'wheel', 'contenteditable']);

// Returns true for events that can trigger HTTP requests
function isNetworkTrigger(ev) {
  return ['click', 'dblclick', 'navigate', 'check', 'select'].includes(ev.type) ||
    (ev.type === 'keydown' && (ev.key === 'Enter' || ev.code === 'Enter'));
}

/**
 * Post-processing at stop-recording time.
 * For each triggering event, find all HTTP responses that arrived between
 * this event's timestamp and the next trigger event's timestamp, and attach
 * their URLs as event.triggeredUrls.
 */
function mapResponsesToEvents(events, responses) {
  const triggerIdxs = [];
  for (let i = 0; i < events.length; i++) {
    if (isNetworkTrigger(events[i])) triggerIdxs.push(i);
  }
  for (let k = 0; k < triggerIdxs.length; k++) {
    const idx    = triggerIdxs[k];
    const tStart = events[idx].t ?? 0;
    const tEnd   = k + 1 < triggerIdxs.length
      ? (events[triggerIdxs[k + 1]].t ?? Infinity)
      : Infinity;
    const urls = responses
      .filter(r => r.t != null && r.t >= tStart && r.t < tEnd)
      .map(r => r.url);
    if (urls.length > 0) events[idx].triggeredUrls = urls;
  }
  return events;
}

/**
 * Compare per-event trigger mappings: for each recorded triggeredUrls,
 * check if the same URLs were seen during replay in the same event window.
 * replayTriggerMap: Map<eventIndex, string[]> built during replay.
 */
function compareTriggerMappings(events, replayTriggerMap) {
  const results = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!Array.isArray(ev.triggeredUrls) || ev.triggeredUrls.length === 0) continue;
    const actual = (replayTriggerMap.get(i) || []).map(normalizeUrl);
    const label  = ev.label || ev.selector
      || (ev.type === 'keydown' ? `키[${ev.key}]` : `(${ev.x ?? ''},${ev.y ?? ''})`);
    for (const url of ev.triggeredUrls) {
      results.push({ eventType: ev.type, eventLabel: label, url, pass: actual.includes(normalizeUrl(url)) });
    }
  }
  return results;
}

// Build a lookup map: normalizedUrl → [recorded response objects]
function buildResponseMap(responses) {
  const map = new Map();
  for (const r of responses) {
    const key = normalizeUrl(r.url);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.search = ''; // strip query params (session tokens, timestamps, etc.)
    return u.toString();
  } catch { return url; }
}

// Shallow JSON field diff — returns array of human-readable difference strings
function jsonDiff(expected, actual, path) {
  path = path || 'root';
  if (typeof expected !== typeof actual)
    return [`${path}: 타입 변경 (${typeof expected} → ${typeof actual})`];
  if (expected === null || actual === null) {
    return expected !== actual ? [`${path}: null 불일치`] : [];
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const diffs = [];
    if (expected.length !== actual.length)
      diffs.push(`${path}[]: 길이 변경 (${expected.length} → ${actual.length})`);
    for (let i = 0; i < Math.min(expected.length, actual.length, 3); i++)
      diffs.push(...jsonDiff(expected[i], actual[i], `${path}[${i}]`));
    return diffs.slice(0, 5);
  }
  if (typeof expected === 'object') {
    const diffs = [];
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of keys) {
      if (!(k in expected)) { diffs.push(`${path}.${k}: 키 추가됨`); continue; }
      if (!(k in actual))   { diffs.push(`${path}.${k}: 키 삭제됨`); continue; }
      diffs.push(...jsonDiff(expected[k], actual[k], `${path}.${k}`));
      if (diffs.length >= 5) break;
    }
    return diffs.slice(0, 5);
  }
  if (expected !== actual)
    return [`${path}: ${JSON.stringify(expected)} → ${JSON.stringify(actual)}`];
  return [];
}

function compareResponses(recorded, actual) {
  const recMap  = buildResponseMap(recorded);

  // Deduplicate actual responses: keep only the last occurrence per normalized URL
  const actMap = new Map();
  for (const r of actual) actMap.set(normalizeUrl(r.url), r);

  const results = [];
  for (const [key, r] of actMap) {
    const recList = recMap.get(key);
    if (!recList) continue;
    const rec = recList[0];

    const statusPass = rec.status === r.status;

    // Body comparison (only when both sides have a captured body)
    let bodyPass  = true;
    let bodyDiffs = [];
    if (rec.body !== null && r.body !== null) {
      // Try JSON field-level diff first
      try {
        const recJson = JSON.parse(rec.body);
        const actJson = JSON.parse(r.body);
        bodyDiffs = jsonDiff(recJson, actJson);
        bodyPass  = bodyDiffs.length === 0;
      } catch {
        // Fallback: exact string match
        bodyPass  = rec.body === r.body;
        if (!bodyPass) bodyDiffs = ['바디 텍스트 불일치'];
      }
    }

    const pass = statusPass && bodyPass;
    results.push({
      url: r.url,
      expectedStatus: rec.status,
      actualStatus:   r.status,
      statusPass,
      bodyPass,
      bodyDiffs,
      pass,
    });
  }
  return results;
}

function compareToasts(recorded, actual) {
  const actSet = new Set(actual.map(t => (typeof t === 'string' ? t : t.text).trim()));
  return recorded.map(r => {
    const text = (typeof r === 'string' ? r : r.text).trim();
    return { text, pass: actSet.has(text) };
  });
}

async function runReplay(recordingId, events, recordedResponses, startUrl, speedFactor, ws, isSuite = false, recordingCookies = [], recordingToasts = []) {
  const startMs = Date.now();
  if (!isSuite) ws.send(JSON.stringify({ type: 'replay-started' }));
  log('info', `재생 시작 → ${startUrl}  (이벤트 ${events.length}개, 속도 ${speedFactor}×)`);

  const replayResponses    = [];
  const replayResponseUrls = [];   // synchronous URL capture for trigger mapping
  const replayRespPending  = new Set();
  const recMap             = buildResponseMap(recordedResponses);
  const replayTriggerMap   = new Map(); // eventIdx → [url, ...]
  const jsErrors           = [];

  replayToasts      = [];
  replayToastActive = true;

  const onPageError = err => {
    jsErrors.push(err.message);
    log('fail', `[JS Error] ${err.message}`);
  };
  activePage.on('pageerror', onPageError);

  const onResponse = response => {
    const url = response.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    replayResponseUrls.push(url);   // synchronous — used for trigger mapping
    const ct       = (response.headers()['content-type'] || '').toLowerCase();
    const status   = response.status();
    const wantBody = /json|text\/plain|xml/.test(ct);

    if (!wantBody) {
      replayResponses.push({ url, status, contentType: ct, body: null });
      return;
    }

    const p = response.buffer()
      .then(buf => {
        const body = buf.length <= 51200 ? buf.toString('utf8') : null;
        replayResponses.push({ url, status, contentType: ct, body });
      })
      .catch(() => replayResponses.push({ url, status, contentType: ct, body: null }))
      .finally(() => replayRespPending.delete(p));

    replayRespPending.add(p);
  };
  activePage.on('response', onResponse);

  try {
    firstNavigateDone = false;
    replayCookies = recordingCookies.length > 0 ? recordingCookies : sessionCookies;
    if (replayCookies.length > 0) {
      await activePage.setCookie(...replayCookies);
      log('info', `쿠키 ${replayCookies.length}개 적용${recordingCookies.length > 0 ? ' (녹화 저장 쿠키)' : ''}`);
    }

    log('info', `페이지 로드: ${startUrl}`);
    await activePage.goto(startUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    const total = events.length;
    let lastT   = 0;

    for (let i = 0; i < total; i++) {
      const ev    = events[i];
      const delay = NO_DELAY_EVENTS.has(ev.type)
        ? 0
        : Math.max(0, ((ev.t ?? 0) - lastT) / speedFactor);
      if (delay > 0) await sleep(delay);
      lastT = ev.t ?? 0;

      // Log significant actions
      switch (ev.type) {
        case 'navigate':
          log('info',  `[Navigate] ${ev.url}`); break;
        case 'click':
          log('info',  `[Click] (${ev.x},${ev.y})`); break;
        case 'dblclick':
          log('info',  `[DblClick] (${ev.x},${ev.y})`); break;
        case 'keydown':
          if (ev.key === 'Enter') log('info', `[Enter] 폼 제출 또는 키 입력`);
          break;
        case 'input':
          log('info',  `[Input] "${String(ev.value ?? '').slice(0, 40)}"`); break;
      }

      const isTrigger = isNetworkTrigger(ev);
      const snapLen   = isTrigger ? replayResponseUrls.length : -1;

      await dispatchReplayEvent(ev);

      if (NETWORK_EVENTS.has(ev.type)) await waitNetworkIdle(5000);
      if (ev.type === 'keydown' && (ev.key === 'Enter' || ev.code === 'Enter'))
        await waitNetworkIdle(5000);
      if (ev.type === 'check' || ev.type === 'select') await waitNetworkIdle(5000);

      if (isTrigger && snapLen >= 0)
        replayTriggerMap.set(i, replayResponseUrls.slice(snapLen));

      if (i % 5 === 0 || i === total - 1)
        ws.send(JSON.stringify({ type: 'replay-progress', done: i + 1, total }));
    }
  } catch (err) {
    log('fail', `재생 오류: ${err.message}`);
  } finally {
    replayToastActive = false;
    activePage.off('pageerror', onPageError);
    activePage.off('response', onResponse);
    // Wait for in-flight body reads
    if (replayRespPending.size > 0)
      await Promise.race([Promise.allSettled([...replayRespPending]), sleep(2000)]);
  }

  // Compare recorded vs actual responses
  const results = recordedResponses.length > 0
    ? compareResponses(recordedResponses, replayResponses)
    : [];

  const toastResults   = compareToasts(recordingToasts, replayToasts);
  const triggerResults = compareTriggerMappings(events, replayTriggerMap);
  const passed         = results.filter(r => r.pass).length;
  const httpFailed     = results.filter(r => !r.pass).length;
  const toastFailed    = toastResults.filter(r => !r.pass).length;
  const triggerFailed  = triggerResults.filter(r => !r.pass).length;
  const scriptFailed   = jsErrors.length;
  const failed         = httpFailed + toastFailed + triggerFailed + scriptFailed;

  if (results.length > 0) {
    if (httpFailed === 0)
      log('success', `━━ HTTP 응답: SUCCESS — ${passed}/${results.length} 일치 ━━`);
    else if (passed === 0)
      log('fail',    `━━ HTTP 응답: FAIL — ${httpFailed}/${results.length} 불일치 ━━`);
    else
      log('warn',    `━━ HTTP 응답: PARTIAL — 성공 ${passed} / 실패 ${httpFailed} ━━`);

    for (const r of results) {
      if (r.pass) {
        log('success', `  ✓ [${r.actualStatus}] ${r.url}`);
      } else {
        log('fail', `  ✗ [${r.actualStatus}] ${r.url}`);
        if (!r.statusPass)
          log('fail', `    상태코드: ${r.expectedStatus} → ${r.actualStatus}`);
        for (const d of r.bodyDiffs.slice(0, 3))
          log('fail', `    바디 diff: ${d}`);
      }
    }
  } else {
    log('info', '━━ 재생 완료 (HTTP 응답 비교 없음) ━━');
  }

  if (toastResults.length > 0) {
    if (toastFailed === 0)
      log('success', `━━ 토스트: SUCCESS — ${toastResults.length}건 일치 ━━`);
    else
      log('fail',    `━━ 토스트: FAIL — ${toastFailed}/${toastResults.length}건 불일치 ━━`);
    for (const r of toastResults) {
      if (r.pass) log('success', `  ✓ [Toast] ${r.text}`);
      else        log('fail',    `  ✗ [Toast] "${r.text}" — 재생 시 미감지`);
    }
  }

  if (triggerResults.length > 0) {
    if (triggerFailed === 0)
      log('success', `━━ 이벤트-HTTP 매핑: SUCCESS — ${triggerResults.length}건 일치 ━━`);
    else
      log('fail',    `━━ 이벤트-HTTP 매핑: FAIL — ${triggerFailed}/${triggerResults.length}건 불일치 ━━`);
    for (const r of triggerResults) {
      if (r.pass) log('success', `  ✓ [${r.eventType}:${r.eventLabel}] → ${r.url}`);
      else        log('fail',    `  ✗ [${r.eventType}:${r.eventLabel}] → ${r.url} — 재생 시 미감지`);
    }
  }

  if (jsErrors.length > 0) {
    log('fail', `━━ 스크립트 에러 ${jsErrors.length}건 감지 ━━`);
    for (const e of jsErrors)
      log('fail', `  ✗ [JS Error] ${e}`);
  }

  const total      = results.length + toastResults.length + triggerResults.length;
  const durationMs = Date.now() - startMs;
  dbSaveHistory(recordingId, passed, failed, total, results, durationMs);
  ws.send(JSON.stringify({ type: 'history', recordingId, runs: dbGetHistory(recordingId) }));

  if (!isSuite) ws.send(JSON.stringify({ type: 'replay-done' }));
  ws.send(JSON.stringify({ type: 'replay-result', results, toastResults, triggerResults, passed, failed, total, jsErrors }));
  return { passed, failed, total };
}

const BTN = b => (b === 'right' ? 'right' : b === 'middle' ? 'middle' : 'left');

async function dispatchReplayEvent(ev) {
  try {
    switch (ev.type) {
      case 'navigate':
        if (replayCookies.length > 0) await activePage.setCookie(...replayCookies);
        await activePage.goto(ev.url, { waitUntil: 'networkidle2', timeout: 30000 });
        break;
      case 'click':
        if (ev.selector) {
          try {
            const el = await activePage.$(ev.selector);
            if (el) { await el.click(); break; }
          } catch {}
        }
        await activePage.mouse.click(ev.x, ev.y, { button: BTN(ev.button) });
        break;
      case 'dblclick':
        if (ev.selector) {
          try {
            const el = await activePage.$(ev.selector);
            if (el) { await el.click({ clickCount: 2 }); break; }
          } catch {}
        }
        await activePage.mouse.click(ev.x, ev.y, { clickCount: 2 });
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
        if (ev.selector) {
          try {
            const el = await activePage.$(ev.selector);
            if (el) { await el.click({ clickCount: 3 }); await el.type(ev.value ?? ''); break; }
          } catch {}
        }
        await activePage.keyboard.down('Control');
        await activePage.keyboard.press('a');
        await activePage.keyboard.up('Control');
        await activePage.keyboard.type(ev.value ?? '');
        break;
      case 'select':
        if (ev.selector) {
          try { await activePage.select(ev.selector, ev.value); break; } catch {}
        }
        await activePage.evaluate(v => {
          const el = document.activeElement;
          if (el && el.tagName === 'SELECT') {
            el.value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, ev.value);
        break;
      case 'check':
        if (ev.selector) {
          try {
            const el = await activePage.$(ev.selector);
            if (el) {
              const cur = await el.evaluate(n => n.checked);
              if (cur !== ev.checked) await el.click();
              break;
            }
          } catch {}
        }
        await activePage.mouse.click(ev.x ?? 0, ev.y ?? 0);
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

// ─── REST API — responses (view & edit) ──────────────────────────────────────

app.get('/api/recordings/:id/responses', (req, res) => {
  const meta = dbGetMeta(+req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  res.json(dbLoadResponses(meta.id));
});

app.put('/api/recordings/:id/responses', (req, res) => {
  const meta = dbGetMeta(+req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  const responses = req.body;
  if (!Array.isArray(responses)) return res.status(400).json({ error: 'Expected array' });
  db.prepare(`UPDATE recordings SET responses = ? WHERE id = ?`)
    .run(JSON.stringify(responses), meta.id);
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
