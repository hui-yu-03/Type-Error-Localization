"""Evaluation on FixJS: real bug-fixing commits of JavaScript functions.

    git clone --depth 1 https://github.com/RGAI-USZ/FixJS DATA
    python bench/fixjs.py screen DATA      # which bugs are type errors?
    python bench/fixjs.py evaluate DATA    # localize them
    python bench/fixjs.py report

FixJS (Csuvik and Vidacs, MSR 2022) has the versions before and after the fix
of every JavaScript function changed by a bug-fixing commit on GitHub in the
first half of 2012: 66,497 pairs in input/{50,50-100,100+} (fewer than 50
tokens, 50 to 100, more).  Each function becomes a program without moving its
lines: an anonymous function is the initializer of a constant, a named one
stays a declaration.  Free variables (globals, `this`, other modules) are left
unconstrained, so only what the function itself says is checked.

screen     classifies every pair (results/fixjs_screen.jsonl.gz): a pair is a
           *type error the type system sees* when the version before the fix
           is ill-typed and the version after it well typed under the SMT
           encoding;
evaluate   ranks the lines of those pairs with every method of
           bench/realworld.py, the lines changed by the fix being the mistake
           lines (results/fixjs.jsonl, results/fixjs.csv);
report     writes results/fixjs.md.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
import random
import re
import signal
import sys
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))

import evaluate as ev  # noqa: E402
import realworld  # noqa: E402
from localizer.constraints import program_from_json  # noqa: E402
from localizer.encode import encode  # noqa: E402

RESULTS = ROOT / "results"
SCREEN = RESULTS / "fixjs_screen.jsonl.gz"
EVAL = RESULTS / "fixjs.jsonl"
SIZES = ["50", "50-100", "100+"]
NAMED = re.compile(r"function\s+[A-Za-z_$][\w$]*\s*\(")
ANON = re.compile(r"function\s*\(")
FIXED = "type error fixed"


def wrap(source: str) -> str | None:
    """The function as a program with the same line numbers (None: not a function)."""
    head = source.lstrip()
    if NAMED.match(head):
        return source
    if ANON.match(head):
        return "const __fixjs = " + source
    return None


def pairs(data: Path):
    for size in SIZES:
        d = data / "input" / size
        for f in sorted(os.listdir(d / "before")):
            if f.endswith(".js") and (d / "after" / f).exists():
                yield size, f[:-3], str(d / "before" / f), str(d / "after" / f)


class _Timeout(Exception):
    pass


def _alarm(signum, frame):
    raise _Timeout()


def _read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8", errors="replace")


def verdict(source: str) -> tuple[str, int]:
    """(parse error | unsupported | well typed | ill-typed | unknown, number of constraints)."""
    data = ev.infer_source(source)
    if not data.get("parsed", True):
        return "parse error", 0
    program = program_from_json(data, source)
    if program.unparsed:  # a constraint the encoding does not understand
        return "unsupported", len(program.constraints)
    r = str(encode(program).check(timeout_ms=20000))
    return {"sat": "well typed", "unsat": "ill-typed"}.get(r, "unknown"), len(program.constraints)


def status(row: dict) -> str:
    if row["buggy"] != "ill-typed":
        return {"well typed": "bug not a type error"}.get(row["buggy"], row["buggy"])
    return {"well typed": FIXED, "ill-typed": "fixed version also ill-typed"}.get(row["fixed"], row["fixed"])


def screen_one(task) -> dict:
    size, name, before, after = task
    row = {"size": size, "name": name}
    t0 = time.time()
    signal.signal(signal.SIGALRM, _alarm)
    signal.alarm(120)
    try:
        buggy, fixed = wrap(_read(before)), wrap(_read(after))
        if buggy is None or fixed is None:
            row["status"] = "not a function"
            return row
        row["lines"] = buggy.count("\n") + 1
        row["buggy"], row["constraints"] = verdict(buggy)
        if row["buggy"] == "ill-typed":
            row["fixed"], _ = verdict(fixed)
        row["status"] = status(row)
    except _Timeout:
        row["status"] = "timeout"
    except Exception as e:  # noqa: BLE001 - anything infer.js or the encoding cannot handle
        row["status"] = "error"
        row["error"] = str(e)[:300]
    finally:
        signal.alarm(0)
        row["seconds"] = round(time.time() - t0, 3)
    return row


def read_jsonl(path: Path) -> list[dict]:
    """The rows of a JSON-lines file, also while it is being written or after an interruption."""
    rows: list[dict] = []
    if not path.exists():
        return rows
    opener = gzip.open if path.suffix == ".gz" else open
    try:
        with opener(path, "rt") as f:
            for line in f:
                if line.strip():
                    rows.append(json.loads(line))
    except (EOFError, json.JSONDecodeError):  # the last row was cut off
        pass
    return rows


def screen(data: Path, jobs: int, sample: int | None, seed: int, out: Path) -> None:
    tasks = list(pairs(data))
    if sample:
        tasks = random.Random(seed).sample(tasks, sample)
    done = {(r["size"], r["name"]) for r in read_jsonl(out)}  # resume an interrupted run
    tasks = [t for t in tasks if (t[0], t[1]) not in done]
    print(f"{len(tasks)} pairs to screen ({len(done)} already done)", file=sys.stderr)
    t0 = time.time()
    with gzip.open(out, "at") as f, ProcessPoolExecutor(jobs) as pool:
        for i, row in enumerate(pool.map(screen_one, tasks, chunksize=8), 1):
            f.write(json.dumps(row) + "\n")
            if i % 1000 == 0:
                f.flush()
                print(f"{i}/{len(tasks)} in {time.time() - t0:.0f} s", file=sys.stderr, flush=True)


def evaluate_one(task) -> dict:
    size, name, before, after = task
    t0 = time.time()
    signal.signal(signal.SIGALRM, _alarm)
    signal.alarm(600)
    try:
        row = realworld.evaluate_pair(name, wrap(_read(before)), wrap(_read(after)))
    except _Timeout:
        row = {"name": name, "error": "timeout"}
    except Exception as e:  # noqa: BLE001
        row = {"name": name, "error": str(e)[:300]}
    finally:
        signal.alarm(0)
    row["size"] = size
    row["seconds"] = round(time.time() - t0, 2)
    return row


def evaluate(data: Path, jobs: int, max_pairs: int | None, seed: int) -> None:
    chosen = [(r["size"], r["name"]) for r in read_jsonl(SCREEN) if r["status"] == FIXED]
    if max_pairs and len(chosen) > max_pairs:
        chosen = sorted(random.Random(seed).sample(chosen, max_pairs))
    done = {(r["size"], r["name"]) for r in read_jsonl(EVAL)}
    tasks = [(s, n, str(data / "input" / s / "before" / f"{n}.js"), str(data / "input" / s / "after" / f"{n}.js"))
             for s, n in chosen if (s, n) not in done]
    print(f"{len(tasks)} pairs to localize ({len(done)} already done)", file=sys.stderr)
    t0 = time.time()
    with open(EVAL, "a") as f, ProcessPoolExecutor(jobs) as pool:
        for i, row in enumerate(pool.map(evaluate_one, tasks), 1):
            f.write(json.dumps(row) + "\n")
            f.flush()
            if i % 50 == 0:
                print(f"{i}/{len(tasks)} in {time.time() - t0:.0f} s", file=sys.stderr, flush=True)
    rows = read_jsonl(EVAL)
    keys = list(dict.fromkeys(k for r in rows for k in r))
    with open(RESULTS / "fixjs.csv", "w", newline="") as f:
        w = csv.DictWriter(f, keys)
        w.writeheader()
        for r in rows:
            w.writerow({k: json.dumps(v) if isinstance(v, (list, dict)) else v for k, v in r.items()})


def _pct(a: int, b: int) -> str:
    return f"{100 * a / b:.1f}" if b else "–"


def report() -> str:
    screened = read_jsonl(SCREEN)
    rows = [r for r in read_jsonl(EVAL) if "error" not in r]
    out = ["# FixJS: real bug-fixing commits\n",
           "Generated by `python bench/fixjs.py report`. Pairs of a JavaScript function before and after a "
           "bug-fixing commit (FixJS, first half of 2012), checked one function at a time with free variables "
           "unconstrained.\n", "## Which bugs are type errors\n",
           "| function size (tokens) | pairs | functions | parsed | before the fix ill-typed | "
           "after the fix well typed |", "|---|---|---|---|---|---|"]
    for size in SIZES + ["all"]:
        rs = [r for r in screened if size in ("all", r["size"])]
        if not rs:
            continue
        fun = [r for r in rs if r["status"] != "not a function"]
        parsed = [r for r in fun if r.get("buggy") in ("well typed", "ill-typed", "unknown", "unsupported")]
        ill = [r for r in parsed if r.get("buggy") == "ill-typed"]
        ok = [r for r in ill if r["status"] == FIXED]
        out.append(f"| {size} | {len(rs):,} | {len(fun):,} | {len(parsed):,} | {len(ill):,} ({_pct(len(ill), len(parsed))}%) "
                   f"| **{len(ok):,}** ({_pct(len(ok), len(parsed))}%) |")
    c = Counter(r["status"] for r in screened)
    out += ["", "All statuses: " + ", ".join(f"{k} {v:,}" for k, v in c.most_common()) + ".\n"]
    loc = [r for r in rows if r.get("buggy_ill_typed") and r.get("fixed_well_typed")]
    same = [r for r in loc if r["similarity"] >= SAME]
    small = [r for r in same if len(r["mistake_lines"]) <= SMALL]
    if not loc:
        return "\n".join(out) + "\n"
    out += ["## Pairing\n",
            f"{len(loc):,} pairs were localized. In {len(loc) - len(same):,} of them the two versions share less "
            f"than {SAME:.0%} of their lines: FixJS pairs the functions of a file by their position, so when a "
            "commit adds, removes or reorders functions, the pair holds two different functions. Those are left "
            f"out below; {len(same):,} pairs remain, {len(small):,} of them small fixes (at most {SMALL} lines "
            "changed).\n",
            "## Localization\n",
            "The mistake lines are the lines the fix changed, ignoring whitespace (for a pure insertion, the "
            "lines around it). Top-1 / top-3 (%) by function size in tokens:\n",
            *_table([(s, [r for r in same if r["size"] == s]) for s in SIZES] + [("all", same)]),
            "", f"Small fixes (at most {SMALL} lines changed):\n",
            *_table([(s, [r for r in small if r["size"] == s]) for s in SIZES] + [("all", small)])]
    for name, g in (("all pairs", same), ("small fixes", small)):
        if g:
            out += ["", f"{name}: mean lines per function {_mean(g, 'lines'):.1f}, lines with constraints "
                    f"{_mean(g, 'blamable_lines'):.1f}, lines changed by the fix "
                    f"{sum(len(r['mistake_lines']) for r in g) / len(g):.1f}; pairs with a hint "
                    f"{sum(1 for r in g if r['hints'])}; median time {sorted(r['seconds'] for r in g)[len(g) // 2]:.1f} s."]
    return "\n".join(out) + "\n"


SAME = 0.5  # share of lines the two versions have in common; below, FixJS paired two different functions
SMALL = 3  # a small fix changes at most this many lines


def _mean(rows: list[dict], key: str) -> float:
    return sum(r[key] for r in rows) / len(rows)


def _table(groups: list[tuple[str, list[dict]]]) -> list[str]:
    out = ["| method | " + " | ".join(name for name, _ in groups) + " |", "|---|" + "---|" * len(groups)]
    for m in realworld.METHODS + ["random line (expected)"]:
        cells = []
        for _, g in groups:
            if not g:
                cells.append("–")
                continue
            if m.startswith("random"):
                t1, t3 = _mean(g, "random_top1"), _mean(g, "random_top3")
            else:
                t1 = sum(1 for r in g if (r[f"rank: {m}"] or 99) <= 1) / len(g)
                t3 = sum(1 for r in g if (r[f"rank: {m}"] or 99) <= 3) / len(g)
            cells.append(f"{100 * t1:.0f} / {100 * t3:.0f}")
        out.append(f"| {m} | " + " | ".join(cells) + " |")
    out.append("| (pairs) | " + " | ".join(str(len(g)) for _, g in groups) + " |")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["screen", "evaluate", "report"])
    ap.add_argument("data", type=Path, nargs="?", help="the FixJS checkout")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--sample", type=int, help="screen only a random sample of pairs")
    ap.add_argument("--max", type=int, help="localize at most this many pairs (random sample)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", type=Path, default=SCREEN, help="screening output")
    args = ap.parse_args()
    if args.command == "screen":
        screen(args.data, args.jobs, args.sample, args.seed, args.out)
    elif args.command == "evaluate":
        evaluate(args.data, args.jobs, args.max, args.seed)
    else:
        text = report()
        (RESULTS / "fixjs.md").write_text(text)
        print(text)


if __name__ == "__main__":
    main()
