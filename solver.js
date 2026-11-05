#!/usr/bin/env node
"use strict";

const BASE_TYPES = new Set(["str", "num", "bool", "void", "regexp", "error"]);
const isBaseType = (t) =>
  BASE_TYPES.has(t) ||
  (t.includes("|") && t.split("|").every((p) => BASE_TYPES.has(p)));

// Returns the intersection (narrower type) of two type descriptors, or null if
// they are incompatible (conflict). Works for base types, union types, and
// structural kinds ("obj", "arr", …) returned by kindOf.
function mergeTypes(t1, t2) {
  if (t1 === t2) return t1;
  const s1 = new Set(t1.split("|"));
  const s2 = new Set(t2.split("|"));
  const inter = [...s1].filter((x) => s2.has(x));
  if (inter.length === 0) return null;
  return inter.length === 1 ? inter[0] : inter.sort().join("|");
}
const isEmptyObj = (t) => t === "{}";
const isObjWithFlds = (t) => t.startsWith("{") && t !== "{}";
const isArray = (t) => t.startsWith("Array<") && t.endsWith(">");
const parseArrayElem = (t) => t.slice(6, -1).trim();
const isFunc = (t) => t.startsWith("Func<");
const isPromise = (t) => t.startsWith("Promise<") && t.endsWith(">");
function parsePromise(t) {
  const inner = t.slice(8, -1); // strip "Promise<" and ">"
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "<" || ch === "{") depth++;
    else if (ch === ">" || ch === "}") depth--;
    else if (ch === "," && depth === 0)
      return {
        resolve: inner.slice(0, i).trim(),
        reject: inner.slice(i + 1).trim(),
      };
  }
  return { resolve: inner.trim(), reject: "bot" };
}
const isResolver = (t) => t.startsWith("Resolver<") && t.endsWith(">");
const isRejector = (t) => t.startsWith("Rejector<") && t.endsWith(">");
const parseResolverInner = (t) => t.slice(9, -1).trim();
const parseRejectorInner = (t) => t.slice(9, -1).trim();
const isClassType = (t) => t.startsWith("Class<") && t.endsWith("]");
const isInstanceType = (t) => t.startsWith("Obj<") && t.endsWith("]");
const isLiteral = (t) =>
  isBaseType(t) ||
  isEmptyObj(t) ||
  isObjWithFlds(t) ||
  isArray(t) ||
  isFunc(t) ||
  isPromise(t) ||
  isResolver(t) ||
  isRejector(t) ||
  isClassType(t) ||
  isInstanceType(t);
const isTypeVar = (t) => !isLiteral(t);

// Parse Func<name>{p1 -> p2 -> ... -> ret}  or  Func<name>{() -> ret}
function parseFunc(t) {
  const nameEnd = t.indexOf(">{");
  const name = t.slice(5, nameEnd); // after "Func<"
  const body = t.slice(nameEnd + 2, -1); // inside {}
  if (body.startsWith("()")) {
    const ret = body.slice(body.indexOf("->") + 2).trim();
    return { name, params: [], ret };
  }
  const parts = body.split(" -> ");
  return { name, params: parts.slice(0, -1), ret: parts[parts.length - 1] };
}

function parseClassOrInst(t) {
  const isCls = isClassType(t);
  const prefix = isCls ? "Class<" : "Obj<";
  const headEnd = t.indexOf(">", prefix.length);
  const className = t.slice(prefix.length, headEnd);
  const bracketStart = t.indexOf("[", headEnd);
  const inner = t.slice(bracketStart + 1, -1).trim();
  const methods = new Map();
  if (inner) {
    let depth = 0,
      start = 0;
    for (let i = 0; i <= inner.length; i++) {
      const ch = inner[i];
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
      else if ((ch === "," || i === inner.length) && depth === 0) {
        const part = inner.slice(start, i).trim();
        if (part) {
          const colon = part.indexOf(":");
          const name = part.slice(0, colon).trim();
          const sig = part
            .slice(colon + 1)
            .trim()
            .split(" -> ")
            .map((x) => x.trim());
          methods.set(name, sig);
        }
        start = i + 1;
      }
    }
  }
  return { kind: isCls ? "Class" : "Obj", className, methods };
}

