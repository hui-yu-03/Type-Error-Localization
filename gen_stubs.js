#!/usr/bin/env node
"use strict";

// Generates a stubs.js entry by introspecting an installed third-party module.
//
// Usage:
//   node gen-stubs.js <module-name>
//   node gen-stubs.js <module-name> --path <dir>   (look in a specific directory)
//
// The --path flag is useful when the package is installed in a project directory
// other than the one containing this script.  Example:
//   node gen-stubs.js ps-kill --path /path/to/project
//
// When required as a module, exports { buildStub } for use by infer.js.

const path = require("path");
const Module = require("module");

// ── Introspection ─────────────────────────────────────────────────────────────

const SKIP_KEYS = new Set([
  "length",
  "name",
  "prototype",
  "arguments",
  "caller",
  "__proto__",
  "constructor",
  "super_",
]);

function describe(val, depth) {
  if (depth > 2 || val == null) return null;

  const t = typeof val;

  if (t === "function") {
    const arity = val.length;
    const attachedFields = collectFields(val, depth);
    return { kind: "func", arity, attachedFields };
  }

  if (t === "object") {
    const fields = collectFields(val, depth);
    return { kind: "obj", fields };
  }

  if (t === "string") return { kind: "base", type: "str" };
  if (t === "number") return { kind: "base", type: "num" };
  if (t === "boolean") return { kind: "base", type: "bool" };

  return null;
}

function collectFields(val, depth) {
  const keys = [
    ...new Set([...Object.keys(val), ...Object.getOwnPropertyNames(val)]),
  ].filter(
    (k) => !SKIP_KEYS.has(k) && !/^[_0-9]/.test(k) && !/^[A-Z_]+$/.test(k),
  );

  const fields = [];
  for (const k of keys.slice(0, 30)) {
    let v;
    try {
      v = val[k];
    } catch {
      continue;
    }
    const child = describe(v, depth + 1);
    if (child) fields.push({ name: k, shape: child });
  }
  return fields;
}

// ── Direct-call variant (exported for use by infer.js) ────────────────────────

function directEmit(shape, label, fresh, addCons) {
  if (!shape) return null;

  switch (shape.kind) {
    case "func": {
      const params = Array.from({ length: shape.arity }, fresh);
      const ret = fresh();
      const fn = fresh();

      if (params.length === 0) {
        addCons(fn, `Func<${label}>{() -> ${ret}}`);
      } else {
        addCons(fn, `Func<${label}>{${[...params, ret].join(" -> ")}}`);
      }

      if (shape.attachedFields.length > 0) {
        const extra = directEmitFields(shape.attachedFields, fresh, addCons);
        if (extra.length > 0) {
          const objVar = fresh();
          directBuildObj(objVar, extra, addCons);
          addCons(objVar, `{call: ${fn}}`);
          return objVar;
        }
      }

      return fn;
    }

    case "obj": {
      const fieldVars = directEmitFields(shape.fields, fresh, addCons);
      const obj = fresh();
      directBuildObj(obj, fieldVars, addCons);
      return obj;
    }

    case "base": {
      const v = fresh();
      addCons(v, shape.type);
      return v;
    }

    default:
      return null;
  }
}

function directEmitFields(fields, fresh, addCons) {
  const result = [];
  for (const { name, shape } of fields) {
    const v = directEmit(shape, name, fresh, addCons);
    if (v) result.push({ name, var: v });
  }
  return result;
}

function directBuildObj(objVar, fieldVars, addCons) {
  if (fieldVars.length === 0) {
    addCons(objVar, "{}");
  } else {
    const parts = fieldVars
      .map(({ name, var: v }) => `${name}: ${v}`)
      .join(", ");
    addCons(objVar, `{${parts}}`);
  }
}

function buildStub(mod, label, fresh, addCons) {
  const shape = describe(mod, 0);
  return shape ? directEmit(shape, label, fresh, addCons) : null;
}

module.exports = { buildStub };

// ── Code-generation variant (CLI output) ─────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const pathFlagIdx = args.indexOf("--path");
  const searchPath = pathFlagIdx !== -1 ? args[pathFlagIdx + 1] : null;
  const moduleName = args.find((a) => !a.startsWith("--"));

  if (!moduleName) {
    console.error("Usage: node gen-stubs.js <module-name> [--path <dir>]");
    process.exit(1);
  }

  let mod;
  try {
    if (searchPath) {
      const req = Module.createRequire(
        path.resolve(searchPath, "__placeholder__.js"),
      );
      mod = req(moduleName);
    } else {
      mod = require(moduleName);
    }
  } catch (e) {
    console.error(`Cannot require '${moduleName}': ${e.message}`);
    if (!searchPath)
      console.error(
        `Tip: if the package is installed elsewhere, use --path <dir>`,
      );
    process.exit(1);
  }

  const lines = [];
  let idx = 0;
  const nextVar = () => `T${idx++}`;

  function emit(shape, label) {
    if (!shape) return null;

    switch (shape.kind) {
      case "func": {
        const params = Array.from({ length: shape.arity }, nextVar);
        const ret = nextVar();
        const fn = nextVar();

        params.forEach((p) => lines.push(`  const ${p} = fresh();`));
        lines.push(`  const ${ret} = fresh();`);
        lines.push(`  const ${fn}  = fresh();`);

        if (params.length === 0) {
          lines.push(
            `  addCons(${fn}, "Func<${label}>{() -> " + ${ret} + "}");`,
          );
        } else {
          const all = [...params, ret].join(", ");
          lines.push(
            `  addCons(${fn}, "Func<${label}>{" + [${all}].join(" -> ") + "}");`,
          );
        }

        if (shape.attachedFields.length > 0) {
          const extra = emitFields(shape.attachedFields);
          if (extra.length > 0) {
            const objVar = nextVar();
            lines.push(`  const ${objVar} = fresh();`);
            buildObjConstraint(objVar, extra);
            lines.push(
              `  addCons(${objVar}, "{call: " + ${fn} + "}"); // function-as-namespace`,
            );
            return objVar;
          }
        }

        return fn;
      }

      case "obj": {
        const fieldVars = emitFields(shape.fields);
        const obj = nextVar();
        lines.push(`  const ${obj} = fresh();`);
        buildObjConstraint(obj, fieldVars);
        return obj;
      }

      case "base": {
        const v = nextVar();
        lines.push(`  const ${v} = fresh(); addCons(${v}, "${shape.type}");`);
        return v;
      }

      default:
        return null;
    }
  }

  function emitFields(fields) {
    const result = [];
    for (const { name, shape } of fields) {
      const v = emit(shape, name);
      if (v) result.push({ name, var: v });
    }
    return result;
  }

  function buildObjConstraint(objVar, fieldVars) {
    if (fieldVars.length === 0) {
      lines.push(`  addCons(${objVar}, "{}");`);
    } else {
      const parts = fieldVars.map(({ name, var: v }, i) =>
        i === 0 ? `"${name}: " + ${v}` : `", ${name}: " + ${v}`,
      );
      lines.push(`  addCons(${objVar}, "{" + ${parts.join(" + ")} + "}");`);
    }
  }

  const root = describe(mod, 0);
  const rootVar = emit(root, moduleName.replace(/[^a-zA-Z0-9_]/g, "_"));

  if (!rootVar) {
    console.error(
      `Could not generate stub for '${moduleName}': unsupported export shape`,
    );
    process.exit(1);
  }

  lines.push(`  return ${rootVar};`);

  console.log(`stubs[${JSON.stringify(moduleName)}] = (fresh, addCons) => {`);
  lines.forEach((l) => console.log(l));
  console.log(`};`);
}
