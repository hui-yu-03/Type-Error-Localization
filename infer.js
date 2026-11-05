#!/usr/bin/env node
"use strict";

const acorn = require("acorn");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const stubs = require("./stubs");
const { buildStub } = require("./gen_stubs");
const summaries = require("./summaries");

// fresh type variable
let _cnt = 0;
const fresh = () => `T${++_cnt}`;

// constraint
const constraints = [];
// typeHints: TV → 'str' | 'num' | 'bool' | { kind: 'arr', elem: TV }
// Populated eagerly so MemberExpression can dispatch built-in type methods.
const typeHints = new Map();
const typeMethodCache = new Map(); // `${TV}::${propName}` → methodTV
// TV → { sig, propName } for module method TVs — propagated through assignments
// so that locally-bound module methods (e.g. var exec = cp.exec) are also dispatched.
const methodSummaryMap = new Map();
const _isPlainTV = (t) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t) && t !== "void";
function addCons(a, b) {
  constraints.push(`${a} <= ${b}`);
  if (b === "str" || b === "num" || b === "bool" || b === "regexp" || b === "error") {
    if (!typeHints.has(a)) typeHints.set(a, b);
    return;
  }
  const am = /^Array<(.+)>$/.exec(b);
  if (am) {
    if (!typeHints.has(a)) typeHints.set(a, { kind: "arr", elem: am[1] });
    return;
  }
  if (_isPlainTV(b)) {
    if (typeHints.has(b) && !typeHints.has(a))
      typeHints.set(a, typeHints.get(b));
    else if (typeHints.has(a) && !typeHints.has(b))
      typeHints.set(b, typeHints.get(a));
    if (methodSummaryMap.has(a) && !methodSummaryMap.has(b))
      methodSummaryMap.set(b, methodSummaryMap.get(a));
    else if (methodSummaryMap.has(b) && !methodSummaryMap.has(a))
      methodSummaryMap.set(a, methodSummaryMap.get(b));
  }
}

// deferred plus constraints: plus(X1, X2, Xr)
const plusConstraints = [];
const addPlus = (a, b, r) => plusConstraints.push(`plus(${a},${b},${r})`);

// deferred union constraints: union(X1, X2, Xr) — ternary branches
const unionConstraints = [];
function addUnion(a, b, r) {
  unionConstraints.push(`union(${a},${b},${r})`);
  // Propagate type hints eagerly so method dispatch works on the result TV.
  const ha = typeHints.get(a);
  const hb = typeHints.get(b);
  if (ha && hb) {
    if (JSON.stringify(ha) === JSON.stringify(hb)) {
      typeHints.set(r, ha);
    } else {
      typeHints.set(r, { kind: "union", hints: [ha, hb] });
    }
  } else if (ha) {
    typeHints.set(r, ha);
  } else if (hb) {
    typeHints.set(r, hb);
  }
}

// deferred logical-union constraints: logical_union(X1, X2, Xr) — && / || result
// More conservative than union(): both sides must be known to resolve the result.
const logicalUnionConstraints = [];
function addLogicalUnion(a, b, r) {
  logicalUnionConstraints.push(`logical_union(${a},${b},${r})`);
  const ha = typeHints.get(a);
  const hb = typeHints.get(b);
  if (ha && hb) {
    if (JSON.stringify(ha) === JSON.stringify(hb)) typeHints.set(r, ha);
    else typeHints.set(r, { kind: "union", hints: [ha, hb] });
  } else if (ha) {
    typeHints.set(r, ha);
  } else if (hb) {
    typeHints.set(r, hb);
  }
}

// deferred index constraints: index(Xobj, Xidx, Xresult)
const indexConstraints = [];
const addIndex = (obj, idx, result) =>
  indexConstraints.push(`index(${obj},${idx},${result})`);

// deferred template constraints: tpl(Xexpr)
const tplConstraints = [];
const addTpl = (expr) => tplConstraints.push(`tpl(${expr})`);

// build a Func type string: Func<qualName>{p1 -> p2 -> ... -> ret}
const funcType = (qualName, paramTVs, retTV) =>
  paramTVs.length === 0
    ? `Func<${qualName}>{() -> ${retTV}}`
    : `Func<${qualName}>{${[...paramTVs, retTV].join(" -> ")}}`;

// function parameter names
const functionParams = new Map();
// save function type variables
const functionTypes = new Map();
// resolver/rejector TV → promise resolve/reject target TV
const resolverTargets = new Map();
const rejectorTargets = new Map();
// typeof-guard: origTV → Set<jsType> — collected from typeof x === 'typename' guards
const typeofGuardMap = new Map();
// qualNames of async functions (return type is wrapped in Promise)
const asyncScopes = new Set();
// class methods: className -> [{name, params, ret}]
const classMethods = new Map();
// instance type variable -> className
const instanceClasses = new Map();
// constructor attrs: className -> [{name, tv}]
const classCtorParams = new Map();
// className -> qualName of the constructor (own or inherited)
const classCtorQualName = new Map();
// this.x = e attrs in non-constructor methods: qualName -> [{name, tv}]
const classMethodThisAttrs = new Map();
// pre-built fnEnvs for prototype-pattern methods: qualName -> fnEnv
const protoMethodEnvs = new Map();
// TV -> { modName: string, cache: Map<propName, methodTV> }
// Records TVs that represent lazy-module require() results.
const moduleTV = new Map();

// environment
const mkTV = (name, scope) => `${name}__${scope}`; //env = { "x" => "x__global" }

// Γ(x)
function envGet(env, name, scope) {
  if (!env.has(name)) env.set(name, mkTV(name, scope));
  return env.get(name);
}

// force declaration in the current scope
function envDeclare(env, name, scope) {
  const tv = mkTV(name, scope);
  env.set(name, tv);
  return tv;
}

// Lazily instantiate a single method from a known-module TV.
// Returns the method's function TV (cached), or null if Xobj is not a lazy module
// or the module has no summary for propName.
function accessModuleProp(Xobj, propName) {
  if (!moduleTV.has(Xobj)) return null;
  const { modName, cache, nativeMod } = moduleTV.get(Xobj);
  if (!summaries[modName]?.[propName] && !nativeMod) return null;
  if (cache.has(propName)) return cache.get(propName);
  let tv;
  if (summaries[modName]?.[propName]) {
    const sig = summaries[modName][propName];
    if (sig.kind === "prop") {
      if (sig.type === "stringmap") {
        tv = fresh();
        addCons(tv, "{}");
        typeHints.set(tv, { kind: "stringmap" });
      } else {
        tv = summaries.buildTypeTV(
          sig.type,
          `${modName}_${propName}`,
          fresh,
          addCons,
        );
      }
    } else {
      tv = summaries.buildMethodTV(modName, propName, sig, fresh, addCons);
      methodSummaryMap.set(tv, { sig, propName });
    }
  } else {
    // Demand-driven introspection for native/third-party modules not in summaries.
    let prop;
    try {
      prop = nativeMod[propName];
    } catch {
      return null;
    }
    if (prop === undefined) return null;
    tv = buildStub(prop, propName, fresh, addCons);
    if (!tv) return null;
  }
  cache.set(propName, tv);
  addCons(Xobj, `{${propName}: ${tv}}`);
  return tv;
}

// Dispatch a property/method access on a TV whose base type is known via typeHints.
// Returns a fresh method TV (cached), or null if no type hint or method known.
function accessTypeMethod(Xobj, propName) {
  const cacheKey = `${Xobj}::${propName}`;
  // Object.prototype methods exist on every value — intercept before hint check
  // so they never add a structural field to the receiver type.
  const objProto = summaries.__objectProtoMethods__?.[propName];
  if (objProto) {
    if (typeMethodCache.has(cacheKey)) return typeMethodCache.get(cacheKey);
    const tv = summaries.buildMethodTV(
      "__obj",
      propName,
      objProto,
      fresh,
      addCons,
    );
    typeMethodCache.set(cacheKey, tv);
    return tv;
  }
  const hint = typeHints.get(Xobj);
  if (!hint) return null;
  if (typeMethodCache.has(cacheKey)) return typeMethodCache.get(cacheKey);
  if (typeof hint === "object" && hint.kind === "arr") {
    return _accessArrayMethod(propName, hint.elem, cacheKey);
  }
  // stringmap hint — any property access yields str (e.g. process.env.KEY)
  if (typeof hint === "object" && hint.kind === "stringmap") {
    const tv = fresh();
    addCons(tv, "str");
    typeMethodCache.set(cacheKey, tv);
    return tv;
  }
  // union hint — try each component, return first match
  if (typeof hint === "object" && hint.kind === "union") {
    for (const h of hint.hints) {
      const props = summaries.__typeProps__?.[h] ?? {};
      if (propName in props) {
        const tv = fresh();
        addCons(tv, props[propName]);
        typeMethodCache.set(cacheKey, tv);
        return tv;
      }
      const methods = summaries.__typeMethods__?.[h];
      if (methods?.[propName]) {
        const tv = summaries.buildMethodTV(
          `__${h}`,
          propName,
          methods[propName],
          fresh,
          addCons,
        );
        typeMethodCache.set(cacheKey, tv);
        return tv;
      }
    }
    return null;
  }
  // str / num / bool — non-callable properties
  const props = summaries.__typeProps__?.[hint] ?? {};
  if (propName in props) {
    const tv = fresh();
    addCons(tv, props[propName]);
    typeMethodCache.set(cacheKey, tv);
    return tv;
  }
  // str / num / bool — methods
  const methods = summaries.__typeMethods__?.[hint];
  if (!methods?.[propName]) return null;
  const tv = summaries.buildMethodTV(
    `__${hint}`,
    propName,
    methods[propName],
    fresh,
    addCons,
  );
  typeMethodCache.set(cacheKey, tv);
  return tv;
}

// Methods that exist only on strings (not on plain objects or arrays). Accessing
// any of these on an untyped TV is strong evidence the value is a string.
const STRING_EXCLUSIVE_METHODS = new Set([
  "trim",
  "trimEnd",
  "trimStart",
  "trimLeft",
  "trimRight",
  "toLowerCase",
  "toUpperCase",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "split",
  "replace",
  "replaceAll",
  "startsWith",
  "endsWith",
  "padStart",
  "padEnd",
  "repeat",
  "charAt",
  "charCodeAt",
  "match",
  "search",
]);

// Methods that exist only on Arrays (not on str/num/bool). Accessing any of
// these on an untyped TV is strong evidence the value is an array.
const ARRAY_EXCLUSIVE_METHODS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "join",
  "forEach",
  "map",
  "filter",
  "reduce",
  "reduceRight",
  "find",
  "findIndex",
  "some",
  "every",
  "flat",
  "flatMap",
  "fill",
  "sort",
  "reverse",
]);