function parseFields(t) {
  const inner = t.slice(1, -1).trim();
  if (!inner) return new Map();
  const fields = new Map();
  let depth = 0,
    start = 0;
  for (let i = 0; i <= inner.length; i++) {
    const ch = inner[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if ((ch === "," || i === inner.length) && depth === 0) {
      const part = inner.slice(start, i).trim();
      if (part) {
        const colon = part.indexOf(":");
        fields.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
      }
      start = i + 1;
    }
  }
  return fields;
}

// ── Estado ────────────────────────────────────────────────────────────────────
class State {
  constructor() {
    this.parent = new Map(); // typeVar → parent
    this.rank = new Map();
    this.baseType = new Map(); // rep → 'str'|'num'|'bool'
    this.isObj = new Map(); // rep → true
    this.objShape = new Map(); // rep → Map<field, typeVar>  ← UMA var por campo
    this.isArr = new Map(); // rep → true
    this.arrElem = new Map(); // rep → typeVar for element type
    this.isFuncType = new Map(); // rep → true
    this.funcInfo = new Map(); // rep → { name, params: string[], ret: string }
    this.isPromiseType = new Map(); // rep → true
    this.promiseResolve = new Map(); // rep → typeVar for resolved value
    this.promiseReject = new Map(); // rep → typeVar for rejected value
    this.isResolverType = new Map(); // rep → true
    this.resolverInner = new Map(); // rep → typeVar for the resolved value type
    this.isRejectorType = new Map(); // rep → true
    this.rejectorInner = new Map(); // rep → typeVar for the rejected value type
    this.classKind = new Map(); // rep → 'Class' | 'Obj'
    this.className = new Map(); // rep → string
    this.classMethods = new Map(); // rep → Map<methodName, TV[]>
    this.baseAndArr = new Map(); // rep → true when TV has both a base type AND isArr
    this.errors = [];

    this.displayList = []; // todos os nós em ordem de aparição
    this.seenNodes = new Set();
    this.consumedLits = new Set(); // literais já absorvidos
  }

  _reg(node) {
    if (!this.seenNodes.has(node)) {
      this.seenNodes.add(node);
      this.displayList.push(node);
    }
    if (isTypeVar(node) && !this.parent.has(node)) {
      this.parent.set(node, node);
      this.rank.set(node, 0);
    }
  }

  regConstraint(lhs, rhs) {
    this._reg(lhs);
    this._reg(rhs);
    if (isFunc(rhs)) {
      const { params, ret } = parseFunc(rhs);
      for (const p of params) this._reg(p);
      this._reg(ret);
    }
  }

  // ── Union-Find ─────────────────────────────────────────────────────────────
  find(x) {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
    if (this.parent.get(x) !== x)
      this.parent.set(x, this.find(this.parent.get(x)));
    return this.parent.get(x);
  }

  kindOf(rx) {
    if (this.baseType.has(rx)) return this.baseType.get(rx);
    if (this.isObj.get(rx)) return "obj";
    if (this.isArr.get(rx)) return "arr";
    if (this.isFuncType.get(rx)) return "func";
    if (this.isPromiseType.get(rx)) return "promise";
    if (this.isResolverType.get(rx)) return "resolver";
    if (this.isRejectorType.get(rx)) return "rejector";
    return null;
  }

  // Returns true (and pushes an error) if ra and rb have concrete types that
  // cannot be merged.  Called before any structural mutation in union().
  _conflictCheck(ra, rb, a, b) {
    const ka = this.kindOf(ra),
      kb = this.kindOf(rb);
    if (!ka || !kb) return false;
    if (ka === kb) return false;
    if (mergeTypes(ka, kb) !== null) return false; // union types overlap — compatible
    this.errors.push(`CONFLICT: ${ka} vs ${kb}  (union(${a},${b}))`);
    return true;
  }

  union(a, b) {
    const ra = this.find(a),
      rb = this.find(b);
    if (ra === rb) return;

    if (this._conflictCheck(ra, rb, a, b)) return;

    let root, child;
    if ((this.rank.get(ra) ?? 0) >= (this.rank.get(rb) ?? 0)) {
      root = ra;
      child = rb;
    } else {
      root = rb;
      child = ra;
    }
    if (this.rank.get(root) === this.rank.get(child))
      this.rank.set(root, (this.rank.get(root) ?? 0) + 1);

    this.parent.set(child, root);

    // Propaga base type do child para o root
    const btc = this.baseType.get(child);
    if (btc) this._setBase(root, btc, `union(${a},${b})`);

    // Propaga objShape do child para o root
    if (this.isObj.get(child)) {
      const rootWasObj = this.isObj.get(root);
      this._initObj(root);
      const sc = this.objShape.get(child) ?? new Map();
      const sr = this.objShape.get(root);

      if (rootWasObj) {
        // Both were already objects → union all field requirements.
        // Our constraints are "at least" bounds (open records), so the merged
        // TV must satisfy every requirement from both sides: all fields are kept.
        for (const [f, tv] of sc) {
          if (sr.has(f)) {
            const srv = sr.get(f);
            if (isLiteral(tv)) this.process(srv, tv);
            else if (isLiteral(srv)) this.process(tv, srv);
            else this.union(srv, tv);
          } else {
            sr.set(f, tv);
          }
        }
      } else {
        // Root was a plain type var → copy all fields from child
        for (const [f, tv] of sc) {
          sr.set(f, tv);
        }
      }
    }

    // Propaga arrElem do child para o root
    if (this.isArr.get(child)) {
      const childElem = this.arrElem.get(child);
      if (this.isArr.get(root)) {
        this.union(this.arrElem.get(root), childElem);
      } else {
        this._initArr(root, childElem);
      }
    }

    // Propaga funcInfo do child para o root
    if (this.isFuncType.get(child)) {
      this._initFunc(root, this.funcInfo.get(child));
    }

    // Propaga promiseInfo do child para o root
    if (this.isPromiseType.get(child)) {
      this._initPromise(
        root,
        this.promiseResolve.get(child),
        this.promiseReject.get(child),
      );
    }

    // Propaga resolver/rejector do child para o root
    if (this.isResolverType.get(child))
      this._initResolver(root, this.resolverInner.get(child));
    if (this.isRejectorType.get(child))
      this._initRejector(root, this.rejectorInner.get(child));
    // Propaga estado de Class/Obj do child para o root
    if (this.classKind.has(child)) {
      const kindC = this.classKind.get(child);
      const nameC = this.className.get(child);
      const methodsC = this.classMethods.get(child) ?? new Map();
      if (this._initClassKind(root, kindC, nameC)) {
        this._mergeMethods(root, methodsC);
      }
    }
  }

  // ── Tipos concretos ────────────────────────────────────────────────────────
  _setBase(rx, type, ctx) {
    const cur = this.baseType.get(rx);
    if (cur) {
      const merged = mergeTypes(cur, type);
      if (merged === null)
        this.errors.push(`CONFLICT: ${cur} vs ${type}  (${ctx})`);
      else if (merged !== cur) this.baseType.set(rx, merged);
    } else if (this.isObj.get(rx)) {
      this.errors.push(`CONFLICT: obj vs ${type}  (${ctx})`);
    } else if (this.isArr.get(rx)) {
      if (isBaseType(type)) {
        // Array + base type → str|Array<T>, num|Array<T>, etc.
        this.baseType.set(rx, type);
        this.baseAndArr.set(rx, true);
      } else {
        this.errors.push(`CONFLICT: Array vs ${type}  (${ctx})`);
      }
    } else if (this.isFuncType.get(rx)) {
      this.errors.push(`CONFLICT: Func vs ${type}  (${ctx})`);
    } else if (this.isPromiseType.get(rx)) {
      this.errors.push(`CONFLICT: Promise vs ${type}  (${ctx})`);
    } else if (this.isResolverType.get(rx)) {
      this.errors.push(`CONFLICT: Resolver vs ${type}  (${ctx})`);
    } else if (this.isRejectorType.get(rx)) {
      this.errors.push(`CONFLICT: Rejector vs ${type}  (${ctx})`);
    } else {
      this.baseType.set(rx, type);
    }
  }

  _initObj(rx) {
    if (this.baseType.has(rx)) {
      this.errors.push(`CONFLICT: ${this.baseType.get(rx)} vs obj`);
      return;
    }
    if (this.isArr.get(rx)) {
      this.errors.push(`CONFLICT: Array vs obj`);
      return;
    }
    if (this.classKind.has(rx)) {
      this.errors.push(
        `CONFLICT: ${this.classKind.get(rx)}<${this.className.get(rx)}> vs obj`,
      );
      return;
    }
    this.isObj.set(rx, true);
    if (!this.objShape.has(rx)) this.objShape.set(rx, new Map());
  }

  _initArr(rx, elemTV) {
    const bt = this.baseType.get(rx);
    if (bt) {
      if (isBaseType(bt)) {
        // base type + Array → str|Array<T>, num|Array<T>, etc.
        this.isArr.set(rx, true);
        if (this.arrElem.has(rx)) this.union(this.arrElem.get(rx), elemTV);
        else this.arrElem.set(rx, elemTV);
        this.baseAndArr.set(rx, true);
        return;
      }
      this.errors.push(`CONFLICT: ${bt} vs Array`);
      return;
    }
    if (this.isObj.get(rx)) {
      this.errors.push(`CONFLICT: obj vs Array`);
      return;
    }
    if (this.classKind.has(rx)) {
      this.errors.push(
        `CONFLICT: ${this.classKind.get(rx)}<${this.className.get(rx)}> vs Array`,
      );
      return;
    }
    this.isArr.set(rx, true);
    if (this.arrElem.has(rx)) {
      this.union(this.arrElem.get(rx), elemTV);
    } else {
      this.arrElem.set(rx, elemTV);
    }
  }

  _initFunc(rx, info) {
    if (this.baseType.has(rx)) {
      this.errors.push(`CONFLICT: ${this.baseType.get(rx)} vs Func`);
      return;
    }
    if (this.isObj.get(rx)) {
      this.errors.push(`CONFLICT: obj vs Func`);
      return;
    }
    if (this.isArr.get(rx)) {
      this.errors.push(`CONFLICT: Array vs Func`);
      return;
    }
    if (this.isFuncType.get(rx)) {
      // Already a Func — unify common prefix of params and ret.
      // If the new signature has more params, upgrade to the longer one so that
      // a call with fewer args (e.g. early-return callback(err)) does not hide
      // the full signature seen at a later call site (e.g. callback(null, result)).
      const existing = this.funcInfo.get(rx);
      const n = Math.min(existing.params.length, info.params.length);
      for (let i = 0; i < n; i++)
        this.union(existing.params[i], info.params[i]);
      this.union(existing.ret, info.ret);
      if (info.params.length > existing.params.length)
        this.funcInfo.set(rx, info);
      return;
    }
    this.isFuncType.set(rx, true);
    this.funcInfo.set(rx, info);
  }

  _initPromise(rx, resolveTV, rejectTV) {
    if (this.baseType.has(rx)) {
      this.errors.push(`CONFLICT: ${this.baseType.get(rx)} vs Promise`);
      return;
    }
    if (this.isObj.get(rx)) {
      this.errors.push(`CONFLICT: obj vs Promise`);
      return;
    }
    if (this.isArr.get(rx)) {
      this.errors.push(`CONFLICT: Array vs Promise`);
      return;
    }
    if (this.isFuncType.get(rx)) {
      this.errors.push(`CONFLICT: Func vs Promise`);
      return;
    }
    if (this.isPromiseType.get(rx)) {
      this.union(this.promiseResolve.get(rx), resolveTV);
      this.union(this.promiseReject.get(rx), rejectTV);
      return;
    }
    this.isPromiseType.set(rx, true);
    this.promiseResolve.set(rx, resolveTV);
    this.promiseReject.set(rx, rejectTV);
  }

  _initResolver(rx, innerTV) {
    if (this.isResolverType.get(rx)) {
      this.union(this.resolverInner.get(rx), innerTV);
      return;
    }
    this.isResolverType.set(rx, true);
    this.resolverInner.set(rx, innerTV);
  }

  _initRejector(rx, innerTV) {
    if (this.isRejectorType.get(rx)) {
      this.union(this.rejectorInner.get(rx), innerTV);
      return;
    }
    this.isRejectorType.set(rx, true);
    this.rejectorInner.set(rx, innerTV);
  }

  _initClassKind(rx, kind, className) {
    if (this.baseType.has(rx)) {
      this.errors.push(
        `CONFLICT: ${this.baseType.get(rx)} vs ${kind}<${className}>`,
      );
      return false;
    }
    if (this.isObj.get(rx)) {
      this.errors.push(`CONFLICT: obj vs ${kind}<${className}>`);
      return false;
    }
    if (this.isArr.get(rx)) {
      this.errors.push(`CONFLICT: Array vs ${kind}<${className}>`);
      return false;
    }
    const curKind = this.classKind.get(rx);
    const curName = this.className.get(rx);
    if (curKind && (curKind !== kind || curName !== className)) {
      this.errors.push(
        `CONFLICT: ${curKind}<${curName}> vs ${kind}<${className}>`,
      );
      return false;
    }
    this.classKind.set(rx, kind);
    this.className.set(rx, className);
    if (!this.classMethods.has(rx)) this.classMethods.set(rx, new Map());
    return true;
  }

  _mergeMethods(rx, methods) {
    const existing = this.classMethods.get(rx);
    for (const [name, sig] of methods) {
      if (existing.has(name)) {
        const ex = existing.get(name);
        if (ex.length !== sig.length) {
          this.errors.push(
            `CONFLICT: arity mismatch on method ${name} (${ex.length} vs ${sig.length})`,
          );
        } else {
          for (let i = 0; i < ex.length; i++) this.union(ex[i], sig[i]);
        }
      } else {
        existing.set(name, sig);
      }
    }
  }

  // ── Processa uma constraint ────────────────────────────────────────────────
  process(lhs, rhs) {
    // case if base type literal appears at the left
    if (isBaseType(lhs)) {
      if (isTypeVar(rhs)) {
        this._setBase(this.find(rhs), lhs, `${lhs} <= ${rhs}`);
      }
      return;
    }

    if (isBaseType(rhs)) {
      this._setBase(this.find(lhs), rhs, `${lhs} <= ${rhs}`);
      this.consumedLits.add(rhs);
    } else if (isEmptyObj(rhs)) {
      this._initObj(this.find(lhs));
      this.consumedLits.add(rhs);
    } else if (isArray(rhs)) {
      const rx = this.find(lhs);
      const elemTV = parseArrayElem(rhs);
      this._initArr(rx, elemTV);
      this.consumedLits.add(rhs);
    } else if (isObjWithFlds(rhs)) {
      const rx = this.find(lhs);
      if (this.classKind.get(rx) === "Obj") {
        // Allow adding new attributes in class instance to avoid conflict
        const fieldMethods = new Map();
        for (const [f, tv] of parseFields(rhs)) fieldMethods.set(f, [tv]);
        this._mergeMethods(rx, fieldMethods);
      } else {
        this._initObj(rx);
        const shape = this.objShape.get(rx) ?? new Map();
        for (const [f, tv] of parseFields(rhs)) {
          if (shape.has(f)) {
            const existing = shape.get(f);
            if (isLiteral(tv)) this.process(existing, tv);
            else if (isLiteral(existing)) this.process(tv, existing);
            else this.union(existing, tv);
          } else {
            shape.set(f, tv);
          }
          this.objShape.set(rx, shape);
        }
      }
      this.consumedLits.add(rhs);
    } else if (isFunc(rhs)) {
      this._initFunc(this.find(lhs), parseFunc(rhs));
      this.consumedLits.add(rhs);
    } else if (isPromise(rhs)) {
      const { resolve, reject } = parsePromise(rhs);
      this._initPromise(this.find(lhs), resolve, reject);
      this.consumedLits.add(rhs);
    } else if (isResolver(rhs)) {
      this._initResolver(this.find(lhs), parseResolverInner(rhs));
      this.consumedLits.add(rhs);
    } else if (isRejector(rhs)) {
      this._initRejector(this.find(lhs), parseRejectorInner(rhs));
      this.consumedLits.add(rhs);
    } else if (isClassType(rhs) || isInstanceType(rhs)) {
      const rx = this.find(lhs);
      const { kind, className, methods } = parseClassOrInst(rhs);
      if (this._initClassKind(rx, kind, className)) {
        this._mergeMethods(rx, methods);
      }
      this.consumedLits.add(rhs);
    } else {
      // lhs <= rhs  (ambos type vars) → union
      this.union(lhs, rhs);
    }
  }

  // ── Tipo imediato de um nó (sem resolver recursivamente) ──────────────────
  immediateType(node) {
    if (isBaseType(node)) return node;
    const rep = this.find(node);
    const bt = this.baseType.get(rep);
    if (bt) {
      if (this.baseAndArr.has(rep)) {
        const elem = this.arrElem.get(rep);
        return `${bt} | Array<${this.find(elem)}>`;
      }
      return bt;
    }
    if (this.isArr.get(rep)) {
      const elem = this.arrElem.get(rep);
      return `Array<${this.find(elem)}>`;
    }
    if (this.isObj.get(rep)) {
      const shape = this.objShape.get(rep) ?? new Map();
      if (shape.size === 0) return "{}";
      const inner = [...shape.entries()]
        .map(([f, tv]) => `${f}: ${this.find(tv)}`)
        .join(", ");
      return `{${inner}}`;
    }
    if (this.isFuncType.get(rep)) {
      const { name, params, ret } = this.funcInfo.get(rep);
      const parts = [...params.map((p) => this.find(p)), this.find(ret)];
      return params.length === 0
        ? `Func<${name}>{() -> ${this.find(ret)}}`
        : `Func<${name}>{${parts.join(" -> ")}}`;
    }
    if (this.isPromiseType.get(rep)) {
      const res = this.find(this.promiseResolve.get(rep));
      const rej = this.find(this.promiseReject.get(rep));
      return `Promise<${res}, ${rej}>`;
    }
    if (this.isResolverType.get(rep))
      return `Resolver<${this.find(this.resolverInner.get(rep))}>`;
    if (this.isRejectorType.get(rep))
      return `Rejector<${this.find(this.rejectorInner.get(rep))}>`;
    if (this.classKind.has(rep)) {
      const kind = this.classKind.get(rep);
      const name = this.className.get(rep);
      const methods = this.classMethods.get(rep) ?? new Map();
      const entries = [...methods.entries()];
      const attrs = entries.filter(([, sig]) => sig.length === 1);
      const meths = entries.filter(([, sig]) => sig.length > 1);
      const inner = [...attrs, ...meths]
        .map(([n, sig]) => `${n}: ${sig.map((t) => this.find(t)).join(" -> ")}`)
        .join(", ");
      return `${kind}<${name}>[${inner}]`;
    }
    return null; // bot
  }

  // ── Tipo final resolvido ───────────────────────────────────────────────────
  resolveType(node, visited = new Set()) {
    if (isBaseType(node)) return node;
    const rep = this.find(node);
    if (visited.has(rep)) return rep;
    visited.add(rep);
    const bt = this.baseType.get(rep);
    if (bt) {
      if (this.baseAndArr.has(rep)) {
        const elem = this.arrElem.get(rep);
        return `${bt} | Array<${this.resolveType(elem, new Set(visited))}>`;
      }
      return bt;
    }
    if (this.isArr.get(rep)) {
      const elem = this.arrElem.get(rep);
      return `Array<${this.resolveType(elem, new Set(visited))}>`;
    }
    if (this.isObj.get(rep)) {
      const shape = this.objShape.get(rep) ?? new Map();
      if (shape.size === 0) return "{}";
      const inner = [...shape.entries()]
        .map(([f, tv]) => `${f}: ${this.resolveType(tv, new Set(visited))}`)
        .join(", ");
      return `{${inner}}`;
    }
    if (this.classKind.has(rep)) {
      const kind = this.classKind.get(rep);
      const name = this.className.get(rep);
      const methods = this.classMethods.get(rep) ?? new Map();
      const entries = [...methods.entries()];
      const attrs = entries.filter(([, sig]) => sig.length === 1);
      const meths = entries.filter(([, sig]) => sig.length > 1);
      const inner = [...attrs, ...meths]
        .map(
          ([n, sig]) =>
            `${n}: ${sig
              .map((t) => this.resolveType(t, new Set(visited)))
              .join(" -> ")}`,
        )
        .join(", ");
      return `${kind}<${name}>[${inner}]`;
    }
    if (this.isFuncType.get(rep)) {
      const { name, params, ret } = this.funcInfo.get(rep);
      const resolvedRet = this.resolveType(ret, new Set(visited));
      if (params.length === 0) return `Func<${name}>{() -> ${resolvedRet}}`;
      const resolvedParams = params.map((p) =>
        this.resolveType(p, new Set(visited)),
      );
      return `Func<${name}>{${[...resolvedParams, resolvedRet].join(" -> ")}}`;
    }
    if (this.isPromiseType.get(rep)) {
      const res = this.resolveType(this.promiseResolve.get(rep), new Set(visited));
      const rej = this.resolveType(this.promiseReject.get(rep), new Set(visited));
      if (isPromise(res)) return res;
      return `Promise<${res}, ${rej}>`;
    }
    if (this.isResolverType.get(rep))
      return `Resolver<${this.resolveType(this.resolverInner.get(rep), new Set(visited))}>`;
    if (this.isRejectorType.get(rep))
      return `Rejector<${this.resolveType(this.rejectorInner.get(rep), new Set(visited))}>`;
    return "bot";
  }

  // ── Display ────────────────────────────────────────────────────────────────
  // Mostra TODOS os nós registados (não só o representante de cada classe).
  // Literais já consumidos são omitidos.
  // Type vars com mesmo representante mostram o mesmo tipo mas ambas aparecem.
  displayState() {
    const parts = [];

    for (const node of this.displayList) {
      // Omite literais já absorvidos
      if (this.consumedLits.has(node)) continue;
      // Omite literais ainda pendentes (str, num, {}, {f:T}) que estejam no display
      if (isLiteral(node)) {
        parts.push(`${node}:bot`);
        continue;
      }

      const type = this.immediateType(node);
      if (!type) {
        parts.push(`${node}:bot`);
      } else if (type === "{}") {
        parts.push(`${node}:{}`);
      } else if (isBaseType(type)) {
        parts.push(`${node}:${type}`);
      } else {
        parts.push(`(${node}: ${type})`);
      }
    }
    return parts.join(", ");
  }
}

// ── Parsing ───────────────────────────────────────────────────────────────────
function parseConstraint(line) {
  const clean = line.replace(/^\s*C\d+:\s*/, "").trim();
  const idx = clean.indexOf(" <= ");
  if (idx === -1) return null;
  return { lhs: clean.slice(0, idx).trim(), rhs: clean.slice(idx + 4).trim() };
}

function parsePlusConstraint(line) {
  const clean = line.replace(/^\s*C\d+:\s*/, "").trim();
  const m = clean.match(/^plus\(([^,]+),([^,]+),([^)]+)\)$/);
  if (!m) return null;
  return { x1: m[1].trim(), x2: m[2].trim(), xr: m[3].trim() };
}

