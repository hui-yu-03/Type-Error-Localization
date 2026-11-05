"""Tests for the SMT-based localizer (run: python -m pytest tests)."""

from __future__ import annotations

import glob
from pathlib import Path

import pytest
import z3

from localizer import baseline, mcs, rank
from localizer.constraints import REPO_ROOT, load_program, load_source, program_from_json, run_infer, run_solver_js
from localizer.encode import encode
from localizer.terms import Arr, Base, Func, Klass, Obj, Prom, Var, parse_term

PROPOSAL_EXAMPLE = """const p = Promise.resolve("42");
const a = p.then(s => s * 2);
const b = p.then(t => t - 1);
"""

TEST_PROGRAMS = sorted(glob.glob(str(REPO_ROOT / "Tests" / "**" / "*.js"), recursive=True))


# -- terms ---------------------------------------------------------------------
def test_parse_terms():
    assert parse_term("T1") == Var("T1")
    assert parse_term("str|regexp") == Base(("regexp", "str"))
    assert parse_term("{}") == Obj(())
    assert parse_term("{a: T1, b: {c: num}}") == Obj((("a", Var("T1")), ("b", Obj((("c", Base(("num",))),)))))
    assert parse_term("Array<{}>") == Arr(Obj(()))
    assert parse_term("Promise<T2,T3>") == Prom(Var("T2"), Var("T3"))
    assert parse_term("Func<f__global>{() -> ret__f__global}") == Func("f__global", (), Var("ret__f__global"))
    assert parse_term("Func<arr_sort_cb>{T1 -> T2 -> T3}") == Func("arr_sort_cb", (Var("T1"), Var("T2")), Var("T3"))
    k = parse_term("Obj<Foo>[x: T1, m: void -> ret__m__Foo]")
    assert k == Klass("Obj", "Foo", (("x", (Var("T1"),)), ("m", (Base(("void",)), Var("ret__m__Foo")))))


# -- encoding ------------------------------------------------------------------
@pytest.mark.parametrize("path", TEST_PROGRAMS, ids=lambda p: str(Path(p).relative_to(REPO_ROOT)))
def test_agrees_with_solver_js(path):
    """The encoding is satisfiable exactly when solver.js finds no conflict."""
    data = run_infer(path)
    program = program_from_json(data, Path(path).read_text(), path)
    assert not program.unparsed
    smt_ok = encode(program).check() == z3.sat
    js_ok = not run_solver_js(data)["conflicts"]
    assert smt_ok == js_ok


def test_constraints_have_lines():
    program = load_source(PROPOSAL_EXAMPLE)
    assert sorted(program.groups()) == [1, 2, 3]
    assert all(c.line in (1, 2, 3) for c in program.constraints)


# -- correction subsets ------------------------------------------------------------
@pytest.mark.parametrize("algorithm", sorted(mcs.ALGORITHMS))
def test_proposal_example(algorithm):
    enc = encode(load_source(PROPOSAL_EXAMPLE))
    assert enc.check() == z3.unsat
    found = [(m.sorted(), m.cost) for m in mcs.make(algorithm, enc).enumerate()]
    assert found == [([1], 1), ([2, 3], 2)]


@pytest.mark.parametrize("algorithm", sorted(mcs.ALGORITHMS))
def test_weights_change_the_optimum(algorithm):
    enc = encode(load_source(PROPOSAL_EXAMPLE))
    found = [(m.sorted(), m.cost) for m in mcs.make(algorithm, enc, weights={1: 5}).enumerate()]
    assert found == [([2, 3], 2), ([1], 5)]


def test_well_typed_program_has_empty_mcs():
    enc = encode(load_program(REPO_ROOT / "Tests" / "Async" / "promises_1.js"))
    for algorithm in mcs.ALGORITHMS:
        assert [m.lines for m in mcs.make(algorithm, enc).enumerate()] == [frozenset()]


ILL_TYPED = [p for p in TEST_PROGRAMS if "Conflict_Detection" in p or "Class" in p or "obj_2" in p]


