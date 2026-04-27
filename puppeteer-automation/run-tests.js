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

// Group responses by full URL (query string included). Same URL called N times
// in a row keeps N entries so positional pairing can compare each occurrence.
function buildResponseMap(responses) {
  const map = new Map();
  for (const r of responses) {
    const key = r.url;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

const MAX_DIFFS = 10;
function jsonDiff(expected, actual, path = "root") {
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
      diffs.push(...jsonDiff(expected[i], actual[i], `${path}[${i}]`));
      if (diffs.length >= MAX_DIFFS) break;
    }
    return diffs.slice(0, MAX_DIFFS);
  }
  if (typeof expected === "object") {
    const diffs = [];
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of keys) {
      if (!(k in expected)) {
        diffs.push(`${path}.${k}: key added`);
        continue;
      }
      if (!(k in actual)) {
        diffs.push(`${path}.${k}: key removed`);
        continue;
      }
      diffs.push(...jsonDiff(expected[k], actual[k], `${path}.${k}`));
      if (diffs.length >= MAX_DIFFS) break;
    }
    return diffs.slice(0, MAX_DIFFS);
  }
  return expected !== actual
    ? [`${path}: ${JSON.stringify(expected)} → ${JSON.stringify(actual)}`]
    : [];
}

function compareResponses(recorded, actual) {
  const recMap = buildResponseMap(recorded);
  const actMap = buildResponseMap(actual);

  const results = [];
  // Iterate over recorded URLs — pair each occurrence positionally with the
  // actual responses for the same full URL. Missing actuals are reported as
  // failures; extras (not in recording) are ignored.
  for (const [url, recList] of recMap) {
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
            bodyDiffs = jsonDiff(JSON.parse(rec.body), JSON.parse(act.body));
            bodyPass = bodyDiffs.length === 0;
          } catch {
            bodyPass = rec.body === act.body;
            if (!bodyPass) bodyDiffs = ["body text mismatch"];
          }
        }
      }
      results.push({
        url: rec.url,
        expectedStatus: rec.status,
        actualStatus: act.status,
        statusPass,
        bodyPass,
        bodyDiffs,
        pass: statusPass && bodyPass,
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

// Pick the element matching `selector` whose visible text equals `label`,
// falling back to the first match if none of them match the label. This
// disambiguates class-only selectors like `button.btn-quick` that match
// many elements during a recording.
async function pickByLabelOrFirst(page, selector, label) {
  const handles = await page.$$(selector);
  if (handles.length === 0) return null;
  if (handles.length === 1 || !label) return handles[0];
  for (const h of handles) {
    const txt = await h.evaluate((e) => (e.innerText || "").trim());
    if (txt === label) return h;
  }
  return handles[0];
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
          const el = await pickByLabelOrFirst(page, ev.selector, ev.label);
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

    if (!wantBody) {
      replayResponses.push({ url, status, contentType: ct, body: null });
      return;
    }
    const p = response
      .buffer()
      .then((buf) => {
        const body = buf.length <= 51200 ? buf.toString("utf8") : null;
        replayResponses.push({ url, status, contentType: ct, body });
      })
      .catch(() =>
        replayResponses.push({ url, status, contentType: ct, body: null }),
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
  const results =
    recorded.length > 0 ? compareResponses(recorded, replayResponses) : [];
  const toastResults = compareToasts(recordedToasts, replayToasts);
  const triggerResults = compareTriggerMappings(events, replayTriggerMap);
  const passed = results.filter((r) => r.pass).length;
  const httpFailed = results.filter((r) => !r.pass).length;
  const toastFailed = toastResults.filter((r) => !r.pass).length;
  const triggerFailed = triggerResults.filter((r) => !r.pass).length;
  const failed = httpFailed + toastFailed + triggerFailed + jsErrors.length;
  const total = results.length + toastResults.length + triggerResults.length;

  return {
    rec,
    results,
    toastResults,
    triggerResults,
    passed,
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
    grandRecFail = 0,
    grandRecSkip = 0;
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
      pgFail = 0,
      pgSkip = 0;

  for (const s of groupResults) {
    const hasJsErr = s.jsErrors && s.jsErrors.length > 0;
    const isErr = !!s.error;
    const isSkip = !isErr && s.total === 0 && !hasJsErr;
    const isPass = !isErr && !isSkip && s.failed === 0 && !hasJsErr;
    if (isPass) { pgPass++; grandRecPass++; }
    else if (isSkip) { pgSkip++; grandRecSkip++; }
    else { pgFail++; grandRecFail++; }

    const statusLabel = s.error
      ? `${C.red}✗ ERROR  ${C.reset}`
      : s.total === 0 && !hasJsErr
        ? `${C.yellow}~ SKIP   ${C.reset}`
        : s.failed === 0 && !hasJsErr
          ? `${C.green}✓ PASS   ${C.reset}`
          : `${C.red}✗ FAIL   ${C.reset}`;

    const timeStr = `${C.dim}(${s.duration.toFixed(1)}s)${C.reset}`;
    console.log(
      `${C.bold}[${statusLabel}${C.bold}]${C.reset} ${C.bold}${s.rec.name}${C.reset} ${timeStr}`,
    );

    if (s.error) {
      console.log(`  ${C.red}Error: ${s.error}${C.reset}`);
    } else {
      const hasToastErr = s.toastResults && s.toastResults.some((r) => !r.pass);
      if (
        s.results.length === 0 &&
        !hasJsErr &&
        !(s.toastResults && s.toastResults.length)
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
      }
      if (hasJsErr) {
        for (const e of s.jsErrors)
          console.log(`  ${C.red}✗ [JS Error] ${e}${C.reset}`);
      }
      grandPassed += s.passed;
      grandFailed += s.failed;
    }
  }

    const skipNote = pgSkip > 0 ? `, ${C.yellow}${pgSkip} skipped${C.reset}` : "";
    console.log(
      `  ${C.dim}└─ Page result:${C.reset} ` +
        `${C.green}${pgPass} passed${C.reset}, ` +
        `${C.red}${pgFail} failed${C.reset}${skipNote}`,
    );
    console.log();
  }

  const overallOk = grandRecFail === 0;
  const icon = overallOk ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
  const totalRec = suiteResults.length;
  const skipTotal =
    grandRecSkip > 0 ? `, ${C.yellow}${grandRecSkip} skipped${C.reset}` : "";
  console.log(
    `${C.bold}${icon} Total:${C.reset}  ` +
      `${C.green}${grandRecPass} passed${C.reset}, ` +
      `${C.red}${grandRecFail} failed${C.reset}${skipTotal}  ` +
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

  // Single shared page across all recordings — no reload between tests.
  // Tests inherit prior state (URL, cookies, localStorage, scroll position).
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(VIEWPORT);
  const session = { page, toastSink: null };
  await page.exposeFunction("__captureToast", (text) => {
    if (session.toastSink) session.toastSink.push(text);
  });
  await page.evaluateOnNewDocument(TOAST_OBSERVER_SCRIPT);

  // Group recordings by page URL — same-URL recordings run consecutively so
  // the shared page does not navigate unnecessarily between them.
  const groups = groupByPage(rows);
  const idxWidth = String(rows.length).length;

  try {
    let i = 0;
    for (const [key, groupRows] of groups) {
      console.log(
        `\n${C.bold}━━ Page: ${key || "(blank)"}${C.reset} ` +
          `${C.dim}(${groupRows.length} recording${groupRows.length === 1 ? "" : "s"})${C.reset}`,
      );

      let groupPass = 0,
        groupFail = 0,
        groupSkip = 0;

      for (const rec of groupRows) {
        i++;
        process.stdout.write(
          `[${String(i).padStart(idxWidth)}/${rows.length}] ${rec.name} … `,
        );

        const result = await replayRecording(session, rec, opts, cliCookies);
        suiteResults.push(result);

        if (result.error) {
          groupFail++;
          console.log(
            `${C.red}ERROR${C.reset} ${C.dim}(${result.duration.toFixed(1)}s)${C.reset}`,
          );
          console.log(`  ${C.dim}${result.error}${C.reset}`);
        } else if (result.total === 0) {
          groupSkip++;
          console.log(
            `${C.yellow}SKIP${C.reset} ${C.dim}(no responses, ${result.duration.toFixed(1)}s)${C.reset}`,
          );
        } else if (result.failed === 0) {
          groupPass++;
          console.log(
            `${C.green}PASS${C.reset} ${C.dim}${result.passed}/${result.total} (${result.duration.toFixed(1)}s)${C.reset}`,
          );
        } else {
          groupFail++;
          console.log(
            `${C.red}FAIL${C.reset} ${C.dim}${result.passed}/${result.total} passed (${result.duration.toFixed(1)}s)${C.reset}`,
          );
        }
      }

      const skipNote = groupSkip > 0 ? `, ${C.yellow}${groupSkip} skipped${C.reset}` : "";
      console.log(
        `  ${C.dim}└─ Page result:${C.reset} ` +
          `${C.green}${groupPass} passed${C.reset}, ` +
          `${C.red}${groupFail} failed${C.reset}${skipNote}`,
      );
    }
  } finally {
    await context.close();
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
