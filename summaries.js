"use strict";

// Demand-driven type summaries for known modules.
// Each entry: summaries[moduleName][methodName] = { params: TypeSpec[], ret: TypeSpec }
//
// TypeSpec:
//   'str' | 'num' | 'bool' | 'void' | '{}'
//   { kind: 'func', name: string, params: TypeSpec[], ret: TypeSpec }
//   { kind: 'array', elem: TypeSpec }
//
// Only methods actually accessed in the analysed file get instantiated.

function buildTypeTV(spec, name, fresh, addCons) {
  if (spec === null || spec?.kind === "any") return fresh();
  if (typeof spec === "string") {
    const v = fresh();
    addCons(v, spec);
    return v;
  }
  if (spec.optional && spec.type) {
    return buildTypeTV(spec.type, name, fresh, addCons);
  }
  if (spec.kind === "func") {
    const label = spec.name ?? name;
    const pTVs = spec.params.map((p, i) =>
      buildTypeTV(p, `${label}_p${i}`, fresh, addCons),
    );
    const r = buildTypeTV(spec.ret, `${label}_ret`, fresh, addCons);
    const fn = fresh();
    if (pTVs.length === 0) {
      addCons(fn, `Func<${label}>{() -> ${r}}`);
    } else {
      addCons(fn, `Func<${label}>{${[...pTVs, r].join(" -> ")}}`);
    }
    return fn;
  }
  if (spec.kind === "array") {
    const elem = buildTypeTV(spec.elem, `${name}_elem`, fresh, addCons);
    const v = fresh();
    addCons(v, `Array<${elem}>`);
    return v;
  }
  if (spec.kind === "obj") {
    // Return a shared TV that accumulates only the fields actually used at call sites.
    // Initialised to {} so it shows as an object (not bot) when the optional param
    // is omitted entirely. Field constraints are added demand-driven in infer.js.
    if (!spec._sharedTV) {
      spec._sharedTV = fresh();
      addCons(spec._sharedTV, "{}");
    }
    return spec._sharedTV;
  }
  if (spec.kind === "struct") {
    // Eagerly build a concrete object TV with all known fields.
    const v = fresh();
    addCons(v, "{}");
    for (const [field, type] of Object.entries(spec.fields)) {
      const fieldTV = buildTypeTV(type, `${name}_${field}`, fresh, addCons);
      addCons(v, `{${field}: ${fieldTV}}`);
    }
    return v;
  }
  if (spec.kind === "promise") {
    const resolveTV = buildTypeTV(
      spec.resolve ?? "{}",
      `${name}_ok`,
      fresh,
      addCons,
    );
    const rejectTV = buildTypeTV(
      spec.reject ?? "{}",
      `${name}_err`,
      fresh,
      addCons,
    );
    const v = fresh();
    addCons(v, `Promise<${resolveTV},${rejectTV}>`);
    return v;
  }
  return fresh();
}

function buildMethodTV(modName, propName, sig, fresh, addCons) {
  return buildTypeTV(
    { kind: "func", name: propName, params: sig.params, ret: sig.ret },
    `${modName}_${propName}`,
    fresh,
    addCons,
  );
}

const summaries = {};
summaries.buildMethodTV = buildMethodTV;
summaries.buildTypeTV = buildTypeTV;

// ── Node.js built-ins ─────────────────────────────────────────────────────────

const CHILD_PROCESS_OPTS = {
  kind: "obj",
  optional: true,
  fields: {
    cwd: "str",
    env: "{}",
    timeout: "num",
    encoding: "str",
    shell: "str",
    maxBuffer: "num",
  },
};

summaries["child_process"] = {
  exec: {
    params: [
      "str",
      CHILD_PROCESS_OPTS,
      {
        kind: "func",
        name: "exec_cb",
        params: ["bool", "str", "str"],
        ret: "void",
      },
    ],
    ret: "void",
  },
  execSync: { params: ["str", CHILD_PROCESS_OPTS], ret: "str" },
  spawn: { params: ["str", { kind: "array", elem: "str" }], ret: "{}" },
};

const EXECA_OPTS = {
  kind: "obj",
  optional: true,
  fields: {
    cwd: "str",
    env: "{}",
    timeout: "num",
    encoding: "str",
    shell: "str",
    reject: "bool",
  },
};

