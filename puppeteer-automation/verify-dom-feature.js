const puppeteer = require('puppeteer-core');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const APP = 'http://localhost:3000';
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await sleep(2000);

  // Select recording #862 and replay against v2 (FAIL case)
  await page.evaluate(() => {
    for (const item of document.querySelectorAll('.rec-item'))
      if (item.dataset.id === '862') { item.click(); return; }
  });
  await sleep(400);

  const replayBtn = await page.$('#replay-btn');
  await replayBtn.click();
  console.log('[1] Replay started (fail case — 3 texts missing)');
  await sleep(12000);
  await page.screenshot({ path: '/tmp/verify-fail-ghost.png' });

  const badge = await page.$eval('#result-badge', el =>
    el.textContent.trim().replace(/\s+/g,' '));
  console.log('[2] Badge:', badge);

  // Scan canvas in logical pixel space for red dashed boxes
  // Recording rects: p2 y≈114, div y≈148, span y≈167
  const scan = await page.evaluate(() => {
    const c = document.getElementById('browser-canvas');
    const ctx = c.getContext('2d');
    const hits = {};
    // Check rows at recorded positions
    for (const scanY of [114, 148, 167]) {
      const row = ctx.getImageData(0, scanY, c.width, 1).data;
      let red = 0;
      for (let i = 0; i < row.length; i += 4) {
        const r=row[i], g=row[i+1], b=row[i+2], a=row[i+3];
        if (a < 30) continue;
        if (r > 180 && g < 100 && b < 100) red++;
      }
      hits[`y${scanY}`] = red;
    }
    return hits;
  });
  console.log('[3] Red pixels at recorded positions:', JSON.stringify(scan));

  await browser.close();
})().catch(e => { console.error('[ERROR]', e.message); process.exit(1); });
