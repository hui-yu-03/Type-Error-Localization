"""Smallest correction subsets of the line groups (MaxSAT/MaxSMT).

A *correction subset* is a set M of lines such that the constraints of all
other lines (plus the hard constraints) are satisfiable.  With a weight w(L) > 0
for every line, a minimum-cost correction subset is the complement of an
optimal MaxSMT solution in which "keep line L" (the selector sel_L) is a soft
constraint of weight w(L).  Minimum-cost correction subsets are minimal (MCSs).

Three interchangeable algorithms enumerate MCSs in order of non-decreasing cost:

  OLL     core-guided MaxSMT (Andres et al. 2012; Morgado et al. 2014), with
          stratification; cardinality constraints over cores via Z3 AtLeast.
  IHS     implicit hitting sets (Davies & Bacchus 2011): an exact hitting-set
          solver (RC2 MaxSAT from PySAT) proposes candidate sets of lines to
          drop, the SMT solver either accepts them or returns a new core.
  Z3Opt   Z3's built-in MaxSMT (Optimize, core-guided maxres), as a reference.

Enumeration: after an MCS M is found, the clause OR_{L in M} sel_L (keep at
least one line of M) is added and the search continues.  It excludes M and its
supersets.  The next optimum is then again minimal: a cheaper correction subset
contained in it would either have been found already (and blocked, so its
supersets are excluded) or would contradict optimality.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Iterator, Optional

import z3
from pysat.examples.rc2 import RC2
from pysat.formula import WCNF

from .encode import Encoding


class Timeout(Exception):
    pass


class HardConflict(Exception):
    """The hard (library) constraints alone are unsatisfiable."""


@dataclass(frozen=True)
class MCS:
    lines: frozenset
    cost: int
    time: float  # seconds since the start of the enumeration

    def sorted(self) -> list[int]:
        return sorted(self.lines)


@dataclass
class Stats:
    sat_calls: int = 0
    cores: int = 0
    core_sizes: list = field(default_factory=list)
    hs_calls: int = 0
    time: float = 0.0


class Enumerator:
    name = "base"

    def __init__(
        self,
        enc: Encoding,
        weights: Optional[dict[int, int]] = None,
        timeout: Optional[float] = None,
        minimize_cores: bool = True,
    ) -> None:
        self.enc = enc
        self.lines = enc.lines
        self.weights = {L: int((weights or {}).get(L, 1)) for L in self.lines}
        if any(w <= 0 for w in self.weights.values()):
            raise ValueError("weights must be positive")
        self.timeout = timeout
        self.minimize_cores = minimize_cores
        self.stats = Stats()
        self._t0 = time.perf_counter()
        self.sel = enc.selectors
        self.line_of = {self.sel[L].get_id(): L for L in self.lines}

    # -- helpers ---------------------------------------------------------------
    def elapsed(self) -> float:
        return time.perf_counter() - self._t0

    def remaining_ms(self) -> Optional[int]:
        if self.timeout is None:
            return None
        rem = self.timeout - self.elapsed()
        if rem <= 0:
            raise Timeout()
        return max(1, int(rem * 1000))

    def check(self, s: z3.Solver, assumptions: list) -> z3.CheckSatResult:
        ms = self.remaining_ms()
        if ms is not None:
            s.set("timeout", ms)
        self.stats.sat_calls += 1
        r = s.check(*assumptions)
        if r == z3.unknown:
            raise Timeout()
        return r

    def minimize(self, s: z3.Solver, core: list) -> list:
        """Shrink an unsat core of assumption literals (trimming + deletion)."""
        if not self.minimize_cores or len(core) <= 1:
            return core
        for _ in range(3):  # trimming: re-solve under the core itself
            if self.check(s, core) != z3.unsat:
                return core
            new = list(s.unsat_core())
            if len(new) >= len(core):
                break
            core = new
        i = 0
        while i < len(core) and len(core) > 1:  # deletion-based minimization
            trial = core[:i] + core[i + 1 :]
            if self.check(s, trial) == z3.unsat:
                kept = {x.get_id() for x in s.unsat_core()}
                core = [x for x in trial if x.get_id() in kept]
            else:
                i += 1
        return core

    def mcs_from_model(self, model: z3.ModelRef) -> frozenset:
        """Lines whose constraints the model violates.

        Evaluating the groups themselves (rather than the selectors) is robust
        against selectors that Z3 leaves unassigned: every group that holds in
        the model can be kept together with the hard constraints.
        """
        return frozenset(
            L
            for L in self.lines
            if not z3.is_true(model.eval(self.enc.groups[L], model_completion=True))
        )

    def cost(self, lines) -> int:
        return sum(self.weights[L] for L in lines)

    def enumerate(self, limit: Optional[int] = None) -> Iterator[MCS]:
        raise NotImplementedError

    def first(self) -> Optional[MCS]:
        return next(iter(self.enumerate(limit=1)), None)


class OLL(Enumerator):
    name = "oll"

    def enumerate(self, limit: Optional[int] = None) -> Iterator[MCS]:
        self._t0 = time.perf_counter()
        s = self.enc.solver()
        if self.check(s, []) == z3.unsat:
            raise HardConflict()
        weight: dict[int, int] = {}  # assumption literal id -> remaining weight
        lit: dict[int, z3.BoolRef] = {}  # id -> assumption literal
        sums: dict[int, tuple] = {}  # id of ~o_k -> (totalizer, k)
        for L in self.lines:
            x = self.sel[L]
            weight[x.get_id()] = self.weights[L]
            lit[x.get_id()] = x
        lb = 0
        found = 0
        totalizers: list[dict] = []

        def not_output(tot: dict, k: int) -> z3.BoolRef:
            """~o_k of a totalizer, where AtLeast(inputs, k) -> o_k: assuming
            ~o_k allows fewer than k of the inputs (violated literals) to hold."""
            if k not in tot["outputs"]:
                o = z3.Bool(f"oll!{tot['id']}!{k}")
                s.add(z3.Implies(z3.AtLeast(*tot["inputs"], k), o))
                tot["outputs"][k] = o
            return z3.Not(tot["outputs"][k])

        while True:
            levels = sorted({w for w in weight.values() if w > 0}, reverse=True)
            level = 0
            while True:  # stratification: heaviest literals first
                thr = levels[level] if levels else 0
                assumptions = [lit[i] for i, w in weight.items() if w >= thr and w > 0]
                r = self.check(s, assumptions)
                if r == z3.sat:
                    if level + 1 < len(levels):
                        level += 1
                        continue
                    break
                core = self.minimize(s, list(s.unsat_core()))
                if not core:
                    return  # no further correction subsets
                self.stats.cores += 1
                self.stats.core_sizes.append(len(core))
                wmin = min(weight[x.get_id()] for x in core)
                lb += wmin
                for x in core:
                    i = x.get_id()
                    weight[i] -= wmin
                    if i in sums:  # ~o_k violated: now allow k violations
                        tot, k = sums[i]
                        if k + 1 <= len(tot["inputs"]):
                            nx = not_output(tot, k + 1)
                            j = nx.get_id()
                            weight[j] = weight.get(j, 0) + wmin
                            lit[j] = nx
                            sums[j] = (tot, k + 1)
                if len(core) > 1:
                    tot = {"id": len(totalizers), "inputs": [z3.Not(x) for x in core], "outputs": {}}
                    totalizers.append(tot)
                    nx = not_output(tot, 2)
                    j = nx.get_id()
                    weight[j] = weight.get(j, 0) + wmin
                    lit[j] = nx
                    sums[j] = (tot, 2)
                else:
                    s.add(z3.Not(core[0]))
                levels = sorted({w for w in weight.values() if w > 0}, reverse=True)
                level = 0
            mcs = self.mcs_from_model(s.model())
            assert self.cost(mcs) == lb, (self.cost(mcs), lb)
            yield MCS(mcs, lb, self.elapsed())
            found += 1
            if not mcs or (limit is not None and found >= limit):
                return
            s.add(z3.Or([self.sel[L] for L in mcs]))  # block mcs and its supersets


class IHS(Enumerator):
    name = "ihs"

    def __init__(self, *args, greedy: bool = True, disjoint: bool = True, **kw) -> None:
        super().__init__(*args, **kw)
        self.greedy = greedy
        self.disjoint = disjoint

    def enumerate(self, limit: Optional[int] = None) -> Iterator[MCS]:
        self._t0 = time.perf_counter()
        s = self.enc.solver()
        if self.check(s, []) == z3.unsat:
            raise HardConflict()
        var = {L: i + 1 for i, L in enumerate(self.lines)}  # x_L: "drop line L"
        cores: list[frozenset] = []
        wcnf = WCNF()
        for L in self.lines:
            wcnf.append([-var[L]], weight=self.weights[L])
        hs_solver = RC2(wcnf)
        blocked: list[frozenset] = []

        def add_core(core_lits) -> frozenset:
            core = frozenset(self.line_of[x.get_id()] for x in core_lits)
            cores.append(core)
            self.stats.cores += 1
            self.stats.core_sizes.append(len(core))
            hs_solver.add_clause([var[L] for L in core])
            return core

        def keep_all_but(drop) -> list:
            return [self.sel[L] for L in self.lines if L not in drop]

        if self.disjoint:  # seed with disjoint cores
            dropped: set = set()
            while True:
                if self.check(s, keep_all_but(dropped)) == z3.sat:
                    break
                core_lits = self.minimize(s, list(s.unsat_core()))
                if not core_lits:
                    return
                dropped |= add_core(core_lits)

        found = 0
        while True:
            self.stats.hs_calls += 1
            model = hs_solver.compute()
            if model is None:
                return  # every correction subset has been blocked
            hs = frozenset(L for L in self.lines if model[var[L] - 1] > 0)
            if self.check(s, keep_all_but(hs)) == z3.sat:
                yield MCS(hs, self.cost(hs), self.elapsed())
                found += 1
                if not hs or (limit is not None and found >= limit):
                    return
                blocked.append(hs)
                hs_solver.add_clause([-var[L] for L in hs])
                continue
            core_lits = self.minimize(s, list(s.unsat_core()))
            if not core_lits:
                return
            add_core(core_lits)
            if self.greedy:  # cheap non-optimal hitting sets harvest more cores
                while True:
                    g = self._greedy_hs(cores, blocked)
                    if g is None or self.check(s, keep_all_but(g)) == z3.sat:
                        break
                    core_lits = self.minimize(s, list(s.unsat_core()))
                    if not core_lits:
                        return
                    add_core(core_lits)

    def _greedy_hs(self, cores: list[frozenset], blocked: list[frozenset]) -> Optional[frozenset]:
        chosen: set = set()
        todo = [c for c in cores]
        while todo:
            score: dict = {}
            for c in todo:
                for L in c:
                    score[L] = score.get(L, 0) + 1
            best = max(score, key=lambda L: (score[L] / self.weights[L], -self.enc.order[L]))
            chosen.add(best)
            todo = [c for c in todo if best not in c]
        if any(b <= chosen for b in blocked):
            return None  # would re-propose a blocked set; leave it to the exact solver
        return frozenset(chosen)


class Z3Opt(Enumerator):
    name = "z3"

    def __init__(self, *args, engine: str = "maxres", **kw) -> None:
        super().__init__(*args, **kw)
        self.engine = engine

    def enumerate(self, limit: Optional[int] = None) -> Iterator[MCS]:
        self._t0 = time.perf_counter()
        opt = z3.Optimize()
        opt.set("maxsat_engine", self.engine)
        opt.add(*self.enc.hard)
        for L, f in self.enc.groups.items():
            opt.add(z3.Implies(self.sel[L], f))
            opt.add_soft(self.sel[L], self.weights[L])
        found = 0
        first = True
        while True:
            ms = self.remaining_ms()
            if ms is not None:
                opt.set("timeout", ms)
            self.stats.sat_calls += 1
            r = opt.check()
            if r == z3.unknown:
                raise Timeout()
            if r == z3.unsat:
                if first:
                    raise HardConflict()
                return
            first = False
            mcs = self.mcs_from_model(opt.model())
            yield MCS(mcs, self.cost(mcs), self.elapsed())
            found += 1
            if not mcs or (limit is not None and found >= limit):
                return
            opt.add(z3.Or([self.sel[L] for L in mcs]))


ALGORITHMS = {"oll": OLL, "ihs": IHS, "z3": Z3Opt}


def make(algorithm: str, enc: Encoding, **kw) -> Enumerator:
    return ALGORITHMS[algorithm](enc, **kw)
