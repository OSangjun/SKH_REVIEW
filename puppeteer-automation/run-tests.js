#!/usr/bin/env node
"use strict";

/**
 * run-tests.js — CLI test runner for Browser Automation Tool
 *
 * Usage:
 *   node run-tests.js --all
 *   node run-tests.js --ids 1,2,3 --speed 2 --junit report.xml
 *   node run-tests.js --id 1 --verbose
 *   BASE_URL=https://staging.example.com node run-tests.js --all
 *
 * Exit codes:
 *   0  All tests passed (or no responses to compare)
 *   1  One or more tests failed
 *   2  Fatal error (DB not found, browser launch failure, etc.)
 */

require("dotenv").config();
const puppeteer = require("puppeteer-core");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

// ── Config ────────────────────────────────────────────────────────────────────

const CHROME_PATH =
  process.env.CHROME_PATH ||
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const VIEWPORT = { width: 1920, height: 1080 };
const DB_PATH = path.join(__dirname, "recordings.db");
const NETWORK_EVTS = new Set(["navigate", "click", "dblclick"]);
const NO_DELAY_EVTS = new Set([
  "keydown",
  "keyup",
  "input",
  "scroll",
  "wheel",
  "contenteditable",
]);

// ── ANSI colors (auto-disabled if not a TTY) ──────────────────────────────────

const COLOR = process.stdout.isTTY;
const C = {
  reset: COLOR ? "\x1b[0m" : "",
  bold: COLOR ? "\x1b[1m" : "",
  dim: COLOR ? "\x1b[2m" : "",
  green: COLOR ? "\x1b[32m" : "",
  red: COLOR ? "\x1b[31m" : "",
  yellow: COLOR ? "\x1b[33m" : "",
  cyan: COLOR ? "\x1b[36m" : "",
};

// ── CLI argument parsing ───────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    ids: [],
    all: false,
    list: false,
    speed: 1.0,
    timeout: 5000,
    output: null, // JSON report path
    junit: null, // JUnit XML report path
    baseUrl: null, // replace origin of all URLs
    cookies: [], // raw --cookie strings
    cookieFile: null, // --cookie-file path
    verbose: false,
    fast: false, // CI mode: skip user think-time, shorten idle waits
    ignoreHosts: [], // additional hosts excluded from response comparison
    ignoreUrlPatterns: [], // additional URL regex patterns excluded
    bodyIgnore: [], // additional JSON path regex patterns ignored in body diff
    stripParams: [], // additional query param names to strip when comparing URLs
    retry: 0, // number of times to retry a failed test before reporting fail
    parallel: 1, // number of parallel browser contexts for execution
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--id":
        opts.ids.push(+args[++i]);
        break;
      case "--ids":
        args[++i].split(",").forEach((x) => opts.ids.push(+x.trim()));
        break;
      case "--all":
        opts.all = true;
        break;
      case "--list":
        opts.list = true;
        break;
      case "--speed":
        opts.speed = parseFloat(args[++i]);
        break;
      case "--timeout":
        opts.timeout = +args[++i];
        break;
      case "--output":
        opts.output = args[++i];
        break;
      case "--junit":
        opts.junit = args[++i];
        break;
      case "--base-url":
        opts.baseUrl = args[++i];
        break;
      case "--cookie":
        opts.cookies.push(args[++i]);
        break;
      case "--cookie-file":
        opts.cookieFile = args[++i];
        break;
      case "--verbose":
        opts.verbose = true;
        break;
      case "-v":
        opts.verbose = true;
        break;
      case "--fast":
        opts.fast = true;
        break;
      case "--ignore-host":
        opts.ignoreHosts.push(args[++i]);
        break;
      case "--ignore-url":
        opts.ignoreUrlPatterns.push(new RegExp(args[++i]));
        break;
      case "--ignore-body":
        opts.bodyIgnore.push(new RegExp(args[++i]));
        break;
      case "--strip-param":
        opts.stripParams.push(args[++i]);
        break;
      case "--retry":
        opts.retry = +args[++i];
        break;
      case "--parallel":
        opts.parallel = +args[++i];
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${a}  (--help for usage)`);
        process.exit(2);
    }
  }
  if (opts.speed <= 0 || !isFinite(opts.speed)) {
    console.error(
      `${C.red}Error:${C.reset} --speed must be a positive number (got ${opts.speed})`,
    );
    process.exit(2);
  }
  if (opts.timeout <= 0 || !Number.isInteger(opts.timeout)) {
    console.error(
      `${C.red}Error:${C.reset} --timeout must be a positive integer ms value (got ${opts.timeout})`,
    );
    process.exit(2);
  }
  return opts;
}

function printHelp() {
  console.log(`
${C.bold}Browser Automation Test Runner${C.reset}

${C.bold}Usage:${C.reset}
  node run-tests.js [options]

${C.bold}Target selection:${C.reset}
  --all                    Run all recordings
  --id <n>                 Run a single recording by ID
  --ids <n,n,n>            Run specific recordings (comma-separated IDs)
  --list                   List available recordings and exit

${C.bold}Replay options:${C.reset}
  --speed <n>              Replay speed multiplier (default: 1.0)
  --fast                   CI mode: skip recorded user think-time, use
                           domcontentloaded for navigations, idleTime 200ms.
                           Use this in CI/CD pipelines.
  --timeout <ms>           Network idle timeout in ms (default: 5000)

${C.bold}Comparison filters (in addition to built-in defaults):${C.reset}
  --ignore-host <host>     Exclude responses to this host from comparison.
                           Built-in: google-analytics, gtm, doubleclick, fb,
                           hotjar, segment, mixpanel, amplitude, sentry, etc.
  --ignore-url <regex>     Exclude responses matching this URL regex.
                           Built-in: anti-bot uniqueness probes, cache-bust
                           query params (?_t=, ?nonce=, ...).
  --ignore-body <regex>    Skip JSON body paths matching this regex during
                           diff. Built-in: CurrentTime, sessionId, csrfToken,
                           nonce, traceId, ETag, etc. (case-insensitive).
  --strip-param <name>     Strip this query param from URLs before matching.
                           Built-in: _ _t _ts nonce cb cachebust timestamp.
                           Use for site-specific tokens like
                           --strip-param netfunnelKeyString.

${C.bold}Reliability / performance:${C.reset}
  --retry <n>              Re-run a failing test up to <n> times. Reports as
                           PASS if any retry passes (with a "(flaky)" tag).
  --parallel <n>           Run up to <n> tests concurrently in separate
                           browser contexts. Disables page reuse — each test
                           starts in a fresh context. Default 1 (serial).
  --base-url <url>         Replace origin of all URLs (for environment switching)
                           e.g. --base-url https://staging.example.com

${C.bold}Cookie options (override recording cookies, higher priority):${C.reset}
  --cookie <spec>          Add a cookie. Format:
                             name=value
                             name=value;domain=.example.com;path=/;secure;httpOnly
                           Repeat for multiple cookies.
  --cookie-file <path>     Load cookies from a JSON file (array of cookie objects).
                           JSON format: [{"name":"...","value":"...","domain":"..."}]

${C.bold}Output:${C.reset}
  --output <file>          Write JSON report to file
  --junit <file>           Write JUnit XML report to file (for CI systems)
  --verbose, -v            Show event-level detail during replay

${C.bold}Environment variables:${C.reset}
  CHROME_PATH              Chrome/Chromium executable path
  BASE_URL                 Same as --base-url

${C.bold}Exit codes:${C.reset}
  0   All tests passed (or no responses recorded to compare)
  1   One or more tests failed
  2   Fatal error (DB not found, browser error, etc.)

