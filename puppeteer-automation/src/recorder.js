'use strict';

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME_PATH =
  process.env.CHROME_PATH ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const MOUSEMOVE_THROTTLE_MS = 50;
const SCROLL_THROTTLE_MS = 100;

async function record(url, outputFile) {
  console.log(`\n[Recorder] Opening: ${url}`);
  console.log('[Recorder] Interact with the browser. Close it when done.\n');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: null,
  });

  const [page] = await browser.pages();
  const events = [];
  let startTime = null;

  function pushEvent(event) {
    if (startTime === null) startTime = event.timestamp;
    events.push({ ...event, t: event.timestamp - startTime });
    process.stdout.write(`\r[Recorder] Events captured: ${events.length}   `);
  }

  await page.exposeFunction('__recorderPush', pushEvent);

  page.on('load', async () => {
    try {
      await injectListeners(page);
    } catch (_) {
      // frame may have navigated away
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await injectListeners(page);

  browser.on('disconnected', () => {
    finalize(events, outputFile);
  });

  await browser.waitForTarget(() => false).catch(() => {});
}

async function injectListeners(page) {
  await page.evaluateOnNewDocument(buildListenerScript());
  await page.evaluate(buildListenerScript());
}

function buildListenerScript() {
  const throttleMs_move = MOUSEMOVE_THROTTLE_MS;
  const throttleMs_scroll = SCROLL_THROTTLE_MS;

  return `(function() {
    if (window.__recorderActive) return;
    window.__recorderActive = true;

    const push = window.__recorderPush;
    let lastMove = 0;
    let lastScroll = 0;

    function ts() { return Date.now(); }

    function buttonName(b) {
      return b === 2 ? 'right' : b === 1 ? 'middle' : 'left';
    }

    document.addEventListener('mousedown', e => {
      push({ type: 'mousedown', timestamp: ts(), x: e.clientX, y: e.clientY, button: buttonName(e.button) });
    }, true);

    document.addEventListener('mouseup', e => {
      push({ type: 'mouseup', timestamp: ts(), x: e.clientX, y: e.clientY, button: buttonName(e.button) });
    }, true);

    document.addEventListener('click', e => {
      push({ type: 'click', timestamp: ts(), x: e.clientX, y: e.clientY, button: buttonName(e.button) });
    }, true);

    document.addEventListener('dblclick', e => {
      push({ type: 'dblclick', timestamp: ts(), x: e.clientX, y: e.clientY });
    }, true);

    document.addEventListener('mousemove', e => {
      const now = ts();
      if (now - lastMove < ${throttleMs_move}) return;
      lastMove = now;
      push({ type: 'mousemove', timestamp: now, x: e.clientX, y: e.clientY });
    }, true);

    document.addEventListener('wheel', e => {
      push({ type: 'wheel', timestamp: ts(), x: e.clientX, y: e.clientY, deltaX: e.deltaX, deltaY: e.deltaY });
    }, { capture: true, passive: true });

    window.addEventListener('scroll', () => {
      const now = ts();
      if (now - lastScroll < ${throttleMs_scroll}) return;
      lastScroll = now;
      push({ type: 'scroll', timestamp: now, scrollX: window.scrollX, scrollY: window.scrollY });
    }, true);

    document.addEventListener('keydown', e => {
      push({
        type: 'keydown',
        timestamp: ts(),
        key: e.key,
        code: e.code,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
        meta: e.metaKey,
      });
    }, true);

    document.addEventListener('keyup', e => {
      push({ type: 'keyup', timestamp: ts(), key: e.key, code: e.code });
    }, true);

    document.addEventListener('input', e => {
      const el = e.target;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        push({ type: 'input', timestamp: ts(), value: el.value });
      }
    }, true);

    document.addEventListener('change', e => {
      const el = e.target;
      if (el && el.tagName === 'SELECT') {
        push({ type: 'select', timestamp: ts(), value: el.value });
      }
    }, true);
  })();`;
}

function finalize(events, outputFile) {
  const dir = path.dirname(outputFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(events, null, 2));
  console.log(`\n\n[Recorder] Saved ${events.length} events → ${outputFile}`);
}

module.exports = { record };
