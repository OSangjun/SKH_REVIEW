#!/usr/bin/env node
'use strict';

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

const puppeteer = require('puppeteer-core');
const Database  = require('better-sqlite3');
const path      = require('path');
const fs        = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────

const CHROME_PATH = process.env.CHROME_PATH
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const VIEWPORT      = { width: 1920, height: 1080 };
const DB_PATH       = path.join(__dirname, 'recordings.db');
const NETWORK_EVTS  = new Set(['navigate', 'click', 'dblclick']);

// ── ANSI colors (auto-disabled if not a TTY) ──────────────────────────────────

const COLOR = process.stdout.isTTY;
const C = {
  reset:  COLOR ? '\x1b[0m'  : '',
  bold:   COLOR ? '\x1b[1m'  : '',
  dim:    COLOR ? '\x1b[2m'  : '',
  green:  COLOR ? '\x1b[32m' : '',
  red:    COLOR ? '\x1b[31m' : '',
  yellow: COLOR ? '\x1b[33m' : '',
  cyan:   COLOR ? '\x1b[36m' : '',
};

// ── CLI argument parsing ───────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    ids:        [],
    all:        false,
    list:       false,
    speed:      1.0,
    timeout:    5000,
    output:     null,   // JSON report path
    junit:      null,   // JUnit XML report path
    baseUrl:    null,   // replace origin of all URLs
    cookies:    [],     // raw --cookie strings
    cookieFile: null,   // --cookie-file path
    verbose:    false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--id':          opts.ids.push(+args[++i]);                                   break;
      case '--ids':         args[++i].split(',').forEach(x => opts.ids.push(+x.trim())); break;
      case '--all':         opts.all        = true;                                       break;
      case '--list':        opts.list       = true;                                       break;
      case '--speed':       opts.speed      = parseFloat(args[++i]);                     break;
      case '--timeout':     opts.timeout    = +args[++i];                                 break;
      case '--output':      opts.output     = args[++i];                                  break;
      case '--junit':       opts.junit      = args[++i];                                  break;
      case '--base-url':    opts.baseUrl    = args[++i];                                  break;
      case '--cookie':      opts.cookies.push(args[++i]);                                 break;
      case '--cookie-file': opts.cookieFile = args[++i];                                  break;
      case '--verbose':     opts.verbose    = true;                                        break;
      case '-v':            opts.verbose    = true;                                        break;
      case '--help': case '-h': printHelp(); process.exit(0);                             break;
      default:
        console.error(`Unknown option: ${a}  (--help for usage)`);
        process.exit(2);
    }
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
  if (!fs.existsSync(DB_PATH)) {
    console.error(`${C.red}Error:${C.reset} DB not found at ${DB_PATH}`);
    console.error('  Start the server at least once to initialise the database.');
    process.exit(2);
  }
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

function fetchRecordings(db, opts) {
  if (opts.all) {
    return db.prepare(
      `SELECT id, name, url, event_count AS eventCount, created_at AS createdAt,
              description, events, responses, cookies
       FROM recordings ORDER BY id`
    ).all();
  }
  const ph = opts.ids.map(() => '?').join(',');
  return db.prepare(
    `SELECT id, name, url, event_count AS eventCount, created_at AS createdAt,
            description, events, responses, cookies
     FROM recordings WHERE id IN (${ph}) ORDER BY id`
  ).all(...opts.ids);
}

