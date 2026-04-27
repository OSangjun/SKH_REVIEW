"use strict";

const COLOR = process.stdout.isTTY;
module.exports = {
  reset:  COLOR ? "\x1b[0m"  : "",
  bold:   COLOR ? "\x1b[1m"  : "",
  dim:    COLOR ? "\x1b[2m"  : "",
  green:  COLOR ? "\x1b[32m" : "",
  red:    COLOR ? "\x1b[31m" : "",
  yellow: COLOR ? "\x1b[33m" : "",
  cyan:   COLOR ? "\x1b[36m" : "",
};