function _accessArrayMethod(propName, elemTV, cacheKey) {
  if (propName === "length") {
    const tv = fresh();
    addCons(tv, "num");
    typeMethodCache.set(cacheKey, tv);
    return tv;
  }
  const methodTV = fresh();
  switch (propName) {
    case "join": {
      const p = fresh();
      addCons(p, "str");
      const r = fresh();
      addCons(r, "str");
      addCons(methodTV, `Func<arr_join>{${p} -> ${r}}`);
      break;
    }
    case "push":
    case "unshift": {
      const p = fresh();
      addCons(p, elemTV);
      const r = fresh();
      addCons(r, "num");
      addCons(methodTV, `Func<arr_${propName}>{${p} -> ${r}}`);
      break;
    }
    case "pop":
    case "shift": {
      const r = fresh();
      addCons(r, elemTV);
      addCons(methodTV, `Func<arr_${propName}>{() -> ${r}}`);
      break;
    }
    case "includes": {
      const p = fresh();
      addCons(p, elemTV);
      const r = fresh();
      addCons(r, "bool");
      addCons(methodTV, `Func<arr_includes>{${p} -> ${r}}`);
      break;
    }
    case "indexOf":
    case "lastIndexOf": {
      const p = fresh();
      addCons(p, elemTV);
      const r = fresh();
      addCons(r, "num");
      addCons(methodTV, `Func<arr_${propName}>{${p} -> ${r}}`);
      break;
    }
    case "forEach": {
      const cbR = fresh();
      addCons(cbR, "void");
      const cb = fresh();
      addCons(cb, `Func<arr_forEach_cb>{${elemTV} -> ${cbR}}`);
      const r = fresh();
      addCons(r, "void");
      addCons(methodTV, `Func<arr_forEach>{${cb} -> ${r}}`);
      break;
    }
    case "some":
    case "every": {
      const cbR = fresh();
      addCons(cbR, "bool");
      const cb = fresh();
      addCons(cb, `Func<arr_${propName}_cb>{${elemTV} -> ${cbR}}`);
      const r = fresh();
      addCons(r, "bool");
      addCons(methodTV, `Func<arr_${propName}>{${cb} -> ${r}}`);
      break;
    }
    case "find": {
      const cbR = fresh();
      addCons(cbR, "bool");
      const cb = fresh();
      addCons(cb, `Func<arr_find_cb>{${elemTV} -> ${cbR}}`);
      const r = fresh();
      addCons(r, elemTV);
      addCons(methodTV, `Func<arr_find>{${cb} -> ${r}}`);
      break;
    }
    case "findIndex": {
      const cbR = fresh();
      addCons(cbR, "bool");
      const cb = fresh();
      addCons(cb, `Func<arr_findIndex_cb>{${elemTV} -> ${cbR}}`);
      const r = fresh();
      addCons(r, "num");
      addCons(methodTV, `Func<arr_findIndex>{${cb} -> ${r}}`);
      break;
    }
    case "map":
    case "flatMap": {
      const retElem = fresh();
      const cb = fresh();
      addCons(cb, `Func<arr_${propName}_cb>{${elemTV} -> ${retElem}}`);
      const r = fresh();
      addCons(r, `Array<${retElem}>`);
      addCons(methodTV, `Func<arr_${propName}>{${cb} -> ${r}}`);
      break;
    }
    case "filter": {
      const cbR = fresh();
      addCons(cbR, "bool");
      const cb = fresh();
      addCons(cb, `Func<arr_filter_cb>{${elemTV} -> ${cbR}}`);
      const r = fresh();
      addCons(r, `Array<${elemTV}>`);
      addCons(methodTV, `Func<arr_filter>{${cb} -> ${r}}`);
      break;
    }
    case "slice": {
      const p1 = fresh();
      addCons(p1, "num");
      const p2 = fresh();
      addCons(p2, "num");
      const r = fresh();
      addCons(r, `Array<${elemTV}>`);
      addCons(methodTV, `Func<arr_slice>{${p1} -> ${p2} -> ${r}}`);
      break;
    }
    case "concat": {
      const p = fresh();
      addCons(p, `Array<${elemTV}>`);
      const r = fresh();
      addCons(r, `Array<${elemTV}>`);
      addCons(methodTV, `Func<arr_concat>{${p} -> ${r}}`);
      break;
    }
    case "reverse": {
      const r = fresh();
      addCons(r, `Array<${elemTV}>`);
      addCons(methodTV, `Func<arr_reverse>{() -> ${r}}`);
      break;
    }
    case "sort": {
      const p1 = fresh();
      addCons(p1, elemTV);
      const p2 = fresh();
      addCons(p2, elemTV);
      const cbR = fresh();
      addCons(cbR, "num");
      const cb = fresh();
      addCons(cb, `Func<arr_sort_cb>{${p1} -> ${p2} -> ${cbR}}`);
      const r = fresh();
      addCons(r, `Array<${elemTV}>`);
      addCons(methodTV, `Func<arr_sort>{${cb} -> ${r}}`);
      break;
    }
    case "reduce": {
      const accTV = fresh();
      const cb = fresh();
      addCons(cb, `Func<arr_reduce_cb>{${accTV} -> ${elemTV} -> ${accTV}}`);
      addCons(methodTV, `Func<arr_reduce>{${cb} -> ${accTV} -> ${accTV}}`);
      break;
    }
    case "flat": {
      const r = fresh();
      addCons(r, "Array<{}>");
      addCons(methodTV, `Func<arr_flat>{() -> ${r}}`);
      break;
    }
    default:
      return null;
  }
  typeMethodCache.set(cacheKey, methodTV);
  return methodTV;
}

// -- typeof-guard extraction -------------------------------------------------
const TYPEOF_TYPE_MAP = { string: "str", number: "num", boolean: "bool" };
function extractTypeofGuard(testNode) {
  // Peel off && layers: `x && typeof x === 'str'`
  if (testNode.type === "LogicalExpression" && testNode.operator === "&&") {
    return extractTypeofGuard(testNode.right) ?? extractTypeofGuard(testNode.left);
  }
  if (testNode.type !== "BinaryExpression") return null;
  if (testNode.operator !== "===" && testNode.operator !== "==") return null;
  let typeofExpr, literalNode;
  if (
    testNode.left.type === "UnaryExpression" &&
    testNode.left.operator === "typeof" &&
    testNode.right.type === "Literal"
  ) {
    typeofExpr = testNode.left;
    literalNode = testNode.right;
  } else if (
    testNode.right.type === "UnaryExpression" &&
    testNode.right.operator === "typeof" &&
    testNode.left.type === "Literal"
  ) {
    typeofExpr = testNode.right;
    literalNode = testNode.left;
  } else {
    return null;
  }
  if (typeofExpr.argument.type !== "Identifier") return null;
  const jsType = TYPEOF_TYPE_MAP[literalNode.value];
  if (!jsType) return null;
  return { ident: typeofExpr.argument.name, jsType };
}

// -- parameter binding helper ------------------------------------------------
// Returns Array<{ name, tv }>.  ObjectPattern flattens to multiple entries.
function declareParam(p, fnEnv, qualName) {
  switch (p.type) {
    case "Identifier":
      return [{ name: p.name, tv: envDeclare(fnEnv, p.name, qualName) }];

    case "AssignmentPattern": {
      if (p.left.type === "ObjectPattern") {
        // e.g. { registry = "", timeout = null } = {}
        // The whole pattern is ONE object parameter; apply the outer default too.
        const entries = declareParam(p.left, fnEnv, qualName);
        const defTV = inferExpr(p.right, fnEnv, qualName);
        if (entries.length === 1) addCons(defTV, entries[0].tv);
        return entries;
      }
      // e.g.  x = 0
      const [{ name, tv }] = declareParam(p.left, fnEnv, qualName);
      const defTV = inferExpr(p.right, fnEnv, qualName);
      addCons(defTV, tv);
      return [{ name, tv }];
    }

    case "ObjectPattern": {
      // One object parameter destructured into named bindings.
      // Create a single TV for the whole object, then add a structural field
      // constraint for each property so the caller's object type is captured.
      const optsTV = fresh();
      addCons(optsTV, "{}");
      for (const prop of p.properties) {
        if (prop.type === "RestElement") continue;
        const keyName = prop.key?.name ?? prop.key?.value;
        if (!keyName) continue;
        const fieldTV = fresh();
        addCons(optsTV, `{${keyName}: ${fieldTV}}`);
        if (prop.value.type === "Identifier") {
          const localTV = envDeclare(fnEnv, prop.value.name, qualName);
          addCons(fieldTV, localTV);
        } else if (
          prop.value.type === "AssignmentPattern" &&
          prop.value.left.type === "Identifier"
        ) {
          const localTV = envDeclare(fnEnv, prop.value.left.name, qualName);
          addCons(fieldTV, localTV);
          const defTV = inferExpr(prop.value.right, fnEnv, qualName);
          addCons(defTV, localTV);
        }
      }
      return [{ name: "_opts", tv: optsTV }];
    }

    case "ArrayPattern": {
      // e.g.  function f([a, b]) — one array parameter; a,b are local element bindings
      const arrTV = fresh();
      const elemTV = fresh();
      addCons(arrTV, `Array<${elemTV}>`);
      for (const el of p.elements ?? []) {
        if (!el || el.type === "RestElement") continue;
        if (el.type === "Identifier") {
          const localTV = envDeclare(fnEnv, el.name, qualName);
          addCons(elemTV, localTV);
        }
      }
      return [{ name: `_arr`, tv: arrTV }];
    }

    case "RestElement":
      return [
        {
          name: p.argument.name,
          tv: envDeclare(fnEnv, p.argument.name, qualName),
        },
      ];

    default: {
      const n = `_unk${fresh()}`;
      return [{ name: n, tv: fresh() }];
    }
  }
}

// Walk up the scope chain (by stripping the innermost "name__" prefix) to find
// the nearest scope that has a classMethodThisAttrs entry.  Returns the scope
// string if found, null otherwise.
function findMethodScope(scope) {
  let s = scope;
  while (s) {
    if (classMethodThisAttrs.has(s)) return s;
    const idx = s.indexOf("__");
    if (idx < 0) return null;
    s = s.slice(idx + 2);
  }
  return null;
}

// -- function node helper ----------------------------------------------------
// for FunctionExpression, ArrowFunctionExpression,
// and the FunctionExpression-as-property case inside ObjectExpression.
function inferFuncNode(funcNode, fnName, fnScope, env, xTarget, thisTV = null) {
  const qualName = `${fnName}__${fnScope}`;

  if (funcNode.async) {
    asyncScopes.add(qualName);
    const X_rej = fresh();
    addCons(`ret__${qualName}`, `Promise<async_inner__${qualName},${X_rej}>`);
  }

  const fnEnv = new Map(env);
  // Bind `this` for regular (non-arrow) functions assigned to a property.
  if (thisTV !== null && funcNode.type === "FunctionExpression") {
    fnEnv.set("this", thisTV);
  }
  // `arguments` is implicitly available in every non-arrow function.
  if (funcNode.type !== "ArrowFunctionExpression") {
    const Xargs = fresh();
    addCons(Xargs, `Array<{}>`);
    fnEnv.set("arguments", Xargs);
  }
  const paramNames = [];
  const paramTVs = [];
  for (const p of funcNode.params) {
    for (const { name, tv } of declareParam(p, fnEnv, qualName)) {
      paramNames.push(name);
      paramTVs.push(tv);
    }
  }
  functionParams.set(qualName, paramNames);

  let hasReturn;
  if (
    funcNode.type === "ArrowFunctionExpression" &&
    funcNode.body.type !== "BlockStatement"
  ) {
    const Xbody = inferExpr(funcNode.body, fnEnv, qualName);
    addCons(
      Xbody,
      funcNode.async ? `async_inner__${qualName}` : `ret__${qualName}`,
    );
    hasReturn = true;
  } else {
    hasReturn = inferStmt(funcNode.body, fnEnv, qualName);
  }

  if (!hasReturn) {
    addCons(
      "void",
      funcNode.async ? `async_inner__${qualName}` : `ret__${qualName}`,
    );
  }

  const retTV = `ret__${qualName}`;
  functionTypes.set(qualName, { params: paramTVs, ret: retTV });

  if (xTarget) {
    addCons(xTarget, funcType(qualName, paramTVs, retTV));
    typeHints.set(xTarget, "func");
  }

  return;
}