function listRecordings(db) {
  const rows = db.prepare(
    `SELECT id, name, url, event_count AS eventCount, created_at AS createdAt, description
     FROM recordings ORDER BY id`
  ).all();

  if (rows.length === 0) {
    console.log('No recordings found.');
    return;
  }

  const fmt = iso => { try { return new Date(iso).toLocaleString('ko-KR'); } catch { return iso; } };
  const pad = (s, n) => String(s).padEnd(n);

  console.log(`\n${C.bold}${pad('ID', 4)}${pad('Name', 24)}${pad('Events', 8)}${pad('Created', 22)}URL${C.reset}`);
  console.log('─'.repeat(90));
  for (const r of rows) {
    const desc = r.description ? `  ${C.dim}${r.description}${C.reset}` : '';
    console.log(`${pad(r.id, 4)}${pad(r.name, 24)}${pad(r.eventCount, 8)}${pad(fmt(r.createdAt), 22)}${r.url}${desc}`);
  }
  console.log();
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

/**
 * Parse a --cookie argument string into a Puppeteer cookie object.
 * Format: "name=value[;domain=X][;path=/][;secure][;httpOnly][;sameSite=Lax]"
 */
function parseCookieArg(raw) {
  const parts = raw.split(';').map(p => p.trim());
  const eqIdx = parts[0].indexOf('=');
  if (eqIdx < 0) {
    console.error(`${C.red}Error:${C.reset} Invalid cookie format: "${raw}"`);
    console.error('  Expected: name=value[;domain=X;path=/;secure;httpOnly]');
    process.exit(2);
  }
  const name  = parts[0].slice(0, eqIdx).trim();
  const value = parts[0].slice(eqIdx + 1);
  if (!name) {
    console.error(`${C.red}Error:${C.reset} Cookie name is empty in: "${raw}"`);
    process.exit(2);
  }
  const cookie = { name, value };
  for (const part of parts.slice(1)) {
    const ei  = part.indexOf('=');
    const key = (ei < 0 ? part : part.slice(0, ei)).trim().toLowerCase();
    const val = ei < 0 ? undefined : part.slice(ei + 1).trim();
    switch (key) {
      case 'domain':   cookie.domain   = val;  break;
      case 'path':     cookie.path     = val;  break;
      case 'secure':   cookie.secure   = true; break;
      case 'httponly': cookie.httpOnly = true; break;
      case 'samesite': cookie.sameSite = val;  break;
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
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
    return parsed.filter(c => c && c.name && c.value !== undefined);
  } catch (err) {
    console.error(`${C.red}Error:${C.reset} Failed to read cookie file: ${err.message}`);
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
  for (const c of cliCookies)       map.set(c.name, c); // overrides by name
  return [...map.values()];
}

// ── Replay utilities ───────────────────────────────────────────────────────────

const sleep   = ms  => new Promise(r => setTimeout(r, ms));
const tryJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

function normalizeUrl(url) {
  try { const u = new URL(url); u.search = ''; return u.toString(); }
  catch { return url; }
}

function applyBaseUrl(url, baseUrl) {
  if (!baseUrl) return url;
  try {
    const u = new URL(url);
    const b = new URL(baseUrl);
    u.protocol = b.protocol;
    u.host     = b.host;
    return u.toString();
  } catch { return url; }
}

function buildResponseMap(responses) {
  const map = new Map();
  for (const r of responses) {
    const key = normalizeUrl(r.url);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

function jsonDiff(expected, actual, path = 'root') {
  if (typeof expected !== typeof actual)
    return [`${path}: type changed (${typeof expected} → ${typeof actual})`];
  if (expected === null || actual === null)
    return expected !== actual ? [`${path}: null mismatch`] : [];
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const diffs = [];
    if (expected.length !== actual.length)
      diffs.push(`${path}[]: length changed (${expected.length} → ${actual.length})`);
    for (let i = 0; i < Math.min(expected.length, actual.length, 3); i++)
      diffs.push(...jsonDiff(expected[i], actual[i], `${path}[${i}]`));
    return diffs.slice(0, 5);
  }
  if (typeof expected === 'object') {
    const diffs = [];
    const keys  = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of keys) {
      if (!(k in expected)) { diffs.push(`${path}.${k}: key added`);   continue; }
      if (!(k in actual))   { diffs.push(`${path}.${k}: key removed`); continue; }
      diffs.push(...jsonDiff(expected[k], actual[k], `${path}.${k}`));
      if (diffs.length >= 5) break;
    }
    return diffs.slice(0, 5);
  }
  return expected !== actual
    ? [`${path}: ${JSON.stringify(expected)} → ${JSON.stringify(actual)}`]
    : [];
}

function compareResponses(recorded, actual) {
  const recMap = buildResponseMap(recorded);
  // Deduplicate actual responses — keep last occurrence per normalized URL
  const actMap = new Map();
  for (const r of actual) actMap.set(normalizeUrl(r.url), r);

  const results = [];
  for (const [, r] of actMap) {
    const recList = recMap.get(normalizeUrl(r.url));
    if (!recList) continue;
    const rec        = recList[0];
    const statusPass = rec.status === r.status;
    let bodyPass = true, bodyDiffs = [];
    if (rec.body !== null && r.body !== null) {
      try {
        bodyDiffs = jsonDiff(JSON.parse(rec.body), JSON.parse(r.body));
        bodyPass  = bodyDiffs.length === 0;
      } catch {
        bodyPass  = rec.body === r.body;
        if (!bodyPass) bodyDiffs = ['body text mismatch'];
      }
    }
    results.push({
      url: r.url, expectedStatus: rec.status, actualStatus: r.status,
      statusPass, bodyPass, bodyDiffs, pass: statusPass && bodyPass,
    });
  }
  return results;
}

async function waitNetworkIdle(page, timeout) {
  try { await page.waitForNetworkIdle({ idleTime: 500, timeout }); } catch {}
}

const BTN = b => b === 'right' ? 'right' : b === 'middle' ? 'middle' : 'left';

async function dispatchEvent(page, ev, baseUrl) {
  switch (ev.type) {
    case 'navigate':
      await page.goto(applyBaseUrl(ev.url, baseUrl), { waitUntil: 'networkidle2', timeout: 30000 });
      break;
    case 'click':
      await page.mouse.click(ev.x, ev.y, { button: BTN(ev.button) });
      break;
    case 'dblclick':
      await page.mouse.click(ev.x, ev.y, { clickCount: 2 });
      break;
    case 'wheel':
      await page.mouse.wheel({ deltaX: ev.deltaX, deltaY: ev.deltaY });
      break;
    case 'scroll':
      await page.evaluate((x, y) => window.scrollTo(x, y), ev.scrollX, ev.scrollY);
      break;
    case 'keydown':
      await page.keyboard.down(ev.key === ' ' ? 'Space' : ev.key);
      break;
    case 'keyup':
      await page.keyboard.up(ev.key === ' ' ? 'Space' : ev.key);
      break;
    case 'input':
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await page.keyboard.type(ev.value ?? '');
      break;
    case 'contenteditable':
      await page.evaluate(h => {
        if (document.activeElement) document.activeElement.innerHTML = h;
      }, ev.html);
      break;
    case 'select':
      await page.evaluate(v => {
        const el = document.activeElement;
        if (el && el.tagName === 'SELECT') {
          el.value = v;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, ev.value);
      break;
  }
}

// ── Core replay function ───────────────────────────────────────────────────────

async function replayRecording(browser, rec, opts, cliCookies = []) {
  const events   = tryJson(rec.events, []);
  const recorded = tryJson(rec.responses, []);
  const cookies  = mergeCookies(tryJson(rec.cookies, []), cliCookies);

  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  const replayResponses = [];
  const pending = new Set();

  const onResponse = response => {
    const url = response.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    const ct       = (response.headers()['content-type'] || '').toLowerCase();
    const status   = response.status();
    const wantBody = /json|text\/plain|xml/.test(ct);

    if (!wantBody) {
      replayResponses.push({ url, status, contentType: ct, body: null });
      return;
    }
    const p = response.buffer()
      .then(buf => {
        const body = buf.length <= 51200 ? buf.toString('utf8') : null;
        replayResponses.push({ url, status, contentType: ct, body });
      })
      .catch(() => replayResponses.push({ url, status, contentType: ct, body: null }))
      .finally(() => pending.delete(p));
    pending.add(p);
  };
  page.on('response', onResponse);

  const startMs = Date.now();
  let error = null;

  try {
    if (cookies.length > 0) await page.setCookie(...cookies);

    const startUrl = applyBaseUrl(rec.url, opts.baseUrl);
    if (opts.verbose) console.log(`  ${C.dim}Load: ${startUrl}${C.reset}`);
    await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    let lastT = 0;
    for (const ev of events) {
      const delay = Math.max(0, ((ev.t ?? 0) - lastT) / opts.speed);
      if (delay > 0) await sleep(delay);
      lastT = ev.t ?? 0;

      if (opts.verbose) {
        const detail =
          ev.type === 'click'    ? `(${ev.x},${ev.y})` :
          ev.type === 'dblclick' ? `(${ev.x},${ev.y})` :
          ev.type === 'keydown'  ? ev.key :
          ev.type === 'input'    ? `"${String(ev.value ?? '').slice(0, 30)}"` :
          ev.type === 'navigate' ? ev.url : '';
        console.log(`  ${C.dim}[${ev.type}]${detail ? ' ' + detail : ''}${C.reset}`);
      }

      try { await dispatchEvent(page, ev, opts.baseUrl); } catch {}

      const needsWait = NETWORK_EVTS.has(ev.type) ||
        (ev.type === 'keydown' && (ev.key === 'Enter' || ev.code === 'Enter'));
      if (needsWait) await waitNetworkIdle(page, opts.timeout);
    }
  } catch (err) {
    error = err.message;
  } finally {
    page.off('response', onResponse);
    if (pending.size > 0)
      await Promise.race([Promise.allSettled([...pending]), sleep(2000)]);
    await page.close();
  }

  const duration = (Date.now() - startMs) / 1000;
  const results  = recorded.length > 0 ? compareResponses(recorded, replayResponses) : [];
  const passed   = results.filter(r => r.pass).length;
  const failed   = results.filter(r => !r.pass).length;

  return { rec, results, passed, failed, total: results.length, duration, error };
}

// ── Output formatters ─────────────────────────────────────────────────────────

function printConsoleResults(suiteResults) {
  let grandPassed = 0, grandFailed = 0;
  console.log();

  for (const s of suiteResults) {
    const statusLabel =
      s.error                           ? `${C.red}✗ ERROR  ${C.reset}` :
      s.total === 0                     ? `${C.yellow}~ SKIP   ${C.reset}` :
      s.failed === 0                    ? `${C.green}✓ PASS   ${C.reset}` :
                                          `${C.red}✗ FAIL   ${C.reset}`;

    const timeStr = `${C.dim}(${s.duration.toFixed(1)}s)${C.reset}`;
    console.log(`${C.bold}[${statusLabel}${C.bold}]${C.reset} ${C.bold}${s.rec.name}${C.reset} ${timeStr}`);

    if (s.error) {
      console.log(`  ${C.red}Error: ${s.error}${C.reset}`);
    } else if (s.results.length === 0) {
      console.log(`  ${C.dim}No recorded responses to compare${C.reset}`);
    } else {
      for (const r of s.results) {
        const short = r.url.length > 80 ? r.url.slice(0, 77) + '…' : r.url;
        if (r.pass) {
          console.log(`  ${C.green}✓${C.reset} ${C.dim}[${r.actualStatus}]${C.reset} ${short}`);
        } else {
          console.log(`  ${C.red}✗${C.reset} ${C.dim}[${r.actualStatus}]${C.reset} ${short}`);
          if (!r.statusPass)
            console.log(`    ${C.red}Status: expected ${r.expectedStatus}, got ${r.actualStatus}${C.reset}`);
          for (const d of r.bodyDiffs.slice(0, 3))
            console.log(`    ${C.red}Body diff: ${d}${C.reset}`);
        }
      }
      grandPassed += s.passed;
      grandFailed += s.failed;
    }
  }

  console.log();
  const overallOk = grandFailed === 0 && !suiteResults.some(s => s.error);
  const icon = overallOk ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
  console.log(
    `${C.bold}${icon} Summary:${C.reset}  ` +
    `${C.green}${grandPassed} passed${C.reset}, ` +
    `${C.red}${grandFailed} failed${C.reset}  ` +
    `${C.dim}(${suiteResults.length} recording(s))${C.reset}`
  );
  console.log();
}

function writeJsonReport(suiteResults, outPath) {
  const report = {
    timestamp:  new Date().toISOString(),
    recordings: suiteResults.length,
    passed:     suiteResults.filter(s => !s.error && s.failed === 0).length,
    failed:     suiteResults.filter(s =>  s.error || s.failed  >  0).length,
    suites:     suiteResults.map(s => ({
      id:       s.rec.id,
      name:     s.rec.name,
      url:      s.rec.url,
      duration: s.duration,
      error:    s.error ?? null,
      passed:   s.passed,
      failed:   s.failed,
      total:    s.total,
      results:  s.results,
    })),
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`${C.cyan}JSON report →${C.reset} ${outPath}`);
}

function writeJunitReport(suiteResults, outPath) {
  const esc = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const totalTests    = suiteResults.reduce((a, s) => a + Math.max(s.total, 1), 0);
  const totalFailures = suiteResults.reduce((a, s) => a + (s.error ? 1 : s.failed), 0);
  const totalTime     = suiteResults.reduce((a, s) => a + s.duration, 0).toFixed(3);

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="Browser Automation Tests" tests="${totalTests}" failures="${totalFailures}" time="${totalTime}">`,
  ];

  for (const s of suiteResults) {
    const suiteTests    = Math.max(s.total, 1);
    const suiteFailures = s.error ? 1 : s.failed;
    lines.push(`  <testsuite name="${esc(s.rec.name)}" tests="${suiteTests}" failures="${suiteFailures}" time="${s.duration.toFixed(3)}">`);

    if (s.error) {
      lines.push(`    <testcase name="${esc(s.rec.name)}" classname="${esc(s.rec.name)}" time="${s.duration.toFixed(3)}">`);
      lines.push(`      <failure message="${esc(s.error)}" type="Error">${esc(s.error)}</failure>`);
      lines.push(`    </testcase>`);
    } else if (s.results.length === 0) {
      lines.push(`    <testcase name="(no responses)" classname="${esc(s.rec.name)}" time="${s.duration.toFixed(3)}"/>`);
    } else {
      for (const r of s.results) {
        const name = r.url.length > 120 ? r.url.slice(0, 117) + '...' : r.url;
        lines.push(`    <testcase name="${esc(name)}" classname="${esc(s.rec.name)}" time="0">`);
        if (!r.pass) {
          const msg = !r.statusPass
            ? `Status: expected ${r.expectedStatus}, got ${r.actualStatus}`
            : (r.bodyDiffs[0] ?? 'body mismatch');
          const detail = r.bodyDiffs.join('\n');
          lines.push(`      <failure message="${esc(msg)}" type="AssertionError">${esc(detail)}</failure>`);
        }
        lines.push('    </testcase>');
      }
    }
    lines.push('  </testsuite>');
  }
  lines.push('</testsuites>');

  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  console.log(`${C.cyan}JUnit report →${C.reset} ${outPath}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  // ENV variable fallback for base URL
  if (!opts.baseUrl && process.env.BASE_URL) opts.baseUrl = process.env.BASE_URL;

  const db = openDb();

  // --list: just show recordings and exit
  if (opts.list) { listRecordings(db); process.exit(0); }

  if (!opts.all && opts.ids.length === 0) {
    console.error(`${C.red}Error:${C.reset} Specify --all, --id <n>, or --ids <n,n,...>`);
    console.error('  Run with --help for usage.');
    process.exit(2);
  }

  const rows = fetchRecordings(db, opts);
  if (rows.length === 0) {
    console.error(`${C.red}Error:${C.reset} No matching recordings found.`);
    process.exit(2);
  }

  const cliCookies = [
    ...opts.cookies.map(parseCookieArg),
    ...(opts.cookieFile ? loadCookieFile(opts.cookieFile) : []),
  ];

  console.log(`\n${C.bold}Browser Automation Test Runner${C.reset}`);
  console.log(`Recordings : ${rows.length}`);
  console.log(`Speed      : ${opts.speed}×`);
  if (opts.baseUrl) console.log(`Base URL   : ${opts.baseUrl}`);
  if (cliCookies.length > 0) console.log(`Cookies    : ${cliCookies.length} (CLI override)`);
  console.log();

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
      defaultViewport: VIEWPORT,
    });
  } catch (err) {
    console.error(`${C.red}Error:${C.reset} Failed to launch browser: ${err.message}`);
    process.exit(2);
  }

  const suiteResults = [];

  try {
    for (let i = 0; i < rows.length; i++) {
      const rec = rows[i];
      process.stdout.write(
        `[${String(i + 1).padStart(String(rows.length).length)}/${rows.length}] ` +
        `${rec.name} … `
      );

      const result = await replayRecording(browser, rec, opts, cliCookies);
      suiteResults.push(result);

      if (result.error) {
        console.log(`${C.red}ERROR${C.reset} ${C.dim}(${result.duration.toFixed(1)}s)${C.reset}`);
        console.log(`  ${C.dim}${result.error}${C.reset}`);
      } else if (result.total === 0) {
        console.log(`${C.yellow}SKIP${C.reset} ${C.dim}(no responses, ${result.duration.toFixed(1)}s)${C.reset}`);
      } else if (result.failed === 0) {
        console.log(`${C.green}PASS${C.reset} ${C.dim}${result.passed}/${result.total} (${result.duration.toFixed(1)}s)${C.reset}`);
      } else {
        console.log(`${C.red}FAIL${C.reset} ${C.dim}${result.passed}/${result.total} passed (${result.duration.toFixed(1)}s)${C.reset}`);
      }
    }
  } finally {
    await browser.close();
  }

  // Print detailed results
  printConsoleResults(suiteResults);

  // Write report files
  if (opts.output) writeJsonReport(suiteResults, opts.output);
  if (opts.junit)  writeJunitReport(suiteResults, opts.junit);

  // Exit code: 1 if any failures or errors
  const anyFailed = suiteResults.some(s => s.error || s.failed > 0);
  process.exit(anyFailed ? 1 : 0);
}

main().catch(err => {
  console.error(`${C.red}Fatal error:${C.reset} ${err.message}`);
  process.exit(2);
});