const EXECA_RESULT = {
  kind: "struct",
  fields: {
    stdout: "str",
    stderr: "str",
    code: "num",
    failed: "bool",
    killed: "bool",
    timedOut: "bool",
    cmd: "str",
  },
};

const EXECA_ERROR = {
  kind: "struct",
  fields: {
    stdout: "str",
    stderr: "str",
    code: "num",
    failed: "bool",
    killed: "bool",
    timedOut: "bool",
    cmd: "str",
    message: "str",
  },
};

const EXECA_RET = {
  kind: "promise",
  resolve: EXECA_RESULT,
  reject: EXECA_ERROR,
};

summaries["execa"] = {
  // v1/v2: execa.shell(cmd, opts?) — runs command in shell
  shell: { params: ["str", EXECA_OPTS], ret: EXECA_RET },
  shellSync: { params: ["str", EXECA_OPTS], ret: EXECA_RESULT },
  // v3+: execa.command(cmd, opts?) — replacement for shell
  command: { params: ["str", EXECA_OPTS], ret: EXECA_RET },
};

const URL_PARSE_RESULT = {
  kind: "struct",
  fields: {
    href: "str",
    protocol: "str",
    slashes: "bool",
    auth: "str",
    host: "str",
    port: "str",
    hostname: "str",
    hash: "str",
    search: "str",
    query: "str",
    pathname: "str",
    path: "str",
  },
};

summaries["url"] = {
  parse: {
    params: ["str", { type: "bool", optional: true }],
    ret: URL_PARSE_RESULT,
  },
  format: { params: ["{}"], ret: "str" },
  resolve: { params: ["str", "str"], ret: "str" },
};

summaries["path"] = {
  join: { params: ["str"], ret: "str" },
  resolve: { params: ["str"], ret: "str" },
  dirname: { params: ["str"], ret: "str" },
  basename: { params: ["str"], ret: "str" },
  extname: { params: ["str"], ret: "str" },
  normalize: { params: ["str"], ret: "str" },
  relative: { params: ["str", "str"], ret: "str" },
  isAbsolute: { params: ["str"], ret: "bool" },
  parse: { params: ["str"], ret: "{}" },
  format: { params: ["{}"], ret: "str" },
};

summaries["vm"] = {
  createContext: { params: ["{}"], ret: "{}" },
  runInContext: { params: ["str", "{}", CHILD_PROCESS_OPTS], ret: "{}" },
  runInNewContext: { params: ["str", "{}", CHILD_PROCESS_OPTS], ret: "{}" },
  runInThisContext: { params: ["str", CHILD_PROCESS_OPTS], ret: "{}" },
  isContext: { params: ["{}"], ret: "bool" },
  compileFunction: { params: ["str", "{}"], ret: "{}" },
};

summaries["fs"] = {
  readFileSync: { params: ["str", "str"], ret: "str" },
  writeFileSync: { params: ["str", "str"], ret: "void" },
  readFile: {
    params: [
      "str",
      { type: "str", optional: true },
      {
        kind: "func",
        name: "readFile_cb",
        params: ["bool", "str"],
        ret: "void",
      },
    ],
    ret: "void",
  },
  writeFile: {
    params: [
      "str",
      "str",
      { kind: "func", name: "writeFile_cb", params: [], ret: "void" },
    ],
    ret: "void",
  },
  stat: {
    params: [
      "str",
      { kind: "func", name: "stat_cb", params: ["bool", "{}"], ret: "void" },
    ],
    ret: "void",
  },
  createWriteStream: { params: ["str", "{}"], ret: "{}" },
};

summaries["util"] = {
  format: { params: ["str", "str"], ret: "str" },
};

// Options bag accepted by most semver functions (loose parsing, prerelease inclusion).
const SEMVER_OPTS = {
  kind: "obj",
  optional: true,
  fields: { loose: "bool", includePrerelease: "bool" },
};

