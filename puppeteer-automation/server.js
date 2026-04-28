"use strict";
require("dotenv").config();
const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const puppeteer = require("puppeteer-core");
const path = require("path");

const {
  dbAllMeta, dbGetMeta,
  dbLoadEvents, dbLoadResponses, dbLoadCookies, dbLoadToasts,
  dbSaveRecording, dbUpdateMeta, dbUpdateName, dbDeleteRecording,
  dbDeleteHistoryByRecording,
  dbGetHistory, dbAllHistory, dbSaveHistory,
} = require("./src/server/db");
const { buildCaptureScript } = require("./src/server/inject");
const { mountRoutes } = require("./src/server/api");
const { isApiResponse } = require("./src/shared/api-filter");
const { isTrackerUrl } = require("./src/shared/blocklist");
const { pickByLabelOrFirst } = require("./src/shared/dispatch");
const {
  buildStatusOnlyResults,
  compareResponses,
  compareToasts,
  compareTriggerMappings,
  buildResponseMap,
  jsonDiff,
  isNetworkTrigger,
} = require("./src/shared/compare");
const { normalizeUrl, canonicalUrl } = require("./src/shared/url");

const CHROME_PATH =
  process.env.CHROME_PATH ||
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const PORT = process.env.PORT || 3000;
const VIEWPORT = { width: 1920, height: 1080 };

// ─── HTTP + WebSocket server setup ───────────────────────────────────────────

const app = express();
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

mountRoutes(app);


// ─── Puppeteer session state ──────────────────────────────────────────────────

let browser = null; // Puppeteer Browser
let activePage = null; // current page
let cdpSession = null; // CDP session for screencasting
let activeWs = null; // connected frontend WebSocket

let isRecording = false;
let capturedEvents = [];
let capturedResponses = [];
let capturedToasts = []; // toast messages captured during recording
let pendingRespPromises = new Set();
let recordingStartTime = null;
let recordingStartUrl = "";
let currentUrl = "about:blank";
let firstNavigateDone = false;
let sessionCookies = [];
let replayCookies = [];
let replayToasts = []; // toast messages captured during replay
let replayToastActive = false; // true only while runReplay is running
let replayCancelled = false; // set to true by 'cancel-replay' message

