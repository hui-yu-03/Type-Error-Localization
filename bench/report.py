"""Tables and plots from the experiment results.

    python bench/report.py      # reads results/*.csv, writes results/summary.md and results/*.png
"""

from __future__ import annotations

import csv
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "results"

OPS = ["literal", "swap-args", "misspell-prop", "missing-await", "wrong-var", "remove-return"]
METHODS = [
    ("rank_first_conflict_js", "first conflict (solver.js)"),
    ("rank_first_conflict_smt", "first conflict (SMT order)"),
    ("random", "MCS card, random ties"),
    ("rank_card", "MCS card, earliest first"),
    ("rank_card-late", "MCS card, latest first"),
    ("rank_card-size", "MCS card, then size"),
    ("rank_size", "MCS size-weighted"),
    ("rank_pareto", "MCS Pareto (card, size)"),
]

# reference palette (light): categorical slots 1-3, ordinal blue pair, chrome
SERIES = ["#2a78d6", "#eb6834", "#1baf7a"]
ORDINAL = {"top1": "#1c5cab", "top3": "#86b6ef"}
INK, INK2, MUTED, GRID, AXIS, SURFACE = "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7", "#fcfcfb"


def load(name: str) -> list[dict]:
    p = RESULTS / f"{name}.csv"
    if not p.exists():
        return []
    rows = list(csv.DictReader(p.open()))
    for r in rows:
        for k, v in list(r.items()):
            if v in ("", None):
                r[k] = None
            elif v in ("True", "False"):
                r[k] = v == "True"
            else:
                try:
                    r[k] = json.loads(v)
                except (ValueError, TypeError):
                    pass
    return rows


def pct(x: float | None) -> str:
    return "–" if x is None else f"{100 * x:.0f}"


def frac(rows, pred) -> float | None:
    return sum(1 for r in rows if pred(r)) / len(rows) if rows else None


def topk(rows: list[dict], key: str, k: int) -> float | None:
    if not rows:
        return None
    if key == "random":
        vals = [r.get(f"random_top{k}") for r in rows]
        vals = [0.0 if v is None else v for v in vals]
        return sum(vals) / len(vals)
    return frac(rows, lambda r: r.get(key) is not None and r[key] <= k)


def table(header: list[str], body: list[list[str]]) -> str:
    out = ["| " + " | ".join(header) + " |", "|" + "|".join(["---"] * len(header)) + "|"]
    out += ["| " + " | ".join(row) + " |" for row in body]
    return "\n".join(out)


# -- single-mistake corpora ------------------------------------------------------
def detection_table(rows: list[dict]) -> str:
    by: dict = defaultdict(lambda: defaultdict(list))
    for r in rows:
        by[r["op"]][r["setting"]].append(r)
    body = []
    tot = defaultdict(int)
    for op in OPS + ["all"]:
        if op == "all":
            o = [r for r in rows if r["setting"] == "open"]
            c = [r for r in rows if r["setting"] == "closed"]
        else:
            if op not in by:
                continue
            o, c = by[op]["open"], by[op]["closed"]
        body.append([
            f"**{op}**" if op == "all" else op,
            str(len(o)),
            str(sum(1 for r in o if r.get("js_detected"))),
            str(sum(1 for r in o if r.get("detected"))),
            str(sum(1 for r in c if r.get("detected"))) + (f" / {len(c)}" if len(c) != len(o) else ""),
        ])
    return table(["mistake", "mutants", "type error: solver.js", "type error: SMT", "type error: SMT + closed fields"], body)


def q1_table(rows: list[dict]) -> str:
    det = [r for r in rows if r["setting"] == "open" and r.get("detected")]
    body = []
    for op in OPS + ["all"]:
        rs = det if op == "all" else [r for r in det if r["op"] == op]
        if not rs:
            continue
        ties = [r["n_min_mcs"] for r in rs if r.get("n_min_mcs") is not None]
        body.append([
            f"**{op}**" if op == "all" else op,
            str(len(rs)),
            pct(frac(rs, lambda r: r.get("target_is_correction"))),
            pct(frac(rs, lambda r: r.get("target_in_min_mcs"))),
            pct(frac(rs, lambda r: r.get("n_min_mcs") == 1)),
            f"{statistics.mean(ties):.1f}" if ties else "–",
            f"{statistics.mean([r['min_mcs_size'] for r in rs if r.get('min_mcs_size') is not None]):.2f}",
        ])
    return table(
        ["mistake", "ill-typed", "mistake line alone is a correction subset (%)", "mistake line in a smallest MCS (%)",
         "smallest MCS unique (%)", "smallest MCSs (mean #)", "size of smallest MCS (mean)"],
        body,
    )