summaries["semver"] = {
  // Comparisons — (v1, v2[, opts]) → bool
  lt: { params: ["str", "str", SEMVER_OPTS], ret: "bool" },
  gt: { params: ["str", "str", SEMVER_OPTS], ret: "bool" },
  gte: { params: ["str", "str", SEMVER_OPTS], ret: "bool" },
  lte: { params: ["str", "str", SEMVER_OPTS], ret: "bool" },
  eq: { params: ["str", "str", SEMVER_OPTS], ret: "bool" },
  neq: { params: ["str", "str", SEMVER_OPTS], ret: "bool" },

  // Numeric ordering — (v1, v2[, opts]) → num  (-1 | 0 | 1)
  compare: { params: ["str", "str", SEMVER_OPTS], ret: "num" },
  rcompare: { params: ["str", "str", SEMVER_OPTS], ret: "num" },
  compareLoose: { params: ["str", "str"], ret: "num" },

  // Range checks
  satisfies: { params: ["str", "str", SEMVER_OPTS], ret: "bool" },
  outside: { params: ["str", "str", "str", SEMVER_OPTS], ret: "bool" },
  gtr: { params: ["str", "str", SEMVER_OPTS], ret: "bool" },
  ltr: { params: ["str", "str", SEMVER_OPTS], ret: "bool" },
  intersects: { params: ["str", "str", SEMVER_OPTS], ret: "bool" },

  // Validation / normalisation — returns the cleaned string or null (approximated as str)
  valid: { params: ["str", SEMVER_OPTS], ret: "str" },
  clean: { params: ["str", SEMVER_OPTS], ret: "str" },
  validRange: { params: ["str", SEMVER_OPTS], ret: "str" },
  coerce: { params: ["str", SEMVER_OPTS], ret: "{}" },

  // Version arithmetic
  inc: { params: ["str", "str", SEMVER_OPTS], ret: "str" },
  diff: { params: ["str", "str"], ret: "str" },

  // Component extraction
  major: { params: ["str", SEMVER_OPTS], ret: "num" },
  minor: { params: ["str", SEMVER_OPTS], ret: "num" },
  patch: { params: ["str", SEMVER_OPTS], ret: "num" },
  prerelease: {
    params: ["str", SEMVER_OPTS],
    ret: { kind: "array", elem: "str" },
  },

  // Array helpers
  sort: {
    params: [{ kind: "array", elem: "str" }],
    ret: { kind: "array", elem: "str" },
  },
  rsort: {
    params: [{ kind: "array", elem: "str" }],
    ret: { kind: "array", elem: "str" },
  },
  maxSatisfying: {
    params: [{ kind: "array", elem: "str" }, "str", SEMVER_OPTS],
    ret: "str",
  },
  minSatisfying: {
    params: [{ kind: "array", elem: "str" }, "str", SEMVER_OPTS],
    ret: "str",
  },
  minVersion: { params: ["str", SEMVER_OPTS], ret: "{}" },
};

summaries["shelljs"] = {
  exec: {
    params: ["str", { type: "{}", optional: true }],
    ret: { kind: "struct", fields: { code: "num", output: "str" } },
  },
};

summaries["http"] = {
  createServer: {
    params: [
      {
        kind: "func",
        name: "requestListener",
        params: ["{}", "{}"],
        ret: "void",
      },
    ],
    ret: "{}",
  },
  request: {
    params: [
      "{}",
      { kind: "func", name: "http_request_cb", params: ["{}"], ret: "void" },
    ],
    ret: "{}",
  },
  get: {
    params: [
      "str",
      { kind: "func", name: "http_get_cb", params: ["{}"], ret: "void" },
    ],
    ret: "{}",
  },
};

summaries["https"] = {
  createServer: {
    params: [
      "{}",
      {
        kind: "func",
        name: "https_requestListener",
        params: ["{}", "{}"],
        ret: "void",
      },
    ],
    ret: "{}",
  },
  request: {
    params: [
      "{}",
      { kind: "func", name: "https_request_cb", params: ["{}"], ret: "void" },
    ],
    ret: "{}",
  },
  get: {
    params: [
      "str",
      { kind: "func", name: "https_get_cb", params: ["{}"], ret: "void" },
    ],
    ret: "{}",
  },
};

// ── JS built-in globals ───────────────────────────────────────────────────────
// These are pre-declared in the initial environment (not via require()).

