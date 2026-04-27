"use strict";

// Built-in blocklist: third-party trackers + common anti-bot/CDN endpoints.
// Responses to these hosts are skipped during BOTH capture and comparison —
// volatile by nature, never useful for regression testing.
// Match is "host ends with" — covers subdomains.
const DEFAULT_HOST_BLOCKLIST = [
  "google-analytics.com",
  "googletagmanager.com",
  "googleapis.com",
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
  /\/uniqueness\.[^/]+\/.+/,
];

// JSON body paths to ignore when diffing — matched against the slash-joined
// path from jsonDiff (e.g. "root.CurrentTime"). Catches the most common
// volatile fields that always differ between recording and replay.
const DEFAULT_BODY_IGNORE = [
  /\.(CurrentTime|currentTime|timestamp|requestId|requestTime|sessionId|UserSessionId|csrfToken|csrf|nonce|traceId|spanId|correlationId|ETag)$/i,
];

function hostMatchesAny(url, hosts) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  const host = parsed.host;
  for (const h of hosts) {
    if (host === h || host.endsWith("." + h)) return true;
  }
  return false;
}

// Capture-time filter — should this URL be skipped entirely (not stored
// in recordings, not captured during replay)?
function isTrackerUrl(url) {
  return hostMatchesAny(url, DEFAULT_HOST_BLOCKLIST);
}

// Comparison-time filter — DEFAULT_HOST_BLOCKLIST + extra hosts +
// DEFAULT_URL_BLOCKLIST + extra URL regex patterns.
function isBlockedUrl(url, extraHosts = [], extraUrlPatterns = []) {
  if (hostMatchesAny(url, [...DEFAULT_HOST_BLOCKLIST, ...extraHosts])) return true;
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

module.exports = {
  DEFAULT_HOST_BLOCKLIST,
  DEFAULT_URL_BLOCKLIST,
  DEFAULT_BODY_IGNORE,
  isTrackerUrl,
  isBlockedUrl,
  isIgnoredBodyPath,
};
