#!/usr/bin/env node
"use strict";
// The functions of a JavaScript file, for extracting the functions a bug fix
// changes (bench/bugsjs.py):
//
//   node bench/functions.js FILE   ->  [{start, end, name}]  (1-based lines)
//
// Every function (declaration, expression, arrow function, method) with the
// lines it spans and a name: its own, or the key or variable it is assigned to.

const acorn = require("acorn");
const fs = require("fs");

const src = fs.readFileSync(process.argv[2], "utf8").replace(/^#!/, "//");
let ast = null;
for (const sourceType of ["script", "module"]) {
  try {
    ast = acorn.parse(src, { ecmaVersion: 2022, sourceType, allowReturnOutsideFunction: true, allowHashBang: true, locations: true });
    break;
  } catch (e) {
    /* try the other source type */
  }
}
const out = [];
const visit = (node, name) => {
  if (!node || typeof node.type !== "string") return;
  if (/Function/.test(node.type) && node.body) {
    out.push({ start: node.loc.start.line, end: node.loc.end.line, name: (node.id && node.id.name) || name || "" });
  }
  for (const key of Object.keys(node)) {
    if (key === "loc") continue;
    const v = node[key];
    let childName = null;
    if (node.type === "VariableDeclarator" && key === "init" && node.id.type === "Identifier") childName = node.id.name;
    if ((node.type === "Property" || node.type === "MethodDefinition") && key === "value" && node.key)
      childName = node.key.name || String(node.key.value);
    if (node.type === "AssignmentExpression" && key === "right")
      childName = src.slice(node.left.start, node.left.end);
    if (Array.isArray(v)) v.forEach((c) => visit(c, null));
    else if (v && typeof v.type === "string") visit(v, childName);
  }
};
if (ast) visit(ast, null);
console.log(JSON.stringify(out));
