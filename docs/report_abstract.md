When type inference fails, a conventional checker reports the first conflict it
meets, which is often not where the mistake is. This report describes a
localizer for a core subset of JavaScript that asks instead *which lines can be
dropped, as few as possible, so that the rest of the program is typable*. The
typing constraints of the existing inferencer, tagged with their source lines,
are encoded into one SMT formula with a selector per line; three MaxSMT
algorithms (core-guided OLL, implicit hitting sets, Z3) list the minimal
correction subsets in order of cost, which are ranked, completed by hints for
missing code and likely fixes, and explained.

On single injected mistakes, the mistake line is a smallest correction subset in
99–100% of the cases when its constraints take part in the conflict, and the
full pipeline ranks it first in 84% (test suite) and 97% (generated programs) of
the cases and among the first three in 100%, against 76% and 71% for a
first-conflict checker. With several mistakes it keeps 83–88% of them among its
first answers (first conflict: 50–55%). Programs of 8,000 lines are localized in
17–21 seconds by OLL and IHS, with no timeouts.

On real bug fixes (44,881 function pairs from FixJS, the 453 bugs of BugsJS),
about one fix in 80 is a type error that this type system sees. On the small
ones the pipeline ranks a changed line first in 70% of the cases and among the
first three in 91% (first conflict: 57%). A relaxed type system for real
JavaScript, its rules chosen by ablation, removes 42% of the false alarms on real
functions and still finds 99.6% of the injected mistakes.

The report covers the design and why it is correct, the benchmarks, the answers
to the three research questions, and every improvement made afterwards, each
measured. Code, scripts and results are in the project repository; every number
can be reproduced with the commands in *Reproducing everything*.
