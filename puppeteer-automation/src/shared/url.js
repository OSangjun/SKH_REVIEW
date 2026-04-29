"use strict";

// Query parameter names to strip when canonicalizing URLs for comparison.
// Pure cache-busters / timestamps / nonces that vary every request but
// don't change which endpoint is being called.
const CACHE_BUST_PARAMS = new Set([
  "_", "_t", "_ts", "_=", "nonce", "cb", "cachebust", "timestamp", "v", "version",
]);

// Strip the origin (protocol + host + port) from a URL, returning only the
// path + query + hash. When the input is already path-only, it is returned
// unchanged. This is used so that the same recording works across local,
// staging, and production environments without modification.
function pathUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash;
  } catch {
    return url; // already path-only or non-standard
  }
}

// Loose URL key for trigger mapping — strips the origin AND the entire query
// string so that trigger URLs match regardless of environment or cache params.
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    // path-only URL — strip query string
    return url.split("?")[0];
  }
}

// Replace the origin (protocol + host) of `url` with that of `baseUrl`.
// Used to point the same recording at staging / QA environments.
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

// Canonicalize a URL for response comparison: strip query params that are
// pure cache-busters/nonces so the same logical endpoint matches across runs.
// Works on both full URLs ("https://example.com/api?x=1") and path-only URLs
// ("/api?x=1") so that recordings made with pathUrl storage remain comparable.
function canonicalUrl(url, extraStrip = []) {
  const strip = new Set([...CACHE_BUST_PARAMS, ...extraStrip]);
  try {
    const u = new URL(url);
    const keep = [];
    u.searchParams.forEach((value, key) => {
      if (!strip.has(key)) keep.push([key, value]);
    });
    u.search = "";
    for (const [k, v] of keep) u.searchParams.append(k, v);
    return u.toString();
  } catch {
    // path-only URL — strip cache-bust params from query string manually
    const qIdx = url.indexOf("?");
    if (qIdx === -1) return url;
    const path = url.slice(0, qIdx);
    const params = new URLSearchParams(url.slice(qIdx + 1));
    const keep = [];
    params.forEach((value, key) => {
      if (!strip.has(key)) keep.push([key, value]);
    });
    if (keep.length === 0) return path;
    return path + "?" + new URLSearchParams(keep).toString();
  }
}

// Page-key for grouping/filtering: origin + pathname (ignore query / hash).
// /orders?status=A and /orders?status=B both belong to the /orders page.
function pageKey(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

module.exports = {
  CACHE_BUST_PARAMS,
  pathUrl,
  normalizeUrl,
  applyBaseUrl,
  canonicalUrl,
  pageKey,
};
