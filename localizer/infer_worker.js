// Runs infer.js on many files in one Node process, so that a benchmark or the
// re-inference of many line sets does not pay Node's start-up for every file.
//
// One JSON request per line on stdin:   {"args": ["--json", "file.js", ...]}
// one JSON reply per line on stdout:    {"code": 0, "stdout": "...", "stderr": "..."}
//
// Every request runs the module body of infer.js again in a fresh function
// scope (compiled once), so no inference state is shared between requests.
"use strict";
const fs = require("fs");
const path = require("path");
const util = require("util");
const vm = require("vm");
const readline = require("readline");
const { createRequire } = require("module");

const INFER = path.join(__dirname, "..", "infer.js");
const body = fs.readFileSync(INFER, "utf8").replace(/^#!.*/, "");
const run = new vm.Script(
  "(function (exports, require, module, __filename, __dirname, process, console) {" + body + "\n})",
  { filename: INFER },
).runInThisContext();
const requireFromInfer = createRequire(INFER);

class Exit {
  constructor(code) {
    this.code = code;
  }
}

function infer(args) {
  const out = [];
  const err = [];
  const overrides = {
    argv: [process.argv[0], INFER, ...args],
    stdout: { write: (s) => out.push(String(s)) > 0 },
    stderr: { write: (s) => err.push(String(s)) > 0 },
    exit: (code) => {
      throw new Exit(code ?? 0);
    },
  };
  const fakeProcess = new Proxy(process, {
    get(target, key) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const line = (sink) => (...a) => sink.push(util.format(...a) + "\n");
  const fakeConsole = { log: line(out), info: line(out), warn: line(err), error: line(err) };
  // The library tables (summaries.js, stubs.js, gen_stubs.js) are loaded
  // afresh as well: building a stub can change their entries.
  const repo = path.dirname(INFER) + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(repo) && !key.includes(`${path.sep}node_modules${path.sep}`) && key !== __filename) {
      delete require.cache[key];
    }
  }
  const mod = { exports: {} };
  let code = 0;
  try {
    run(mod.exports, requireFromInfer, mod, INFER, path.dirname(INFER), fakeProcess, fakeConsole);
  } catch (e) {
    if (e instanceof Exit) code = e.code;
    else {
      code = 1;
      err.push(String((e && e.stack) || e) + "\n");
    }
  }
  return { code, stdout: out.join(""), stderr: err.join("") };
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const { args } = JSON.parse(line);
  process.stdout.write(JSON.stringify(infer(args)) + "\n");
});
