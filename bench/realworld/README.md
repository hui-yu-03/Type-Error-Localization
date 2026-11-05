# Real buggy programs

`python bench/realworld.py DIR` evaluates the localizer on pairs
`NAME.buggy.js` / `NAME.fixed.js` (for example a student's failed submission
and the next accepted one, or the two sides of a bug-fixing commit).  The
lines changed by the fix are the lines of the mistake.

`pipeline-check/` only checks that the script works: it holds the small
examples of this repository with their fixes.  It is **not** a real-world
data set.  No real data set could be fetched from the environment in which
this was built (its network policy blocked the hosts); see the main README.