function parseUnionConstraint(line) {
  const clean = line.replace(/^\s*C\d+:\s*/, "").trim();
  const m = clean.match(/^union\(([^,]+),([^,]+),([^)]+)\)$/);
  if (!m) return null;
  return { x1: m[1].trim(), x2: m[2].trim(), xr: m[3].trim() };
}

function parseIndexConstraint(line) {
  const clean = line.replace(/^\s*C\d+:\s*/, "").trim();
  const m = clean.match(/^index\(([^,]+),([^,]+),([^)]+)\)$/);
  if (!m) return null;
  return { xobj: m[1].trim(), xidx: m[2].trim(), xresult: m[3].trim() };
}

function parseLogicalUnionConstraint(line) {
  const clean = line.replace(/^\s*C\d+:\s*/, "").trim();
  const m = clean.match(/^logical_union\(([^,]+),([^,]+),([^)]+)\)$/);
  if (!m) return null;
  return { x1: m[1].trim(), x2: m[2].trim(), xr: m[3].trim() };
}

function parseTplConstraint(line) {
  const clean = line.replace(/^\s*C\d+:\s*/, "").trim();
  const m = clean.match(/^tpl\(([^)]+)\)$/);
  if (!m) return null;
  return { xexpr: m[1].trim() };
}

// ── Main ──────────────────────────────────────────────────────────────────────
const STRUCTURAL = new Set(["obj", "arr", "func", "promise"]);

