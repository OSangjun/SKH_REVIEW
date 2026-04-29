#!/usr/bin/env node
"use strict";
/**
 * test-elplus-10.js
 * Element Plus UI 컴포넌트 — 10개 테스트 케이스 녹화 & Mock 리플레이 검증
 *
 * 목표:
 *   1. 로컬 Element Plus 앱(서버)을 띄운다
 *   2. 10개 TC를 Puppeteer로 녹화한다
 *   3. 목(Mock) 리플레이 모드로 재생 → 실서버 API 요청 0건 검증
 *   4. 실서버 모드로 재생 → API 요청이 실제로 도달함을 대비 확인
 *
 * TC 목록 (컴포넌트별 2개씩):
 *   #01 버튼-1       버튼 1 클릭
 *   #02 버튼-5       버튼 5 클릭
 *   #03 셀렉트-1-opt1 Select 1 → Option 1 선택
 *   #04 셀렉트-3-opt3 Select 3 → Option 3 선택
 *   #05 인풋-1       Input 1 에 "Hello" 입력
 *   #06 인풋-2       Input 2 에 "World" 입력
 *   #07 체크박스-1    Checkbox 1 토글
 *   #08 체크박스-5    Checkbox 5 토글
 *   #09 스위치-1      Switch 1 토글
 *   #10 스위치-3      Switch 3 토글
 */

const http    = require("http");
const express = require("express");
const puppeteer = require("puppeteer-core");
const path    = require("path");
const { spawn } = require("child_process");

const { openDb }             = require("./src/shared/db");
const { buildCaptureScript } = require("./src/server/inject");

