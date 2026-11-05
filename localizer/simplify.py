"""Eliminating type variables that are local to one group (item: performance).

infer.js introduces a fresh type variable for almost every subexpression, and
most of them (about 70% in large programs) occur in the constraints of a
single group only.  If x occurs only in group G and G contains the equation
x = y, then renaming x to y inside G gives an equivalent group:
  sel_G -> (x = y and phi(x))   is equisatisfiable with   sel_G -> phi(y)
because x is unconstrained outside G (when sel_G is false x is free anyway).
The hard constraints form one more group.  Equations that become y = y are
dropped.  The MCSs are unchanged; the formula has fewer variables and
equations.  Variables of the program (name__scope) are preferred as
representatives, so that models still mention them.
"""

from __future__ import annotations

from dataclasses import replace

from .constraints import Constraint, Program
from .terms import Var, rename


def _vars(c: Constraint) -> set[str]:
    from .reinfer import constraint_vars

    return constraint_vars(c)


def local_renaming(program: Program, group_of) -> dict[str, str]:
    """A renaming of group-local variables to representatives (union-find)."""
    occurs: dict[str, set] = {}
    for c in program.constraints:
        g = "hard" if c.hard else group_of(c)
        for v in _vars(c):
            occurs.setdefault(v, set()).add(g)
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        while parent.get(x, x) != x:
            parent[x] = parent.get(parent[x], parent[x])
            x = parent[x]
        return x

    def better(a: str, b: str) -> bool:  # is a the better representative?
        la, lb = len(occurs[a]) > 1, len(occurs[b]) > 1  # occurs elsewhere: must stay
        if la != lb:
            return la
        pa, pb = "__" in a, "__" in b  # program variables read better in models
        return pa and not pb

    # A class is "pinned" if it contains a variable occurring in several groups.
    # Two pinned classes are never merged: their equation only holds while its
    # group is kept, so it stays a (guarded) constraint.  An unpinned class only
    # contains variables local to one group, so renaming them is sound.
    pinned = {v: len(gs) > 1 for v, gs in occurs.items()}
    for c in program.constraints:
        if c.kind != "sub" or not (isinstance(c.args[0], Var) and isinstance(c.args[1], Var)):
            continue
        x, y = c.args[0].name, c.args[1].name
        g = "hard" if c.hard else group_of(c)
        # only merge through a variable that occurs in this group alone
        if not (occurs[x] == {g} or occurs[y] == {g}):
            continue
        rx, ry = find(x), find(y)
        if rx == ry or (pinned[rx] and pinned[ry]):
            continue
        # the merged class keeps the variable that may occur elsewhere, if any
        root, child = (rx, ry) if better(rx, ry) else (ry, rx)
        parent[child] = root
        pinned[root] = pinned[rx] or pinned[ry]
    return {v: find(v) for v in occurs if find(v) != v}


def simplify(program: Program, group_of) -> tuple[list[Constraint], int]:
    """The constraints with group-local variables eliminated (trivial ones dropped)."""
    m = local_renaming(program, group_of)
    out = []
    dropped = 0
    for c in program.constraints:
        if c.kind == "sub":
            a, b = rename(c.args[0], m), rename(c.args[1], m)
            if a == b:
                dropped += 1
                continue
            out.append(replace(c, args=(a, b)))
        else:
            out.append(replace(c, args=tuple(Var(m.get(v.name, v.name)) for v in c.args)))
    return out, dropped
