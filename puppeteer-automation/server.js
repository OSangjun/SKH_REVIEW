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
const RECORDINGS_FILE = path.join(RECORDINGS_DIR, 'web-recordings.json');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Recordings persistence ───────────────────────────────────────────────────

let recordings = [];
let nextId = 1;

function loadRecordings() {
  try {
    if (fs.existsSync(RECORDINGS_FILE)) {
      recordings = JSON.parse(fs.readFileSync(RECORDINGS_FILE, 'utf8'));
      if (recordings.length > 0)
        nextId = Math.max(...recordings.map(r => r.id)) + 1;
    }
  } catch {}
}

function saveRecordings() {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  fs.writeFileSync(RECORDINGS_FILE, JSON.stringify(recordings, null, 2));
}

loadRecordings();

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

  // Strip Content-Security-Policy
  $('meta[http-equiv]').each((_, el) => {
    if (/content-security-policy/i.test($(el).attr('http-equiv') || ''))
      $(el).remove();
  });

  // Rewrite href (<a>, <link>)
  $('[href]').each((_, el) => {
    const v = $(el).attr('href');
    if (!isRewritable(v)) return;
    const abs = resolveUrl(pageUrl, v);
    if (abs) $(el).attr('href', toProxyHref(abs));
  });

  // Rewrite src (<script>, <img>, <source>, <iframe>, <video>, <audio>)
  $('[src]').each((_, el) => {
    const v = $(el).attr('src');
    if (!isRewritable(v)) return;
    const abs = resolveUrl(pageUrl, v);
    if (abs) $(el).attr('src', toProxyHref(abs));
  });

  // Rewrite srcset
  $('[srcset]').each((_, el) => {
    const srcset = $(el).attr('srcset') || '';
    const rewritten = srcset.replace(/([^\s,]+)(\s+[\d.]+[wx])?/g, (m, url, desc) => {
      if (!isRewritable(url)) return m;
      const abs = resolveUrl(pageUrl, url);
      return abs ? toProxyHref(abs) + (desc || '') : m;
    });
    $(el).attr('srcset', rewritten);
  });

  // Rewrite form action
  $('form[action]').each((_, el) => {
    const v = $(el).attr('action');
    if (!isRewritable(v)) return;
    const abs = resolveUrl(pageUrl, v);
    if (abs) $(el).attr('action', toProxyHref(abs));
  });

  // Inject recorder bootstrap + script
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
    res.status(502).send(`
      <html><body style="font-family:sans-serif;padding:32px;color:#c00">
        <h2>프록시 오류</h2><pre>${err.message}</pre>
        <p>URL: ${targetUrl}</p>
      </body></html>`);
  }
});

// ─── Recordings API ───────────────────────────────────────────────────────────

app.get('/api/recordings', (_req, res) => {
  res.json(
    recordings.map(({ id, name, url, events, createdAt }) => ({
      id,
      name,
      url,
      eventCount: events.length,
      createdAt,
    }))
  );
});

app.post('/api/recordings', (req, res) => {
  const { name, url, events } = req.body;
  if (!url || !Array.isArray(events))
    return res.status(400).json({ error: 'url and events required' });

  const id = nextId++;
  const rec = {
    id,
    name: name || `녹화 #${id}`,
    url,
    events,
    createdAt: new Date().toISOString(),
  };
  recordings.push(rec);
  saveRecordings();

  res.json({
    id: rec.id,
    name: rec.name,
    url: rec.url,
    eventCount: rec.events.length,
    createdAt: rec.createdAt,
  });
});

app.get('/api/recordings/:id', (req, res) => {
  const rec = recordings.find(r => r.id === +req.params.id);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  res.json(rec);
});

app.delete('/api/recordings/:id', (req, res) => {
  const idx = recordings.findIndex(r => r.id === +req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  recordings.splice(idx, 1);
  saveRecordings();
  res.json({ ok: true });
});

// ─── Puppeteer replay endpoint ────────────────────────────────────────────────

app.post('/api/replay/:id', async (req, res) => {
  const rec = recordings.find(r => r.id === +req.params.id);
  if (!rec) return res.status(404).json({ error: 'Not found' });

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
      await page.goto(rec.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      let lastT = 0;
      for (const ev of rec.events) {
        const delay = Math.max(0, ((ev.t ?? 0) - lastT) / speedFactor);
        if (delay > 0) await sleep(delay);
        lastT = ev.t ?? 0;
        await dispatchPuppeteerEvent(page, ev);
      }
      console.log(`[Puppeteer] Replay of recording #${rec.id} complete.`);
    } catch (err) {
      console.error('[Puppeteer Replay]', err.message);
    } finally {
      if (browser) setTimeout(() => browser.close(), 3000);
    }
  })();
});

const BTN = b => (b === 'right' ? 'right' : b === 'middle' ? 'middle' : 'left');

async function dispatchPuppeteerEvent(page, ev) {
  try {
    switch (ev.type) {
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
      case 'keydown':
        await page.keyboard.down(ev.key);
        break;
      case 'keyup':
        await page.keyboard.up(ev.key);
        break;
      case 'input':
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.keyboard.type(ev.value ?? '');
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
