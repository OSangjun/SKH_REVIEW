"use strict";

// DB query client supporting PostgreSQL, MariaDB, and Tibero (via ODBC).
// Engine is selected by DB_ENGINE env var: pg | mariadb | tibero
// Connection: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
// Tibero: TIBERO_ODBC_DSN (requires odbc npm + Tibero ODBC driver installed)

const ENGINE = (process.env.DB_ENGINE || "").toLowerCase();

function isConfigured() {
  if (ENGINE === "tibero") return !!process.env.TIBERO_ODBC_DSN;
  return !!(ENGINE && process.env.DB_HOST && process.env.DB_NAME);
}

function getEngine() { return ENGINE; }

// Lazy pool creation — created on first query.
let _pool = null;
let _odbc = null;

async function getPool() {
  if (_pool) return _pool;

  const host     = process.env.DB_HOST || "localhost";
  const port     = parseInt(process.env.DB_PORT || "0", 10);
  const user     = process.env.DB_USER || "";
  const password = process.env.DB_PASSWORD || "";
  const database = process.env.DB_NAME || "";

  if (ENGINE === "pg") {
    const { Pool } = require("pg");
    _pool = new Pool({ host, port: port || 5432, user, password, database, max: 3 });
    return _pool;
  }

  if (ENGINE === "mariadb") {
    const mysql = require("mysql2/promise");
    _pool = mysql.createPool({ host, port: port || 3306, user, password, database, connectionLimit: 3 });
    return _pool;
  }

  if (ENGINE === "tibero") {
    const odbc = require("odbc");
    _odbc = odbc;
    return null;
  }

  throw new Error(`지원하지 않는 DB_ENGINE: ${ENGINE}`);
}

// Execute a query and return rows array.
async function query(sql, params = []) {
  if (!isConfigured()) throw new Error("DB 연결 정보가 설정되지 않았습니다.");

  if (ENGINE === "tibero") {
    const odbc = require("odbc");
    const conn = await odbc.connect(`DSN=${process.env.TIBERO_ODBC_DSN}`);
    try {
      const result = await conn.query(sql, params);
      return Array.from(result);
    } finally {
      await conn.close();
    }
  }

  const pool = await getPool();

  if (ENGINE === "pg") {
    const { rows } = await pool.query(sql, params);
    return rows;
  }

  if (ENGINE === "mariadb") {
    const [rows] = await pool.execute(sql, params);
    return rows;
  }
}

// Release pool on process exit.
async function close() {
  if (_pool && ENGINE === "pg")      await _pool.end().catch(() => {});
  if (_pool && ENGINE === "mariadb") await _pool.end().catch(() => {});
  _pool = null;
}

module.exports = { isConfigured, getEngine, query, close };
