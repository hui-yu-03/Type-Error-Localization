"use strict";

// Module stub registry.
// Each entry: (fresh, addCons) => TV representing the module's export.
//   fresh:   () => string   — creates a fresh type variable name
//   addCons: (a, b) => void — emits constraint  a <= b
//
// All TVs are created fresh per call so separate require() invocations
// for the same module remain fully independent.

const stubs = {};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Single-function export: (str) -> void
function singleStrFn(name) {
  return (fresh, addCons) => {
    const T_p = fresh();
    addCons(T_p, "str");
    const T_ret = fresh();
    addCons(T_ret, "void");
    const T_fn = fresh();
    addCons(T_fn, `Func<${name}>{${T_p} -> ${T_ret}}`);
    return T_fn;
  };
}

// Object export with one method: { method: (str) -> void }
function objMethodStr(method) {
  return (fresh, addCons) => {
    const T_p = fresh();
    addCons(T_p, "str");
    const T_ret = fresh();
    addCons(T_ret, "void");
    const T_fn = fresh();
    addCons(T_fn, `Func<${method}>{${T_p} -> ${T_ret}}`);
    const T_mod = fresh();
    addCons(T_mod, `{${method}: ${T_fn}}`);
    return T_mod;
  };
}

// ── Third-party package stubs ─────────────────────────────────────────────────
// Node.js built-ins (fs, path, child_process, util) are handled lazily
// in summaries.js — only the methods actually accessed get instantiated.

stubs["portkiller"] = singleStrFn("portkiller");
stubs["port-killer"] = singleStrFn("port-killer");
stubs["react-dev-utils/getProcessForPort"] = singleStrFn("getProcessForPort");
stubs["bestzip"] = singleStrFn("bestzip");

stubs["ps-kill"] = objMethodStr("kill");
stubs["psnode"] = objMethodStr("kill");
stubs["portprocesses"] = objMethodStr("killProcess");
stubs["npm-help"] = objMethodStr("latestVersion");
stubs["buns"] = objMethodStr("install");

// ts-process-promises: { exec: (cmd: str, opts: str) -> void }
stubs["ts-process-promises"] = (fresh, addCons) => {
  const T_p1 = fresh();
  addCons(T_p1, "str");
  const T_p2 = fresh();
  addCons(T_p2, "str");
  const T_ret = fresh();
  addCons(T_ret, "void");
  const T_fn = fresh();
  addCons(T_fn, `Func<ts_exec>{${T_p1} -> ${T_p2} -> ${T_ret}}`);
  const T_mod = fresh();
  addCons(T_mod, `{exec: ${T_fn}}`);
  return T_mod;
};

module.exports = stubs;