@pytest.mark.parametrize("path", ILL_TYPED, ids=lambda p: Path(p).name)
def test_algorithms_agree(path):
    """OLL, IHS and Z3 enumerate MCSs with the same sequence of costs, and
    every MCS is a minimal correction subset."""
    enc = encode(load_program(path))
    if enc.check() == z3.sat:
        pytest.skip("well typed")
    runs = {a: list(mcs.make(a, enc).enumerate(limit=12)) for a in mcs.ALGORITHMS}
    costs = {a: [m.cost for m in r] for a, r in runs.items()}
    assert costs["oll"] == costs["ihs"] == costs["z3"]
    s = enc.solver()
    for m in runs["oll"]:
        keep = [enc.selectors[L] for L in enc.lines if L not in m.lines]
        assert s.check(*keep) == z3.sat  # a correction subset ...
        for L in m.lines:  # ... and minimal: putting any line back is unsat
            assert s.check(*keep, enc.selectors[L]) == z3.unsat


@pytest.mark.parametrize("seed", [1, 2, 3, 4])
def test_algorithms_agree_with_several_mistakes_and_weights(seed):
    """Regression test: OLL must keep the outputs of different cardinality
    sums apart when it extends them (several overlapping cores, weights)."""
    import random
    import sys

    sys.path.insert(0, str(REPO_ROOT / "bench"))
    import evaluate as ev
    from generate import generate

    import tempfile

    with tempfile.TemporaryDirectory() as d:
        base = Path(d) / "base.js"
        base.write_text(generate(120, 300 + seed))
        sample = ev.sample_mistakes(str(base), 6, seed)
    enc = encode(program_from_json(ev.infer_source(sample["source"]), sample["source"]))
    rng = random.Random(seed)
    weights = {L: rng.randint(1, 5) for L in enc.lines}
    for w in (None, weights):
        costs = {a: [m.cost for m in mcs.make(a, enc, weights=w).enumerate(limit=5)] for a in mcs.ALGORITHMS}
        assert costs["oll"] == costs["ihs"] == costs["z3"]


# -- closed-world fields ---------------------------------------------------------------
MISSPELLED_READ = 'const o = { name: "a", id: 1 };\nconst n = o.nmae;\nconst m = o.id + 1;\n'


def test_closed_fields_catches_misspelled_read():
    program = load_source(MISSPELLED_READ)
    assert encode(program).check() == z3.sat  # open records: reading o.nmae is fine
    enc = encode(program, closed_fields=True)
    assert enc.check() == z3.unsat
    assert sorted(m.sorted() for m in mcs.make("oll", enc).enumerate()) == [[1], [2]]
    assert baseline.first_conflicts(enc) == [2]


@pytest.mark.parametrize("path", TEST_PROGRAMS, ids=lambda p: str(Path(p).relative_to(REPO_ROOT)))
def test_closed_fields_has_no_false_positives(path):
    program = load_program(path)
    assert encode(program, closed_fields=True).check() == encode(program).check()


# -- baselines and ranking -------------------------------------------------------
def test_first_conflict_baselines():
    data = run_infer_source(PROPOSAL_EXAMPLE)
    program = program_from_json(data, PROPOSAL_EXAMPLE)
    assert baseline.solver_js_lines(run_solver_js(data)) == [2, 3]
    assert baseline.first_conflicts(encode(program), k=3) == [2, 3]


def test_rankings():
    enc = encode(load_source(PROPOSAL_EXAMPLE))
    for strategy in rank.STRATEGIES:
        r = rank.rank(enc, strategy)
        assert r.lines[0] == 1, strategy


def test_pareto_layers():
    C = rank.Candidate
    a, b, c, d = C((1,), 1, 9), C((2,), 1, 3), C((3, 4), 2, 2), C((5, 6), 2, 5)
    assert rank.pareto_layers([a, b, c, d]) == [[b, c], [a, d]]


def test_random_tiebreak():
    C = rank.Candidate
    cands = [C((1,), 1, 1), C((2,), 1, 1)]
    stats = rank.random_tiebreak(cands, target=2, trials=2000)
    assert 0.4 < stats["top1"] < 0.6 and stats["top3"] == 1.0


def run_infer_source(source: str) -> dict:
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "input.js"
        p.write_text(source)
        return run_infer(p)