summaries["JSON"] = {
  stringify: { params: ["bot"], ret: "str" },
  parse: { params: ["str"], ret: "{}" },
};

summaries["Math"] = {
  abs: { params: ["num"], ret: "num" },
  ceil: { params: ["num"], ret: "num" },
  floor: { params: ["num"], ret: "num" },
  round: { params: ["num"], ret: "num" },
  sqrt: { params: ["num"], ret: "num" },
  pow: { params: ["num", "num"], ret: "num" },
  max: { params: ["num", "num"], ret: "num" },
  min: { params: ["num", "num"], ret: "num" },
  log: { params: ["num"], ret: "num" },
  random: { params: [], ret: "num" },
  trunc: { params: ["num"], ret: "num" },
};

summaries["console"] = {
  log: { params: ["{}"], ret: "void" },
  error: { params: ["{}"], ret: "void" },
  warn: { params: ["{}"], ret: "void" },
  info: { params: ["{}"], ret: "void" },
  debug: { params: ["{}"], ret: "void" },
};

summaries["process"] = {
  exit: { params: ["num"], ret: "void" },
  cwd: { params: [], ret: "str" },
  chdir: { params: ["str"], ret: "void" },
  env: { kind: "prop", type: "stringmap" },
  argv: { kind: "prop", type: { kind: "array", elem: "str" } },
  platform: { kind: "prop", type: "str" },
  version: { kind: "prop", type: "str" },
  pid: { kind: "prop", type: "num" },
  stdout: { kind: "prop", type: "{}" },
  stderr: { kind: "prop", type: "{}" },
};

summaries["Number"] = {
  parseInt: { params: ["str", "num"], ret: "num" },
  parseFloat: { params: ["str"], ret: "num" },
  isInteger: { params: ["{}"], ret: "bool" },
  isFinite: { params: ["{}"], ret: "bool" },
  isNaN: { params: ["{}"], ret: "bool" },
  isSafeInteger: { params: ["{}"], ret: "bool" },
  MAX_VALUE: { kind: "prop", type: "num" },
  MIN_VALUE: { kind: "prop", type: "num" },
  MAX_SAFE_INTEGER: { kind: "prop", type: "num" },
  MIN_SAFE_INTEGER: { kind: "prop", type: "num" },
  POSITIVE_INFINITY: { kind: "prop", type: "num" },
  NEGATIVE_INFINITY: { kind: "prop", type: "num" },
  NaN: { kind: "prop", type: "num" },
  EPSILON: { kind: "prop", type: "num" },
};

summaries["Array"] = {
  isArray: { params: [{ kind: "any" }], ret: "bool" },
  from: { params: ["{}"], ret: { kind: "array", elem: "{}" } },
  of: { params: ["{}"], ret: { kind: "array", elem: "{}" } },
};

summaries["Object"] = {
  keys: { params: ["{}"], ret: { kind: "array", elem: "str" } },
  values: { params: ["{}"], ret: { kind: "array", elem: "{}" } },
  entries: { params: ["{}"], ret: { kind: "array", elem: "{}" } },
  assign: { params: ["{}"], ret: "{}" },
  freeze: { params: ["{}"], ret: "{}" },
  seal: { params: ["{}"], ret: "{}" },
  create: { params: ["{}"], ret: "{}" },
  fromEntries: { params: ["{}"], ret: "{}" },
  hasOwn: { params: ["{}", "str"], ret: "bool" },
  is: { params: ["{}", "{}"], ret: "bool" },
  getOwnPropertyNames: { params: ["{}"], ret: { kind: "array", elem: "str" } },
  getPrototypeOf: { params: ["{}"], ret: "{}" },
  defineProperty: { params: ["{}", "str", "{}"], ret: "{}" },
};

// Methods inherited from Object.prototype — present on every value, so accessing
// them must never add a structural field to the receiver's type.
summaries.__objectProtoMethods__ = {
  hasOwnProperty: { params: ["str"], ret: "bool" },
  isPrototypeOf: { params: ["{}"], ret: "bool" },
  propertyIsEnumerable: { params: ["str"], ret: "bool" },
  toString: { params: [], ret: "str" },
  valueOf: { params: [], ret: "{}" },
};

