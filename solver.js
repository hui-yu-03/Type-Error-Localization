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
    // blame[i] = origin of the constraint being processed when errors[i] was
    // found (set only when the input carries origins, i.e. JSON input)
    this.blame = [];
    this.currentOrigin = null;

    this.displayList = []; // todos os nós em ordem de aparição
    this.seenNodes = new Set();
    this.consumedLits = new Set(); // literais já absorvidos
  }

  reportError(msg) {
    this.errors.push(msg);
    this.blame.push(this.currentOrigin);
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
    this.reportError(`CONFLICT: ${ka} vs ${kb}  (union(${a},${b}))`);
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
        this.reportError(`CONFLICT: ${cur} vs ${type}  (${ctx})`);
      else if (merged !== cur) this.baseType.set(rx, merged);
    } else if (this.isObj.get(rx)) {
      this.reportError(`CONFLICT: obj vs ${type}  (${ctx})`);
    } else if (this.isArr.get(rx)) {
      if (type === "str") {
        // a string is indexable like an array (s[0], s.length): str|Array<T>
        this.baseType.set(rx, type);
        this.baseAndArr.set(rx, true);
      } else {
        this.reportError(`CONFLICT: Array vs ${type}  (${ctx})`);
      }
    } else if (this.isFuncType.get(rx)) {
      this.reportError(`CONFLICT: Func vs ${type}  (${ctx})`);
    } else if (this.isPromiseType.get(rx)) {
      this.reportError(`CONFLICT: Promise vs ${type}  (${ctx})`);
    } else if (this.isResolverType.get(rx)) {
      this.reportError(`CONFLICT: Resolver vs ${type}  (${ctx})`);
    } else if (this.isRejectorType.get(rx)) {
      this.reportError(`CONFLICT: Rejector vs ${type}  (${ctx})`);
    } else {
      this.baseType.set(rx, type);
    }
  }

  _initObj(rx) {
    if (this.baseType.has(rx)) {
      this.reportError(`CONFLICT: ${this.baseType.get(rx)} vs obj`);
      return;
    }
    if (this.isArr.get(rx)) {
      this.reportError(`CONFLICT: Array vs obj`);
      return;
    }
    if (this.isPromiseType.get(rx)) {
      this.reportError(`CONFLICT: Promise vs obj`);
      return;
    }
    if (this.isFuncType.get(rx)) {
      this.reportError(`CONFLICT: Func vs obj`);
      return;
    }
    if (this.classKind.has(rx)) {
      this.reportError(
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
      if (bt === "str") {
        // a string is indexable like an array (s[0], s.length): str|Array<T>
        this.isArr.set(rx, true);
        if (this.arrElem.has(rx)) this.union(this.arrElem.get(rx), elemTV);
        else this.arrElem.set(rx, elemTV);
        this.baseAndArr.set(rx, true);
        return;
      }
      this.reportError(`CONFLICT: ${bt} vs Array`);
      return;
    }
    if (this.isObj.get(rx)) {
      this.reportError(`CONFLICT: obj vs Array`);
      return;
    }
    if (this.isPromiseType.get(rx)) {
      this.reportError(`CONFLICT: Promise vs Array`);
      return;
    }
    if (this.isFuncType.get(rx)) {
      this.reportError(`CONFLICT: Func vs Array`);
      return;
    }
    if (this.classKind.has(rx)) {
      this.reportError(
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
      this.reportError(`CONFLICT: ${this.baseType.get(rx)} vs Func`);
      return;
    }
    if (this.isObj.get(rx)) {
      this.reportError(`CONFLICT: obj vs Func`);
      return;
    }
    if (this.isArr.get(rx)) {
      this.reportError(`CONFLICT: Array vs Func`);
      return;
    }
    if (this.isPromiseType.get(rx)) {
      this.reportError(`CONFLICT: Promise vs Func`);
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
      this.reportError(`CONFLICT: ${this.baseType.get(rx)} vs Promise`);
      return;
    }
    if (this.isObj.get(rx)) {
      this.reportError(`CONFLICT: obj vs Promise`);
      return;
    }
    if (this.isArr.get(rx)) {
      this.reportError(`CONFLICT: Array vs Promise`);
      return;
    }
    if (this.isFuncType.get(rx)) {
      this.reportError(`CONFLICT: Func vs Promise`);
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
      this.reportError(
        `CONFLICT: ${this.baseType.get(rx)} vs ${kind}<${className}>`,
      );
      return false;
    }
    if (this.isObj.get(rx)) {
      this.reportError(`CONFLICT: obj vs ${kind}<${className}>`);
      return false;
    }
    if (this.isArr.get(rx)) {
      this.reportError(`CONFLICT: Array vs ${kind}<${className}>`);
      return false;
    }
    const curKind = this.classKind.get(rx);
    const curName = this.className.get(rx);
    if (curKind && (curKind !== kind || curName !== className)) {
      this.reportError(
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
          this.reportError(
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
// ── Deferred constraints ──────────────────────────────────────────────────────
// plus (+), union (?:), logical_union (&&, ||), index (o[i]) and tpl (`${x}`)
// are resolved after the main pass.  The precise rules below are applied
// repeatedly until nothing changes, so that the result does not depend on the
// order of the constraints; one-sided inferences are applied only when no
// precise rule applies any more, and defaults only at the very end.

// The kinds a TV may have: base type names ("num", "str", ... — several for a
// union such as num|str), a structural kind ("obj", "arr", "func", ...), or null.
function kindsOf(st, x) {
  const k = st.kindOf(st.find(x));
  return k ? k.split("|") : null;
}

// A kind as a type literal that process() understands (null: none exists).
function kindLiteral(kind) {
  if (isBaseType(kind)) return kind;
  if (kind === "obj") return "{}";
  return null; // arr/func/promise need component TVs: leave unconstrained
}

// xr's type comes from the operands, not from the downstream uses of xr:
// after a conflict the base type is still recorded for display.
function setResult(st, xr, type) {
  st.process(xr, type);
  const rep = st.find(xr);
  if (!st.baseType.has(rep) && isBaseType(type)) st.baseType.set(rep, type);
}

// + is numeric addition (num + num -> num) or concatenation (a string on
// either side -> str); anything else is a type error (as in TypeScript).
function plusCombinations(s1, s2) {
  const ok1 = new Set(), ok2 = new Set(), res = new Set();
  for (const a of s1)
    for (const b of s2) {
      if (a === "num" && b === "num") res.add("num");
      else if (a === "str" || b === "str") res.add("str");
      else continue;
      ok1.add(a);
      ok2.add(b);
    }
  return { ok1, ok2, res };
}

function narrowBase(st, x, kinds, ok) {
  if (kinds.every(isBaseType) && ok.size < kinds.length && ok.size > 0)
    st.process(x, [...ok].sort().join("|"));
}

function precisePlus(st, list, done) {
  let changed = false;
  list.forEach(({ x1, x2, xr, origin }, i) => {
    if (done.has(i)) return;
    st.currentOrigin = origin ?? null;
    const s1 = kindsOf(st, x1), s2 = kindsOf(st, x2);
    const isStr = (s) => s && s.length === 1 && s[0] === "str";
    if (isStr(s1) || isStr(s2)) {
      setResult(st, xr, "str"); // a string concatenated with anything
    } else if (s1 && s2) {
      const { ok1, ok2, res } = plusCombinations(s1, s2);
      const isNum = (s) => s.length === 1 && s[0] === "num";
      if (res.size === 0 && (isNum(s1) || isNum(s2))) {
        // a number with something that is neither a number nor a string:
        // numeric addition is meant, so the other operand must be a number
        st.process(isNum(s1) ? x2 : x1, "num");
        setResult(st, xr, "num");
      } else if (res.size === 0) {
        st.reportError(`CONFLICT: ${s1.join("|")} + ${s2.join("|")}  (plus(${x1},${x2},${xr}))`);
      } else {
        narrowBase(st, x1, s1, ok1);
        narrowBase(st, x2, s2, ok2);
        setResult(st, xr, [...res].sort().join("|"));
      }
    } else {
      // one side known: if it can be neither a number nor a string, the
      // other side must be a string (concatenation)
      const known = s1 ?? s2;
      if (!known || known.includes("num") || known.includes("str")) return;
      st.process(s1 ? x2 : x1, "str");
      setResult(st, xr, "str");
    }
    done.add(i);
    changed = true;
  });
  return changed;
}

function joinKinds(k1, k2) {
  if (k1.join("|") === k2.join("|")) return k1.join("|");
  if ([...k1, ...k2].every(isBaseType)) return [...new Set([...k1, ...k2])].sort().join("|");
  return null; // different structural kinds: no single literal
}

// c ? a : b and a && b, a || b: the result is one of the operands.
function preciseChoice(st, list, done) {
  let changed = false;
  list.forEach(({ x1, x2, xr, origin }, i) => {
    if (done.has(i)) return;
    const k1 = kindsOf(st, x1), k2 = kindsOf(st, x2);
    if (!k1 || !k2) return;
    st.currentOrigin = origin ?? null;
    const j = joinKinds(k1, k2);
    const lit = j && (isBaseType(j) ? j : kindLiteral(j));
    if (lit) setResult(st, xr, lit);
    done.add(i);
    changed = true;
  });
  return changed;
}

function preciseIndex(st, list, done) {
  let changed = false;
  list.forEach(({ xobj, xidx, xresult, origin }, i) => {
    if (done.has(i)) return;
    const robj = st.find(xobj);
    const kinds = kindsOf(st, xobj);
    if (!kinds) return;
    st.currentOrigin = origin ?? null;
    if (st.isArr.get(robj)) {
      // Array[i]: index must be num, result is the element type
      st.process(xidx, "num");
      const elemTV = st.arrElem.get(robj);
      if (elemTV) st.union(xresult, elemTV);
    } else if (st.isObj.get(robj)) {
      // obj[key]: key must be str; if all fields share one type, propagate it
      st.process(xidx, "str");
      const shape = st.objShape.get(robj) ?? new Map();
      const fieldKinds = [...shape.values()]
        .map((fv) => st.kindOf(st.find(fv)))
        .filter(Boolean);
      const unique = [...new Set(fieldKinds)];
      const lit = unique.length === 1 ? kindLiteral(unique[0]) : null;
      if (lit) st.process(xresult, lit);
    } else if (kinds.includes("str")) {
      // s[i]: a character
      st.process(xidx, "num");
      st.process(xresult, "str");
    } else {
      st.reportError(`CONFLICT: cannot index ${kinds.join("|")}  (index(${xobj},${xidx},${xresult}))`);
    }
    done.add(i);
    changed = true;
  });
  return changed;
}

// One-sided rules, used only when no precise rule applies.
function weakRules(st, d, done) {
  let changed = false;
  d.unionParsed.forEach(({ x1, x2, xr, origin }, i) => {
    if (done.union.has(i)) return;
    const k1 = kindsOf(st, x1), k2 = kindsOf(st, x2);
    const k = k1 ?? k2;
    if (!k || (k1 && k2)) return;
    st.currentOrigin = origin ?? null;
    const lit = kindLiteral(k.join("|")) ?? (k.every(isBaseType) ? k.join("|") : null);
    if (lit) setResult(st, xr, lit); // only one branch known
    done.union.add(i);
    changed = true;
  });
  d.logicalUnionParsed.forEach(({ x1, xr, origin }, i) => {
    if (done.logical.has(i) || kindsOf(st, x1)) return;
    // Backward: when x1 is truthy the result is x1, so an unknown x1 must be
    // compatible with the type of the result (e.g. delimiter || '.' -> str|regexp)
    const kr = st.kindOf(st.find(xr));
    if (!kr || !isBaseType(kr)) return;
    st.currentOrigin = origin ?? null;
    setResult(st, x1, kr);
    changed = true;
  });
  d.indexParsed.forEach(({ xobj, xidx, origin }, i) => {
    if (done.index.has(i) || kindsOf(st, xobj)) return;
    // Unknown type indexed by a string key -> an object
    const ki = kindsOf(st, xidx);
    if (!ki || ki.join("|") !== "str") return;
    st.currentOrigin = origin ?? null;
    st.process(xobj, "{}");
    changed = true;
  });
  return changed;
}

function resolveDeferred(st, d) {
  const done = { plus: new Set(), union: new Set(), logical: new Set(), index: new Set() };
  const precise = () => {
    let any = false;
    for (;;) {
      const c =
        precisePlus(st, d.plusParsed, done.plus) |
        preciseChoice(st, d.unionParsed, done.union) |
        preciseChoice(st, d.logicalUnionParsed, done.logical) |
        preciseIndex(st, d.indexParsed, done.index);
      if (!c) return any;
      any = true;
    }
  };
  do precise();
  while (weakRules(st, d, done));
  // Operands of + still unknown: a number or a string
  d.plusParsed.forEach(({ x1, x2, origin }, i) => {
    if (done.plus.has(i)) return;
    st.currentOrigin = origin ?? null;
    if (!kindsOf(st, x1)) st.process(x1, "num|str");
    if (!kindsOf(st, x2)) st.process(x2, "num|str");
  });
  precise();
  resolveTpl(st, d.tplParsed);
}

function resolveTpl(st, tplParsed) {
  for (const { xexpr, origin } of tplParsed) {
    st.currentOrigin = origin ?? null;
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

// Input is either the text printed by `node infer.js` or the JSON printed by
// `node infer.js --json`.  With JSON input every parsed constraint keeps its
// origin (source line), so that conflicts can be blamed on a line.
function parseInput(input) {
  const lists = {
    parsed: [],
    plusParsed: [],
    unionParsed: [],
    logicalUnionParsed: [],
    indexParsed: [],
    tplParsed: [],
  };
  const addLine = (line, origin) => {
    let item = null,
      list = null;
    if (line.includes(" <= ")) {
      item = parseConstraint(line);
      list = lists.parsed;
    } else if (line.includes("plus(")) {
      item = parsePlusConstraint(line);
      list = lists.plusParsed;
    } else if (line.includes("logical_union(")) {
      item = parseLogicalUnionConstraint(line);
      list = lists.logicalUnionParsed;
    } else if (line.includes("union(")) {
      item = parseUnionConstraint(line);
      list = lists.unionParsed;
    } else if (line.includes("index(")) {
      item = parseIndexConstraint(line);
      list = lists.indexParsed;
    } else if (line.includes("tpl(")) {
      item = parseTplConstraint(line);
      list = lists.tplParsed;
    }
    if (item) {
      if (origin) item.origin = origin;
      list.push(item);
    }
  };
  const trimmed = input.trimStart();
  if (trimmed.startsWith("{")) {
    for (const c of JSON.parse(trimmed).constraints) addLine(c.text, c);
  } else {
    for (const line of input.split("\n")) addLine(line, null);
  }
  return lists;
}

// Machine-readable result for `--json`: the conflicts in the order the solver
// met them (the first one is what a first-conflict checker reports) and the
// final types.
function printJsonResult(st) {
  const conflicts = st.errors.map((message, i) => {
    const o = st.blame[i];
    return {
      message,
      constraint: o ? o.id : null,
      text: o ? o.text : null,
      line: o && o.source === "program" ? o.line : null,
    };
  });
  const types = {};
  const progVars = [...st.seenNodes]
    .filter(
      (k) =>
        k.includes("__") && !isLiteral(k) && !k.startsWith("async_inner__"),
    )
    .sort();
  for (const v of progVars) types[v] = st.resolveType(v);
  console.log(JSON.stringify({ conflicts, types }));
}

function solve(input, quiet = false, json = false) {
  const {
    parsed,
    plusParsed,
    unionParsed,
    logicalUnionParsed,
    indexParsed,
    tplParsed,
  } = parseInput(input);
  if (
    !parsed.length &&
    !plusParsed.length &&
    !unionParsed.length &&
    !tplParsed.length
  ) {
    if (json) console.log(JSON.stringify({ conflicts: [], types: {} }));
    else console.log("(sem constraints)");
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

  if (json) {
    for (const c of parsed) {
      st.currentOrigin = c.origin ?? null;
      st.process(c.lhs, c.rhs);
    }
    resolveDeferred(st, { plusParsed, unionParsed, logicalUnionParsed, indexParsed, tplParsed });
    printJsonResult(st);
    return;
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

    resolveDeferred(st, { plusParsed, unionParsed, logicalUnionParsed, indexParsed, tplParsed });
  } else {
    for (const { lhs, rhs } of parsed) st.process(lhs, rhs);
    resolveDeferred(st, { plusParsed, unionParsed, logicalUnionParsed, indexParsed, tplParsed });
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

// Usage: node infer.js f.js | node solver.js [-q] [--json]
//   -q      do not print the intermediate states
//   --json  print {conflicts, types} as JSON (needs `infer.js --json` input
//           for the conflicts to carry source lines)
const args = process.argv.slice(2);
const quiet = args.includes("-q") || args.includes("--quiet");
const json = args.includes("--json");
const fileArg = args.find((a) => !a.startsWith("-"));

if (fileArg) {
  solve(require("fs").readFileSync(fileArg, "utf8"), quiet, json);
} else if (!process.stdin.isTTY) {
  const chunks = [];
  process.stdin.on("data", (d) => chunks.push(d));
  process.stdin.on("end", () => solve(chunks.join(""), quiet, json));
}
