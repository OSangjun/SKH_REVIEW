"use strict";

const fs = require("fs");
const path = require("path");
const { openDb } = require("../shared/db");

const ROOT = path.join(__dirname, "..", "..");

const db = openDb();

const stmts = {
  insertRecording: db.prepare(
    `INSERT INTO recordings (name, url, event_count, created_at, events, responses, cookies, toasts, dom_snapshot)
     VALUES (@name, @url, @event_count, @created_at, @events, @responses, @cookies, @toasts, @dom_snapshot)`,
  ),
  updateMeta: db.prepare(
    `UPDATE recordings SET name=@name, description=@description, tags=@tags WHERE id=@id`,
  ),
  allMeta: db.prepare(
    `SELECT id, name, url, event_count AS eventCount, created_at AS createdAt,
            description, tags
     FROM recordings ORDER BY id`,
  ),
  getMeta: db.prepare(
    `SELECT id, name, url, event_count AS eventCount, created_at AS createdAt,
            description, tags
     FROM recordings WHERE id = ?`,
  ),
  getEvents: db.prepare(`SELECT events    FROM recordings WHERE id = ?`),
  getResponses: db.prepare(`SELECT responses FROM recordings WHERE id = ?`),
  getCookies: db.prepare(`SELECT cookies   FROM recordings WHERE id = ?`),
  getToasts: db.prepare(`SELECT toasts       FROM recordings WHERE id = ?`),
  getDomSnapshot: db.prepare(`SELECT dom_snapshot FROM recordings WHERE id = ?`),
  getDomExclude:  db.prepare(`SELECT dom_exclude  FROM recordings WHERE id = ?`),
  updateDomExclude: db.prepare(`UPDATE recordings SET dom_exclude = ? WHERE id = ?`),
  deleteRecording: db.prepare(`DELETE FROM recordings WHERE id = ?`),
  insertHistory: db.prepare(
    `INSERT INTO run_history (recording_id, run_at, passed, failed, total, results, duration_ms)
     VALUES (@recording_id, @run_at, @passed, @failed, @total, @results, @duration_ms)`,
  ),
  getHistory: db.prepare(
    `SELECT id, recording_id AS recordingId, run_at AS runAt, passed, failed, total, duration_ms AS durationMs
     FROM run_history WHERE recording_id = ? ORDER BY id DESC LIMIT 20`,
  ),
  allHistory: db.prepare(
    `SELECT id, recording_id AS recordingId, run_at AS runAt, passed, failed, total, duration_ms AS durationMs
     FROM run_history ORDER BY id DESC`,
  ),
  deleteHistoryByRecording: db.prepare(
    `DELETE FROM run_history WHERE recording_id = ?`,
  ),
  updateName: db.prepare(`UPDATE recordings SET name = ? WHERE id = ?`),
  updateResponses: db.prepare(`UPDATE recordings SET responses = ? WHERE id = ?`),
  findInitByUrl: db.prepare(
    `SELECT id FROM recordings WHERE name = '초기화' AND url = ? ORDER BY id DESC LIMIT 1`,
  ),
};

function tryJson(s, def) {
  try { return JSON.parse(s); } catch { return def; }
}

function parseMeta(row) {
  if (!row) return null;
  return { ...row, tags: tryJson(row.tags, []) };
}

