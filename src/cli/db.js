"use strict";

const C = require("./colors");
const { openDb, DB_PATH } = require("../shared/db");

function fetchRecordings(db, opts) {
  if (opts.all) {
    return db.prepare(`
      SELECT id, name, url, event_count AS eventCount, created_at AS createdAt,
             description, events, responses, cookies, toasts
      FROM recordings ORDER BY id
    `).all();
  }
  const ph = opts.ids.map(() => "?").join(",");
  return db.prepare(`
    SELECT id, name, url, event_count AS eventCount, created_at AS createdAt,
           description, events, responses, cookies, toasts
    FROM recordings WHERE id IN (${ph}) ORDER BY id
  `).all(...opts.ids);
}

function listRecordings(db) {
  const rows = db.prepare(`
    SELECT id, name, url, event_count AS eventCount, created_at AS createdAt, description
    FROM recordings ORDER BY id
  `).all();

  if (rows.length === 0) {
    console.log("No recordings found.");
    return;
  }

  const fmt = (iso) => {
    try { return new Date(iso).toLocaleString("ko-KR"); } catch { return iso; }
  };
  const pad = (s, n) => String(s).padEnd(n);

  console.log(`\n${C.bold}${pad("ID", 4)}${pad("Name", 24)}${pad("Events", 8)}${pad("Created", 22)}URL${C.reset}`);
  console.log("─".repeat(90));
  for (const r of rows) {
    const desc = r.description ? `  ${C.dim}${r.description}${C.reset}` : "";
    console.log(`${pad(r.id, 4)}${pad(r.name, 24)}${pad(r.eventCount, 8)}${pad(fmt(r.createdAt), 22)}${r.url}${desc}`);
  }
  console.log();
}

module.exports = { openDb, fetchRecordings, listRecordings, DB_PATH };