${C.bold}Examples:${C.reset}
  node run-tests.js --all
  node run-tests.js --ids 1,2,3 --speed 2 --junit report.xml
  node run-tests.js --id 1 --verbose
  node run-tests.js --all --cookie "session_id=abc123;domain=.example.com;secure"
  node run-tests.js --all --cookie "auth=tok1" --cookie "pref=dark"
  node run-tests.js --all --cookie-file ./cookies.json
  BASE_URL=https://staging.example.com node run-tests.js --all --output results.json
`);
}

// ── Database helpers ───────────────────────────────────────────────────────────

function openDb() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Full schema — idempotent on an existing DB
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

  // Safe column migrations — silently ignored if column already exists
  for (const col of [
    `ALTER TABLE recordings ADD COLUMN responses   TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE recordings ADD COLUMN description TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE recordings ADD COLUMN tags        TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE recordings ADD COLUMN cookies     TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE recordings ADD COLUMN toasts      TEXT NOT NULL DEFAULT '[]'`,
  ]) {
    try {
      db.exec(col);
    } catch {}
  }

  return db;
}

function fetchRecordings(db, opts) {
  if (opts.all) {
    return db
      .prepare(
        `SELECT id, name, url, event_count AS eventCount, created_at AS createdAt,
              description, events, responses, cookies, toasts
       FROM recordings ORDER BY id`,
      )
      .all();
  }
  const ph = opts.ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id, name, url, event_count AS eventCount, created_at AS createdAt,
            description, events, responses, cookies, toasts
     FROM recordings WHERE id IN (${ph}) ORDER BY id`,
    )
    .all(...opts.ids);
}

function listRecordings(db) {
  const rows = db
    .prepare(
      `SELECT id, name, url, event_count AS eventCount, created_at AS createdAt, description
     FROM recordings ORDER BY id`,
    )
    .all();

  if (rows.length === 0) {
    console.log("No recordings found.");
    return;
  }

  const fmt = (iso) => {
    try {
      return new Date(iso).toLocaleString("ko-KR");
    } catch {
      return iso;
    }
  };
  const pad = (s, n) => String(s).padEnd(n);

  console.log(
    `\n${C.bold}${pad("ID", 4)}${pad("Name", 24)}${pad("Events", 8)}${pad("Created", 22)}URL${C.reset}`,
  );
  console.log("─".repeat(90));
  for (const r of rows) {
    const desc = r.description ? `  ${C.dim}${r.description}${C.reset}` : "";
    console.log(
      `${pad(r.id, 4)}${pad(r.name, 24)}${pad(r.eventCount, 8)}${pad(fmt(r.createdAt), 22)}${r.url}${desc}`,
    );
  }
  console.log();
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

/**
 * Parse a --cookie argument string into a Puppeteer cookie object.
 *
 * Format: "name=value[;domain=X][;path=/][;secure][;httpOnly][;sameSite=Lax]"
 *
 * Cookie values that contain literal semicolons must be percent-encoded (%3B).
 * Attribute parsing starts at the FIRST token whose key matches a known
 * attribute name, so unknown tokens (e.g. an encoded value fragment) are skipped.
 */
function parseCookieArg(raw) {
  const ATTRS = new Set([
    "domain",
    "path",
    "secure",
    "httponly",
    "samesite",
    "expires",
    "max-age",
  ]);

  // Split on semicolons, keeping track of where the name=value ends and
  // attributes begin (first token that looks like a known attribute).
  const tokens = raw
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);

  const eqIdx = tokens[0].indexOf("=");
  if (eqIdx < 0) {
    console.error(`${C.red}Error:${C.reset} Invalid cookie format: "${raw}"`);
    console.error("  Expected: name=value[;domain=X;path=/;secure;httpOnly]");
    process.exit(2);
  }
  const name = tokens[0].slice(0, eqIdx).trim();
  if (!name) {
    console.error(`${C.red}Error:${C.reset} Cookie name is empty in: "${raw}"`);
    process.exit(2);
  }

  // Find where the attribute list starts (first token that is a known attr key)
  let attrStart = tokens.length;
  for (let i = 1; i < tokens.length; i++) {
    const key = (
      tokens[i].indexOf("=") >= 0
        ? tokens[i].slice(0, tokens[i].indexOf("="))
        : tokens[i]
    )
      .trim()
      .toLowerCase();
    if (ATTRS.has(key)) {
      attrStart = i;
      break;
    }
  }

  // Everything between tokens[0] key and the first attribute is part of the value
  const valueParts = [
    tokens[0].slice(eqIdx + 1),
    ...tokens.slice(1, attrStart),
  ];
  const value = decodeURIComponent(valueParts.join(";"));

  const cookie = { name, value };
  for (const token of tokens.slice(attrStart)) {
    const ei = token.indexOf("=");
    const key = (ei < 0 ? token : token.slice(0, ei)).trim().toLowerCase();
    const val = ei < 0 ? undefined : token.slice(ei + 1).trim();
    switch (key) {
      case "domain":
        cookie.domain = val;
        break;
      case "path":
        cookie.path = val;
        break;
      case "secure":
        cookie.secure = true;
        break;
      case "httponly":
        cookie.httpOnly = true;
        break;
      case "samesite":
        cookie.sameSite = val;
        break;
    }
  }
  return cookie;
}

/**
 * Load cookies from a JSON file.
 * File must contain a JSON array of cookie objects with at least name+value.
 */
function loadCookieFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    console.error(`${C.red}Error:${C.reset} Cookie file not found: ${abs}`);
    process.exit(2);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
    return parsed.filter((c) => c && c.name && c.value !== undefined);
  } catch (err) {
    console.error(
      `${C.red}Error:${C.reset} Failed to read cookie file: ${err.message}`,
    );
    process.exit(2);
  }
}

/**
 * Merge recording cookies with CLI cookies.
 * CLI cookies take precedence: if the same name exists in both, CLI wins.
 */
function mergeCookies(recordingCookies, cliCookies) {
  if (cliCookies.length === 0) return recordingCookies;
  const map = new Map();
  for (const c of recordingCookies) map.set(c.name, c);
  for (const c of cliCookies) map.set(c.name, c); // overrides by name
  return [...map.values()];
}

// ── Replay utilities ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tryJson = (s, d) => {
  try {
    return JSON.parse(s);
  } catch {
    return d;
  }
};

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.search = "";
    return u.toString();
  } catch {
    return url;
  }
}

function applyBaseUrl(url, baseUrl) {
  if (!baseUrl) return url;
  try {
    const u = new URL(url);
    const b = new URL(baseUrl);
    u.protocol = b.protocol;
    u.host = b.host;
    return u.toString();
  } catch {
    return url;
  }
}

function isApiResponse(response) {
  const t = response.request().resourceType();
  return t === "xhr" || t === "fetch";
}

// Built-in blocklist: third-party trackers + common anti-bot/CDN endpoints.
// Responses to these hosts are excluded from comparison (still captured for
// reference). Match is "host ends with" — covers subdomains.
const DEFAULT_HOST_BLOCKLIST = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "googlesyndication.com",
  "facebook.com",
  "facebook.net",
  "connect.facebook.net",
  "hotjar.com",
  "segment.com",
  "segment.io",
  "mixpanel.com",
  "amplitude.com",
  "branch.io",
  "fullstory.com",
  "tealium.com",
  "tealiumiq.com",
  "newrelic.com",
  "nr-data.net",
  "sentry.io",
  "datadoghq.com",
  "cloudflare.com",
  "cloudflareinsights.com",
];

// URL patterns that always vary (anti-bot challenges, fingerprinting probes).
// Match is regex on the full URL.
const DEFAULT_URL_BLOCKLIST = [
  /\/uniqueness\.[^/]+\/.+/,           // anti-bot fingerprinting
];

// Query parameter names to strip when canonicalizing URLs for comparison.
// These are cache-busters / timestamps / nonces that vary every request but
// don't change which endpoint is being called.
const CACHE_BUST_PARAMS = new Set([
  "_", "_t", "_ts", "_=", "nonce", "cb", "cachebust", "timestamp", "v", "version",
]);

