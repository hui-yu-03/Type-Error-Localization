"""Evaluation on BugsJS: real, test-validated bugs of ten Node.js projects.

    python bench/bugsjs.py fetch WORK      # git: the buggy and the fixed version of every bug
    python bench/bugsjs.py extract WORK    # the functions each fix changes, as buggy/fixed pairs
    python bench/realworld.py WORK/pairs --out bugsjs [--relaxed]

BugsJS (Gyimesi et al., ICST 2019) has 453 bugs of ten server-side JavaScript
projects; each bug is a tag Bug-N (the buggy revision) and Bug-N-fix (the same
with only the source fix applied) in the project's repository under
github.com/BugsJS.
For every JavaScript file the fix modifies, the innermost function of the buggy
version that contains a changed hunk is paired with the innermost function of
the fixed version that contains the hunk's counterpart.  Each function is
written as a program of its own (an anonymous function becomes the initializer
of a constant, as in bench/fixjs.py), so line numbers are function-relative.
"""

from __future__ import annotations

import argparse
import difflib
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))

PROJECTS = ["bower", "eslint", "express", "hessian.js", "hexo", "karma", "mongoose", "node_redis", "pencilblue",
            "shields"]


def git(repo: Path, *args: str, check: bool = True) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=check).stdout


def bugs_of(project: str) -> list[int]:
    out = subprocess.run(["git", "ls-remote", "--tags", f"https://github.com/BugsJS/{project}"],
                         capture_output=True, text=True).stdout
    tags = {line.split("refs/tags/")[1] for line in out.splitlines() if "refs/tags/" in line}
    return sorted(int(t.split("-")[1]) for t in tags if t.count("-") == 1 and f"{t}-fix" in tags)


def fetch(work: Path) -> None:
    for project in PROJECTS:
        repo = work / f"{project}.git"
        bugs = bugs_of(project)
        print(f"{project}: {len(bugs)} bugs", flush=True)
        if not bugs:
            continue
        if not repo.exists():
            subprocess.run(["git", "init", "-q", "--bare", str(repo)], check=True)
            git(repo, "remote", "add", "origin", f"https://github.com/BugsJS/{project}")
        refs = [f"refs/tags/{t}:refs/tags/{t}" for n in bugs for t in (f"Bug-{n}", f"Bug-{n}-fix")]
        for i in range(0, len(refs), 40):
            git(repo, "fetch", "-q", "--depth", "1", "origin", *refs[i:i + 40])


def functions(text: str) -> list[dict]:
    import tempfile

    with tempfile.NamedTemporaryFile("w", suffix=".js") as f:
        f.write(text)
        f.flush()
        out = subprocess.run(["node", str(HERE / "functions.js"), f.name], capture_output=True, text=True)
    try:
        return json.loads(out.stdout or "[]")
    except json.JSONDecodeError:
        return []


def innermost(fns: list[dict], lo: int, hi: int):
    inside = [f for f in fns if f["start"] <= lo and hi <= f["end"]]
    return min(inside, key=lambda f: f["end"] - f["start"]) if inside else None


def as_program(text: str, fn: dict) -> str:
    """The function's lines as a program; an anonymous function (or method) is
    the initializer of a constant, on the same first line."""
    body = "\n".join(text.split("\n")[fn["start"] - 1:fn["end"]])
    head = body.lstrip()
    import re

    if re.match(r"(async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(", head):
        return body
    start = len(body) - len(head)
    m = re.match(r"(?:[\w$.]+\s*[:=]\s*|(?:static\s+|async\s+|get\s+|set\s+)*(?=[\w$]+\s*\())", head)
    if m and head[m.end():].lstrip().startswith(("function", "(", "async")):
        return body[:start] + "const __bugsjs = " + head[m.end():].lstrip()
    if re.match(r"[\w$]+\s*\(", head):  # a method: name(args) { ... }
        return body[:start] + "const __bugsjs = function " + head
    if head.startswith(("function", "(", "async")):
        return body[:start] + "const __bugsjs = " + head
    return ""


def extract(work: Path) -> None:
    pairs_dir = work / "pairs"
    pairs_dir.mkdir(parents=True, exist_ok=True)
    count = 0
    for project in PROJECTS:
        repo = work / f"{project}.git"
        if not repo.exists():
            continue
        tags = git(repo, "tag").split()
        bugs = sorted(int(t.split("-")[1]) for t in tags if t.count("-") == 1 and f"{t}-fix" in tags)
        for n in bugs:
            a, b = f"Bug-{n}", f"Bug-{n}-fix"
            files = [f for f in git(repo, "diff", "--name-only", "--diff-filter=M", a, b, "--", "*.js").split()
                     if "test" not in f.lower()]
            for path in files:
                before = git(repo, "show", f"{a}:{path}", check=False)
                after = git(repo, "show", f"{b}:{path}", check=False)
                fb, fa = functions(before), functions(after)
                norm = lambda t: [" ".join(x.split()) for x in t.split("\n")]  # noqa: E731 - whitespace does not count
                matcher = difflib.SequenceMatcher(None, norm(before), norm(after), autojunk=False)
                seen = set()
                for tag, i1, i2, j1, j2 in matcher.get_opcodes():
                    if tag == "equal":
                        continue
                    g = innermost(fb, i1 + 1, max(i2, i1 + 1))
                    h = innermost(fa, j1 + 1, max(j2, j1 + 1))
                    if not g or not h or (g["start"], g["end"]) in seen:
                        continue
                    seen.add((g["start"], g["end"]))
                    buggy, fixed = as_program(before, g), as_program(after, h)
                    if not buggy or not fixed or buggy == fixed:
                        continue
                    name = f"{project}-{n}-{Path(path).stem}-{g['start']}"
                    (pairs_dir / f"{name}.buggy.js").write_text(buggy)
                    (pairs_dir / f"{name}.fixed.js").write_text(fixed)
                    count += 1
        print(f"{project}: {count} function pairs so far", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["fetch", "extract"])
    ap.add_argument("work", type=Path)
    args = ap.parse_args()
    args.work.mkdir(parents=True, exist_ok=True)
    (fetch if args.command == "fetch" else extract)(args.work)


if __name__ == "__main__":
    main()
