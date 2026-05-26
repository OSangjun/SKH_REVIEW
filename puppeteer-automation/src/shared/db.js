"use strict";

const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "..", "..", "recordings.db");

function openDb() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS recordings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      url         TEXT    NOT NULL,
      event_count INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL,
      events      TEXT    NOT NULL DEFAULT '[]'
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id INTEGER NOT NULL,
      run_at       TEXT    NOT NULL,
      passed       INTEGER NOT NULL DEFAULT 0,
      failed       INTEGER NOT NULL DEFAULT 0,
      total        INTEGER NOT NULL DEFAULT 0,
      results      TEXT    NOT NULL DEFAULT '[]',
      duration_ms  INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Idempotent column migrations — silently ignored if already added.
  for (const col of [
    `ALTER TABLE recordings ADD COLUMN responses    TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE recordings ADD COLUMN description  TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE recordings ADD COLUMN tags         TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE recordings ADD COLUMN cookies      TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE recordings ADD COLUMN toasts       TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE recordings ADD COLUMN dom_snapshot TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE recordings ADD COLUMN dom_exclude  TEXT NOT NULL DEFAULT '[]'`,
  ]) {
    try { db.exec(col); } catch {}
  }

  return db;
}

module.exports = { openDb, DB_PATH };
