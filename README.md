# SAT/SMT-Based Type Error Localization for a Core JavaScript Subset

When type inference fails, a conventional checker reports the **first conflict it
meets**, which is often not where the mistake is:

```js
const p = Promise.resolve("42");   // the mistake: "42" instead of 42
const a = p.then(s => s * 2);
const b = p.then(t => t - 1);
```

The union-find solver of this repository (`solver.js`) blames line 2. The
localizer added here asks a different question: *which lines can be dropped,
as few as possible, so that the rest of the program is typable?* Dropping line 1
alone removes every conflict, while lines 2 and 3 would both have to go, so line
1 is the best candidate:

```
$ python -m localizer examples/promise.js
examples/promise.js: type error.

Suspicious lines (card-late, oll):
   1. line 1    const p = Promise.resolve("42");                              (candidate #1)
   3. line 2    const a = p.then(s => s * 2);                                 (candidate #2)
   3. line 3    const b = p.then(t => t - 1);                                 (candidate #2)

Correction subsets (dropping the constraints of these lines makes the rest typable):
  #1  {1}  (1 line(s), 4 constraint(s))
  #2  {2, 3}  (2 line(s), 18 constraint(s))

A first-conflict checker (solver.js) blames: line 2
```

(The command exits with status 1 when it finds a type error, like a checker.)

This README explains everything that was built for the proposal
*SAT/SMT-Based Type Error Localization for a Core JavaScript Subset*: the design,
why it is correct, the benchmark, and the answers to the three research
questions, with the measurements behind them.

**Contents**