// Canonicalize a URL for comparison: strip query params that are pure
// cache-busters/nonces so the same logical endpoint matches between
// recording and replay. Extra param names (per-project tokens like
// `netfunnelKeyString`, `csrfToken`, `xsrf`) can be added via `extraStrip`.
function canonicalUrl(url, extraStrip = []) {
  try {
    const u = new URL(url);
    const strip = new Set([...CACHE_BUST_PARAMS, ...extraStrip]);
    const keep = [];
    u.searchParams.forEach((value, key) => {
      if (!strip.has(key)) keep.push([key, value]);
    });
    u.search = "";
    for (const [k, v] of keep) u.searchParams.append(k, v);
    return u.toString();
  } catch {
    return url;
  }
}

// JSON body paths to ignore when diffing — matched against the slash-joined
// path from jsonDiff (e.g. "root.CurrentTime"). Catches the most common
// volatile fields that always differ between recording and replay.
const DEFAULT_BODY_IGNORE = [
  /\.(CurrentTime|currentTime|timestamp|requestId|requestTime|sessionId|UserSessionId|csrfToken|csrf|nonce|traceId|spanId|correlationId|ETag)$/i,
];

function isBlockedUrl(url, extraHosts = [], extraUrlPatterns = []) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  const host = parsed.host;
  for (const h of [...DEFAULT_HOST_BLOCKLIST, ...extraHosts]) {
    if (host === h || host.endsWith("." + h)) return true;
  }
  for (const re of [...DEFAULT_URL_BLOCKLIST, ...extraUrlPatterns]) {
    if (re.test(url)) return true;
  }
  return false;
}

function isIgnoredBodyPath(path, extraPatterns = []) {
  for (const re of [...DEFAULT_BODY_IGNORE, ...extraPatterns]) {
    if (re.test(path)) return true;
  }
  return false;
}

// Page-key for URL grouping: origin + pathname (ignore query / hash)
function pageKey(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

// Group recordings by page URL, preserving original order both across groups
// (by first occurrence) and within each group.
function groupByPage(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = pageKey(r.url);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return groups;
}

// Group responses by canonicalized URL (cache-buster params stripped, full
// query otherwise). Same URL called N times in a row keeps N entries so
// positional pairing can compare each occurrence.
function buildResponseMap(responses, stripParams = []) {
  const map = new Map();
  for (const r of responses) {
    const key = canonicalUrl(r.url, stripParams);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

const MAX_DIFFS = 10;
function jsonDiff(expected, actual, path = "root", bodyIgnore = []) {
  if (isIgnoredBodyPath(path, bodyIgnore)) return [];
  if (typeof expected !== typeof actual)
    return [`${path}: type changed (${typeof expected} → ${typeof actual})`];
  if (expected === null || actual === null)
    return expected !== actual ? [`${path}: null mismatch`] : [];
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const diffs = [];
    if (expected.length !== actual.length)
      diffs.push(
        `${path}[]: length changed (${expected.length} → ${actual.length})`,
      );
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) {
      diffs.push(...jsonDiff(expected[i], actual[i], `${path}[${i}]`, bodyIgnore));
      if (diffs.length >= MAX_DIFFS) break;
    }
    return diffs.slice(0, MAX_DIFFS);
  }
  if (typeof expected === "object") {
    const diffs = [];
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of keys) {
      const childPath = `${path}.${k}`;
      if (isIgnoredBodyPath(childPath, bodyIgnore)) continue;
      if (!(k in expected)) {
        diffs.push(`${childPath}: key added`);
        continue;
      }
      if (!(k in actual)) {
        diffs.push(`${childPath}: key removed`);
        continue;
      }
      diffs.push(...jsonDiff(expected[k], actual[k], childPath, bodyIgnore));
      if (diffs.length >= MAX_DIFFS) break;
    }
    return diffs.slice(0, MAX_DIFFS);
  }
  return expected !== actual
    ? [`${path}: ${JSON.stringify(expected)} → ${JSON.stringify(actual)}`]
    : [];
}

function compareResponses(recorded, actual, opts = {}) {
  const ignoreHosts = opts.ignoreHosts ?? [];
  const ignoreUrlPatterns = opts.ignoreUrlPatterns ?? [];
  const bodyIgnore = opts.bodyIgnore ?? [];
  const stripParams = opts.stripParams ?? [];

  const recMap = buildResponseMap(recorded, stripParams);
  const actMap = buildResponseMap(actual, stripParams);

  const results = [];
  // Iterate over recorded URLs — pair each occurrence positionally with the
  // actual responses for the same full URL. Missing actuals are reported as
  // failures; extras (not in recording) are ignored. URLs that match the
  // host/url blocklist are skipped (third-party trackers, anti-bot probes).
  for (const [url, recList] of recMap) {
    if (isBlockedUrl(url, ignoreHosts, ignoreUrlPatterns)) continue;
    const actList = actMap.get(url) ?? [];
    for (let i = 0; i < recList.length; i++) {
      const rec = recList[i];
      const act = actList[i];

      if (!act) {
        results.push({
          url: rec.url,
          expectedStatus: rec.status,
          actualStatus: "-",
          statusPass: false,
          bodyPass: false,
          bodyDiffs: ["response not seen in replay"],
          pass: false,
        });
        continue;
      }

      const statusPass = rec.status === act.status;
      let bodyPass = true,
        bodyDiffs = [];
      if (rec.body !== null) {
        if (act.body === null) {
          bodyPass = false;
          bodyDiffs = ["body capture failed (no response body in replay)"];
        } else {
          try {
            bodyDiffs = jsonDiff(JSON.parse(rec.body), JSON.parse(act.body), "root", bodyIgnore);
            bodyPass = bodyDiffs.length === 0;
          } catch {
            bodyPass = rec.body === act.body;
            if (!bodyPass) bodyDiffs = ["body text mismatch"];
          }
        }
      }
      // Compare request body (POST/PUT/PATCH payloads) — only when both sides
      // recorded one. Recordings made before this feature have no `reqBody`.
      let reqBodyPass = true;
      let reqBodyDiffs = [];
      if (rec.reqBody != null && act.reqBody != null) {
        try {
          reqBodyDiffs = jsonDiff(JSON.parse(rec.reqBody), JSON.parse(act.reqBody), "reqBody", bodyIgnore);
          reqBodyPass = reqBodyDiffs.length === 0;
        } catch {
          reqBodyPass = rec.reqBody === act.reqBody;
          if (!reqBodyPass) reqBodyDiffs = ["request body text mismatch"];
        }
      }
      results.push({
        url: rec.url,
        expectedStatus: rec.status,
        actualStatus: act.status,
        statusPass,
        bodyPass,
        bodyDiffs: [...bodyDiffs, ...reqBodyDiffs],
        pass: statusPass && bodyPass && reqBodyPass,
      });
    }
  }
  return results;
}

function compareToasts(recorded, actual) {
  const actSet = new Set(
    actual.map((t) => (typeof t === "string" ? t : t.text).trim()),
  );
  return recorded.map((r) => {
    const text = (typeof r === "string" ? r : r.text).trim();
    return { text, pass: actSet.has(text) };
  });
}

function isNetworkTrigger(ev) {
  return (
    ["click", "dblclick", "navigate", "check", "select"].includes(ev.type) ||
    (ev.type === "keydown" && (ev.key === "Enter" || ev.code === "Enter"))
  );
}

