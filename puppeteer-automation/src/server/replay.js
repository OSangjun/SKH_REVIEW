"use strict";

const { isApiResponse } = require("../shared/api-filter");
const { isTrackerUrl } = require("../shared/blocklist");
const {
  buildStatusOnlyResults,
  compareResponses,
  compareToasts,
  compareTriggerMappings,
  compareDomSnapshots,
  isNetworkTrigger,
} = require("../shared/compare");
const { canonicalUrl, pathUrl } = require("../shared/url");
const { pickByLabelOrFirst } = require("../shared/dispatch");
const { dbSaveHistory, dbGetHistory, dbFindInitByUrl, dbLoadResponses } = require("./db");
const state = require("./state");
const { send, log } = require("./comms");

// Events that typically trigger network requests and warrant idle-waiting
const NETWORK_EVENTS = new Set(["navigate", "click", "dblclick"]);

// Events that don't need UI settle delay: passive gestures + keyboard input
// (keydown/keyup/input fire many times per field; Enter is handled separately
//  via waitNetworkIdle so it still gets the network settle it needs)
const NO_SETTLE_EVTS = new Set([
  "wheel", "scroll", "hover", "mousemove", "mouseup", "mousedown",
  "keydown", "keyup", "input", "contenteditable",
]);
// Milliseconds to pause after each user-action event so that Vue/React
// reactivity, CSS transitions, and component state updates can complete
// before the next action is dispatched.
const UI_SETTLE_MS = 150;

const BTN = (b) => (b === "right" ? "right" : b === "middle" ? "middle" : "left");

const SKIP_KEYS = new Set(["Process", "Unidentified", "Dead", "Compose", "OS"]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Capture visible text nodes from the page as [{path, text}].
// Skips script/style/noscript elements and hidden/invisible elements.
async function captureDomSnapshot(page) {
  return page.evaluate(() => {
    const SKIP_TAGS = new Set(["script", "style", "noscript", "head", "meta", "link"]);
    function buildPath(el) {
      const parts = [];
      let cur = el;
      while (cur && cur !== document.body && cur.tagName) {
        const tag = cur.tagName.toLowerCase();
        if (cur.id) { parts.unshift("#" + cur.id); break; }
        const sibs = cur.parentElement
          ? Array.from(cur.parentElement.children).filter((c) => c.tagName === cur.tagName)
          : [cur];
        const idx = sibs.indexOf(cur);
        parts.unshift(sibs.length > 1 ? `${tag}:${idx}` : tag);
        cur = cur.parentElement;
      }
      return parts.join(">");
    }
    const results = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = (node.textContent || "").trim().replace(/\s+/g, " ");
      if (!text) continue;
      const el = node.parentElement;
      if (!el || SKIP_TAGS.has(el.tagName.toLowerCase())) continue;
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (parseFloat(cs.opacity) < 0.05) continue;
      const br = el.getBoundingClientRect();
      results.push({ path: buildPath(el), text,
        rect: { x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.width), h: Math.round(br.height) } });
    }
    return results;
  }).catch(() => []);
}

async function waitNetworkIdle(timeout = 60000, idleTime = 500) {
  try {
    await state.activePage.waitForNetworkIdle({ idleTime, timeout });
  } catch {}
}