# -- granularity and re-inference ----------------------------------------------------
def test_method_chain_links_have_their_own_line():
    src = "const p = Promise.resolve(1);\nconst q = p\n  .then(x => x + 1)\n  .thne(y => y);\n"
    enc = encode(load_source(src))
    smallest = sorted(m.sorted() for m in mcs.make("oll", enc).enumerate() if m.cost == 1)
    # the two links of the chain (the misspelled .thne, and the .then whose
    # promise it is applied to), no longer line 2 where the chain starts
    assert smallest == [[3], [4]]


def test_group_by_statement_and_node():
    src = 'const a = 1; const b = a + "x"; const c = b * 2;\n'
    program = load_source(src)
    assert encode(program, group_by="line").lines == [1]
    stmts = encode(program, group_by="statement")
    assert len(stmts.lines) == 3 and all(stmts.span[g] == (1, 1) for g in stmts.lines)
    nodes = encode(program, group_by="node")
    found = [m.lines for m in mcs.make("oll", nodes).enumerate()]
    assert len(found) >= 2 and all(len(m) == 1 for m in found)


HINT_CASE = 'const s = 0;\nconst t = s.toUpperCase();\nconst z = s === "x";\n'


def test_reinference_finds_the_line_behind_a_wrong_type_hint(tmp_path):
    """After `const s = 0`, s.toUpperCase() is inferred as a field of an
    object, so dropping line 1's constraints alone is not enough; inferring
    the program again without line 1 is."""
    path = tmp_path / "hint.js"
    path.write_text(HINT_CASE)
    enc = encode(load_program(path))
    plain = rank.rank(enc, "card")
    assert plain.candidates[0].card == 2
    with_reinference = rank.rank(enc, "card", path=path, reinfer=True)
    assert with_reinference.stats["reinference"] == [1]
    assert with_reinference.candidates[0].lines == (1,)


# -- missing code ----------------------------------------------------------------------
@pytest.mark.parametrize("example,kind,line", [("missing_return", "add-return", 3), ("missing_await", "add-await", 3)])
def test_hints_for_missing_code(example, kind, line):
    path = REPO_ROOT / "examples" / f"{example}.js"
    r = rank.rank(encode(load_program(path)), "card-late", path=path, hints=True)
    assert [(h.kind, h.line) for h in r.hints] == [(kind, line)]
    assert r.rank_of(line) == 1


def test_no_hint_without_missing_code():
    path = REPO_ROOT / "examples" / "promise.js"
    r = rank.rank(encode(load_program(path)), "card-late", path=path, hints=True)
    assert r.hints == [] and r.rank_of(1) == 1



# -- performance changes keep the results -------------------------------------------------
@pytest.mark.parametrize("seed", [1, 2, 3])
def test_simplification_and_slicing_keep_the_mcses(seed):
    """Eliminating group-local variables and slicing to the conflicting
    components change the formula, never its smallest correction subsets."""
    import sys
    import tempfile

    sys.path.insert(0, str(REPO_ROOT / "bench"))
    import evaluate as ev
    from generate import generate
    from localizer.slicing import slice_to_conflicts

    with tempfile.TemporaryDirectory() as d:
        base = Path(d) / "base.js"
        base.write_text(generate(240, 400 + seed, modules=4))
        sample = ev.sample_mistakes(str(base), 4, seed)
    program = program_from_json(ev.infer_source(sample["source"]), sample["source"])

    def smallest(enc):
        found = []
        for m in mcs.make("oll", enc).enumerate():
            if found and m.cost > found[0][0]:
                break
            found.append((m.cost, tuple(m.sorted())))
        return sorted(found)

    plain = encode(program, simplify=False)
    simplified = encode(program)
    sliced, stats = slice_to_conflicts(simplified)
    assert smallest(plain) == smallest(simplified) == smallest(sliced)
    assert stats["components"] >= 4


def test_hint_with_another_mistake_present(tmp_path):
    """With two mistakes no single edit makes the program well typed; a hint is
    accepted when it removes one conflict (the smallest MCS gets smaller)."""
    path = tmp_path / "two.js"
    path.write_text(
        "const p = Promise.resolve(41);\nasync function next(k) {\n  const w = p;\n  return w * k;\n}\n"
        'const q = next(2);\nconst n = "3";\nconst m = n * 2;\n'
    )
    r = rank.rank(encode(load_program(path)), "card-late", path=path, hints=True)
    assert [(h.kind, h.line) for h in r.hints] == [("add-await", 3)]