// ─── Browser session lifecycle ────────────────────────────────────────────────
async function launchSession() {
  console.log("[Browser] Launching Puppeteer …");
  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
    defaultViewport: VIEWPORT,
  });

  [activePage] = await browser.pages();

  // Expose capture bridge: page JS → Node.js handler
  await activePage.exposeFunction("__captureEvent", (type, data) => {
    if (!isRecording) return;
    const now = Date.now();
    if (recordingStartTime === null) recordingStartTime = now;
    if (type === "toast") {
      capturedToasts.push({ text: data.text });
      return;
    }
    const ev = { type, ...data, t: now - recordingStartTime };
    capturedEvents.push(ev);
    send({ type: "recording-event", count: capturedEvents.length });
  });

  // Expose toast bridge for replay (separate from recording bridge)
  await activePage.exposeFunction("__captureToast", (text) => {
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
  activePage.on("framenavigated", (frame) => {
    if (frame !== activePage.mainFrame()) return;
    const url = frame.url();
    if (url === currentUrl || url === "about:blank") return;

    if (isRecording && firstNavigateDone) {
      const ev = { type: "navigate", url, t: Date.now() - recordingStartTime };
      capturedEvents.push(ev);
      send({ type: "recording-event", count: capturedEvents.length });
    }
    firstNavigateDone = true;
    currentUrl = url;
    send({ type: "url-changed", url });
  });

  // Capture HTTP responses (with body) during recording
  activePage.on("response", (response) => {
    if (!isRecording) return;
    const url = response.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (!isApiResponse(response)) return;
    if (isTrackerUrl(url)) return;

    const ct = (response.headers()["content-type"] || "").toLowerCase();
    const wantBody = /json|text\/plain|xml/.test(ct);
    const status = response.status();
    const t = Date.now() - (recordingStartTime ?? Date.now());

    if (!wantBody) {
      capturedResponses.push({ url, status, contentType: ct, body: null, t });
      return;
    }

    // Async body read — track promise so stop-recording can await it
    const p = response
      .buffer()
      .then((buf) => {
        const body = buf.length <= 51200 ? buf.toString("utf8") : null;
        capturedResponses.push({ url, status, contentType: ct, body, t });
      })
      .catch(() => {
        capturedResponses.push({ url, status, contentType: ct, body: null, t });
      })
      .finally(() => pendingRespPromises.delete(p));

    pendingRespPromises.add(p);
  });

  // Handle page crashes / unexpected closes
  browser.on("disconnected", () => {
    console.log("[Browser] Disconnected");
    browser = null;
    activePage = null;
    cdpSession = null;
  });

  // Start CDP screencasting
  await startScreencast();

  console.log("[Browser] Ready");
}

async function startScreencast() {
  cdpSession = await activePage.createCDPSession();
  await cdpSession.send("Page.startScreencast", {
    format: "jpeg",
    quality: 75,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
    everyNthFrame: 1,
  });

  cdpSession.on("Page.screencastFrame", async ({ data, sessionId }) => {
    // Forward JPEG frame to the connected frontend
    if (activeWs?.readyState === WebSocket.OPEN) {
      activeWs.send(JSON.stringify({ type: "frame", data }));
    }
    // Must ack to receive next frame
    await cdpSession
      .send("Page.screencastFrameAck", { sessionId })
      .catch(() => {});
  });
}

// ─── WebSocket connection handler ─────────────────────────────────────────────

wss.on("connection", async (ws) => {
  console.log("[WS] Client connected");
  activeWs = ws;

  try {
    if (!browser) await launchSession();
    ws.send(JSON.stringify({ type: "ready", viewport: VIEWPORT }));
    ws.send(JSON.stringify({ type: "url-changed", url: currentUrl }));
    ws.send(JSON.stringify({ type: "recordings", list: dbAllMeta() }));
    ws.send(JSON.stringify({ type: "history-all", map: dbAllHistory() }));
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", message: err.message }));
    console.error("[WS] Session launch error:", err.message);
  }

  ws.on("message", async (raw) => {
    try {
      await handleClientMessage(JSON.parse(raw.toString()), ws);
    } catch (err) {
      console.error("[WS] Handler error:", err.message);
    }
  });

  ws.on("close", () => {
    if (activeWs === ws) activeWs = null;
    console.log("[WS] Client disconnected");
  });
});

function send(msg) {
  if (activeWs?.readyState === WebSocket.OPEN)
    activeWs.send(JSON.stringify(msg));
}

// level: 'info' | 'success' | 'fail' | 'warn'
function log(level, message) {
  const ts = new Date().toLocaleTimeString("ko-KR", { hour12: false });
  send({ type: "log", level, message, ts });
  console.log(`[${ts}] [${level.toUpperCase()}] ${message}`);
}

// ─── Client message dispatcher ────────────────────────────────────────────────

async function handleClientMessage(msg, ws) {
  if (!activePage) {
    ws.send(
      JSON.stringify({ type: "error", message: "브라우저 세션이 없습니다." }),
    );
    return;
  }

  switch (msg.type) {
    // ── Navigation ───────────────────────────────────────────────────────────
    case "navigate": {
      firstNavigateDone = false;
      if (sessionCookies.length > 0)
        await activePage.setCookie(...sessionCookies);
      await activePage.goto(msg.url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      break;
    }

    // ── Cookie management ────────────────────────────────────────────────────
    case "set-cookies": {
      sessionCookies = (msg.cookies ?? []).filter((c) => c.name && c.value);
      if (sessionCookies.length > 0) {
        await activePage.setCookie(...sessionCookies);
        console.log(`[Cookies] Set ${sessionCookies.length} cookie(s)`);
      }
      ws.send(
        JSON.stringify({
          type: "cookies-applied",
          count: sessionCookies.length,
        }),
      );
      break;
    }

    // ── Mouse events ─────────────────────────────────────────────────────────
    case "mousemove":
      await activePage.mouse.move(msg.x, msg.y);
      break;
    case "mousedown":
      await activePage.mouse.move(msg.x, msg.y);
      await activePage.mouse.down({ button: msg.button ?? "left" });
      break;
    case "mouseup":
      await activePage.mouse.move(msg.x, msg.y);
      await activePage.mouse.up({ button: msg.button ?? "left" });
      break;
    case "click":
      await activePage.mouse.click(msg.x, msg.y, {
        button: msg.button ?? "left",
      });
      break;
    case "dblclick":
      await activePage.mouse.click(msg.x, msg.y, { clickCount: 2 });
      break;
    case "wheel":
      await activePage.mouse.wheel({
        deltaX: msg.deltaX ?? 0,
        deltaY: msg.deltaY ?? 0,
      });
      break;

    // ── Keyboard events ───────────────────────────────────────────────────────
    case "keydown":
      await activePage.keyboard.down(msg.key === " " ? "Space" : msg.key);
      break;
    case "keyup":
      await activePage.keyboard.up(msg.key === " " ? "Space" : msg.key);
      break;

    // ── Recording ─────────────────────────────────────────────────────────────
    case "start-recording":
      isRecording = true;
      capturedEvents = [];
      capturedResponses = [];
      capturedToasts = [];
      pendingRespPromises = new Set();
      recordingStartTime = null;
      recordingStartUrl = currentUrl;
      firstNavigateDone = true;
      ws.send(JSON.stringify({ type: "recording-started" }));
      console.log(`[Recording] Started @ ${recordingStartUrl}`);
      break;

    case "stop-recording": {
      isRecording = false;
      // Wait for any in-flight body reads (up to 2 s)
      if (pendingRespPromises.size > 0)
        await Promise.race([
          Promise.allSettled([...pendingRespPromises]),
          sleep(2000),
        ]);
      console.log(
        `[Recording] Stopped — ${capturedEvents.length} events, ${capturedResponses.length} responses`,
      );
      if (capturedEvents.length === 0) {
        ws.send(JSON.stringify({ type: "recording-empty" }));
        break;
      }
      // Map HTTP responses to the events that triggered them
      const eventsWithMapping = mapResponsesToEvents(
        [...capturedEvents],
        [...capturedResponses],
      );
      const triggeredCount = eventsWithMapping.filter(
        (e) => e.triggeredUrls?.length,
      ).length;
      if (triggeredCount > 0)
        console.log(
          `[Recording] Event→HTTP mapping: ${triggeredCount} events mapped`,
        );

      const createdAt = new Date().toISOString();
      const newId = dbSaveRecording(
        `테스트 케이스 #?`,
        recordingStartUrl || currentUrl,
        capturedEvents.length,
        createdAt,
        eventsWithMapping,
        [...capturedResponses],
        [...sessionCookies],
        [...capturedToasts],
      );
      // Update name to reflect actual auto-increment id
      dbUpdateName(newId, `테스트 케이스 #${newId}`);
      const meta = dbGetMeta(newId);
      ws.send(JSON.stringify({ type: "recording-saved", recording: meta }));
      ws.send(JSON.stringify({ type: "recordings", list: dbAllMeta() }));
      console.log(`[Recording] Saved as id=${newId}`);
      break;
    }

    // ── Cancel replay / suite ────────────────────────────────────────────────
    case "cancel-replay":
      replayCancelled = true;
      log("warn", "재생 취소 요청됨");
      break;

    // ── Replay ────────────────────────────────────────────────────────────────
    case "replay": {
      const meta = dbGetMeta(msg.id);
      if (!meta) break;
      const events = dbLoadEvents(msg.id);
      if (!events) break;
      const responses = dbLoadResponses(msg.id);
      const cookies = dbLoadCookies(msg.id);
      const toasts = dbLoadToasts(msg.id);
      await runReplay(
        msg.id,
        events,
        responses,
        meta.url,
        ws,
        false,
        cookies,
        toasts,
        msg.compareHttp !== false,
        !!msg.mockReplay,
      );
      break;
    }

    // ── Suite (batch replay) ──────────────────────────────────────────────────
    case "run-suite": {
      const ids = Array.isArray(msg.ids)
        ? msg.ids.filter((x) => typeof x === "number")
        : [];
      if (ids.length === 0) break;

      ws.send(JSON.stringify({ type: "suite-started", total: ids.length }));
      log("info", `━━ 스위트 실행 시작: ${ids.length}개 테스트 ━━`);

      let suitePass = 0,
        suiteFail = 0;

      replayCancelled = false;
      for (let i = 0; i < ids.length; i++) {
        if (replayCancelled) {
          log("warn", `스위트 취소됨 (${i}/${ids.length} 완료)`);
          break;
        }
        const id = ids[i];
        const meta = dbGetMeta(id);
        if (!meta) {
          suiteFail++;
          continue;
        }
        const events = dbLoadEvents(id);
        if (!events) {
          suiteFail++;
          continue;
        }
        const responses = dbLoadResponses(id);
        const cookies = dbLoadCookies(id);
        const toasts = dbLoadToasts(id);

        ws.send(
          JSON.stringify({
            type: "suite-item-started",
            index: i,
            total: ids.length,
            name: meta.name,
          }),
        );
        log("info", `━━ [${i + 1}/${ids.length}] ${meta.name} ━━`);

        const result = await runReplay(
          id,
          events,
          responses,
          meta.url,
          ws,
          true,
          cookies,
          toasts,
          msg.compareHttp !== false,
          !!msg.mockReplay,
        );

        if (result.failed === 0) suitePass++;
        else suiteFail++;

        ws.send(
          JSON.stringify({
            type: "suite-item-done",
            index: i,
            total: ids.length,
            name: meta.name,
            passed: result.passed,
            failed: result.failed,
            recTotal: result.total,
          }),
        );
      }

      log(
        suiteFail === 0 ? "success" : "fail",
        `━━ 스위트 완료: 성공 ${suitePass} / 실패 ${suiteFail} (총 ${ids.length}개) ━━`,
      );
      ws.send(
        JSON.stringify({
          type: "suite-done",
          total: ids.length,
          passed: suitePass,
          failed: suiteFail,
        }),
      );
      break;
    }

    // ── Update metadata (name / description / tags) ───────────────────────────
    case "update-recording": {
      const { id, name, description, tags } = msg;
      if (!dbGetMeta(id)) break;
      dbUpdateMeta(
        id,
        (name || "").trim(),
        (description || "").trim(),
        Array.isArray(tags) ? tags : [],
      );
      ws.send(JSON.stringify({ type: "recordings", list: dbAllMeta() }));
      break;
    }

    // ── Delete ────────────────────────────────────────────────────────────────
    case "delete-recording": {
      dbDeleteHistoryByRecording(msg.id);
      dbDeleteRecording(msg.id);
      ws.send(JSON.stringify({ type: "recordings", list: dbAllMeta() }));
      break;
    }
  }
}

// ─── Replay engine ────────────────────────────────────────────────────────────


// Wait until network goes idle (≤2 concurrent requests for idleTime ms).
// Silently absorbs timeout — some pages keep persistent connections.
// Fast-mode default: 200ms idle is enough for typical localhost/API responses.
async function waitNetworkIdle(timeout = 60000) {
  try {
    await activePage.waitForNetworkIdle({ idleTime: 200, timeout });
  } catch {}
}

// Events that typically trigger network requests and warrant idle-waiting
const NETWORK_EVENTS = new Set(["navigate", "click", "dblclick"]);


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
    const idx = triggerIdxs[k];
    const tStart = events[idx].t ?? 0;
    const tEnd =
      k + 1 < triggerIdxs.length
        ? (events[triggerIdxs[k + 1]].t ?? Infinity)
        : Infinity;
    const urls = responses
      .filter((r) => r.t != null && r.t >= tStart && r.t < tEnd)
      .map((r) => r.url);
    if (urls.length > 0) events[idx].triggeredUrls = urls;
  }
  return events;
}
async function runReplay(
  recordingId,
  events,
  recordedResponses,
  startUrl,
  ws,
  isSuite = false,
  recordingCookies = [],
  recordingToasts = [],
  compareHttp = true,
  mockReplay = false,
) {
  const startMs = Date.now();
  if (!isSuite) ws.send(JSON.stringify({ type: "replay-started" }));
  log(
    "info",
    `재생 시작 → ${startUrl}  (이벤트 ${events.length}개, fast)`,
  );

  const replayResponses = [];
  const replayResponseUrls = []; // synchronous URL capture for trigger mapping
  const replayRespPending = new Set();
  const recMap = buildResponseMap(recordedResponses);
  const replayTriggerMap = new Map(); // eventIdx → [url, ...]
  const jsErrors = [];

  replayToasts = [];
  replayToastActive = true;
  replayCancelled = false;

  const onPageError = (err) => {
    jsErrors.push(err.message);
    log("fail", `[JS Error] ${err.message}`);
  };
  activePage.on("pageerror", onPageError);

  const onResponse = (response) => {
    const url = response.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (!isApiResponse(response)) return;
    if (isTrackerUrl(url)) return;
    replayResponseUrls.push(url); // synchronous — used for trigger mapping
    const ct = (response.headers()["content-type"] || "").toLowerCase();
    const status = response.status();
    const wantBody = /json|text\/plain|xml/.test(ct);

    if (!wantBody) {
      replayResponses.push({ url, status, contentType: ct, body: null });
      return;
    }

    const p = response
      .buffer()
      .then((buf) => {
        const body = buf.length <= 51200 ? buf.toString("utf8") : null;
        replayResponses.push({ url, status, contentType: ct, body });
      })
      .catch(() =>
        replayResponses.push({ url, status, contentType: ct, body: null }),
      )
      .finally(() => replayRespPending.delete(p));

    replayRespPending.add(p);
  };
  activePage.on("response", onResponse);

  try {
    firstNavigateDone = false;

    // ── Session isolation ──────────────────────────────────────────────────
    // 1. Clear all browser cookies so previous test's session doesn't leak.
    await cdpSession.send("Network.clearBrowserCookies").catch(() => {});

    // 2. Install a one-shot script that clears Web Storage (localStorage /
    //    sessionStorage) before any page JS runs on the next navigation.
    let clearStorageId = null;
    await cdpSession
      .send("Page.addScriptToEvaluateOnNewDocument", {
        source: "try{localStorage.clear();sessionStorage.clear();}catch{}",
      })
      .then(({ identifier }) => { clearStorageId = identifier; })
      .catch(() => {});

    // 3. Apply recording cookies (now the only cookies in the browser).
    replayCookies =
      recordingCookies.length > 0 ? recordingCookies : sessionCookies;
    if (replayCookies.length > 0) {
      await activePage.setCookie(...replayCookies);
      log(
        "info",
        `쿠키 ${replayCookies.length}개 적용${recordingCookies.length > 0 ? " (테스트 케이스 저장 쿠키)" : ""}`,
      );
    }

    // 4. Set up mock routes before navigation so the initial page load can
    //    also serve mocked responses if needed.
    if (mockReplay) {
      const mockMap = new Map();
      const mockCursors = new Map();
      for (const r of recordedResponses) {
        const key = canonicalUrl(r.url);
        if (!mockMap.has(key)) mockMap.set(key, []);
        mockMap.get(key).push(r);
      }
      await activePage.route("**/*", async (route) => {
        const req = route.request();
        if (req.resourceType() !== "xhr" && req.resourceType() !== "fetch")
          return route.continue();
        const key = canonicalUrl(req.url());
        const queue = mockMap.get(key);
        const cursor = mockCursors.get(key) ?? 0;
        const rec = queue?.[cursor];
        if (!rec || rec.body === null) return route.continue();
        mockCursors.set(key, cursor + 1);
        log("info", `[Mock] ${req.method()} ${req.url()}`);
        await route.fulfill({
          status: rec.status,
          headers: {
            "content-type": rec.contentType,
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "*",
          },
          body: rec.body,
        });
      });
    }

    // 5. Always navigate — fresh context requires a full page load.
    log("info", `페이지 로드: ${startUrl}`);
    await activePage.goto(startUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // 6. Remove the clear-storage script so subsequent navigations within
    //    this replay (e.g. ev.type === "navigate") are not affected.
    if (clearStorageId)
      await cdpSession
        .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: clearStorageId })
        .catch(() => {});
    // ──────────────────────────────────────────────────────────────────────

    const total = events.length;
    let lastTriggerIdx = -1;
    let lastTriggerSnapLen = -1;

    for (let i = 0; i < total; i++) {
      if (replayCancelled) {
        log("warn", `재생 취소됨 (${i}/${total} 완료)`);
        break;
      }
      const ev = events[i];
      // Fast mode: skip recorded inter-event think-time. Per-event waits for
      // the page (waitNetworkIdle below) still ensure responses settle before
      // the next event fires.

      // Log significant actions
      switch (ev.type) {
        case "navigate":
          log("info", `[Navigate] ${ev.url}`);
          break;
        case "click":
          log("info", `[Click] (${ev.x},${ev.y})`);
          break;
        case "dblclick":
          log("info", `[DblClick] (${ev.x},${ev.y})`);
          break;
        case "keydown":
          if (ev.key === "Enter") log("info", `[Enter] 폼 제출 또는 키 입력`);
          break;
        case "input":
          log("info", `[Input] "${String(ev.value ?? "").slice(0, 40)}"`);
          break;
      }

      const isTrigger = isNetworkTrigger(ev);
      const snapLen = isTrigger ? replayResponseUrls.length : -1;

      await dispatchReplayEvent(ev);

      if (NETWORK_EVENTS.has(ev.type)) await waitNetworkIdle();
      if (ev.type === "keydown" && (ev.key === "Enter" || ev.code === "Enter"))
        await waitNetworkIdle();
      if (ev.type === "check" || ev.type === "select")
        await waitNetworkIdle();

      if (isTrigger && snapLen >= 0) {
        replayTriggerMap.set(i, replayResponseUrls.slice(snapLen));
        lastTriggerIdx = i;
        lastTriggerSnapLen = snapLen;
      }

      if (i % 5 === 0 || i === total - 1)
        ws.send(
          JSON.stringify({ type: "replay-progress", done: i + 1, total }),
        );
    }

    // Post-loop settlement: repeat waitNetworkIdle until no new responses
    // arrive. Handles A→B→C cascade chains of any depth — each pass
    // catches the next level. Capped at 5 iterations to avoid spinning
    // on continuously-polling pages.
    for (let pass = 0; pass < 5; pass++) {
      const prevLen = replayResponseUrls.length;
      await waitNetworkIdle();
      if (replayResponseUrls.length === prevLen) break;
    }
    // Update the last trigger's map with ALL responses captured since it
    // fired — covers chained responses caught in the settlement passes.
    if (lastTriggerIdx >= 0)
      replayTriggerMap.set(lastTriggerIdx, replayResponseUrls.slice(lastTriggerSnapLen));
  } catch (err) {
    log("fail", `재생 오류: ${err.message}`);
  } finally {
    replayToastActive = false;
    activePage.off("pageerror", onPageError);
    activePage.off("response", onResponse);
    if (mockReplay) await activePage.unrouteAll().catch(() => {});
    // Wait for in-flight body reads
    if (replayRespPending.size > 0)
      await Promise.race([
        Promise.allSettled([...replayRespPending]),
        sleep(2000),
      ]);
  }

  // Compare recorded vs actual responses
  const results = mockReplay
    ? []
    : compareHttp
      ? (recordedResponses.length > 0 ? compareResponses(recordedResponses, replayResponses) : [])
      : buildStatusOnlyResults(replayResponses);

  const toastResults = compareToasts(recordingToasts, replayToasts);
  const triggerResults = compareTriggerMappings(events, replayTriggerMap);
  const passed = results.filter((r) => r.pass).length;
  const httpFailed = results.filter((r) => !r.pass).length;
  const toastFailed = toastResults.filter((r) => !r.pass).length;
  const triggerFailed = triggerResults.filter((r) => !r.pass).length;
  const scriptFailed = jsErrors.length;
  const failed = httpFailed + toastFailed + triggerFailed + scriptFailed;

  if (results.length > 0) {
    if (httpFailed === 0)
      log(
        "success",
        `━━ HTTP 응답: SUCCESS — ${passed}/${results.length} 일치 ━━`,
      );
    else if (passed === 0)
      log(
        "fail",
        `━━ HTTP 응답: FAIL — ${httpFailed}/${results.length} 불일치 ━━`,
      );
    else
      log(
        "warn",
        `━━ HTTP 응답: PARTIAL — 성공 ${passed} / 실패 ${httpFailed} ━━`,
      );

    for (const r of results) {
      if (r.pass) {
        const note = r.urlParamsMismatch ? " (URL 파라미터 변경됨)" : "";
        log("success", `  ✓ [${r.actualStatus}] ${r.url}${note}`);
      } else {
        log("fail", `  ✗ [${r.actualStatus}] ${r.url}`);
        if (r.urlParamsMismatch)
          log("warn", `    URL 파라미터 변경됨 (경로만 일치)`);
        if (!r.statusPass)
          log("fail", `    상태코드: ${r.expectedStatus} → ${r.actualStatus}`);
        for (const d of r.bodyDiffs.slice(0, 3))
          log("fail", `    바디 diff: ${d}`);
      }
    }
  } else {
    log("info", "━━ 재생 완료 (HTTP 응답 비교 없음) ━━");
  }

  if (toastResults.length > 0) {
    if (toastFailed === 0)
      log("success", `━━ 토스트: SUCCESS — ${toastResults.length}건 일치 ━━`);
    else
      log(
        "fail",
        `━━ 토스트: FAIL — ${toastFailed}/${toastResults.length}건 불일치 ━━`,
      );
    for (const r of toastResults) {
      if (r.pass) log("success", `  ✓ [Toast] ${r.text}`);
      else log("fail", `  ✗ [Toast] "${r.text}" — 재생 시 미감지`);
    }
  }

  if (triggerResults.length > 0) {
    if (triggerFailed === 0)
      log(
        "success",
        `━━ 이벤트-HTTP 매핑: SUCCESS — ${triggerResults.length}건 일치 ━━`,
      );
    else
      log(
        "fail",
        `━━ 이벤트-HTTP 매핑: FAIL — ${triggerFailed}/${triggerResults.length}건 불일치 ━━`,
      );
    for (const r of triggerResults) {
      if (r.pass)
        log("success", `  ✓ [${r.eventType}:${r.eventLabel}] → ${r.url}`);
      else
        log(
          "fail",
          `  ✗ [${r.eventType}:${r.eventLabel}] → ${r.url} — 재생 시 미감지`,
        );
    }
  }

  if (jsErrors.length > 0) {
    log("fail", `━━ 스크립트 에러 ${jsErrors.length}건 감지 ━━`);
    for (const e of jsErrors) log("fail", `  ✗ [JS Error] ${e}`);
  }

  const total = results.length + toastResults.length + triggerResults.length;
  const durationMs = Date.now() - startMs;
  dbSaveHistory(recordingId, passed, failed, total, results, durationMs);
  ws.send(
    JSON.stringify({
      type: "history",
      recordingId,
      runs: dbGetHistory(recordingId),
    }),
  );

  if (!isSuite) ws.send(JSON.stringify({ type: "replay-done" }));
  ws.send(
    JSON.stringify({
      type: "replay-result",
      results,
      toastResults,
      triggerResults,
      passed,
      failed,
      total,
      jsErrors,
    }),
  );
  return { passed, failed, total };
}