const CHROME_PATH =
  process.env.CHROME_PATH ||
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const VIEWPORT = { width: 1920, height: 1080 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const VUE_JS = path.join(__dirname, "node_modules/vue/dist/vue.global.prod.js");
const EP_JS  = path.join(__dirname, "node_modules/element-plus/dist/index.full.min.js");
const EP_CSS = path.join(__dirname, "node_modules/element-plus/dist/index.css");

// ─── 1. HTML Page (El Plus 컴포넌트 + API 호출) ─────────────────────────────────

const PAGE_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>El Plus 10 TC</title>
  <link rel="stylesheet" href="/ep.css">
  <style>
    body { font-family: sans-serif; padding: 24px; max-width: 1400px; }
    .section { margin-bottom: 20px; }
    .section h3 { font-size: 12px; color: #888; margin: 0 0 10px;
                  font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
    .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .el-input { width: 150px; }
    .el-select { width: 150px; }
    #api-log { margin-top: 20px; font-size: 12px; color: #aaa;
               border-top: 1px solid #eee; padding-top: 10px; }
  </style>
</head>
<body>
<div id="app">
  <!-- Buttons -->
  <div class="section">
    <h3>버튼 (10)</h3>
    <div class="row">
      <el-button v-for="n in 10" :key="n"
        :data-testid="'btn-' + n"
        :type="['primary','success','warning','danger','info',
                'primary','success','warning','danger','info'][n-1]"
        @click="doBtn(n)">버튼 {{ n }}</el-button>
    </div>
  </div>

  <!-- Selects -->
  <div class="section">
    <h3>셀렉트 (5)</h3>
    <div class="row">
      <el-select v-for="s in 5" :key="s"
        :data-testid="'select-' + s"
        v-model="selVals[s-1]"
        :placeholder="'Select ' + s"
        @change="doSelect(s, $event)">
        <el-option v-for="m in 5" :key="m"
          :label="'Option ' + m" :value="'opt-' + m" />
      </el-select>
    </div>
  </div>

  <!-- Inputs -->
  <div class="section">
    <h3>인풋 (5)</h3>
    <div class="row">
      <el-input v-for="n in 5" :key="n"
        :data-testid="'input-' + n"
        v-model="inpVals[n-1]"
        :placeholder="'Input ' + n"
        @change="doInput(n, $event)" />
    </div>
  </div>

  <!-- Checkboxes -->
  <div class="section">
    <h3>체크박스 (5)</h3>
    <div class="row">
      <el-checkbox v-for="n in 5" :key="n"
        :data-testid="'check-' + n"
        v-model="chkVals[n-1]"
        @change="doCheck(n, $event)">Check {{ n }}</el-checkbox>
    </div>
  </div>

  <!-- Switches -->
  <div class="section">
    <h3>스위치 (5)</h3>
    <div class="row">
      <el-switch v-for="n in 5" :key="n"
        :data-testid="'switch-' + n"
        v-model="swVals[n-1]"
        @change="doSwitch(n, $event)" />
    </div>
  </div>

  <div id="api-log">마지막 API: {{ lastCall || '—' }}</div>
</div>

<script src="/vue.js"></script>
<script src="/ep.js"></script>
<script>
const { createApp, ref } = Vue;
createApp({
  setup() {
    const selVals  = ref(Array(5).fill(''));
    const inpVals  = ref(Array(5).fill(''));
    const chkVals  = ref(Array(5).fill(false));
    const swVals   = ref(Array(5).fill(false));
    const lastCall = ref('');

    async function post(data) {
      const r = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await r.json();
      lastCall.value = JSON.stringify(data);
      return json;
    }

    const doBtn    = n       => post({ type: 'button',   id: n, value: null });
    const doSelect = (n, v)  => post({ type: 'select',   id: n, value: v   });
    const doInput  = (n, v)  => post({ type: 'input',    id: n, value: v   });
    const doCheck  = (n, v)  => post({ type: 'check',    id: n, value: v   });
    const doSwitch = (n, v)  => post({ type: 'switch',   id: n, value: v   });

    return { selVals, inpVals, chkVals, swVals, lastCall,
             doBtn, doSelect, doInput, doCheck, doSwitch };
  }
}).use(ElementPlus).mount('#app');
window.__vueAppMounted__ = true;
</script>
</body>
</html>`;

// ─── 2. Express 서버 + API 히트 카운터 ─────────────────────────────────────────

let apiHitCount = 0;
function resetApiHitCount() { apiHitCount = 0; }
function getApiHitCount() { return apiHitCount; }

function makeApp() {
  const app = express();
  app.use(express.json());
  app.get("/vue.js",  (_, res) => res.sendFile(VUE_JS));
  app.get("/ep.js",   (_, res) => res.sendFile(EP_JS));
  app.get("/ep.css",  (_, res) => res.sendFile(EP_CSS));
  app.get("/", (_req, res) => res.send(PAGE_HTML));

  // API 히트 카운터 미들웨어
  app.use("/api", (req, _res, next) => {
    apiHitCount++;
    next();
  });

  app.post("/api/action", (req, res) => {
    const { type, id, value } = req.body || {};
    if (!type) return res.status(400).json({ error: "type required" });
    res.json({ ok: true, type, id, value });
  });

  return app;
}

// ─── 3. 응답 캡처 헬퍼 ──────────────────────────────────────────────────────────

function makeRespListener(responses, pending) {
  return (response) => {
    const url = response.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    const rt = response.request().resourceType();
    if (rt !== "xhr" && rt !== "fetch") return;
    const ct = (response.headers()["content-type"] || "").toLowerCase();
    const st = response.status();
    if (!/json|text\/plain/.test(ct)) {
      responses.push({ url, status: st, contentType: ct, body: null });
      return;
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

// ─── 4. DB 저장 ──────────────────────────────────────────────────────────────────

function saveRecording(db, name, url, events, responses) {
  const TRIGGERS = new Set(["click","dblclick","navigate","check","select"]);
  const triggerIdxs = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (TRIGGERS.has(ev.type) || (ev.type === "keydown" && ev.key === "Enter"))
      triggerIdxs.push(i);
  }
  if (triggerIdxs.length > 0 && responses.length > 0)
    events[triggerIdxs[triggerIdxs.length - 1]].triggeredUrls = responses.map(r => r.url);

  const info = db.prepare(
    `INSERT INTO recordings (name, url, event_count, created_at, events, responses, cookies, toasts)
     VALUES (?, ?, ?, ?, ?, ?, '[]', '[]')`
  ).run(name, url, events.length, new Date().toISOString(),
        JSON.stringify(events), JSON.stringify(responses));
  return info.lastInsertRowid;
}

// ─── 5. TC 녹화 헬퍼 ────────────────────────────────────────────────────────────

async function recordTC(page, db, baseUrl, name, interactFn) {
  const responses = [];
  const pending   = new Set();
  const listener  = makeRespListener(responses, pending);
  page.on("response", listener);

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => !!window.__vueAppMounted__, { timeout: 15000 });
    await sleep(200);
    await page.evaluate(() => { window.__events__ = []; });

    const baseT = Date.now();
    await interactFn(page, baseT);
    await sleep(300);

    await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
    if (pending.size > 0)
      await Promise.race([Promise.allSettled([...pending]), sleep(2000)]);

    const raw = await page.evaluate(() => {
      const evs = window.__events__.slice();
      window.__events__ = [];
      return evs;
    });

    const KEEP = new Set(["click","dblclick","input","check","select","keydown"]);
    const filtered = raw.filter(e => KEEP.has(e.type));
    const tBase = filtered.length > 0 ? (filtered[0].t ?? baseT) : baseT;
    filtered.forEach(ev => { ev.t = Math.max(0, (ev.t ?? tBase) - tBase + 500); });

    const allEvents = [{ type: "navigate", url: baseUrl, t: 0 }, ...filtered];
    const id = saveRecording(db, name, baseUrl, allEvents, responses);
    return { id, eventCount: allEvents.length, responseCount: responses.length };
  } finally {
    page.off("response", listener);
  }
}

// El Plus 셀렉트 클릭 유틸
async function clickSelect(page, selector) {
  await page.$eval(selector, el => {
    (el.querySelector(".el-select__wrapper") || el).click();
  });
}
async function clickSelectOption(page, optText) {
  const clicked = await page.evaluate(txt => {
    for (const item of document.querySelectorAll(".el-select-dropdown__item")) {
      const r = item.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if ((item.textContent || "").trim() === txt) { item.click(); return true; }
    }
    return false;
  }, optText);
  if (!clicked) throw new Error(`Option not visible: ${optText}`);
}

// ─── 6. 메인 ────────────────────────────────────────────────────────────────────

async function main() {
  const W = 63;
  const line = "═".repeat(W);
  console.log(`\n${line}`);
  console.log("  Browser Automation — Element Plus 10 TC Mock 리플레이 검증");
  console.log(line + "\n");

  // DB 초기화
  const db = openDb();
  db.exec("DELETE FROM run_history");
  db.exec("DELETE FROM recordings");
  console.log("✓ DB 초기화\n");

  // 서버 기동
  const server = http.createServer(makeApp());
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const PORT  = server.address().port;
  const BASE  = `http://127.0.0.1:${PORT}`;
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

  // 캡처 스크립트 주입
  await page.evaluateOnNewDocument(`
    window.__events__ = [];
    window.__captureEvent = function(type, data) {
      window.__events__.push(Object.assign({ type, t: Date.now() }, data || {}));
    };
    window.__captureToast = function() {};
    ${buildCaptureScript()}
  `);

  // ─── 10개 TC 녹화 ─────────────────────────────────────────────────────────────
  console.log("─── 녹화 시작 (10 TC) " + "─".repeat(40));

  const recordings = [];
  let tcNum = 0;
  const tc = n => `TC-${String(++tcNum).padStart(2,"0")}-${n}`;

  // TC-01: 버튼 1
  recordings.push(await recordTC(page, db, BASE, tc("버튼-1"), async p => {
    await p.$eval('[data-testid="btn-1"]', el => el.click());
  }));
  console.log(`  ✓ [${recordings.at(-1).id}] TC-01 버튼-1  (ev:${recordings.at(-1).eventCount} resp:${recordings.at(-1).responseCount})`);

  // TC-02: 버튼 5
  recordings.push(await recordTC(page, db, BASE, tc("버튼-5"), async p => {
    await p.$eval('[data-testid="btn-5"]', el => el.click());
  }));
  console.log(`  ✓ [${recordings.at(-1).id}] TC-02 버튼-5  (ev:${recordings.at(-1).eventCount} resp:${recordings.at(-1).responseCount})`);

  // TC-03: 셀렉트 1 → Option 1
  recordings.push(await recordTC(page, db, BASE, tc("셀렉트-1-opt1"), async p => {
    await clickSelect(p, '[data-testid="select-1"]');
    await p.waitForFunction(() =>
      [...document.querySelectorAll(".el-select-dropdown__item")]
        .some(el => el.getBoundingClientRect().height > 0), { timeout: 3000 });
    await clickSelectOption(p, "Option 1");
    await p.evaluate(() => {
      const last = window.__events__.slice().reverse().find(e =>
        e.type === "click" && e.selector && e.selector.includes("select-dropdown__item"));
      if (last) last.elSelectSelector = '[data-testid="select-1"]';
    });
  }));
  console.log(`  ✓ [${recordings.at(-1).id}] TC-03 셀렉트-1-opt1  (ev:${recordings.at(-1).eventCount} resp:${recordings.at(-1).responseCount})`);

  // TC-04: 셀렉트 3 → Option 3
  recordings.push(await recordTC(page, db, BASE, tc("셀렉트-3-opt3"), async p => {
    await clickSelect(p, '[data-testid="select-3"]');
    await p.waitForFunction(() =>
      [...document.querySelectorAll(".el-select-dropdown__item")]
        .some(el => el.getBoundingClientRect().height > 0), { timeout: 3000 });
    await clickSelectOption(p, "Option 3");
    await p.evaluate(() => {
      const last = window.__events__.slice().reverse().find(e =>
        e.type === "click" && e.selector && e.selector.includes("select-dropdown__item"));
      if (last) last.elSelectSelector = '[data-testid="select-3"]';
    });
  }));
  console.log(`  ✓ [${recordings.at(-1).id}] TC-04 셀렉트-3-opt3  (ev:${recordings.at(-1).eventCount} resp:${recordings.at(-1).responseCount})`);

  // TC-05: 인풋 1 → "Hello"
  // El Plus 2.x forwards data-testid to the inner <input> element itself.
  recordings.push(await recordTC(page, db, BASE, tc("인풋-1-Hello"), async p => {
    const el = await p.$('[data-testid="input-1"]'); // IS the input element
    if (!el) throw new Error("input-1 not found");
    await el.click({ clickCount: 3 });
    await p.keyboard.type("Hello");
    await p.keyboard.press("Enter");
    await p.evaluate(sel => {
      const clickEv = window.__events__.find(e => e.type === "click");
      const enterEv = window.__events__.find(e => e.type === "keydown" && e.key === "Enter");
      window.__events__ = [
        ...(clickEv ? [clickEv] : []),
        { type: "input", selector: sel, value: "Hello", t: 500 },
        ...(enterEv ? [enterEv] : []),
      ];
    }, '[data-testid="input-1"]');
  }));
  console.log(`  ✓ [${recordings.at(-1).id}] TC-05 인풋-1-Hello  (ev:${recordings.at(-1).eventCount} resp:${recordings.at(-1).responseCount})`);

  // TC-06: 인풋 2 → "World"
  recordings.push(await recordTC(page, db, BASE, tc("인풋-2-World"), async p => {
    const el = await p.$('[data-testid="input-2"]'); // IS the input element
    if (!el) throw new Error("input-2 not found");
    await el.click({ clickCount: 3 });
    await p.keyboard.type("World");
    await p.keyboard.press("Enter");
    await p.evaluate(sel => {
      const clickEv = window.__events__.find(e => e.type === "click");
      const enterEv = window.__events__.find(e => e.type === "keydown" && e.key === "Enter");
      window.__events__ = [
        ...(clickEv ? [clickEv] : []),
        { type: "input", selector: sel, value: "World", t: 500 },
        ...(enterEv ? [enterEv] : []),
      ];
    }, '[data-testid="input-2"]');
  }));
  console.log(`  ✓ [${recordings.at(-1).id}] TC-06 인풋-2-World  (ev:${recordings.at(-1).eventCount} resp:${recordings.at(-1).responseCount})`);

  // TC-07: 체크박스 1
  recordings.push(await recordTC(page, db, BASE, tc("체크박스-1"), async p => {
    await p.$eval('[data-testid="check-1"]', el => el.click());
    await p.evaluate(() => {
      let cleaned = [], seen = false;
      for (const ev of window.__events__) {
        if (ev.type === "click") { if (!seen) { cleaned.push(ev); seen = true; } }
        else cleaned.push(ev);
      }
      window.__events__ = cleaned;
    });
  }));
  console.log(`  ✓ [${recordings.at(-1).id}] TC-07 체크박스-1  (ev:${recordings.at(-1).eventCount} resp:${recordings.at(-1).responseCount})`);

  // TC-08: 체크박스 5
  recordings.push(await recordTC(page, db, BASE, tc("체크박스-5"), async p => {
    await p.$eval('[data-testid="check-5"]', el => el.click());
    await p.evaluate(() => {
      let cleaned = [], seen = false;
      for (const ev of window.__events__) {
        if (ev.type === "click") { if (!seen) { cleaned.push(ev); seen = true; } }
        else cleaned.push(ev);
      }
      window.__events__ = cleaned;
    });
  }));
  console.log(`  ✓ [${recordings.at(-1).id}] TC-08 체크박스-5  (ev:${recordings.at(-1).eventCount} resp:${recordings.at(-1).responseCount})`);

  // TC-09: 스위치 1
  recordings.push(await recordTC(page, db, BASE, tc("스위치-1"), async p => {
    await p.$eval('[data-testid="switch-1"]', el => el.click());
  }));
  console.log(`  ✓ [${recordings.at(-1).id}] TC-09 스위치-1  (ev:${recordings.at(-1).eventCount} resp:${recordings.at(-1).responseCount})`);

  // TC-10: 스위치 3
  recordings.push(await recordTC(page, db, BASE, tc("스위치-3"), async p => {
    await p.$eval('[data-testid="switch-3"]', el => el.click());
  }));
  console.log(`  ✓ [${recordings.at(-1).id}] TC-10 스위치-3  (ev:${recordings.at(-1).eventCount} resp:${recordings.at(-1).responseCount})`);

  await browser.close();
  await new Promise(r => server.close(r));

  const total = db.prepare("SELECT COUNT(*) as c FROM recordings").get().c;
  console.log(`\n✓ 녹화 완료: ${total}개 TC 저장됨\n`);

  // ─── 리플레이 서버 재기동 ──────────────────────────────────────────────────────
  resetApiHitCount();
  const server2 = http.createServer(makeApp());
  await new Promise(r => server2.listen(PORT, "127.0.0.1", r));
  console.log(`✓ 리플레이 서버: ${BASE}\n`);

  function runTests(label, extraArgs = []) {
    return new Promise(resolve => {
      console.log(`${line}`);
      console.log(`  ${label}`);
      console.log(line);
      console.log();
      resetApiHitCount();

      const before = getApiHitCount(); // always 0 after reset
      const child = spawn(
        process.execPath,
        ["run-tests.js", "--all", "--fast", "--base-url", BASE, "--verbose", ...extraArgs],
        { cwd: __dirname, stdio: "inherit" }
      );
      child.on("exit", code => {
        const hits = getApiHitCount();
        console.log();
        console.log(`  실서버 API 히트: ${hits}건`);
        if (extraArgs.includes("--no-mock-replay")) {
          const sym = hits > 0 ? "✓" : "⚠";
          console.log(`  ${sym} 실서버 모드: ${hits}건 도달 (예상: >0)`);
        } else {
          const sym = hits === 0 ? "✅" : "❌";
          const verdict = hits === 0 ? "PASS — API 요청 0건 (백엔드 불필요)" : `FAIL — ${hits}건 누출!`;
          console.log(`  ${sym} 목 모드: ${verdict}`);
        }
        console.log();
        resolve({ code, hits });
      });
    });
  }

  // ─── A. 목(Mock) 리플레이 ─────────────────────────────────────────────────────
  const mockResult = await runTests("목(Mock) 리플레이 모드 — 기본값 (mockReplay=true)");

  // ─── B. 실서버 리플레이 (비교용) ──────────────────────────────────────────────
  const realResult = await runTests(
    "실서버 리플레이 모드 — --no-mock-replay",
    ["--no-mock-replay"]
  );

  await new Promise(r => server2.close(r)).catch(() => {});

  // ─── 최종 요약 ────────────────────────────────────────────────────────────────
  console.log(line);
  console.log("  최종 결과 요약");
  console.log(line);
  console.log(`  목 모드   실서버 API 히트: ${mockResult.hits}건  → ${mockResult.hits === 0 ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`  실서버 모드 실서버 API 히트: ${realResult.hits}건  → ${realResult.hits > 0 ? "✓ 정상" : "⚠ 예상과 다름"}`);
  console.log(line);
  console.log();

  process.exit(mockResult.code === 0 && mockResult.hits === 0 ? 0 : 1);
}

main().catch(err => {
  console.error("Fatal:", err.message, "\n", err.stack);
  process.exit(1);
});
