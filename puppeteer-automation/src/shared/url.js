"use strict";

// Query parameter names to strip when canonicalizing URLs for comparison.
// Pure cache-busters / timestamps / nonces that vary every request but
// don't change which endpoint is being called.
const CACHE_BUST_PARAMS = new Set([
  "_", "_t", "_ts", "_=", "nonce", "cb", "cachebust", "timestamp", "v", "version",
]);

// Loose URL key for trigger mapping — strips the entire query string.
// Used by compareTriggerMappings to tolerate cache-buster / nonce values
// in URLs that the app's network observer should still consider "the same".
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.search = "";
    return u.toString();
  } catch {
    return url;
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
// pure cache-busters/nonces so the same logical endpoint matches across
// runs. Site-specific tokens can be added via `extraStrip`.
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
  normalizeUrl,
  applyBaseUrl,
  canonicalUrl,
  pageKey,
};