// Flash the target element with colour-coded glow + ripple at click coordinates.
//   type "click"    → orange ripple + orange outline
//   type "dblclick" → purple ripple + orange outline (double ring)
//   type "input"    → blue outline only (no ripple)
async function flashElement(selector, x, y, type = "click") {
  await state.activePage.evaluate((sel, px, py, tp) => {
    // ── Inject styles once ─────────────────────────────────────────────────
    if (!document.getElementById("__replay-flash-style__")) {
      const s = document.createElement("style");
      s.id = "__replay-flash-style__";
      s.textContent =
        "@keyframes __rfClick__ {" +
          "0%  {outline:3px solid rgba(249,115,22,0)   !important;outline-offset:4px !important;background-color:rgba(249,115,22,0)   !important}" +
          "20% {outline:3px solid rgba(249,115,22,1)   !important;outline-offset:4px !important;background-color:rgba(249,115,22,0.2) !important}" +
          "80% {outline:3px solid rgba(249,115,22,0.8) !important;outline-offset:4px !important;background-color:rgba(249,115,22,0.1) !important}" +
          "100%{outline:3px solid rgba(249,115,22,0)   !important;outline-offset:4px !important;background-color:rgba(249,115,22,0)   !important}" +
        "}" +
        "@keyframes __rfInput__ {" +
          "0%  {outline:3px solid rgba(59,130,246,0)   !important;outline-offset:4px !important;background-color:rgba(59,130,246,0)   !important}" +
          "20% {outline:3px solid rgba(59,130,246,1)   !important;outline-offset:4px !important;background-color:rgba(59,130,246,0.2) !important}" +
          "80% {outline:3px solid rgba(59,130,246,0.8) !important;outline-offset:4px !important;background-color:rgba(59,130,246,0.1) !important}" +
          "100%{outline:3px solid rgba(59,130,246,0)   !important;outline-offset:4px !important;background-color:rgba(59,130,246,0)   !important}" +
        "}" +
        "@keyframes __rfRipple__ {" +
          "0%  {transform:translate(-50%,-50%) scale(0);opacity:1}" +
          "100%{transform:translate(-50%,-50%) scale(1);opacity:0}" +
        "}" +
        "@keyframes __rfDot__ {" +
          "0%  {transform:translate(-50%,-50%) scale(1);opacity:1}" +
          "60% {transform:translate(-50%,-50%) scale(1.4);opacity:1}" +
          "100%{transform:translate(-50%,-50%) scale(0.8);opacity:0}" +
        "}" +
        ".__rfClick__{animation:__rfClick__ .7s ease forwards !important}" +
        ".__rfInput__{animation:__rfInput__ .7s ease forwards !important}" +
        ".__rfRipple__{" +
          "position:fixed;pointer-events:none;border-radius:50%;z-index:2147483647;" +
          "animation:__rfRipple__ .65s cubic-bezier(0,.5,.5,1) forwards !important" +
        "}" +
        ".__rfDot__{" +
          "position:fixed;pointer-events:none;border-radius:50%;z-index:2147483647;" +
          "animation:__rfDot__ .45s ease-out forwards !important" +
        "}";
      document.head.appendChild(s);
    }

    // ── Element outline glow ───────────────────────────────────────────────
    const cls   = tp === "input" ? "__rfInput__" : "__rfClick__";
    const other = tp === "input" ? "__rfClick__" : "__rfInput__";
    let el = null;
    if (sel) { try { el = document.querySelector(sel); } catch {} }
    if (!el && typeof px === "number" && typeof py === "number")
      el = document.elementFromPoint(px, py);
    if (el) {
      el.classList.remove(cls, other);
      void el.offsetWidth;
      el.classList.add(cls);
      setTimeout(() => el && el.classList.remove(cls), 750);
    }

    // ── Ripple at click coordinates (click / dblclick only) ────────────────
    if (tp === "input" || typeof px !== "number" || typeof py !== "number") return;
    const isDbl = tp === "dblclick";
    const color = isDbl ? "rgba(168,85,247," : "rgba(249,115,22,";

    // Center dot
    const dot = document.createElement("div");
    dot.className = "__rfDot__";
    dot.style.cssText =
      `left:${px}px;top:${py}px;width:18px;height:18px;` +
      `background:${color}1);box-shadow:0 0 0 4px ${color}0.4),0 0 12px 4px ${color}0.6)`;
    document.body.appendChild(dot);
    setTimeout(() => dot.parentNode && dot.parentNode.removeChild(dot), 500);

    // Expanding rings
    function makeRing(delay, size) {
      const r = document.createElement("div");
      r.className = "__rfRipple__";
      r.style.cssText =
        `left:${px}px;top:${py}px;` +
        `width:${size}px;height:${size}px;` +
        `border:4px solid ${color}1);` +
        `background:${color}0.25);` +
        `box-shadow:0 0 0 2px ${color}0.5),inset 0 0 8px ${color}0.2);` +
        `animation-delay:${delay}ms !important`;
      document.body.appendChild(r);
      setTimeout(() => r.parentNode && r.parentNode.removeChild(r), 700 + delay);
    }

    makeRing(0,   isDbl ? 120 : 90);
    makeRing(120, isDbl ? 200 : 150);
    if (isDbl) makeRing(240, 90); // third ring for dblclick
  }, selector ?? null, x ?? null, y ?? null, type).catch(() => {});
}

