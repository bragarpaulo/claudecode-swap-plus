#!/usr/bin/env node
"use strict";
// Swap Plus Cliente — ponto de entrada da linha de comando. Tudo está em ../src/cli.js.

require("../src/cli")
  .main(process.argv.slice(2))
  .then(
    (code) => {
      process.exitCode = Number.isInteger(code) ? code : 0;
    },
    (e) => {
      console.error(`swap-plus-cliente: ${(e && e.message) || e}`);
      process.exitCode = 1;
    }
  );