function resolvePlus(st, plusParsed) {
  const done = new Set();

  // Sets the result type of a + expression. process() records any conflict,
  // then we force-set the base type if it wasn't stored (structural conflict):
  // xr's type comes from its operands, not from downstream usage of xr.
  const setResult = (xr, type) => {
    st.process(xr, type);
    const rep = st.find(xr);
    if (!st.baseType.has(rep)) st.baseType.set(rep, type);
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < plusParsed.length; i++) {
      if (done.has(i)) continue;
      const { x1, x2, xr } = plusParsed[i];
      const k1 = st.kindOf(st.find(x1));
      const k2 = st.kindOf(st.find(x2));
      if (k1 === "str" || k2 === "str") {
        setResult(xr, "str");
        if (k1 === "str" && !k2) st.process(x2, "str");
        if (k2 === "str" && !k1) st.process(x1, "str");
        done.add(i);
        changed = true;
      } else if (k1 === "num" && k2 === "num") {
        setResult(xr, "num");
        done.add(i);
        changed = true;
      } else if (k1 === "num" && STRUCTURAL.has(k2)) {
        // obj/arr/func used in numeric context → conflict
        st.process(x2, "num");
        setResult(xr, "num");
        done.add(i);
        changed = true;
      } else if (k2 === "num" && STRUCTURAL.has(k1)) {
        st.process(x1, "num");
        setResult(xr, "num");
        done.add(i);
        changed = true;
      }
    }
  }
  // Operands still unresolved — any operand of + must be str or num
  for (let i = 0; i < plusParsed.length; i++) {
    if (done.has(i)) continue;
    const { x1, x2, xr } = plusParsed[i];
    if (!st.kindOf(st.find(x1))) st.process(x1, "num|str");
    if (!st.kindOf(st.find(x2))) st.process(x2, "num|str");
    setResult(xr, "num|str");
    done.add(i);
  }
}

