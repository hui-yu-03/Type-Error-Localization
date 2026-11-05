# Real buggy programs: bugsjs_relaxed

486 pairs; the buggy version is ill-typed in 50, and the fixed version well typed in 4 of those (type errors the type system sees).

| method | top-1 (%) | top-3 (%) |
|---|---|---|
| first conflict (solver.js) | 50 | 50 |
| first conflict (SMT order) | 75 | 75 |
| MCS card, latest first | 75 | 100 |
| MCS learned | 75 | 100 |
| full pipeline | 75 | 100 |
| random line (expected) | 22 | 49 |