1. [Summary](#summary)
2. [Quick start](#quick-start)
3. [Architecture](#architecture)
4. [Step 1: constraints with source lines](#step-1-constraints-with-source-lines)
5. [Step 2: the SMT encoding and why it is correct](#step-2-the-smt-encoding-and-why-it-is-correct)
6. [Step 3: smallest correction subsets](#step-3-smallest-correction-subsets)
7. [Step 4: ranking the candidates](#step-4-ranking-the-candidates)
8. [Benchmarks](#benchmarks)
9. [Results](#results)
10. [Findings about the existing inferencer](#findings-about-the-existing-inferencer)
11. [Limitations and threats to validity](#limitations-and-threats-to-validity)
12. [Reproducing everything](#reproducing-everything)
13. [Repository map](#repository-map)
14. [References](#references)

---

## Summary

What was done, following the plan of the proposal:

| Proposal plan | What exists now |
|---|---|
| Weeks 1–2: constraints with source lines | `infer.js --json` tags every constraint with the line (and AST node) it comes from; library signatures are marked hard. `solver.js --json` records which constraint caused each conflict. The text output, and therefore the 132 regression tests, are unchanged. |
| Weeks 1–2: SMT encoding + correctness argument | `localizer/encode.py`: types are an algebraic datatype, fields and signatures uninterpreted functions, `+` a disjunction, one selector literal per line. [Correctness argument](#24-correctness-argument) plus an empirical cross-check: the encoding agrees with `solver.js` on **all 132** test programs, and every disagreement on mutated programs is explained. |
| Weeks 3–4: smallest correction subsets | `localizer/mcs.py`: core-guided MaxSMT (**OLL**), **implicit hitting sets** (MaxHS-style, with RC2 as the hitting-set solver), and Z3's built-in MaxSMT as a reference, all enumerating minimal correction subsets in order of cost. Tests check that all three agree and that every result is a minimal correction subset. |
| Week 5: ranking (Q2) | `localizer/rank.py`: cardinality with three tie-breaking rules, program-derived weights (number of constraints per line), and Pareto-optimal correction subsets over two criteria. |
| Week 6: benchmarks | `bench/mutate.js` (six kinds of mistakes), `bench/generate.py` (well-typed programs of any size), 4,000+ evaluated programs. |
| Week 7: experiments (Q1–Q3) | `bench/run_experiments.py`, `bench/report.py`, results in [`results/`](results/summary.md). |
| (extension) | Optional **closed-world fields** (`--closed-fields`): a disjunctive constraint, beyond what unification can express, that catches misspelled property names. |

Main findings (details in [Results](#results)):

* **Q1.** For a single mistake whose line carries the conflicting constraints,
  the mistake line is a smallest correction subset in 99–100% of the cases. It
  is often **not the only one**: the smallest correction subset is unique in
  only 41–55% of the cases. The approach fails systematically when the
  mistake is *missing code*. A forgotten `return` changes a constraint on the
  function header, not on the line where the code is missing, so the
  mistake line is never blamed (0%). A forgotten `await` is still found,
  because the line keeps the constraint that conflicts, but it always ties.
* **Q2.** Ranking by cardinality puts the mistake line in the top 3 in
  90–99% of the cases (99–100% if forgotten `return`s are left out), against
  66–77% for a first-conflict checker. For the top-1, the tie-breaking rule
  decides, and which rule is best depends on the kind of mistake. "Latest line
  first" is the best overall rule: 78–83% top-1, against 66–76% for the first
  conflict. It wins for mistakes at a use site (wrong variable, misspelled
  property: 93–99%), while "fewer constraints first" wins for mistakes at a
  definition site (forgotten `await`: 77% vs 0%). Program-derived weights
  (fewest constraints blamed) and Pareto ranking help definition-site mistakes
  and hurt use-site mistakes; no single rule dominates.
* **Several mistakes.** With 2–6 mistakes, the MCS ranking still has 77–80% of
  the mistakes among its first answers, while the first-conflict checker drops
  to 45–52%.
* **Q3.** All three algorithms localize programs of 8,000 lines (≈28,700
  constraints) with 16 mistakes in 30–42 s, with no timeouts. With many
  mistakes Z3's maxres is fastest, OLL is close behind, and implicit hitting
  sets need about 2.5 times as many SAT calls as OLL. The time grows roughly
  quadratically with the size of the program; the cost of each SAT call, not
  their number, dominates.
* The declarative encoding also exposed **order dependence in the existing
  solver**: on well-typed generated programs of 1,600 lines, `solver.js`
  reports a spurious conflict in 7 of 20 cases; the SMT encoding accepts all of
  them.

---

## Quick start

Requirements: Node.js ≥ 18, Python ≥ 3.10.

```bash
npm install
```

```bash
pip install -r requirements.txt
```

Localize the type error of a program:

```bash
python -m localizer examples/promise.js
```

Options: `--strategy {card,card-late,card-size,size,pareto}` (default
`card-late`, the best single rule in the experiments), `--algorithm {oll,ihs,z3}`
(default `oll`), `--closed-fields`, `--top N`, `--json`.
A well-typed program prints the types of a model, with `?` for the parts that
no constraint determines:

```bash
python -m localizer Tests/Async/promises_1.js
```

Tests:

```bash
./run_tests.sh
```

```bash
python -m pytest tests -q
```

---

## Architecture

```
                         program.js
                             │
                             ▼
                 node infer.js --json          (constraint generation, existing,
                             │                  now tagged with source lines)
          constraints  [{text: "T4 <= Promise<T2,T3>", line: 1, node: "CallExpression", ...}, ...]
              ┌──────────────┴────────────────────────┐
              ▼                                       ▼
   node solver.js --json                    python -m localizer
   union-find, constraints in order         ┌─────────────────────────────────────────┐
   → first conflict (the baseline)          │ constraints.py  parse the terms          │
                                            │ encode.py       Z3 formula, one selector │
                                            │                 literal per source line  │
                                            │ mcs.py          smallest correction      │
                                            │                 subsets: OLL / IHS / Z3  │
                                            │ rank.py         ranked suspicious lines  │
                                            │ baseline.py     first conflict, SMT order│
                                            └─────────────────────────────────────────┘
```

* **`infer.js`** (existing; extended) walks the AST of the program and emits typing
  constraints. With `--json` every constraint carries its origin.
* **`solver.js`** (existing; extended) solves the constraints in order with
  union-find and records the constraint that caused each conflict. Its first
  conflict is the "first-conflict checker" of the proposal.
* **`localizer/`** (new, Python) encodes the constraints into SMT and computes
  smallest correction subsets.
* **`bench/`** (new) contains the mutation tool, the program generator and the experiment
  drivers; **`results/`** has their output.

---

## Step 1: constraints with source lines

**What changed in `infer.js`.** Inference already separated constraint generation
from solving: `infer.js` prints the constraints and `solver.js` reads them. Three
things were added, all without changing the existing text output:

1. **Origins.** The three inference entry points (`inferExpr`, `inferStmt`,
   `inferExprStmt`) push the AST node they work on onto a stack (`withNode`).
   Every constraint records the innermost node being inferred when it was
   generated: its line, column, end position and node type. Constraints are
   attributed to the innermost node on purpose: in

   ```js
   const x = foo(
     "42",
     b);
   ```

   the constraint `T <= str` of the literal is on line 2, while the constraint
   linking the argument to the parameter belongs to the call on line 1.
   `Program` and `BlockStatement` are skipped, so a block's constraints belong to
   the construct that owns the block.

2. **Hard library constraints.** Signatures of library functions (`summaries.js`,
   `stubs.js`, the built-in string and array methods) are instantiated lazily
   and **cached**: `arr.push` on line 3 and on line 5 share one method type, whose
   signature constraints were generated while inferring line 3. If those
   constraints belonged to line 3, "dropping line 3" would also remove the
   signature used by line 5. Everything generated inside `asLibrary(...)` is
   therefore tagged `source: "library"` and treated as **hard**: it can never be
   dropped. The constraint linking a call's argument to the parameter stays
   with the line of the call.

3. **Field access kinds.** Field constraints `x <= {f: T}` are tagged as `read`,
   `write`, `literal` (object literal) or `computed-write`. The default encoding
   ignores these tags; the closed-world extension uses them.

`node infer.js --json file.js` prints the constraints in the same order as the
text output:

```json
{"id": 7, "kind": "sub", "text": "s__then_cb_T8__global <= num", "source": "program",
 "line": 2, "col": 17, "endLine": 2, "endCol": 22, "node": "BinaryExpression"}
```

**What changed in `solver.js`.** It accepts the JSON (as well as the text) on
stdin. With `--json` it prints `{conflicts, types}`, where each conflict names
the constraint, and hence the line, that was being processed when it was
found. Internally, the 26 `this.errors.push(...)` calls became
`this.reportError(...)`, which records the current origin. All 132 regression
tests still pass byte for byte.

---

## Step 2: the SMT encoding and why it is correct

### 2.1 Types

```
Type = Num | Str | Bool | Void | Regexp | Error           base types
     | Obj(Id) | Arr(Id) | Fun(Id) | Prom(Id)             structured types
     | Res(Id) | Rej(Id)                                  Promise resolver / rejector
     | Cls(Int, Id) | Inst(Int, Id)                       class #n / instance of class #n
```

`Id` is an uninterpreted sort. A structured type carries only an *identity*; its
components are **uninterpreted functions** of the type:

| component | function |
|---|---|
| field `f` of an object (or attribute of an instance) | `field_f : Type → Type` (one per field name) |
| array element | `elem : Type → Type` |
| i-th parameter, result of a function | `param_i : Type → Type`, `ret : Type → Type` |
| resolve / reject type of a promise | `pres`, `prej : Type → Type` |
| method `m` of a class: j-th signature slot, arity | `member_m_j : Type → Type`, `arity_m : Type → Int` |

Two consequences matter:

* **Equal types have equal components** (congruence), which is exactly what
  unification does when it merges two equivalence classes. Types that are never
  unified can get different identities and therefore independent components.
* Components are functions of an identity, not constructor arguments, so a type
  may refer to itself (`o.self = o`). This matches `solver.js`, which has no
  occurs check.

### 2.2 Constraints as formulas

| constraint (as printed by infer.js) | formula |
|---|---|
| `x <= y` | `x = y` |
| `x <= num` / `x <= str\|regexp` | `x = Num` / `x = Str ∨ x = Regexp` |
| `x <= {}` | `is_Obj(x)` |
| `x <= {f: T, g: U}` | `(is_Obj(x) ∨ (is_Inst(x) ∧ arity_f(x) = 1 ∧ …)) ∧ field_f(x) = T ∧ field_g(x) = U` (open records: *at least* these fields) |
| `x <= Array<T>` | `is_Arr(x) ∧ elem(x) = T` |
| `x <= Func<n>{P1 -> P2 -> R}` | `is_Fun(x) ∧ param_0(x) = P1 ∧ param_1(x) = P2 ∧ ret(x) = R` |
| `x <= Promise<A,B>` | `is_Prom(x) ∧ pres(x) = A ∧ prej(x) = B` |
| `x <= Class<C>[m: P -> R, a: T]` | `is_Cls(x) ∧ cls_name(x) = #C ∧ arity_m(x) = 2 ∧ field_m(x) = P ∧ member_m_1(x) = R ∧ …` |
| `void <= x` (literal on the left) | as `x <= void` |
| `plus(a, b, r)`  (`r = a + b`) | `(a = Num ∧ b = Num ∧ r = Num) ∨ ((a = Str ∨ b = Str) ∧ r = Str)` |
| `union(a, b, r)`  (`r = c ? a : b`), `logical_union` (`&&`, `\|\|`) | `r = a ∨ r = b` |
| `index(o, i, r)`  (`r = o[i]`) | `(is_Arr(o) ∧ i = Num ∧ r = elem(o)) ∨ (is_Obj(o) ∧ i = Str) ∨ (o = Str ∧ i = Num ∧ r = Str)` |
| `tpl(x)` (`` `${x}` ``) | `true` |

Nested type literals (e.g. `Array<{}>`) get a fresh auxiliary variable. The
typing rule for `+` follows TypeScript: numeric addition, or concatenation
when one operand is a string. (`--plus lenient` reproduces the more permissive
rule of `solver.js`.)

### 2.3 Lines as groups

For every source line `L` there is a selector literal `sel_L`, and the
constraints of line `L` are asserted as `sel_L → (c1 ∧ … ∧ ck)`. Library
constraints are asserted unconditionally. "Dropping line L" means assuming
`sel_L` false.

### 2.4 Correctness argument

The goal is that the formula has a model **exactly when** the constraints
have a solution, and that a model **is** a solution. Then nothing is lost
and nothing is invented, and correction subsets of the formula are correction
subsets of the program.

**Semantics of the constraints.** A *type graph* is a set of nodes `N`, each
labelled with a constructor (`num`, …, `obj`, `arr`, `fun`, `prom`, …), with one
canonical node per base type, and partial edge functions `field_f`, `elem`,
`param_i`, `ret`, `pres`, `prej`, … between nodes. Type graphs represent
regular (possibly infinite) trees, which is what union-find without an occurs
check computes. A *typing* of a constraint set `C` is a type graph together
with a map `σ` from type variables to nodes such that every constraint holds
when read as in the table above, with `x = y` meaning `σ(x) = σ(y)`, `is_Obj(x)`
meaning that `σ(x)` is labelled `obj`, `elem(x)` meaning the `elem` edge, and so on.

**Claim 1 (no typing is lost, no model is spurious).** `Φ(C)` is satisfiable
iff `C` has a typing.

* *(⇒)* Let `M` be a model. Take as nodes the values of sort `Type` in `M`, label
  each by its outermost constructor, and take as edges the interpretations of
  the function symbols in `M`; let `σ(x) = M(x)`. Each conjunct of the encoding
  of a constraint is literally the condition required of the typing, evaluated
  in `M` (auxiliary variables of nested literals provide the witness nodes).
  Base constructors are nullary, so each base type is a single canonical value.
* *(⇐)* Given a typing, let the domain of `Id` be the set of nodes and map each
  node `n` to the value `K(n)`: the nullary constructor of a base node, or the
  constructor of `n` applied to `n` itself as its identity (`Cls`/`Inst` also
  get the class number). `K` is injective. Interpret every function symbol `ℓ`
  by `ℓ(K(n)) = K(ℓ-edge of n)` where the edge exists (arbitrarily elsewhere),
  each variable by `K(σ(x))`, and each auxiliary variable by `K` of its witness.
  Every conjunct holds by construction.

The essential point is the identity argument: two structured types are equal
values **iff** they are the same node. So the formula can neither identify
two types the typing keeps apart, nor separate two that it identifies.

**Claim 2 (selectors).** For a set `K` of lines, the formula is satisfiable
under the assumptions `{sel_L | L ∈ K}` iff the hard constraints together with
the constraints of the lines in `K` are satisfiable. (⇐: set the other selectors
false. ⇒: drop the guarded conjuncts.) Hence the correction subsets of the
formula, i.e. sets of selectors to falsify, are exactly the correction subsets
of lines, and a minimum-weight correction subset is the complement of an optimal
MaxSMT solution with soft constraints `sel_L` of weight `w(L)`.

**Claim 3 (relation to the union-find solver).** For constraints of the form
`x <= y` and `x <= pattern`, solvability is unification over rational trees
with open records. Union-find with propagation of components, which is what
`State.union`/`process` in `solver.js` does, decides it **provided every pair of
incompatible constructors is checked**. Here the encoding found two missing
checks, Promise against object and against array, and one deliberate
leniency, base types mixed with arrays (see
[Findings](#findings-about-the-existing-inferencer)). The
disjunctive constraints (`+`, `?:`, `&&`/`||`, `o[i]`) are outside unification.
`solver.js` resolves them after the main pass, once, using whatever types are
known at that point. That is an approximation, and it is order dependent. The
encoding states them declaratively, so the order of the constraints does not
matter.

**Empirical cross-check.**

* All 132 test programs: the encoding is satisfiable exactly when `solver.js`
  reports no conflict (`tests/test_localizer.py::test_agrees_with_solver_js`;
  13 ill-typed, 119 well-typed).
* 1,828 mutated programs (761 from the test suite, 1,067 generated): the
  verdicts agree on 1,774 (97%). All 54 differences are programs that
  `solver.js` accepts and the encoding rejects. None goes the other way. They
  come from four semantic differences, each of which the encoding gets right by
  TypeScript's standards:
  1. `+` with an operand that is neither a number nor a string (`true + 1`,
     `void + 1`), which `solver.js` accepts (20 cases);
  2. a `Promise` used as an object or an array (`p.thne(...)`, `p[0]`);
     `solver.js` never checks Promise against either (23 cases);
  3. an array used as a number or a string, or the other way round
     (`nums * 2`, `flag.join(",")`); `solver.js` turns the variable into a union
     such as `num | Array<num>` (8 cases);
  4. indexing a number (`i[i]`), which `solver.js` accepts (3 cases).
* Generated well-typed programs: every one is accepted by the encoding, while
  `solver.js` reports a spurious conflict on 0/20 programs of 100 lines, 2/20 of
  400 lines and 7/20 of 1,600 lines (order dependence, see [Findings](#findings-about-the-existing-inferencer)).

### 2.5 Extension: closed-world fields

With open records, `user.nmae` (a misspelled read) is not a type error: the
object simply gains a field `nmae`. A unification-based checker cannot do
better, because the constraint needed is not an equation: *a field that is read
must be defined somewhere*. As a formula this is a disjunction over the
definitions in the program, which the SMT encoding can express directly
(`--closed-fields`):

* `closed(x)` holds for every object created by an object literal (`{...}`,
  including `{}`);
* a read `x.f` of a closed object requires a definition of `f` on an object
  equal to `x` whose line is kept:
  `closed(x) → ∨_{definitions d of f} (sel_{line(d)} ∧ x = y_d)`, where
  definitions are literal fields, writes `y.f = …`, library fields, and computed
  writes `y[k] = …` (which may define any field);
* reads with a default value (`const {a = 0} = obj`) need no definition.

On the 132 test programs this changes no verdict (no false positives), and it
more than doubles the number of misspelled-property mutants that are detected
(29 → 64 on the test suite).

```
$ python -m localizer examples/misspelled_property.js --closed-fields
...
  #1  {1}  (1 line(s), 5 constraint(s))
  #2  {3}  (1 line(s), 4 constraint(s))       <- line 3: "hi " + user.nmae
```

---

## Step 3: smallest correction subsets

A **correction subset** is a set of lines whose removal leaves a satisfiable
formula; a **minimal correction subset (MCS)** has no smaller correction subset
inside it. With positive weights, a minimum-cost correction subset is always
minimal. All algorithms live in `localizer/mcs.py` behind one interface,
`make(algorithm, encoding, weights=...).enumerate()`, and yield MCSs in
order of **non-decreasing cost**.

**OLL, core-guided MaxSMT** (Andres et al. 2012; Morgado et al. 2014; the
algorithm in RC2):

1. Solve under the assumption that all soft literals hold.
2. If unsatisfiable, take the unsat core `K`, shrink it (re-solving under the
   core, then deletion-based minimization), and add `w_min(K)` to the lower
   bound. Lower every weight in `K` by `w_min`, then introduce a cardinality
   output `o_2` with `AtLeast(¬K, 2) → o_2`, and the new soft literal `¬o_2`
   ("at most one of `K` is violated") of weight `w_min`. When a soft literal
   `¬o_k` appears in a core, it is relaxed to `¬o_{k+1}`.
3. If satisfiable, the lines whose constraints the model violates form an
   optimal correction subset. Its cost equals the lower bound, and the code
   asserts this.

Weights are handled with stratification (heaviest literals first).

**IHS, implicit hitting sets** (Davies & Bacchus 2011, MaxHS):

1. Collect disjoint cores first: assume all lines, take a core, stop assuming
   its lines, repeat until satisfiable.
2. Repeat: compute an **optimal hitting set** `H` of all cores collected so far,
   using PySAT's RC2 MaxSAT solver incrementally. Check the program without the
   lines of `H`. If it is satisfiable, `H` is an optimal correction subset;
   otherwise add the new core.
3. Between optimal hitting sets, cheap greedy hitting sets harvest more cores
   (as in MaxHS).

**Z3** uses its built-in MaxSMT (`Optimize`, core-guided *maxres*) as a reference.

**Enumeration.** After an MCS `M` is reported, the clause `∨_{L ∈ M} sel_L`
("keep at least one line of `M`") is added (to the hitting-set problem in IHS)
and the search continues. This excludes `M` and all its supersets. The next
optimum is again minimal: a cheaper correction subset inside it would either have
been found already (and then its supersets are excluded) or would contradict
optimality. All three algorithms therefore produce the MCSs in order of cost.

**Checks** (`tests/test_localizer.py`). On every ill-typed test program, and on
generated programs with six mistakes and random weights, the three algorithms
produce the same sequence of costs. Every MCS is verified to be a correction
subset (the rest is satisfiable) and minimal (adding back any one of its lines
makes it unsatisfiable). OLL also checks at run time that the cost of its model
equals its lower bound. That check caught a real bug during the experiments
(cardinality outputs of different cores could share a variable name), and
the weighted test now guards against it.

**First-conflict baselines** (`localizer/baseline.py`):

* **`solver.js`**: the lines of the conflicts it reports, in the order it meets them;
* **SMT order**: the same strategy under the SMT semantics. The shortest
  unsatisfiable prefix of the constraint sequence, found by binary search since
  unsatisfiability is monotone in the prefix, ends with the constraint that is
  blamed. To get a ranked list, that line is dropped and the search continues.
  This baseline isolates the effect of the *strategy* from the semantic
  differences between `solver.js` and the encoding.

---

## Step 4: ranking the candidates

The candidates are ordered, then flattened into a list of lines. A line's
**rank** is the number of distinct lines in the candidates up to and including the
first candidate that contains it. Lines inside one candidate are counted
pessimistically: in the example above, lines 2 and 3 both get rank 3.

| strategy | order of the candidates |
|---|---|
| `card` | fewest lines first; ties in source order (earliest line first) |
| `card-late` | fewest lines first; ties: latest line first |
| `card-size` | fewest lines first; ties: fewer constraints first |
| `size` | weight of a line = number of constraints it generates, i.e. blame as little of the program as possible (the cost of Pavlinovic et al. is the size of the blamed expressions) |
| `pareto` | two criteria at once, (number of lines, number of constraints). Every Pareto-optimal correction subset is an MCS, because both criteria grow with the set (Terra-Neves et al. 2018), so the front is computed among the enumerated MCSs. The Pareto-optimal candidates come first, then the front of the rest, and so on (non-dominated sorting). |

For the analysis, the experiments also report **random tie-breaking**: the
probability that the mistake line is first, or in the top 3, when candidates of
equal size are shown in random order (500 shuffles).

---

## Benchmarks

### Mistakes (`bench/mutate.js`)

Each operator changes one line of a correct program, so the line of the
mistake is known:

| operator | example | kind |
|---|---|---|
| `literal` | `42` → `"42"`, `"42"` → `42`, `true` → `"true"` | wrong value (the proposal's example) |
| `swap-args` | `f(a, b)` → `f(b, a)` | swapped arguments |
| `misspell-prop` | `o.name` → `o.naem` | misspelled property |
| `missing-await` | `await p` → `p` | forgotten `await` (missing code) |
| `wrong-var` | `x` → the most recently declared other variable in scope | wrong variable |
| `remove-return` | `return e;` → `e;` | forgotten `return` (missing code) |

Mutants that are still well typed are not type errors and are excluded from
the localization metrics (but counted in the detection tables).

### Corpora

| corpus | base programs | evaluated programs |
|---|---|---|
| **test suite** | the 119 well-typed programs of `Tests/` (the 13 ill-typed ones excluded) | up to 6 mutants per operator and program: 761 mutants, × 2 settings (open / closed fields) |
| **generated** | 40 generated programs of 60 lines (`bench/corpus/generated/`), accepted by both checkers | 1,067 mutants × 2 settings; balanced over operators (the test suite has a single `await`) |
| **several mistakes** | 20 generated programs of 200 lines (`bench/corpus/multi/`) | k ∈ {1, 2, 3, 4, 6} mistakes on distinct lines, 3 samples each: 300 programs |
| **scaling** | generated programs of 250 – 8,000 lines, 3 per size | k ∈ {1, 4, 16} mistakes: 54 programs × 3 algorithms (+ 2 ablations) |

The **generator** (`bench/generate.py`) builds programs from templates that use
earlier variables of the right type: numbers, strings, booleans, arrays,
objects with fields, named and arrow functions, promises with `then`, `async`
functions with `await`, loops and conditionals. Lines therefore depend on each
other the way they do in real code. It avoids a few imprecisions of the
inferencer (listed below); base programs that either checker rejects are
skipped.

### Metrics

* **top-k**: share of the ill-typed mutants whose mistake line has rank ≤ k;
* Q1 facts per mutant: is the mistake line alone a correction subset? Is it in a
  smallest MCS? How many smallest MCSs are there (ties)?
* several mistakes: a mistake is *effective* if it is a type error on its own
  (benign ones cannot be found by any method); precision of the first MCS, and
  recall of the effective mistakes in the first MCS and in the first *e* ranked
  lines (*e* = number of effective mistakes);
* scaling: time until the first optimal MCS, number of SAT calls, timeouts
  (300 s).

---

## Results

All numbers below come from `results/*.csv` and are reproduced by
`python bench/report.py` (full tables: [`results/summary.md`](results/summary.md)).

### Which mutants are type errors

| mistake | test suite: mutants | type errors: solver.js / SMT / SMT + closed fields | generated: mutants | type errors: solver.js / SMT / SMT + closed fields |
|---|---|---|---|---|
| literal | 324 | 138 / 138 / 138 | 240 | 190 / 190 / 190 |
| swap-args | 20 | 6 / 6 / 6 | 128 | 56 / 56 / 56 |
| misspell-prop | 127 | 21 / 29 / **64** | 240 | 146 / 158 / **173** |
| missing-await | 1 | 0 / 0 / 0 | 70 | 70 / 70 / 70 |
| wrong-var | 250 | 72 / 83 / 83 | 240 | 108 / 119 / 119 |
| remove-return | 39 | 5 / 5 / 5 | 149 | 38 / 50 / 50 |
| **all** | 761 | 242 / 261 / 296 | 1,067 | 608 / 643 / 658 |

Many mutants are still well typed: a string literal that is only concatenated
can become a number, a swapped pair of arguments can have the same type. These
are not type errors, so no checker can report them, and they are left out of
the localization results. The encoding finds more errors than `solver.js` for
the reasons given in [§2.4](#24-correctness-argument). Closed-world fields
more than double the misspelled properties found in the test suite.

### Q1: does the smallest correction subset point to the real mistake?

| mistake | ill-typed (test suite / generated) | mistake line is in a smallest MCS (%) | the smallest MCS is unique (%) | equally small MCSs (mean) |
|---|---|---|---|---|
| literal | 138 / 190 | 100 / 99 | 49 / 88 | 1.6 / 1.2 |
| swap-args | 6 / 56 | 100 / 100 | 100 / 100 | 1.0 / 1.0 |
| misspell-prop | 29 / 158 | 93 / 100 | 10 / 48 | 2.0 / 1.6 |
| missing-await | – / 70 | – / 100 | – / **0** | – / 2.4 |
| wrong-var | 83 / 119 | 100 / 100 | 31 / 34 | 1.8 / 1.8 |
| remove-return | 5 / 50 | 80 / **0** | 80 / 28 | 1.2 / 2.5 |
| **all** | 261 / 643 | 99 / 92 | 41 / 55 | 1.7 / 1.6 |

**Mostly yes, as long as the mistake is on a line whose constraints take part
in the conflict.** For wrong values, swapped arguments, misspelled
properties, wrong variables and even forgotten `await`s, the mistake line is
a smallest correction subset in 99–100% of the cases. The assumption behind it,
that most of the program is right, holds by construction for a single
mistake: the mistake line alone explains every conflict. There are 10
exceptions among the 849 ill-typed mutants of these kinds. In 8, a mistake
changes the constraints that
`infer.js` generates for *other* lines, through its eager type hints and
`typeof` guards: after `const s2 = 0` (instead of a string), a later
`s2.toUpperCase()` is inferred as a field access on an object. The other 2 are
method chains split over lines, where the misspelled method name is not on the
line its constraints belong to.

**But a smallest MCS is often not unique.** It is unique in only 41% (test
suite) and 55% (generated programs) of the cases. Two lines that contradict
each other once give two equally small candidates, and nothing in the
constraints says which one is wrong. The smallest MCS is unique when the
evidence is unbalanced, e.g. a wrong literal in a definition that has several
uses (88% unique in the generated programs). That is exactly the case where a
first-conflict checker blames a use instead (the example at the top).

**It fails when the mistake is missing code.**

* *Forgotten `return`* (0% in the generated programs): `return e;` → `e;`
  leaves the line with constraints that are still consistent. (The 4 of 5 found
  in the test suite are one-line callbacks, `function (n) { return n > 1; }`,
  where the `return` and the header share a line.) The change shows up
  elsewhere:
  `infer.js` adds `void <= ret` for a function without `return` **on the
  function's header line**. The localizer then blames the header (with
  "earliest first", the header is the top candidate in all 50 cases) or the
  call site. It blames the right function, but never the right line
  (`examples/missing_return.js`). `solver.js` misses a quarter of these
  errors (12 of 50), because it accepts `void + 1`.
* *Forgotten `await`* (100% in a smallest MCS, 0% unique): the line
  `const w = p;` still carries the binding that conflicts, so it is a
  candidate. But so are the use of `w` and often the definition of the
  promise, which tie (2.4 equally small candidates on average,
  `examples/missing_await.js`).

### Q2: which candidate should be shown first?

![Top-1 and top-3 accuracy of the ranking strategies](results/topk.png)

Generated programs, one mistake, top-1 / top-3 (%):

| method | literal | swap-args | misspell-prop | missing-await | wrong-var | remove-return | **all** |
|---|---|---|---|---|---|---|---|
| first conflict (solver.js) | 85 / 85 | 100 / 100 | 82 / 82 | 0 / 0 | 66 / 66 | 0 / 0 | 66 / 66 |
| first conflict (SMT order) | 85 / 85 | 100 / 100 | 95 / 95 | 0 / 0 | 76 / 76 | 0 / 0 | 71 / 71 |
| MCS card, random ties | 91 / 99 | 100 / 100 | 73 / 99 | 44 / 99 | 64 / 99 | 0 / 0 | 70 / 92 |
| MCS card, earliest first | **94** / 99 | 100 / 100 | 48 / 98 | 64 / 100 | 36 / 97 | 0 / 0 | 62 / 91 |
| MCS card, latest first | 89 / 99 | 100 / 100 | **99** / 100 | 0 / 100 | **97** / 100 | 0 / 0 | **78** / 92 |
| MCS card, then size | 93 / 99 | 100 / 100 | 63 / 100 | **77** / 100 | 59 / 99 | 0 / 0 | 71 / 92 |
| MCS size-weighted | 93 / 99 | 100 / 100 | 56 / 96 | **77** / 100 | 59 / 97 | 0 / 0 | 69 / 90 |
| MCS Pareto (card, size) | 93 / 99 | 100 / 100 | 63 / 100 | **77** / 100 | 59 / 99 | 0 / 0 | 71 / 92 |
| (ill-typed mutants) | 190 | 56 | 158 | 70 | 119 | 50 | 643 |

The same table for the test-suite programs is in [`results/summary.md`](results/summary.md).

* **Top-3: the smallest correction subsets almost always contain the mistake.**
  With any of the MCS rankings, the mistake line is among the first three
  suspicious lines in 98–99% of the test-suite mutants and 90–92% of the
  generated ones. The 8% gap there is exactly the forgotten `return`s, which
  no method finds; for the other kinds it is 99–100%. A first-conflict checker
  has a single answer, so its top-3 is barely better than its top-1: 70–77%
  and 66–71%.
* **Top-1: the tie-breaking rule decides, and the best rule depends on the kind
  of mistake.** With random tie-breaking, MCSs are about as good as the first
  conflict at top-1 (68% vs 70–76%; 70% vs 66–71%). The
  balanced conflicts lose half of their points to a coin flip.
  * *Latest line first* is the best single rule (83% test suite, 78%
    generated). For a use-site mistake (wrong variable 96–97%, misspelled
    property 93–99%) the later of two conflicting lines is the use. In a tie
    this rule agrees with the first-conflict checker, which also blames the
    later constraint; it beats that checker when the evidence is unbalanced. But it
    always misses a forgotten `await` (0%), where the mistake is at the
    definition `const w = p` and the conflict at the later use.
  * *Fewer constraints first*, size weights (blame as little code as
    possible, the cost of Pavlinovic et al.) and the Pareto ranking all prefer
    simple lines. That helps when the mistake is a simple definition (forgotten
    `await` 77%, wrong literal 93%) and hurts at use sites (wrong variable 59%,
    misspelled property 56–63%).
  * Pareto ranking over (lines, constraints) gives the same order as "fewest
    lines, then fewest constraints" here. In these programs, the candidates
    with more lines almost never have fewer constraints, so the front adds
    little. Size weights alone are slightly worse because they can trade one
    line for two smaller ones.

  So the weights derived from the program that were tried encode a *prior*
  about where mistakes are (definition vs. use), not information about the
  mistake itself. A tie-breaker that knows whether a line defines or uses the
  conflicting variable, or one learned from data, is the natural next step.

### Closed-world fields

| corpus | fields | misspelled-property mutants found | MCS latest first: top-1 / top-3 (%) | first conflict (SMT): top-1 / top-3 (%) |
|---|---|---|---|---|
| test suite | open | 29 / 127 | 93 / 93 | 90 / 90 |
| test suite | closed | **64** / 127 | 83 / 83 | 81 / 81 |
| generated | open | 158 / 240 | 99 / 100 | 95 / 95 |
| generated | closed | **173** / 240 | 99 / 100 | 93 / 93 |

Closed-world fields find many more misspelled properties (×2.2 in the test
suite, where objects are built with `{}` and assignments), with no false
positives on the 132 test programs. The new errors are harder to localize. Of
the 11 test-suite cases not ranked first, 9 are misspelled *writes*
(`obj.scoer = 55`). Such a write is like deleting the definition of `score`, so
the conflict appears at the reads of `score`: missing code again. The other 2
are method chains split over lines (`p\n  .thne(...)`), whose constraints belong
to the line where the call expression starts.

### Several mistakes

Generated programs of 200 lines with *k* mistakes on distinct lines. A
mistake is *effective* if it is a type error on its own; benign mistakes cannot
be found by any method, so recall is measured against the effective ones.

| mistakes k | ill-typed programs | effective mistakes e (mean) | size of the first MCS | first MCS: precision (%) | first MCS: recall (%) | top-e lines, MCS latest first (%) | top-e lines, MCS earliest first (%) | first e blamed lines, first conflict (%) |
|---|---|---|---|---|---|---|---|---|
| 1 | 40 / 60 | 1.00 | 1.00 | 60 | 60 | **80** | 60 | 72 |
| 2 | 56 / 60 | 1.52 | 1.96 | 59 | 71 | **78** | 65 | 45 |
| 3 | 58 / 60 | 2.05 | 2.48 | 64 | 74 | **79** | 65 | 47 |
| 4 | 59 / 60 | 2.58 | 2.98 | 63 | 71 | **77** | 62 | 47 |
| 6 | 60 / 60 | 3.83 | 4.25 | 63 | 69 | **77** | 60 | 52 |

With several mistakes the first-conflict strategy degrades quickly: only
45–52% of the effective mistakes are among its first *e* answers. It keeps
blaming consequences, and one mistake can cause several conflicts. The
MCS ranking keeps 77–80% of them, independent of *k*. A smallest correction
subset covers all conflicts at once, so each mistake needs only one of its
lines in it. About 60% of the lines of the first MCS are mistakes; the others
are the other side of a tie.

### Q3: how does it scale?

![Time to the first smallest MCS as programs grow](results/scaling.png)

Median over 3 programs; in parentheses the number of SAT calls; no run hit
the 300 s timeout, and all algorithms found the same optimum in every run.

| lines | constraints | mistakes | smallest MCS (mean size) | OLL | IHS | Z3 maxres |
|---|---|---|---|---|---|---|
| 1,000 | 3,571 | 16 | 8.7 | 0.7 s (38) | 0.8 s (66) | 0.6 s (1) |
| 2,000 | 7,106 | 16 | 9.0 | 2.1 s (36) | 2.9 s (91) | 1.9 s (1) |
| 4,000 | 14,353 | 16 | 10.7 | 8.5 s (42) | 9.6 s (104) | 6.9 s (1) |
| 8,000 | 28,688 | 1 | 0.3 | 18.7 s (2) | 16.0 s (3) | 18.5 s (1) |
| 8,000 | 28,688 | 4 | 3.3 | 34.8 s (29) | 31.1 s (66) | 25.8 s (1) |
| 8,000 | 28,685 | 16 | 12.7 | 34.4 s (76) | 41.7 s (179) | 29.8 s (1) |

(all sizes from 250 lines: [`results/summary.md`](results/summary.md))

* **All three scale to programs of 8,000 lines** (≈28,700 constraints) with
  16 mistakes in well under a minute. Time grows roughly quadratically with the
  size of the program (8 times the lines, 45–55 times the time), and much more
  slowly with the number of mistakes.
* **The cost of one SAT call dominates, not the number of calls.** With a
  single mistake, an 8,000-line program already takes 16–19 s, almost all of
  it the first satisfiability check of the 28,700 constraints. With 16 mistakes,
  OLL makes 38 times as many calls but takes less than twice as long, because
  later calls reuse what the solver has learned.
* **With few mistakes the three are within about 35% of each other** (with a
  single mistake at 8,000 lines IHS is even the fastest). **With 16 mistakes Z3's
  maxres is fastest, OLL is 10–25% slower and IHS 35–55% slower.** IHS makes
  about 2.5 times as many SAT calls as OLL: each optimal
  hitting set must be checked against the SMT formula, and the cores are
  collected one by one. Its advantage, cheap reasoning about cores outside the
  SMT solver, does not pay off when the number of cores is small (≈ the number
  of mistakes).
* **Core minimization is not worth it here.** Without it (ablation at 1,000
  and 4,000 lines), OLL and IHS reach the same optimum faster: 5.2 s instead of
  8.5–9.6 s at 4,000 lines with 16 mistakes. Each mistake causes only a few
  conflicts, so Z3's cores are already small, and minimizing them costs SAT
  calls on a large formula.

---

## Findings about the existing inferencer

Building a second, declarative solver next to the union-find solver turned up
the following. None of them was changed in `infer.js`/`solver.js`: they are
design decisions of the inferencer, and changing them changes its behaviour
(and possibly the expected outputs of its regression tests). They are
documented here so that they can be decided on, and the generator avoids them.

1. **Order dependence of deferred constraints in `solver.js`.** `+`, `?:` and
   `&&`/`||` are resolved after the main pass, in one pass, with heuristics.
   One such heuristic is "`str + unknown` makes the unknown a string". In

   ```js
   function label(text, k) {
     const head = text.toUpperCase();
     return head + k;          // k is still unknown when this + is resolved
   }
   const xs = [1, 2, 3];
   const n = xs.length + 2;    // n = num, but this + is resolved later
   const s = label("a", n);
   ```

   `k` becomes `str`, and the later resolution of `n` (`num`) then conflicts
   (`examples/order_dependence.js`). The program is well typed, and the SMT
   encoding finds `k : num`. On generated programs this happens in 7 of 20
   programs of 1,600 lines.
2. **A Promise is never checked against an object or an array.** `_initObj`
   and `_initArr` check base types, arrays/objects and classes, but not
   promises, so `p.thne(...)` and `p[0]` on a promise are accepted.
3. **Arrays mix with base types.** A variable used both as an array and as a
   number becomes `num | Array<T>` instead of a conflict (`[1, 2] * 2` is
   accepted).
4. **`+` accepts any operands** except a number with an object: `true + 1`,
   `void + 1` (the result of a function that forgot to `return`) and `{} + {}`
   are not errors. Similarly, **indexing a number** with a number (`i[i]`) is
   accepted by `resolveIndex`.
5. **Cached method instances are monomorphic.** `a.map(x => x + 1)` and
   `a.map(x => "v" + x)` on the same array share one `map` type, so the two
   result types conflict.
6. **Computed writes conflict with arrays.** `arr[i] = v` adds `arr <= {}`.
7. **`String(n)`, `console.log(n)`** conflict with numbers: their summaries
   declare an object parameter.
8. **`const n = s.length`** (a statement-level assignment) and `s.slice(...)` on a
   string variable without a type hint constrain the variable to be an object:
   `handleRHS` lacks the special case that `inferExpr` has for `.length`.
9. **Eager type hints.** `infer.js` decides some method dispatches using types
   guessed from *earlier* lines (`typeHints`). The constraints of a line can
   therefore depend on other lines, which is a threat to the "drop a line" model
   (see below).

---

## Limitations and threats to validity

* **Granularity is the line.** Several statements on one line are one
  candidate; one statement over several lines is several candidates (the
  innermost node decides). A method chain split over lines belongs to the line
  where each call expression starts, not the line of the method name. Grouping
  by statement or by expression would be a small change in `encode.py`.
* **Dropping a line does not re-run inference.** Because of the eager type hints
  (finding 9), the constraints that `infer.js` generates for later lines can
  depend on the mistake. For 8 of 849 single-mistake mutants (not counting
  forgotten `return`s) the mistake line alone is therefore not a correction
  subset, even though its code is not missing. Re-running inference without the
  dropped line would remove this effect, at the price of one inference run per
  candidate.
* **The tie-breaking results depend on where the mutation operators put
  mistakes.** `wrong-var` and `misspell-prop` change a use; `literal` mostly
  changes a definition. "Latest line first" looks good overall partly because
  use-site mistakes are frequent in this benchmark. Real mistakes may be
  distributed differently, so the per-operator tables matter more than the totals.
* **Synthetic programs.** The generated programs exercise the core subset, but
  their structure (one definition per line, short functions) is regular.
* **The test programs are small** (5–30 lines), which inflates ties: a
  definition with a single use always gives two equally small candidates.
* **Timing** was measured on a 4-core cloud machine, 3 programs in parallel,
  with other jobs running at times. Absolute times are indicative, but the
  comparison between algorithms on the same programs is fair.
* **Semantics.** The encoding is stricter than `solver.js` in four documented
  ways (§2.4). Using `--plus lenient` brings back the `+` rule of `solver.js`.

---

## Reproducing everything

```bash
npm install
```

```bash
pip install -r requirements.txt
```

```bash
./run_tests.sh
```

```bash
python -m pytest tests -q
```

```bash
python bench/run_experiments.py all
```

```bash
python bench/report.py
```

`run_experiments.py all` takes about 15 minutes on 4 cores (the scaling
experiment dominates). The single experiments are `mutants`, `generated`, `multi` and
`scaling`; see `--help` for sizes, seeds and timeouts. Everything is seeded
and deterministic except the running times.

---

## Repository map

| path | what |
|---|---|
| `infer.js` | constraint generation (existing); `--json` with source origins |
| `solver.js` | union-find solver (existing); `--json` with the constraint of each conflict |
| `summaries.js`, `stubs.js`, `gen_stubs.js` | library signatures (existing) |
| `Tests/`, `run_tests.sh` | regression tests of the inferencer (existing, unchanged) |
| `localizer/terms.py` | parser for the type terms printed by `infer.js` |
| `localizer/constraints.py` | runs `infer.js --json` / `solver.js --json`, constraint data model |
| `localizer/encode.py` | SMT encoding, closed-world fields, printing models |
| `localizer/mcs.py` | OLL, implicit hitting sets, Z3; MCS enumeration |
| `localizer/rank.py` | ranking strategies, Pareto fronts, random tie-breaking |
| `localizer/baseline.py` | first-conflict baselines |
| `localizer/__main__.py` | command line (`python -m localizer`) |
| `tests/test_localizer.py` | tests of the localizer |
| `bench/mutate.js` | mutation tool |
| `bench/generate.py` | generator of well-typed programs |
| `bench/evaluate.py`, `bench/run_experiments.py`, `bench/report.py` | experiments |
| `bench/corpus/` | the generated base programs used in the experiments |
| `results/` | CSV results, `summary.md`, plots |
| `examples/` | the small programs used in this README |
| `docs/inferencer-constructs.md` | the JavaScript constructs `infer.js` supports (the previous README) |

---

## References

1. Z. Pavlinovic, T. King, T. Wies. *Finding minimum type error sources.* OOPSLA 2014.
2. C. Loncaric, S. Chandra, C. Schlesinger, M. Sridharan. *A practical framework for type inference error explanation.* OOPSLA 2016.
3. S. Fu, T. Dwyer, P. J. Stuckey, J. Grundy. *Goanna: resolving Haskell type errors with minimal correction subsets.* arXiv:2405.12697, 2024.
4. J. Davies, F. Bacchus. *Solving MAXSAT by solving a sequence of simpler SAT instances.* CP 2011.
5. M. Terra-Neves, I. Lynce, V. Manquinho. *Multi-objective optimization through Pareto minimal correction subsets.* IJCAI 2018.
6. B. Andres, B. Kaufmann, O. Matheis, T. Schaub. *Unsatisfiability-based optimization in clasp.* ICLP 2012 (OLL).
7. A. Morgado, C. Dodaro, J. Marques-Silva. *Core-guided MaxSAT with soft cardinality constraints.* CP 2014.
8. A. Ignatiev, A. Morgado, J. Marques-Silva. *RC2: an efficient MaxSAT solver.* JSAT 2019 (PySAT's RC2, used for hitting sets).
9. N. Bjørner, A.-D. Phan, L. Fleckenstein. *νZ – an optimizing SMT solver.* TACAS 2015 (Z3's MaxSMT).