// -- Promise helpers ---------------------------------------------------------
function inferNewPromise(node, env, scope) {
  const X_res = fresh();
  const X_rej = fresh();
  const X_p = fresh();
  addCons(X_p, `Promise<${X_res},${X_rej}>`);

  const executor = node.arguments[0];
  if (!executor) return X_p;

  const execName = executor.id?.name ?? `executor_${fresh()}`;
  const execQualName = `${execName}__${scope}`;
  const execEnv = new Map(env);
  const [resParam, rejParam] = executor.params ?? [];

  if (resParam?.type === "Identifier") {
    const resTV = envDeclare(execEnv, resParam.name, execQualName);
    resolverTargets.set(resTV, X_res);
    addCons(resTV, `Resolver<${X_res}>`);
  }

  if (rejParam?.type === "Identifier") {
    const rejTV = envDeclare(execEnv, rejParam.name, execQualName);
    rejectorTargets.set(rejTV, X_rej);
    addCons(rejTV, `Rejector<${X_rej}>`);
  }

  if (executor.body?.type === "BlockStatement") {
    inferStmt(executor.body, execEnv, execQualName);
  } else if (executor.body) {
    inferExpr(executor.body, execEnv, execQualName);
  }

  return X_p;
}

function inferPromiseThen(node, env, scope) {
  const X_promise = inferExpr(node.callee.object, env, scope);
  const X_res = fresh();
  const X_rej = fresh();
  addCons(X_promise, `Promise<${X_res},${X_rej}>`);

  const cb = node.arguments[0];
  let X_cb_ret = fresh();

  if (
    cb &&
    (cb.type === "FunctionExpression" || cb.type === "ArrowFunctionExpression")
  ) {
    const cbName = cb.id?.name ?? `then_cb_${fresh()}`;
    const cbQualName = `${cbName}__${scope}`;
    const cbEnv = new Map(env);
    const paramNames = [],
      paramTVs = [];
    for (const p of cb.params)
      for (const { name, tv } of declareParam(p, cbEnv, cbQualName)) {
        paramNames.push(name);
        paramTVs.push(tv);
      }
    functionParams.set(cbQualName, paramNames);
    if (paramTVs.length > 0) addCons(X_res, paramTVs[0]);

    let hasReturn;
    if (
      cb.type === "ArrowFunctionExpression" &&
      cb.body.type !== "BlockStatement"
    ) {
      addCons(inferExpr(cb.body, cbEnv, cbQualName), `ret__${cbQualName}`);
      hasReturn = true;
    } else {
      hasReturn = inferStmt(cb.body, cbEnv, cbQualName);
    }
    if (!hasReturn) addCons("void", `ret__${cbQualName}`);
    X_cb_ret = `ret__${cbQualName}`;
    functionTypes.set(cbQualName, { params: paramTVs, ret: X_cb_ret });
  } else if (cb) {
    // Callback is a reference (identifier or expression), e.g. .then(buildCredential).
    // Treat it as a 1-arg function: its param unifies with the upstream resolve type
    // and its return type becomes the downstream resolve type.
    const X_cb = inferExpr(cb, env, scope);
    const X_param = fresh();
    addCons(X_res, X_param);
    X_cb_ret = fresh();
    addCons(X_cb, `Func<then_ref>{${X_param} -> ${X_cb_ret}}`);
  }

  const X_result = fresh();
  addCons(X_result, `Promise<${X_cb_ret},${X_rej}>`);
  return X_result;
}

function inferPromiseCatch(node, env, scope) {
  const X_promise = inferExpr(node.callee.object, env, scope);
  const X_res = fresh();
  const X_rej = fresh();
  addCons(X_promise, `Promise<${X_res},${X_rej}>`);

  const cb = node.arguments[0];
  let X_cb_ret = fresh();

  if (
    cb &&
    (cb.type === "FunctionExpression" || cb.type === "ArrowFunctionExpression")
  ) {
    const cbName = cb.id?.name ?? `catch_cb_${fresh()}`;
    const cbQualName = `${cbName}__${scope}`;
    const cbEnv = new Map(env);
    const paramNames = [],
      paramTVs = [];
    for (const p of cb.params)
      for (const { name, tv } of declareParam(p, cbEnv, cbQualName)) {
        paramNames.push(name);
        paramTVs.push(tv);
      }
    functionParams.set(cbQualName, paramNames);
    if (paramTVs.length > 0) addCons(X_rej, paramTVs[0]);

    let hasReturn;
    if (
      cb.type === "ArrowFunctionExpression" &&
      cb.body.type !== "BlockStatement"
    ) {
      addCons(inferExpr(cb.body, cbEnv, cbQualName), `ret__${cbQualName}`);
      hasReturn = true;
    } else {
      hasReturn = inferStmt(cb.body, cbEnv, cbQualName);
    }
    if (!hasReturn) addCons("void", `ret__${cbQualName}`);
    X_cb_ret = `ret__${cbQualName}`;
    functionTypes.set(cbQualName, { params: paramTVs, ret: X_cb_ret });
  } else if (cb) {
    inferExpr(cb, env, scope);
  }

  const X_result = fresh();
  addCons(X_result, `Promise<${X_res},${X_cb_ret}>`);
  return X_result;
}

function inferPromiseSettle(node, env, scope, slot) {
  const arg = node.arguments[0];
  const X_arg = arg ? inferExpr(arg, env, scope) : "void";
  const X_res = fresh();
  const X_rej = fresh();
  addCons(X_arg, slot === "resolve" ? X_res : X_rej);
  const X_p = fresh();
  addCons(X_p, `Promise<${X_res},${X_rej}>`);
  return X_p;
}

function inferPromiseAll(node, env, scope) {
  const arg = node.arguments[0];
  const X_arr = arg ? inferExpr(arg, env, scope) : fresh();
  const X_elem = fresh();
  const X_res = fresh();
  const X_rej = fresh();
  addCons(X_arr, `Array<${X_elem}>`);
  addCons(X_elem, `Promise<${X_res},${X_rej}>`);
  const X_result_arr = fresh();
  addCons(X_result_arr, `Array<${X_res}>`);
  const X_p = fresh();
  addCons(X_p, `Promise<${X_result_arr},${X_rej}>`);
  return X_p;
}

// for function as a property of the object
function inferObjectExpr(node, env, scope, ownerName) {
  const Xobj = fresh();

  if (node.properties.length === 0) {
    addCons(Xobj, "{}");
    return Xobj;
  }

  for (const p of node.properties) {
    if (p.type === "SpreadElement") {
      inferExpr(p.argument, env, scope);
      continue;
    }
    const key = String(p.key.name ?? p.key.value);
    let Xval;

    if (
      p.value.type === "FunctionExpression" ||
      p.value.type === "ArrowFunctionExpression"
    ) {
      const localName = p.value.id?.name ?? key;
      const fnName = ownerName ? `${ownerName}.${localName}` : localName;
      const fnScope = scope;
      const Xval_fn = fresh();
      const objThisTV = p.value.type === "FunctionExpression" ? Xobj : null;
      inferFuncNode(p.value, fnName, fnScope, env, Xval_fn, objThisTV);
      Xval = Xval_fn;
    } else {
      Xval = inferExpr(p.value, env, scope);
    }

    addCons(Xobj, `{${key}: ${Xval}}`);
  }

  return Xobj;
}

// -- Class instance helper ---------------------------------------------------
function inferNewInstance(node, env, scope) {
  const className = node.callee.name;
  const ctorAttrs = classCtorParams.get(className) ?? [];
  const ctorQName = classCtorQualName.get(className);
  const ctorInfo = ctorQName ? functionTypes.get(ctorQName) : undefined;

  const argTVs = [];
  for (const arg of node.arguments) argTVs.push(inferExpr(arg, env, scope));

  if (ctorInfo) {
    argTVs.forEach((argTV, i) => {
      if (ctorInfo.params[i]) addCons(argTV, ctorInfo.params[i]);
    });
  }

  const Xinst = fresh();
  const methods = classMethods.get(className);
  const attrSig = ctorAttrs.map((a) => `${a.name}: ${a.tv}`).join(", ");
  const methodSig = methods
    .map((m) =>
      m.params.length === 0
        ? `${m.name}: void -> ${m.ret}`
        : `${m.name}: ${[...m.params, m.ret].join(" -> ")}`,
    )
    .join(", ");
  const parts = [];
  if (attrSig) parts.push(attrSig);
  if (methodSig) parts.push(methodSig);
  addCons(Xinst, `Obj<${className}>[${parts.join(", ")}]`);
  instanceClasses.set(Xinst, className);
  return Xinst;
}

