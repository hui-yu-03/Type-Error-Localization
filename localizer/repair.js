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
// and three small fixes that real bug-fixing commits make (FixJS):
//
//   precedence     `!a === b` (always false: ! binds first) becomes `!(a === b)`
//   add-length     a comparison `n < xs` becomes `n < xs.length`, if xs is also
//                  used as a collection (indexed, xs.push(...), ...)
//   rename-member  a member that the program never defines and that is no
//                  built-in member, `user.nmae`, becomes the closest defined or
//                  built-in name (edit distance 1, or 2 for longer names)
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
const summaries = require("../summaries");

// Damerau-Levenshtein distance (with adjacent transpositions), bounded
function distance(a, b, bound) {
  if (Math.abs(a.length - b.length) > bound) return bound + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

function builtinMembers() {
  const names = new Set(["length", "then", "catch", "finally", "call", "apply", "bind", "prototype"]);
  for (const table of ["__typeMethods__", "__typeProps__"])
    for (const members of Object.values(summaries[table] ?? {})) Object.keys(members).forEach((k) => names.add(k));
  Object.keys(summaries.__objectProtoMethods__ ?? {}).forEach((k) => names.add(k));
  return names;
}

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
  const replace = (kind, line, description, start, end, text) => {
    const source = src.slice(0, start) + text + src.slice(end);
    if (seen.has(source)) return;
    seen.add(source);
    repairs.push({ kind, line, description, source });
  };
  const add = (kind, line, description, at, text) => replace(kind, line, description, at, at, text);
  const code = (n) => src.slice(n.start, n.end);

  // members the program defines (object literal keys, x.m = ..., class members)
  const defined = new Set();
  walk(ast, (n) => {
    if ((n.type === "Property" || n.type === "MethodDefinition" || n.type === "PropertyDefinition") && n.key)
      defined.add(n.key.type === "Identifier" ? n.key.name : String(n.key.value));
    if (n.type === "AssignmentExpression" && n.left.type === "MemberExpression" && !n.left.computed)
      defined.add(n.left.property.name);
  });
  const known = new Set([...defined, ...builtinMembers()]);
  // values the program also uses as a collection (xs[i], xs.push(...), ...):
  // only for those is a missing .length a likely fix
  const COLLECTION = new Set(["length", "push", "pop", "shift", "unshift", "splice", "slice", "map", "forEach",
    "filter", "reduce", "some", "every", "indexOf", "join", "concat", "sort", "reverse", "includes"]);
  const collections = new Set();
  walk(ast, (n) => {
    if (n.type === "MemberExpression" && (n.computed || COLLECTION.has(n.property.name))) collections.add(code(n.object));
  });
  walk(ast, (n) => {
    if (!n.loc || !lines.has(n.loc.start.line)) return;
    const L = n.loc.start.line;
    if (n.type === "BinaryExpression" && ["===", "!==", "==", "!="].includes(n.operator) &&
        n.left.type === "UnaryExpression" && n.left.operator === "!") {
      const text = `!(${code(n.left.argument)} ${n.operator} ${code(n.right)})`;
      replace("precedence", L, `${text}  (! binds before ${n.operator})`, n.start, n.end, text);
    }
    if (n.type === "BinaryExpression" && ["<", ">", "<=", ">="].includes(n.operator)) {
      for (const side of [n.left, n.right])
        if ((side.type === "Identifier" || side.type === "MemberExpression") && collections.has(code(side)))
          add("add-length", L, `${code(side)}.length`, side.end, ".length");
    }
    if (n.type === "MemberExpression" && !n.computed && n.property.type === "Identifier" && !known.has(n.property.name)) {
      const name = n.property.name;
      const bound = name.length > 5 ? 2 : 1;
      const close = [...known].filter((k) => distance(name, k, bound) <= bound)
        .sort((a, b) => distance(name, a, bound) - distance(name, b, bound) || a.localeCompare(b)).slice(0, 2);
      for (const k of close)
        replace("rename-member", L, `${code(n.object)}.${k}  (instead of .${name})`, n.property.start, n.property.end, k);
    }
  });

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