function compareTriggerMappings(events, replayTriggerMap) {
  const results = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!Array.isArray(ev.triggeredUrls) || ev.triggeredUrls.length === 0)
      continue;
    const actual = (replayTriggerMap.get(i) || []).map(normalizeUrl);
    const label =
      ev.label ||
      ev.selector ||
      (ev.type === "keydown"
        ? `키[${ev.key}]`
        : `(${ev.x ?? ""},${ev.y ?? ""})`);
    for (const url of ev.triggeredUrls) {
      results.push({
        eventType: ev.type,
        eventLabel: label,
        url,
        pass: actual.includes(normalizeUrl(url)),
      });
    }
  }
  return results;
}

const TOAST_OBSERVER_SCRIPT = `(function() {
  if (window.__CDP_TOAST_OBSERVER__) return;
  window.__CDP_TOAST_OBSERVER__ = true;
  var seen = new WeakSet();
  var obs  = new MutationObserver(function(muts) {
    for (var i = 0; i < muts.length; i++) {
      var added = muts[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var node = added[j];
        if (node.nodeType !== 1) continue;
        var els = (node.matches && node.matches('[role="alert"],[role="status"]'))
          ? [node]
          : (node.querySelectorAll
              ? Array.prototype.slice.call(node.querySelectorAll('[role="alert"],[role="status"]'))
              : []);
        for (var k = 0; k < els.length; k++) {
          var el = els[k];
          if (seen.has(el)) continue;
          seen.add(el);
          var text = (el.innerText || el.textContent || '').trim();
          if (text && window.__captureToast) window.__captureToast(text);
        }
      }
    }
  });
  function start() {
    if (document.body) obs.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();`;

async function waitNetworkIdle(page, timeout, idleTime = 500) {
  try {
    await page.waitForNetworkIdle({ idleTime, timeout });
  } catch {}
}

const BTN = (b) =>
  b === "right" ? "right" : b === "middle" ? "middle" : "left";

// Run a DOM assertion event. Returns { pass, message }.
// Supported event types:
//   assert-text     {selector, expected, mode: 'equals'|'contains'|'regex'}
//   assert-visible  {selector, expected: true|false}
//   assert-attr     {selector, attr, expected, mode?: 'equals'|'contains'|'regex'}
//   assert-count    {selector, expected, op?: 'eq'|'gte'|'lte'}
async function runAssertion(page, ev, timeout = 5000) {
  const label = ev.label || ev.selector || ev.type;
  try {
    switch (ev.type) {
      case "assert-text": {
        await page.waitForSelector(ev.selector, { timeout, visible: true }).catch(() => {});
        const actual = await page.$eval(ev.selector, (e) =>
          (e.innerText || e.textContent || "").trim()
        ).catch(() => null);
        if (actual === null) return { type: ev.type, label, pass: false, message: `selector not found: ${ev.selector}` };
        const mode = ev.mode || "contains";
        const ok =
          mode === "equals" ? actual === ev.expected :
          mode === "regex"  ? new RegExp(ev.expected).test(actual) :
                              actual.includes(ev.expected);
        return { type: ev.type, label, pass: ok, expected: ev.expected, actual,
                 message: ok ? null : `text ${mode} "${ev.expected}" — got "${actual.slice(0, 80)}"` };
      }
      case "assert-visible": {
        const want = ev.expected !== false;
        if (want) {
          await page.waitForSelector(ev.selector, { timeout, visible: true }).catch(() => {});
        }
        const visible = await page.$eval(ev.selector, (e) => {
          const r = e.getBoundingClientRect();
          const s = window.getComputedStyle(e);
          return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
        }).catch(() => false);
        const ok = visible === want;
        return { type: ev.type, label, pass: ok, expected: want, actual: visible,
                 message: ok ? null : `expected ${want ? "visible" : "hidden"}, got ${visible ? "visible" : "hidden"}` };
      }
      case "assert-attr": {
        await page.waitForSelector(ev.selector, { timeout }).catch(() => {});
        const actual = await page.$eval(ev.selector, (e, attr) => e.getAttribute(attr), ev.attr).catch(() => null);
        const mode = ev.mode || "equals";
        const ok =
          mode === "equals" ? actual === ev.expected :
          mode === "regex"  ? actual !== null && new RegExp(ev.expected).test(actual) :
                              actual !== null && actual.includes(ev.expected);
        return { type: ev.type, label, pass: ok, expected: ev.expected, actual,
                 message: ok ? null : `attr ${ev.attr} ${mode} "${ev.expected}" — got "${actual}"` };
      }
      case "assert-count": {
        const op = ev.op || "eq";
        const actual = await page.$$eval(ev.selector, (els) => els.length).catch(() => 0);
        const ok =
          op === "eq"  ? actual === ev.expected :
          op === "gte" ? actual >= ev.expected :
          op === "lte" ? actual <= ev.expected :
                          false;
        return { type: ev.type, label, pass: ok, expected: ev.expected, actual,
                 message: ok ? null : `count ${op} ${ev.expected} — got ${actual}` };
      }
    }
  } catch (err) {
    return { type: ev.type, label, pass: false, message: `assertion error: ${err.message}` };
  }
  return null;
}

// State-based wait events (alternative to time-based sleep):
//   wait-for-selector  {selector, visible?: bool, timeout?}
//   wait-for-text      {selector, expected, timeout?}
//   wait-for-function  {expr, timeout?}  // page-evaluated boolean expression
// Compare two PNG buffers — exact byte equality is too strict (browsers
// vary subtly), so we compare image dimensions + the proportion of differing
// bytes. Returns { pass, sizeMatch, diffRatio } where diffRatio is roughly
// the fraction of bytes that differ in raw PNG (not perfect, but a useful
// "did the screenshot change a lot?" signal without an image lib).
function comparePngBuffers(a, b, threshold = 0.05) {
  if (!a || !b) return { pass: false, message: "missing buffer" };
  if (a.length === 0 || b.length === 0) return { pass: false, message: "empty buffer" };
  // Compare PNG IHDR (bytes 16..24) for width/height/bit depth equality
  const sizeMatch = a.length >= 24 && b.length >= 24 &&
    a.slice(16, 24).equals(b.slice(16, 24));
  if (!sizeMatch) return { pass: false, message: `dimensions differ` };
  // Count differing bytes after the header (compressed payload — sensitive
  // to small visual changes but tolerant of identical renders).
  const len = Math.min(a.length, b.length);
  let diff = 0;
  for (let i = 24; i < len; i++) if (a[i] !== b[i]) diff++;
  const ratio = diff / Math.max(1, len - 24);
  return { pass: ratio <= threshold, diffRatio: ratio,
           message: ratio <= threshold ? null : `pixel diff ratio ${(ratio*100).toFixed(1)}% > ${(threshold*100).toFixed(1)}%` };
}

async function runWait(page, ev, defaultTimeout = 5000) {
  const timeout = ev.timeout ?? defaultTimeout;
  try {
    if (ev.type === "wait-for-selector") {
      await page.waitForSelector(ev.selector, { timeout, visible: ev.visible !== false });
      return { pass: true };
    }
    if (ev.type === "wait-for-text") {
      await page.waitForFunction(
        (sel, exp) => {
          const e = document.querySelector(sel);
          return !!e && (e.innerText || e.textContent || "").includes(exp);
        },
        { timeout },
        ev.selector,
        ev.expected,
      );
      return { pass: true };
    }
    if (ev.type === "wait-for-function") {
      await page.waitForFunction(ev.expr, { timeout });
      return { pass: true };
    }
  } catch (err) {
    return { pass: false, message: `wait timed out (${timeout}ms): ${err.message}` };
  }
  return { pass: true };
}

const ASSERT_TYPES = new Set([
  "assert-text", "assert-visible", "assert-attr", "assert-count", "assert-screenshot",
]);
const WAIT_TYPES = new Set(["wait-for-selector", "wait-for-text", "wait-for-function"]);

