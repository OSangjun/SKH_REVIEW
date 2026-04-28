"use strict";

const C = require("./colors");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    ids: [],
    all: false,
    list: false,
    speed: 1.0,
    timeout: 5000,
    requestTimeout: 60000,
    output: null,
    junit: null,
    baseUrl: null,
    cookies: [],
    cookieFile: null,
    verbose: false,
    fast: false,
    ignoreHosts: [],
    ignoreUrlPatterns: [],
    bodyIgnore: [],
    stripParams: [],
    retry: 0,
    parallel: 1,
    httpCompare: true,
    mockReplay: true,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--id":            opts.ids.push(+args[++i]); break;
      case "--ids":           args[++i].split(",").forEach((x) => opts.ids.push(+x.trim())); break;
      case "--all":           opts.all = true; break;
      case "--list":          opts.list = true; break;
      case "--speed":         opts.speed = parseFloat(args[++i]); break;
      case "--timeout":         opts.timeout = +args[++i]; break;
      case "--request-timeout": opts.requestTimeout = +args[++i]; break;
      case "--output":        opts.output = args[++i]; break;
      case "--junit":         opts.junit = args[++i]; break;
      case "--base-url":      opts.baseUrl = args[++i]; break;
      case "--cookie":        opts.cookies.push(args[++i]); break;
      case "--cookie-file":   opts.cookieFile = args[++i]; break;
      case "--verbose":
      case "-v":              opts.verbose = true; break;
      case "--fast":          opts.fast = true; break;
      case "--ignore-host":   opts.ignoreHosts.push(args[++i]); break;
      case "--ignore-url":    opts.ignoreUrlPatterns.push(new RegExp(args[++i])); break;
      case "--ignore-body":   opts.bodyIgnore.push(new RegExp(args[++i])); break;
      case "--strip-param":   opts.stripParams.push(args[++i]); break;
      case "--retry":            opts.retry = +args[++i]; break;
      case "--parallel":         opts.parallel = +args[++i]; break;
      case "--no-http-compare":  opts.httpCompare = false; break;
      case "--mock-replay":      opts.mockReplay = true; break;
      case "--no-mock-replay":   opts.mockReplay = false; break;
      case "--help":
      case "-h":              printHelp(); process.exit(0); break;
      default:
        console.error(`Unknown option: ${a}  (--help for usage)`);
        process.exit(2);
    }
  }
  if (opts.speed <= 0 || !isFinite(opts.speed)) {
    console.error(`${C.red}Error:${C.reset} --speed must be a positive number (got ${opts.speed})`);
    process.exit(2);
  }
  if (opts.timeout <= 0 || !Number.isInteger(opts.timeout)) {
    console.error(`${C.red}Error:${C.reset} --timeout must be a positive integer ms value (got ${opts.timeout})`);
    process.exit(2);
  }
  if (opts.requestTimeout <= 0 || !Number.isInteger(opts.requestTimeout)) {
    console.error(`${C.red}Error:${C.reset} --request-timeout must be a positive integer ms value (got ${opts.requestTimeout})`);
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
  --timeout <ms>           Assertion/wait-element timeout in ms (default: 5000)
  --request-timeout <ms>   Max time to wait for network idle after each trigger
                           event (default: 60000). Increase for APIs that take
                           tens of seconds to respond.

${C.bold}Comparison filters (in addition to built-in defaults):${C.reset}
  --ignore-host <host>     Exclude responses to this host from comparison.
                           Built-in: google-analytics, gtm, googleapis,
                           doubleclick, fb, hotjar, segment, mixpanel,
                           amplitude, sentry, cloudflareinsights, etc.
  --ignore-url <regex>     Exclude responses matching this URL regex.
                           Built-in: anti-bot uniqueness probes.
  --ignore-body <regex>    Skip JSON body paths matching this regex during
                           diff. Built-in: CurrentTime, sessionId, csrfToken,
                           nonce, traceId, ETag, etc. (case-insensitive).
  --strip-param <name>     Strip this query param from URLs before matching.
                           Built-in: _ _t _ts nonce cb cachebust timestamp.
                           Use for site-specific tokens like
                           --strip-param netfunnelKeyString.

${C.bold}Reliability / performance:${C.reset}
  --retry <n>              Re-run a failing test up to <n> times. Reports as
                           PASS if any retry passes (with a "(flaky)" tag).
  --parallel <n>           Run up to <n> tests concurrently in separate
                           browser contexts. Disables page reuse — each test
                           starts in a fresh context. Default 1 (serial).
  --no-http-compare        Skip HTTP response body comparison. Only checks
                           that each API call returned a 2xx status code.
                           Toast and trigger mapping checks still run.
  --no-mock-replay         Disable mock replay and send requests to the real
                           server (mock replay is ON by default).
  --mock-replay            Force mock replay on (already the default).

${C.bold}Cookie options (override recording cookies, higher priority):${C.reset}
  --cookie <spec>          Add a cookie. Format:
                             name=value
                             name=value;domain=.example.com;path=/;secure;httpOnly
                           Repeat for multiple cookies.
  --cookie-file <path>     Load cookies from a JSON file (array of cookie objects).

${C.bold}Output:${C.reset}
  --base-url <url>         Replace origin of all URLs (env switching)
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
`);
}

module.exports = { parseArgs, printHelp };