async function dispatchReplayEvent(ev) {
  try {
    switch (ev.type) {
      case "navigate":
        if (state.replayCookies.length > 0)
          await state.activePage.setCookie(...state.replayCookies);
        await state.activePage.goto(ev.url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        break;
      case "click":
        flashElement(ev.selector, ev.x, ev.y, "click");
        if (ev.elSelectSelector) {
          try {
            // Detect open state via visible dropdown items — more reliable than
            // is-focus/is-open classes which vary across El Plus versions.
            const isOpen = await state.activePage.evaluate(() => {
              var items = document.querySelectorAll(".el-select-dropdown__item");
              for (var i = 0; i < items.length; i++) {
                var r = items[i].getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return true;
              }
              return false;
            }).catch(() => false);
            if (!isOpen) {
              await state.activePage.evaluate((sel) => {
                var el = document.querySelector(sel);
                if (!el) return;
                var wrapper = el.querySelector(".el-select__wrapper") || el;
                wrapper.click();
              }, ev.elSelectSelector);
              // Poll until at least one dropdown item is visible — avoids the
              // fixed-delay race where 300ms was shorter than the open animation.
              await state.activePage.waitForFunction(() => {
                var items = document.querySelectorAll(".el-select-dropdown__item");
                for (var i = 0; i < items.length; i++) {
                  var r = items[i].getBoundingClientRect();
                  if (r.width > 0 && r.height > 0) return true;
                }
                return false;
              }, { timeout: 3000 }).catch(() => {});
            }
          } catch {}
        }
        if (ev.selector) {
          try {
            const el = await pickByLabelOrFirst(state.activePage, ev.selector, ev.label);
            if (el) {
              // Scroll the option into view within the dropdown list before clicking.
              // Handles the case where the target option is below the dropdown's
              // visible fold and requires scrolling to become interactable.
              if (ev.elSelectSelector)
                await el.evaluate((e) => e.scrollIntoView({ block: "nearest" })).catch(() => {});
              await el.click();
              break;
            }
            log("warn", `  [Click] 선택자 미발견, 좌표 폴백: ${ev.selector} → (${ev.x},${ev.y})`);
          } catch (selErr) {
            log("warn", `  [Click] 선택자 오류, 좌표 폴백: ${ev.selector} — ${selErr.message}`);
          }
        }
        if (!ev.selector)
          log("info", `  [Click] 셀렉터 없음, 좌표 클릭: (${ev.x},${ev.y})`);
        await state.activePage.mouse.click(ev.x, ev.y, { button: BTN(ev.button) });
        break;
      case "dblclick":
        flashElement(ev.selector, ev.x, ev.y, "dblclick");
        if (ev.selector) {
          try {
            const el = await pickByLabelOrFirst(state.activePage, ev.selector, ev.label);
            if (el) {
              await el.click({ clickCount: 2 });
              break;
            }
            log("warn", `  [DblClick] 선택자 미발견, 좌표 폴백: ${ev.selector} → (${ev.x},${ev.y})`);
          } catch (selErr) {
            log("warn", `  [DblClick] 선택자 오류, 좌표 폴백: ${ev.selector} — ${selErr.message}`);
          }
        }
        if (!ev.selector)
          log("info", `  [DblClick] 셀렉터 없음, 좌표 클릭: (${ev.x},${ev.y})`);
        await state.activePage.mouse.click(ev.x, ev.y, { clickCount: 2 });
        break;
      case "hover":
        if (ev.selector) {
          try {
            const el = await pickByLabelOrFirst(state.activePage, ev.selector, ev.label);
            if (el) { await el.hover(); break; }
          } catch {}
        }
        if (typeof ev.x === "number" && typeof ev.y === "number")
          await state.activePage.mouse.move(ev.x, ev.y);
        break;
      case "wheel":
        await state.activePage.mouse.wheel({ deltaX: ev.deltaX, deltaY: ev.deltaY });
        break;
      case "scroll":
        await state.activePage.evaluate(
          (x, y) => window.scrollTo(x, y),
          ev.scrollX,
          ev.scrollY,
        );
        break;
      case "keydown": {
        const key = ev.key === " " ? "Space" : ev.key;
        if (!SKIP_KEYS.has(key)) {
          try { await state.activePage.keyboard.down(key); } catch {}
        }
        break;
      }
      case "keyup": {
        const key = ev.key === " " ? "Space" : ev.key;
        if (!SKIP_KEYS.has(key)) {
          try { await state.activePage.keyboard.up(key); } catch {}
        }
        break;
      }
      case "input":
        flashElement(ev.selector, null, null, "input");
        if (ev.selector) {
          try {
            const el = await pickByLabelOrFirst(state.activePage, ev.selector, ev.label);
            if (el) {
              await el.click({ clickCount: 3 });
              await el.type(ev.value ?? "");
              break;
            }
          } catch {}
        }
        await state.activePage.keyboard.down("Control");
        await state.activePage.keyboard.press("a");
        await state.activePage.keyboard.up("Control");
        await state.activePage.keyboard.type(ev.value ?? "");
        break;
      case "select":
        flashElement(ev.selector, null, null, "input");
        if (ev.selector) {
          try {
            const el = await pickByLabelOrFirst(state.activePage, ev.selector, ev.label);
            if (el) {
              await el.evaluate((node, v) => {
                node.value = v;
                node.dispatchEvent(new Event("change", { bubbles: true }));
              }, ev.value);
              break;
            }
          } catch {}
        }
        await state.activePage.evaluate((v) => {
          const el = document.activeElement;
          if (el && el.tagName === "SELECT") {
            el.value = v;
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }, ev.value);
        break;
      case "check":
        flashElement(ev.selector, ev.x, ev.y, "click");
        if (ev.selector) {
          try {
            const el = await pickByLabelOrFirst(state.activePage, ev.selector, ev.label);
            if (el) {
              const info = await el.evaluate((input) => {
                const s = window.getComputedStyle(input);
                const hidden =
                  parseFloat(s.opacity) < 0.1 ||
                  s.visibility === "hidden"     ||
                  s.display === "none"          ||
                  (s.position === "absolute" && input.offsetWidth === 0 && input.offsetHeight === 0);
                const cur = input.indeterminate ? null : input.checked;
                if (!hidden) return { cur, cx: null, cy: null };
                const candidates = [
                  input.closest("label.el-checkbox, label.el-radio, label.el-checkbox-button, label.el-radio-button"),
                  input.parentElement && input.parentElement.querySelector(".el-checkbox__inner, .el-radio__inner"),
                  input.parentElement,
                ];
                for (const c of candidates) {
                  if (!c) continue;
                  const r = c.getBoundingClientRect();
                  if (r.width > 0 && r.height > 0) {
                    c.scrollIntoView({ block: "nearest" });
                    const r2 = c.getBoundingClientRect();
                    return { cur, cx: r2.left + r2.width / 2, cy: r2.top + r2.height / 2 };
                  }
                }
                return { cur, cx: null, cy: null };
              });
              if (info.cur !== ev.checked) {
                if (info.cx !== null) await state.activePage.mouse.click(info.cx, info.cy);
                else await el.click();
              }
              break;
            }
          } catch {}
        }
        await state.activePage.mouse.click(ev.x ?? 0, ev.y ?? 0);
        break;
      case "contenteditable":
        await state.activePage.evaluate((h) => {
          if (document.activeElement) document.activeElement.innerHTML = h;
        }, ev.html);
        break;
    }
  } catch {}
}

/**
 * For each network-trigger event, attach triggeredUrls: all HTTP responses
 * that arrived between this event's timestamp and the next trigger's timestamp.
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
  isSuite = false,
  recordingCookies = [],
  recordingToasts = [],
  compareHttp = true,
  mockReplay = false,
  recordingDomSnapshot = [],
) {
  const startMs = Date.now();
  if (!isSuite) send({ type: "replay-started" });
  log("info", `재생 시작 → ${startUrl}  (이벤트 ${events.length}개, fast)`);

  const replayResponses = [];
  const replayResponseUrls = []; // synchronous URL capture for trigger mapping
  const replayRespPending = new Set();
  const replayTriggerMap = new Map(); // eventIdx → [url, ...]
  const jsErrors = [];

  state.replayToasts = [];
  state.replayToastActive = true;
  state.replayCancelled = false;

  const onPageError = (err) => {
    jsErrors.push(err.message);
    log("fail", `[JS Error] ${err.message}`);
  };
  state.activePage.on("pageerror", onPageError);

  const onResponse = (response) => {
    const url = response.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (!isApiResponse(response)) return;
    if (isTrackerUrl(url)) return;
    const purl = pathUrl(url); // path-only for environment-portable comparison
    replayResponseUrls.push(purl);
    const ct = (response.headers()["content-type"] || "").toLowerCase();
    const status = response.status();
    const wantBody = /json|text\/plain|xml/.test(ct);

    if (!wantBody) {
      replayResponses.push({ url: purl, status, contentType: ct, body: null });
      return;
    }

    const p = response
      .buffer()
      .then((buf) => {
        const body = buf.toString("utf8");
        replayResponses.push({ url: purl, status, contentType: ct, body });
      })
      .catch(() =>
        replayResponses.push({ url: purl, status, contentType: ct, body: null }),
      )
      .finally(() => replayRespPending.delete(p));

    replayRespPending.add(p);
  };
  state.activePage.on("response", onResponse);

  let mockRequestHandler = null;
  let replayDomSnapshot = [];

  try {
    state.firstNavigateDone = false;

    // 1. Clear all browser cookies so previous test's session doesn't leak.
    await state.cdpSession.send("Network.clearBrowserCookies").catch(() => {});

    // 2. Clear Web Storage before any page JS runs on the next navigation.
    let clearStorageId = null;
    await state.cdpSession
      .send("Page.addScriptToEvaluateOnNewDocument", {
        source: "try{localStorage.clear();sessionStorage.clear();}catch{}",
      })
      .then(({ identifier }) => { clearStorageId = identifier; })
      .catch(() => {});

    // 3. Apply recording cookies (now the only cookies in the browser).
    state.replayCookies =
      recordingCookies.length > 0 ? recordingCookies : state.sessionCookies;
    if (state.replayCookies.length > 0) {
      await state.activePage.setCookie(...state.replayCookies);
      log(
        "info",
        `쿠키 ${state.replayCookies.length}개 적용${recordingCookies.length > 0 ? " (테스트 케이스 저장 쿠키)" : ""}`,
      );
    }

    // 4. Set up mock request interception before navigation.
    if (mockReplay) {
      // Build URL → response map keyed by canonicalUrl (URL + query params,
      // cache-busters stripped). Init recording is loaded first as baseline;
      // test recording overwrites for the same key (last-write-wins).
      // Every matching request is served from the map — no cursor, repeatable.
      const mockMap = new Map();

      // Keys are canonicalUrl(pathUrl(url)): origin stripped + cache-busters
      // stripped. This makes recordings portable across local/dev/production.
      const mkKey = (url) => canonicalUrl(pathUrl(url));

      const initId = dbFindInitByUrl(startUrl);
      if (initId) {
        const initResps = dbLoadResponses(initId);
        for (const r of initResps) mockMap.set(mkKey(r.url), r);
        log("info", `[Mock] 초기화 레코딩 로드 (id=${initId}, ${initResps.length}건)`);
      }
      for (const r of recordedResponses) mockMap.set(mkKey(r.url), r);

      mockRequestHandler = async (request) => {
        if (request.isInterceptResolutionHandled?.()) return;
        const rt = request.resourceType();
        if (rt !== "xhr" && rt !== "fetch") return request.continue().catch(() => {});
        const key = mkKey(request.url());
        const rec = mockMap.get(key);
        // Hybrid mock: pass through to the real server when no recording is
        // available. This avoids cascading axios "Network Error" when the
        // page makes calls (SDK init, analytics, lazy-loaded data) that
        // weren't part of the recording. Recorded responses still take
        // precedence and stay deterministic.
        if (!rec || rec.body === null) {
          log("info", `[Mock] 미매칭 → 실서버 통과: ${request.url()}`);
          return request.continue().catch(() => {});
        }
        log("info", `[Mock] ${request.method()} ${request.url()}`);
        await request.respond({
          status: rec.status,
          headers: {
            "content-type": rec.contentType,
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "*",
          },
          body: rec.body,
        }).catch(() => {});
      };
      await state.activePage.setRequestInterception(true);
      state.activePage.on("request", mockRequestHandler);
    }

    // 5. Always navigate — fresh context requires a full page load.
    log("info", `페이지 로드: ${startUrl}`);
    await state.activePage.goto(startUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    // Wait for initial API calls to settle, but with a SHORT timeout —
    // pages with persistent connections / pollers never reach full idle and
    // would otherwise leave the overlay stuck on "준비 중…" for the full
    // 60s default. Best-effort: 6s ceiling, 300ms idle window.
    await waitNetworkIdle(6000, 300);
    // Tell the UI that loading has finished and event execution will begin.
    // Without this, the overlay shows "준비 중…" until the first event
    // dispatches and the modulo-5 progress emit fires.
    send({ type: "replay-progress", done: 0, total: events.length });

    // 6. Remove the clear-storage script so subsequent navigations within
    //    this replay are not affected.
    if (clearStorageId)
      await state.cdpSession
        .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: clearStorageId })
        .catch(() => {});

    const total = events.length;
    let lastTriggerIdx = -1;
    let lastTriggerSnapLen = -1;

    for (let i = 0; i < total; i++) {
      if (state.replayCancelled) {
        log("warn", `재생 취소됨 (${i}/${total} 완료)`);
        break;
      }
      const ev = events[i];

      switch (ev.type) {
        case "navigate": log("info", `[Navigate] ${ev.url}`); break;
        case "click":    log("info", `[Click] (${ev.x},${ev.y})`); break;
        case "dblclick": log("info", `[DblClick] (${ev.x},${ev.y})`); break;
        case "keydown":
          if (ev.key === "Enter") log("info", `[Enter] 폼 제출 또는 키 입력`);
          break;
        case "input": log("info", `[Input] "${String(ev.value ?? "").slice(0, 40)}"`); break;
      }

      const isTrigger = isNetworkTrigger(ev);
      const snapLen = isTrigger ? replayResponseUrls.length : -1;

      await dispatchReplayEvent(ev);

      if (NETWORK_EVENTS.has(ev.type)) await waitNetworkIdle();
      if (ev.type === "keydown" && (ev.key === "Enter" || ev.code === "Enter"))
        await waitNetworkIdle();
      if (ev.type === "check" || ev.type === "select")
        await waitNetworkIdle();

      // Let the UI react: give Vue/React reactivity, CSS transitions, and
      // component updates time to complete before the next action fires.
      if (!NO_SETTLE_EVTS.has(ev.type)) await sleep(UI_SETTLE_MS);

      if (isTrigger && snapLen >= 0) {
        replayTriggerMap.set(i, replayResponseUrls.slice(snapLen));
        lastTriggerIdx = i;
        lastTriggerSnapLen = snapLen;
      }

      if (i % 5 === 0 || i === total - 1)
        send({ type: "replay-progress", done: i + 1, total });
    }

    // Post-loop settlement: repeat waitNetworkIdle until no new responses
    // arrive (handles A→B→C cascade chains). Capped at 5 iterations.
    for (let pass = 0; pass < 5; pass++) {
      const prevLen = replayResponseUrls.length;
      await waitNetworkIdle();
      if (replayResponseUrls.length === prevLen) break;
    }
    // Update the last trigger's map with ALL responses captured since it fired.
    if (lastTriggerIdx >= 0)
      replayTriggerMap.set(lastTriggerIdx, replayResponseUrls.slice(lastTriggerSnapLen));

    // Capture final DOM state for comparison
    replayDomSnapshot = await captureDomSnapshot(state.activePage);
  } catch (err) {
    log("fail", `재생 오류: ${err.message}`);
  } finally {
    state.replayToastActive = false;
    state.activePage.off("pageerror", onPageError);
    state.activePage.off("response", onResponse);
    if (mockReplay && mockRequestHandler) {
      state.activePage.off("request", mockRequestHandler);
      await state.activePage.setRequestInterception(false).catch(() => {});
    }
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

  const toastResults = compareToasts(recordingToasts, state.replayToasts);
  const triggerResults = compareTriggerMappings(events, replayTriggerMap);
  const domResults = compareDomSnapshots(recordingDomSnapshot, replayDomSnapshot);
  const passed = results.filter((r) => r.pass).length;
  const httpFailed = results.filter((r) => !r.pass).length;
  const toastFailed = toastResults.filter((r) => !r.pass).length;
  const triggerFailed = triggerResults.filter((r) => !r.pass).length;
  const domFailed = domResults.filter((r) => !r.pass).length;
  const scriptFailed = jsErrors.length;
  const failed = httpFailed + toastFailed + triggerFailed + domFailed + scriptFailed;

  if (results.length > 0) {
    if (httpFailed === 0)
      log("success", `━━ HTTP 응답: SUCCESS — ${passed}/${results.length} 일치 ━━`);
    else if (passed === 0)
      log("fail", `━━ HTTP 응답: FAIL — ${httpFailed}/${results.length} 불일치 ━━`);
    else
      log("warn", `━━ HTTP 응답: PARTIAL — 성공 ${passed} / 실패 ${httpFailed} ━━`);

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
      log("fail", `━━ 토스트: FAIL — ${toastFailed}/${toastResults.length}건 불일치 ━━`);
    for (const r of toastResults) {
      const t = (r.text ?? "").replace(/\r?\n/g, " ↵ ").trim();
      if (r.pass) log("success", `  ✓ [Toast] ${t}`);
      else log("fail", `  ✗ [Toast] "${t}" — 재생 시 미감지`);
    }
  }

  if (triggerResults.length > 0) {
    if (triggerFailed === 0)
      log("success", `━━ 이벤트-HTTP 매핑: SUCCESS — ${triggerResults.length}건 일치 ━━`);
    else
      log("fail", `━━ 이벤트-HTTP 매핑: FAIL — ${triggerFailed}/${triggerResults.length}건 불일치 ━━`);
    for (const r of triggerResults) {
      if (r.pass)
        log("success", `  ✓ [${r.eventType}:${r.eventLabel}] → ${r.url}`);
      else
        log("fail", `  ✗ [${r.eventType}:${r.eventLabel}] → ${r.url} — 재생 시 미감지`);
    }
  }

  if (domResults.length > 0) {
    const domPassed = domResults.filter((r) => r.pass).length;
    if (domFailed === 0)
      log("success", `━━ DOM 텍스트: SUCCESS — ${domPassed}/${domResults.length} 일치 ━━`);
    else
      log("fail", `━━ DOM 텍스트: FAIL — ${domFailed}/${domResults.length} 불일치 ━━`);
    for (const r of domResults) {
      if (!r.pass) {
        if (r.reason === 'text-mismatch') {
          const actual = (r.actualTexts || []).map(t => `"${t.slice(0, 40)}"`).join(', ');
          log("fail", `  ✗ [DOM] 텍스트 불일치 (경로: ${r.path}) 기대: "${r.text.slice(0, 40)}" → 실제: ${actual}`);
        } else {
          log("fail", `  ✗ [DOM] 경로 없음: "${r.text.slice(0, 60)}" (경로: ${r.path})`);
        }
      }
    }
  }

  if (jsErrors.length > 0) {
    log("fail", `━━ 스크립트 에러 ${jsErrors.length}건 감지 ━━`);
    for (const e of jsErrors) log("fail", `  ✗ [JS Error] ${e}`);
  }

  const total = results.length + toastResults.length + triggerResults.length + domResults.length;
  const durationMs = Date.now() - startMs;
  dbSaveHistory(recordingId, passed, failed, total, results, durationMs);
  send({ type: "history", recordingId, runs: dbGetHistory(recordingId) });

  if (!isSuite) send({ type: "replay-done" });
  send({ type: "replay-result", results, toastResults, triggerResults, domResults, passed, failed, total, jsErrors });

  return { passed, failed, total };
}

module.exports = { runReplay, mapResponsesToEvents, captureDomSnapshot };