def topk_table(rows: list[dict], setting: str = "open") -> str:
    det = [r for r in rows if r["setting"] == setting and r.get("detected")]
    header = ["method"] + [op for op in OPS if any(r["op"] == op for r in det)] + ["**all**"]
    body = []
    for key, label in METHODS:
        row = [label]
        for op in header[1:]:
            rs = det if op == "**all**" else [r for r in det if r["op"] == op]
            row.append(f"{pct(topk(rs, key, 1))} / {pct(topk(rs, key, 3))}")
        body.append(row)
    counts = ["(ill-typed mutants)"] + [
        str(len(det if op == "**all**" else [r for r in det if r["op"] == op])) for op in header[1:]
    ]
    body.append(counts)
    return table(header, body)


def closed_table(rows: list[dict]) -> str:
    body = []
    for op in ("misspell-prop", "all"):
        for setting in ("open", "closed"):
            rs = [r for r in rows if r["setting"] == setting and (op == "all" or r["op"] == op)]
            det = [r for r in rs if r.get("detected")]
            body.append([op, setting, str(len(rs)), str(len(det)),
                         f"{pct(topk(det, 'rank_card-late', 1))} / {pct(topk(det, 'rank_card-late', 3))}",
                         f"{pct(topk(det, 'rank_first_conflict_smt', 1))} / {pct(topk(det, 'rank_first_conflict_smt', 3))}"])
    return table(["mistakes", "fields", "mutants", "ill-typed", "MCS card, latest first: top-1 / top-3 (%)",
                  "first conflict (SMT): top-1 / top-3 (%)"], body)


# -- several mistakes --------------------------------------------------------------
def multi_table(rows: list[dict]) -> str:
    body = []
    for k in sorted({r["k"] for r in rows}):
        rs = [r for r in rows if r["k"] == k]
        det = [r for r in rs if r.get("detected")]
        if not det:
            continue
        m = lambda key: f"{statistics.mean([r[key] for r in det]):.2f}"  # noqa: E731
        body.append([str(k), str(len(rs)), str(len(det)), m("first_mcs_size"), pct(statistics.mean([r["first_mcs_precision"] for r in det])),
                     pct(statistics.mean([r["first_mcs_recall"] for r in det])), pct(statistics.mean([r["topk_recall"] for r in det])),
                     pct(statistics.mean([r["first_conflict_topk_recall"] for r in det]))])
    return table(["mistakes k", "programs", "ill-typed", "size of first MCS", "first MCS precision (%)", "first MCS recall (%)",
                  "MCS ranking: mistakes in top-k lines (%)", "first conflicts: mistakes in first k blamed lines (%)"], body)


# -- scaling -------------------------------------------------------------------------
def scaling_table(rows: list[dict]) -> str:
    algs = [a for a in ("oll", "ihs", "z3", "oll-nomin", "ihs-nomin") if any(r["algorithm"] == a for r in rows)]
    body = []
    for size in sorted({r["size"] for r in rows}):
        for k in sorted({r["k"] for r in rows}):
            rs = [r for r in rows if r["size"] == size and r["k"] == k]
            if not rs:
                continue
            cons = statistics.median([r["constraints"] for r in rs if r["algorithm"] == "oll"] or [0])
            costs = [r["cost"] for r in rs if r["algorithm"] == "oll" and r.get("cost") is not None]
            cells = [str(size), str(k), f"{cons:.0f}", f"{statistics.mean(costs):.1f}" if costs else "–"]
            for a in algs:
                ar = [r for r in rs if r["algorithm"] == a]
                if not ar:
                    cells.append("")
                    continue
                t = statistics.median([r["time"] for r in ar])
                to = sum(1 for r in ar if r["status"] == "timeout")
                calls = statistics.median([r["sat_calls"] for r in ar])
                cells.append(f"{t:.1f} s ({calls:.0f})" + (f" {to}×TO" if to else ""))
            body.append(cells)
    names = {"oll": "OLL", "ihs": "IHS", "z3": "Z3 maxres", "oll-nomin": "OLL, no core min.", "ihs-nomin": "IHS, no core min."}
    return table(["lines", "mistakes", "constraints", "smallest MCS (mean)"] + [f"{names[a]}: median time (SAT calls)" for a in algs], body)


# -- plots ---------------------------------------------------------------------------
def _style(ax) -> None:
    ax.set_facecolor(SURFACE)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color(AXIS)
    ax.tick_params(colors=INK2, labelsize=9)
    ax.grid(True, color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)


