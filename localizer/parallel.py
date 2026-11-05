"""Solving the independent parts of a program separately, in parallel.

Slicing (slicing.py) splits the formula into connected components that share
no type variable.  An MCS of the whole formula is a union of one MCS per
component that is unsatisfiable on its own, and its cost is the sum, so the
smallest MCS is the union of the smallest MCSs of the parts.  Each part is a
much smaller formula, and the parts can be solved by separate processes.

    smallest_mcs(program, jobs=4) -> (lines, cost, number of conflicting parts)

The parts are sent to the worker processes as constraint lists (Python data)
and encoded there, because Z3 objects cannot be shared between processes.
A part's result is cached by the text of its constraints, with the type
variables T1, T2, ... renumbered in order of appearance and the lines counted
from the part's first line, so a program that is localized again after an
edit only solves the parts that changed, even if the edit moved the others
(the language server benefits from this).
"""

from __future__ import annotations

import hashlib
import re
from concurrent.futures import ProcessPoolExecutor
from dataclasses import replace
from types import SimpleNamespace
from typing import Optional

import z3

from . import mcs
from .constraints import Program
from .encode import encode, group_key
from .simplify import simplify
from .slicing import components

_cache: dict[str, tuple[list[int], int]] = {}


def parts(program: Program, group_by: str = "line") -> list[Program]:
    """The program restricted to each connected component (with at least one
    line), after eliminating line-local variables; no formula is built."""
    simplified, _ = simplify(program, lambda c: group_key(c, group_by))
    view = SimpleNamespace(program=replace(program, constraints=simplified), group_by=group_by)
    out = []
    for groups, hard in components(view):
        if groups:
            cs = [c for c in view.program.constraints if (c.hard and c.id in hard)
                  or (not c.hard and group_key(c, group_by) in groups)]
            out.append(replace(view.program, constraints=cs))
    return out


def _base(part: Program) -> int:
    return min((c.line for c in part.constraints if not c.hard and c.line), default=0)


def _key(part: Program) -> str:
    """The part up to renaming its fresh type variables and moving its lines."""
    names: dict[str, str] = {}

    def canon(text: str) -> str:
        return re.sub(r"\bT\d+\b", lambda m: names.setdefault(m.group(0), f"t{len(names)}"), text)

    base = _base(part)
    rows = [f"{c.kind}|{canon(c.text)}|{c.line - base if c.line else ''}|{c.hard}" for c in part.constraints]
    return hashlib.sha256("\n".join(rows).encode()).hexdigest()


def _solve(task) -> tuple[list[int], int]:
    """(lines of a smallest MCS counted from the part's first line, cost)."""
    part, algorithm, timeout = task
    enc = encode(part, simplify=False)  # parts are already simplified
    if enc.check() == z3.sat:
        return [], 0
    first = next(iter(mcs.make(algorithm, enc, timeout=timeout).enumerate(limit=1)))
    base = _base(part)
    return sorted(enc.line_of(g) - base for g in first.lines), first.cost


def smallest_mcs(program: Program, algorithm: str = "oll", jobs: int = 1,
                 timeout: Optional[float] = None) -> tuple[list[int], int, int]:
    """The lines of a smallest MCS, its cost, and the number of conflicting parts."""
    ps = parts(program)
    keys = [_key(p) for p in ps]
    todo = [(p, algorithm, timeout) for p, k in zip(ps, keys) if k not in _cache]
    if jobs > 1 and len(todo) > 1:
        with ProcessPoolExecutor(min(jobs, len(todo))) as pool:
            results = list(pool.map(_solve, todo))
    else:
        results = [_solve(t) for t in todo]
    for t, r in zip(todo, results):
        _cache[_key(t[0])] = r
    lines, cost, conflicting = set(), 0, 0
    for p, k in zip(ps, keys):
        ls, c = _cache[k]
        lines |= {_base(p) + x for x in ls}
        cost += c
        conflicting += bool(ls)
    return sorted(lines), cost, conflicting
