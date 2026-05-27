"use strict";

const ASSERT_TYPES = new Set([
  "assert-text", "assert-visible", "assert-attr", "assert-count", "assert-screenshot",
]);
const WAIT_TYPES = new Set([
  "wait-for-selector", "wait-for-text", "wait-for-function",
]);

// Run a DOM assertion event. Returns { type, label, pass, message, ... }.
async function runAssertion(page, ev, timeout = 5000) {
  const label = ev.label || ev.selector || ev.type;
  try {
    switch (ev.type) {
      case "assert-text": {
        await page.waitForSelector(ev.selector, { timeout, visible: true }).catch(() => {});
        const actual = await page.$eval(ev.selector, (e) =>
          (e.innerText || e.textContent || "").trim()
        ).catch(() => null);
        if (actual === null)
          return { type: ev.type, label, pass: false, message: `selector not found: ${ev.selector}` };
        const mode = ev.mode || "contains";
        const ok =
          mode === "equals" ? actual === ev.expected :
          mode === "regex"  ? new RegExp(ev.expected).test(actual) :
                              actual.includes(ev.expected);
        return {
          type: ev.type, label, pass: ok, expected: ev.expected, actual,
          message: ok ? null : `text ${mode} "${ev.expected}" — got "${actual.slice(0, 80)}"`,
        };
      }
      case "assert-visible": {
        const want = ev.expected !== false;
        if (want)
          await page.waitForSelector(ev.selector, { timeout, visible: true }).catch(() => {});
        const visible = await page.$eval(ev.selector, (e) => {
          const r = e.getBoundingClientRect();
          const s = window.getComputedStyle(e);
          return r.width > 0 && r.height > 0 &&
                 s.visibility !== "hidden" && s.display !== "none";
        }).catch(() => false);
        const ok = visible === want;
        return {
          type: ev.type, label, pass: ok, expected: want, actual: visible,
          message: ok ? null : `expected ${want ? "visible" : "hidden"}, got ${visible ? "visible" : "hidden"}`,
        };
      }
      case "assert-attr": {
        await page.waitForSelector(ev.selector, { timeout }).catch(() => {});
        const actual = await page.$eval(ev.selector, (e, attr) => e.getAttribute(attr), ev.attr).catch(() => null);
        const mode = ev.mode || "equals";
        const ok =
          mode === "equals" ? actual === ev.expected :
          mode === "regex"  ? actual !== null && new RegExp(ev.expected).test(actual) :
                              actual !== null && actual.includes(ev.expected);
        return {
          type: ev.type, label, pass: ok, expected: ev.expected, actual,
          message: ok ? null : `attr ${ev.attr} ${mode} "${ev.expected}" — got "${actual}"`,
        };
      }
      case "assert-count": {
        const op = ev.op || "eq";
        const actual = await page.$$eval(ev.selector, (els) => els.length).catch(() => 0);
        const ok =
          op === "eq"  ? actual === ev.expected :
          op === "gte" ? actual >= ev.expected :
          op === "lte" ? actual <= ev.expected : false;
        return {
          type: ev.type, label, pass: ok, expected: ev.expected, actual,
          message: ok ? null : `count ${op} ${ev.expected} — got ${actual}`,
        };
      }
    }
  } catch (err) {
    return { type: ev.type, label, pass: false, message: `assertion error: ${err.message}` };
  }
  return null;
}

// Compare two PNG buffers — exact byte equality is too strict, so we compare
// header equality (size) and the proportion of differing payload bytes.
function comparePngBuffers(a, b, threshold = 0.05) {
  if (!a || !b) return { pass: false, message: "missing buffer" };
  if (a.length === 0 || b.length === 0) return { pass: false, message: "empty buffer" };
  const sizeMatch = a.length >= 24 && b.length >= 24 &&
    a.slice(16, 24).equals(b.slice(16, 24));
  if (!sizeMatch) return { pass: false, message: "dimensions differ" };
  const len = Math.min(a.length, b.length);
  let diff = 0;
  for (let i = 24; i < len; i++) if (a[i] !== b[i]) diff++;
  const ratio = diff / Math.max(1, len - 24);
  return {
    pass: ratio <= threshold,
    diffRatio: ratio,
    message: ratio <= threshold ? null : `pixel diff ratio ${(ratio*100).toFixed(1)}% > ${(threshold*100).toFixed(1)}%`,
  };
}

async function runScreenshotAssert(page, ev) {
  const selector = ev.selector;
  const expectedB64 = ev.expected;
  if (!expectedB64)
    return { type: ev.type, label: ev.label || "screenshot", pass: false, message: "no recorded screenshot" };
  let actualBuf;
  try {
    if (selector) {
      const el = await page.$(selector);
      if (!el)
        return { type: ev.type, label: selector, pass: false, message: `selector not found: ${selector}` };
      actualBuf = await el.screenshot({ type: "png" });
    } else {
      actualBuf = await page.screenshot({ type: "png", fullPage: false });
    }
  } catch (err) {
    return { type: ev.type, label: ev.label || "screenshot", pass: false, message: `screenshot failed: ${err.message}` };
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

// State-based wait events — alternative to time-based sleeps.
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

module.exports = {
  ASSERT_TYPES,
  WAIT_TYPES,
  runAssertion,
  runScreenshotAssert,
  runWait,
  comparePngBuffers,
};
