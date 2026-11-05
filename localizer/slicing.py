"""Slicing the formula to the parts that contain conflicts (item: performance).

Groups (lines) and type variables form a graph: a group is linked to the
variables of its constraints, and the variables of a hard constraint are
linked to each other.  Different connected components share no variables,
so the formula is the conjunction of independent parts, and a model of the
whole is just a model of every part (structured types carry identities from an
uninterpreted sort, which can be chosen apart between parts).  Hence:

  * a line in a component that is satisfiable on its own is never in a
    minimal correction subset (it can always be added back);
  * the MCSs of the program are the MCSs of the formula restricted to the
    unsatisfiable components.

slice_to_conflicts() checks every component except the largest (which is kept
without checking, so slicing never costs a check of the big formula) and
returns the encoding restricted to the components that are not known to be
satisfiable.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Optional

import z3

from .encode import Encoding, group_key
from .reinfer import constraint_vars


def components(enc: Encoding) -> list[tuple[set, set]]:
    """[(group keys, hard constraint ids)] per connected component."""
    parent: dict = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for c in enc.program.constraints:
        vs = [("V", v) for v in constraint_vars(c)]
        node = ("C", c.id) if c.hard else ("G", group_key(c, enc.group_by))
        find(node)
        for v in vs:
            union(node, v)
    comps: dict = {}
    for c in enc.program.constraints:
        node = ("C", c.id) if c.hard else ("G", group_key(c, enc.group_by))
        groups, hard = comps.setdefault(find(node), (set(), set()))
        (hard.add(c.id) if c.hard else groups.add(group_key(c, enc.group_by)))
    return list(comps.values())


def slice_to_conflicts(enc: Encoding, timeout_ms: Optional[int] = None) -> tuple[Encoding, dict]:
    if enc.encoder.closed_fields:  # justifications link the variables of several groups
        return enc, {"components": None}
    comps = [c for c in components(enc) if c[0]]
    hard_of = dict(zip(enc.stats["hard_ids"], enc.hard))
    comps.sort(key=lambda c: -len(c[0]))
    keep_groups, keep_hard = set(comps[0][0]) if comps else set(), set(comps[0][1]) if comps else set()
    dropped = 0
    for groups, hard in comps[1:]:
        s = z3.Solver()
        if timeout_ms:
            s.set("timeout", int(timeout_ms))
        s.add(*[hard_of[i] for i in hard if i in hard_of])
        s.add(*[enc.groups[g] for g in groups])
        if s.check() == z3.sat:
            dropped += len(groups)
            continue
        keep_groups |= groups
        keep_hard |= hard
    # (hard constraints of components without any group only constrain library
    # variables that no line uses: they are dropped with those components)
    kept = [g for g in enc.groups if g in keep_groups]
    program = replace(enc.program, constraints=[c for c in enc.program.constraints
                                                if (c.hard and c.id in keep_hard)
                                                or (not c.hard and group_key(c, enc.group_by) in keep_groups)])
    sliced = replace(
        enc,
        program=program,
        hard=[f for i, f in zip(enc.stats["hard_ids"], enc.hard) if i in keep_hard],
        groups=type(enc.groups)((g, enc.groups[g]) for g in kept),
        selectors=type(enc.selectors)((g, enc.selectors[g]) for g in kept),
        _per_constraint=None,
        group_sizes={g: enc.group_sizes[g] for g in kept},
        stats={**enc.stats, "hard_ids": [i for i in enc.stats["hard_ids"] if i in keep_hard]},
    )
    return sliced, {"components": len(comps), "dropped_groups": dropped, "kept_groups": len(kept)}
