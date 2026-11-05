"""Loading the typing constraints of a program (via `node infer.js --json`)."""

from __future__ import annotations

import json
import re
import subprocess
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .terms import ParseError, Term, Var, parse_term

REPO_ROOT = Path(__file__).resolve().parent.parent
INFER_JS = REPO_ROOT / "infer.js"
SOLVER_JS = REPO_ROOT / "solver.js"

_CALL = re.compile(r"^(plus|union|logical_union|index|tpl)\((.*)\)$")


@dataclass(frozen=True)
class Constraint:
    """One typing constraint, tagged with where it came from.

    kind is one of
      sub            lhs <= rhs        (unification / pattern constraint)
      plus           plus(a, b, r)     r = a + b (numeric addition or concatenation)
      union          union(a, b, r)    r = c ? a : b
      logical_union  logical_union(a, b, r)  r = a && b, a || b
      index          index(o, i, r)    r = o[i] with a computed key
      tpl            tpl(x)            x is interpolated in a template literal
    """

    id: int
    kind: str
    text: str
    args: tuple  # sub: (Term, Term); others: tuple of Var
    line: Optional[int]  # None for library constraints, which are hard
    source: str  # "program" | "library" | "none"
    node: Optional[str] = None  # AST node type that generated the constraint
    access: Optional[str] = None  # field constraints: read | write | literal
    field: Optional[str] = None
    col: Optional[int] = None  # position of that node (0-based column)
    end_line: Optional[int] = None
    end_col: Optional[int] = None
    stmt_line: Optional[int] = None  # innermost statement containing the node
    stmt_col: Optional[int] = None
    stmt_end_line: Optional[int] = None

    @property
    def hard(self) -> bool:
        return self.line is None


@dataclass
class Program:
    path: str
    source_lines: list[str]
    constraints: list[Constraint]
    parsed: bool = True
    unparsed: list[str] = field(default_factory=list)

    @property
    def hard(self) -> list[Constraint]:
        return [c for c in self.constraints if c.hard]

    def groups(self) -> "OrderedDict[int, list[Constraint]]":
        """Soft constraints grouped by source line (in line order)."""
        out: dict[int, list[Constraint]] = {}
        for c in self.constraints:
            if not c.hard:
                out.setdefault(c.line, []).append(c)
        return OrderedDict(sorted(out.items()))

    def line_text(self, line: int) -> str:
        if 1 <= line <= len(self.source_lines):
            return self.source_lines[line - 1]
        return ""


def parse_constraint(raw: dict) -> Constraint:
    text = raw["text"]
    kind = raw["kind"]
    if kind == "sub":
        lhs, rhs = text.split(" <= ", 1)
        args = (parse_term(lhs), parse_term(rhs))
    else:
        m = _CALL.match(text)
        if not m or m.group(1) != kind:
            raise ParseError(f"bad constraint {text!r}")
        args = tuple(Var(a.strip()) for a in m.group(2).split(","))
    source = raw.get("source", "none")
    line = raw.get("line") if source == "program" else None
    return Constraint(
        id=raw["id"],
        kind=kind,
        text=text,
        args=args,
        line=line,
        source=source,
        node=raw.get("node"),
        access=raw.get("access"),
        field=raw.get("field"),
        col=raw.get("col"),
        end_line=raw.get("endLine"),
        end_col=raw.get("endCol"),
        stmt_line=raw.get("stmtLine"),
        stmt_col=raw.get("stmtCol"),
        stmt_end_line=raw.get("stmtEndLine"),
    )


def program_from_json(data: dict, source_text: str, path: str = "<input>") -> Program:
    constraints, unparsed = [], []
    for raw in data["constraints"]:
        try:
            constraints.append(parse_constraint(raw))
        except ParseError:
            unparsed.append(raw["text"])
    return Program(
        path=path,
        source_lines=source_text.split("\n"),
        constraints=constraints,
        parsed=data.get("parsed", True),
        unparsed=unparsed,
    )


def run_infer(path: str | Path, timeout: float = 60, ignore_lines=None) -> dict:
    """Constraints of a program; with ignore_lines, as if those lines said nothing."""
    extra = ["--ignore-lines", ",".join(map(str, sorted(ignore_lines)))] if ignore_lines else []
    out = subprocess.run(
        ["node", str(INFER_JS), "--json", *extra, str(path)],
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=REPO_ROOT,
    )
    if out.returncode != 0:
        raise RuntimeError(f"infer.js failed on {path}: {out.stderr.strip()}")
    return json.loads(out.stdout)


def load_program(path: str | Path, timeout: float = 60) -> Program:
    data = run_infer(path, timeout)
    return program_from_json(data, Path(path).read_text(), str(path))


def load_source(source: str, tmpdir: str | Path | None = None, name: str = "input.js") -> Program:
    """Run the inferencer on a source string (written to a temporary file)."""
    import tempfile

    with tempfile.TemporaryDirectory(dir=tmpdir) as d:
        p = Path(d) / name
        p.write_text(source)
        data = run_infer(p)
    return program_from_json(data, source, name)


def run_solver_js(infer_json: dict, timeout: float = 60) -> dict:
    """The existing union-find solver (solver.js) on the same constraints.

    Returns {"conflicts": [{message, constraint, text, line}], "types": {...}}.
    The first conflict is what a first-conflict checker reports.
    """
    out = subprocess.run(
        ["node", str(SOLVER_JS), "--json"],
        input=json.dumps(infer_json),
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=REPO_ROOT,
    )
    if out.returncode != 0:
        raise RuntimeError(f"solver.js failed: {out.stderr.strip()}")
    return json.loads(out.stdout)