function resolveUnion(st, unionParsed) {
  const setResult = (xr, type) => {
    st.process(xr, type);
    const rep = st.find(xr);
    if (!st.baseType.has(rep) && isBaseType(type)) st.baseType.set(rep, type);
  };

  for (const { x1, x2, xr } of unionParsed) {
    const k1 = st.kindOf(st.find(x1));
    const k2 = st.kindOf(st.find(x2));
    if (!k1 && !k2) continue; // both unresolved → xr stays bot
    if (!k1) {
      setResult(xr, k2);
      continue;
    } // only one branch known
    if (!k2) {
      setResult(xr, k1);
      continue;
    }
    if (k1 === k2) {
      setResult(xr, k1);
      continue;
    } // branches agree
    // Different types: produce a union if both are base types
    if (isBaseType(k1) && isBaseType(k2)) {
      const components = [
        ...new Set([...k1.split("|"), ...k2.split("|")]),
      ].sort();
      setResult(xr, components.join("|"));
    }
    // Structural types on different branches → xr stays bot
  }
}

function resolveTpl(st, tplParsed) {
  for (const { xexpr } of tplParsed) {
    const r = st.find(xexpr);
    const kind = st.kindOf(r);
    if (!kind) {
      // bot → str: the only constraint on this variable is that it is interpolated
      st.process(xexpr, "str");
    } else if (isBaseType(kind) && !kind.includes("str")) {
      // known base type (num, bool, void, or a union without str) → widen to kind|str
      const components = [...new Set([...kind.split("|"), "str"])].sort();
      st.baseType.set(r, components.join("|"));
    }
    // already str / already includes str / structural type → leave as-is
  }
}

