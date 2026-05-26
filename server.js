"use strict";
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");

const { mountRoutes } = require("./src/server/api");
const { dbAllMeta, dbAllHistory } = require("./src/server/db");
const state = require("./src/server/state");
const { send } = require("./src/server/comms");
const { launchSession } = require("./src/server/browser");
const { handleClientMessage } = require("./src/server/ws-handler");

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

// ─── WebSocket connection handler ─────────────────────────────────────────────

wss.on("connection", async (ws) => {
  console.log("[WS] Client connected");
  state.activeWs = ws;

  try {
    if (!state.browser) await launchSession(CHROME_PATH, VIEWPORT);
    send({ type: "ready", viewport: VIEWPORT });
    send({ type: "url-changed", url: state.currentUrl });
    send({ type: "recordings", list: dbAllMeta() });
    send({ type: "history-all", map: dbAllHistory() });
  } catch (err) {
    send({ type: "error", message: err.message });
    console.error("[WS] Session launch error:", err.message);
  }

  ws.on("message", async (raw) => {
    try {
      await handleClientMessage(JSON.parse(raw.toString()));
    } catch (err) {
      console.error("[WS] Handler error:", err.message);
    }
  });

  ws.on("close", () => {
    if (state.activeWs === ws) state.activeWs = null;
    console.log("[WS] Client disconnected");
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n[Server] Browser Automation Tool → http://localhost:${PORT}\n`);
});
