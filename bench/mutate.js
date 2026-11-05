#!/usr/bin/env node
"use strict";

// Mutation tool: introduces one typical mistake at a time into a (correct)
// JavaScript program, so that the line of the mistake is known.
//
//   node bench/mutate.js list   <file.js> [--max-per-op N]   -> JSON lines, one mutant each
//   node bench/mutate.js sample <file.js> --k K --seed S      -> one program with K mistakes
//
// Operators (each changes the text of one line only):
//   literal        a literal of the wrong type: 42 -> "42", "42" -> 42, "abc" -> 0, true -> "true"
//   swap-args      two adjacent arguments of a call swapped: f(a, b) -> f(b, a)
//   misspell-prop  a misspelled property name: o.name -> o.naem
//   missing-await  a forgotten await: await p -> p
//   wrong-var      another variable used instead of the right one: x -> y
//   remove-return  a forgotten return: return e; -> e;
//
// A mutant records the 1-based line of the change and the operator.

const acorn = require("acorn");
const fs = require("fs");

const OPERATORS = [
  "literal",
  "swap-args",
  "misspell-prop",
  "missing-await",
  "wrong-var",
  "remove-return",
];

function parse(src) {
  for (const sourceType of ["script", "module"]) {
    try {
      return acorn.parse(src, {
        ecmaVersion: 2020,
        sourceType,
        allowReturnOutsideFunction: true,
        locations: true,
      });
    } catch (e) {
      /* try the other source type */
    }
  }
  return null;
}

// Generic AST walk that also gives the parent and the key of each node.
function walk(node, visit, parent = null, key = null) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parent, key);
  for (const k of Object.keys(node)) {
    if (k === "loc") continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit, node, k));
    else if (v && typeof v.type === "string") walk(v, visit, node, k);
  }
}

function sameLine(node) {
  return node.loc.start.line === node.loc.end.line;
}

// Each site: { op, line, start, end, replacement, description }
function mutationSites(src, ast) {
  const sites = [];
  const declared = []; // [{name, pos}] declared variable names in source order
  const isRequireArg = (n, parent) =>
    parent &&
    parent.type === "CallExpression" &&
    parent.callee.type === "Identifier" &&
    parent.callee.name === "require";

  walk(ast, (node, parent, key) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier")
      declared.push({ name: node.id.name, pos: node.end }); // initialized after its declarator
    if (
      (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression") &&
      node.params
    )
      for (const p of node.params)
        if (p.type === "Identifier") declared.push({ name: p.name, pos: p.end });
  });
  declared.sort((a, b) => a.pos - b.pos);

  walk(ast, (node, parent, key) => {
    const line = node.loc.start.line;
    const text = src.slice(node.start, node.end);

    // literal ----------------------------------------------------------------
    if (node.type === "Literal" && sameLine(node) && !node.regex && node.value !== null) {
      const isKey = parent && parent.type === "Property" && key === "key";
      const isDirective = parent && parent.type === "ExpressionStatement" && parent.directive;
      const isModule =
        isRequireArg(node, parent) ||
        (parent && /Import|Export/.test(parent.type) && key === "source");
      if (!isKey && !isDirective && !isModule) {
        let repl = null;
        if (typeof node.value === "number") repl = JSON.stringify(String(node.value));
        else if (typeof node.value === "string")
          repl = node.value.trim() !== "" && !isNaN(Number(node.value)) ? String(Number(node.value)) : "0";
        else if (typeof node.value === "boolean") repl = JSON.stringify(String(node.value));
        if (repl !== null && repl !== text)
          sites.push({ op: "literal", line, start: node.start, end: node.end, replacement: repl, description: `${text} -> ${repl}` });
      }
    }

    // swap-args --------------------------------------------------------------
    if ((node.type === "CallExpression" || node.type === "NewExpression") && node.arguments.length >= 2) {
      for (let i = 0; i + 1 < node.arguments.length; i++) {
        const a = node.arguments[i], b = node.arguments[i + 1];
        if (a.type === "SpreadElement" || b.type === "SpreadElement") continue;
        if (!sameLine(a) || !sameLine(b) || a.loc.start.line !== b.loc.start.line) continue;
        const ta = src.slice(a.start, a.end), tb = src.slice(b.start, b.end);
        if (ta === tb) continue;
        const repl = tb + src.slice(a.end, b.start) + ta;
        sites.push({ op: "swap-args", line: a.loc.start.line, start: a.start, end: b.end, replacement: repl, description: `(${ta}, ${tb}) -> (${tb}, ${ta})` });
      }
    }

    // misspell-prop ----------------------------------------------------------
    if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
      const name = node.property.name;
      if (name.length >= 3 && name !== "prototype") {
        const typo = name.slice(0, -2) + name[name.length - 1] + name[name.length - 2];
        if (typo !== name)
          sites.push({ op: "misspell-prop", line: node.property.loc.start.line, start: node.property.start, end: node.property.end, replacement: typo, description: `.${name} -> .${typo}` });
      }
    }

    // missing-await ------------------------------------------------------------
    if (node.type === "AwaitExpression") {
      const arg = src.slice(node.argument.start, node.argument.end);
      sites.push({ op: "missing-await", line, start: node.start, end: node.end, replacement: arg, description: `await ${arg} -> ${arg}` });
    }

    // remove-return ------------------------------------------------------------
    if (node.type === "ReturnStatement" && node.argument && sameLine(node)) {
      const arg = src.slice(node.argument.start, node.argument.end);
      sites.push({ op: "remove-return", line, start: node.start, end: node.argument.end, replacement: arg, description: `return ${arg} -> ${arg}` });
    }

    // wrong-var ----------------------------------------------------------------
    if (node.type === "Identifier" && parent) {
      const isUse =
        !(parent.type === "VariableDeclarator" && key === "id") &&
        !(parent.type === "MemberExpression" && key === "property" && !parent.computed) &&
        !(parent.type === "Property" && key === "key") &&
        !(/Function/.test(parent.type) && (key === "id" || key === "params")) &&
        !(parent.type === "CallExpression" && key === "callee") &&
        !(parent.type === "NewExpression" && key === "callee") &&
        !/Class|Method|Label|Import|Export|Catch|Pattern/.test(parent.type) &&
        !(parent.type === "AssignmentExpression" && key === "left") &&
        !(parent.type === "UpdateExpression");
      if (isUse && declared.some((d) => d.name === node.name)) {
        // the most recently declared other variable before this use
        let other = null;
        for (const d of declared) {
          if (d.pos > node.start) break;
          if (d.name !== node.name) other = d.name;
        }
        if (other)
          sites.push({ op: "wrong-var", line, start: node.start, end: node.end, replacement: other, description: `${node.name} -> ${other}` });
      }
    }
  });
  return sites;
}

