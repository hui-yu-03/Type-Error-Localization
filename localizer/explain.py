"""Explaining a candidate, and a question that separates two tied candidates.

A candidate (a correction subset) says "drop these lines".  Why?  The program
without the candidate is typable, and its typing forces some types; the
candidate's own constraints force others.  explain() names the program
variables whose type the candidate's lines and the rest of the program force
differently:

    line 1 makes p a Promise<str, ?>; the rest of the program needs Promise<num, ?>

When two candidates tie, the rest of the program without the one and without
the other force different types for some variable; asking which one is
intended decides the tie (question()).

Only types that the constraints force are compared (describe_types with a
solver: unforced parts print as "?"), so the explanation never depends on an
arbitrary choice of the solver.
"""

from __future__ import annotations

from typing import Optional

import z3

from .encode import Encoding, describe_types, group_key
from .reinfer import constraint_vars


def pretty(name: str) -> str:
    """x__scope -> x;  ret__f__scope -> the result of f."""
    parts = name.split("__")
    if parts[0] == "ret" and len(parts) > 2:
        return f"the result of {parts[1]}"
    return parts[0]


def _program_vars(enc: Encoding, groups) -> list[str]:
    names = set()
    for c in enc.program.constraints:
        if not c.hard and group_key(c, enc.group_by) in groups:
            names |= {v for v in constraint_vars(c) if "__" in v and not v.startswith("async_inner__")}
    return sorted(names)


def _forced_types(enc: Encoding, keep, names: list[str], timeout_ms: int) -> Optional[dict]:
    """The forced types of names when exactly the groups in keep are kept."""
    s = enc.solver(timeout_ms)
    assumptions = [sel for g, sel in enc.selectors.items() if g in keep]
    if s.check(*assumptions) != z3.sat:
        return None
    return describe_types(enc, s.model(), names, solver=s, assumptions=assumptions, max_checks=80)


def _informative(t: str) -> bool:
    return t not in ("?", "...") and not t.startswith("?")


def explain(enc: Encoding, groups, timeout_ms: int = 5000, limit: int = 2) -> list[str]:
    """Sentences: what the candidate's lines force, against what the rest needs."""
    groups = set(groups)
    names = _program_vars(enc, groups)
    if not names:
        return []
    rest = _forced_types(enc, set(enc.selectors) - groups, names, timeout_ms)
    alone = _forced_types(enc, groups, names, timeout_ms)
    if rest is None or alone is None:
        return []
    lines = ", ".join(str(enc.line_of(g)) for g in sorted(groups, key=enc.line_of))
    out = []
    for n in names:
        a, r = alone[n], rest[n]
        if a != r and _informative(a) and _informative(r):
            out.append(f"line{'s' if len(groups) > 1 else ''} {lines} make{'' if len(groups) > 1 else 's'} "
                       f"{pretty(n)} {a}; the rest of the program needs {r}")
            if len(out) >= limit:
                break
    return out


def question(enc: Encoding, first, second, timeout_ms: int = 5000) -> Optional[dict]:
    """A variable whose intended type tells two tied candidates apart.

    Returns {"variable", "if_first": type when the first candidate is the
    mistake, "if_second": ...} or None."""
    first, second = set(first), set(second)
    names = sorted(set(_program_vars(enc, first)) | set(_program_vars(enc, second)))
    if not names:
        return None
    without_first = _forced_types(enc, set(enc.selectors) - first, names, timeout_ms)
    without_second = _forced_types(enc, set(enc.selectors) - second, names, timeout_ms)
    if without_first is None or without_second is None:
        return None
    for n in names:
        a, b = without_first[n], without_second[n]
        if a != b and _informative(a) and _informative(b):
            return {"variable": pretty(n), "if_first": a, "if_second": b}
    return None
