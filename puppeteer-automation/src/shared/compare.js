"use strict";

const { canonicalUrl, pathUrl, normalizeUrl } = require("./url");
const { isBlockedUrl, isIgnoredBodyPath } = require("./blocklist");

// Matching key: strip origin then strip cache-bust params.
// Handles both legacy full-URL recordings and new path-only recordings so
// that test cases remain portable across local / dev / production environments.
function matchKey(url, stripParams = []) {
  return canonicalUrl(pathUrl(url), stripParams);
}

// Group responses by canonicalized path (origin stripped, cache-busters
// stripped). Same path called N times keeps N entries for positional pairing.
function buildResponseMap(responses, stripParams = []) {
  const map = new Map();
  for (const r of responses) {
    const key = matchKey(r.url, stripParams);
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
      diffs.push(`${path}[]: length changed (${expected.length} → ${actual.length})`);
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
      if (!(k in expected)) { diffs.push(`${childPath}: key added`); continue; }
      if (!(k in actual)) { diffs.push(`${childPath}: key removed`); continue; }
      diffs.push(...jsonDiff(expected[k], actual[k], childPath, bodyIgnore));
      if (diffs.length >= MAX_DIFFS) break;
    }
    return diffs.slice(0, MAX_DIFFS);
  }
  return expected !== actual
    ? [`${path}: ${JSON.stringify(expected)} → ${JSON.stringify(actual)}`]
    : [];
}

// Compare recorded vs replay HTTP responses. Returns one result per recorded
// response. URLs matching the host/url blocklist are skipped (third-party
// trackers, anti-bot probes).
// When HTTP body comparison is disabled: just verify every captured response
// returned a 2xx status code. No URL matching against the recording.
function buildStatusOnlyResults(replayResponses, opts = {}) {
  const ignoreHosts = opts.ignoreHosts ?? [];
  const ignoreUrlPatterns = opts.ignoreUrlPatterns ?? [];
  return replayResponses
    .filter(r => !isBlockedUrl(r.url, ignoreHosts, ignoreUrlPatterns))
    .map(r => ({
      url: r.url,
      expectedStatus: "2xx",
      actualStatus: r.status,
      statusPass: r.status >= 200 && r.status < 300,
      bodyPass: true,
      bodyDiffs: [],
      pass: r.status >= 200 && r.status < 300,
    }));
}

function compareResponses(recorded, actual, opts = {}) {
  const ignoreHosts = opts.ignoreHosts ?? [];
  const ignoreUrlPatterns = opts.ignoreUrlPatterns ?? [];
  const bodyIgnore = opts.bodyIgnore ?? [];
  const stripParams = opts.stripParams ?? [];

  const recMap = buildResponseMap(recorded, stripParams);
  const actMap = buildResponseMap(actual, stripParams);

  // Fallback: group actual responses by path-only key (query fully stripped)
  // so session tokens / CSRF params in the URL don't break matching.
  // We track a per-path consumption index to preserve positional pairing.
  const actPathMap = new Map();
  for (const list of actMap.values()) {
    for (const r of list) {
      const pk = normalizeUrl(r.url);
      if (!actPathMap.has(pk)) actPathMap.set(pk, []);
      actPathMap.get(pk).push(r);
    }
  }
  const actPathCursor = new Map(); // pathKey → next unmatched index

  const results = [];
  for (const [url, recList] of recMap) {
    if (isBlockedUrl(url, ignoreHosts, ignoreUrlPatterns)) continue;
    const actList = actMap.get(url) ?? [];
    for (let i = 0; i < recList.length; i++) {
      const rec = recList[i];
      let act = actList[i] ?? null;
      let urlParamsMismatch = false;

      if (!act) {
        // Exact match not found — try path-only fallback (query fully stripped)
        // to tolerate session tokens / dynamic query params between runs.
        const pk = normalizeUrl(rec.url);
        const pathList = actPathMap.get(pk) ?? [];
        const exactConsumed = actList.length;
        const cursor = Math.max(actPathCursor.get(pk) ?? 0, exactConsumed);
        if (cursor < pathList.length) {
          act = pathList[cursor];
          actPathCursor.set(pk, cursor + 1);
          urlParamsMismatch = true;
        }
      }

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
      let bodyPass = true, bodyDiffs = [];
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
      // recorded one. Backward compatible: old recordings have no `reqBody`.
      let reqBodyPass = true, reqBodyDiffs = [];
      if (rec.reqBody != null && act.reqBody != null) {
        try {
          reqBodyDiffs = jsonDiff(JSON.parse(rec.reqBody), JSON.parse(act.reqBody), "reqBody", bodyIgnore);
          reqBodyPass = reqBodyDiffs.length === 0;
        } catch {
          reqBodyPass = rec.reqBody === act.reqBody;
          if (!reqBodyPass) reqBodyDiffs = ["request body text mismatch"];
        }
      }

      const allDiffs = [...bodyDiffs, ...reqBodyDiffs];
      results.push({
        url: rec.url,
        expectedStatus: rec.status,
        actualStatus: act.status,
        statusPass,
        bodyPass,
        bodyDiffs: allDiffs,
        urlParamsMismatch,
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

// Compare per-event trigger mappings (network triggers). Uses normalizeUrl
// (query stripped) on purpose — trigger detection should tolerate cache-
// busters / nonces in URLs even though the response comparison is strict.
function compareTriggerMappings(events, replayTriggerMap) {
  const results = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!Array.isArray(ev.triggeredUrls) || ev.triggeredUrls.length === 0) continue;
    const actual = (replayTriggerMap.get(i) || []).map(normalizeUrl);
    const label = ev.label || ev.selector ||
      (ev.type === "keydown" ? `키[${ev.key}]` : `(${ev.x ?? ""},${ev.y ?? ""})`);
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

// Compare recorded vs replay DOM text snapshots.
// Each entry: { path, text }. Matching strategy:
//   1. Exact path+text match → pass
//   2. Same text found at a different path (element moved) → pass with pathMoved flag
//   3. Text not found anywhere in replay → fail
function compareDomSnapshots(recorded, replayed) {
  if (!recorded || recorded.length === 0) return [];
  const byPath = new Map();
  const byText = new Map();
  for (const r of (replayed || [])) {
    if (!byPath.has(r.path)) byPath.set(r.path, []);
    byPath.get(r.path).push(r);
    if (!byText.has(r.text)) byText.set(r.text, []);
    byText.get(r.text).push(r);
  }
  return recorded.map((r) => {
    const atPath = (byPath.get(r.path) ?? []).find((e) => e.text === r.text);
    if (atPath) return { path: r.path, text: r.text, pass: true, rect: atPath.rect ?? null };
    const atOther = (byText.get(r.text) ?? [])[0];
    if (atOther) return { path: r.path, text: r.text, pass: true, pathMoved: true, rect: atOther.rect ?? null };
    return { path: r.path, text: r.text, pass: false, rect: null };
  });
}

function isNetworkTrigger(ev) {
  return (
    ["click", "dblclick", "navigate", "check", "select"].includes(ev.type) ||
    (ev.type === "keydown" && (ev.key === "Enter" || ev.code === "Enter"))
  );
}

module.exports = {
  buildResponseMap,
  jsonDiff,
  buildStatusOnlyResults,
  compareResponses,
  compareToasts,
  compareTriggerMappings,
  compareDomSnapshots,
  isNetworkTrigger,
  MAX_DIFFS,
};
