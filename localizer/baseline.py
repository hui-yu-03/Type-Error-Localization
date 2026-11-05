"""First-conflict baselines.

A conventional checker processes the constraints in the order they are
generated and reports the first one that cannot be added.  Two versions:

  solver_js_lines   the existing union-find solver (solver.js): the lines of the
                    conflicts it reports, in the order it met them.
  first_conflicts   the same strategy under the SMT semantics: the shortest
                    unsatisfiable prefix of the constraint sequence (found by
                    binary search, since unsatisfiability is monotone in the
                    prefix) ends with the constraint whose line is blamed.  To
                    obtain a ranked list, that line is dropped and the search
                    continues.

The second baseline isolates the effect of the localization strategy from the
small semantic differences between solver.js and the encoding.
"""

from __future__ import annotations

from typing import Optional

import z3

from .encode import Encoding


def solver_js_lines(result: dict) -> list[int]:
    lines: list[int] = []
    for c in result.get("conflicts", []):
        if c.get("line") is not None and c["line"] not in lines:
            lines.append(c["line"])
    return lines


def first_conflicts(enc: Encoding, k: int = 3, timeout_ms: Optional[int] = None) -> list[int]:
    soft = [(c, f) for c, f in enc.per_constraint if not c.hard]
    s = z3.Solver()
    if timeout_ms:
        s.set("timeout", int(timeout_ms))
    s.add(*enc.hard)
    ind = []
    for i, (c, f) in enumerate(soft):
        b = z3.Bool(f"c!{i}")
        s.add(z3.Implies(b, f))
        ind.append(b)
    dropped: set[int] = set()
    ranked: list[int] = []
    while len(ranked) < k:
        active = [i for i, (c, _) in enumerate(soft) if c.line not in dropped]
        r = s.check(*[ind[i] for i in active])
        if r != z3.unsat:
            break
        lo, hi = 1, len(active)  # the prefix of length hi is unsat
        while lo < hi:
            mid = (lo + hi) // 2
            if s.check(*[ind[i] for i in active[:mid]]) == z3.unsat:
                hi = mid
            else:
                lo = mid + 1
        line = soft[active[hi - 1]][0].line
        ranked.append(line)
        dropped.add(line)
    return ranked