// One-time migration from legacy file-based storage to SQLite. Idempotent.
(function migrate() {
  const META_FILE = path.join(ROOT, "recordings", "meta.json");
  if (!fs.existsSync(META_FILE)) return;
  try {
    const oldMeta = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
    if (!Array.isArray(oldMeta) || oldMeta.length === 0) return;
    const existing = new Set(stmts.allMeta.all().map((r) => r.id));
    let migrated = 0;
    const insert = db.transaction(() => {
      for (const rec of oldMeta) {
        if (existing.has(rec.id)) continue;
        const evFile = path.join(ROOT, "recordings", `${rec.id}.events.json`);
        const events = fs.existsSync(evFile) ? fs.readFileSync(evFile, "utf8") : "[]";
        db.prepare(
          `INSERT INTO recordings (id, name, url, event_count, created_at, events)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(rec.id, rec.name, rec.url, rec.eventCount ?? 0,
              rec.createdAt ?? new Date().toISOString(), events);
        migrated++;
      }
    });
    insert();
    if (migrated > 0)
      console.log(`[Storage] Migrated ${migrated} recording(s) from file storage to SQLite.`);
  } catch (err) {
    console.error("[Storage] Migration error (non-fatal):", err.message);
  }
})();

function dbAllMeta() { return stmts.allMeta.all().map(parseMeta); }
function dbGetMeta(id) { return parseMeta(stmts.getMeta.get(id)); }

function dbLoadEvents(id) {
  const row = stmts.getEvents.get(id);
  return row ? tryJson(row.events, null) : null;
}
function dbLoadResponses(id) {
  const row = stmts.getResponses.get(id);
  return row ? tryJson(row.responses, []) : [];
}
function dbLoadCookies(id) {
  const row = stmts.getCookies.get(id);
  return row ? tryJson(row.cookies, []) : [];
}
function dbLoadToasts(id) {
  const row = stmts.getToasts.get(id);
  return row ? tryJson(row.toasts, []) : [];
}
function dbLoadDomSnapshot(id) {
  const row = stmts.getDomSnapshot.get(id);
  return row ? tryJson(row.dom_snapshot, []) : [];
}
function dbLoadDomExclude(id) {
  const row = stmts.getDomExclude.get(id);
  return row ? tryJson(row.dom_exclude, []) : [];
}
function dbUpdateDomExclude(id, paths) {
  stmts.updateDomExclude.run(JSON.stringify(paths ?? []), id);
}
function dbSaveRecording(name, url, eventCount, createdAt, events, responses, cookies, toasts, domSnapshot) {
  const info = stmts.insertRecording.run({
    name, url,
    event_count: eventCount,
    created_at: createdAt,
    events: JSON.stringify(events),
    responses: JSON.stringify(responses),
    cookies: JSON.stringify(cookies ?? []),
    toasts: JSON.stringify(toasts ?? []),
    dom_snapshot: JSON.stringify(domSnapshot ?? []),
  });
  return info.lastInsertRowid;
}
function dbUpdateMeta(id, name, description, tags) {
  stmts.updateMeta.run({ id, name, description, tags: JSON.stringify(tags) });
}
function dbFindInitByUrl(url) {
  const row = stmts.findInitByUrl.get(url);
  return row ? row.id : null;
}
function dbUpdateName(id, name) { stmts.updateName.run(name, id); }
function dbUpdateResponses(id, responsesJson) { stmts.updateResponses.run(responsesJson, id); }
function dbDeleteRecording(id) { stmts.deleteRecording.run(id); }
function dbDeleteHistoryByRecording(id) { stmts.deleteHistoryByRecording.run(id); }

function dbGetHistory(recId) { return stmts.getHistory.all(recId); }
function dbAllHistory() {
  const map = {};
  for (const r of stmts.allHistory.all()) {
    if (!map[r.recordingId]) map[r.recordingId] = [];
    if (map[r.recordingId].length < 20) map[r.recordingId].push(r);
  }
  return map;
}
function dbSaveHistory(recId, passed, failed, total, results, durationMs) {
  stmts.insertHistory.run({
    recording_id: recId,
    run_at: new Date().toISOString(),
    passed, failed, total,
    results: JSON.stringify(results),
    duration_ms: durationMs,
  });
}

module.exports = {
  db,
  tryJson,
  dbAllMeta, dbGetMeta,
  dbLoadEvents, dbLoadResponses, dbLoadCookies, dbLoadToasts, dbLoadDomSnapshot,
  dbLoadDomExclude, dbUpdateDomExclude,
  dbSaveRecording, dbUpdateMeta, dbUpdateName, dbUpdateResponses, dbDeleteRecording,
  dbDeleteHistoryByRecording,
  dbGetHistory, dbAllHistory, dbSaveHistory,
  dbFindInitByUrl,
};