// -- Class node helper --------------------------------------------------------
function setupProtoClasses(protoGroups, statements, env, scope) {
  for (const [ctorName, methodList] of protoGroups) {
    // Find the constructor body node
    let ctorBody = null;
    for (const s of statements) {
      if (s.type === "FunctionDeclaration" && s.id?.name === ctorName) {
        ctorBody = s.body;
        break;
      }
      if (s.type === "VariableDeclaration") {
        for (const d of s.declarations) {
          if (
            d.id?.name === ctorName &&
            (d.init?.type === "FunctionExpression" ||
              d.init?.type === "ArrowFunctionExpression")
          ) {
            ctorBody = d.init.body;
            break;
          }
        }
      }
      if (ctorBody) break;
    }

    // Collect this.x = ... field names from constructor body
    const ctorFields = [];
    if (ctorBody?.type === "BlockStatement") {
      for (const stmt of ctorBody.body) {
        if (
          stmt.type === "ExpressionStatement" &&
          stmt.expression?.type === "AssignmentExpression" &&
          stmt.expression.operator === "=" &&
          stmt.expression.left?.type === "MemberExpression" &&
          stmt.expression.left.object?.type === "ThisExpression" &&
          !stmt.expression.left.computed
        ) {
          const fname = stmt.expression.left.property.name;
          if (!ctorFields.includes(fname)) ctorFields.push(fname);
        }
      }
    }

    const ctorAttrs = ctorFields.map((name) => ({ name, tv: fresh() }));
    classCtorParams.set(ctorName, ctorAttrs);

    const ctorQualName = `${ctorName}__${scope}`;
    classCtorQualName.set(ctorName, ctorQualName);
    // Register ctor scope so this.x = ... writes in the ctor body share the TVs
    classMethodThisAttrs.set(ctorQualName, ctorAttrs.map((a) => ({ ...a })));

    // Declare params/ret TVs and scan this.x writes for each method
    const methodDefs = [];
    for (const { methodName, funcNode } of methodList) {
      const qualName = `${methodName}__${ctorName}`;
      const fnEnv = new Map(env);
      const paramNames = [],
        paramTVs = [];
      for (const p of funcNode.params) {
        for (const { name: pn, tv } of declareParam(p, fnEnv, qualName)) {
          paramNames.push(pn);
          paramTVs.push(tv);
        }
      }
      functionParams.set(qualName, paramNames);
      const retTV = `ret__${qualName}`;
      functionTypes.set(qualName, { params: paramTVs, ret: retTV });

      const thisAttrs = [];
      for (const stmt of funcNode.body?.body ?? []) {
        if (
          stmt.type === "ExpressionStatement" &&
          stmt.expression?.type === "AssignmentExpression" &&
          stmt.expression.operator === "=" &&
          stmt.expression.left?.type === "MemberExpression" &&
          stmt.expression.left.object?.type === "ThisExpression" &&
          !stmt.expression.left.computed
        ) {
          const fname = stmt.expression.left.property.name;
          if (!thisAttrs.some((a) => a.name === fname))
            thisAttrs.push({ name: fname, tv: fresh() });
        }
      }
      classMethodThisAttrs.set(qualName, thisAttrs);

      methodDefs.push({ name: methodName, params: paramTVs, ret: retTV, qualName, fnEnv });
      protoMethodEnvs.set(qualName, fnEnv);
    }
    classMethods.set(
      ctorName,
      methodDefs.map((m) => ({ name: m.name, params: m.params, ret: m.ret })),
    );

    // Pre-seed: ctor attrs + sibling method TVs into each method's classMethodThisAttrs
    const methodFieldTVs = new Map();
    for (const mDef of methodDefs) {
      const mfv = fresh();
      const sig =
        mDef.params.length === 0
          ? `Func<${mDef.qualName}>{void -> ${mDef.ret}}`
          : `Func<${mDef.qualName}>{${[...mDef.params, mDef.ret].join(" -> ")}}`;
      addCons(mfv, sig);
      methodFieldTVs.set(mDef.name, mfv);
    }
    for (const mDef of methodDefs) {
      const thisAttrs = classMethodThisAttrs.get(mDef.qualName) ?? [];
      for (const ctorAttr of ctorAttrs) {
        if (!thisAttrs.some((a) => a.name === ctorAttr.name))
          thisAttrs.push({ name: ctorAttr.name, tv: ctorAttr.tv });
      }
      for (const [mName, mTV] of methodFieldTVs) {
        if (!thisAttrs.some((a) => a.name === mName))
          thisAttrs.push({ name: mName, tv: mTV });
      }
      classMethodThisAttrs.set(mDef.qualName, thisAttrs);
    }

    // Generate Class<> constraint on the constructor TV, mirroring inferClassNode.
    const attrSig = ctorAttrs.map((a) => `${a.name}: ${a.tv}`).join(", ");
    const methodSig = methodDefs
      .map((m) =>
        m.params.length === 0
          ? `${m.name}: void -> ${m.ret}`
          : `${m.name}: ${[...m.params, m.ret].join(" -> ")}`,
      )
      .join(", ");
    const classParts = [];
    if (attrSig) classParts.push(attrSig);
    if (methodSig) classParts.push(methodSig);
    const ctorTV = mkTV(ctorName, scope);
    addCons(ctorTV, `Class<${ctorName}>[${classParts.join(", ")}]`);
  }
}

function inferClassNode(node, className, env) {
  const methods = [];
  const attrs = [];

  if (node.superClass?.type === "Identifier") {
    const parentName = node.superClass.name;
    if (classMethods.has(parentName)) {
      methods.push(...classMethods.get(parentName));
    }
    // inherit parent ctor attrs
    if (classCtorParams.has(parentName))
      attrs.push(...classCtorParams.get(parentName));
    const hasOwnCtor = node.body.body.some(
      (m) => m.type === "MethodDefinition" && m.key.name === "constructor",
    );
    if (!hasOwnCtor && classCtorQualName.has(parentName)) {
      classCtorQualName.set(className, classCtorQualName.get(parentName));
    }
  }

  // declare params/ret TVs for every method; handle constructor specially.
  const methodEntries = [];
  for (const m of node.body.body) {
    if (m.type !== "MethodDefinition") continue;
    const methodName = m.key.name;

    if (methodName === "constructor") {
      const qualName = `constructor__${className}`;
      const fnEnv = new Map(env);
      const paramNames = [],
        paramTVs = [];
      for (const p of m.value.params) {
        for (const { name: pn, tv } of declareParam(p, fnEnv, qualName)) {
          paramNames.push(pn);
          paramTVs.push(tv);
        }
      }
      functionParams.set(qualName, paramNames);
      const retTV = `ret__${qualName}`;
      functionTypes.set(qualName, { params: paramTVs, ret: retTV });
      classCtorQualName.set(className, qualName);

      // Collect this.x = param patterns from the constructor body
      const ownAttrs = [];
      for (const stmt of m.value.body?.body ?? []) {
        if (
          stmt.type === "ExpressionStatement" &&
          stmt.expression.type === "AssignmentExpression" &&
          stmt.expression.operator === "=" &&
          stmt.expression.left.type === "MemberExpression" &&
          stmt.expression.left.object.type === "ThisExpression" &&
          !stmt.expression.left.computed &&
          stmt.expression.right.type === "Identifier"
        ) {
          const attrName = stmt.expression.left.property.name;
          const paramName = stmt.expression.right.name;
          const paramTV = fnEnv.has(paramName)
            ? fnEnv.get(paramName)
            : mkTV(paramName, qualName);
          if (!ownAttrs.some((a) => a.name === attrName)) {
            ownAttrs.push({ name: attrName, tv: paramTV });
          }
        }
      }

      // Update inherited attrs: if child's constructor has a same-named param, use child's TV
      for (let i = 0; i < attrs.length; i++) {
        if (fnEnv.has(attrs[i].name)) {
          attrs[i] = { name: attrs[i].name, tv: fnEnv.get(attrs[i].name) };
        }
      }
      // Add/override with child's own attrs
      for (const a of ownAttrs) {
        const idx = attrs.findIndex((x) => x.name === a.name);
        if (idx >= 0) attrs[idx] = a;
        else attrs.push(a);
      }

      methodEntries.push({ m, fnEnv, qualName, isCtor: true });
      continue;
    }

    const qualName = `${methodName}__${className}`;
    const fnEnv = new Map(env);
    const paramNames = [],
      paramTVs = [];
    for (const p of m.value.params) {
      for (const { name: pn, tv } of declareParam(p, fnEnv, qualName)) {
        paramNames.push(pn);
        paramTVs.push(tv);
      }
    }
    functionParams.set(qualName, paramNames);
    const retTV = `ret__${qualName}`;
    functionTypes.set(qualName, { params: paramTVs, ret: retTV });

    // Scan top-level body for this.x = e patterns; pre-allocate a field TV for each
    const thisAttrs = [];
    for (const stmt of m.value.body?.body ?? []) {
      if (
        stmt.type === "ExpressionStatement" &&
        stmt.expression.type === "AssignmentExpression" &&
        stmt.expression.operator === "=" &&
        stmt.expression.left.type === "MemberExpression" &&
        stmt.expression.left.object.type === "ThisExpression" &&
        !stmt.expression.left.computed
      ) {
        const fieldName = stmt.expression.left.property.name;
        if (!thisAttrs.some((a) => a.name === fieldName)) {
          thisAttrs.push({ name: fieldName, tv: fresh() });
        }
      }
    }
    classMethodThisAttrs.set(qualName, thisAttrs);

    const entry = { name: methodName, params: paramTVs, ret: retTV, qualName };
    const idx = methods.findIndex((x) => x.name === methodName);
    if (idx >= 0) methods[idx] = entry;
    else methods.push(entry);
    methodEntries.push({ m, fnEnv, qualName, isCtor: false });
  }

  // store attrs and pre-register so bodies can resolve self/sibling references
  classCtorParams.set(className, attrs);
  classMethods.set(className, methods);
  if (node.id?.name && node.id.name !== className) {
    classMethods.set(node.id.name, methods);
    classCtorParams.set(node.id.name, attrs);
    if (classCtorQualName.has(className))
      classCtorQualName.set(node.id.name, classCtorQualName.get(className));
  }

  // Pre-seed each method's classMethodThisAttrs with:
  //   - constructor attrs: links this.field in any method to the same TV as
  //     the corresponding constructor param, so field-type constraints flow
  //     between methods and the constructor.
  //   - sibling method TVs: links this.method(args) calls inside one method
  //     to the actual method signature, so argument types propagate correctly.
  //     Getters are seeded with their return-value TV (property access = call).
  const methodFieldTVs = new Map(); // methodName → TV for this.method reads
  for (const { m, qualName: mq, isCtor: ic } of methodEntries) {
    if (ic) continue;
    const mName = m.key.name;
    const mDef = methods.find((e) => e.name === mName);
    if (!mDef) continue;
    if (m.kind === "get") {
      methodFieldTVs.set(mName, mDef.ret);
    } else if (m.kind === "method") {
      const mfv = fresh();
      const sig =
        mDef.params.length === 0
          ? `Func<${mq}>{void -> ${mDef.ret}}`
          : `Func<${mq}>{${[...mDef.params, mDef.ret].join(" -> ")}}`;
      addCons(mfv, sig);
      methodFieldTVs.set(mName, mfv);
    }
  }
  for (const { qualName: mq, isCtor: ic } of methodEntries) {
    if (ic) continue;
    const thisAttrs = classMethodThisAttrs.get(mq) ?? [];
    for (const ctorAttr of attrs) {
      if (!thisAttrs.some((a) => a.name === ctorAttr.name))
        thisAttrs.push({ name: ctorAttr.name, tv: ctorAttr.tv });
    }
    for (const [mName, mTV] of methodFieldTVs) {
      if (!thisAttrs.some((a) => a.name === mName))
        thisAttrs.push({ name: mName, tv: mTV });
    }
    classMethodThisAttrs.set(mq, thisAttrs);
  }

  // process method bodies
  for (const { m, fnEnv, qualName, isCtor } of methodEntries) {
    if (isCtor) {
      addCons("void", `ret__${qualName}`);
      continue;
    }
    if (m.value.async) {
      asyncScopes.add(qualName);
      const X_rej = fresh();
      addCons(`ret__${qualName}`, `Promise<async_inner__${qualName},${X_rej}>`);
    }
    let hasReturn;
    if (
      m.value.type === "ArrowFunctionExpression" &&
      m.value.body.type !== "BlockStatement"
    ) {
      const Xbody = inferExpr(m.value.body, fnEnv, qualName);
      addCons(
        Xbody,
        m.value.async ? `async_inner__${qualName}` : `ret__${qualName}`,
      );
      hasReturn = true;
    } else {
      hasReturn = inferStmt(m.value.body, fnEnv, qualName);
    }
    if (!hasReturn) {
      addCons(
        "void",
        m.value.async ? `async_inner__${qualName}` : `ret__${qualName}`,
      );
    }
  }

  const attrSig = attrs.map((a) => `${a.name}: ${a.tv}`).join(", ");
  const methodSig = methods
    .map((m) =>
      m.params.length === 0
        ? `${m.name}: void -> ${m.ret}`
        : `${m.name}: ${[...m.params, m.ret].join(" -> ")}`,
    )
    .join(", ");
  const parts = [];
  if (attrSig) parts.push(attrSig);
  if (methodSig) parts.push(methodSig);
  return parts.join(", ");
}

