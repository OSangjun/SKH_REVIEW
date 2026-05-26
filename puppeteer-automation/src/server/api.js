"use strict";

const {
  dbAllMeta, dbGetMeta,
  dbLoadEvents, dbLoadResponses,
  dbLoadDomSnapshot, dbLoadDomExclude, dbUpdateDomExclude,
  dbDeleteRecording, dbUpdateResponses,
} = require("./db");
const { generateScript } = require("./export");

/**
 * Mount all REST routes for the recording browser onto an Express app.
 */
function mountRoutes(app) {
  // ── List + read ────────────────────────────────────────────────────────────
  app.get("/api/recordings", (_req, res) => res.json(dbAllMeta()));

  app.get("/api/recordings/:id", (req, res) => {
    const meta = dbGetMeta(+req.params.id);
    if (!meta) return res.status(404).json({ error: "Not found" });
    const events = dbLoadEvents(meta.id);
    if (!events) return res.status(500).json({ error: "Events not found" });
    res.json({ ...meta, events });
  });

  app.delete("/api/recordings/:id", (req, res) => {
    const meta = dbGetMeta(+req.params.id);
    if (!meta) return res.status(404).json({ error: "Not found" });
    dbDeleteRecording(meta.id);
    res.json({ ok: true });
  });

  // ── HTTP responses (view + edit) ───────────────────────────────────────────
  app.get("/api/recordings/:id/responses", (req, res) => {
    const meta = dbGetMeta(+req.params.id);
    if (!meta) return res.status(404).json({ error: "Not found" });
    res.json(dbLoadResponses(meta.id));
  });

  app.put("/api/recordings/:id/responses", (req, res) => {
    const meta = dbGetMeta(+req.params.id);
    if (!meta) return res.status(404).json({ error: "Not found" });
    const responses = req.body;
    if (!Array.isArray(responses))
      return res.status(400).json({ error: "Expected array" });
    dbUpdateResponses(meta.id, JSON.stringify(responses));
    res.json({ ok: true });
  });

  // ── DOM snapshot + exclude ────────────────────────────────────────────────
  app.get("/api/recordings/:id/dom-snapshot", (req, res) => {
    const meta = dbGetMeta(+req.params.id);
    if (!meta) return res.status(404).json({ error: "Not found" });
    res.json({
      snapshot: dbLoadDomSnapshot(meta.id),
      exclude:  dbLoadDomExclude(meta.id),
    });
  });

  app.put("/api/recordings/:id/dom-exclude", (req, res) => {
    const meta = dbGetMeta(+req.params.id);
    if (!meta) return res.status(404).json({ error: "Not found" });
    const paths = req.body;
    if (!Array.isArray(paths))
      return res.status(400).json({ error: "Expected array of path strings" });
    dbUpdateDomExclude(meta.id, paths);
    res.json({ ok: true });
  });

  // ── Puppeteer script export ────────────────────────────────────────────────
  app.get("/api/recordings/:id/export/puppeteer", (req, res) => {
    const meta = dbGetMeta(+req.params.id);
    if (!meta) return res.status(404).json({ error: "Not found" });
    const events = dbLoadEvents(meta.id);
    if (!events) return res.status(500).json({ error: "Events not found" });

    const filename = `${meta.name.replace(/[^\w\s-]/g, "_")}.js`;
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(generateScript({ ...meta, events }));
  });
}

module.exports = { mountRoutes };
