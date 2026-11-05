"""SAT/SMT-based type error localization for a core JavaScript subset.

Pipeline:  infer.js --json  ->  constraints.py  ->  encode.py (Z3)
           ->  mcs.py (smallest correction subsets)  ->  rank.py (ranked lines)
"""
