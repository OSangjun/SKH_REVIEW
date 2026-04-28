"use strict";

const puppeteer = require("puppeteer-core");
const { buildCaptureScript } = require("./inject");
const { isApiResponse } = require("../shared/api-filter");
const { isTrackerUrl } = require("../shared/blocklist");
const state = require("./state");
const { send } = require("./comms");

async function launchSession(chromePath, viewport) {
  console.log("[Browser] Launching Puppeteer …");
  state.browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
    defaultViewport: viewport,
  });

  [state.activePage] = await state.browser.pages();

  // Expose capture bridge: page JS → Node.js handler
  await state.activePage.exposeFunction("__captureEvent", (type, data) => {
    if (!state.isRecording) return;
    const now = Date.now();
    if (state.recordingStartTime === null) state.recordingStartTime = now;
    if (type === "toast") {
      state.capturedToasts.push({ text: data.text });
      return;
    }
    const ev = { type, ...data, t: now - state.recordingStartTime };
    state.capturedEvents.push(ev);
    send({ type: "recording-event", count: state.capturedEvents.length });
  });

  // Expose toast bridge for replay (separate from recording bridge)
  await state.activePage.exposeFunction("__captureToast", (text) => {
    if (state.replayToastActive) state.replayToasts.push(text);
  });

  // Inject toast observer for replay (runs on every page load)
  await state.activePage.evaluateOnNewDocument(`(function() {
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

  // Inject capture script on EVERY navigation (JS redirect, meta refresh, etc.)
  await state.activePage.evaluateOnNewDocument(buildCaptureScript());

  // Track URL changes
  state.activePage.on("framenavigated", (frame) => {
    if (frame !== state.activePage.mainFrame()) return;
    const url = frame.url();
    if (url === state.currentUrl || url === "about:blank") return;

    if (state.isRecording && state.firstNavigateDone) {
      const ev = { type: "navigate", url, t: Date.now() - state.recordingStartTime };
      state.capturedEvents.push(ev);
      send({ type: "recording-event", count: state.capturedEvents.length });
    }
    state.firstNavigateDone = true;
    state.currentUrl = url;
    send({ type: "url-changed", url });
  });

  // Capture HTTP responses (with body) during recording
  state.activePage.on("response", (response) => {
    if (!state.isRecording) return;
    const url = response.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (!isApiResponse(response)) return;
    if (isTrackerUrl(url)) return;

    const ct = (response.headers()["content-type"] || "").toLowerCase();
    const wantBody = /json|text\/plain|xml/.test(ct);
    const status = response.status();
    const t = Date.now() - (state.recordingStartTime ?? Date.now());

    if (!wantBody) {
      state.capturedResponses.push({ url, status, contentType: ct, body: null, t });
      return;
    }

    const p = response
      .buffer()
      .then((buf) => {
        const body = buf.length <= 51200 ? buf.toString("utf8") : null;
        state.capturedResponses.push({ url, status, contentType: ct, body, t });
      })
      .catch(() => {
        state.capturedResponses.push({ url, status, contentType: ct, body: null, t });
      })
      .finally(() => state.pendingRespPromises.delete(p));

    state.pendingRespPromises.add(p);
  });

  // Handle page crashes / unexpected closes
  state.browser.on("disconnected", () => {
    console.log("[Browser] Disconnected");
    state.browser = null;
    state.activePage = null;
    state.cdpSession = null;
  });

  await startScreencast(viewport);
  console.log("[Browser] Ready");
}

async function startScreencast(viewport) {
  state.cdpSession = await state.activePage.createCDPSession();
  await state.cdpSession.send("Page.startScreencast", {
    format: "jpeg",
    quality: 75,
    maxWidth: viewport.width,
    maxHeight: viewport.height,
    everyNthFrame: 1,
  });

  state.cdpSession.on("Page.screencastFrame", async ({ data, sessionId }) => {
    send({ type: "frame", data });
    await state.cdpSession
      .send("Page.screencastFrameAck", { sessionId })
      .catch(() => {});
  });
}

module.exports = { launchSession };
