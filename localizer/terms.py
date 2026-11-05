"""Parser for the type terms printed by infer.js.

infer.js prints constraints as strings, e.g.

    T4 <= Promise<T2,T3>
    flag__global <= {active: T1}
    f__global <= Func<f__global>{x__f__global -> ret__f__global}
    plus(a__global,b__global,T3)

This module turns the right-hand sides into small immutable term trees.  The
grammar mirrors the string formats produced in infer.js / summaries.js:

    term    ::= base ('|' base)*                 str | num | bool | void | regexp | error
              | '{' '}'                          some object
              | '{' name ':' term (',' ...)* '}'  object with (at least) these fields
              | 'Array<' term '>'
              | 'Promise<' term ',' term '>'
              | 'Resolver<' term '>' | 'Rejector<' term '>'
              | 'Func<' name '>{' sig '}'         sig ::= '()' '->' term | term ('->' term)*
              | 'Class<' name '>[' members ']'   members ::= name ':' term ('->' term)*, ...
              | 'Obj<' name '>[' members ']'
              | type-variable
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple, Union

BASE_TYPES = ("num", "str", "bool", "void", "regexp", "error")


@dataclass(frozen=True)
class Var:
    name: str


@dataclass(frozen=True)
class Base:
    """One of the base types; several alternatives for a union like str|regexp."""

    options: Tuple[str, ...]


@dataclass(frozen=True)
class Obj:
    """An object with at least these fields (empty tuple: just "some object")."""

    fields: Tuple[Tuple[str, "Term"], ...]


@dataclass(frozen=True)
class Arr:
    elem: "Term"


@dataclass(frozen=True)
class Prom:
    resolve: "Term"
    reject: "Term"


@dataclass(frozen=True)
class Resolver:
    inner: "Term"


@dataclass(frozen=True)
class Rejector:
    inner: "Term"


@dataclass(frozen=True)
class Func:
    name: str
    params: Tuple["Term", ...]
    ret: "Term"


@dataclass(frozen=True)
class Klass:
    """Class<Name>[...] (kind == "Class") or an instance Obj<Name>[...] (kind == "Obj").

    Each member is (name, signature); a signature of length 1 is an attribute,
    a longer one a method p1 -> ... -> ret (zero-parameter methods are printed
    as `void -> ret`).
    """

    kind: str
    name: str
    members: Tuple[Tuple[str, Tuple["Term", ...]], ...]


Term = Union[Var, Base, Obj, Arr, Prom, Resolver, Rejector, Func, Klass]


class ParseError(ValueError):
    pass


def is_literal(t: Term) -> bool:
    return not isinstance(t, Var)


def _split_top(s: str, sep: str) -> list[str]:
    """Split s on sep at bracket depth 0 (brackets: <> {} [] ())."""
    parts, depth, start, i = [], 0, 0, 0
    while i < len(s):
        if s.startswith("->", i):  # the arrow is not a closing bracket
            if depth == 0 and sep == "->":
                parts.append(s[start:i])
                i += 2
                start = i
                continue
            i += 2
            continue
        ch = s[i]
        if ch in "<{[(":
            depth += 1
        elif ch in ">}])":
            depth -= 1
        elif depth == 0 and s.startswith(sep, i):
            parts.append(s[start:i])
            i += len(sep)
            start = i
            continue
        i += 1
    parts.append(s[start:])
    return parts


def _matching(s: str, open_idx: int) -> int:
    """Index of the bracket closing the one at open_idx."""
    pairs = {"<": ">", "{": "}", "[": "]", "(": ")"}
    depth = 0
    i = open_idx
    while i < len(s):
        if s.startswith("->", i):
            i += 2
            continue
        if s[i] in pairs:
            depth += 1
        elif s[i] in ")>}]":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ParseError(f"unbalanced brackets in {s!r}")


def parse_term(s: str) -> Term:
    s = s.strip()
    if not s:
        raise ParseError("empty term")

    def wrapped(prefix: str) -> str | None:
        if s.startswith(prefix):
            close = _matching(s, len(prefix) - 1)
            if close != len(s) - 1:
                raise ParseError(f"trailing text in {s!r}")
            return s[len(prefix) : close]
        return None

    inner = wrapped("Array<")
    if inner is not None:
        return Arr(parse_term(inner))
    inner = wrapped("Promise<")
    if inner is not None:
        parts = _split_top(inner, ",")
        if len(parts) == 1:  # solver.js default for a missing reject type
            return Prom(parse_term(parts[0]), Var("bot"))
        if len(parts) != 2:
            raise ParseError(f"bad Promise {s!r}")
        return Prom(parse_term(parts[0]), parse_term(parts[1]))
    inner = wrapped("Resolver<")
    if inner is not None:
        return Resolver(parse_term(inner))
    inner = wrapped("Rejector<")
    if inner is not None:
        return Rejector(parse_term(inner))

    if s.startswith("Func<"):
        name_end = s.find(">{")
        if name_end < 0 or not s.endswith("}"):
            raise ParseError(f"bad Func {s!r}")
        name = s[5:name_end]
        body = s[name_end + 2 : -1].strip()
        if body.startswith("()"):
            arrow = body.find("->")
            return Func(name, (), parse_term(body[arrow + 2 :]))
        parts = [p.strip() for p in _split_top(body, "->")]
        if len(parts) < 1 or not parts[-1]:
            raise ParseError(f"bad Func signature {s!r}")
        return Func(name, tuple(parse_term(p) for p in parts[:-1]), parse_term(parts[-1]))

    for kind in ("Class", "Obj"):
        if s.startswith(kind + "<") and s.endswith("]"):
            head_end = s.find(">", len(kind) + 1)
            name = s[len(kind) + 1 : head_end]
            bracket = s.find("[", head_end)
            body = s[bracket + 1 : -1].strip()
            members = []
            if body:
                for part in _split_top(body, ","):
                    part = part.strip()
                    if not part:
                        continue
                    colon = part.find(":")
                    mname = part[:colon].strip()
                    sig = tuple(parse_term(p) for p in _split_top(part[colon + 1 :], "->"))
                    members.append((mname, sig))
            return Klass(kind, name, tuple(members))

    if s.startswith("{"):
        if not s.endswith("}"):
            raise ParseError(f"bad object {s!r}")
        body = s[1:-1].strip()
        if not body:
            return Obj(())
        fields = []
        for part in _split_top(body, ","):
            part = part.strip()
            if not part:
                continue
            colon = part.find(":")
            if colon < 0:
                raise ParseError(f"bad field {part!r} in {s!r}")
            fields.append((part[:colon].strip(), parse_term(part[colon + 1 :])))
        return Obj(tuple(fields))

    alts = s.split("|")
    if len(alts) > 1 or s in BASE_TYPES:
        alts = [a.strip() for a in alts]
        if all(a in BASE_TYPES for a in alts):
            return Base(tuple(sorted(set(alts))))
        raise ParseError(f"bad union {s!r}")

    if any(ch in s for ch in "<>{}[](),") or " " in s:
        raise ParseError(f"cannot parse {s!r}")
    return Var(s)


def show(t: Term) -> str:
    if isinstance(t, Var):
        return t.name
    if isinstance(t, Base):
        return "|".join(t.options)
    if isinstance(t, Obj):
        return "{" + ", ".join(f"{f}: {show(v)}" for f, v in t.fields) + "}"
    if isinstance(t, Arr):
        return f"Array<{show(t.elem)}>"
    if isinstance(t, Prom):
        return f"Promise<{show(t.resolve)},{show(t.reject)}>"
    if isinstance(t, Resolver):
        return f"Resolver<{show(t.inner)}>"
    if isinstance(t, Rejector):
        return f"Rejector<{show(t.inner)}>"
    if isinstance(t, Func):
        sig = " -> ".join(show(p) for p in (*t.params, t.ret))
        return f"Func<{t.name}>{{{sig if t.params else '() -> ' + show(t.ret)}}}"
    if isinstance(t, Klass):
        mem = ", ".join(f"{n}: {' -> '.join(show(x) for x in sig)}" for n, sig in t.members)
        return f"{t.kind}<{t.name}>[{mem}]"
    raise TypeError(t)


def term_vars(t: Term) -> set[str]:
    """Names of the type variables occurring in a term."""
    if isinstance(t, Var):
        return {t.name}
    if isinstance(t, Base):
        return set()
    if isinstance(t, Obj):
        return set().union(*(term_vars(v) for _, v in t.fields)) if t.fields else set()
    if isinstance(t, Arr):
        return term_vars(t.elem)
    if isinstance(t, Prom):
        return term_vars(t.resolve) | term_vars(t.reject)
    if isinstance(t, (Resolver, Rejector)):
        return term_vars(t.inner)
    if isinstance(t, Func):
        return set().union(*(term_vars(p) for p in (*t.params, t.ret)))
    if isinstance(t, Klass):
        return set().union(set(), *(term_vars(x) for _, sig in t.members for x in sig))
    raise TypeError(t)