def plot_scaling(rows: list[dict]) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    ks = sorted({r["k"] for r in rows})
    algs = [("oll", "OLL"), ("ihs", "IHS"), ("z3", "Z3 maxres")]
    fig, axes = plt.subplots(1, len(ks), figsize=(4.2 * len(ks), 3.6), sharey=True, facecolor=SURFACE)
    axes = [axes] if len(ks) == 1 else axes
    for ax, k in zip(axes, ks):
        _style(ax)
        for (a, label), color in zip(algs, SERIES):
            pts = []
            for size in sorted({r["size"] for r in rows}):
                ts = [r["time"] for r in rows if r["k"] == k and r["size"] == size and r["algorithm"] == a]
                if ts:
                    pts.append((size, statistics.median(ts)))
            if not pts:
                continue
            xs, ys = zip(*pts)
            ax.plot(xs, ys, color=color, linewidth=2, marker="o", markersize=5,
                    markeredgecolor=SURFACE, markeredgewidth=1.5, label=label)
            ax.annotate(label, (xs[-1], ys[-1]), textcoords="offset points", xytext=(6, 0), va="center",
                        fontsize=8.5, color=INK2)
        ax.set_xscale("log")
        ax.set_yscale("log")
        ax.set_title(f"{k} injected mistake{'s' if k > 1 else ''}", fontsize=10, color=INK, loc="left")
        ax.set_xlabel("program size (lines)", fontsize=9, color=INK2)
        ax.margins(x=0.25)
    axes[0].set_ylabel("time to first smallest MCS (s, median)", fontsize=9, color=INK2)
    axes[0].legend(frameon=False, fontsize=8.5, loc="upper left", labelcolor=INK2)
    fig.tight_layout()
    fig.savefig(RESULTS / "scaling.png", dpi=200, facecolor=SURFACE)
    plt.close(fig)


def plot_topk(corpora: list[tuple[str, list[dict]]]) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    corpora = [(n, rs) for n, rs in corpora if rs]
    if not corpora:
        return
    fig, axes = plt.subplots(1, len(corpora), figsize=(5.2 * len(corpora), 3.9), sharey=True, facecolor=SURFACE)
    axes = [axes] if len(corpora) == 1 else axes
    labels = [label for _, label in METHODS]
    for ax, (name, rows) in zip(axes, corpora):
        _style(ax)
        ax.grid(True, axis="x", color=GRID, linewidth=0.6)
        ax.grid(False, axis="y")
        det = [r for r in rows if r["setting"] == "open" and r.get("detected")]
        y = list(range(len(METHODS)))[::-1]
        t1 = [100 * topk(det, key, 1) for key, _ in METHODS]
        t3 = [100 * topk(det, key, 3) for key, _ in METHODS]
        ax.barh(y, t3, height=0.62, color=ORDINAL["top3"], label="top-3", edgecolor=SURFACE, linewidth=1)
        ax.barh(y, t1, height=0.62, color=ORDINAL["top1"], label="top-1", edgecolor=SURFACE, linewidth=1)
        for yi, a, b in zip(y, t1, t3):
            ax.text(a - 1.5, yi, f"{a:.0f}", va="center", ha="right", fontsize=8, color="#ffffff")
            ax.text(b + 1.5, yi, f"{b:.0f}", va="center", ha="left", fontsize=8, color=INK2)
        ax.set_yticks(y)
        ax.set_yticklabels(labels, fontsize=9, color=INK)
        ax.set_xlim(0, 112)
        ax.set_xlabel("mistake line ranked first / in top 3 (%)", fontsize=9, color=INK2)
        ax.set_title(f"{name} ({len(det)} ill-typed mutants)", fontsize=10, color=INK, loc="left")
    axes[-1].legend(frameon=False, fontsize=8.5, loc="lower right", labelcolor=INK2)
    fig.tight_layout()
    fig.savefig(RESULTS / "topk.png", dpi=200, facecolor=SURFACE)
    plt.close(fig)


def main() -> None:
    parts = ["# Experiment results\n", "Generated by `python bench/report.py` from the CSV files in this directory.\n"]
    corpora = []
    for name, title in (("mutants", "Test-suite programs (one mistake each)"), ("generated", "Generated programs, 60 lines (one mistake each)")):
        rows = [r for r in load(name) if not r.get("error")]
        corpora.append((title.split(" (")[0], rows))
        if not rows:
            continue
        parts.append(f"## {title}\n")
        parts.append("### Which mutants are type errors\n\n" + detection_table(rows) + "\n")
        parts.append("### Q1: does a smallest correction subset contain the mistake?\n\n" + q1_table(rows) + "\n")
        parts.append("### Q2: rank of the mistake line, top-1 / top-3 (%)\n\n" + topk_table(rows) + "\n")
        parts.append("### Closed-world fields\n\n" + closed_table(rows) + "\n")
    multi = [r for r in load("multi") if not r.get("error")]
    if multi:
        parts.append("## Several mistakes (generated programs, 200 lines)\n\n" + multi_table(multi) + "\n")
    scaling = [r for r in load("scaling") if not r.get("error")]
    if scaling:
        parts.append("## Q3: scaling\n\n" + scaling_table(scaling) + "\n")
        plot_scaling([r for r in scaling if r["algorithm"] in ("oll", "ihs", "z3")])
    plot_topk(corpora)
    (RESULTS / "summary.md").write_text("\n".join(parts))
    print((RESULTS / "summary.md").read_text())


if __name__ == "__main__":
    sys.exit(main())
