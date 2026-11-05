"""Command line: python -m localizer program.js [options]

Prints whether the program is well typed; if not, a ranked list of suspicious
lines computed from smallest correction subsets, and the line a first-conflict
checker (solver.js) would blame.
"""

from __future__ import annotations

import argparse
import json
import sys

import z3

from . import baseline, rank
from .constraints import load_program, run_infer, program_from_json, run_solver_js
from .encode import GROUPINGS, describe_types, encode
from .mcs import ALGORITHMS, HardConflict
from pathlib import Path


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m localizer", description=__doc__.split("\n\n")[0])
    ap.add_argument("file", help="JavaScript source file")
    ap.add_argument("--strategy", choices=rank.STRATEGIES, default="card-late",
                    help="ranking strategy (default: card-late, the best single rule in the experiments)")
    ap.add_argument("--algorithm", choices=sorted(ALGORITHMS), default="oll", help="MCS algorithm (default: oll)")
    ap.add_argument("--top", type=int, default=5, help="number of suspicious lines to show")
    ap.add_argument("--candidates", type=int, default=10, help="number of correction subsets to enumerate")
    ap.add_argument("--closed-fields", action="store_true", help="reading an undefined field of an object literal is an error")
    ap.add_argument("--plus", choices=("strict", "lenient"), default="strict", help="typing rule for +")
    ap.add_argument("--group-by", choices=GROUPINGS, default="line",
                    help="unit of blame: source line (default), statement, or AST node")
    ap.add_argument("--reinfer", action="store_true",
                    help="also check candidate lines by re-running inference without them")
    ap.add_argument("--no-hints", action="store_true",
                    help="do not look for missing code (a forgotten return or await)")
    ap.add_argument("--timeout", type=float, default=60.0, help="seconds")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args(argv)

    data = run_infer(args.file)
    program = program_from_json(data, Path(args.file).read_text(), args.file)
    enc = encode(program, plus=args.plus, closed_fields=args.closed_fields, group_by=args.group_by)
    result = {"file": args.file, "lines": len(enc.lines), "constraints": len(program.constraints)}

    s = enc.solver(timeout_ms=int(args.timeout * 1000))
    status = s.check(*enc.selectors.values())
    if status == z3.sat:
        result["well_typed"] = True
        result["types"] = describe_types(enc, s.model(), solver=s)
        if args.json:
            print(json.dumps(result, indent=2))
        else:
            print(f"{args.file}: well typed. One typing (a model of the constraints):")
            width = max((len(n) for n in result["types"]), default=0)
            for n, t in result["types"].items():
                print(f"  {n.ljust(width)} : {t}")
        return 0
    if status != z3.unsat:
        print(f"{args.file}: solver gave up ({status})", file=sys.stderr)
        return 2

    result["well_typed"] = False
    try:
        ranking = rank.rank(enc, args.strategy, args.algorithm, min_count=args.candidates, timeout=args.timeout,
                            path=args.file, reinfer=args.reinfer, hints=not args.no_hints,
                            options={"plus": args.plus, "closed_fields": args.closed_fields})
    except HardConflict:
        print(f"{args.file}: the library signatures alone are contradictory", file=sys.stderr)
        return 2
    js = run_solver_js(data)
    result.update(
        strategy=args.strategy,
        algorithm=args.algorithm,
        candidates=[{"groups": [list(enc.span[g]) for g in c.lines], "size": c.size} for c in ranking.candidates],
        suspicious_lines=ranking.lines[: args.top],
        hints=[{"kind": h.kind, "line": h.line, "edit": h.description} for h in ranking.hints],
        first_conflict_solver_js=baseline.solver_js_lines(js)[:1],
    )
    if args.json:
        print(json.dumps(result, indent=2))
        return 1

    print(f"{args.file}: type error.")
    if ranking.hints:
        print("\nLikely missing code (this edit makes the program well typed):")
        for h in ranking.hints:
            print(f"  line {h.line:<4} {h.description}")
    def where(g) -> str:
        if args.group_by == "node":
            return f"{g[0]}:{g[1] + 1}"
        a, b = enc.span[g]
        return f"{a}" if a == b else f"{a}-{b}"

    def code(g) -> str:
        text = program.line_text(enc.line_of(g))
        if args.group_by == "node" and g[2] == g[0]:
            text = text[g[1] : g[3]]  # the expression itself
        return text.strip()[:58]

    print(f"\nSuspicious lines ({args.strategy}, {args.algorithm}):")
    ranks = rank.line_ranks(ranking.candidates)
    for g in ranking.groups[: args.top]:
        cand = next(i for i, c in enumerate(ranking.candidates, 1) if g in c.lines)
        print(f"  {ranks[g] + len(ranking.hint_lines):>2}. line {where(g):<6} {code(g):<58}  (candidate #{cand})")
    unit = {"line": "line", "statement": "statement", "node": "expression"}[args.group_by]
    print(f"\nCorrection subsets (dropping the constraints of these {unit}s makes the rest typable):")
    for i, c in enumerate(ranking.candidates[: max(args.top, 3)], 1):
        print(f"  #{i:<2} {{{', '.join(where(g) for g in c.lines)}}}  ({c.card} {unit}(s), {c.size} constraint(s))")
    if not ranking.complete:
        print("  (enumeration cut short)")
    fc = result["first_conflict_solver_js"]
    print(f"\nA first-conflict checker (solver.js) blames: line {fc[0] if fc else '?'}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