// Build a mapping from arg index → param index, honouring optional params.
// Optional params are skipped when there are not enough args to cover all
// required params after them.
function _buildArgParamMap(params, nArgs) {
  const nParams = params.length;
  // requiredAfter[i] = number of required params at positions >= i
  const requiredAfter = new Array(nParams + 1).fill(0);
  for (let i = nParams - 1; i >= 0; i--)
    requiredAfter[i] = requiredAfter[i + 1] + (params[i]?.optional ? 0 : 1);

  const argToParam = new Map();
  let ai = 0;
  for (let pi = 0; pi < nParams && ai < nArgs; pi++) {
    if (params[pi]?.optional && nArgs - ai <= requiredAfter[pi]) continue;
    argToParam.set(ai++, pi);
  }
  return argToParam;
}

// Apply a module method's declared signature to a list of argument AST nodes.
// Used both for direct mod.method(args) calls and locally-bound method calls.
function applyModuleMethodCall(sig, propName, argNodes, env, scope) {
  const argToParam = _buildArgParamMap(sig.params, argNodes.length);
  for (let ai = 0; ai < argNodes.length; ai++) {
    const arg = argNodes[ai];
    const pi = argToParam.get(ai);
    const Xi = inferExpr(arg, env, scope);
    const paramSpec = pi !== undefined ? sig.params[pi] : undefined;
    if (paramSpec === undefined) continue;
    if (
      paramSpec &&
      typeof paramSpec === "object" &&
      paramSpec.kind === "obj" &&
      arg.type === "ObjectExpression"
    ) {
      addCons(Xi, "{}");
      if (paramSpec._sharedTV) addCons(paramSpec._sharedTV, "{}");
      for (const prop of arg.properties) {
        if (prop.computed || prop.type === "SpreadElement") continue;
        const fieldName =
          prop.key.type === "Identifier"
            ? prop.key.name
            : (prop.key.value ?? null);
        if (fieldName && paramSpec.fields[fieldName] !== undefined) {
          const fTV = summaries.buildTypeTV(
            paramSpec.fields[fieldName],
            `${propName}_${fieldName}`,
            fresh,
            addCons,
          );
          addCons(Xi, `{${fieldName}: ${fTV}}`);
          if (paramSpec._sharedTV)
            addCons(paramSpec._sharedTV, `{${fieldName}: ${fTV}}`);
        }
      }
    } else {
      const pTV = summaries.buildTypeTV(
        paramSpec,
        `${propName}_p${pi}`,
        fresh,
        addCons,
      );
      addCons(Xi, pTV);
    }
  }
  return summaries.buildTypeTV(sig.ret, `${propName}_ret`, fresh, addCons);
}