function resolveLogicalUnion(st, logicalUnionParsed) {
  const setResult = (xr, type) => {
    st.process(xr, type);
    const rep = st.find(xr);
    if (!st.baseType.has(rep)) st.baseType.set(rep, type);
  };
  for (const { x1, x2, xr } of logicalUnionParsed) {
    const k1 = st.kindOf(st.find(x1));
    const k2 = st.kindOf(st.find(x2));
    if (!k1 || !k2) {
      // Backward: if xr already has a base type (from downstream usage) and x1
      // is unknown, infer x1's type from xr — when x1 is truthy, result = x1,
      // so x1 must be compatible with xr's type (e.g. delimiter || '.' → str|regexp)
      if (!k1) {
        const kr = st.kindOf(st.find(xr));
        if (kr && isBaseType(kr)) setResult(x1, kr);
      }
      continue;
    }
    if (k1 === k2) { setResult(xr, k1); continue; }
    if (isBaseType(k1) && isBaseType(k2)) {
      const components = [...new Set([...k1.split("|"), ...k2.split("|")])].sort();
      setResult(xr, components.join("|"));
    }
  }
}

function resolveIndex(st, indexParsed) {
  for (const { xobj, xidx, xresult } of indexParsed) {
    const robj = st.find(xobj);
    if (st.isArr.get(robj)) {
      // Array[i]: index must be num, result is the element type
      st.process(xidx, "num");
      const elemTV = st.arrElem.get(robj);
      if (elemTV) st.union(xresult, elemTV);
    } else if (st.isObj.get(robj)) {
      // obj[key]: key must be str; if all fields share one type, propagate it
      st.process(xidx, "str");
      const shape = st.objShape.get(robj) ?? new Map();
      const kinds = [...shape.values()]
        .map((fv) => st.kindOf(st.find(fv)))
        .filter(Boolean);
      const unique = [...new Set(kinds)];
      if (unique.length === 1) st.process(xresult, unique[0]);
    } else {
      // Unknown type being indexed by a str key → must be an object at minimum.
      const ridx = st.find(xidx);
      if (
        st.baseType.get(ridx) === "str" ||
        st.baseType.get(st.find(xidx)) === "str"
      ) {
        st.process(robj, "{}");
      }
    }
  }
}

