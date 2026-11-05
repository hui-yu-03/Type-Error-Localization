"""Evaluation on real buggy programs: pairs of a buggy and a fixed version.

    python bench/realworld.py DIR [--out NAME]

DIR contains pairs NAME.buggy.js / NAME.fixed.js (e.g. a student's failed
submission and the next accepted one, or the two sides of a bug-fixing
commit).  The lines of the mistake are the lines of the buggy version that the
fix changes; for a pure insertion (missing code) the lines next to the
insertion point count as the mistake.

For every pair the script records whether the buggy version is ill-typed and
the fixed version well typed under the type system (otherwise the bug is not a
type error it can see), and ranks the mistake lines with the first-conflict
checkers, the MCS strategies, and the full pipeline (latest first with
re-inference and missing-code hints).  Results go to results/<NAME>.csv and
results/<NAME>.md.
"""

from __future__ import annotations

import argparse
import difflib
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))

import evaluate as ev  # noqa: E402
from localizer import baseline, rank  # noqa: E402
from localizer.repair import find_hints  # noqa: E402

METHODS = ["first conflict (solver.js)", "first conflict (SMT order)", "MCS card, latest first", "MCS learned",
           "full pipeline"]


def mistake_lines(buggy: str, fixed: str) -> list[int]:
    """Lines of the buggy version changed by the fix (1-based)."""
    a, b = buggy.split("\n"), fixed.split("\n")
    out: set[int] = set()
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag in ("replace", "delete"):
            out.update(range(i1 + 1, i2 + 1))
        elif tag == "insert":  # missing code: the neighbouring lines
            out.update(L for L in (i1, i1 + 1) if 1 <= L <= len(a))
    return sorted(out)


def _rank_in(lines: list[int], targets: list[int]):
    pos = [lines.index(t) + 1 for t in targets if t in lines]
    return min(pos) if pos else None


def evaluate_pair(name: str, buggy: str, fixed: str) -> dict:
    targets = mistake_lines(buggy, fixed)
    row = {"name": name, "mistake_lines": targets, "lines": buggy.count("\n") + 1}
    fixed_ok, _ = ev.is_clean(fixed)
    data = ev.infer_source(buggy)
    program = ev.program_from_json(data, buggy)
    enc = ev.encode(program)
    row["buggy_ill_typed"] = str(enc.check()) == "unsat"
    row["fixed_well_typed"] = fixed_ok
    js = ev.run_solver_js(data)
    row["solver_js_reports"] = bool(js["conflicts"])
    if not row["buggy_ill_typed"]:
        return row
    ranks = {
        "first conflict (solver.js)": _rank_in(baseline.solver_js_lines(js), targets),
        "first conflict (SMT order)": _rank_in(baseline.first_conflicts(enc, k=5), targets),
    }
    pool = rank.enumerate_pool(enc, None, "oll", min_count=10, hard_cap=40, timeout=60)
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "buggy.js"
        path.write_text(buggy)
        extra = rank.reinference_singletons(enc, pool, path)
        plain = rank.rank_from_pools(enc, pool)
        full = rank.rank_from_pools(enc, pool, None, extra)["card-late"]
        full.hints = find_hints(path, rank.top_lines(enc, full.candidates))
    best = lambda r: min((x for x in (r.rank_of(t) for t in targets) if x is not None), default=None)  # noqa: E731
    ranks["MCS card, latest first"] = best(plain["card-late"])
    ranks["MCS learned"] = best(plain["learned"])
    ranks["full pipeline"] = best(full)
    row.update({f"rank: {m}": ranks[m] for m in METHODS})
    row["hints"] = [[h.kind, h.line] for h in full.hints]
    return row


def report(rows: list[dict], name: str) -> str:
    seen = [r for r in rows if r.get("buggy_ill_typed")]
    both = [r for r in seen if r.get("fixed_well_typed")]
    lines = [f"# Real buggy programs: {name}\n", f"{len(rows)} pairs; the buggy version is ill-typed in {len(seen)}, "
             f"and the fixed version well typed in {len(both)} of those (type errors the type system sees).\n"]
    if both:
        lines += ["| method | top-1 (%) | top-3 (%) |", "|---|---|---|"]
        for m in METHODS:
            r1 = sum(1 for r in both if r[f"rank: {m}"] is not None and r[f"rank: {m}"] <= 1) / len(both)
            r3 = sum(1 for r in both if r[f"rank: {m}"] is not None and r[f"rank: {m}"] <= 3) / len(both)
            lines.append(f"| {m} | {100 * r1:.0f} | {100 * r3:.0f} |")
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dir", type=Path)
    ap.add_argument("--out", default="realworld")
    args = ap.parse_args()
    rows = []
    for buggy in sorted(args.dir.glob("*.buggy.js")):
        fixed = buggy.with_name(buggy.name.replace(".buggy.js", ".fixed.js"))
        if not fixed.exists():
            print(f"skipping {buggy.name}: no fixed version", file=sys.stderr)
            continue
        rows.append(evaluate_pair(buggy.name[: -len(".buggy.js")], buggy.read_text(), fixed.read_text()))
    from run_experiments import RESULTS, write_csv

    write_csv(RESULTS / f"{args.out}.csv", rows)
    text = report(rows, args.out)
    (RESULTS / f"{args.out}.md").write_text(text)
    print(text)


if __name__ == "__main__":
    main()
