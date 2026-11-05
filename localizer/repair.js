#!/usr/bin/env node
"use strict";

// Candidate repairs for mistakes that consist of *missing* code, which no
// correction subset can point at (the missing code has no constraints):
//
//   add-return  a function without `return` whose result is used: the last
//               expression statement of its body becomes `return <expr>;`
//   add-await   inside an async function, a declaration or assignment whose
//               value is a promise that should have been awaited:
//               `const w = p;` becomes `const w = await p;`
//
//   node localizer/repair.js <file.js> <line,line,...>
//
// Only code related to the given (suspicious) lines is considered: functions
// whose header is on one of them or that are called on one of them, and
// declarations/assignments on them.  Prints a JSON list of
// {kind, line, description, source}; the caller checks which patched sources
// are well typed.

const acorn = require("acorn");
const fs = require("fs");

function parse(src) {
  for (const sourceType of ["script", "module"]) {
    try {
      return acorn.parse(src, { ecmaVersion: 2020, sourceType, allowReturnOutsideFunction: true, locations: true });
    } catch (e) {
      /* try the other source type */
    }
  }
  return null;
}

const isFunction = (n) =>
  n && (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression");

// Walk with the stack of enclosing functions.
function walk(node, visit, fns = []) {
  if (!node || typeof node.type !== "string") return;
  visit(node, fns);
  const inner = isFunction(node) ? [...fns, node] : fns;
  for (const k of Object.keys(node)) {
    if (k === "loc") continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit, inner));
    else if (v && typeof v.type === "string") walk(v, visit, inner);
  }
}

// Does fn return a value from its own body (not from nested functions)?
function returnsValue(fn) {
  let found = false;
  const visit = (n) => {
    if (!n || typeof n.type !== "string" || found) return;
    if (n !== fn && isFunction(n)) return;
    if (n.type === "ReturnStatement" && n.argument) found = true;
    for (const k of Object.keys(n)) {
      if (k === "loc") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === "string") visit(v);
    }
  };
  visit(fn);
  return found;
}

function main() {
  const [file, linesArg] = process.argv.slice(2);
  const src = fs.readFileSync(file, "utf8");
  const lines = new Set(String(linesArg ?? "").split(",").filter(Boolean).map(Number));
  const ast = parse(src);
  if (!ast) return console.log("[]");

  const fnByName = new Map(); // name -> function node (declarations and const f = ...)
  const calledOn = new Map(); // line -> names of functions called on it
  const repairs = [];
  const seen = new Set();
  const add = (kind, line, description, at, text) => {
    const source = src.slice(0, at) + text + src.slice(at);
    if (seen.has(source)) return;
    seen.add(source);
    repairs.push({ kind, line, description, source });
  };

  walk(ast, (n, fns) => {
    if (n.type === "FunctionDeclaration" && n.id) fnByName.set(n.id.name, n);
    if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && isFunction(n.init))
      fnByName.set(n.id.name, n.init);
    if (n.type === "CallExpression" && n.callee.type === "Identifier") {
      const L = n.loc.start.line;
      if (!calledOn.has(L)) calledOn.set(L, new Set());
      calledOn.get(L).add(n.callee.name);
    }
    // add-await: in an async function, the value of a declaration/assignment
    const fn = fns[fns.length - 1];
    if (!fn || !fn.async) return;
    let value = null;
    if (n.type === "VariableDeclarator" && n.init) value = n.init;
    if (n.type === "AssignmentExpression" && n.operator === "=") value = n.right;
    if (!value || value.type === "AwaitExpression" || isFunction(value)) return;
    const L = value.loc.start.line;
    if (!lines.has(L)) return;
    const text = src.slice(value.start, value.end);
    add("add-await", L, `await ${text}`, value.start, "await ");
  });

  // add-return: functions on a suspicious line, or called on one
  const fns = new Set();
  walk(ast, (n) => {
    if (isFunction(n) && lines.has(n.loc.start.line)) fns.add(n);
  });
  for (const L of lines)
    for (const name of calledOn.get(L) ?? []) if (fnByName.has(name)) fns.add(fnByName.get(name));
  for (const fn of fns) {
    if (fn.body.type !== "BlockStatement" || returnsValue(fn)) continue;
    const last = fn.body.body[fn.body.body.length - 1];
    if (!last || last.type !== "ExpressionStatement") continue;
    const name = fn.id?.name ?? "the function";
    const text = src.slice(last.expression.start, last.expression.end);
    add("add-return", last.loc.start.line, `return ${text}  (${name} has no return)`, last.start, "return ");
  }
  console.log(JSON.stringify(repairs));
}

main();
