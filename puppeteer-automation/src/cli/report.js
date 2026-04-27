"use strict";

const fs = require("fs");
const C = require("./colors");
const { pageKey } = require("../shared/url");

function statusLine(result) {
  if (result.error) return `${C.red}ERROR${C.reset} ${C.dim}(${result.duration.toFixed(1)}s)${C.reset}`;
  const flaky = result.flakyAttempts ? ` ${C.yellow}(flaky x${result.flakyAttempts})${C.reset}` : "";
  if (result.failed === 0) {
    const note = result.total === 0 ? "no checks" : `${result.passed}/${result.total}`;
    return `${C.green}PASS${C.reset}${flaky} ${C.dim}${note} (${result.duration.toFixed(1)}s)${C.reset}`;
  }
  return `${C.red}FAIL${C.reset} ${C.dim}${result.passed}/${result.total} passed (${result.duration.toFixed(1)}s)${C.reset}`;
}

function printConsoleResults(suiteResults) {
  let grandPassed = 0, grandFailed = 0;
  let grandRecPass = 0, grandRecFail = 0;
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
    let pgPass = 0, pgFail = 0;

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
              ? `${C.green}✓ PASS*  ${C.reset}`
              : `${C.green}✓ PASS   ${C.reset}`)
          : `${C.red}✗ FAIL   ${C.reset}`;

      const timeStr = `${C.dim}(${s.duration.toFixed(1)}s)${C.reset}`;
      console.log(
        `${C.bold}[${statusLabel}${C.bold}]${C.reset} ${C.bold}${s.rec.name}${C.reset} ${timeStr}`,
      );

      if (s.error) {
        console.log(`  ${C.red}Error: ${s.error}${C.reset}`);
      } else {
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
              console.log(`  ${C.green}✓${C.reset} ${C.dim}[${r.actualStatus}]${C.reset} ${r.url}`);
            } else {
              console.log(`  ${C.red}✗${C.reset} ${C.dim}[${r.actualStatus}]${C.reset} ${r.url}`);
              if (!r.statusPass)
                console.log(`    ${C.red}Status: expected ${r.expectedStatus}, got ${r.actualStatus}${C.reset}`);
              for (const d of r.bodyDiffs.slice(0, 3))
                console.log(`    ${C.red}Body diff: ${d}${C.reset}`);
            }
          }
          for (const r of s.toastResults ?? []) {
            if (r.pass)
              console.log(`  ${C.green}✓${C.reset} ${C.dim}[Toast]${C.reset} ${r.text}`);
            else
              console.log(`  ${C.red}✗${C.reset} ${C.dim}[Toast]${C.reset} "${r.text}" — not seen in replay`);
          }
          for (const r of s.triggerResults ?? []) {
            if (r.pass)
              console.log(`  ${C.green}✓${C.reset} ${C.dim}[Trigger:${r.eventType}]${C.reset} ${r.url}`);
            else
              console.log(`  ${C.red}✗${C.reset} ${C.dim}[Trigger:${r.eventType}]${C.reset} ${r.url} — not triggered in replay`);
          }
          for (const r of s.assertResults ?? []) {
            const tag = `[${r.type}]`;
            if (r.pass)
              console.log(`  ${C.green}✓${C.reset} ${C.dim}${tag}${C.reset} ${r.label}`);
            else
              console.log(`  ${C.red}✗${C.reset} ${C.dim}${tag}${C.reset} ${r.label} — ${r.message}`);
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
  const totalTests = suiteResults.reduce((a, s) => a + Math.max(s.total + jsCount(s), 1), 0);
  const totalFailures = suiteResults.reduce((a, s) => a + (s.error ? 1 : s.failed), 0);
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
      lines.push(`    <testcase name="${esc(s.rec.name)}" classname="${esc(s.rec.name)}" time="${s.duration.toFixed(3)}">`);
      lines.push(`      <failure message="${esc(s.error)}" type="Error">${esc(s.error)}</failure>`);
      lines.push(`    </testcase>`);
    } else {
      if (s.results.length === 0 && !(s.jsErrors && s.jsErrors.length)) {
        lines.push(`    <testcase name="(no responses)" classname="${esc(s.rec.name)}" time="${s.duration.toFixed(3)}"/>`);
      } else {
        for (const r of s.results) {
          lines.push(`    <testcase name="${esc(r.url)}" classname="${esc(s.rec.name)}" time="0">`);
          if (!r.pass) {
            const msg = !r.statusPass
              ? `Status: expected ${r.expectedStatus}, got ${r.actualStatus}`
              : (r.bodyDiffs[0] ?? "body mismatch");
            const detail = r.bodyDiffs.join("\n");
            lines.push(`      <failure message="${esc(msg)}" type="AssertionError">${esc(detail)}</failure>`);
          }
          lines.push("    </testcase>");
        }
        for (const r of s.toastResults ?? []) {
          if (!r.pass) {
            lines.push(`    <testcase name="[Toast] ${esc(r.text.slice(0, 120))}" classname="${esc(s.rec.name)}" time="0">`);
            lines.push(`      <failure message="Toast not seen in replay: ${esc(r.text)}" type="ToastMismatch">${esc(r.text)}</failure>`);
            lines.push("    </testcase>");
          }
        }
        for (const r of s.triggerResults ?? []) {
          if (!r.pass) {
            const name = `[Trigger:${r.eventType}] ${r.url.slice(0, 100)}`;
            lines.push(`    <testcase name="${esc(name)}" classname="${esc(s.rec.name)}" time="0">`);
            lines.push(`      <failure message="URL not triggered in replay: ${esc(r.url)}" type="TriggerMismatch">${esc(r.url)}</failure>`);
            lines.push("    </testcase>");
          }
        }
        for (const e of s.jsErrors ?? []) {
          lines.push(`    <testcase name="[JS Error] ${esc(e.slice(0, 120))}" classname="${esc(s.rec.name)}" time="0">`);
          lines.push(`      <failure message="${esc(e)}" type="ScriptError">${esc(e)}</failure>`);
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

module.exports = { statusLine, printConsoleResults, writeJsonReport, writeJunitReport };
