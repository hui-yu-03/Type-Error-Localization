"""Re-inference: checking candidate lines by running inference again without them.

Dropping the constraints of a line is not quite the same as removing what the
line says: infer.js guesses types from earlier lines (type hints) and uses them
to decide how later lines are inferred, e.g. after `const s = 0` (a mistake
for a string), `s.toUpperCase()` is inferred as a field access on an object.
Dropping line 1's constraints leaves that wrong field access in place.

`infer.js --ignore-lines L` infers the program as if line L contributed
nothing, neither constraints nor type hints, so later lines are inferred
afresh.  A line L is a *re-inference correction* if the program inferred
this way is well typed.  Such lines are added to the candidates as
single-line correction subsets.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, Optional

import z3

from .constraints import program_from_json, run_infer
from .encode import Encoding, encode
from .terms import term_vars


def constraint_vars(c) -> set[str]:
    if c.kind == "sub":
        return term_vars(c.args[0]) | term_vars(c.args[1])
    return {v.name for v in c.args}


def related_lines(enc: Encoding, lines: Iterable[int], limit: int = 25) -> list[int]:
    """Lines that share a program variable (x__scope) with the given lines."""
    lines = set(lines)
    is_prog = lambda v: "__" in v and not v.startswith("async_inner__")  # noqa: E731
    shared: set[str] = set()
    by_line: dict[int, set[str]] = {}
    for c in enc.program.constraints:
        if c.hard:
            continue
        vs = {v for v in constraint_vars(c) if is_prog(v)}
        by_line.setdefault(c.line, set()).update(vs)
        if c.line in lines:
            shared |= vs
    out = sorted(L for L, vs in by_line.items() if vs & shared)
    return out[:limit]


def well_typed_without(path: str | Path, source: str, line: int, plus: str = "strict",
                       closed_fields: bool = False, timeout_ms: int = 10000) -> Optional[bool]:
    try:
        data = run_infer(path, ignore_lines=[line])
    except RuntimeError:
        return None
    if not data.get("parsed", True):
        return None
    enc = encode(program_from_json(data, source, str(path)), plus=plus, closed_fields=closed_fields)
    s = enc.solver(timeout_ms=timeout_ms)
    r = s.check(*enc.selectors.values())
    return None if r == z3.unknown else r == z3.sat


def reinference_corrections(path: str | Path, enc: Encoding, candidate_lines: Iterable[int],
                            plus: str = "strict", closed_fields: bool = False, limit: int = 25,
                            skip: Iterable[int] = ()) -> list[int]:
    """Single lines whose removal (with re-inference) makes the program well typed,
    among the lines related to the candidates (except those in `skip`)."""
    source = Path(path).read_text()
    skip = set(skip)
    out = []
    for L in related_lines(enc, candidate_lines, limit):
        if L in skip:
            continue
        if well_typed_without(path, source, L, plus, closed_fields):
            out.append(L)
    return out
