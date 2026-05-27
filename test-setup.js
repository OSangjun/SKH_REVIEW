#!/usr/bin/env node
"use strict";
/**
 * test-setup.js
 * 로컬 테스트 서버를 띄우고 Puppeteer로 직접 상호작용해
 * 3개의 테스트 케이스를 DB에 삽입한 뒤 run-tests.js를 실행한다.
 *
 * 테스트 케이스:
 *   #1  목록 조회    – GET /api/items 응답 비교
 *   #2  아이템 검색  – 폼 입력 → GET /api/items?q=milk 응답 비교
 *   #3  아이템 추가  – 폼 입력 + 제출 → POST /api/items 응답 비교
 */

const http    = require("http");
const express = require("express");
const puppeteer = require("puppeteer-core");
const { execSync, spawn } = require("child_process");
const path    = require("path");

const { openDb } = require("./src/shared/db");

const CHROME_PATH =
  process.env.CHROME_PATH ||
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const VIEWPORT = { width: 1280, height: 800 };

// ─── 1. 로컬 테스트 서버 ──────────────────────────────────────────────────────

const ITEMS = [
  { id: 1, name: "Buy milk",     done: false },
  { id: 2, name: "Read a book",  done: true  },
  { id: 3, name: "Go for a run", done: false },
];

