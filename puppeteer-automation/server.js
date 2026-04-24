'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { load: cheerioLoad } = require('cheerio');
const puppeteer = require('puppeteer-core');

const CHROME_PATH =
  process.env.CHROME_PATH ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const PORT = process.env.PORT || 3000;
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const META_FILE = path.join(RECORDINGS_DIR, 'meta.json');
const OLD_FILE = path.join(RECORDINGS_DIR, 'web-recordings.json'); // legacy

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Storage (metadata in memory, events in per-ID files) ─────────────────────
// Fixes D3/D4/D6/P3: lazy event loading, O(1) saves, parse-error logging

let recordingsMeta = []; // [{id, name, url, eventCount, createdAt}]
let nextId = 1;

function eventsFile(id) {
  return path.join(RECORDINGS_DIR, `${id}.events.json`);
}

function loadMeta() {
  try {
    if (!fs.existsSync(META_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    if (!Array.isArray(data)) throw new Error('meta.json root is not an array');
    recordingsMeta = data;
    if (recordingsMeta.length > 0)
      nextId = Math.max(...recordingsMeta.map(r => r.id)) + 1;
    return true;
  } catch (err) {
    console.error('[Storage] Failed to load meta.json:', err.message, '— starting fresh.');
    recordingsMeta = [];
    return false;
  }
}

function migrateOldFormat() {
  if (!fs.existsSync(OLD_FILE)) return;
  try {
    console.log('[Storage] Migrating web-recordings.json …');
    const old = JSON.parse(fs.readFileSync(OLD_FILE, 'utf8'));
    for (const rec of old) {
      fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
      fs.writeFileSync(eventsFile(rec.id), JSON.stringify(rec.events ?? []));
      recordingsMeta.push({
        id: rec.id,
        name: rec.name,
        url: rec.url,
        eventCount: Array.isArray(rec.events) ? rec.events.length : 0,
        createdAt: rec.createdAt,
      });
    }
    if (recordingsMeta.length > 0)
      nextId = Math.max(...recordingsMeta.map(r => r.id)) + 1;
    saveMeta();
    fs.renameSync(OLD_FILE, OLD_FILE + '.bak');
    console.log(`[Storage] Migrated ${recordingsMeta.length} recordings.`);
  } catch (err) {
    console.error('[Storage] Migration failed:', err.message);
    recordingsMeta = [];
  }
}

function saveMeta() {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  fs.writeFileSync(META_FILE, JSON.stringify(recordingsMeta, null, 2));
}

function saveEvents(id, events) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  fs.writeFileSync(eventsFile(id), JSON.stringify(events));
}

function loadEvents(id) {
  try {
    const f = eventsFile(id);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (err) {
    console.error(`[Storage] Failed to load events #${id}:`, err.message);
    return null;
  }
}

function deleteEvents(id) {
  try { fs.unlinkSync(eventsFile(id)); } catch {}
}

if (!loadMeta()) migrateOldFormat();

// ─── Security: HTML escaping helper (Fix B1 XSS) ──────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Proxy helpers ────────────────────────────────────────────────────────────

function resolveUrl(base, rel) {
  try {
    if (!rel) return null;
    if (rel.startsWith('//')) return new URL('https:' + rel).href;
    return new URL(rel, base).href;
  } catch {
    return null;
  }
}

function toProxyHref(absUrl) {
  return `/proxy?url=${encodeURIComponent(absUrl)}`;
}

function isRewritable(val) {
  if (!val) return false;
  const v = val.trim();
  return (
    !v.startsWith('data:') &&
    !v.startsWith('#') &&
    !v.startsWith('javascript:') &&
    !v.startsWith('mailto:') &&
    !v.startsWith('tel:')
  );
}

function rewriteHtml(html, pageUrl) {
  const $ = cheerioLoad(html, { decodeEntities: false });

  $('meta[http-equiv]').each((_, el) => {
    if (/content-security-policy/i.test($(el).attr('http-equiv') || ''))
      $(el).remove();
  });

  $('[href]').each((_, el) => {
    const v = $(el).attr('href');
    if (!isRewritable(v)) return;
    const abs = resolveUrl(pageUrl, v);
    if (abs) $(el).attr('href', toProxyHref(abs));
  });

  $('[src]').each((_, el) => {
    const v = $(el).attr('src');
    if (!isRewritable(v)) return;
    const abs = resolveUrl(pageUrl, v);
    if (abs) $(el).attr('src', toProxyHref(abs));
  });

  $('[srcset]').each((_, el) => {
    const srcset = $(el).attr('srcset') || '';
    const rewritten = srcset.replace(/([^\s,]+)(\s+[\d.]+[wx])?/g, (m, url, desc) => {
      if (!isRewritable(url)) return m;
      const abs = resolveUrl(pageUrl, url);
      return abs ? toProxyHref(abs) + (desc || '') : m;
    });
    $(el).attr('srcset', rewritten);
  });

  $('form[action]').each((_, el) => {
    const v = $(el).attr('action');
    if (!isRewritable(v)) return;
    const abs = resolveUrl(pageUrl, v);
    if (abs) $(el).attr('action', toProxyHref(abs));
  });

  $('body').append(`
<script>window.__PROXIED_URL__ = ${JSON.stringify(pageUrl)};</script>
<script src="/inject.js"></script>`);

  return $.html();
}

function rewriteCss(css, pageUrl) {
  return css.replace(/url\(\s*['"]?([^'"\)\s]+)['"]?\s*\)/g, (match, u) => {
    if (!isRewritable(u)) return match;
    const abs = resolveUrl(pageUrl, u);
    return abs ? `url("${toProxyHref(abs)}")` : match;
  });
}

// ─── Proxy endpoint ───────────────────────────────────────────────────────────

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url parameter');

  try {
    const fetchRes = await fetch(targetUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
      },
    });

    const finalUrl = fetchRes.url || targetUrl;
    const ct = fetchRes.headers.get('content-type') || 'application/octet-stream';

    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');

    // Fix P1: cache static assets for 5 min
    if (!ct.includes('text/html')) {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }

    if (ct.includes('text/html')) {
      const html = await fetchRes.text();
      res.send(rewriteHtml(html, finalUrl));
    } else if (ct.includes('text/css')) {
      const css = await fetchRes.text();
      res.send(rewriteCss(css, finalUrl));
    } else if (ct.includes('javascript') || ct.includes('text/')) {
      res.send(await fetchRes.text());
    } else {
      res.send(Buffer.from(await fetchRes.arrayBuffer()));
    }
  } catch (err) {
    // Fix B1: XSS — escape error message and URL before embedding in HTML
    res.status(502).send(`
      <html data-proxy-error="true">
      <body style="font-family:sans-serif;padding:32px;color:#c00">
        <h2>프록시 오류</h2>
        <pre>${escHtml(err.message)}</pre>
        <p>URL: ${escHtml(targetUrl)}</p>
      </body></html>`);
  }
});

