"""Ranking candidate correction subsets (question Q2).

Several MCSs are often equally small (two conflicting lines already give two
candidates), so the order in which they are shown matters.  Strategies:

  card        fewest lines first; ties in source order (earliest line first)
  card-late   fewest lines first; ties: latest line first
  card-size   fewest lines first; ties: fewer constraints first
  size        weight of a line = number of constraints it generates, i.e. blame
              as little of the program as possible (the cost function of
              Pavlinovic et al. is the size of the blamed expressions)
  pareto      two criteria at once, (number of lines, number of constraints):
              non-dominated sorting of the enumerated MCSs (layer 1 = the
              Pareto-optimal correction subsets, cf. Terra-Neves et al. 2018)

The ranked list of suspicious lines is obtained by flattening the ordered
candidates: a line's rank is the number of distinct lines in the candidates up
to and including the first one that contains it (ties inside a candidate are
counted pessimistically).
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

from . import mcs as mcs_mod
from .encode import Encoding

STRATEGIES = ("card", "card-late", "card-size", "size", "pareto")


@dataclass(frozen=True)
class Candidate:
    lines: tuple  # sorted line numbers
    card: int
    size: int  # number of constraints in these lines


@dataclass
class Ranking:
    strategy: str
    candidates: list[Candidate]
    complete: bool = True  # False if the enumeration was cut short
    time: float = 0.0
    stats: dict = field(default_factory=dict)

    @property
    def lines(self) -> list[int]:
        out: list[int] = []
        for c in self.candidates:
            for L in c.lines:
                if L not in out:
                    out.append(L)
        return out

    def rank_of(self, line: int) -> Optional[int]:
        return line_ranks(self.candidates).get(line)


def line_ranks(candidates: list[Candidate]) -> dict[int, int]:
    seen: set[int] = set()
    ranks: dict[int, int] = {}
    for c in candidates:
        new = [L for L in c.lines if L not in seen]
        seen.update(new)
        for L in new:
            ranks[L] = len(seen)
    return ranks


def size_weights(enc: Encoding) -> dict[int, int]:
    return {L: max(1, enc.group_sizes.get(L, 1)) for L in enc.lines}


@dataclass
class Pool:
    """MCSs enumerated in order of non-decreasing cost under some weights.

    complete: every cost tier in the pool is whole (the enumeration stopped
    between tiers, or found all MCSs), so tie-breaking inside tiers is exact.
    exhausted: the pool contains all MCSs of the program.
    """

    mcses: list
    complete: bool
    exhausted: bool
    time: float
    stats: object


def enumerate_pool(
    enc: Encoding,
    weights: Optional[dict[int, int]] = None,
    algorithm: str = "oll",
    min_count: int = 10,
    hard_cap: int = 30,
    timeout: Optional[float] = None,
) -> Pool:
    """Enumerate at least min_count MCSs, then finish the current cost tier
    (but never keep more than hard_cap)."""
    t0 = time.perf_counter()
    en = mcs_mod.make(algorithm, enc, weights=weights, timeout=timeout)
    found: list = []
    complete, exhausted = True, False
    try:
        for m in en.enumerate():
            if len(found) >= min_count and m.cost > found[-1].cost:
                break  # the tiers kept so far are whole
            if len(found) >= hard_cap:
                complete = False
                break
            found.append(m)
        else:
            exhausted = True
    except mcs_mod.Timeout:
        complete = False
    return Pool(found, complete, exhausted, time.perf_counter() - t0, en.stats)


def to_candidate(enc: Encoding, lines) -> Candidate:
    lines = tuple(sorted(lines))
    return Candidate(lines, len(lines), sum(enc.group_sizes.get(L, 0) for L in lines))


def order(cands: list[Candidate], key: Callable) -> list[Candidate]:
    return sorted(cands, key=key)


def pareto_layers(cands: list[Candidate]) -> list[list[Candidate]]:
    """Non-dominated sorting w.r.t. (card, size), both minimized."""
    rest = list(dict.fromkeys(cands))
    layers = []
    while rest:
        front = [
            c
            for c in rest
            if not any(
                (d.card <= c.card and d.size <= c.size) and (d.card < c.card or d.size < c.size)
                for d in rest
            )
        ]
        layers.append(sorted(front, key=lambda c: (c.card, c.size, c.lines)))
        rest = [c for c in rest if c not in front]
    return layers


def rank_from_pools(enc: Encoding, card_pool: Pool, size_pool: Optional[Pool] = None) -> dict[str, Ranking]:
    """All strategies from (at most) two enumerations."""
    out: dict[str, Ranking] = {}
    card = [to_candidate(enc, m.lines) for m in card_pool.mcses]
    keys = {
        "card": lambda c: (c.card, c.lines),
        "card-late": lambda c: (c.card, tuple(-L for L in reversed(c.lines))),
        "card-size": lambda c: (c.card, c.size, c.lines),
    }
    for name, key in keys.items():
        out[name] = Ranking(name, order(card, key), card_pool.complete, card_pool.time)
    if size_pool is not None:
        size = [to_candidate(enc, m.lines) for m in size_pool.mcses]
        out["size"] = Ranking(
            "size", order(size, lambda c: (c.size, c.card, c.lines)), size_pool.complete, size_pool.time
        )
        # Every Pareto-optimal correction subset is an MCS (both criteria grow
        # with the set), so the front is found among the enumerated MCSs; the
        # union of the two pools contains the optimum of each criterion.
        union = list(dict.fromkeys(card + size))
        layers = pareto_layers(union)
        out["pareto"] = Ranking(
            "pareto",
            [c for layer in layers for c in layer],
            card_pool.complete and size_pool.complete,
            card_pool.time + size_pool.time,
            {"front": [c.lines for c in layers[0]] if layers else []},
        )
    return out


def rank(
    enc: Encoding,
    strategy: str = "card",
    algorithm: str = "oll",
    min_count: int = 10,
    hard_cap: int = 30,
    timeout: Optional[float] = None,
) -> Ranking:
    card_pool = enumerate_pool(enc, None, algorithm, min_count, hard_cap, timeout)
    size_pool = None
    if strategy in ("size", "pareto"):
        size_pool = enumerate_pool(enc, size_weights(enc), algorithm, min_count, hard_cap, timeout)
    return rank_from_pools(enc, card_pool, size_pool)[strategy]


def random_tiebreak(cands: list[Candidate], target: int, k_values=(1, 3), trials: int = 500, seed: int = 0) -> dict:
    """Top-k probabilities and expected rank of `target` when the candidates of
    equal cardinality are shown in a uniformly random order."""
    rng = random.Random(seed)
    tiers: dict[int, list[Candidate]] = {}
    for c in cands:
        tiers.setdefault(c.card, []).append(c)
    hits = {k: 0 for k in k_values}
    total_rank = 0.0
    found = 0
    for _ in range(trials):
        seq = []
        for card in sorted(tiers):
            t = tiers[card][:]
            rng.shuffle(t)
            seq.extend(t)
        r = line_ranks(seq).get(target)
        if r is not None:
            found += 1
            total_rank += r
            for k in k_values:
                hits[k] += r <= k
    out = {f"top{k}": hits[k] / trials for k in k_values}
    out["mean_rank"] = total_rank / found if found else None
    return out
