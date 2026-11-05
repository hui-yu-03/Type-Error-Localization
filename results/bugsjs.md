# Real buggy programs: bugsjs

486 pairs; the buggy version is ill-typed in 107, and the fixed version well typed in 6 of those (type errors the type system sees).

| method | top-1 (%) | top-3 (%) |
|---|---|---|
| first conflict (solver.js) | 50 | 67 |
| first conflict (SMT order) | 50 | 67 |
| MCS card, latest first | 50 | 67 |
| MCS learned | 33 | 67 |
| full pipeline | 50 | 67 |
| random line (expected) | 38 | 66 |
