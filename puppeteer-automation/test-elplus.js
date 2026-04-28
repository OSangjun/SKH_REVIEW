"use strict";
/**
 * test-elplus.js
 * Element Plus UI 컴포넌트 테스트 — 100개 이상의 테스트 케이스 생성 및 실행
 *
 * 컴포넌트: 버튼(10) + 셀렉트박스(5×5=25) + 인풋(10) + 체크박스(10) +
 *           라디오(4그룹×3=12) + 스위치(8) + 숫자인풋(5×5=25) = 100 TC
 */

const http    = require("http");
const express = require("express");
const puppeteer = require("puppeteer-core");
const path    = require("path");
const { spawn } = require("child_process");

const { openDb }          = require("./src/shared/db");
const { buildCaptureScript } = require("./src/server/inject");

const CHROME_PATH =
  process.env.CHROME_PATH ||
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const VIEWPORT = { width: 1920, height: 1080 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const VUE_JS  = path.join(__dirname, "node_modules/vue/dist/vue.global.prod.js");
const EP_JS   = path.join(__dirname, "node_modules/element-plus/dist/index.full.min.js");
const EP_CSS  = path.join(__dirname, "node_modules/element-plus/dist/index.css");

// ─── 1. HTML Page ──────────────────────────────────────────────────────────────

const PAGE_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>El Plus Test</title>
  <link rel="stylesheet" href="/ep.css">
  <style>
    body { font-family: sans-serif; padding: 20px; max-width: 1600px; }
    .section { margin: 0 0 18px; }
    .section h3 { font-size: 12px; color: #888; margin: 0 0 8px; font-weight: 600; text-transform: uppercase; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .el-input { width: 140px; }
    .el-select { width: 140px; }
    .el-input-number { width: 140px; }
  </style>
</head>
<body>
<div id="app">
  <!-- Buttons 1-10 -->
  <div class="section">
    <h3>Buttons (10)</h3>
    <div class="row">
      <el-button v-for="n in 10" :key="n"
        :data-testid="'btn-' + n"
        :type="['primary','success','warning','danger','info','primary','success','warning','danger','info'][n-1]"
        @click="handleBtn(n)">Button {{ n }}</el-button>
    </div>
  </div>
  <!-- Selects 1-5, each with 5 options -->
  <div class="section">
    <h3>Selects (5 × 5 options)</h3>
    <div class="row">
      <el-select v-for="s in 5" :key="s"
        :data-testid="'select-' + s"
        v-model="selectVals[s-1]"
        :placeholder="'Select ' + s"
        @change="handleSelect(s, $event)">
        <el-option v-for="m in 5" :key="m" :label="'Option ' + m" :value="'opt-' + m" />
      </el-select>
    </div>
  </div>
  <!-- Inputs 1-10 -->
  <div class="section">
    <h3>Inputs (10)</h3>
    <div class="row">
      <el-input v-for="n in 10" :key="n"
        :data-testid="'input-' + n"
        v-model="inputVals[n-1]"
        :placeholder="'Input ' + n"
        @change="handleInput(n, $event)" />
    </div>
  </div>
  <!-- Checkboxes 1-10 -->
  <div class="section">
    <h3>Checkboxes (10)</h3>
    <div class="row">
      <el-checkbox v-for="n in 10" :key="n"
        :data-testid="'check-' + n"
        v-model="checkVals[n-1]"
        @change="handleCheck(n, $event)">Check {{ n }}</el-checkbox>
    </div>
  </div>
  <!-- Radio groups: 4 groups × 3 radios each -->
  <div class="section">
    <h3>Radios (4 groups × 3)</h3>
    <div v-for="g in 4" :key="g" class="row" style="margin-bottom:6px">
      <span style="font-size:11px;color:#aaa;width:55px">G{{ g }}:</span>
      <el-radio v-for="m in 3" :key="m"
        :data-testid="'radio-' + g + '-' + m"
        v-model="radioVals[g-1]"
        :label="'r' + m"
        @change="handleRadio(g, $event)">R{{ g }}-{{ m }}</el-radio>
    </div>
  </div>
  <!-- Switches 1-8 -->
  <div class="section">
    <h3>Switches (8)</h3>
    <div class="row">
      <el-switch v-for="n in 8" :key="n"
        :data-testid="'switch-' + n"
        v-model="switchVals[n-1]"
        @change="handleSwitch(n, $event)" />
    </div>
  </div>
  <!-- Number inputs 1-5 -->
  <div class="section">
    <h3>Number Inputs (5)</h3>
    <div class="row">
      <el-input-number v-for="n in 5" :key="n"
        :data-testid="'number-' + n"
        v-model="numberVals[n-1]"
        :min="1" :max="999"
        @change="handleNumber(n, $event)" />
    </div>
  </div>
</div>

<script src="/vue.js"></script>
<script src="/ep.js"></script>
<script>
const { createApp, ref } = Vue;
createApp({
  setup() {
    const selectVals = ref(Array(5).fill(''));
    const inputVals  = ref(Array(10).fill(''));
    const checkVals  = ref(Array(10).fill(false));
    const radioVals  = ref(Array(4).fill(''));
    const switchVals = ref(Array(8).fill(false));
    const numberVals = ref(Array(5).fill(1));

    async function post(data) {
      const r = await fetch('/api/ep/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      return r.json();
    }

    const handleBtn    = n       => post({ type: 'button',   id: n, value: null });
    const handleSelect = (n, v)  => post({ type: 'select',   id: n, value: v });
    const handleInput  = (n, v)  => post({ type: 'input',    id: n, value: v });
    const handleCheck  = (n, v)  => post({ type: 'check',    id: n, value: v });
    const handleRadio  = (n, v)  => post({ type: 'radio',    id: n, value: v });
    const handleSwitch = (n, v)  => post({ type: 'switch',   id: n, value: v });
    const handleNumber = (n, v)  => post({ type: 'number',   id: n, value: v });

    return { selectVals, inputVals, checkVals, radioVals, switchVals, numberVals,
             handleBtn, handleSelect, handleInput, handleCheck,
             handleRadio, handleSwitch, handleNumber };
  }
}).use(ElementPlus).mount('#app');
window.__vueAppMounted__ = true;
</script>
</body>
</html>`;

// ─── 2. Express Server ─────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  app.get("/vue.js",  (_, res) => res.sendFile(VUE_JS));
  app.get("/ep.js",   (_, res) => res.sendFile(EP_JS));
  app.get("/ep.css",  (_, res) => res.sendFile(EP_CSS));
  app.post("/api/ep/action", (req, res) => {
    const { type, id, value } = req.body || {};
    if (!type) return res.status(400).json({ error: "type required" });
    res.json({ ok: true, type, id, value });
  });
  app.get("/", (_req, res) => res.send(PAGE_HTML));
  return app;
}

// ─── 3. Response Capture Helper ────────────────────────────────────────────────

function makeRespListener(responses, pending) {
  return (response) => {
    const url = response.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    const rt = response.request().resourceType();
    if (rt !== "xhr" && rt !== "fetch") return;
    const ct = (response.headers()["content-type"] || "").toLowerCase();
    const st = response.status();
    if (!/json|text\/plain/.test(ct)) {
      responses.push({ url, status: st, contentType: ct, body: null }); return;
    }
    const p = response.buffer()
      .then(buf => responses.push({
        url, status: st, contentType: ct,
        body: buf.length <= 51200 ? buf.toString("utf8") : null,
      }))
      .catch(() => responses.push({ url, status: st, contentType: ct, body: null }))
      .finally(() => pending.delete(p));
    pending.add(p);
  };
}

// ─── 4. DB Save ────────────────────────────────────────────────────────────────

function saveRecording(db, name, url, events, responses) {
  const TRIGGERS = new Set(["click", "dblclick", "navigate", "check", "select"]);
  const triggerIdxs = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (TRIGGERS.has(ev.type) || (ev.type === "keydown" && ev.key === "Enter"))
      triggerIdxs.push(i);
  }
  if (triggerIdxs.length > 0 && responses.length > 0)
    events[triggerIdxs[triggerIdxs.length - 1]].triggeredUrls = responses.map(r => r.url);

  const stmt = db.prepare(
    `INSERT INTO recordings (name, url, event_count, created_at, events, responses, cookies, toasts)
     VALUES (?, ?, ?, ?, ?, ?, '[]', '[]')`
  );
  const info = stmt.run(
    name, url, events.length, new Date().toISOString(),
    JSON.stringify(events), JSON.stringify(responses)
  );
  console.log(`  ✓ [${info.lastInsertRowid}] "${name}"  ev:${events.length} resp:${responses.length}`);
}

// ─── 5. Generic TC Recorder ────────────────────────────────────────────────────
// Uses the injected capture script to collect real events.

async function recordTC(page, db, baseUrl, name, interactFn) {

  const responses = [];
  const pending = new Set();
  const listener = makeRespListener(responses, pending);
  page.on("response", listener);

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => !!window.__vueAppMounted__, { timeout: 15000 });
    await sleep(200);
    await page.evaluate(() => { window.__events__ = []; }); // clear load-time events

    const baseT = Date.now();
    await interactFn(page, baseT);
    await sleep(300); // let capture bridge flush

    await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
    if (pending.size > 0)
      await Promise.race([Promise.allSettled([...pending]), sleep(2000)]);

    // Collect events captured by inject script
    const raw = await page.evaluate(() => {
      const evs = window.__events__.slice();
      window.__events__ = [];
      return evs;
    });

    const KEEP = new Set(["click", "dblclick", "input", "check", "select", "keydown"]);
    const filtered = raw.filter(e => KEEP.has(e.type));
    const tBase = filtered.length > 0 ? (filtered[0].t ?? baseT) : baseT;
    filtered.forEach(ev => { ev.t = Math.max(0, (ev.t ?? tBase) - tBase + 500); });

    const allEvents = [{ type: "navigate", url: baseUrl, t: 0 }, ...filtered];
    saveRecording(db, name, baseUrl, allEvents, responses);
  } finally {
    page.off("response", listener);
  }
}

// Click an El Plus select trigger robustly (bypasses strict clickability check).
async function clickSelect(page, selector) {
  await page.$eval(selector, el => {
    const wrapper = el.querySelector('.el-select__wrapper') || el;
    wrapper.click();
  });
}

// Click the VISIBLE dropdown option matching optText.
// El Plus renders ALL popper panels in DOM (even closed ones), so we must
// filter to only those with non-zero bounding boxes (i.e. currently visible).
async function clickSelectOption(page, optText) {
  const clicked = await page.evaluate((txt) => {
    const items = document.querySelectorAll('.el-select-dropdown__item');
    for (const item of items) {
      const r = item.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // skip hidden items
      if ((item.textContent || "").trim() === txt) {
        item.click();
        return true;
      }
    }
    return false;
  }, optText);
  if (!clicked) throw new Error(`Option not found or not visible: ${optText}`);
}

// ─── 6. Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Browser Automation Tool — El Plus 테스트 (100 TC)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // DB 초기화
  const db = openDb();
  db.exec("DELETE FROM run_history");
  db.exec("DELETE FROM recordings");
  console.log("✓ DB 초기화\n");

  // 서버 기동
  const server = http.createServer(makeApp());
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const PORT = server.address().port;
  const BASE = `http://127.0.0.1:${PORT}`;
  console.log(`✓ 테스트 서버: ${BASE}\n`);

  // 브라우저 기동
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: VIEWPORT,
  });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  console.log("✓ Chromium 기동\n");

  // 캡처 스크립트 주입 — cap(type, data) 시그니처로 이벤트 병합
  await page.evaluateOnNewDocument(`
    window.__events__ = [];
    window.__captureEvent = function(type, data) {
      var ev = Object.assign({ type: type, t: Date.now() }, data || {});
      window.__events__.push(ev);
    };
    window.__captureToast = function() {};
    ${buildCaptureScript()}
  `);

  let tcNum = 0;
  const tc = (n) => { tcNum++; return `TC-${String(tcNum).padStart(3,"0")}-${n}`; };

  console.log("─── 녹화 시작 ──────────────────────────────────────────────────");

  // ── TC-B01~B10: 버튼 (10개) ─────────────────────────────────────────────────
  console.log("\n[버튼 10개]");
  for (let n = 1; n <= 10; n++) {
    await recordTC(page, db, BASE, tc(`버튼-${n}`), async (p) => {
      await p.$eval(`[data-testid="btn-${n}"]`, el => el.click());
    });
  }

  // ── TC-S01~S25: 셀렉트 (5 × 5) ──────────────────────────────────────────────
  console.log("\n[셀렉트 5×5]");
  for (let s = 1; s <= 5; s++) {
    for (let m = 1; m <= 5; m++) {
      await recordTC(page, db, BASE, tc(`셀렉트-${s}-옵션-${m}`), async (p) => {
        const selectSel = `[data-testid="select-${s}"]`;
        // 1. 셀렉트 wrapper 클릭 (드롭다운 열기 — evaluate로 엄격한 clickability 우회)
        await clickSelect(p, selectSel);
        // 2. 드롭다운 아이템 대기 (visible item 기다림)
        await p.waitForFunction(() => {
          const items = document.querySelectorAll(".el-select-dropdown__item");
          return [...items].some(el => el.getBoundingClientRect().height > 0);
        }, { timeout: 3000 });
        // 3. 해당 옵션 클릭 (visible 아이템만 대상)
        await clickSelectOption(p, `Option ${m}`);
        // 4. findAssociatedSelect이 is-focus를 못 잡을 수 있으므로 명시적으로 주입
        await p.evaluate((selSel) => {
          for (let i = window.__events__.length - 1; i >= 0; i--) {
            const ev = window.__events__[i];
            if (ev.type === "click" && ev.selector &&
                ev.selector.includes("el-select-dropdown__item")) {
              ev.elSelectSelector = selSel;
              break;
            }
          }
        }, selectSel);
      });
    }
  }

  // ── TC-I01~I10: 인풋 (10개) ─────────────────────────────────────────────────
  console.log("\n[인풋 10개]");
  const inputValues = ["Hello", "World", "Test123", "FooBar", "엘플러스",
                       "AlphaNum", "BetaTest", "GammaQ", "DeltaX", "EpsilonZ"];
  for (let n = 1; n <= 10; n++) {
    const val = inputValues[n - 1];
    await recordTC(page, db, BASE, tc(`인풋-${n}`), async (p, baseT) => {
      const sel = `[data-testid="input-${n}"]`;
      const el  = await p.$(sel);
      const box = await el.boundingBox();
      // Triple-click to select all, then type
      await el.click({ clickCount: 3 });
      await p.keyboard.type(val);
      // Enter triggers el-input @change via handleEnterDown (more reliable than
      // Tab which requires focus movement + blur, and is not a network trigger).
      await p.keyboard.press("Enter");
      // Reorder events: [click, char_keydowns, input, keydown_Enter]
      // — Korean chars don't produce keydown events via insertText, so without
      //   this reorder Enter fires before value is typed → wrong @change value.
      await p.evaluate((s, v, bx, by) => {
        const clickEv  = window.__events__.find(e => e.type === "click");
        const enterEv  = window.__events__.find(e => e.type === "keydown" && (e.key === "Enter" || e.code === "Enter"));
        const charKds  = window.__events__.filter(e => e.type === "keydown" && e.key !== "Enter" && e.key !== "Tab");
        const evts = [];
        if (clickEv) evts.push(clickEv);
        evts.push(...charKds);  // per-char keydowns (ASCII only; Korean has none)
        evts.push({ type: "input", selector: s, value: v, x: bx, y: by, t: 500 });
        if (enterEv) evts.push(enterEv);  // keep original event object with triggeredUrls
        window.__events__ = evts;
      }, sel, val,
        Math.round(box.x + box.width / 2),
        Math.round(box.y + box.height / 2));
    });
  }

  // ── TC-C01~C10: 체크박스 (10개) ─────────────────────────────────────────────
  console.log("\n[체크박스 10개]");
  for (let n = 1; n <= 10; n++) {
    await recordTC(page, db, BASE, tc(`체크박스-${n}`), async (p) => {
      await p.$eval(`[data-testid="check-${n}"]`, el => el.click());
    });
  }

  // ── TC-R01~R12: 라디오 (4그룹 × 3) ──────────────────────────────────────────
  console.log("\n[라디오 4×3]");
  for (let g = 1; g <= 4; g++) {
    for (let m = 1; m <= 3; m++) {
      await recordTC(page, db, BASE, tc(`라디오-${g}-${m}`), async (p) => {
        await p.$eval(`[data-testid="radio-${g}-${m}"]`, el => el.click());
        // El Plus 라디오는 내부 input.click()을 재발화해 click 이벤트가 중복 기록됨.
        // check/input 이벤트도 spurious. 첫 번째 click만 남겨 triggeredUrls를 click에 배치.
        await p.evaluate(() => {
          const cleaned = [];
          let clickSeen = false;
          for (const ev of window.__events__) {
            if (ev.type === "click") {
              if (!clickSeen) { cleaned.push(ev); clickSeen = true; }
              // 중복 click 제거
            }
            // input/check 이벤트 제거 (radio TC에서는 spurious)
          }
          window.__events__ = cleaned;
        });
      });
    }
  }

  // ── TC-SW01~SW08: 스위치 (8개) ──────────────────────────────────────────────
  console.log("\n[스위치 8개]");
  for (let n = 1; n <= 8; n++) {
    await recordTC(page, db, BASE, tc(`스위치-${n}`), async (p) => {
      await p.$eval(`[data-testid="switch-${n}"]`, el => el.click());
    });
  }

  // ── TC-N01~N25: 숫자 인풋 (5개 × 5가지 값) ─────────────────────────────────
  console.log("\n[숫자 인풋 5×5]");
  const numVals = [10, 25, 50, 75, 99];
  for (let n = 1; n <= 5; n++) {
    for (const val of numVals) {
      await recordTC(page, db, BASE, tc(`숫자-${n}-값-${val}`), async (p) => {
        const sel = `[data-testid="number-${n}"]`;
        const el  = await p.$(sel);
        const box = await el.boundingBox();
        const inner = await el.$("input");
        const target = inner || el;
        await target.click({ clickCount: 3 });
        await p.keyboard.type(String(val));
        await p.keyboard.press("Enter"); // @change 트리거 (blur or Enter on number input)
        // 이벤트 재정렬: [click, input, keydown Enter]
        // — click: 포커스/전체선택, input: 값 입력, keydown Enter: @change → API 호출 트리거
        await p.evaluate((s, v, bx, by) => {
          const clickEv  = window.__events__.find(e => e.type === "click");
          const enterEv  = window.__events__.find(
            e => e.type === "keydown" && (e.key === "Enter" || e.code === "Enter")
          );
          const evts = [];
          if (clickEv) evts.push(clickEv);
          evts.push({ type: "input", selector: s, value: String(v), x: bx, y: by, t: 500 });
          if (enterEv) evts.push({ type: "keydown", key: "Enter", code: "Enter", t: 600 });
          window.__events__ = evts;
        }, sel, val,
          Math.round(box.x + box.width / 2),
          Math.round(box.y + box.height / 2));
      });
    }
  }

  await browser.close();
  await new Promise(r => server.close(r)); // wait for port release

  const total = db.prepare("SELECT COUNT(*) as c FROM recordings").get().c;
  console.log(`\n✓ 녹화 완료: ${total}개 TC\n`);

  // ─── 7. 리플레이 실행 ─────────────────────────────────────────────────────────
  // spawn (not execSync) so the parent event loop keeps running for the Express server.

  function runTests(baseUrl, extraArgs = []) {
    return new Promise(resolve => {
      const child = spawn(
        process.execPath,
        ["run-tests.js", "--all", "--fast", "--base-url", baseUrl, ...extraArgs],
        { cwd: __dirname, stdio: "inherit" }
      );
      child.on("exit", code => { console.log(`\nrun-tests.js 종료 코드: ${code}`); resolve(code); });
    });
  }

  // Reuse same PORT — browser connections are closed, so the port is free after server.close().
  const server2 = http.createServer(makeApp());
  await new Promise((res, rej) => { server2.once("error", rej); server2.listen(PORT, "127.0.0.1", res); });
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  리플레이 실행 (목 응답 모드)");
  console.log("═══════════════════════════════════════════════════════════════\n");
  console.log(`✓ 리플레이 서버: http://127.0.0.1:${PORT}\n`);
  await runTests(`http://127.0.0.1:${PORT}`);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  리플레이 실행 (실서버 모드 --no-mock-replay)");
  console.log("═══════════════════════════════════════════════════════════════\n");
  await runTests(`http://127.0.0.1:${PORT}`, ["--no-mock-replay"]);

  await new Promise(r => server2.close(r)).catch(() => {});
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
