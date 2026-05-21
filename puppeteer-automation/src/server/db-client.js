"use strict";

/**
 * db-client.js — 이중 DB 클라이언트 (center / local)
 *
 * 환경변수 네이밍:
 *   Center DB : CENTER_DB_ENGINE, CENTER_DB_HOST, CENTER_DB_PORT,
 *               CENTER_DB_USER, CENTER_DB_PASSWORD, CENTER_DB_NAME
 *               CENTER_TIBERO_ODBC_DSN (Tibero only)
 *
 *   Local  DB : DB_ENGINE, DB_HOST, DB_PORT,
 *               DB_USER, DB_PASSWORD, DB_NAME
 *               TIBERO_ODBC_DSN (Tibero only)
 *
 * Supported engines: pg | mariadb | tibero
 * Tibero requires odbc npm package + Tibero ODBC driver + DSN configured.
 */

// ── Config readers ───────────────────────────────────────────────────────────

function readConfig(name) {
  const pfx = name === "center" ? "CENTER_" : "";
  const engine = (process.env[`${pfx}DB_ENGINE`] || "").toLowerCase();
  return {
    engine,
    host:     process.env[`${pfx}DB_HOST`]     || "localhost",
    port:     parseInt(process.env[`${pfx}DB_PORT`] || "0", 10),
    user:     process.env[`${pfx}DB_USER`]     || "",
    password: process.env[`${pfx}DB_PASSWORD`] || "",
    database: process.env[`${pfx}DB_NAME`]     || "",
    odbc:     process.env[name === "center" ? "CENTER_TIBERO_ODBC_DSN" : "TIBERO_ODBC_DSN"] || "",
  };
}

function isConfigured(name = "local") {
  const cfg = readConfig(name);
  if (!cfg.engine) return false;
  if (cfg.engine === "tibero") return !!cfg.odbc;
  return !!(cfg.host && cfg.database);
}

// Returns list of configured DB names (for tool registration & logging)
function configuredDbs() {
  const list = [];
  if (isConfigured("local"))  list.push("local");
  if (isConfigured("center")) list.push("center");
  return list;
}

// ── Pool cache ───────────────────────────────────────────────────────────────

const _pools = { local: null, center: null };

async function getPool(name) {
  if (_pools[name]) return _pools[name];

  const cfg = readConfig(name);

  if (cfg.engine === "pg") {
    const { Pool } = require("pg");
    _pools[name] = new Pool({
      host: cfg.host, port: cfg.port || 5432,
      user: cfg.user, password: cfg.password, database: cfg.database,
      max: 3,
    });
    return _pools[name];
  }

  if (cfg.engine === "mariadb") {
    const mysql = require("mysql2/promise");
    _pools[name] = mysql.createPool({
      host: cfg.host, port: cfg.port || 3306,
      user: cfg.user, password: cfg.password, database: cfg.database,
      connectionLimit: 3,
    });
    return _pools[name];
  }

  if (cfg.engine === "tibero") {
    return null; // Tibero uses per-query connections via ODBC
  }

  throw new Error(`지원하지 않는 DB 엔진: ${cfg.engine} (${name})`);
}

// ── Query ────────────────────────────────────────────────────────────────────

async function query(sql, params = [], name = "local") {
  if (!isConfigured(name)) throw new Error(`${name} DB가 설정되지 않았습니다.`);

  const cfg = readConfig(name);

  if (cfg.engine === "tibero") {
    const odbc = require("odbc");
    const conn = await odbc.connect(`DSN=${cfg.odbc}`);
    try {
      const result = await conn.query(sql, params);
      return Array.from(result);
    } finally {
      await conn.close();
    }
  }

  const pool = await getPool(name);

  if (cfg.engine === "pg") {
    const { rows } = await pool.query(sql, params);
    return rows;
  }

  if (cfg.engine === "mariadb") {
    const [rows] = await pool.execute(sql, params);
    return rows;
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

async function close() {
  for (const name of ["local", "center"]) {
    const pool = _pools[name];
    if (!pool) continue;
    const cfg = readConfig(name);
    if (cfg.engine === "pg" || cfg.engine === "mariadb")
      await pool.end().catch(() => {});
    _pools[name] = null;
  }
}

module.exports = { isConfigured, configuredDbs, query, close };
