"""Experiments for questions Q1-Q3.

    python bench/run_experiments.py mutants     # Q1/Q2 on the test suite (one mistake each)
    python bench/run_experiments.py generated   # Q1/Q2 on generated programs (one mistake each)
    python bench/run_experiments.py multi       # several mistakes per program
    python bench/run_experiments.py scaling     # Q3: OLL vs IHS vs Z3 on large programs
    python bench/run_experiments.py all

Results are written as CSV files to results/; bench/report.py turns them into
the tables and plots of the README.
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import os
import random
import sys
import time
import zlib
from multiprocessing import Pool
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

import evaluate as ev  # noqa: E402
from generate import generate  # noqa: E402

RESULTS = ROOT / "results"
CORPUS = HERE / "corpus"


def write_csv(path: Path, rows: list[dict]) -> None:
    keys: list[str] = []
    for r in rows:
        for k in r:
            if k not in keys:
                keys.append(k)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        for r in rows:
            w.writerow({k: json.dumps(v) if isinstance(v, (list, dict)) else v for k, v in r.items()})


def run_parallel(fn, tasks: list, jobs: int, label: str) -> list:
    out = []
    t0 = time.time()
    with Pool(jobs) as pool:
        for i, res in enumerate(pool.imap_unordered(fn, tasks, chunksize=1), 1):
            if isinstance(res, list):
                out.extend(res)
            elif res is not None:
                out.append(res)
            if i % 25 == 0 or i == len(tasks):
                print(f"  [{label}] {i}/{len(tasks)}  {time.time() - t0:.0f}s", flush=True)
    return out


# -- single-mistake corpora --------------------------------------------------------
# setting -> (closed_fields, group_by, reinfer)
SETTINGS = {
    "open": (False, "line", True),
    "closed": (True, "line", False),
    "statement": (False, "statement", False),
    "node": (False, "node", False),
}


def _single(task: dict) -> dict:
    row = {k: v for k, v in task.items() if k != "source"}
    closed, group_by, reinfer = SETTINGS[task["setting"]]
    try:
        row.update(ev.evaluate_single(task["source"], task["lines"], closed_fields=closed,
                                      group_by=group_by, reinfer=reinfer))
    except Exception as e:  # keep going; the failure is recorded
        row.update(error=repr(e)[:200])
    return row


def _clean_settings(source: str) -> list[str]:
    """Settings under which a base program is well typed (and solver.js
    reports no conflict)."""
    data = ev.infer_source(source)
    program = ev.program_from_json(data, source)
    if ev.run_solver_js(data)["conflicts"]:
        return []
    out = []
    for setting, (closed, _, _) in SETTINGS.items():
        if ev.encode(program, closed_fields=closed).check() == ev.z3.sat:
            out.append(setting)
    return out


def _sample_mutants(path: str, per_op: int, seed: int) -> list[dict]:
    ms = ev.mutants(path)
    rng = random.Random(seed)
    by_op: dict[str, list] = {}
    for m in ms:
        by_op.setdefault(m["op"], []).append(m)
    out = []
    for op in sorted(by_op):
        items = by_op[op]
        out.extend(items if len(items) <= per_op else rng.sample(items, per_op))
    return out


def single_corpus(name: str, bases: list[tuple[str, str]], per_op: int, jobs: int) -> None:
    """bases: (label, path)"""
    tasks = []
    excluded = []
    for label, path in bases:
        settings = _clean_settings(Path(path).read_text())
        if not settings:
            excluded.append(label)
            continue
        for m in _sample_mutants(path, per_op, seed=zlib.crc32(label.encode())):
            for setting in settings:
                tasks.append(dict(corpus=name, base=label, op=m["op"], line=m["line"], lines=m["lines"],
                                  description=m["description"], setting=setting, source=m["source"]))
    print(f"{name}: {len(bases) - len(excluded)} base programs, {len(tasks)} evaluations "
          f"(excluded, not well typed: {len(excluded)})", flush=True)
    rows = run_parallel(_single, tasks, jobs, name)
    rows.sort(key=lambda r: (r["base"], r["line"], r["op"], r["setting"]))
    write_csv(RESULTS / f"{name}.csv", rows)
    (RESULTS / f"{name}_excluded.json").write_text(json.dumps(excluded, indent=1))


def cmd_mutants(args) -> None:
    files = sorted(glob.glob(str(ROOT / "Tests" / "**" / "*.js"), recursive=True))
    bases = [(str(Path(f).relative_to(ROOT)), f) for f in files]
    single_corpus("mutants", bases, args.per_op, args.jobs)


def _generated_bases(lines: int, count: int, first_seed: int, subdir: str) -> list[tuple[str, str]]:
    """count generated programs that both checkers accept (seeds are skipped otherwise)."""
    d = CORPUS / subdir
    d.mkdir(parents=True, exist_ok=True)
    bases = []
    seed = first_seed
    while len(bases) < count:
        src = generate(lines, seed)
        smt_ok, js_ok = ev.is_clean(src)
        if smt_ok and js_ok:
            p = d / f"gen_{lines}_{seed}.js"
            p.write_text(src)
            bases.append((str(p.relative_to(ROOT)), str(p)))
        seed += 1
    return bases


def cmd_generated(args) -> None:
    bases = _generated_bases(args.lines, args.programs, 1, "generated")
    single_corpus("generated", bases, args.per_op, args.jobs)


# -- several mistakes ----------------------------------------------------------------
def _multi(task: dict) -> dict:
    row = {k: v for k, v in task.items() if k != "source"}
    try:
        row.update(ev.evaluate_multi(task["source"], task["mistake_lines"],
                                     base_source=(ROOT / task["base"]).read_text(), mistakes=task["mistakes"]))
    except Exception as e:
        row.update(error=repr(e)[:200])
    return row


def cmd_multi(args) -> None:
    bases = _generated_bases(200, args.programs, 1001, "multi")
    tasks = []
    for label, path in bases:
        for k in (1, 2, 3, 4, 6):
            for seed in range(1, 4):
                s = ev.sample_mistakes(path, k, seed)
                tasks.append(dict(base=label, k=k, seed=seed, mistake_lines=s["lines"],
                                  ops=[m["op"] for m in s["mistakes"]], mistakes=s["mistakes"],
                                  source=s["source"]))
    print(f"multi: {len(tasks)} programs", flush=True)
    rows = run_parallel(_multi, tasks, args.jobs, "multi")
    for r in rows:
        r.pop("mistakes", None)
    write_csv(RESULTS / "multi.csv", rows)


# -- scaling (Q3) and performance (item 2) -------------------------------------------
def _scaling(task: dict) -> list[dict]:
    data = ev.infer_source(task["source"])
    rows = []
    for algorithm, config in task["runs"]:
        r = ev.time_config(task["source"], algorithm, config, timeout=task["timeout"], data=data)
        rows.append(dict({k: v for k, v in task.items() if k not in ("source", "runs")}, **r))
    return rows


def cmd_scaling(args) -> None:
    """Main runs (OLL/IHS/Z3, before/after the performance changes) on one-module
    programs, an ablation of the changes (OLL), and modular programs."""
    d = CORPUS / "scaling"
    d.mkdir(parents=True, exist_ok=True)
    main_runs = [(a, c) for a in ("oll", "ihs", "z3") for c in ("before", "after")]
    ablation = [("oll", c) for c in ("no-core-min", "simplify", "slicing")]
    tasks = []
    for kind, sizes, modules, ks in (("program", args.sizes, 1, args.mistakes),
                                     ("modular", args.modular_sizes, 8, (1, 4))):
        for n in sizes:
            for seed in range(1, args.seeds + 1):
                src = generate(n, (5000 if modules == 1 else 7000) + seed, modules)
                p = d / f"{kind}_{n}_{seed}.js"
                p.write_text(src)
                for k in ks:
                    s = ev.sample_mistakes(str(p), k, seed)
                    runs = main_runs + (ablation if kind == "program" and n in args.ablation_sizes else [])
                    tasks.append(dict(kind=kind, size=n, modules=modules, seed=seed, k=k,
                                      mistake_lines=s["lines"], source=s["source"], timeout=args.timeout, runs=runs))
    tasks.sort(key=lambda t: -t["size"])  # long runs first
    print(f"scaling: {len(tasks)} programs, {sum(len(t['runs']) for t in tasks)} runs", flush=True)
    rows = run_parallel(_scaling, tasks, args.jobs, "scaling")
    rows.sort(key=lambda r: (r["kind"], r["size"], r["k"], r["seed"], r["algorithm"], r["config"]))
    write_csv(RESULTS / "scaling.csv", rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("experiment", choices=["mutants", "generated", "multi", "scaling", "all"])
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--per-op", type=int, default=6, help="max mutants per operator and program")
    ap.add_argument("--programs", type=int, default=40)
    ap.add_argument("--lines", type=int, default=60)
    ap.add_argument("--sizes", type=int, nargs="+", default=[500, 1000, 2000, 4000, 8000])
    ap.add_argument("--modular-sizes", type=int, nargs="+", default=[2000, 8000])
    ap.add_argument("--mistakes", type=int, nargs="+", default=[1, 4, 16])
    ap.add_argument("--seeds", type=int, default=2)
    ap.add_argument("--timeout", type=float, default=300.0)
    ap.add_argument("--ablation-sizes", type=int, nargs="*", default=[2000, 8000])
    args = ap.parse_args()
    exps = ["mutants", "generated", "multi", "scaling"] if args.experiment == "all" else [args.experiment]
    for e in exps:
        t0 = time.time()
        {"mutants": cmd_mutants, "generated": cmd_generated, "multi": cmd_multi, "scaling": cmd_scaling}[e](args)
        print(f"{e} done in {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
