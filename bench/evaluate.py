"""Evaluation of one program with known mistake line(s).

evaluate_single(): one mistake at a known line -> rank of that line under each
ranking strategy and each first-conflict baseline, plus facts about the
correction subsets (question Q1/Q2).

evaluate_multi(): several mistakes -> precision/recall of the first MCS and of
the top of the ranked list.

time_algorithms(): time to the first optimal correction subset with OLL, IHS
and Z3 (question Q3).
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


def evaluate_single(source: str, targets: list[int], closed_fields: bool = False, timeout: float = 30.0) -> dict:
    t0 = time.perf_counter()
    data = infer_source(source)
    program = program_from_json(data, source)
    enc = encode(program, closed_fields=closed_fields)
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
    row["target_has_constraints"] = any(t in enc.groups for t in targets)
    # Q1: is the mistake line alone a correction subset?
    s = enc.solver(timeout_ms=int(timeout * 1000))
    keep = [enc.selectors[L] for L in enc.lines if L not in targets]
    row["target_is_correction"] = s.check(*keep) == z3.sat

    b1 = baseline.first_conflicts(enc, k=5, timeout_ms=int(timeout * 1000))
    row["rank_first_conflict_js"] = _rank_in(js_lines, targets)
    row["rank_first_conflict_smt"] = _rank_in(b1, targets)

    card_pool = rank.enumerate_pool(enc, None, "oll", min_count=10, hard_cap=40, timeout=timeout)
    size_pool = rank.enumerate_pool(enc, rank.size_weights(enc), "oll", min_count=10, hard_cap=40, timeout=timeout)
    rankings = rank.rank_from_pools(enc, card_pool, size_pool)
    row["pool_complete"] = card_pool.complete and size_pool.complete
    for name, r in rankings.items():
        ranks = [r.rank_of(t) for t in targets]
        ranks = [x for x in ranks if x is not None]
        row[f"rank_{name}"] = min(ranks) if ranks else None
        row[f"first_{name}"] = list(r.candidates[0].lines) if r.candidates else []
    if card_pool.mcses:
        min_cost = card_pool.mcses[0].cost
        tier = [m for m in card_pool.mcses if m.cost == min_cost]
        row["min_mcs_size"] = min_cost
        row["n_min_mcs"] = len(tier)
        row["target_in_min_mcs"] = any(t in m.lines for m in tier for t in targets)
        cands = [rank.to_candidate(enc, m.lines) for m in card_pool.mcses]
        tb = rank.random_tiebreak(cands, targets[0])
        row["random_top1"], row["random_top3"] = tb["top1"], tb["top3"]
    row["time"] = time.perf_counter() - t0
    return row


def evaluate_multi(source: str, targets: list[int], timeout: float = 60.0) -> dict:
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
    k = len(targets)
    pool = rank.enumerate_pool(enc, None, "oll", min_count=5, hard_cap=20, timeout=timeout)
    r = rank.rank_from_pools(enc, pool)["card"]
    first = set(r.candidates[0].lines) if r.candidates else set()
    row["first_mcs_size"] = len(first)
    row["first_mcs_precision"] = len(first & T) / len(first) if first else 0.0
    row["first_mcs_recall"] = len(first & T) / k
    top = r.lines[:k]
    row["topk_recall"] = len(set(top) & T) / k
    b1 = baseline.first_conflicts(enc, k=k, timeout_ms=int(timeout * 1000))
    row["first_conflict_topk_recall"] = len(set(b1[:k]) & T) / k
    # how many of the mistakes are "visible" (their line alone matters)?
    row["time"] = time.perf_counter() - t0
    return row


def time_algorithms(source: str, algorithms=("oll", "ihs", "z3"), timeout: float = 120.0) -> list[dict]:
    t0 = time.perf_counter()
    data = infer_source(source)
    t_infer = time.perf_counter() - t0
    program = program_from_json(data, source)
    t1 = time.perf_counter()
    enc = encode(program)
    t_encode = time.perf_counter() - t1
    base = {"lines": len(enc.lines), "constraints": len(program.constraints), "t_infer": t_infer, "t_encode": t_encode}
    rows = []
    for a in algorithms:
        en = mcs.make(a, enc, timeout=timeout)
        row = dict(base, algorithm=a)
        try:
            m = en.first()
            row.update(status="ok", time=en.elapsed(), cost=m.cost if m else None)
        except mcs.Timeout:
            row.update(status="timeout", time=timeout, cost=None)
        row.update(sat_calls=en.stats.sat_calls, cores=en.stats.cores,
                   mean_core=(sum(en.stats.core_sizes) / len(en.stats.core_sizes)) if en.stats.core_sizes else 0)
        rows.append(row)
    return rows