// -- Expression inference ----------------------------------------------------
function inferExpr(node, env, scope) {
  if (!node) return fresh();

  switch (node.type) {
    // -- Primitives and Variables ----------------------------------
    case "Literal": {
      // e.g. 3, "haha", true, /pattern/flags
      const X = fresh();
      if (typeof node.value === "number") addCons(X, "num");
      else if (typeof node.value === "string") addCons(X, "str");
      else if (typeof node.value === "boolean") addCons(X, "bool");
      else if (node.regex) addCons(X, "regexp");
      return X;
    }

    // Templates are always strings. Tagged templates not so, but that is a different case
    case "TemplateLiteral": {
      const X = fresh();
      addCons(X, "str");
      for (const expr of node.expressions) {
        const Xexpr = inferExpr(expr, env, scope);
        addTpl(Xexpr);
      }
      return X;
    }

    // TODO: TaggedTemplateExpression

    case "Identifier": {
      // e.g. x, y,...
      return envGet(env, node.name, scope);
    }

    case "ThisExpression":
      return envGet(env, "this", scope);

    // -- Operations ------------------------------------------------
    case "BinaryExpression":
    case "LogicalExpression": {
      // e.g. a + b, a > b, a && b,...
      const X1 = inferExpr(node.left, env, scope);
      const X2 = inferExpr(node.right, env, scope);
      const Xr = fresh();
      const op = node.operator;

      if (op === "+") {
        addPlus(X1, X2, Xr);
      } else if (["-", "*", "/", "%"].includes(op)) {
        addCons(X1, "num");
        addCons(X2, "num");
        addCons(Xr, "num");
      } else if (
        ["<", ">", "<=", ">=", "==", "===", "!=", "!=="].includes(op)
      ) {
        addCons(X1, X2);
        addCons(X2, X1);
        addCons(Xr, "bool");
      } else if (["&&", "||"].includes(op)) {
        // Result is one of the operands, but only resolvable when both sides are known.
        addLogicalUnion(X1, X2, Xr);
      }
      return Xr;
    }

    case "UnaryExpression": {
      const Xa = inferExpr(node.argument, env, scope);
      if (node.operator === "typeof") {
        // typeof always returns a string; the argument is unconstrained.
        const Xr = fresh();
        addCons(Xr, "str");
        return Xr;
      }
      if (node.operator === "!") {
        // ! works on any truthy/falsy value; operand is unconstrained.
        const Xr = fresh();
        addCons(Xr, "bool");
        return Xr;
      }
      if (["-", "+"].includes(node.operator)) {
        addCons(Xa, "num");
        const Xr = fresh();
        addCons(Xr, "num");
        return Xr;
      }
      return Xa;
    }

    case "UpdateExpression": {
      // e.g. x++, x--,...
      const Xa = inferExpr(node.argument, env, scope);
      addCons(Xa, "num");
      return Xa;
    }

    case "ConditionalExpression": {
      // e.g. e1 ? e2 : e3
      const Xcond = inferExpr(node.test, env, scope);
      const X2 = inferExpr(node.consequent, env, scope);
      const X3 = inferExpr(node.alternate, env, scope);
      const Xr = fresh();
      addUnion(X2, X3, Xr);
      return Xr;
    }

    case "SequenceExpression": {
      // (e1, e2, ..., en)
      let Xlast;
      for (const expr of node.expressions) {
        Xlast = inferExprStmt(expr, env, scope);
      }
      return Xlast;
    }

    // -- Objects, Arrays and Functions -----------------------------
    case "ObjectExpression": {
      // e.g. {e1, e2, ..., en}
      return inferObjectExpr(node, env, scope, null);
    }

    case "MemberExpression": {
      // this.prop read inside a class method — use the shared field TV so reads
      // and writes share one TV per field, even in nested arrow functions.
      if (!node.computed && node.object.type === "ThisExpression") {
        const methodScope = findMethodScope(scope);
        if (methodScope) {
          const fieldName = node.property.name;
          const attrs = classMethodThisAttrs.get(methodScope);
          let attr = attrs.find((a) => a.name === fieldName);
          if (!attr) {
            attr = { name: fieldName, tv: fresh() };
            attrs.push(attr);
          }
          return attr.tv;
        }
      }
      // e.g. obj.prop, arr[index], ...
      const Xobj = inferExpr(node.object, env, scope);

      if (!node.computed) {
        // obj.prop — intercept lazy module access then built-in type methods
        const propTV = accessModuleProp(Xobj, node.property.name);
        if (propTV !== null) return propTV;
        const typeTV = accessTypeMethod(Xobj, node.property.name);
        if (typeTV !== null) return typeTV;
        // String-exclusive method on an untyped TV → constrain receiver as str.
        if (
          !typeHints.has(Xobj) &&
          STRING_EXCLUSIVE_METHODS.has(node.property.name)
        ) {
          addCons(Xobj, "str");
          typeHints.set(Xobj, "str");
          return accessTypeMethod(Xobj, node.property.name);
        }
        // Array-exclusive method on an untyped TV → constrain receiver as array.
        if (
          !typeHints.has(Xobj) &&
          ARRAY_EXCLUSIVE_METHODS.has(node.property.name)
        ) {
          const elemTV = fresh();
          addCons(Xobj, `Array<${elemTV}>`);
          typeHints.set(Xobj, { kind: "arr", elem: elemTV });
          const cacheKey = `${Xobj}::${node.property.name}`;
          return _accessArrayMethod(node.property.name, elemTV, cacheKey);
        }
        // "length" is universal (present on both str and Array) — return num
        // without adding a structural constraint that would force the receiver
        // to be an object and block str|Array<T> union inference later.
        if (!typeHints.has(Xobj) && node.property.name === "length") {
          const Xlen = fresh();
          addCons(Xlen, "num");
          return Xlen;
        }
        const X3 = fresh();
        if (typeHints.get(Xobj) !== "func") {
          addCons(Xobj, `{${node.property.name}: ${X3}}`);
        }
        return X3;
      } else if (
        node.property.type === "Literal" &&
        typeof node.property.value === "string"
      ) {
        // obj["prop"] → known string key — intercept lazy module access then type methods
        const propTV = accessModuleProp(Xobj, node.property.value);
        if (propTV !== null) return propTV;
        const typeTV = accessTypeMethod(Xobj, node.property.value);
        if (typeTV !== null) return typeTV;
        if (
          !typeHints.has(Xobj) &&
          STRING_EXCLUSIVE_METHODS.has(node.property.value)
        ) {
          addCons(Xobj, "str");
          typeHints.set(Xobj, "str");
          return accessTypeMethod(Xobj, node.property.value);
        }
        if (
          !typeHints.has(Xobj) &&
          ARRAY_EXCLUSIVE_METHODS.has(node.property.value)
        ) {
          const elemTV = fresh();
          addCons(Xobj, `Array<${elemTV}>`);
          typeHints.set(Xobj, { kind: "arr", elem: elemTV });
          const cacheKey = `${Xobj}::${node.property.value}`;
          return _accessArrayMethod(node.property.value, elemTV, cacheKey);
        }
        if (!typeHints.has(Xobj) && node.property.value === "length") {
          const Xlen = fresh();
          addCons(Xlen, "num");
          return Xlen;
        }
        const X3 = fresh();
        if (node.property.value !== "") {
          addCons(Xobj, `{${node.property.value}: ${X3}}`);
        } else {
          // empty-string key: just an existence probe, don't add a named field
          addIndex(Xobj, fresh(), X3);
        }
        return X3;
      } else if (
        node.property.type === "Literal" &&
        typeof node.property.value === "number"
      ) {
        // arr[0] → numeric literal index
        const X3 = fresh();
        const Xidx = inferExpr(node.property, env, scope);
        addCons(Xidx, "num");
        addCons(Xobj, `Array<${X3}>`);
        return X3;
      } else {
        // arr[i] or obj[key] with variable/expression key — defer to solver
        const X3 = fresh();
        const Xidx = inferExpr(node.property, env, scope);
        addIndex(Xobj, Xidx, X3);
        return X3;
      }
    }

    case "NewExpression": {
      // e.g. new Promise(executor)
      if (node.callee.type === "Identifier" && node.callee.name === "Promise") {
        return inferNewPromise(node, env, scope);
      }
      // e.g. new Foo(args)
      if (
        node.callee.type === "Identifier" &&
        classMethods.has(node.callee.name)
      ) {
        return inferNewInstance(node, env, scope);
      }
      // Known built-in constructors: new Error(...), new TypeError(...), etc.
      if (node.callee.type === "Identifier") {
        const ctorSig = summaries.__globalConstructors__?.[node.callee.name];
        if (ctorSig) {
          node.arguments.forEach((arg, i) => {
            const Xi = inferExpr(arg, env, scope);
            const p = ctorSig.params[i];
            if (p) addCons(Xi, typeof p === "string" ? p : p.type ?? "{}");
          });
          return summaries.buildTypeTV(ctorSig.ret, node.callee.name, fresh, addCons);
        }
      }
      for (const arg of node.arguments) inferExpr(arg, env, scope);
      return fresh();
    }

    case "CallExpression": {
      // ex: f(e1, e2, ..., en)

      // fn.call(thisArg, a, b, ...) → fn(a, b, ...)
      // Avoids adding a spurious {call: T} structural constraint to `fn`.
      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.property.name === "call"
      ) {
        return inferExpr(
          { type: "CallExpression", callee: node.callee.object, arguments: node.arguments.slice(1) },
          env, scope,
        );
      }

      // fn.apply(thisArg, argsArray) → call fn as a generic function, infer argsArray
      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.property.name === "apply"
      ) {
        const Xcallee = inferExpr(node.callee.object, env, scope);
        if (node.arguments.length >= 2) inferExpr(node.arguments[1], env, scope);
        const Xret = fresh();
        addCons(Xcallee, `Func<apply_ret>{() -> ${Xret}}`);
        return Xret;
      }

      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === "Promise" &&
        (node.callee.property.name === "resolve" ||
          node.callee.property.name === "reject")
      )
        return inferPromiseSettle(node, env, scope, node.callee.property.name);

      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === "Promise" &&
        node.callee.property.name === "all"
      )
        return inferPromiseAll(node, env, scope);

      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.property.name === "then"
      )
        return inferPromiseThen(node, env, scope);

      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.property.name === "catch"
      )
        return inferPromiseCatch(node, env, scope);

      // require('module') — dispatch to stub if available
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        node.arguments.length === 1 &&
        node.arguments[0].type === "Literal" &&
        typeof node.arguments[0].value === "string"
      ) {
        const moduleName = node.arguments[0].value;
        if (summaries[moduleName]) {
          const T_mod = fresh();
          moduleTV.set(T_mod, { modName: moduleName, cache: new Map() });
          return T_mod;
        }
        if (stubs[moduleName]) return stubs[moduleName](fresh, addCons);

        // Fallback: introspect from node_modules (file-relative first, then global).
        // Store the native module object in moduleTV for demand-driven access —
        // only properties actually used in the file get instantiated.
        const label = moduleName.replace(/[^a-zA-Z0-9_]/g, "_");
        const tryLoadMod = (load) => {
          try {
            return load();
          } catch {
            return null;
          }
        };
        const nativeMod =
          tryLoadMod(() =>
            Module.createRequire(path.resolve(filePath))(moduleName),
          ) ?? tryLoadMod(() => require(moduleName));
        if (nativeMod !== null && nativeMod !== undefined) {
          const T_mod = fresh();
          moduleTV.set(T_mod, { modName: label, cache: new Map(), nativeMod });
          return T_mod;
        }
        // Unresolved local/unknown module — give each require() its own fresh TV
        // so separate imports don't get merged via the shared ret__require__global.
        return fresh();
      }
      // Static method call: ClassName.method(args)  — must come before the
      // generic MemberExpression fallback to avoid generating {method: T} on
      // the class variable (which would conflict with Class<ClassName>).
      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.object.type === "Identifier" &&
        classMethods.has(node.callee.object.name)
      ) {
        const methodName = node.callee.property.name;
        const method = classMethods
          .get(node.callee.object.name)
          .find((m) => m.name === methodName);
        if (method) {
          node.arguments.forEach((arg, i) => {
            const Xi = inferExpr(arg, env, scope);
            if (method.params[i]) addCons(Xi, method.params[i]);
          });
          return method.ret;
        }
      }

      // Instance method call: o.bar(args)
      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.object.type === "Identifier"
      ) {
        const Xobj = inferExpr(node.callee.object, env, scope);
        const className = instanceClasses.get(Xobj);
        const methodName = node.callee.property.name;
        if (className && classMethods.has(className)) {
          const method = classMethods
            .get(className)
            .find((m) => m.name === methodName);
          if (method) {
            node.arguments.forEach((arg, i) => {
              const Xi = inferExpr(arg, env, scope);
              if (method.params[i]) addCons(Xi, method.params[i]);
            });
            // Propagate this.x field assignments to the calling instance
            const mQualName = method.qualName ?? `${methodName}__${className}`;
            for (const { name: fn, tv: fv } of classMethodThisAttrs.get(
              mQualName,
            ) ?? []) {
              addCons(Xobj, `{${fn}: ${fv}}`);
            }
            return method.ret;
          }
        }
      }

      // Module method call: mod.method(args) where mod is a known summary module.
      // Register the method on the global (for display) but apply declared param types
      // directly per call site — avoids contaminating the cached Func TV with actual
      // argument types.
      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.object.type === "Identifier"
      ) {
        const Xobj = inferExpr(node.callee.object, env, scope);
        if (moduleTV.has(Xobj)) {
          const { modName } = moduleTV.get(Xobj);
          const propName = node.callee.property.name;
          const sig = summaries[modName]?.[propName];
          if (sig && !sig.kind) {
            accessModuleProp(Xobj, propName); // register declared shape on the global
            return applyModuleMethodCall(
              sig,
              propName,
              node.arguments,
              env,
              scope,
            );
          }
        }
      }

      const fname = node.callee.type === "Identifier" ? node.callee.name : null;
      if (!fname) {
        // e.g. obj.method(a, b), (function(x){})(5)
        const Xcallee = inferExpr(node.callee, env, scope);
        const Xret = fresh();
        const paramTVs = node.arguments.map(() => fresh());
        addCons(Xcallee, funcType(fresh(), paramTVs, Xret));
        node.arguments.forEach((arg, i) => {
          const Xi = inferExpr(arg, env, scope);
          addCons(Xi, paramTVs[i]);
        });
        return Xret;
      }

      const fnVar = envGet(env, fname, scope);

      // Locally-bound module method: var exec = cp.exec; exec(cmd, cb)
      if (methodSummaryMap.has(fnVar)) {
        const { sig, propName } = methodSummaryMap.get(fnVar);
        return applyModuleMethodCall(sig, propName, node.arguments, env, scope);
      }

      if (resolverTargets.has(fnVar)) {
        const targetTV = resolverTargets.get(fnVar);
        for (const arg of node.arguments)
          addCons(inferExpr(arg, env, scope), targetTV);
        return fresh();
      }
      if (rejectorTargets.has(fnVar)) {
        const targetTV = rejectorTargets.get(fnVar);
        for (const arg of node.arguments)
          addCons(inferExpr(arg, env, scope), targetTV);
        return fresh();
      }

      // Known callable globals: String(x) → str, Number(x) → num, Boolean(x) → bool
      if (fname && summaries.__globalCallables__?.[fname]) {
        const sig = summaries.__globalCallables__[fname];
        node.arguments.forEach((arg, i) => {
          const Xi = inferExpr(arg, env, scope);
          if (sig.params[i] !== undefined) addCons(Xi, sig.params[i]);
        });
        const retTV = fresh();
        addCons(retTV, sig.ret);
        return retTV;
      }

      // from current scope upward to global
      const qualName = functionParams.has(`${fname}__${scope}`)
        ? `${fname}__${scope}`
        : `${fname}__global`;
      const paramNames = functionParams.get(qualName);
      // For declared functions use named param TVs; for higher-order parameters
      // (callbacks, injected functions) create fresh TVs per call site so the
      // argument types still flow in and the solver can infer the signature.
      const callParamTVs = paramNames
        ? paramNames.map((p) => `${p}__${qualName}`)
        : node.arguments.map(() => fresh());
      addCons(fnVar, funcType(qualName, callParamTVs, `ret__${qualName}`));
      node.arguments.forEach((arg, i) => {
        const Xi = inferExpr(arg, env, scope);
        addCons(Xi, callParamTVs[i]);
      });
      return `ret__${qualName}`;
    }

    case "ArrayExpression": {
      // e.g. [e1, e2, ..., en]
      const Xelem = fresh();
      const Xarr = fresh();
      for (const elem of node.elements) {
        if (elem) {
          const Xi = inferExpr(elem, env, scope);
          addCons(Xi, Xelem);
        }
      }
      addCons(Xarr, `Array<${Xelem}>`);
      return Xarr;
    }

    case "AwaitExpression": {
      const X_expr = inferExpr(node.argument, env, scope);
      const X_res = fresh();
      const X_rej = fresh();
      addCons(X_expr, `Promise<${X_res},${X_rej}>`);
      return X_res;
    }

    case "ClassExpression": {
      const className = node.id?.name ?? `class_${fresh()}`;
      const sig = inferClassNode(node, className, env);
      const Xcls = fresh();
      addCons(Xcls, `Class<${className}>[${sig}]`);
      return Xcls;
    }

    case "FunctionExpression": // e.g. function(a) { return a; }
    case "ArrowFunctionExpression": {
      // e.g. (n) => n * 2
      const fnName = node.id?.name ?? `fun_${fresh()}`;
      const fnTV = mkTV(fnName, scope);
      inferFuncNode(node, fnName, scope, env, fnTV);
      return fnTV;
    }

    case "AssignmentExpression": {
      // Assignment used as an expression, e.g. var foo = exports.foo = 1.
      // In JS, (lhs = rhs) evaluates to rhs, so we infer rhs, apply the
      // side-effect, and return rhs's type variable.
      if (node.operator !== "=") {
        // compound (+=, -= …) — apply side-effect, return lhs TV
        inferExprStmt(node, env, scope);
        return inferExpr(node.left, env, scope);
      }
      const Xrhs = inferExpr(node.right, env, scope);
      const lhs = node.left;
      if (lhs.type === "Identifier") {
        const xTarget = envGet(env, lhs.name, scope);
        addCons(Xrhs, xTarget);
        if (moduleTV.has(Xrhs)) moduleTV.set(xTarget, moduleTV.get(Xrhs));
      } else if (
        lhs.type === "MemberExpression" &&
        !lhs.computed &&
        lhs.object.type !== "ThisExpression"
      ) {
        const Xobj = inferExpr(lhs.object, env, scope);
        addCons(Xobj, `{${lhs.property.name}: ${Xrhs}}`);
      } else if (
        lhs.type === "MemberExpression" &&
        !lhs.computed &&
        lhs.object.type === "ThisExpression"
      ) {
        const methodScope = findMethodScope(scope);
        if (methodScope) {
          const attrs = classMethodThisAttrs.get(methodScope);
          let attr = attrs.find((a) => a.name === lhs.property.name);
          if (!attr) {
            attr = { name: lhs.property.name, tv: fresh() };
            attrs.push(attr);
          }
          addCons(Xrhs, attr.tv);
        }
      }
      return Xrhs;
    }

    default:
      return fresh();
  }
}