let nextId = 4;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "test-public")));

  app.get("/api/items", (req, res) => {
    const q = (req.query.q || "").toLowerCase();
    const result = q ? ITEMS.filter(i => i.name.toLowerCase().includes(q)) : ITEMS;
    res.json({ items: result, total: result.length });
  });

  app.post("/api/items", (req, res) => {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    const item = { id: nextId++, name, done: false };
    ITEMS.push(item);
    res.status(201).json({ ok: true, item });
  });

  app.get("/", (_req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>Todo Demo</title>
  <style>
    body { font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; }
    h1 { font-size: 1.4rem; }
    #list { border: 1px solid #ddd; border-radius: 6px; padding: 12px; min-height: 60px; }
    .item { padding: 4px 0; }
    input { padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; }
    button { padding: 6px 14px; cursor: pointer; border: none; border-radius: 4px; background: #4f8ef7; color: #fff; margin-left: 6px; }
    #toast { display:none; position:fixed; top:20px; right:20px; background:#2ecc71;
             color:#fff; padding:10px 18px; border-radius:6px; font-size:.9rem; }
    #toast.show { display:block; }
  </style>
</head>
<body>
  <h1>Todo Demo</h1>

  <section>
    <h2>목록 조회</h2>
    <button id="btn-load">전체 불러오기</button>
    <div id="list"></div>
  </section>

  <section>
    <h2>검색</h2>
    <input id="search-input" placeholder="검색어" />
    <button id="btn-search">검색</button>
    <div id="search-result"></div>
  </section>

  <section>
    <h2>새 항목 추가</h2>
    <input id="add-input" placeholder="할 일 이름" />
    <button id="btn-add">추가</button>
  </section>

  <div id="toast" role="alert"></div>

  <script>
    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2500);
    }

    document.getElementById('btn-load').addEventListener('click', async () => {
      const r = await fetch('/api/items');
      const data = await r.json();
      const list = document.getElementById('list');
      list.innerHTML = data.items.map(i =>
        '<div class="item">' + (i.done ? '✅' : '⬜') + ' ' + i.name + '</div>'
      ).join('');
    });

    document.getElementById('btn-search').addEventListener('click', async () => {
      const q = document.getElementById('search-input').value.trim();
      const r = await fetch('/api/items?q=' + encodeURIComponent(q));
      const data = await r.json();
      document.getElementById('search-result').innerHTML =
        data.items.length
          ? data.items.map(i => '<div class="item">' + i.name + '</div>').join('')
          : '<div class="item">결과 없음</div>';
    });

    document.getElementById('btn-add').addEventListener('click', async () => {
      const name = document.getElementById('add-input').value.trim();
      if (!name) return;
      const r = await fetch('/api/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const data = await r.json();
      if (data.ok) showToast('추가 완료: ' + data.item.name);
    });
  </script>
</body>
</html>`);
  });

  return app;
}

// ─── 2. Puppeteer 녹화 헬퍼 ──────────────────────────────────────────────────

function isApiResponse(response) {
  const t = response.request().resourceType();
  return t === "xhr" || t === "fetch";
}

async function capture(page, actions, baseT) {
  const responses  = [];
  const respUrls   = [];
  const pending    = new Set();

  const onResp = (response) => {
    const url = response.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (!isApiResponse(response)) return;
    const t   = Date.now() - baseT;
    const ct  = (response.headers()["content-type"] || "").toLowerCase();
    const st  = response.status();
    const wantBody = /json/.test(ct);
    if (!wantBody) { responses.push({ url, status: st, contentType: ct, body: null, t }); return; }
    const p = response.buffer().then(buf => {
      responses.push({ url, status: st, contentType: ct,
                       body: buf.toString("utf8"), t });
    }).catch(() => responses.push({ url, status: st, contentType: ct, body: null, t }))
      .finally(() => pending.delete(p));
    pending.add(p);
  };
  page.on("response", onResp);

  await actions();

  await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => {});
  if (pending.size > 0)
    await Promise.race([Promise.allSettled([...pending]), new Promise(r => setTimeout(r, 2000))]);

  page.off("response", onResp);
  return responses;
}

// ─── 3. 녹화 데이터 → DB 저장 ────────────────────────────────────────────────

function saveRecording(db, name, url, events, responses) {
  const mapResponsesToEvents = (evs, resps) => {
    const triggerIdxs = [];
    const TRIGGERS = new Set(["click", "dblclick", "navigate", "check", "select"]);
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      if (TRIGGERS.has(ev.type) || (ev.type === "keydown" && (ev.key === "Enter" || ev.code === "Enter")))
        triggerIdxs.push(i);
    }
    for (let k = 0; k < triggerIdxs.length; k++) {
      const idx    = triggerIdxs[k];
      const tStart = evs[idx].t ?? 0;
      const tEnd   = k + 1 < triggerIdxs.length ? (evs[triggerIdxs[k + 1]].t ?? Infinity) : Infinity;
      const urls   = resps.filter(r => r.t != null && r.t >= tStart && r.t < tEnd).map(r => r.url);
      if (urls.length > 0) evs[idx].triggeredUrls = urls;
    }
    return evs;
  };
  const mappedEvents = mapResponsesToEvents(events, responses);
  const stmt = db.prepare(
    `INSERT INTO recordings (name, url, event_count, created_at, events, responses, cookies, toasts)
     VALUES (?, ?, ?, ?, ?, ?, '[]', '[]')`
  );
  const info = stmt.run(
    name, url, events.length, new Date().toISOString(),
    JSON.stringify(mappedEvents), JSON.stringify(responses)
  );
  console.log(`  ✓ 저장: [${info.lastInsertRowid}] "${name}"  이벤트 ${events.length}개, 응답 ${responses.length}개`);
  return info.lastInsertRowid;
}

// ─── 4. 메인 ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n═══════════════════════════════════════════════════");
  console.log("  Browser Automation Tool — 테스트 셋업");
  console.log("═══════════════════════════════════════════════════\n");

  // 4-1. DB 기존 레코딩 초기화
  const db = openDb();
  db.exec("DELETE FROM run_history");
  db.exec("DELETE FROM recordings");
  console.log("✓ DB 초기화 완료\n");

  // 4-2. 테스트 서버 기동
  const app    = makeApp();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const PORT = server.address().port;
  const BASE = `http://127.0.0.1:${PORT}`;
  console.log(`✓ 테스트 서버 기동: ${BASE}\n`);

  // 4-3. 브라우저 기동
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: VIEWPORT,
  });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  console.log("✓ Chromium 기동\n");
  console.log("─── 녹화 시작 ──────────────────────────────────────");

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── 테스트 케이스 #1: 전체 목록 조회 ─────────────────────────────────────
  {
    console.log("\n[TC-1] 전체 목록 조회");
    await page.goto(BASE, { waitUntil: "networkidle2" });
    const baseT = Date.now();
    const events = [
      { type: "navigate", url: BASE, t: 0 },
    ];

    const responses = await capture(page, async () => {
      // 버튼 클릭 이벤트 기록
      const btn = await page.$("#btn-load");
      const box = await btn.boundingBox();
      const t = Date.now() - baseT;
      events.push({ type: "click", x: Math.round(box.x + box.width/2), y: Math.round(box.y + box.height/2),
                    button: "left", selector: "#btn-load", t });
      await btn.click();
    }, baseT);
    saveRecording(db, "TC-1: 목록 조회", BASE, events, responses);
  }

  // ── 테스트 케이스 #2: 검색 ────────────────────────────────────────────────
  {
    console.log("\n[TC-2] 아이템 검색 (milk)");
    await page.goto(BASE, { waitUntil: "networkidle2" });
    const baseT = Date.now();
    const events = [{ type: "navigate", url: BASE, t: 0 }];
    let t;

    const responses = await capture(page, async () => {
      // 검색 입력
      const inp = await page.$("#search-input");
      const iBox = await inp.boundingBox();
      t = Date.now() - baseT;
      events.push({ type: "click", x: Math.round(iBox.x + iBox.width/2), y: Math.round(iBox.y + iBox.height/2),
                    button: "left", selector: "#search-input", t });
      await inp.click({ clickCount: 3 });
      await sleep(100);

      t = Date.now() - baseT;
      events.push({ type: "input", value: "milk", selector: "#search-input", t });
      await inp.type("milk");

      // 검색 버튼 클릭
      const btn = await page.$("#btn-search");
      const bBox = await btn.boundingBox();
      t = Date.now() - baseT;
      events.push({ type: "click", x: Math.round(bBox.x + bBox.width/2), y: Math.round(bBox.y + bBox.height/2),
                    button: "left", selector: "#btn-search", t });
      await btn.click();
    }, baseT);
    saveRecording(db, "TC-2: 검색 (milk)", BASE, events, responses);
  }

  // ── 테스트 케이스 #3: 아이템 추가 ────────────────────────────────────────
  {
    console.log("\n[TC-3] 아이템 추가");
    // 매 실행마다 같은 ID가 나오도록 nextId 고정
    nextId = 10;
    ITEMS.length = 3; // 초기 상태로 되돌리기

    await page.goto(BASE, { waitUntil: "networkidle2" });
    const baseT = Date.now();
    const events = [{ type: "navigate", url: BASE, t: 0 }];
    let t;

    const responses = await capture(page, async () => {
      const inp = await page.$("#add-input");
      const iBox = await inp.boundingBox();
      t = Date.now() - baseT;
      events.push({ type: "click", x: Math.round(iBox.x + iBox.width/2), y: Math.round(iBox.y + iBox.height/2),
                    button: "left", selector: "#add-input", t });
      await inp.click({ clickCount: 3 });
      await sleep(100);

      t = Date.now() - baseT;
      events.push({ type: "input", value: "Walk the dog", selector: "#add-input", t });
      await inp.type("Walk the dog");

      const btn = await page.$("#btn-add");
      const bBox = await btn.boundingBox();
      t = Date.now() - baseT;
      events.push({ type: "click", x: Math.round(bBox.x + bBox.width/2), y: Math.round(bBox.y + bBox.height/2),
                    button: "left", selector: "#btn-add", t });
      await btn.click();
    }, baseT);
    saveRecording(db, "TC-3: 아이템 추가", BASE, events, responses);
  }

  await browser.close();
  console.log("\n─── 녹화 완료 ──────────────────────────────────────");
  console.log(`\n총 ${db.prepare("SELECT COUNT(*) as n FROM recordings").get().n}개 테스트 케이스 저장됨\n`);
  server.close();

  // 4-4. run-tests.js 실행 (같은 포트로 재기동 불가하므로 별도 재기동)
  console.log("\n═══════════════════════════════════════════════════");
  console.log("  재생 및 비교 실행");
  console.log("═══════════════════════════════════════════════════\n");

  // 서버 재기동 (같은 포트)
  const app2 = makeApp();
  nextId = 10;   // TC-3 재현을 위해 동일 nextId
  ITEMS.length = 3;

  const server2 = http.createServer(app2);
  await new Promise(r => server2.listen(PORT, "127.0.0.1", r));
  console.log(`✓ 재생용 서버 재기동: ${BASE}\n`);

  // ── 실서버 비교 모드 ──────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════");
  console.log("  실서버 응답 비교 모드 (--no-mock-replay)");
  console.log("═══════════════════════════════════════════════════\n");

  await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["run-tests.js", "--all", "--base-url", BASE, "--fast", "--no-mock-replay", "--verbose"],
      { cwd: __dirname, stdio: "inherit" }
    );
    child.on("exit", code => {
      console.log(`\nrun-tests.js (no-mock) 종료 코드: ${code}`);
      resolve(code);
    });
  });

  // ── 목(Mock) 리플레이 모드 (기본값) ──────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════");
  console.log("  목(Mock) 리플레이 모드 (기본값)");
  console.log("═══════════════════════════════════════════════════\n");

  await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["run-tests.js", "--all", "--base-url", BASE, "--fast", "--verbose"],
      { cwd: __dirname, stdio: "inherit" }
    );
    child.on("exit", code => {
      console.log(`\nrun-tests.js (mock, default) 종료 코드: ${code}`);
      resolve(code);
    });
  });

  server2.close();
  console.log("\n테스트 완료.\n");
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