// Take a screenshot of `selector` (or full page if absent) and compare
// against the recorded base64 PNG. Threshold default 5% byte diff.
async function runScreenshotAssert(page, ev) {
  const selector = ev.selector;
  const expectedB64 = ev.expected;
  if (!expectedB64) return { type: ev.type, label: ev.label || "screenshot",
                              pass: false, message: "no recorded screenshot" };
  let actualBuf;
  try {
    if (selector) {
      const el = await page.$(selector);
      if (!el) return { type: ev.type, label: selector, pass: false,
                        message: `selector not found: ${selector}` };
      actualBuf = await el.screenshot({ type: "png" });
    } else {
      actualBuf = await page.screenshot({ type: "png", fullPage: false });
    }
  } catch (err) {
    return { type: ev.type, label: ev.label || "screenshot", pass: false,
             message: `screenshot failed: ${err.message}` };
  }
  const expectedBuf = Buffer.from(expectedB64, "base64");
  const cmp = comparePngBuffers(expectedBuf, actualBuf, ev.threshold ?? 0.05);
  return {
    type: ev.type,
    label: ev.label || selector || "fullpage",
    pass: cmp.pass,
    message: cmp.message,
  };
}

// Pick the element matching `selector` whose visible text equals `label`,
// falling back to the first match if none of them match the label. This
// disambiguates class-only selectors like `button.btn-quick` that match
// many elements during a recording.
//
// The match traverses Shadow DOM (recursively into open shadow roots) and
// child iframes, so components built on web components (Vaadin, Lit, etc.)
// and pages with embedded iframes work as expected.
async function pickByLabelOrFirst(page, selector, label) {
  // 1. Main frame with Shadow DOM piercing
  try {
    const handle = await page.evaluateHandle(
      (sel, lbl) => {
        function collect(root, out) {
          try {
            const direct = root.querySelectorAll(sel);
            for (const e of direct) out.push(e);
          } catch {}
          const all = root.querySelectorAll("*");
          for (const el of all) {
            if (el.shadowRoot) collect(el.shadowRoot, out);
          }
        }
        const all = [];
        collect(document, all);
        if (all.length === 0) return null;
        if (all.length === 1 || !lbl) return all[0];
        for (const e of all) {
          const txt = (e.innerText || e.textContent || "").trim();
          if (txt === lbl) return e;
        }
        return all[0];
      },
      selector,
      label,
    );
    const el = handle.asElement();
    if (el) {
      const isNull = await el.evaluate((n) => n === null).catch(() => false);
      if (!isNull) return el;
    }
    await handle.dispose().catch(() => {});
  } catch {}

  // 2. Child frames (iframes)
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const handles = await frame.$$(selector);
      if (handles.length === 0) continue;
      if (handles.length === 1 || !label) return handles[0];
      for (const h of handles) {
        const txt = await h.evaluate((e) => (e.innerText || "").trim());
        if (txt === label) return h;
      }
      return handles[0];
    } catch {}
  }
  return null;
}