// ─── Recordings API ───────────────────────────────────────────────────────────

app.get('/api/recordings', (_req, res) => {
  res.json(recordingsMeta); // metadata only, no events (Fix P3)
});

app.post('/api/recordings', (req, res) => {
  const { name, url, events } = req.body;
  if (!url || !Array.isArray(events))
    return res.status(400).json({ error: 'url and events required' });

  const id = nextId++;
  const meta = {
    id,
    name: name || `녹화 #${id}`,
    url,
    eventCount: events.length,
    createdAt: new Date().toISOString(),
  };
  recordingsMeta.push(meta);
  saveEvents(id, events); // Fix D3/D4: events saved to separate file
  saveMeta();
  res.json(meta);
});

app.get('/api/recordings/:id', (req, res) => {
  const meta = recordingsMeta.find(r => r.id === +req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  const events = loadEvents(meta.id);
  if (!events) return res.status(500).json({ error: 'Events file missing' });
  res.json({ ...meta, events });
});

app.delete('/api/recordings/:id', (req, res) => {
  const idx = recordingsMeta.findIndex(r => r.id === +req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const { id } = recordingsMeta[idx];
  recordingsMeta.splice(idx, 1);
  deleteEvents(id);
  saveMeta();
  res.json({ ok: true });
});

// ─── Puppeteer script export (Fix U5) ─────────────────────────────────────────

app.get('/api/recordings/:id/export/puppeteer', (req, res) => {
  const meta = recordingsMeta.find(r => r.id === +req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  const events = loadEvents(meta.id);
  if (!events) return res.status(500).json({ error: 'Events file missing' });

  const filename = `${meta.name.replace(/[^\w\s-]/g, '_')}.js`;
  res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(generatePuppeteerScript({ ...meta, events }));
});

function generatePuppeteerScript(rec) {
  const lines = [
    `'use strict';`,
    `// Generated by Browser Automation Tool`,
    `// Recording : ${rec.name}`,
    `// URL       : ${rec.url}`,
    `// Events    : ${rec.events.length}`,
    `// Date      : ${rec.createdAt}`,
    ``,
    `const puppeteer = require('puppeteer');`,
    ``,
    `(async () => {`,
    `  const browser = await puppeteer.launch({ headless: false, defaultViewport: null });`,
    `  const [page] = await browser.pages();`,
    `  await page.goto(${JSON.stringify(rec.url)}, { waitUntil: 'domcontentloaded' });`,
    ``,
  ];

  const BTN = b => b === 'right' ? "'right'" : b === 'middle' ? "'middle'" : "'left'";
  let prevT = 0;

  for (const ev of rec.events) {
    const d = Math.max(0, (ev.t ?? 0) - prevT);
    prevT = ev.t ?? 0;
    if (d > 0) lines.push(`  await new Promise(r => setTimeout(r, ${d}));`);

    switch (ev.type) {
      case 'navigate':
        lines.push(`  await page.goto(${JSON.stringify(ev.url)}, { waitUntil: 'domcontentloaded' });`);
        break;
      case 'click':
        lines.push(`  await page.mouse.click(${ev.x}, ${ev.y}, { button: ${BTN(ev.button)} });`);
        break;
      case 'dblclick':
        lines.push(`  await page.mouse.click(${ev.x}, ${ev.y}, { clickCount: 2 });`);
        break;
      case 'mousedown':
        lines.push(`  await page.mouse.move(${ev.x}, ${ev.y}); await page.mouse.down({ button: ${BTN(ev.button)} });`);
        break;
      case 'mouseup':
        lines.push(`  await page.mouse.move(${ev.x}, ${ev.y}); await page.mouse.up({ button: ${BTN(ev.button)} });`);
        break;
      case 'mousemove':
        lines.push(`  await page.mouse.move(${ev.x}, ${ev.y});`);
        break;
      case 'wheel':
        lines.push(`  await page.mouse.wheel({ deltaX: ${ev.deltaX}, deltaY: ${ev.deltaY} });`);
        break;
      case 'scroll':
        lines.push(`  await page.evaluate(() => window.scrollTo(${ev.scrollX}, ${ev.scrollY}));`);
        break;
      case 'keydown':
        lines.push(`  await page.keyboard.down(${JSON.stringify(ev.key)});`);
        break;
      case 'keyup':
        lines.push(`  await page.keyboard.up(${JSON.stringify(ev.key)});`);
        break;
      case 'input':
        lines.push(`  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');`);
        lines.push(`  await page.keyboard.type(${JSON.stringify(ev.value ?? '')});`);
        break;
      case 'contenteditable':
        lines.push(`  await page.evaluate(h => { if (document.activeElement) document.activeElement.innerHTML = h; }, ${JSON.stringify(ev.html)});`);
        break;
    }
  }

  lines.push(``);
  lines.push(`  console.log('Replay complete.');`);
  lines.push(`  await browser.close();`);
  lines.push(`})().catch(err => { console.error(err); process.exit(1); });`);
  return lines.join('\n');
}

// ─── Puppeteer replay endpoint ────────────────────────────────────────────────

app.post('/api/replay/:id', async (req, res) => {
  const meta = recordingsMeta.find(r => r.id === +req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  const events = loadEvents(meta.id);
  if (!events) return res.status(500).json({ error: 'Events file missing' });

  const speedFactor = Math.max(0.1, +req.body.speedFactor || 1.0);
  res.json({ ok: true, message: 'Puppeteer 재생이 시작됩니다.' });

  (async () => {
    let browser;
    try {
      browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
        defaultViewport: null,
      });
      const [page] = await browser.pages();
      await page.goto(meta.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      let lastT = 0;
      for (const ev of events) {
        const delay = Math.max(0, ((ev.t ?? 0) - lastT) / speedFactor);
        if (delay > 0) await sleep(delay);
        lastT = ev.t ?? 0;
        await dispatchPuppeteerEvent(page, ev);
      }
      console.log(`[Puppeteer] Replay of recording #${meta.id} complete.`);
    } catch (err) {
      console.error('[Puppeteer Replay]', err.message);
    } finally {
      // Fix B3: browser always closes, even on error
      if (browser) {
        await sleep(3000);
        browser.close().catch(() => {});
      }
    }
  })();
});

const BTN = b => (b === 'right' ? 'right' : b === 'middle' ? 'middle' : 'left');

async function dispatchPuppeteerEvent(page, ev) {
  try {
    switch (ev.type) {
      // Fix B2: handle navigate events during replay
      case 'navigate':
        await page.goto(ev.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        break;
      case 'click':
        await page.mouse.click(ev.x, ev.y, { button: BTN(ev.button) });
        break;
      case 'dblclick':
        await page.mouse.click(ev.x, ev.y, { clickCount: 2 });
        break;
      case 'mousedown':
        await page.mouse.move(ev.x, ev.y);
        await page.mouse.down({ button: BTN(ev.button) });
        break;
      case 'mouseup':
        await page.mouse.move(ev.x, ev.y);
        await page.mouse.up({ button: BTN(ev.button) });
        break;
      case 'mousemove':
        await page.mouse.move(ev.x, ev.y);
        break;
      case 'wheel':
        await page.mouse.wheel({ deltaX: ev.deltaX, deltaY: ev.deltaY });
        break;
      case 'scroll':
        await page.evaluate((x, y) => window.scrollTo(x, y), ev.scrollX, ev.scrollY);
        break;
      // Fix B2: just press/release the key as-is; modifiers are separate recorded events
      case 'keydown':
        await page.keyboard.down(ev.key === ' ' ? 'Space' : ev.key);
        break;
      case 'keyup':
        await page.keyboard.up(ev.key === ' ' ? 'Space' : ev.key);
        break;
      case 'input':
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.keyboard.type(ev.value ?? '');
        break;
      case 'contenteditable':
        await page.evaluate(
          h => { if (document.activeElement) document.activeElement.innerHTML = h; },
          ev.html
        );
        break;
    }
  } catch {}
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

app.listen(PORT, () => {
  console.log(`\n[Server] Browser Automation Tool → http://localhost:${PORT}\n`);
});
