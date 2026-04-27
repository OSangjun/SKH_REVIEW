"use strict";

const { mergeCookies } = require("./cookies");
const C = require("./colors");
const { applyBaseUrl, pageKey } = require("../shared/url");
const { isApiResponse } = require("../shared/api-filter");
const { isBlockedUrl, isTrackerUrl } = require("../shared/blocklist");
const {
  compareResponses, compareToasts, compareTriggerMappings, isNetworkTrigger,
} = require("../shared/compare");
const {
  NETWORK_EVTS, NO_DELAY_EVTS, dispatchEvent, waitNetworkIdle,
} = require("../shared/dispatch");
const {
  ASSERT_TYPES, WAIT_TYPES, runAssertion, runScreenshotAssert, runWait,
} = require("../shared/assertions");

const VIEWPORT = { width: 1920, height: 1080 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tryJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

const TOAST_OBSERVER_SCRIPT = `(function() {
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
})();`;

async function replayRecording(session, rec, opts, cliCookies = []) {
  const { page } = session;
  const events = tryJson(rec.events, []);
  const recorded = tryJson(rec.responses, []);
  const recordedToasts = tryJson(rec.toasts, []);
  const cookies = mergeCookies(tryJson(rec.cookies, []), cliCookies);

  // Toast buffer for *this* test — session.__captureToast pushes here
  const replayToasts = [];
  session.toastSink = replayToasts;

  const replayResponses = [];
  const replayResponseUrls = [];
  const replayTriggerMap = new Map();
  const pending = new Set();
  const jsErrors = [];
  const assertResults = [];
  const waitFailures = [];

  const onPageError = (err) => {
    jsErrors.push(err.message);
    if (opts.verbose) console.log(`  ${C.red}[JS Error] ${err.message}${C.reset}`);
  };
  page.on("pageerror", onPageError);

  const onResponse = (response) => {
    const url = response.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (!isApiResponse(response)) return;
    if (isTrackerUrl(url)) return;
    if (isBlockedUrl(url, opts.ignoreHosts, opts.ignoreUrlPatterns)) return;
    replayResponseUrls.push(url);
    const ct = (response.headers()["content-type"] || "").toLowerCase();
    const status = response.status();
    const wantBody = /json|text\/plain|xml/.test(ct);
    const req = response.request();
    const method = req.method();
    const reqBody = method !== "GET" && method !== "HEAD" ? (req.postData() ?? null) : null;

    if (!wantBody) {
      replayResponses.push({ url, status, contentType: ct, body: null, method, reqBody });
      return;
    }
    const p = response.buffer()
      .then((buf) => {
        const body = buf.length <= 51200 ? buf.toString("utf8") : null;
        replayResponses.push({ url, status, contentType: ct, body, method, reqBody });
      })
      .catch(() =>
        replayResponses.push({ url, status, contentType: ct, body: null, method, reqBody }),
      )
      .finally(() => pending.delete(p));
    pending.add(p);
  };
  page.on("response", onResponse);

  const startMs = Date.now();
  let error = null;

  try {
    if (cookies.length > 0) await page.setCookie(...cookies);

    const startUrl = applyBaseUrl(rec.url, opts.baseUrl);
    const idleTime = opts.fast ? 200 : 500;

    if (page.url() !== startUrl) {
      if (opts.verbose) console.log(`  ${C.dim}Load: ${startUrl}${C.reset}`);
      const waitUntil = opts.fast ? "domcontentloaded" : "networkidle2";
      await page.goto(startUrl, { waitUntil, timeout: 30000 });
      // Fast mode uses domcontentloaded which can resolve before in-flight
      // response bodies are available — wait for network to settle.
      if (opts.fast) await waitNetworkIdle(page, opts.timeout, idleTime);
    } else if (opts.verbose) {
      console.log(`  ${C.dim}Reuse: ${startUrl}${C.reset}`);
    }

    let lastT = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const delay =
        opts.fast || NO_DELAY_EVTS.has(ev.type)
          ? 0
          : Math.max(0, ((ev.t ?? 0) - lastT) / opts.speed);
      if (delay > 0) await sleep(delay);
      lastT = ev.t ?? 0;

      if (opts.verbose) {
        const detail =
          ev.type === "click"      ? `(${ev.x},${ev.y})` :
          ev.type === "dblclick"   ? `(${ev.x},${ev.y})` :
          ev.type === "keydown"    ? ev.key :
          ev.type === "input"      ? `"${String(ev.value ?? "").slice(0, 30)}"` :
          ev.type === "navigate"   ? ev.url :
                                     "";
        console.log(`  ${C.dim}[${ev.type}]${detail ? " " + detail : ""}${C.reset}`);
      }

      if (ASSERT_TYPES.has(ev.type)) {
        const r = ev.type === "assert-screenshot"
          ? await runScreenshotAssert(page, ev)
          : await runAssertion(page, ev, opts.timeout);
        if (r) assertResults.push(r);
        continue;
      }
      if (WAIT_TYPES.has(ev.type)) {
        const r = await runWait(page, ev, opts.timeout);
        if (!r.pass) waitFailures.push({ type: ev.type, label: ev.selector || ev.expr, message: r.message });
        continue;
      }

      const isTrigger = isNetworkTrigger(ev);
      const snapLen = isTrigger ? replayResponseUrls.length : -1;

      try {
        await dispatchEvent(page, ev, opts.baseUrl, opts.fast);
      } catch {}

      const needsWait =
        NETWORK_EVTS.has(ev.type) ||
        (ev.type === "keydown" && (ev.key === "Enter" || ev.code === "Enter")) ||
        ev.type === "check" ||
        ev.type === "select";
      if (needsWait) await waitNetworkIdle(page, opts.timeout, idleTime);

      if (isTrigger && snapLen >= 0)
        replayTriggerMap.set(i, replayResponseUrls.slice(snapLen));
    }
  } catch (err) {
    error = err.message;
  } finally {
    page.off("pageerror", onPageError);
    page.off("response", onResponse);
    if (pending.size > 0)
      await Promise.race([Promise.allSettled([...pending]), sleep(2000)]);
    // Page is reused across tests — do not close
  }

  const duration = (Date.now() - startMs) / 1000;
  const compareOpts = {
    ignoreHosts: opts.ignoreHosts,
    ignoreUrlPatterns: opts.ignoreUrlPatterns,
    bodyIgnore: opts.bodyIgnore,
    stripParams: opts.stripParams,
  };
  const results = recorded.length > 0 ? compareResponses(recorded, replayResponses, compareOpts) : [];
  const toastResults = compareToasts(recordedToasts, replayToasts);
  const triggerResults = compareTriggerMappings(events, replayTriggerMap);
  const passed = results.filter((r) => r.pass).length;
  const httpFailed = results.filter((r) => !r.pass).length;
  const toastFailed = toastResults.filter((r) => !r.pass).length;
  const triggerFailed = triggerResults.filter((r) => !r.pass).length;
  const assertPassed = assertResults.filter((r) => r.pass).length;
  const assertFailed = assertResults.filter((r) => !r.pass).length;
  const waitFailed = waitFailures.length;
  const failed = httpFailed + toastFailed + triggerFailed + assertFailed + waitFailed + jsErrors.length;
  const total = results.length + toastResults.length + triggerResults.length + assertResults.length;

  return {
    rec,
    results,
    toastResults,
    triggerResults,
    assertResults,
    waitFailures,
    passed: passed + assertPassed,
    failed,
    total,
    duration,
    error,
    jsErrors,
  };
}

// Group recordings by page URL — same-URL recordings run consecutively so
// the shared page does not navigate unnecessarily between them.
function groupByPage(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = pageKey(r.url);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return groups;
}

module.exports = { replayRecording, groupByPage, VIEWPORT, TOAST_OBSERVER_SCRIPT };