// -- Assignment helpers ------------------------------------------------------
/**
 * Handle  xTarget = rhs  where xTarget is already a resolved type variable.
 * Dispatches to C-EmptyObj / C-BinOp / C-PropRead / C-Assign.
 */
function handleRHS(name, rhs, env, scope) {
  const xTarget = envGet(env, name, scope);

  if (rhs.type === "ObjectExpression" && rhs.properties.length === 0) {
    // x = {}
    addCons(xTarget, "{}");
    return;
  }

  if (rhs.type === "ObjectExpression") {
    // x = {e1, ...}
    const Xobj = inferObjectExpr(rhs, env, scope, name);
    addCons(Xobj, xTarget);
    return;
  }

  if (rhs.type === "BinaryExpression" && rhs.operator === "+") {
    // x = e1 + e2  (deferred: resolved after main pass)
    const X1 = inferExpr(rhs.left, env, scope);
    const X2 = inferExpr(rhs.right, env, scope);
    const X3 = fresh();
    addPlus(X1, X2, X3);
    addCons(X3, xTarget);
    return;
  }

  if (
    rhs.type === "BinaryExpression" &&
    ["-", "*", "/", "%"].includes(rhs.operator)
  ) {
    // x = e1 op e2
    const X1 = inferExpr(rhs.left, env, scope);
    const X2 = inferExpr(rhs.right, env, scope);
    const X3 = fresh();
    addCons(X1, "num");
    addCons(X2, "num");
    addCons(X3, "num");
    addCons(X3, xTarget);
    return;
  }

  if (rhs.type === "MemberExpression" && !rhs.computed) {
    // x = e.p — intercept lazy module access then built-in type methods
    const X1 = inferExpr(rhs.object, env, scope);
    const prop = rhs.property.name;
    const propTV = accessModuleProp(X1, prop);
    if (propTV !== null) {
      addCons(propTV, xTarget);
      return;
    }
    const typeTV = accessTypeMethod(X1, prop);
    if (typeTV !== null) {
      addCons(typeTV, xTarget);
      return;
    }
    const X3 = fresh();
    addCons(X3, xTarget);
    addCons(X1, `{${prop}: ${X3}}`);
    return;
  }

  if (
    rhs.type === "FunctionExpression" ||
    rhs.type === "ArrowFunctionExpression"
  ) {
    const fnName = rhs.id?.name ?? name;
    inferFuncNode(rhs, fnName, scope, env, xTarget);
    return;
  }

  if (rhs.type === "ClassExpression") {
    const params = inferClassNode(rhs, name, env);
    addCons(xTarget, `Class<${name}>[${params}]`);
    return;
  }

  const X1 = inferExpr(rhs, env, scope); // Assign
  addCons(X1, xTarget);

  // propagate lazy-module tracking through assignments (handles aliasing)
  if (moduleTV.has(X1)) moduleTV.set(xTarget, moduleTV.get(X1));

  // connect TV to the responding class
  if (instanceClasses.has(X1)) {
    instanceClasses.set(xTarget, instanceClasses.get(X1));
  }
}

// -- Statement inference -----------------------------------------------------
function inferStmt(node, env, scope) {
  let hasReturn = false;
  if (!node) return hasReturn;

  switch (node.type) {
    // -- Control Flow --------------------------------------------------------
    case "Program":
    case "BlockStatement": {
      // Hoist function declarations so forward references resolve correctly.
      for (const s of node.body) {
        if (s.type === "FunctionDeclaration" && s.id) {
          envDeclare(env, s.id.name, scope);
        }
      }
      // Detect X.prototype.Y = function(...) patterns and set up class infrastructure.
      const protoGroups = new Map();
      for (const s of node.body) {
        if (
          s.type === "ExpressionStatement" &&
          s.expression?.type === "AssignmentExpression" &&
          s.expression.operator === "=" &&
          s.expression.left?.type === "MemberExpression" &&
          !s.expression.left.computed &&
          s.expression.left.object?.type === "MemberExpression" &&
          !s.expression.left.object.computed &&
          s.expression.left.object.property?.name === "prototype" &&
          s.expression.left.object.object?.type === "Identifier" &&
          (s.expression.right?.type === "FunctionExpression" ||
            s.expression.right?.type === "ArrowFunctionExpression")
        ) {
          const ctorName = s.expression.left.object.object.name;
          const methodName = s.expression.left.property.name;
          const funcNode = s.expression.right;
          if (!protoGroups.has(ctorName)) protoGroups.set(ctorName, []);
          protoGroups.get(ctorName).push({ methodName, funcNode });
        }
      }
      if (protoGroups.size > 0) setupProtoClasses(protoGroups, node.body, env, scope);

      for (const s of node.body) {
        if (inferStmt(s, env, scope)) {
          hasReturn = true;
        }
      }
      return hasReturn;
    }

    case "IfStatement": {
      inferExpr(node.test, env, scope);
      const guard = extractTypeofGuard(node.test);
      if (guard) {
        const origTV = envGet(env, guard.ident, scope);
        const shadowTV = fresh();
        typeHints.set(shadowTV, guard.jsType);
        env.set(guard.ident, shadowTV);
        inferStmt(node.consequent, env, scope);
        env.set(guard.ident, origTV);
        if (!typeofGuardMap.has(origTV)) typeofGuardMap.set(origTV, new Set());
        typeofGuardMap.get(origTV).add(guard.jsType);
      } else {
        inferStmt(node.consequent, env, scope);
      }
      if (node.alternate) inferStmt(node.alternate, env, scope);
      break;
    }

    case "WhileStatement": {
      // e.g. while (test) {body}
      const Xcond = inferExpr(node.test, env, scope);
      inferStmt(node.body, env, scope);
      break;
    }

    case "DoWhileStatement": {
      // e.g. do {body} while (test)
      inferStmt(node.body, env, scope);
      const Xcond = inferExpr(node.test, env, scope);
      break;
    }

    case "SwitchStatement": {
      // e.g. switch (discriminant) {cases}
      // Infer the discriminant — its type variable is registered but not
      // constrained to any particular base type (switch works over any type).
      const Xdisc = inferExpr(node.discriminant, env, scope);
      // Each case test is compared to the discriminant via strict equality,
      // so we unify their type variables (same rule as ===).
      for (const cas of node.cases) {
        if (cas.test) {
          const Xtest = inferExpr(cas.test, env, scope);
          addCons(Xdisc, Xtest);
          addCons(Xtest, Xdisc);
        }

        // process the body of each case
        for (const s of cas.consequent) inferStmt(s, env, scope);
      }
      break;
    }

    case "ForStatement": {
      // e.g. for (init; test; update) {body}
      if (node.init) {
        if (node.init.type === "VariableDeclaration") {
          inferStmt(node.init, env, scope);
        } else {
          // e.g. i = 0
          inferExprStmt(node.init, env, scope);
        }
      }

      if (node.test) {
        inferExpr(node.test, env, scope);
      }

      inferStmt(node.body, env, scope);

      if (node.update) {
        inferExprStmt(node.update, env, scope);
      }
      break;
    }

    case "ForInStatement": {
      // e.g. for (left in right) {body}
      inferExpr(node.right, env, scope);

      let keyVar;
      if (node.left.type === "VariableDeclaration") {
        // e.g., for (var key in obj)
        const decl = node.left.declarations[0];
        keyVar = envDeclare(env, decl.id.name, scope);
      } else if (node.left.type === "Identifier") {
        // e.g., for (key in obj)
        keyVar = envGet(env, node.left.name, scope);
      }

      // Constrain the iteration key to be a string
      if (keyVar) {
        addCons(keyVar, "str");
      }

      inferStmt(node.body, env, scope);
      break;
    }

    case "LabeledStatement": {
      inferStmt(node.body, env, scope);
      break;
    }

    case "ForOfStatement": {
      // e.g. for (left of right) {body}
      inferExpr(node.right, env, scope);

      let valVar;
      if (node.left.type === "VariableDeclaration") {
        // e.g. for (const item of iterable)
        const decl = node.left.declarations[0];
        valVar = envDeclare(env, decl.id.name, scope);
      } else if (node.left.type === "Identifier") {
        // e.g. for (item of iterable)
        valVar = envGet(env, node.left.name, scope);
      }

      // TODO: Constrain valVar by the iterable's element type once
      // the solver supports Iterable<T> for both Array<T> and str.

      inferStmt(node.body, env, scope);
      break;
    }

    // -- Declarations --------------------------------------------------------
    case "VariableDeclaration": {
      for (const decl of node.declarations) {
        if (decl.id.type === "ObjectPattern") {
          // const { a, b } = expr  — destructuring
          const Xrhs = decl.init ? inferExpr(decl.init, env, scope) : fresh();
          for (const prop of decl.id.properties) {
            if (prop.type === "RestElement") continue;
            const keyName =
              prop.key.type === "Identifier"
                ? prop.key.name
                : String(prop.key.value);
            const valName =
              prop.value.type === "Identifier" ? prop.value.name : keyName;
            const localTV = envDeclare(env, valName, scope);
            const propTV = accessModuleProp(Xrhs, keyName);
            if (propTV !== null) {
              addCons(propTV, localTV);
            } else {
              addCons(Xrhs, `{${keyName}: ${localTV}}`);
            }
          }
        } else if (decl.id.type === "ArrayPattern") {
          // const [a, b] = expr  — array destructuring
          const Xrhs = decl.init ? inferExpr(decl.init, env, scope) : fresh();
          const Xelem = fresh();
          addCons(Xrhs, `Array<${Xelem}>`);
          for (const el of decl.id.elements) {
            if (!el || el.type === "RestElement") continue;
            if (el.type === "Identifier") {
              const localTV = envDeclare(env, el.name, scope);
              addCons(Xelem, localTV);
            }
          }
        } else {
          // Identifier
          envDeclare(env, decl.id.name, scope);
          if (decl.init) handleRHS(decl.id.name, decl.init, env, scope);
        }
      }
      break;
    }

    case "FunctionDeclaration": {
      // e.g. function id(params) {body}
      const fnName = node.id?.name ?? `anon_${fresh()}`;
      const qualName = `${fnName}__${scope}`;

      if (node.async) {
        asyncScopes.add(qualName);
        const X_rej = fresh();
        addCons(
          `ret__${qualName}`,
          `Promise<async_inner__${qualName},${X_rej}>`,
        );
      }

      // Pre-declare the function name before building fnEnv so that recursive
      // calls inside the body resolve to the same TV as the outer binding,
      // rather than creating a spurious scoped duplicate.
      const fnTV = node.id
        ? envDeclare(env, fnName, scope)
        : mkTV(fnName, scope);

      const fnEnv = new Map(env); // now includes fnName → fnTV
      const paramNames = [];
      const paramTVs = [];
      for (const p of node.params) {
        for (const { name, tv } of declareParam(p, fnEnv, qualName)) {
          paramNames.push(name);
          paramTVs.push(tv);
        }
      }
      functionParams.set(qualName, paramNames);

      const retTV = `ret__${qualName}`;
      const hasReturn = inferStmt(node.body, fnEnv, qualName);
      if (!hasReturn) {
        addCons("void", node.async ? `async_inner__${qualName}` : retTV);
      }

      functionTypes.set(qualName, {
        params: paramTVs,
        ret: retTV,
      });

      addCons(fnTV, funcType(qualName, paramTVs, retTV));
      typeHints.set(fnTV, "func");
      break;
    }

    case "ClassDeclaration": {
      // e.g. class Id { method(params) {body} ... }
      const className = node.id?.name ?? `anon_${fresh()}`;
      const params = inferClassNode(node, className, env);
      const Xclass = node.id
        ? envDeclare(env, className, scope)
        : mkTV(className, scope);
      addCons(Xclass, `Class<${className}>[${params}]`);
      break;
    }

    case "ExportNamedDeclaration": {
      // export const x = 5 / export function f() {} / export class C {}
      if (node.declaration) {
        if (inferStmt(node.declaration, env, scope)) hasReturn = true;
      }
      // export { x, y } — bindings already in env, nothing to do
      // export { x } from 'mod' — cross-module re-export, skip
      break;
    }

    case "ExportDefaultDeclaration": {
      // export default function f() {} / export default class C {}
      const decl = node.declaration;
      if (
        decl.type === "FunctionDeclaration" ||
        decl.type === "ClassDeclaration"
      ) {
        if (inferStmt(decl, env, scope)) hasReturn = true;
      } else {
        // export default <expr>  (literal, arrow, object, ...)
        inferExpr(decl, env, scope);
      }
      break;
    }

    // -- Others --------------------------------------------------------------
    case "ExpressionStatement": {
      // e.g. assignments, updates, calls
      inferExprStmt(node.expression, env, scope);
      break;
    }

    case "ReturnStatement": {
      // e.g. return (argument)
      const retTarget = asyncScopes.has(scope)
        ? `async_inner__${scope}`
        : `ret__${scope}`;
      if (node.argument) {
        const X1 = inferExpr(node.argument, env, scope);
        addCons(X1, retTarget);
      } else {
        addCons("void", retTarget);
      }
      return true;
    }

    case "ThrowStatement": {
      // e.g. throw argument;
      inferExpr(node.argument, env, scope);
      break;
    }

    case "TryStatement": {
      // e.g. try {block} (catch (param) {handler}) (finally {finalizer})
      inferStmt(node.block, env, scope);
      if (node.handler) {
        if (node.handler.param) {
          const errTV = envDeclare(env, node.handler.param.name, scope);
          addCons(errTV, "error");
        }
        inferStmt(node.handler.body, env, scope);
      }
      if (node.finalizer) inferStmt(node.finalizer, env, scope);
      break;
    }

    default:
      return hasReturn;
  }
}

