"""Evaluation of one program with known mistake line(s).

evaluate_single(): one mistake at a known line -> rank of that line under each
ranking strategy and each first-conflict baseline, plus facts about the
correction subsets (question Q1/Q2).

evaluate_multi(): several mistakes -> precision/recall of the first MCS and of
the top of the ranked list.

time_config(): time to the first optimal correction subset with OLL, IHS or
Z3 under one of the performance configurations (question Q3, item 2).
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional

import z3

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from localizer import baseline, mcs, rank  # noqa: E402
from localizer.constraints import program_from_json, run_infer, run_solver_js  # noqa: E402
from localizer.encode import encode  # noqa: E402
from localizer.repair import find_hints  # noqa: E402
from localizer.features import fanout_of, pool_counts, tier_features  # noqa: E402

STRATEGIES = list(rank.STRATEGIES)


def infer_source(source: str, workdir: Optional[str] = None) -> dict:
    with tempfile.TemporaryDirectory(dir=workdir) as d:
        p = Path(d) / "program.js"
        p.write_text(source)
        return run_infer(p)


def mutants(path: str, max_per_op: int = 1000, ops: Optional[str] = None) -> list[dict]:
    cmd = ["node", str(ROOT / "bench" / "mutate.js"), "list", path, "--max-per-op", str(max_per_op)]
    if ops:
        cmd += ["--ops", ops]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True, cwd=ROOT)
    return [json.loads(line) for line in out.stdout.splitlines() if line.strip()]


def sample_mistakes(path: str, k: int, seed: int) -> dict:
    cmd = ["node", str(ROOT / "bench" / "mutate.js"), "sample", path, "--k", str(k), "--seed", str(seed)]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True, cwd=ROOT)
    return json.loads(out.stdout)


def is_clean(source: str) -> tuple[bool, bool]:
    """(well typed under the SMT encoding, no conflict in solver.js)."""
    data = infer_source(source)
    program = program_from_json(data, source)
    smt_ok = encode(program).check() == z3.sat
    js_ok = not run_solver_js(data)["conflicts"]
    return smt_ok, js_ok


def _rank_in(lines: list[int], targets: list[int]) -> Optional[int]:
    pos = [lines.index(t) + 1 for t in targets if t in lines]
    return min(pos) if pos else None


def _record_rankings(row: dict, rankings: dict, enc, targets: list[int], suffix: str = "") -> None:
    for name, r in rankings.items():
        ranks = [r.rank_of(t) for t in targets]
        ranks = [x for x in ranks if x is not None]
        row[f"rank_{name}{suffix}"] = min(ranks) if ranks else None
        row[f"first_{name}{suffix}"] = [enc.line_of(g) for g in r.candidates[0].lines] if r.candidates else []


def evaluate_single(source: str, targets: list[int], closed_fields: bool = False, timeout: float = 30.0,
                    group_by: str = "line", reinfer: bool = False) -> dict:
    """One mistake at a known line.  With reinfer, the rankings are also
    computed with the re-inference candidates (columns rank_<strategy>+reinfer)."""
    t0 = time.perf_counter()
    data = infer_source(source)
    program = program_from_json(data, source)
    enc = encode(program, closed_fields=closed_fields, group_by=group_by)
    on_target = lambda g: any(enc.covers(g, t) for t in targets)  # noqa: E731
    row: dict = {"lines": len(enc.lines), "constraints": len(program.constraints)}
    status = enc.check(timeout_ms=int(timeout * 1000))
    row["smt_status"] = str(status)
    js = run_solver_js(data)
    js_lines = baseline.solver_js_lines(js)
    row["js_detected"] = bool(js["conflicts"])
    if status != z3.unsat:
        row["detected"] = False
        return row
    row["detected"] = True
    row["target_has_constraints"] = any(on_target(g) for g in enc.groups)
    # Q1: is the mistake line alone a correction subset?
    s = enc.solver(timeout_ms=int(timeout * 1000))
    keep = [enc.selectors[g] for g in enc.lines if not on_target(g)]
    row["target_is_correction"] = s.check(*keep) == z3.sat

    b1 = baseline.first_conflicts(enc, k=5, timeout_ms=int(timeout * 1000))
    row["rank_first_conflict_js"] = _rank_in(js_lines, targets)
    row["rank_first_conflict_smt"] = _rank_in(b1, targets)

    card_pool = rank.enumerate_pool(enc, None, "oll", min_count=10, hard_cap=40, timeout=timeout)
    size_pool = rank.enumerate_pool(enc, rank.size_weights(enc), "oll", min_count=10, hard_cap=40, timeout=timeout)
    rankings = rank.rank_from_pools(enc, card_pool, size_pool)
    row["pool_complete"] = card_pool.complete and size_pool.complete
    _record_rankings(row, rankings, enc, targets)
    if reinfer and group_by == "line":
        # item 4: re-inference; item 3: hints for missing code; "best" = both
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "program.js"
            path.write_text(source)
            t1 = time.perf_counter()
            extra = rank.reinference_singletons(enc, card_pool, path, closed_fields=closed_fields)
            row["time_reinfer"] = time.perf_counter() - t1
            t1 = time.perf_counter()
            hints = find_hints(path, rank.top_lines(enc, rankings["card-late"].candidates), closed_fields=closed_fields)
            row["time_hints"] = time.perf_counter() - t1
        row["reinfer_lines"] = extra
        row["target_is_reinfer_correction"] = row["target_is_correction"] or any(t in extra for t in targets)
        with_reinfer = rank.rank_from_pools(enc, card_pool, size_pool, extra)
        _record_rankings(row, with_reinfer, enc, targets, "+reinfer")
        row["hints"] = [[h.kind, h.line] for h in hints]
        row["hint_on_target"] = any(h.line in targets for h in hints)
        for r in list(rankings.values()) + list(with_reinfer.values()):
            r.hints = hints
        _record_rankings(row, rankings, enc, targets, "+hints")
        _record_rankings(row, with_reinfer, enc, targets, "+reinfer+hints")
    if group_by == "line" and card_pool.mcses:
        # training data for the learned tie-breaker: the first tiers with features
        cands = [rank.to_candidate(enc, m.lines) for m in card_pool.mcses]
        counts, n = pool_counts(enc, card_pool.mcses)
        fan = fanout_of(enc)
        row["tiers"] = [
            [{"lines": [enc.line_of(g) for g in c.lines], "x": [round(v, 4) for v in x],
              "y": int(any(on_target(g) for g in c.lines))}
             for c, x in zip(tier[:12], tier_features(enc, tier[:12], counts, n, fan))]
            for tier in rank.tiers_of(cands)[:3]
        ]
    if card_pool.mcses:
        min_cost = card_pool.mcses[0].cost
        tier = [m for m in card_pool.mcses if m.cost == min_cost]
        row["min_mcs_size"] = min_cost
        row["n_min_mcs"] = len(tier)
        row["target_in_min_mcs"] = any(on_target(g) for m in tier for g in m.lines)
        cands = [rank.to_candidate(enc, m.lines) for m in card_pool.mcses]
        tb = rank.random_tiebreak(cands, targets[0], covers=enc.covers)
        row["random_top1"], row["random_top3"] = tb["top1"], tb["top3"]
    row["time"] = time.perf_counter() - t0
    return row


def apply_mistakes(source: str, mistakes: list[dict]) -> str:
    """Apply mutation sites (from `mutate.js sample`) to a source text."""
    for m in sorted(mistakes, key=lambda m: -m["start"]):
        source = source[: m["start"]] + m["replacement"] + source[m["end"] :]
    return source


def evaluate_multi(source: str, targets: list[int], base_source: Optional[str] = None,
                   mistakes: Optional[list[dict]] = None, timeout: float = 60.0) -> dict:
    """Several mistakes.  A mistake is *effective* if applying it alone to the
    base program already causes a type error; benign mistakes cannot be found
    by any method, so recall is also reported relative to the effective ones."""
    t0 = time.perf_counter()
    data = infer_source(source)
    program = program_from_json(data, source)
    enc = encode(program)
    row: dict = {"lines": len(enc.lines), "constraints": len(program.constraints), "k": len(targets)}
    if enc.check() != z3.unsat:
        row["detected"] = False
        return row
    row["detected"] = True
    T = set(targets)
    effective = set(T)
    if base_source is not None and mistakes:
        effective = set()
        for m in mistakes:
            single = apply_mistakes(base_source, [m])
            p1 = program_from_json(infer_source(single), single)
            if encode(p1).check() == z3.unsat:
                effective.add(m["line"])
    row["effective"] = len(effective)
    pool = rank.enumerate_pool(enc, None, "oll", min_count=5, hard_cap=20, timeout=timeout)
    rankings = rank.rank_from_pools(enc, pool)
    b1 = baseline.first_conflicts(enc, k=max(len(T), 1), timeout_ms=int(timeout * 1000))
    first = {enc.line_of(g) for g in rankings["card"].candidates[0].lines} if rankings["card"].candidates else set()
    row["first_mcs_size"] = len(first)
    row["first_mcs_precision"] = len(first & T) / len(first) if first else 0.0
    row["first_mcs_recall"] = len(first & T) / len(T)
    e = len(effective)
    row["first_mcs_recall_eff"] = len(first & effective) / e if e else None
    with tempfile.TemporaryDirectory() as d:  # full pipeline: latest first + re-inference + hints
        path = Path(d) / "program.js"
        path.write_text(source)
        extra = rank.reinference_singletons(enc, pool, path)
        full = rank.rank_from_pools(enc, pool, None, extra)["card-late"]
        full.hints = find_hints(path, rank.top_lines(enc, full.candidates, k=max(6, 2 * len(T))))
    rankings["full"] = full
    for name in ("card", "card-late", "learned", "full"):
        lines = rankings[name].lines
        row[f"top_recall_{name}"] = len(set(lines[: len(T)]) & T) / len(T)
        row[f"top_recall_eff_{name}"] = len(set(lines[:e]) & effective) / e if e else None
    row["top_recall_first_conflict"] = len(set(b1[: len(T)]) & T) / len(T)
    row["top_recall_eff_first_conflict"] = len(set(b1[:e]) & effective) / e if e else None
    row["time"] = time.perf_counter() - t0
    return row


# -- performance configurations (item: performance) ----------------------------------
CONFIGS = {
    "before": dict(simplify=False, slicing=False, minimize_cores=True),  # the first version
    "no-core-min": dict(simplify=False, slicing=False, minimize_cores=False),
    "simplify": dict(simplify=True, slicing=False, minimize_cores=True),
    "slicing": dict(simplify=False, slicing=True, minimize_cores=True),
    "after": dict(simplify=True, slicing=True, minimize_cores=None),  # the defaults now
}


def time_config(source: str, algorithm: str, config: str, timeout: float = 300.0, data: Optional[dict] = None) -> dict:
    """Time to the first smallest MCS, split into encoding, slicing and solving."""
    from localizer.slicing import slice_to_conflicts

    cfg = CONFIGS[config]
    data = data or infer_source(source)
    program = program_from_json(data, source)
    t0 = time.perf_counter()
    enc = encode(program, simplify=cfg["simplify"])
    t_encode = time.perf_counter() - t0
    t0 = time.perf_counter()
    groups_before = len(enc.lines)
    if cfg["slicing"]:
        enc, _ = slice_to_conflicts(enc, timeout_ms=int(timeout * 1000))
    t_slice = time.perf_counter() - t0
    en = mcs.make(algorithm, enc, timeout=timeout, minimize_cores=cfg["minimize_cores"])
    row = {"algorithm": algorithm, "config": config, "lines": groups_before, "groups_solved": len(enc.lines),
           "constraints": len(program.constraints), "t_encode": t_encode, "t_slice": t_slice}
    try:
        m = en.first()
        row.update(status="ok", t_solve=en.elapsed(), cost=m.cost if m else None)
    except mcs.Timeout:
        row.update(status="timeout", t_solve=timeout, cost=None)
    row.update(time=row["t_encode"] + row["t_slice"] + row["t_solve"], sat_calls=en.stats.sat_calls,
               cores=en.stats.cores)
    return row

