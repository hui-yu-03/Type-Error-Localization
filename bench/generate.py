"""Random generator of larger, well-typed programs in the core subset.

    python bench/generate.py --lines 200 --seed 1 > prog.js

Statements are drawn from templates that use previously defined variables of
the right type, so that lines depend on each other the way real code does:
numbers, strings, booleans, arrays, objects with fields, named functions,
arrow functions, promises with then, async functions with await, loops and
conditionals.  Mistakes are injected afterwards with bench/mutate.js.

The templates avoid some imprecisions of the inferencer (see README): calling a
polymorphic array method twice on the same array with different result types,
computed writes arr[i] = v, String(n) / console.log(n) (their summaries expect
an object), and `const n = s.length` or s.slice(...) on a string variable the
inferencer has no type hint for (it then assumes an object).
"""

from __future__ import annotations

import argparse
import random

WORDS = ["alpha", "beta", "gamma", "delta", "item", "node", "user", "key", "path", "tag"]


class Gen:
    def __init__(self, seed: int, ns: str = "") -> None:
        self.r = random.Random(seed)
        self.ns = ns  # name prefix of this module
        self.n = 0
        self.vars: dict[str, list[str]] = {
            t: [] for t in ("num", "str", "bool", "arr_num", "arr_str", "obj", "prom_num", "prom_str", "mut_num")
        }
        self.funcs: dict[str, list[str]] = {k: [] for k in ("nn_n", "sn_s", "n_b", "o_s", "n_pn")}
        self.lines: list[str] = []

    # -- helpers -------------------------------------------------------------------
    def name(self, prefix: str) -> str:
        self.n += 1
        return f"{self.ns}{prefix}{self.n}"

    def lit(self) -> str:
        return str(self.r.randint(1, 99))

    def word(self) -> str:
        return self.r.choice(WORDS)

    def pick(self, t: str) -> str:
        """A variable of type t, biased towards recent ones."""
        vs = self.vars[t]
        i = len(vs) - 1 - min(int(self.r.expovariate(0.3)), len(vs) - 1)
        return vs[i]

    def has(self, *types: str) -> bool:
        return all(self.vars[t] for t in types)

    def emit(self, *lines: str) -> None:
        self.lines.extend(lines)

    def define(self, t: str, prefix: str, expr: str) -> None:
        v = self.name(prefix)
        self.emit(f"const {v} = {expr};")
        self.vars[t].append(v)

    # -- templates ---------------------------------------------------------------
    def prelude(self) -> None:
        self.define("num", "n", self.lit())
        self.define("str", "s", f'"{self.word()}"')
        self.define("bool", "b", self.r.choice(["true", "false"]))
        self.define("arr_num", "xs", f"[{self.lit()}, {self.lit()}, {self.lit()}]")
        self.define("arr_str", "ws", f'["{self.word()}", "{self.word()}"]')
        self.define("obj", "o", f'{{ id: {self.lit()}, name: "{self.word()}", active: true }}')
        v = self.name("acc")
        self.emit(f"let {v} = 0;")
        self.vars["mut_num"].append(v)

    def stmt(self) -> None:
        r = self.r
        choices = [
            (6, self.num_expr),
            (5, self.str_expr),
            (3, self.bool_expr),
            (2, self.arr_expr),
            (2, self.obj_expr),
            (2, self.obj_write),
            (2, self.fun_decl),
            (4, self.call),
            (3, self.promise),
            (2, self.async_fun),
            (1, self.loop),
            (1, self.cond),
            (1, self.push),
        ]
        total = sum(w for w, _ in choices)
        x = r.uniform(0, total)
        for w, f in choices:
            x -= w
            if x <= 0:
                f()
                return
        choices[-1][1]()

    def num_expr(self) -> None:
        r = self.r
        opts = [
            lambda: f"{self.pick('num')} * {self.lit()} + {self.pick('num')}",
            lambda: f"{self.pick('num')} - {self.pick('num')}",
            lambda: f"{self.pick('arr_num')}.length + {self.lit()}",
            lambda: f"{self.pick('arr_num')}[{r.randint(0, 2)}] * {self.lit()}",
            lambda: f"{self.pick('obj')}.id + {self.pick('num')}",
            lambda: f"{self.pick('str')}.length + {self.lit()}",
            lambda: f"Math.max({self.pick('num')}, {self.pick('num')})",
            lambda: f"{self.pick('bool')} ? {self.pick('num')} : {self.pick('num')}",
        ]
        self.define("num", "n", r.choice(opts)())

    def str_expr(self) -> None:
        r = self.r
        opts = [
            lambda: f'{self.pick("str")} + "-" + {self.pick("num")}',
            lambda: f"{self.pick('str')}.toUpperCase()",
            lambda: f"{self.pick('str')}.repeat({r.randint(1, 3)})",
            lambda: f"`${{{self.pick('str')}}}:${{{self.pick('num')}}}`",
            lambda: f"{self.pick('obj')}.name + {self.pick('str')}",
            lambda: f'{self.pick("arr_str")}.join(", ")',
            lambda: f'{self.pick("str")}.padStart({self.lit()}, "0")',
            lambda: f"`${{{self.pick('num')}}}`",
        ]
        self.define("str", "s", r.choice(opts)())

    def bool_expr(self) -> None:
        r = self.r
        opts = [
            lambda: f"{self.pick('num')} > {self.pick('num')}",
            lambda: f'{self.pick("str")}.startsWith("{self.word()[0]}")',
            lambda: f"{self.pick('obj')}.active && {self.pick('bool')}",
            lambda: f"{self.pick('arr_num')}.includes({self.pick('num')})",
            lambda: f"{self.pick('str')} === {self.pick('str')}",
        ]
        self.define("bool", "b", r.choice(opts)())

    def arr_expr(self) -> None:
        r = self.r
        if r.random() < 0.5:
            self.define("arr_num", "xs", f"[{self.pick('num')}, {self.pick('num')}, {self.lit()}]")
        elif r.random() < 0.5:
            self.define("arr_str", "ws", f'{self.pick("str")}.split(",")')
        else:
            self.define("arr_str", "ws", f"[{self.pick('str')}, {self.pick('str')}]")

    def obj_expr(self) -> None:
        self.define("obj", "o", f"{{ id: {self.pick('num')}, name: {self.pick('str')}, active: {self.pick('bool')} }}")

    def obj_write(self) -> None:
        o = self.pick("obj")
        if self.r.random() < 0.5:
            self.emit(f"{o}.name = {self.pick('str')};")
        else:
            self.emit(f"{o}.id = {self.pick('num')} + {self.lit()};")

    def push(self) -> None:
        self.emit(f"{self.pick('arr_num')}.push({self.pick('num')});")

    def fun_decl(self) -> None:
        r = self.r
        kind = r.choice(["nn_n", "sn_s", "n_b", "o_s", "arrow"])
        f = self.name("f")
        if kind == "nn_n":
            self.emit(f"function {f}(x, y) {{", f"  const t = x * y;", f"  return t + {self.lit()};", "}")
        elif kind == "sn_s":
            self.emit(f"function {f}(text, k) {{", "  const head = text.toUpperCase();", '  return head.padStart(k, "*");', "}")
        elif kind == "n_b":
            self.emit(f"function {f}(v) {{", f"  return v > {self.lit()};", "}")
        elif kind == "o_s":
            self.emit(f"function {f}(item) {{", '  const label = item.name + "#" + item.id;', "  return label;", "}")
        else:
            kind = "nn_n"
            self.emit(f"const {f} = (a, b) => a * b + {self.lit()};")
        self.funcs[kind].append(f)

    def call(self) -> None:
        avail = [k for k, fs in self.funcs.items() if fs and k != "n_pn"]
        if not avail:
            return self.fun_decl()
        k = self.r.choice(avail)
        f = self.r.choice(self.funcs[k])
        if k == "nn_n":
            self.define("num", "n", f"{f}({self.pick('num')}, {self.pick('num')})")
        elif k == "sn_s":
            self.define("str", "s", f"{f}({self.pick('str')}, {self.pick('num')})")
        elif k == "n_b":
            self.define("bool", "b", f"{f}({self.pick('num')})")
        else:
            self.define("str", "s", f"{f}({self.pick('obj')})")

    def promise(self) -> None:
        r = self.r
        if not self.vars["prom_num"] or r.random() < 0.3:
            self.define("prom_num", "p", f"Promise.resolve({self.pick('num')})")
        elif r.random() < 0.6:
            self.define("prom_num", "p", f"{self.pick('prom_num')}.then(v => v * {self.lit()})")
        else:
            self.define("prom_str", "p", f'{self.pick("prom_num")}.then(v => "#" + v)')

    def async_fun(self) -> None:
        if not self.vars["prom_num"]:
            return self.promise()
        g = self.name("g")
        if self.funcs["n_pn"] and self.r.random() < 0.5:
            h = self.r.choice(self.funcs["n_pn"])
            self.emit(f"async function {g}(k) {{", f"  const w = await {h}(k);", f"  return w + {self.pick('num')};", "}")
        else:
            p = self.pick("prom_num")
            self.emit(f"async function {g}(k) {{", f"  const w = await {p};", "  return w * k;", "}")
        self.funcs["n_pn"].append(g)
        self.define("prom_num", "p", f"{g}({self.pick('num')})")

    def loop(self) -> None:
        acc, xs = self.pick("mut_num"), self.pick("arr_num")
        i = f"{self.ns}i"  # infer.js has no block scopes: one loop variable per module
        self.emit(f"for (let {i} = 0; {i} < {xs}.length; {i}++) {{", f"  {acc} = {acc} + {xs}[{i}];", "}")

    def cond(self) -> None:
        acc = self.pick("mut_num")
        self.emit(f"if ({self.pick('bool')}) {{", f"  {acc} = {acc} + {self.pick('num')};", "} else {",
                  f"  {acc} = {acc} - {self.lit()};", "}")


def generate(lines: int, seed: int, modules: int = 1) -> str:
    """A program of about `lines` lines.  With modules > 1 it consists of
    independent parts (own variables and functions), like the separate
    functions or modules of real code; the SMT formula then has one
    component per part."""
    out: list[str] = []
    for m in range(modules):
        if modules == 1:
            g = Gen(seed)  # (the seeding of the committed corpora)
        else:
            g = Gen(seed * 1000 + m, ns=f"m{m}_")
        g.prelude()
        while len(g.lines) < lines // modules:
            g.stmt()
        out += g.lines
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--lines", type=int, default=100)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--modules", type=int, default=1)
    a = ap.parse_args()
    print(generate(a.lines, a.seed, a.modules), end="")