/**
 * Handle expressions that appear at statement level
 * (assignments, compound assignments, update expressions, calls).
 */
function inferExprStmt(node, env, scope) {
  if (!node) return;

  switch (node.type) {
    case "AssignmentExpression": {
      // x = rhs  or  x.p = rhs
      const lhs = node.left;
      const rhs = node.right;

      if (lhs.type === "Identifier") {
        // x = rhs
        handleRHS(lhs.name, rhs, env, scope);
        return;
      }

      if (
        lhs.type === "MemberExpression" &&
        !lhs.computed &&
        lhs.object.type !== "ThisExpression"
      ) {
        // X.prototype.Y = function(...) — prototype-pattern method definition
        if (
          lhs.object?.type === "MemberExpression" &&
          !lhs.object.computed &&
          lhs.object.property?.name === "prototype" &&
          lhs.object.object?.type === "Identifier" &&
          (rhs.type === "FunctionExpression" ||
            rhs.type === "ArrowFunctionExpression")
        ) {
          const ctorName = lhs.object.object.name;
          const methodName = lhs.property.name;
          const qualName = `${methodName}__${ctorName}`;
          if (protoMethodEnvs.has(qualName)) {
            const fnEnv = protoMethodEnvs.get(qualName);
            const { params: paramTVs, ret: retTV } = functionTypes.get(qualName);
            if (rhs.async) asyncScopes.add(qualName);
            let hasReturn;
            if (
              rhs.type === "ArrowFunctionExpression" &&
              rhs.body.type !== "BlockStatement"
            ) {
              addCons(inferExpr(rhs.body, fnEnv, qualName), retTV);
              hasReturn = true;
            } else {
              hasReturn = inferStmt(rhs.body, fnEnv, qualName);
            }
            if (!hasReturn) addCons("void", retTV);
            const mfv = mkTV(methodName, scope);
            addCons(mfv, funcType(qualName, paramTVs, retTV));
            typeHints.set(mfv, "func");
            return;
          }
        }

        // x.p = e  or  a.b.c = e  (arbitrarily deep)
        // Infer the object first so function RHS can bind `this` to it.
        const X2 = inferExpr(lhs.object, env, scope);
        let X1;
        if (rhs.type === "FunctionExpression") {
          const fnName = rhs.id?.name ?? lhs.property.name;
          X1 = mkTV(fnName, scope);
          inferFuncNode(rhs, fnName, scope, env, X1, X2);
        } else {
          X1 = inferExpr(rhs, env, scope);
        }
        const prop = lhs.property.name;
        addCons(X2, `{${prop}: ${X1}}`);
        return;
      }

      if (
        // this.p = e  (inside a class method or nested arrow function)
        lhs.type === "MemberExpression" &&
        !lhs.computed &&
        lhs.object.type === "ThisExpression"
      ) {
        const fieldName = lhs.property.name;
        const X_rhs = inferExpr(rhs, env, scope);
        const methodScope = findMethodScope(scope);
        if (methodScope) {
          const attrs = classMethodThisAttrs.get(methodScope);
          let attr = attrs.find((a) => a.name === fieldName);
          if (!attr) {
            attr = { name: fieldName, tv: fresh() };
            attrs.push(attr);
          }
          addCons(X_rhs, attr.tv);
        }
        return;
      }

      if (node.operator !== "=") {
        // +=, -=, ... - desugar to BinOp + assign
        const baseOp = node.operator.slice(0, -1); // '+=' -> '+'
        if (baseOp === "+") {
          const X1 = inferExpr(lhs, env, scope);
          const X2 = inferExpr(rhs, env, scope);
          const Xr = fresh();
          addPlus(X1, X2, Xr);
          if (lhs.type === "Identifier") {
            const xVar = envGet(env, lhs.name, scope);
            addCons(Xr, xVar);
          }
        } else if (["-", "*", "/", "%"].includes(baseOp)) {
          const X1 = inferExpr(lhs, env, scope);
          const X2 = inferExpr(rhs, env, scope);
          const Xr = fresh();
          addCons(X1, "num");
          addCons(X2, "num");
          addCons(Xr, "num");
          if (lhs.type === "Identifier") {
            const xVar = envGet(env, lhs.name, scope);
            addCons(Xr, xVar);
          }
        }
        return;
      }
      // Computed write: obj[key] = rhs — infer rhs and constrain obj as an object.
      if (lhs.type === "MemberExpression" && lhs.computed) {
        const Xrhs = inferExpr(rhs, env, scope);
        const Xobj = inferExpr(lhs.object, env, scope);
        const Xidx = inferExpr(lhs.property, env, scope);
        addCons(Xobj, "{}");
        addIndex(Xobj, Xidx, Xrhs);
        return;
      }
      inferExpr(rhs, env, scope);
      break;
    }

    case "UpdateExpression": {
      // i++, --i
      const Xa = inferExpr(node.argument, env, scope);
      addCons(Xa, "num");
      break;
    }

    default: // call expressions, ...
      return inferExpr(node, env, scope);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
const filePath = process.argv[2];

if (!filePath) {
  console.error("Usage: node infer.js <source-file.js>");
  process.exit(1);
}

let src;
try {
  src = fs.readFileSync(filePath, "utf8");
} catch (e) {
  console.error(`Cannot read file: ${filePath}\n${e.message}`);
  process.exit(1);
}

if (src.startsWith("#!")) src = "//" + src.slice(2);

let ast = null;
try {
  ast = acorn.parse(src, {
    ecmaVersion: 2020,
    sourceType: "script",
    allowReturnOutsideFunction: true,
  });
} catch (scriptErr) {
  try {
    ast = acorn.parse(src, {
      ecmaVersion: 2020,
      sourceType: "module",
      allowReturnOutsideFunction: true,
    });
  } catch (e) {
    process.stderr.write(
      `Parse error in ${path.basename(filePath)}: ${e.message}\n`,
    );
  }
}

// Run inference on the whole program (top-level scope = 'global')
// Pre-declare known JS globals so their methods resolve via accessModuleProp.
// Use fixed names (no fresh()) so the TV counter is unaffected for files that
// don't use these globals.
const globalEnv = new Map();
for (const name of summaries.__globals__ ?? []) {
  const tv = `${name}__global`;
  globalEnv.set(name, tv);
  moduleTV.set(tv, { modName: name, cache: new Map() });
}
if (ast) inferStmt(ast, globalEnv, "global");

for (const [tv, types] of typeofGuardMap.entries()) {
  const union = [...types].sort().join("|");
  constraints.push(`${tv} <= ${union}`);
}

// ── Output ────────────────────────────────────────────────────────────────────
const SEP = "─".repeat(60);
console.log(`\nType Inference Constraints`);
console.log(`File : ${path.resolve(filePath)}`);
console.log(SEP);

const allConstraints = [
  ...constraints,
  ...plusConstraints,
  ...unionConstraints,
  ...logicalUnionConstraints,
  ...indexConstraints,
  ...tplConstraints,
];
if (allConstraints.length === 0) {
  console.log("  (no constraints generated)");
} else {
  const pad = String(allConstraints.length).length;
  allConstraints.forEach((c, i) =>
    console.log(`  C${String(i + 1).padStart(pad, "0")}: ${c}`),
  );
}

console.log(SEP);
console.log(`Total: ${allConstraints.length} constraint(s)\n`);

console.log("\nFunction Types");
console.log(SEP);

for (const [qualName, t] of functionTypes.entries()) {
  const params = t.params.join(", ");
  console.log(`  ${qualName} : (${params}) -> ${t.ret}`);
}
