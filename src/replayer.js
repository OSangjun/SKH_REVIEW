'use strict';

const puppeteer = require('puppeteer-core');
const fs = require('fs');

const CHROME_PATH =
  process.env.CHROME_PATH ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const BUTTON_MAP = { left: 'left', middle: 'middle', right: 'right' };

async function replay(url, inputFile, speedFactor = 1.0) {
  if (!fs.existsSync(inputFile)) {
    console.error(`[Replayer] File not found: ${inputFile}`);
    process.exit(1);
  }

  const events = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  console.log(`\n[Replayer] Loaded ${events.length} events from ${inputFile}`);
  console.log(`[Replayer] Speed: ${speedFactor}x  →  URL: ${url}\n`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: null,
  });

  const [page] = await browser.pages();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  let lastRelTime = 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const relTime = ev.t ?? 0;
    const delay = Math.max(0, (relTime - lastRelTime) / speedFactor);
    if (delay > 0) await sleep(delay);
    lastRelTime = relTime;

    const label = `[${String(i + 1).padStart(4)}/${events.length}] ${ev.type.padEnd(10)}`;
    process.stdout.write(`\r${label}`);

    try {
      await dispatch(page, ev);
    } catch (err) {
      console.warn(`\n[Replayer] Skipped event ${ev.type}: ${err.message}`);
    }
  }

  console.log('\n\n[Replayer] Replay complete.');
  await browser.close();
}

async function dispatch(page, ev) {
  switch (ev.type) {
    case 'mousemove':
      await page.mouse.move(ev.x, ev.y);
      break;

    case 'mousedown':
      await page.mouse.move(ev.x, ev.y);
      await page.mouse.down({ button: BUTTON_MAP[ev.button] ?? 'left' });
      break;

    case 'mouseup':
      await page.mouse.move(ev.x, ev.y);
      await page.mouse.up({ button: BUTTON_MAP[ev.button] ?? 'left' });
      break;

    case 'click':
      await page.mouse.click(ev.x, ev.y, { button: BUTTON_MAP[ev.button] ?? 'left' });
      break;

    case 'dblclick':
      await page.mouse.click(ev.x, ev.y, { clickCount: 2 });
      break;

    case 'wheel':
      await page.mouse.move(ev.x, ev.y);
      await page.mouse.wheel({ deltaX: ev.deltaX, deltaY: ev.deltaY });
      break;

    case 'scroll':
      await page.evaluate((x, y) => window.scrollTo(x, y), ev.scrollX, ev.scrollY);
      break;

    // Fix B2: modifier keys are already recorded as individual keydown/keyup events.
    // Just press/release the key as-is; pressing modifiers again would double-fire.
    case 'keydown':
      await page.keyboard.down(normalizeKey(ev.key));
      break;

    case 'keyup':
      await page.keyboard.up(normalizeKey(ev.key));
      break;

    // Fix U1: navigate events recorded during multi-page sessions
    case 'navigate':
      await page.goto(ev.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      break;

    case 'input':
      // Type the full current value by clearing first then typing
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await page.keyboard.type(ev.value ?? '');
      break;

    case 'select':
      await page.evaluate((val) => {
        const el = document.activeElement;
        if (el && el.tagName === 'SELECT') {
          el.value = val;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, ev.value);
      break;

    default:
      break;
  }
}

function normalizeKey(key) {
  return key === ' ' ? 'Space' : key;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { replay };