// If the target element exists in DOM but is currently hidden (typical of
// hover-revealed dropdown menus on Korean gov/edu sites), find the closest
// ancestor that *is* visible and likely a menu trigger (aria-haspopup, has
// hidden submenu children, or is a top-level nav item) and hover it.
// Returns true if a hover was performed.
async function tryHoverAncestorTrigger(page, selector) {
  const triggerInfo = await page.evaluate((sel) => {
    const target = document.querySelector(sel);
    if (!target) return null;
    const visible = (() => {
      const r = target.getBoundingClientRect();
      const s = window.getComputedStyle(target);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    })();
    if (visible) return null;
    let cur = target.parentElement;
    while (cur && cur !== document.body) {
      const r = cur.getBoundingClientRect();
      const s = window.getComputedStyle(cur);
      const isVisible = r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      if (isVisible) {
        const haspopup = cur.getAttribute("aria-haspopup");
        const cls = (cur.className || "").toString();
        if (haspopup === "true" || haspopup === "menu" ||
            /\b(has-(dropdown|menu|sub)|menu-item|gnb|lnb|nav-item)\b/.test(cls) ||
            cur.querySelector(":scope > ul, :scope > .submenu, :scope > .sub-menu, :scope > [class*='dropdown' i]")) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      cur = cur.parentElement;
    }
    return null;
  }, selector);
  if (!triggerInfo) return false;
  await page.mouse.move(triggerInfo.x, triggerInfo.y);
  // Brief settle so CSS :hover transitions fire and the submenu becomes visible
  await new Promise((r) => setTimeout(r, 150));
  return true;
}

async function dispatchEvent(page, ev, baseUrl, fast = false) {
  switch (ev.type) {
    case "navigate":
      await page.goto(applyBaseUrl(ev.url, baseUrl), {
        waitUntil: fast ? "domcontentloaded" : "networkidle2",
        timeout: 30000,
      });
      break;
    case "click":
      if (ev.selector) {
        try {
          let el = await pickByLabelOrFirst(page, ev.selector, ev.label);
          // Hover-revealed menu items: if the element exists but is hidden,
          // hover an ancestor menu trigger and retry.
          if (el) {
            const visible = await el.evaluate((e) => {
              const r = e.getBoundingClientRect();
              const s = window.getComputedStyle(e);
              return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
            }).catch(() => true);
            if (!visible && await tryHoverAncestorTrigger(page, ev.selector)) {
              el = await pickByLabelOrFirst(page, ev.selector, ev.label);
            }
          }
          if (el) {
            await el.click();
            break;
          }
        } catch {}
      }
      await page.mouse.click(ev.x, ev.y, { button: BTN(ev.button) });
      break;
    case "dblclick":
      if (ev.selector) {
        try {
          const el = await pickByLabelOrFirst(page, ev.selector, ev.label);
          if (el) {
            await el.click({ clickCount: 2 });
            break;
          }
        } catch {}
      }
      await page.mouse.click(ev.x, ev.y, { clickCount: 2 });
      break;
    case "hover":
      if (ev.selector) {
        try {
          const el = await pickByLabelOrFirst(page, ev.selector, ev.label);
          if (el) {
            await el.hover();
            break;
          }
        } catch {}
      }
      if (typeof ev.x === "number" && typeof ev.y === "number")
        await page.mouse.move(ev.x, ev.y);
      break;
    case "wheel":
      await page.mouse.wheel({ deltaX: ev.deltaX, deltaY: ev.deltaY });
      break;
    case "scroll":
      await page.evaluate(
        (x, y) => window.scrollTo(x, y),
        ev.scrollX,
        ev.scrollY,
      );
      break;
    case "keydown":
      await page.keyboard.down(ev.key === " " ? "Space" : ev.key);
      break;
    case "keyup":
      await page.keyboard.up(ev.key === " " ? "Space" : ev.key);
      break;
    case "input":
      if (ev.selector) {
        try {
          const el = await page.$(ev.selector);
          if (el) {
            await el.click({ clickCount: 3 });
            await el.type(ev.value ?? "");
            break;
          }
        } catch {}
      }
      await page.keyboard.down("Control");
      await page.keyboard.press("a");
      await page.keyboard.up("Control");
      await page.keyboard.type(ev.value ?? "");
      break;
    case "select":
      if (ev.selector) {
        try {
          await page.select(ev.selector, ev.value);
          break;
        } catch {}
      }
      await page.evaluate((v) => {
        const el = document.activeElement;
        if (el && el.tagName === "SELECT") {
          el.value = v;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, ev.value);
      break;
    case "check":
      if (ev.selector) {
        try {
          const el = await page.$(ev.selector);
          if (el) {
            const cur = await el.evaluate((n) => n.checked);
            if (cur !== ev.checked) await el.click();
            break;
          }
        } catch {}
      }
      await page.mouse.click(ev.x ?? 0, ev.y ?? 0);
      break;
    case "contenteditable":
      await page.evaluate((h) => {
        if (document.activeElement) document.activeElement.innerHTML = h;
      }, ev.html);
      break;
  }
}

// ── Core replay function ───────────────────────────────────────────────────────

async function replayRecording(session, rec, opts, cliCookies = []) {
  const { page } = session;
  const events = tryJson(rec.events, []);
  const recorded = tryJson(rec.responses, []);
  const recordedToasts = tryJson(rec.toasts, []);
  const cookies = mergeCookies(tryJson(rec.cookies, []), cliCookies);

  // Toast buffer for *this* test — session.__captureToast pushes here
  const replayToasts = [];
  session.toastSink = replayToasts;

  const replayResponses = [];
  const replayResponseUrls = []; // synchronous URL capture for trigger mapping
  const replayTriggerMap = new Map(); // eventIdx → [url, ...]
  const pending = new Set();
  const jsErrors = [];
  const assertResults = []; // {type, label, pass, message, expected?, actual?}
  const waitFailures = []; // explicit wait events that timed out

  const onPageError = (err) => {
    jsErrors.push(err.message);
    if (opts.verbose)
      console.log(`  ${C.red}[JS Error] ${err.message}${C.reset}`);
  };
  page.on("pageerror", onPageError);

  const onResponse = (response) => {
    const url = response.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (!isApiResponse(response)) return;
    replayResponseUrls.push(url); // synchronous — used for trigger mapping
    const ct = (response.headers()["content-type"] || "").toLowerCase();
    const status = response.status();
    const wantBody = /json|text\/plain|xml/.test(ct);
    // Capture request method + body for non-GET requests so POST/PUT payloads
    // can be validated alongside the response.
    const req = response.request();
    const method = req.method();
    const reqBody = method !== "GET" && method !== "HEAD" ? (req.postData() ?? null) : null;

    if (!wantBody) {
      replayResponses.push({ url, status, contentType: ct, body: null, method, reqBody });
      return;
    }
    const p = response
      .buffer()
      .then((buf) => {
        const body = buf.length <= 51200 ? buf.toString("utf8") : null;
        replayResponses.push({ url, status, contentType: ct, body, method, reqBody });
      })
      .catch(() =>
        replayResponses.push({ url, status, contentType: ct, body: null, method, reqBody }),
      )
      .finally(() => pending.delete(p));
    pending.add(p);
  };
  page.on("response", onResponse);

  const startMs = Date.now();
  let error = null;

  try {
    if (cookies.length > 0) await page.setCookie(...cookies);

    const startUrl = applyBaseUrl(rec.url, opts.baseUrl);
    const idleTime = opts.fast ? 200 : 500;
    // Reuse the existing page when its URL already matches the recording's
    // start URL — skip the navigation/refresh between consecutive tests.
    if (page.url() !== startUrl) {
      if (opts.verbose) console.log(`  ${C.dim}Load: ${startUrl}${C.reset}`);
      const waitUntil = opts.fast ? "domcontentloaded" : "networkidle2";
      await page.goto(startUrl, { waitUntil, timeout: 30000 });
      // Fast mode uses domcontentloaded which can resolve before in-flight
      // response bodies are available — wait for network to settle so that
      // r.buffer() inside the response listener succeeds.
      if (opts.fast) await waitNetworkIdle(page, opts.timeout, idleTime);
    } else if (opts.verbose) {
      console.log(`  ${C.dim}Reuse: ${startUrl}${C.reset}`);
    }

    let lastT = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const delay =
        opts.fast || NO_DELAY_EVTS.has(ev.type)
          ? 0
          : Math.max(0, ((ev.t ?? 0) - lastT) / opts.speed);
      if (delay > 0) await sleep(delay);
      lastT = ev.t ?? 0;

      if (opts.verbose) {
        const detail =
          ev.type === "click"
            ? `(${ev.x},${ev.y})`
            : ev.type === "dblclick"
              ? `(${ev.x},${ev.y})`
              : ev.type === "keydown"
                ? ev.key
                : ev.type === "input"
                  ? `"${String(ev.value ?? "").slice(0, 30)}"`
                  : ev.type === "navigate"
                    ? ev.url
                    : "";
        console.log(
          `  ${C.dim}[${ev.type}]${detail ? " " + detail : ""}${C.reset}`,
        );
      }

      // Assertions and explicit waits are handled separately — they don't
      // dispatch DOM events, they just observe page state.
      if (ASSERT_TYPES.has(ev.type)) {
        const r = ev.type === "assert-screenshot"
          ? await runScreenshotAssert(page, ev)
          : await runAssertion(page, ev, opts.timeout);
        if (r) assertResults.push(r);
        continue;
      }
      if (WAIT_TYPES.has(ev.type)) {
        const r = await runWait(page, ev, opts.timeout);
        if (!r.pass) waitFailures.push({ type: ev.type, label: ev.selector || ev.expr, message: r.message });
        continue;
      }

      const isTrigger = isNetworkTrigger(ev);
      const snapLen = isTrigger ? replayResponseUrls.length : -1;

      try {
        await dispatchEvent(page, ev, opts.baseUrl, opts.fast);
      } catch {}

      const needsWait =
        NETWORK_EVTS.has(ev.type) ||
        (ev.type === "keydown" &&
          (ev.key === "Enter" || ev.code === "Enter")) ||
        ev.type === "check" ||
        ev.type === "select";
      if (needsWait) await waitNetworkIdle(page, opts.timeout, idleTime);

      if (isTrigger && snapLen >= 0)
        replayTriggerMap.set(i, replayResponseUrls.slice(snapLen));
    }
  } catch (err) {
    error = err.message;
  } finally {
    page.off("pageerror", onPageError);
    page.off("response", onResponse);
    if (pending.size > 0)
      await Promise.race([Promise.allSettled([...pending]), sleep(2000)]);
    // Page is reused across tests — do not close
  }

  const duration = (Date.now() - startMs) / 1000;
  const compareOpts = {
    ignoreHosts: opts.ignoreHosts,
    ignoreUrlPatterns: opts.ignoreUrlPatterns,
    bodyIgnore: opts.bodyIgnore,
    stripParams: opts.stripParams,
  };
  const results =
    recorded.length > 0 ? compareResponses(recorded, replayResponses, compareOpts) : [];
  const toastResults = compareToasts(recordedToasts, replayToasts);
  const triggerResults = compareTriggerMappings(events, replayTriggerMap);
  const passed = results.filter((r) => r.pass).length;
  const httpFailed = results.filter((r) => !r.pass).length;
  const toastFailed = toastResults.filter((r) => !r.pass).length;
  const triggerFailed = triggerResults.filter((r) => !r.pass).length;
  const assertPassed = assertResults.filter((r) => r.pass).length;
  const assertFailed = assertResults.filter((r) => !r.pass).length;
  const waitFailed = waitFailures.length;
  const failed = httpFailed + toastFailed + triggerFailed + assertFailed + waitFailed + jsErrors.length;
  const total = results.length + toastResults.length + triggerResults.length + assertResults.length;

  return {
    rec,
    results,
    toastResults,
    triggerResults,
    assertResults,
    waitFailures,
    passed: passed + assertPassed,
    failed,
    total,
    duration,
    error,
    jsErrors,
  };
}

// ── Output formatters ─────────────────────────────────────────────────────────

function printConsoleResults(suiteResults) {
  let grandPassed = 0,
    grandFailed = 0;
  let grandRecPass = 0,
    grandRecFail = 0;
  console.log();

  // Group suite results by page URL so the detailed report is URL-segmented
  const groups = new Map();
  for (const s of suiteResults) {
    const k = pageKey(s.rec.url);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }

  for (const [key, groupResults] of groups) {
    console.log(
      `${C.bold}━━ Page: ${key || "(blank)"}${C.reset} ` +
        `${C.dim}(${groupResults.length} recording${groupResults.length === 1 ? "" : "s"})${C.reset}`,
    );
    let pgPass = 0,
      pgFail = 0;

  for (const s of groupResults) {
    const hasJsErr = s.jsErrors && s.jsErrors.length > 0;
    const isErr = !!s.error;
    const isPass = !isErr && s.failed === 0 && !hasJsErr;
    if (isPass) { pgPass++; grandRecPass++; }
    else { pgFail++; grandRecFail++; }

    const noChecks = !isErr && s.total === 0 && !hasJsErr;
    const statusLabel = s.error
      ? `${C.red}✗ ERROR  ${C.reset}`
      : s.failed === 0 && !hasJsErr
        ? (noChecks
            ? `${C.green}✓ PASS*  ${C.reset}` // PASS with no checks
            : `${C.green}✓ PASS   ${C.reset}`)
        : `${C.red}✗ FAIL   ${C.reset}`;

    const timeStr = `${C.dim}(${s.duration.toFixed(1)}s)${C.reset}`;
    console.log(
      `${C.bold}[${statusLabel}${C.bold}]${C.reset} ${C.bold}${s.rec.name}${C.reset} ${timeStr}`,
    );

    if (s.error) {
      console.log(`  ${C.red}Error: ${s.error}${C.reset}`);
    } else {
      const hasToastErr = s.toastResults && s.toastResults.some((r) => !r.pass);
      const hasAsserts = (s.assertResults && s.assertResults.length) ||
                         (s.waitFailures && s.waitFailures.length);
      if (
        s.results.length === 0 &&
        !hasJsErr &&
        !(s.toastResults && s.toastResults.length) &&
        !hasAsserts
      ) {
        console.log(`  ${C.dim}No recorded responses to compare${C.reset}`);
      } else {
        for (const r of s.results) {
          if (r.pass) {
            console.log(
              `  ${C.green}✓${C.reset} ${C.dim}[${r.actualStatus}]${C.reset} ${r.url}`,
            );
          } else {
            console.log(
              `  ${C.red}✗${C.reset} ${C.dim}[${r.actualStatus}]${C.reset} ${r.url}`,
            );
            if (!r.statusPass)
              console.log(
                `    ${C.red}Status: expected ${r.expectedStatus}, got ${r.actualStatus}${C.reset}`,
              );
            for (const d of r.bodyDiffs.slice(0, 3))
              console.log(`    ${C.red}Body diff: ${d}${C.reset}`);
          }
        }
        for (const r of s.toastResults ?? []) {
          if (r.pass)
            console.log(
              `  ${C.green}✓${C.reset} ${C.dim}[Toast]${C.reset} ${r.text}`,
            );
          else
            console.log(
              `  ${C.red}✗${C.reset} ${C.dim}[Toast]${C.reset} "${r.text}" — not seen in replay`,
            );
        }
        for (const r of s.triggerResults ?? []) {
          if (r.pass)
            console.log(
              `  ${C.green}✓${C.reset} ${C.dim}[Trigger:${r.eventType}]${C.reset} ${r.url}`,
            );
          else
            console.log(
              `  ${C.red}✗${C.reset} ${C.dim}[Trigger:${r.eventType}]${C.reset} ${r.url} — not triggered in replay`,
            );
        }
        for (const r of s.assertResults ?? []) {
          const tag = `[${r.type}]`;
          if (r.pass)
            console.log(`  ${C.green}✓${C.reset} ${C.dim}${tag}${C.reset} ${r.label}`);
          else
            console.log(
              `  ${C.red}✗${C.reset} ${C.dim}${tag}${C.reset} ${r.label} — ${r.message}`,
            );
        }
        for (const w of s.waitFailures ?? []) {
          console.log(`  ${C.red}✗${C.reset} ${C.dim}[${w.type}]${C.reset} ${w.label} — ${w.message}`);
        }
      }
      if (hasJsErr) {
        for (const e of s.jsErrors)
          console.log(`  ${C.red}✗ [JS Error] ${e}${C.reset}`);
      }
      grandPassed += s.passed;
      grandFailed += s.failed;
    }
  }

    console.log(
      `  ${C.dim}└─ Page result:${C.reset} ` +
        `${C.green}${pgPass} passed${C.reset}, ` +
        `${C.red}${pgFail} failed${C.reset}`,
    );
    console.log();
  }

  const overallOk = grandRecFail === 0;
  const icon = overallOk ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
  const totalRec = suiteResults.length;
  console.log(
    `${C.bold}${icon} Total:${C.reset}  ` +
      `${C.green}${grandRecPass} passed${C.reset}, ` +
      `${C.red}${grandRecFail} failed${C.reset}  ` +
      `${C.dim}(${totalRec} test case${totalRec === 1 ? "" : "s"} — ` +
      `${grandPassed}/${grandPassed + grandFailed} checks)${C.reset}`,
  );
  console.log();
}

function writeJsonReport(suiteResults, outPath) {
  const report = {
    timestamp: new Date().toISOString(),
    recordings: suiteResults.length,
    passed: suiteResults.filter((s) => !s.error && s.failed === 0).length,
    failed: suiteResults.filter((s) => s.error || s.failed > 0).length,
    suites: suiteResults.map((s) => ({
      id: s.rec.id,
      name: s.rec.name,
      url: s.rec.url,
      duration: s.duration,
      error: s.error ?? null,
      passed: s.passed,
      failed: s.failed,
      total: s.total,
      results: s.results,
    })),
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`${C.cyan}JSON report →${C.reset} ${outPath}`);
}

function writeJunitReport(suiteResults, outPath) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const jsCount = (s) => (s.jsErrors ?? []).length;
  const totalTests = suiteResults.reduce(
    (a, s) => a + Math.max(s.total + jsCount(s), 1),
    0,
  );
  const totalFailures = suiteResults.reduce(
    (a, s) => a + (s.error ? 1 : s.failed),
    0,
  );
  const totalTime = suiteResults.reduce((a, s) => a + s.duration, 0).toFixed(3);

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="Browser Automation Tests" tests="${totalTests}" failures="${totalFailures}" time="${totalTime}">`,
  ];

  for (const s of suiteResults) {
    const suiteTests = Math.max(s.total + jsCount(s), 1);
    const suiteFailures = s.error ? 1 : s.failed;
    lines.push(
      `  <testsuite name="${esc(s.rec.name)}" tests="${suiteTests}" failures="${suiteFailures}" time="${s.duration.toFixed(3)}">`,
    );

    if (s.error) {
      lines.push(
        `    <testcase name="${esc(s.rec.name)}" classname="${esc(s.rec.name)}" time="${s.duration.toFixed(3)}">`,
      );
      lines.push(
        `      <failure message="${esc(s.error)}" type="Error">${esc(s.error)}</failure>`,
      );
      lines.push(`    </testcase>`);
    } else {
      if (s.results.length === 0 && !(s.jsErrors && s.jsErrors.length)) {
        lines.push(
          `    <testcase name="(no responses)" classname="${esc(s.rec.name)}" time="${s.duration.toFixed(3)}"/>`,
        );
      } else {
        for (const r of s.results) {
          lines.push(
            `    <testcase name="${esc(r.url)}" classname="${esc(s.rec.name)}" time="0">`,
          );
          if (!r.pass) {
            const msg = !r.statusPass
              ? `Status: expected ${r.expectedStatus}, got ${r.actualStatus}`
              : (r.bodyDiffs[0] ?? "body mismatch");
            const detail = r.bodyDiffs.join("\n");
            lines.push(
              `      <failure message="${esc(msg)}" type="AssertionError">${esc(detail)}</failure>`,
            );
          }
          lines.push("    </testcase>");
        }
        for (const r of s.toastResults ?? []) {
          if (!r.pass) {
            lines.push(
              `    <testcase name="[Toast] ${esc(r.text.slice(0, 120))}" classname="${esc(s.rec.name)}" time="0">`,
            );
            lines.push(
              `      <failure message="Toast not seen in replay: ${esc(r.text)}" type="ToastMismatch">${esc(r.text)}</failure>`,
            );
            lines.push("    </testcase>");
          }
        }
        for (const r of s.triggerResults ?? []) {
          if (!r.pass) {
            const name = `[Trigger:${r.eventType}] ${r.url.slice(0, 100)}`;
            lines.push(
              `    <testcase name="${esc(name)}" classname="${esc(s.rec.name)}" time="0">`,
            );
            lines.push(
              `      <failure message="URL not triggered in replay: ${esc(r.url)}" type="TriggerMismatch">${esc(r.url)}</failure>`,
            );
            lines.push("    </testcase>");
          }
        }
        for (const e of s.jsErrors ?? []) {
          lines.push(
            `    <testcase name="[JS Error] ${esc(e.slice(0, 120))}" classname="${esc(s.rec.name)}" time="0">`,
          );
          lines.push(
            `      <failure message="${esc(e)}" type="ScriptError">${esc(e)}</failure>`,
          );
          lines.push("    </testcase>");
        }
      }
    }
    lines.push("  </testsuite>");
  }
  lines.push("</testsuites>");

  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  console.log(`${C.cyan}JUnit report →${C.reset} ${outPath}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  // ENV variable fallback for base URL
  if (!opts.baseUrl && process.env.BASE_URL)
    opts.baseUrl = process.env.BASE_URL;

  const db = openDb();

  // --list: just show recordings and exit
  if (opts.list) {
    listRecordings(db);
    process.exit(0);
  }

  if (!opts.all && opts.ids.length === 0) {
    console.error(
      `${C.red}Error:${C.reset} Specify --all, --id <n>, or --ids <n,n,...>`,
    );
    console.error("  Run with --help for usage.");
    process.exit(2);
  }

  const rows = fetchRecordings(db, opts);
  if (rows.length === 0) {
    console.error(`${C.red}Error:${C.reset} No matching recordings found.`);
    process.exit(2);
  }

  // Warn about requested IDs that don't exist in the DB
  if (opts.ids.length > 0) {
    const foundIds = new Set(rows.map((r) => r.id));
    const missing = opts.ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      console.error(
        `${C.red}Error:${C.reset} Recording ID(s) not found: ${missing.join(", ")}`,
      );
      process.exit(2);
    }
  }

  const cliCookies = [
    ...opts.cookies.map(parseCookieArg),
    ...(opts.cookieFile ? loadCookieFile(opts.cookieFile) : []),
  ];

  console.log(`\n${C.bold}Browser Automation Test Runner${C.reset}`);
  console.log(`Recordings : ${rows.length}`);
  console.log(`Speed      : ${opts.speed}×`);
  if (opts.baseUrl) console.log(`Base URL   : ${opts.baseUrl}`);
  if (cliCookies.length > 0)
    console.log(`Cookies    : ${cliCookies.length} (CLI override)`);
  console.log();

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--ignore-certificate-errors", // allow self-signed / internal TLS
        "--allow-running-insecure-content",
      ],
      defaultViewport: VIEWPORT,
    });
  } catch (err) {
    console.error(
      `${C.red}Error:${C.reset} Failed to launch browser: ${err.message}`,
    );
    process.exit(2);
  }

  const suiteResults = [];

  // Run a single recording with optional retry on failure. Returns the final
  // result (last attempt). Adds `flakyAttempts` if a retry succeeded.
  async function runOne(session, rec) {
    const maxAttempts = (opts.retry || 0) + 1;
    let last;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      last = await replayRecording(session, rec, opts, cliCookies);
      const ok = !last.error && last.failed === 0;
      if (ok) {
        if (attempt > 1) last.flakyAttempts = attempt;
        return last;
      }
    }
    return last;
  }

  function statusLine(result) {
    if (result.error) return `${C.red}ERROR${C.reset} ${C.dim}(${result.duration.toFixed(1)}s)${C.reset}`;
    const flaky = result.flakyAttempts ? ` ${C.yellow}(flaky x${result.flakyAttempts})${C.reset}` : "";
    if (result.failed === 0) {
      const note = result.total === 0 ? "no checks" : `${result.passed}/${result.total}`;
      return `${C.green}PASS${C.reset}${flaky} ${C.dim}${note} (${result.duration.toFixed(1)}s)${C.reset}`;
    }
    return `${C.red}FAIL${C.reset} ${C.dim}${result.passed}/${result.total} passed (${result.duration.toFixed(1)}s)${C.reset}`;
  }

  async function makeSession() {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport(VIEWPORT);
    const session = { page, toastSink: null };
    await page.exposeFunction("__captureToast", (text) => {
      if (session.toastSink) session.toastSink.push(text);
    });
    await page.evaluateOnNewDocument(TOAST_OBSERVER_SCRIPT);
    return { ctx, session };
  }

  const idxWidth = String(rows.length).length;

  try {
    if (opts.parallel > 1) {
      // ── Parallel mode ────────────────────────────────────────────────────
      // Each worker has its own context (no page reuse). Tests run in
      // arrival order across workers; final summary is sorted by recording id.
      console.log(`\n${C.bold}━━ Parallel mode: ${opts.parallel} workers${C.reset}`);
      const queue = [...rows];
      let nextDone = 0;
      const workers = [];
      for (let w = 0; w < opts.parallel; w++) {
        workers.push((async () => {
          const { ctx, session } = await makeSession();
          try {
            while (queue.length > 0) {
              const rec = queue.shift();
              if (!rec) break;
              const result = await runOne(session, rec);
              suiteResults.push(result);
              nextDone++;
              console.log(
                `[${String(nextDone).padStart(idxWidth)}/${rows.length}] ${rec.name} … ${statusLine(result)}`,
              );
            }
          } finally {
            await ctx.close();
          }
        })());
      }
      await Promise.all(workers);
      // Restore original ordering for the final report
      const idIndex = new Map(rows.map((r, i) => [r.id, i]));
      suiteResults.sort((a, b) => idIndex.get(a.rec.id) - idIndex.get(b.rec.id));
    } else {
      // ── Serial mode (page reuse + URL grouping) ──────────────────────────
      const { ctx, session } = await makeSession();
      try {
        const groups = groupByPage(rows);
        let i = 0;
        for (const [key, groupRows] of groups) {
          console.log(
            `\n${C.bold}━━ Page: ${key || "(blank)"}${C.reset} ` +
              `${C.dim}(${groupRows.length} recording${groupRows.length === 1 ? "" : "s"})${C.reset}`,
          );
          let groupPass = 0, groupFail = 0;
          for (const rec of groupRows) {
            i++;
            process.stdout.write(
              `[${String(i).padStart(idxWidth)}/${rows.length}] ${rec.name} … `,
            );
            const result = await runOne(session, rec);
            suiteResults.push(result);
            console.log(statusLine(result));
            if (result.error) console.log(`  ${C.dim}${result.error}${C.reset}`);
            if (result.error || result.failed > 0) groupFail++;
            else groupPass++;
          }
          console.log(
            `  ${C.dim}└─ Page result:${C.reset} ` +
              `${C.green}${groupPass} passed${C.reset}, ` +
              `${C.red}${groupFail} failed${C.reset}`,
          );
        }
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }

  // Print detailed results
  printConsoleResults(suiteResults);

  // Write report files
  if (opts.output) writeJsonReport(suiteResults, opts.output);
  if (opts.junit) writeJunitReport(suiteResults, opts.junit);

  // Exit code: 1 if any failures or errors
  const anyFailed = suiteResults.some((s) => s.error || s.failed > 0);
  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error(`${C.red}Fatal error:${C.reset} ${err.message}`);
  process.exit(2);
});
