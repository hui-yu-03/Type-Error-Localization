"""Hints for missing code: a forgotten `return` or `await`.

Missing code has no constraints, so no correction subset can contain it (the
smallest correction subsets point at the function header or at the use of the
value instead).  For the lines that the ranking finds most suspicious,
localizer/repair.js proposes two kinds of small edits: add a `return` to a
function without one whose result is used, and add an `await` to the value of a
declaration/assignment in an async function.  An edit becomes a *hint* if it
removes at least one conflict: the smallest correction subset of the edited
program is smaller than that of the original one (with a single mistake: the
edited program is well typed).  Hints are shown before the correction subsets.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

import z3

from .constraints import REPO_ROOT, program_from_json, run_infer
from .encode import encode

REPAIR_JS = REPO_ROOT / "localizer" / "repair.js"


@dataclass(frozen=True)
class Hint:
    kind: str  # add-return | add-await
    line: int  # where the code is missing
    description: str


def candidate_repairs(path: str | Path, lines: Iterable[int]) -> list[dict]:
    lines = sorted(set(lines))
    if not lines:
        return []
    out = subprocess.run(
        ["node", str(REPAIR_JS), str(path), ",".join(map(str, lines))],
        capture_output=True, text=True, timeout=60, cwd=REPO_ROOT,
    )
    return json.loads(out.stdout) if out.returncode == 0 and out.stdout.strip() else []


def smallest_mcs_cost(source: str, plus: str = "strict", closed_fields: bool = False,
                      timeout: float = 30.0) -> Optional[int]:
    """Size of the smallest correction subset (0: well typed); None if unknown."""
    from .mcs import HardConflict, Timeout, make

    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "repaired.js"
        p.write_text(source)
        try:
            data = run_infer(p)
        except RuntimeError:
            return None
    if not data.get("parsed", True):
        return None
    enc = encode(program_from_json(data, source), plus=plus, closed_fields=closed_fields)
    s = enc.solver(timeout_ms=int(timeout * 1000))
    r = s.check(*enc.selectors.values())
    if r == z3.sat:
        return 0
    if r != z3.unsat:
        return None
    try:
        m = make("oll", enc, timeout=timeout).first()
    except (HardConflict, Timeout):
        return None
    return m.cost if m else None


def find_hints(path: str | Path, lines: Iterable[int], plus: str = "strict",
               closed_fields: bool = False, cost: int = 1) -> list[Hint]:
    """Repairs of missing code, related to `lines`, that remove at least one
    conflict: the edited program's smallest correction subset is smaller than
    `cost`, the size of the original one (default 1: the edit must make the
    program well typed)."""
    hints = []
    for r in candidate_repairs(path, lines):
        c = 0 if cost <= 1 and well_typed(r["source"], plus, closed_fields) else (
            smallest_mcs_cost(r["source"], plus, closed_fields) if cost > 1 else None)
        if c is not None and c < cost:
            hints.append(Hint(r["kind"], r["line"], r["description"]))
    return hints


def well_typed(source: str, plus: str = "strict", closed_fields: bool = False, timeout_ms: int = 10000) -> bool:
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "repaired.js"
        p.write_text(source)
        try:
            data = run_infer(p)
        except RuntimeError:
            return False
    if not data.get("parsed", True):
        return False
    enc = encode(program_from_json(data, source), plus=plus, closed_fields=closed_fields)
    s = enc.solver(timeout_ms=timeout_ms)
    return s.check(*enc.selectors.values()) == z3.sat