// Names of all globals that should be pre-declared in the initial environment.
summaries.__globals__ = [
  "JSON",
  "Math",
  "Number",
  "console",
  "process",
  "Object",
  "Array",
];

// Globals that are callable functions themselves (not objects with methods).
// String(x) → str, Number(x) → num, Boolean(x) → bool.
summaries.__globalCallables__ = {
  String: { params: ["{}"], ret: "str" },
  Number: { params: ["{}"], ret: "num" },
  Boolean: { params: ["{}"], ret: "bool" },
  eval: { params: ["str"], ret: "bot" },
};

// Built-in constructors: new Error(...) → error, etc.
summaries.__globalConstructors__ = {
  RegExp: { params: ["str", { type: "str", optional: true }], ret: "regexp" },
  Error: { params: [{ type: "str", optional: true }], ret: "error" },
  TypeError: { params: [{ type: "str", optional: true }], ret: "error" },
  RangeError: { params: [{ type: "str", optional: true }], ret: "error" },
  SyntaxError: { params: [{ type: "str", optional: true }], ret: "error" },
  ReferenceError: { params: [{ type: "str", optional: true }], ret: "error" },
  EvalError: { params: [{ type: "str", optional: true }], ret: "error" },
  URIError: { params: [{ type: "str", optional: true }], ret: "error" },
};

// ── Built-in type methods ─────────────────────────────────────────────────────
// Dispatch table for methods on str / num / bool values.
// Array methods are handled inline in infer.js (_accessArrayMethod).

summaries.__typeMethods__ = {
  str: {
    split: { params: ["str|regexp"], ret: { kind: "array", elem: "str" } },
    trim: { params: [], ret: "str" },
    trimEnd: { params: [], ret: "str" },
    trimStart: { params: [], ret: "str" },
    toLowerCase: { params: [], ret: "str" },
    toUpperCase: { params: [], ret: "str" },
    toLocaleLowerCase: { params: [], ret: "str" },
    toLocaleUpperCase: { params: [], ret: "str" },
    slice: { params: ["num", "num"], ret: "str" },
    substring: { params: ["num", "num"], ret: "str" },
    replace: { params: ["str|regexp", "str"], ret: "str" },
    replaceAll: { params: ["str|regexp", "str"], ret: "str" },
    concat: { params: ["str"], ret: "str" },
    includes: { params: ["str"], ret: "bool" },
    startsWith: { params: ["str"], ret: "bool" },
    endsWith: { params: ["str"], ret: "bool" },
    indexOf: { params: ["str"], ret: "num" },
    lastIndexOf: { params: ["str"], ret: "num" },
    charAt: { params: ["num"], ret: "str" },
    charCodeAt: { params: ["num"], ret: "num" },
    padStart: { params: ["num", "str"], ret: "str" },
    padEnd: { params: ["num", "str"], ret: "str" },
    repeat: { params: ["num"], ret: "str" },
    toString: { params: [], ret: "str" },
    match: { params: ["{}"], ret: { kind: "array", elem: "str" } },
    search: { params: ["{}"], ret: "num" },
    at: { params: ["num"], ret: "str" },
  },
  num: {
    toString: { params: [], ret: "str" },
    toFixed: { params: ["num"], ret: "str" },
    toPrecision: { params: ["num"], ret: "str" },
    toLocaleString: { params: [], ret: "str" },
  },
  bool: {
    toString: { params: [], ret: "str" },
  },
  regexp: {
    exec: { params: ["str"], ret: { kind: "array", elem: "str" } },
    test: { params: ["str"], ret: "bool" },
    toString: { params: [], ret: "str" },
  },
  error: {
    toString: { params: [], ret: "str" },
  },
};

// Non-callable properties on built-in types.
summaries.__typeProps__ = {
  str: { length: "num" },
  arr: { length: "num" },
  num: {},
  bool: {},
  error: {
    message: "str",
    stack: "str",
    name: "str",
  },
  regexp: {
    source: "str",
    flags: "str",
    lastIndex: "num",
    global: "bool",
    ignoreCase: "bool",
    multiline: "bool",
    sticky: "bool",
  },
};

module.exports = summaries;
