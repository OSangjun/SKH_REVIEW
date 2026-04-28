"use strict";

// Shared mutable state for the browser automation server.
// All modules read/write this object directly; Node's module cache
// guarantees a single instance across all requires.
const state = {
  // Puppeteer handles
  browser: null,
  activePage: null,
  cdpSession: null,
  activeWs: null,

  // Recording
  isRecording: false,
  capturedEvents: [],
  capturedResponses: [],
  capturedToasts: [],
  pendingRespPromises: new Set(),
  recordingStartTime: null,
  recordingStartUrl: "",
  currentUrl: "about:blank",
  firstNavigateDone: false,

  // Cookies
  sessionCookies: [],
  replayCookies: [],

  // Replay
  replayToasts: [],
  replayToastActive: false,
  replayCancelled: false,
};

module.exports = state;
