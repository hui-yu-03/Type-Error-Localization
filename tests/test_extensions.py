"""Tests of the extensions: inference worker, relaxed type system, block scopes,
explanations, the tie question, the language server, per-part solving, and the
helpers of the real-data benchmarks."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest
import z3

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "bench"))

from localizer import constraints as C  # noqa: E402
from localizer import parallel, rank  # noqa: E402
from localizer.constraints import program_from_json, run_infer  # noqa: E402
from localizer.encode import encode  # noqa: E402
from localizer.explain import explain, question  # noqa: E402
from localizer.slicing import slice_to_conflicts  # noqa: E402
from localizer import mcs  # noqa: E402


def _program(source: str, relaxed=False):
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "p.js"
        p.write_text(source)
        data = run_infer(p, relaxed=relaxed)
    return program_from_json(data, source)


def _ill_typed(source: str, relaxed=False) -> bool:
    rules = set(C.DEFAULT_RELAX_RULES) if relaxed is True else set(relaxed or ())
    return encode(_program(source, rules), relaxed=rules - set(C.INFER_RELAX_RULES)).check() == z3.unsat


# -- inference worker ----------------------------------------------------------
@pytest.mark.parametrize("name", ["examples/promise.js", "Tests/Require/require_3.js", "Tests/Type_Methods/str_2.js"])
def test_worker_output_is_identical(name):
    w = C._InferWorker()
    try:
        for args in (["--json", name], [name], ["--json", "--ignore-lines", "1", name]):
            a = subprocess.run(["node", "infer.js", *args], capture_output=True, text=True, cwd=ROOT)
            assert w.run(args, 60)[:2] == (a.returncode, a.stdout)
    finally:
        w.close()


# -- relaxed type system -------------------------------------------------------
REAL = """function f(x) {
  if (!x) return;
  $.ajax({ url: x });
  $("#a").html("b");
  var arr = [1, 2];
  arr.length = 0;
  return x.length + 1;
}
"""


def test_relaxed_accepts_common_javascript():
    assert _ill_typed(REAL)
    assert not _ill_typed(REAL, relaxed=True)


@pytest.mark.parametrize("name", ["examples/promise.js", "examples/missing_return.js", "examples/missing_await.js"])
def test_relaxed_still_finds_the_examples(name):
    assert _ill_typed((ROOT / name).read_text(), relaxed=True)


def test_relaxed_comparison_of_two_primitive_types_is_an_error():
    # the precedence bug of a real FixJS commit: !x === "object" compares a boolean with a string
    assert _ill_typed('function f(r) { if (!typeof r === "object") return 1; return 2; }', relaxed=True)
    with_compare = set(C.DEFAULT_RELAX_RULES) | {"compare"}
    assert _ill_typed('function f(r) { if (!typeof r === "object") return 1; return 2; }', relaxed=with_compare)
    assert not _ill_typed('function f(r) { if (true === r) return r.responses; return 0; }', relaxed=with_compare)


def test_relaxed_members_keep_typos_checked():
    src = "function f(xs) { const n = xs.lenght; return xs.map(x => x + 1); }\n"
    assert _ill_typed(src, relaxed=True)  # lenght is a typo of length: checked
    assert not _ill_typed("function f(el) { el.addClass('x'); return el.map(x => x + 1); }\n", relaxed=True)


def test_relaxed_rules_are_switchable():
    src = "function f() { return $.ajax('/x'); }\nconst y = f;\n"
    assert not _ill_typed(src, relaxed={"globals"})
    with pytest.raises(ValueError):
        C.set_relaxed({"no such rule"})
    C.set_relaxed(False)


# -- block scopes ----------------------------------------------------------------
def test_block_scoped_let_gets_its_own_type():
    src = ('for (let i = 0; i < 3; i++) { console.log(i * 2); }\n'
           'for (let i of ["a", "b"]) { console.log(i.toUpperCase()); }\n'
           'let x = 1;\n{ let x = "s"; console.log(x.length); }\nconst y = x + 1;\n')
    assert not _ill_typed(src)


# -- explanations and the tie question ----------------------------------------
def _ranking(path: str):
    src = (ROOT / path).read_text()
    enc = encode(_program(src))
    return enc, rank.rank(enc, "card-late", "oll", path=ROOT / path, hints=False)


def test_explanation_names_the_clashing_types():
    enc, r = _ranking("examples/promise.js")
    text = " ".join(explain(enc, r.candidates[0].lines))
    assert "p Promise<str" in text and "needs Promise<num" in text


def test_question_separates_tied_candidates():
    enc, r = _ranking("examples/missing_await.js")
    q = question(enc, r.candidates[0].lines, r.candidates[1].lines)
    assert q is not None and q["variable"] == "w"
    assert {q["if_first"], q["if_second"]} == {"num", "Promise<num, ?>"}


# -- language server ------------------------------------------------------------
def test_language_server_reports_and_clears():
    p = subprocess.Popen([sys.executable, "-m", "localizer.lsp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         cwd=ROOT)

    def send(m):
        b = json.dumps(m).encode()
        p.stdin.write(f"Content-Length: {len(b)}\r\n\r\n".encode() + b)
        p.stdin.flush()

    def recv():
        n = None
        while True:
            line = p.stdout.readline().decode().strip()
            if not line:
                break
            if line.lower().startswith("content-length"):
                n = int(line.split(":")[1])
        return json.loads(p.stdout.read(n))

    try:
        send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        assert recv()["id"] == 1
        text = (ROOT / "examples/promise.js").read_text()
        send({"jsonrpc": "2.0", "method": "textDocument/didOpen",
              "params": {"textDocument": {"uri": "file:///p.js", "languageId": "javascript", "version": 1, "text": text}}})
        diags = recv()["params"]["diagnostics"]
        assert diags[0]["range"]["start"]["line"] == 0 and diags[0]["severity"] == 1
        send({"jsonrpc": "2.0", "method": "textDocument/didChange",
              "params": {"textDocument": {"uri": "file:///p.js", "version": 2},
                         "contentChanges": [{"text": text.replace('"42"', "42")}]}})
        assert recv()["params"]["diagnostics"] == []
        send({"jsonrpc": "2.0", "id": 2, "method": "shutdown"})
        recv()
        send({"jsonrpc": "2.0", "method": "exit"})
        assert p.wait(30) == 0
    finally:
        p.kill()


# -- per-part solving --------------------------------------------------------------
def test_parts_give_the_same_smallest_cost():
    import evaluate as ev
    from generate import generate

    src = generate(400, 3, modules=4)
    with tempfile.TemporaryDirectory() as d:
        base = Path(d) / "base.js"
        base.write_text(src)
        m = ev.sample_mistakes(str(base), 3, 2)
    bad = ev.apply_mistakes(src, m["mistakes"])
    prog = _program(bad)
    enc, _ = slice_to_conflicts(encode(prog))
    joint = next(iter(mcs.make("oll", enc).enumerate(limit=1)))
    parallel._cache.clear()
    lines, cost, _ = parallel.smallest_mcs(prog, jobs=2)
    assert cost == joint.cost
    assert len(lines) == len(joint.lines)


# -- helpers of the real-data benchmarks -------------------------------------------
def test_wrap_keeps_line_numbers():
    import fixjs

    assert fixjs.wrap("function(a) {\n  return a;\n}") == "const __fixjs = function(a) {\n  return a;\n}"
    assert fixjs.wrap("function f(a) {}") == "function f(a) {}"
    assert fixjs.wrap("get x() { return 1; }") is None


def test_mistake_lines_ignore_whitespace():
    import realworld

    assert realworld.mistake_lines("a\n  b\nc", "a\n\tb\nc") == []
    assert realworld.mistake_lines("a\nb\nc", "a\nB\nc") == [2]
