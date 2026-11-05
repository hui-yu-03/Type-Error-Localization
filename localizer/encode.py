"""SMT encoding of the typing constraints (Z3).

Types are values of an algebraic datatype

    Type = Num | Str | Bool | Void | Regexp | Error            (base types)
         | Obj(Id) | Arr(Id) | Fun(Id) | Prom(Id) | Res(Id) | Rej(Id)
         | Cls(Int, Id) | Inst(Int, Id)                        (class / instance of class #n)

where Id is an uninterpreted sort.  A structured type carries only an identity;
its components are uninterpreted functions of the type:

    field_f : Type -> Type      (one function per field name f)
    elem    : Type -> Type      (array element)
    param_i : Type -> Type, ret : Type -> Type   (function signature)
    pres, prej : Type -> Type   (promise resolve / reject types)
    rinner, jinner : Type -> Type, arity_m : Type -> Int, member_m_j : Type -> Type

Equal types have equal components (congruence), which is exactly what
unification does when it merges two equivalence classes.  Types that are never
unified can get different identities, hence independent components.  Because
components are functions of an identity rather than constructor arguments,
cyclic types (an object whose field points back to itself) are allowed, as in
the union-find solver, which has no occurs check.

Every constraint becomes a formula over these terms (see `Encoder.constraint`).
The constraints of source line L are guarded by a selector literal sel_L, so
that a line can be "dropped" by assuming sel_L false; library constraints are
hard.  See README.md ("SMT encoding") for the correctness argument.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Optional

import z3

from .constraints import Constraint, Program
from .terms import BASE_TYPES, Arr, Base, Func, Klass, Obj, Prom, Rejector, Resolver, Term, Var


class Theory:
    """Sorts and function symbols shared by all encodings (one per Z3 context)."""

    _instance: Optional["Theory"] = None

    def __init__(self) -> None:
        self.Id = z3.DeclareSort("Id")
        T = z3.Datatype("Type")
        for b in BASE_TYPES:
            T.declare(b.capitalize())
        for k in ("Obj", "Arr", "Fun", "Prom", "Res", "Rej"):
            T.declare(k, (k.lower() + "_id", self.Id))
        T.declare("Cls", ("cls_name", z3.IntSort()), ("cls_id", self.Id))
        T.declare("Inst", ("inst_name", z3.IntSort()), ("inst_id", self.Id))
        self.T = T.create()
        self.base = {b: getattr(self.T, b.capitalize()) for b in BASE_TYPES}
        self._funcs: dict[tuple, z3.FuncDeclRef] = {}

    @classmethod
    def get(cls) -> "Theory":
        if cls._instance is None:
            cls._instance = Theory()
        return cls._instance

    def fn(self, name: str, rng=None) -> z3.FuncDeclRef:
        key = (name, rng is None)
        if key not in self._funcs:
            self._funcs[key] = z3.Function(name, self.T, rng if rng is not None else self.T)
        return self._funcs[key]

    def field(self, f: str):
        return self.fn(f"field[{f}]")

    def param(self, i: int):
        return self.fn(f"param{i}")

    def member(self, m: str, j: int):
        return self.fn(f"member[{m}]{j}")

    def arity(self, m: str):
        return self.fn(f"arity[{m}]", z3.IntSort())

    def is_kind(self, kind: str, x):
        return getattr(self.T, "is_" + kind)(x)


GROUPINGS = ("line", "statement", "node")


def group_key(c: Constraint, group_by: str):
    """The group (unit of blame) of a soft constraint."""
    if group_by == "line":
        return c.line
    if group_by == "statement" and c.stmt_line is not None:
        return (c.stmt_line, c.stmt_col)
    if group_by == "node":
        return (c.line, c.col, c.end_line, c.end_col)
    return (c.line, -1)


def group_span(c: Constraint, group_by: str) -> tuple[int, int]:
    """(first line, last line) covered by the group of c."""
    if group_by == "line":
        return (c.line, c.line)
    if group_by == "statement" and c.stmt_line is not None:
        return (c.stmt_line, c.stmt_end_line or c.stmt_line)
    if group_by == "node":
        return (c.line, c.end_line or c.line)
    return (c.line, c.line)


@dataclass
class Encoding:
    """The encoded program: hard formulas plus one guarded group per unit of
    blame (by default a source line; see GROUPINGS).

    Groups are identified by keys: the line number when grouping by line,
    (line, column, ...) tuples otherwise.  `order` gives the position of each
    group in source order and `span` the lines it covers.
    """

    program: Program
    hard: list[z3.BoolRef]
    groups: "OrderedDict"  # key -> conjunction of the group's constraints
    selectors: "OrderedDict"  # key -> selector literal
    per_constraint: list[tuple[Constraint, z3.BoolRef]]  # every constraint, in order
    encoder: "Encoder"
    group_sizes: dict = field(default_factory=dict)  # key -> number of constraints
    group_by: str = "line"
    order: dict = field(default_factory=dict)  # key -> position in source order
    span: dict = field(default_factory=dict)  # key -> (first line, last line)

    def line_of(self, key) -> int:
        return self.span[key][0]

    def covers(self, key, line: int) -> bool:
        a, b = self.span[key]
        return a <= line <= b

    def solver(self, timeout_ms: Optional[int] = None, **params) -> z3.Solver:
        s = z3.Solver()
        if timeout_ms:
            s.set("timeout", int(timeout_ms))
        for k, v in params.items():
            s.set(k, v)
        s.add(*self.hard)
        for line, f in self.groups.items():
            s.add(z3.Implies(self.selectors[line], f))
        return s

    def check(self, timeout_ms: Optional[int] = None) -> z3.CheckSatResult:
        """Is the whole program well typed (all lines kept)?"""
        s = self.solver(timeout_ms)
        return s.check(*self.selectors.values())

    @property
    def lines(self) -> list[int]:
        return list(self.groups.keys())


class Encoder:
    """Translates constraints into Z3 formulas.

    Options
      plus:          "strict" (default): a + b is num + num -> num, or has a string
                     operand -> str (as in TypeScript).  "lenient": additionally
                     accepts operands that are neither num nor str (as solver.js).
      closed_fields: if True, reading field f of an object created by an object
                     literal requires that some object literal or write defines
                     f on that object (catches misspelled property names).
    """

    def __init__(self, plus: str = "strict", closed_fields: bool = False) -> None:
        self.th = Theory.get()
        self.plus_mode = plus
        self.closed_fields = closed_fields
        self._vars: dict[str, z3.ExprRef] = {}
        self._aux = 0
        self._class_ids: dict[str, int] = {}
        # (term, field) pairs and (term, i) pairs, used to print models
        self.field_uses: list[tuple[z3.ExprRef, str]] = []
        self.param_uses: list[tuple[z3.ExprRef, int]] = []

    # -- terms ---------------------------------------------------------------
    def var(self, name: str) -> z3.ExprRef:
        v = self._vars.get(name)
        if v is None:
            v = z3.Const(name, self.th.T)
            self._vars[name] = v
        return v

    def fresh(self) -> z3.ExprRef:
        self._aux += 1
        return z3.Const(f"aux!{self._aux}", self.th.T)

    def class_id(self, name: str) -> int:
        return self._class_ids.setdefault(name, len(self._class_ids))

    def term(self, t: Term, out: list) -> z3.ExprRef:
        """A Z3 term for t; nested type literals get a fresh variable."""
        if isinstance(t, Var):
            return self.var(t.name)
        if isinstance(t, Base) and len(t.options) == 1:
            return self.th.base[t.options[0]]
        x = self.fresh()
        self.pattern(x, t, out)
        return x

    def pattern(self, x: z3.ExprRef, t: Term, out: list) -> None:
        """Append formulas stating that type x matches the literal t."""
        th = self.th
        if isinstance(t, Var):
            out.append(x == self.var(t.name))
        elif isinstance(t, Base):
            out.append(z3.Or([x == th.base[o] for o in t.options]))
        elif isinstance(t, Obj):
            if not t.fields:
                out.append(th.is_kind("Obj", x))
                return
            # objects are open records; a class instance may gain attributes
            inst = z3.And([th.arity(f)(x) == 1 for f, _ in t.fields])
            out.append(z3.Or(th.is_kind("Obj", x), z3.And(th.is_kind("Inst", x), inst)))
            for f, v in t.fields:
                out.append(th.field(f)(x) == self.term(v, out))
                self.field_uses.append((x, f))
        elif isinstance(t, Arr):
            out.append(th.is_kind("Arr", x))
            out.append(th.fn("elem")(x) == self.term(t.elem, out))
        elif isinstance(t, Prom):
            out.append(th.is_kind("Prom", x))
            out.append(th.fn("pres")(x) == self.term(t.resolve, out))
            out.append(th.fn("prej")(x) == self.term(t.reject, out))
        elif isinstance(t, Resolver):
            out.append(th.is_kind("Res", x))
            out.append(th.fn("rinner")(x) == self.term(t.inner, out))
        elif isinstance(t, Rejector):
            out.append(th.is_kind("Rej", x))
            out.append(th.fn("jinner")(x) == self.term(t.inner, out))
        elif isinstance(t, Func):
            out.append(th.is_kind("Fun", x))
            for i, p in enumerate(t.params):
                out.append(th.param(i)(x) == self.term(p, out))
                self.param_uses.append((x, i))
            out.append(th.fn("ret")(x) == self.term(t.ret, out))
        elif isinstance(t, Klass):
            kind = "Cls" if t.kind == "Class" else "Inst"
            name_of = th.T.cls_name if kind == "Cls" else th.T.inst_name
            out.append(th.is_kind(kind, x))
            out.append(name_of(x) == self.class_id(t.name))
            for m, sig in t.members:
                out.append(th.arity(m)(x) == len(sig))
                out.append(th.field(m)(x) == self.term(sig[0], out))
                self.field_uses.append((x, m))
                for j, s in enumerate(sig[1:], start=1):
                    out.append(th.member(m, j)(x) == self.term(s, out))
        else:
            raise TypeError(t)

    # -- constraints ---------------------------------------------------------
    def constraint(self, c: Constraint) -> z3.BoolRef:
        th = self.th
        out: list = []
        if c.kind == "sub":
            lhs, rhs = c.args
            if c.access == "index" and isinstance(lhs, Var) and isinstance(rhs, Arr):
                # x[0] with a numeric literal: x is an array, or a string
                # (whose characters are strings)
                x = self.var(lhs.name)
                elem = self.term(rhs.elem, out)
                out.append(
                    z3.Or(
                        z3.And(th.is_kind("Arr", x), th.fn("elem")(x) == elem),
                        z3.And(x == th.base["str"], elem == th.base["str"]),
                    )
                )
            elif isinstance(lhs, Var):
                self.pattern(self.var(lhs.name), rhs, out)
            elif isinstance(rhs, Var):  # e.g. void <= ret__f
                self.pattern(self.var(rhs.name), lhs, out)
            elif isinstance(lhs, Base) and isinstance(rhs, Base):
                out.append(z3.BoolVal(bool(set(lhs.options) & set(rhs.options))))
            else:
                self.pattern(self.term(lhs, out), rhs, out)
        elif c.kind == "plus":
            a, b, r = (self.var(v.name) for v in c.args)
            num, string = th.base["num"], th.base["str"]
            alts = [
                z3.And(a == num, b == num, r == num),
                z3.And(z3.Or(a == string, b == string), r == string),
            ]
            if self.plus_mode == "lenient":
                # solver.js only rejects num + <object/array/function/promise>
                structural = lambda v: z3.Not(z3.Or([v == bt for bt in th.base.values()]))  # noqa: E731
                alts.append(
                    z3.And(
                        a != string,
                        b != string,
                        z3.Not(z3.And(a == num, b == num)),
                        z3.Not(z3.And(a == num, structural(b))),
                        z3.Not(z3.And(b == num, structural(a))),
                        z3.Or(r == num, r == string),
                    )
                )
            out.append(z3.Or(alts))
        elif c.kind in ("union", "logical_union"):
            a, b, r = (self.var(v.name) for v in c.args)
            out.append(z3.Or(r == a, r == b))
        elif c.kind == "index":
            o, i, r = (self.var(v.name) for v in c.args)
            num, string = th.base["num"], th.base["str"]
            out.append(
                z3.Or(
                    z3.And(th.is_kind("Arr", o), i == num, r == th.fn("elem")(o)),
                    z3.And(th.is_kind("Obj", o), i == string),
                    z3.And(o == string, i == num, r == string),
                )
            )
        elif c.kind == "tpl":
            pass  # any value can be interpolated in a template literal
        else:
            raise ValueError(c.kind)
        return z3.And(out) if len(out) != 1 else out[0]

    # -- closed-world fields (optional extension) -----------------------------
    def closed_field_formulas(self, program: Program, guard) -> list[tuple[int, z3.BoolRef]]:
        """Reads of a field on an object built by a literal must be justified.

        closed(x) holds for objects created by an object literal.  A read
        `x.f` with closed(x) requires some definition of f (literal field,
        write, computed write obj[k] = v, or library) on an object equal to x
        whose line is kept (guard(line) is the selector of that line).
        Returns (constraint id, formula) pairs: each formula belongs to the
        object literal or the read that it comes from.
        """
        th = self.th
        closed = th.fn("closed", z3.BoolSort())
        defs: dict[str, list[tuple[Optional[int], z3.ExprRef]]] = {}
        any_field: list[tuple[Optional[int], z3.ExprRef]] = []  # obj[key] = v defines any field
        literal_objs: list[tuple[int, z3.ExprRef]] = []
        for c in program.constraints:
            if c.kind == "index" and c.access == "computed-write":
                any_field.append((c.line, self.var(c.args[0].name)))
                continue
            if c.kind != "sub" or not isinstance(c.args[1], Obj) or not isinstance(c.args[0], Var):
                continue
            x = self.var(c.args[0].name)
            if c.access in ("write", "literal") or c.source == "library":
                for f, _ in c.args[1].fields:
                    defs.setdefault(f, []).append((c.line, x))
            if c.access == "literal":
                literal_objs.append((c.id, x))
        out = []
        for cid, x in literal_objs:
            out.append((cid, closed(x)))
        for c in program.constraints:
            if c.kind != "sub" or c.access != "read" or not isinstance(c.args[0], Var):
                continue
            x = self.var(c.args[0].name)
            for f, _ in c.args[1].fields:
                just = [z3.And(guard(dl), x == y) for dl, y in defs.get(f, []) + any_field]
                out.append((c.id, z3.Implies(closed(x), z3.Or(just) if just else z3.BoolVal(False))))
        return out


def encode(program: Program, plus: str = "strict", closed_fields: bool = False, group_by: str = "line") -> Encoding:
    if group_by not in GROUPINGS:
        raise ValueError(group_by)
    enc = Encoder(plus=plus, closed_fields=closed_fields)
    key_of = {c.id: group_key(c, group_by) for c in program.constraints if not c.hard}
    span: dict = {}
    for c in program.constraints:
        if not c.hard:
            a, b = group_span(c, group_by)
            k = key_of[c.id]
            lo, hi = span.get(k, (a, b))
            span[k] = (min(lo, a), max(hi, b))
    keys = sorted(span, key=lambda k: (k, 0) if isinstance(k, int) else (k[0], k))
    order = {k: i for i, k in enumerate(keys)}
    selectors = OrderedDict((k, z3.Bool(f"group!{order[k]}")) for k in keys)
    line_selector = {}  # closed fields: a definition's line -> its group selector
    for c in program.constraints:
        if not c.hard:
            line_selector.setdefault(c.line, selectors[key_of[c.id]])
    extra: dict[int, list[z3.BoolRef]] = {}
    if closed_fields:
        guard = lambda line: z3.BoolVal(True) if line is None else line_selector[line]  # noqa: E731
        for cid, f in enc.closed_field_formulas(program, guard):
            extra.setdefault(cid, []).append(f)
    hard: list[z3.BoolRef] = []
    parts: dict = {k: [] for k in keys}
    per_constraint = []
    sizes: dict = {}
    for c in program.constraints:
        f = enc.constraint(c)
        if c.id in extra:
            f = z3.And(f, *extra[c.id])
        per_constraint.append((c, f))
        if c.hard:
            hard.append(f)
        else:
            k = key_of[c.id]
            parts[k].append(f)
            sizes[k] = sizes.get(k, 0) + 1
    groups = OrderedDict((k, z3.And(parts[k])) for k in keys)
    return Encoding(program, hard, groups, selectors, per_constraint, enc, sizes, group_by, order, span)


# -- models -------------------------------------------------------------------
def describe_types(
    enc: Encoding,
    model: z3.ModelRef,
    names: Optional[list[str]] = None,
    solver: Optional[z3.Solver] = None,
    assumptions: Optional[list] = None,
    max_checks: int = 300,
) -> dict[str, str]:
    """Human-readable types of the program variables in a model.

    A model fixes every type, including parts that no constraint determines.
    If a solver is given, each printed part is checked to be entailed (the
    constraints force that kind); parts that are not forced print as "?"
    (solver.js prints "bot" for them).
    """
    e = enc.encoder
    th = e.th
    budget = [max_checks]
    if solver is not None and assumptions is None:
        assumptions = list(enc.selectors.values())

    def forced(term, value) -> bool:
        if solver is None or budget[0] <= 0:
            return True
        budget[0] -= 1
        name = value.decl().name()
        test = term == value if name.lower() in BASE_TYPES else th.is_kind(name, term)
        return solver.check(*assumptions, z3.Not(test)) == z3.unsat
    fields_of: dict[str, set[str]] = {}
    arity_of: dict[str, int] = {}
    for x, f in e.field_uses:
        fields_of.setdefault(str(model.eval(x, model_completion=True)), set()).add(f)
    for x, i in e.param_uses:
        k = str(model.eval(x, model_completion=True))
        arity_of[k] = max(arity_of.get(k, 0), i + 1)

    def show(term, depth: int, seen: frozenset) -> str:
        v = model.eval(term, model_completion=True)
        key = str(v)
        name = v.decl().name()
        if not forced(term, v):
            return "?"
        if name.lower() in BASE_TYPES:
            return name.lower()
        if key in seen or depth > 4:
            return "..."
        seen = seen | {key}
        sub = lambda f: show(f(term), depth + 1, seen)  # noqa: E731
        if name == "Obj":
            fs = sorted(fields_of.get(key, ()))
            return "{" + ", ".join(f"{f}: {sub(th.field(f))}" for f in fs) + "}"
        if name == "Arr":
            return f"Array<{sub(th.fn('elem'))}>"
        if name == "Prom":
            return f"Promise<{sub(th.fn('pres'))}, {sub(th.fn('prej'))}>"
        if name == "Fun":
            ps = [sub(th.param(i)) for i in range(arity_of.get(key, 0))]
            return f"({', '.join(ps)}) -> {sub(th.fn('ret'))}"
        if name == "Res":
            return f"Resolver<{sub(th.fn('rinner'))}>"
        if name == "Rej":
            return f"Rejector<{sub(th.fn('jinner'))}>"
        if name in ("Cls", "Inst"):
            cid = model.eval(v.arg(0)).as_long()
            cname = next((n for n, i in e._class_ids.items() if i == cid), str(cid))
            return f"{'Class' if name == 'Cls' else 'Obj'}<{cname}>"
        return key

    if names is None:
        names = sorted(n for n in e._vars if "__" in n and not n.startswith("async_inner__"))
    return {n: show(e.var(n), 0, frozenset()) for n in names}