function apply(src, sites) {
  // apply from the end so that earlier offsets stay valid
  const sorted = [...sites].sort((a, b) => b.start - a.start);
  let out = src;
  for (const s of sorted) out = out.slice(0, s.start) + s.replacement + out.slice(s.end);
  return out;
}

// Deterministic PRNG (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function main() {
  const [cmd, file, ...rest] = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : dflt;
  };
  if (!cmd || !file) {
    console.error("usage: node bench/mutate.js list|sample <file.js> [--max-per-op N] [--k K --seed S] [--ops a,b]");
    process.exit(1);
  }
  const src = fs.readFileSync(file, "utf8");
  const ast = parse(src);
  if (!ast) process.exit(0);
  const ops = (opt("--ops", OPERATORS.join(","))).split(",");
  const sites = mutationSites(src, ast).filter((s) => ops.includes(s.op));

  if (cmd === "list") {
    const maxPerOp = Number(opt("--max-per-op", "1000000"));
    const count = {};
    const seen = new Set();
    for (const s of sites) {
      count[s.op] = (count[s.op] ?? 0) + 1;
      if (count[s.op] > maxPerOp) continue;
      const mutated = apply(src, [s]);
      if (seen.has(mutated) || mutated === src) continue;
      seen.add(mutated);
      const { start, end, ...info } = s;
      process.stdout.write(JSON.stringify({ ...info, lines: [s.line], source: mutated }) + "\n");
    }
  } else if (cmd === "sample") {
    // K mistakes on K distinct lines, chosen uniformly with the given seed
    const k = Number(opt("--k", "1"));
    const rand = rng(Number(opt("--seed", "1")));
    const pool = [...sites];
    const chosen = [];
    const usedLines = new Set();
    while (chosen.length < k && pool.length) {
      const i = Math.floor(rand() * pool.length);
      const s = pool.splice(i, 1)[0];
      // non-overlapping and on a fresh line
      if (usedLines.has(s.line)) continue;
      if (chosen.some((c) => !(s.end <= c.start || c.end <= s.start))) continue;
      chosen.push(s);
      usedLines.add(s.line);
    }
    const mutated = apply(src, chosen);
    process.stdout.write(
      JSON.stringify({
        mistakes: chosen.map(({ start, end, ...info }) => info),
        lines: chosen.map((s) => s.line).sort((a, b) => a - b),
        source: mutated,
      }) + "\n",
    );
  }
}

main();
