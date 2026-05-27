#!/usr/bin/env node
'use strict';

const path = require('path');
const { record } = require('./recorder');
const { replay } = require('./replayer');

const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');

function usage() {
  console.log(`
Puppeteer Browser Automation - Recorder & Replayer
===================================================

Usage:
  node src/index.js record  <url> [output.json]
  node src/index.js replay  <url> <input.json> [speedFactor]

Examples:
  node src/index.js record  https://example.com
  node src/index.js record  https://example.com recordings/my-session.json

  node src/index.js replay  https://example.com recordings/session.json
  node src/index.js replay  https://example.com recordings/session.json 2.0

Options:
  speedFactor   Playback speed multiplier (default: 1.0)
                  0.5 = half speed, 2.0 = double speed

Recording output defaults to recordings/session-<timestamp>.json
`);
}

async function main() {
  const [,, command, urlArg, ...rest] = process.argv;

  if (!command || !urlArg || command === '--help' || command === '-h') {
    usage();
    process.exit(0);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaultOutput = path.join(RECORDINGS_DIR, `session-${timestamp}.json`);

  if (command === 'record') {
    const outputFile = rest[0] ?? defaultOutput;
    await record(urlArg, outputFile);

  } else if (command === 'replay') {
    const inputFile = rest[0];
    if (!inputFile) {
      console.error('[Error] replay requires <input.json>');
      usage();
      process.exit(1);
    }
    const speedFactor = parseFloat(rest[1] ?? '1.0');
    await replay(urlArg, inputFile, speedFactor);

  } else {
    console.error(`[Error] Unknown command: ${command}`);
    usage();
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[Fatal]', err.message);
  process.exit(1);
});