const BTN = (b) =>
  b === "right" ? "right" : b === "middle" ? "middle" : "left";

async function dispatchReplayEvent(ev) {
  try {
    switch (ev.type) {
      case "navigate":
        if (replayCookies.length > 0)
          await activePage.setCookie(...replayCookies);
        await activePage.goto(ev.url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        break;
      case "click":
        if (ev.selector) {
          try {
            const el = await pickByLabelOrFirst(activePage, ev.selector, ev.label);
            if (el) {
              await el.click();
              break;
            }
            log(
              "warn",
              `  [Click] 선택자 미발견, 좌표 폴백: ${ev.selector} → (${ev.x},${ev.y})`,
            );
          } catch (selErr) {
            log(
              "warn",
              `  [Click] 선택자 오류, 좌표 폴백: ${ev.selector} — ${selErr.message}`,
            );
          }
        }
        await activePage.mouse.click(ev.x, ev.y, { button: BTN(ev.button) });
        break;
      case "dblclick":
        if (ev.selector) {
          try {
            const el = await pickByLabelOrFirst(activePage, ev.selector, ev.label);
            if (el) {
              await el.click({ clickCount: 2 });
              break;
            }
            log(
              "warn",
              `  [DblClick] 선택자 미발견, 좌표 폴백: ${ev.selector} → (${ev.x},${ev.y})`,
            );
          } catch (selErr) {
            log(
              "warn",
              `  [DblClick] 선택자 오류, 좌표 폴백: ${ev.selector} — ${selErr.message}`,
            );
          }
        }
        await activePage.mouse.click(ev.x, ev.y, { clickCount: 2 });
        break;
      case "hover":
        if (ev.selector) {
          try {
            const el = await pickByLabelOrFirst(activePage, ev.selector, ev.label);
            if (el) { await el.hover(); break; }
          } catch {}
        }
        if (typeof ev.x === "number" && typeof ev.y === "number")
          await activePage.mouse.move(ev.x, ev.y);
        break;
      case "wheel":
        await activePage.mouse.wheel({ deltaX: ev.deltaX, deltaY: ev.deltaY });
        break;
      case "scroll":
        await activePage.evaluate(
          (x, y) => window.scrollTo(x, y),
          ev.scrollX,
          ev.scrollY,
        );
        break;
      case "keydown":
        await activePage.keyboard.down(ev.key === " " ? "Space" : ev.key);
        break;
      case "keyup":
        await activePage.keyboard.up(ev.key === " " ? "Space" : ev.key);
        break;
      case "input":
        if (ev.selector) {
          try {
            const el = await pickByLabelOrFirst(activePage, ev.selector, ev.label);
            if (el) {
              await el.click({ clickCount: 3 });
              await el.type(ev.value ?? "");
              break;
            }
          } catch {}
        }
        await activePage.keyboard.down("Control");
        await activePage.keyboard.press("a");
        await activePage.keyboard.up("Control");
        await activePage.keyboard.type(ev.value ?? "");
        break;
      case "select":
        if (ev.selector) {
          try {
            const el = await pickByLabelOrFirst(activePage, ev.selector, ev.label);
            if (el) {
              await el.evaluate((node, v) => {
                node.value = v;
                node.dispatchEvent(new Event("change", { bubbles: true }));
              }, ev.value);
              break;
            }
          } catch {}
        }
        await activePage.evaluate((v) => {
          const el = document.activeElement;
          if (el && el.tagName === "SELECT") {
            el.value = v;
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }, ev.value);
        break;
      case "check":
        if (ev.selector) {
          try {
            const el = await pickByLabelOrFirst(activePage, ev.selector, ev.label);
            if (el) {
              const cur = await el.evaluate((n) => n.checked);
              if (cur !== ev.checked) await el.click();
              break;
            }
          } catch {}
        }
        await activePage.mouse.click(ev.x ?? 0, ev.y ?? 0);
        break;
      case "contenteditable":
        await activePage.evaluate((h) => {
          if (document.activeElement) document.activeElement.innerHTML = h;
        }, ev.html);
        break;
    }
  } catch {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(
    `\n[Server] Browser Automation Tool → http://localhost:${PORT}\n`,
  );
});
