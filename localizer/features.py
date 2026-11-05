"""Features of candidate lines, for ordering equally small candidates.

Within a tier of equally small candidates (a tie), nothing in the constraints
says which candidate is the mistake: two lines that contradict each other once
give two candidates.  The features describe each line of a tie relative to the
other lines of the tie: its position, whether it defines a variable that
another tied line uses (or uses one defined there), how much code it is, and
what kind of code it is.  A conditional-logit model (bench/train_ranker.py)
learns weights for them; the `learned` strategy orders each tier by the score.
"""

from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Optional

FEATURES = [
    "position",          # 0 = earliest line of the tie, 1 = latest
    "latest",            # the latest line of the tie
    "earliest",          # the earliest line of the tie
    "log_constraints",   # log(1 + number of constraints of the line)
    "fewest_constraints",  # fewest constraints in the tie
    "defines_for_tie",   # declares/assigns a name used by another tied line
    "uses_from_tie",     # uses a name declared/assigned by another tied line
    "log_fanout",        # log(1 + lines using a name the line declares)
    "declaration",       # const/let/var declaration
    "literal",           # contains a literal
    "call",
    "member",            # property access
    "await",
    "return",
    "function_header",
    "mcs_frequency",     # share of the enumerated MCSs that contain the line
]

MODEL_PATH = Path(__file__).resolve().parent / "ranking_model.json"


def _names(info: dict, *keys) -> set[str]:
    out: set[str] = set()
    for k in keys:
        out.update(info.get(k, []))
    return out


def line_features(enc, line: int, tie_lines: list[int], mcs_counts: dict, n_mcs: int,
                  fanout: dict) -> list[float]:
    info = enc.program.line_info.get(line, {})
    order = sorted(tie_lines)
    pos = order.index(line) / (len(order) - 1) if len(order) > 1 else 0.5
    size = enc.group_sizes.get(line, 0)
    sizes = [enc.group_sizes.get(L, 0) for L in tie_lines]
    defs = _names(info, "declares", "assigns")
    uses = _names(info, "uses")
    others = [L for L in tie_lines if L != line]
    other_uses = set().union(*(_names(enc.program.line_info.get(L, {}), "uses") for L in others)) if others else set()
    other_defs = set().union(
        *(_names(enc.program.line_info.get(L, {}), "declares", "assigns") for L in others)) if others else set()
    return [
        pos,
        float(line == order[-1] and len(order) > 1),
        float(line == order[0] and len(order) > 1),
        math.log1p(size),
        float(size == min(sizes)),
        float(bool(defs & other_uses)),
        float(bool(uses & other_defs)),
        math.log1p(fanout.get(line, 0)),
        float(bool(info.get("decl"))),
        float(info.get("literals", 0) > 0),
        float(info.get("calls", 0) > 0),
        float(info.get("members", 0) > 0),
        float(info.get("awaits", 0) > 0),
        float(info.get("returns", 0) > 0),
        float(bool(info.get("fnHeader"))),
        mcs_counts.get(line, 0) / max(n_mcs, 1),
    ]


def fanout_of(enc) -> dict[int, int]:
    """line -> number of other lines that use a name declared on it."""
    users: dict[str, set[int]] = {}
    for L, info in enc.program.line_info.items():
        for n in info.get("uses", []):
            users.setdefault(n, set()).add(L)
    return {L: len(set().union(*(users.get(n, set()) for n in info.get("declares", []))) - {L})
            if info.get("declares") else 0
            for L, info in enc.program.line_info.items()}


def tier_features(enc, tier: list, mcs_counts: dict, n_mcs: int, fanout: dict) -> list[list[float]]:
    """Feature vectors of the candidates of one tier (mean over a candidate's lines)."""
    lines = sorted({enc.line_of(g) for c in tier for g in c.lines})
    out = []
    for c in tier:
        vecs = [line_features(enc, enc.line_of(g), lines, mcs_counts, n_mcs, fanout) for g in c.lines]
        out.append([sum(v[i] for v in vecs) / len(vecs) for i in range(len(FEATURES))])
    return out


def pool_counts(enc, mcses) -> tuple[dict, int]:
    counts: dict[int, int] = {}
    for m in mcses:
        for L in {enc.line_of(g) for g in m.lines}:
            counts[L] = counts.get(L, 0) + 1
    return counts, len(mcses)


@lru_cache(maxsize=4)
def load_model(path: str = str(MODEL_PATH)) -> Optional[dict]:
    p = Path(path)
    if not p.exists():
        return None
    model = json.loads(p.read_text())
    if model.get("features") != FEATURES:
        raise ValueError(f"{path} was trained with different features")
    return model


def score(weights: list[float], x: list[float]) -> float:
    return sum(w * v for w, v in zip(weights, x))
