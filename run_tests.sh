#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0
SKIP=0
FAILURES=""

while IFS= read -r js_file; do
  out_file="${js_file%.js}.out"

  if [ ! -f "$out_file" ]; then
    echo "⚠  SKIP (no .out): $js_file"
    SKIP=$((SKIP + 1))
    continue
  fi

  actual=$(node infer.js "$js_file" | node solver.js 2>&1)
  expected=$(cat "$out_file")

  if [ "$actual" = "$expected" ]; then
    echo "✓  $js_file"
    PASS=$((PASS + 1))
  else
    echo "✗  $js_file"
    diff <(echo "$expected") <(echo "$actual") || true
    FAIL=$((FAIL + 1))
    FAILURES="$FAILURES\n  - $js_file"
  fi
done < <(find "./Tests/${1:-}" -type f -name "*.js" | sort)

echo ""
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"

if [ $FAIL -gt 0 ]; then
  echo -e "Failed tests:$FAILURES"
  exit 1
fi
