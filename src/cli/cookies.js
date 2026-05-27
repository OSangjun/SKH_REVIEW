"use strict";

const fs = require("fs");
const path = require("path");
const C = require("./colors");

/**
 * Parse a --cookie argument string into a Puppeteer cookie object.
 * Format: "name=value[;domain=X][;path=/][;secure][;httpOnly][;sameSite=Lax]"
 * Cookie values containing literal semicolons must be percent-encoded (%3B).
 */
function parseCookieArg(raw) {
  const ATTRS = new Set([
    "domain", "path", "secure", "httponly", "samesite", "expires", "max-age",
  ]);

  const tokens = raw.split(";").map((p) => p.trim()).filter(Boolean);
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

  let attrStart = tokens.length;
  for (let i = 1; i < tokens.length; i++) {
    const key = (
      tokens[i].indexOf("=") >= 0
        ? tokens[i].slice(0, tokens[i].indexOf("="))
        : tokens[i]
    ).trim().toLowerCase();
    if (ATTRS.has(key)) { attrStart = i; break; }
  }

  const valueParts = [tokens[0].slice(eqIdx + 1), ...tokens.slice(1, attrStart)];
  const value = decodeURIComponent(valueParts.join(";"));

  const cookie = { name, value };
  for (const token of tokens.slice(attrStart)) {
    const ei = token.indexOf("=");
    const key = (ei < 0 ? token : token.slice(0, ei)).trim().toLowerCase();
    const val = ei < 0 ? undefined : token.slice(ei + 1).trim();
    switch (key) {
      case "domain":   cookie.domain = val; break;
      case "path":     cookie.path = val; break;
      case "secure":   cookie.secure = true; break;
      case "httponly": cookie.httpOnly = true; break;
      case "samesite": cookie.sameSite = val; break;
    }
  }
  return cookie;
}

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
    console.error(`${C.red}Error:${C.reset} Failed to read cookie file: ${err.message}`);
    process.exit(2);
  }
}

/**
 * Merge recording cookies with CLI cookies. CLI cookies take precedence.
 */
function mergeCookies(recordingCookies, cliCookies) {
  if (cliCookies.length === 0) return recordingCookies;
  const map = new Map();
  for (const c of recordingCookies) map.set(c.name, c);
  for (const c of cliCookies) map.set(c.name, c);
  return [...map.values()];
}

module.exports = { parseCookieArg, loadCookieFile, mergeCookies };
