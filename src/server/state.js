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

  // 초기화 녹화 — navigate 후 첫 사용자 입력 전까지 수집, 입력 시점에 확정 저장
  pendingInitCap: null,

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

  // Analysis
  isAnalyzing: false,
  analysisCancelled: false,
};

module.exports = state;
