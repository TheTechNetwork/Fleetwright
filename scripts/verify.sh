#!/usr/bin/env bash
# Everything that must pass, with an exit code that means it.
#
# This exists because I twice committed past a failing typecheck by writing
#   npx tsc | head -3; echo "clean"
# where the echo runs whatever tsc said, and once more by writing
#   ... | head -3 && echo "FAILING" || echo "clean"
# where head exits 0 on empty input, so it reported failure on success.
#
# A verification step that cannot fail is not a verification step, and one
# whose result depends on getting shell precedence right is barely better.
set -uo pipefail
fail=0

printf 'tests      ... '
if out=$(npm test --silent 2>&1); then
  printf '%s\n' "$(printf '%s' "$out" | grep -E '^# (pass|fail)' | tr '\n' ' ')"
else
  printf 'FAILED\n%s\n' "$(printf '%s' "$out" | grep -E '^not ok' | head -10)"; fail=1
fi

printf 'typecheck  ... '
if out=$(npx tsc -p . --noEmit 2>&1) && [ -z "$out" ]; then
  printf 'clean\n'
else
  printf 'FAILED\n%s\n' "$(printf '%s' "$out" | head -10)"; fail=1
fi

printf 'worker     ... '
if out=$(cd worker && ./node_modules/.bin/esbuild src/worker.js --bundle --format=esm --platform=neutral --outfile=/dev/null --external:node:* 2>&1); then
  printf 'bundles\n'
else
  printf 'FAILED\n%s\n' "$out"; fail=1
fi

printf 'installer  ... '
if bash -n install/install.sh 2>/dev/null && sh -n install/bootstrap.sh 2>/dev/null; then
  printf 'parses\n'
else
  printf 'FAILED\n'; fail=1
fi

[ "$fail" = 0 ] && printf '\nALL GREEN\n' || printf '\nSOMETHING FAILED — do not commit\n'
exit "$fail"