function solve(input, quiet = false) {
  const parsed = [];
  const plusParsed = [];
  const unionParsed = [];
  const logicalUnionParsed = [];
  const indexParsed = [];
  const tplParsed = [];
  for (const line of input.split("\n")) {
    if (line.includes(" <= ")) {
      const c = parseConstraint(line);
      if (c) parsed.push(c);
    } else if (line.includes("plus(")) {
      const p = parsePlusConstraint(line);
      if (p) plusParsed.push(p);
    } else if (line.includes("logical_union(")) {
      const lu = parseLogicalUnionConstraint(line);
      if (lu) logicalUnionParsed.push(lu);
    } else if (line.includes("union(")) {
      const u = parseUnionConstraint(line);
      if (u) unionParsed.push(u);
    } else if (line.includes("index(")) {
      const ix = parseIndexConstraint(line);
      if (ix) indexParsed.push(ix);
    } else if (line.includes("tpl(")) {
      const t = parseTplConstraint(line);
      if (t) tplParsed.push(t);
    }
  }
  if (
    !parsed.length &&
    !plusParsed.length &&
    !unionParsed.length &&
    !tplParsed.length
  ) {
    console.log("(sem constraints)");
    return;
  }

  const SEP = "─".repeat(54);
  const st = new State();

  for (const c of parsed) st.regConstraint(c.lhs, c.rhs);
  for (const { x1, x2, xr } of plusParsed) {
    st._reg(x1);
    st._reg(x2);
    st._reg(xr);
  }
  for (const { x1, x2, xr } of unionParsed) {
    st._reg(x1);
    st._reg(x2);
    st._reg(xr);
  }
  for (const { x1, x2, xr } of logicalUnionParsed) {
    st._reg(x1);
    st._reg(x2);
    st._reg(xr);
  }
  for (const { xobj, xidx, xresult } of indexParsed) {
    st._reg(xobj);
    st._reg(xidx);
    st._reg(xresult);
  }
  for (const { xexpr } of tplParsed) {
    st._reg(xexpr);
  }

  if (!quiet) {
    console.log("\nConstraints:");
    const allC = [
      ...parsed.map((c) => `${c.lhs} <= ${c.rhs}`),
      ...plusParsed.map((p) => `plus(${p.x1},${p.x2},${p.xr})`),
      ...unionParsed.map((u) => `union(${u.x1},${u.x2},${u.xr})`),
      ...logicalUnionParsed.map((lu) => `logical_union(${lu.x1},${lu.x2},${lu.xr})`),
      ...tplParsed.map((t) => `tpl(${t.xexpr})`),
    ];
    const pad = String(allC.length).length;
    allC.forEach((c, i) =>
      console.log(`  C${String(i + 1).padStart(pad, "0")}: ${c}`),
    );

    console.log("\n" + SEP);
    console.log("Inicio:");
    console.log(" " + st.displayState());

    for (let i = 0; i < parsed.length; i++) {
      const { lhs, rhs } = parsed[i];
      st.process(lhs, rhs);
      console.log(`\n${i + 1}: [${lhs} <= ${rhs}]`);
      console.log(" " + st.displayState());
    }

    resolvePlus(st, plusParsed);
    resolveUnion(st, unionParsed);
    resolveLogicalUnion(st, logicalUnionParsed);
    resolveIndex(st, indexParsed);
    resolveTpl(st, tplParsed);
  } else {
    for (const { lhs, rhs } of parsed) st.process(lhs, rhs);
    resolvePlus(st, plusParsed);
    resolveUnion(st, unionParsed);
    resolveLogicalUnion(st, logicalUnionParsed);
    resolveIndex(st, indexParsed);
    resolveTpl(st, tplParsed);
  }

  console.log("\n" + SEP);
  if (st.errors.length) {
    console.log("⚠  ERROS DE TIPO:");
    st.errors.forEach((e) => console.log("   " + e));
  } else {
    console.log("✓  Sem conflitos.");
  }

  console.log("\nFINAL:");
  const progVars = [...st.seenNodes]
    .filter(
      (k) =>
        k.includes("__") && !isLiteral(k) && !k.startsWith("async_inner__"),
    )
    .sort();
  const maxLen = progVars.length
    ? Math.max(...progVars.map((v) => v.length))
    : 0;
  for (const v of progVars)
    console.log(`  ${v.padEnd(maxLen)}  :  ${st.resolveType(v)}`);
  console.log();
}

const args = process.argv.slice(2);
const quiet = args.includes("-q") || args.includes("--quiet");
const fileArg = args.find((a) => !a.startsWith("-"));

if (fileArg) {
  solve(require("fs").readFileSync(fileArg, "utf8"), quiet);
} else if (!process.stdin.isTTY) {
  const chunks = [];
  process.stdin.on("data", (d) => chunks.push(d));
  process.stdin.on("end", () => solve(chunks.join(""), quiet));
}
