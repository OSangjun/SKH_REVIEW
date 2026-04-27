#!/usr/bin/env node
"use strict";

/**
 * run-tests.js — CLI test runner for Browser Automation Tool
 *
 * Thin entry point. The actual logic is split across src/cli/* and
 * src/shared/*. See `node run-tests.js --help` for usage.
 *
 * Exit codes:
 *   0  All tests passed (or no responses to compare)
 *   1  One or more tests failed
 *   2  Fatal error (DB not found, browser launch failure, etc.)
 */

require("dotenv").config();
const puppeteer = require("puppeteer-core");

const C = require("./src/cli/colors");
const { parseArgs } = require("./src/cli/args");
const { parseCookieArg, loadCookieFile } = require("./src/cli/cookies");
const { openDb, fetchRecordings, listRecordings } = require("./src/cli/db");
const {
  replayRecording, groupByPage, VIEWPORT, TOAST_OBSERVER_SCRIPT,
} = require("./src/cli/runner");
const {
  statusLine, printConsoleResults, writeJsonReport, writeJunitReport,
} = require("./src/cli/report");

const CHROME_PATH =
  process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

async function main() {
  const opts = parseArgs();

  if (!opts.baseUrl && process.env.BASE_URL) opts.baseUrl = process.env.BASE_URL;

  const db = openDb();

  if (opts.list) {
    listRecordings(db);
    process.exit(0);
  }

  if (!opts.all && opts.ids.length === 0) {
    console.error(`${C.red}Error:${C.reset} Specify --all, --id <n>, or --ids <n,n,...>`);
    console.error("  Run with --help for usage.");
    process.exit(2);
  }

  const rows = fetchRecordings(db, opts);
  if (rows.length === 0) {
    console.error(`${C.red}Error:${C.reset} No matching recordings found.`);
    process.exit(2);
  }

  if (opts.ids.length > 0) {
    const foundIds = new Set(rows.map((r) => r.id));
    const missing = opts.ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      console.error(`${C.red}Error:${C.reset} Recording ID(s) not found: ${missing.join(", ")}`);
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
  if (cliCookies.length > 0) console.log(`Cookies    : ${cliCookies.length} (CLI override)`);
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
        "--ignore-certificate-errors",
        "--allow-running-insecure-content",
      ],
      defaultViewport: VIEWPORT,
    });
  } catch (err) {
    console.error(`${C.red}Error:${C.reset} Failed to launch browser: ${err.message}`);
    process.exit(2);
  }

  const suiteResults = [];

  // Wrap a single recording with optional retry.
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
      const idIndex = new Map(rows.map((r, i) => [r.id, i]));
      suiteResults.sort((a, b) => idIndex.get(a.rec.id) - idIndex.get(b.rec.id));
    } else {
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
            process.stdout.write(`[${String(i).padStart(idxWidth)}/${rows.length}] ${rec.name} … `);
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

  printConsoleResults(suiteResults);

  if (opts.output) writeJsonReport(suiteResults, opts.output);
  if (opts.junit) writeJunitReport(suiteResults, opts.junit);

  const anyFailed = suiteResults.some((s) => s.error || s.failed > 0);
  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error(`${C.red}Fatal error:${C.reset} ${err.message}`);
  process.exit(2);
});
