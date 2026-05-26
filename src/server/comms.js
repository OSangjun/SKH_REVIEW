"use strict";

const { WebSocket } = require("ws");
const state = require("./state");

function send(msg) {
  if (state.activeWs?.readyState === WebSocket.OPEN)
    state.activeWs.send(JSON.stringify(msg));
}

// level: 'info' | 'success' | 'fail' | 'warn'
function log(level, message) {
  const ts = new Date().toLocaleTimeString("ko-KR", { hour12: false });
  send({ type: "log", level, message, ts });
  console.log(`[${ts}] [${level.toUpperCase()}] ${message}`);
}

module.exports = { send, log };
