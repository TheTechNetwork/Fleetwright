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

# `--external:cloudflare:*` for the same reason as node: those modules exist in
# the Workers runtime and nowhere else. Wrangler resolves them; esbuild here is
# checking that everything ELSE resolves, and treating a runtime built-in as a
# missing dependency would make this check fail on correct code.
printf 'worker     ... '
if out=$(cd worker && ./node_modules/.bin/esbuild src/worker.js --bundle --format=esm --platform=neutral --outfile=/dev/null --external:node:* --external:cloudflare:* 2>&1); then
  printf 'bundles\n'
else
  printf 'FAILED\n%s\n' "$out"; fail=1
fi

# The contract, and the copy of it the Worker ships. openapi.json is the source
# and test/openapi.test.js executes it against BOTH coordinators — but the
# Worker inlines its own copy, and a copy of a contract is a thing that drifts.
# It did: a verb reached openapi.json and the protocol and not the bundle, so
# the two coordinators would have disagreed about what they accept.
printf 'contract   ... '
if out=$(node scripts/sync-openapi.mjs --check 2>&1); then
  printf 'in sync
'
else
  printf 'FAILED
%s
' "$out"; fail=1
fi

# THE CHECKS THAT WOULD HAVE CAUGHT WHAT SHIPPED BROKEN.
#
# Three bugs reached main and every one was invisible to everything that ran:
# an expression in `permissions:` (invalid workflow, no line number, failed only
# after merge), a stray quote in a `run:` block (killed a live macOS runner
# after it had already enrolled), and a function called in the Worker and
# defined nowhere (a ReferenceError in the production coordinator, on a route no
# test reaches).
#
# None of them needed cleverness to catch. They needed something to look.
printf 'workflows  ... '
if out=$(node scripts/check-workflows.mjs 2>&1); then
  printf '%s\n' "${out##*$'\n'}"
else
  printf 'FAILED\n%s\n' "$out"; fail=1
fi

# TS2304 ONLY — "Cannot find name". worker/src, tools/ and sandbox/ carry
# pre-existing type complaints that are noise rather than defects, and demanding
# all of them be fixed before any of them can be checked is how a check never
# gets added. An identifier that does not exist is different: always a bug,
# always a runtime throw, invisible until the line runs.
printf 'names      ... '
if out=$(npx tsc --noEmit -p tsconfig.names.json 2>&1 | grep 'TS2304' || true); then
  if [ -n "$out" ]; then
    printf 'FAILED\n%s\n' "$out"; fail=1
  else
    printf 'all defined\n'
  fi
fi

printf 'installer  ... '
if bash -n install/install.sh 2>/dev/null && sh -n install/bootstrap.sh 2>/dev/null; then
  printf 'parses\n'
else
  printf 'FAILED\n'; fail=1
fi

# The scripts that run INSIDE a session's container. They are not covered by the
# installer check above and have no test that executes them, so a syntax error
# would first be seen by somebody whose session could not start.
# tool-shim.sh is a template: @TOOL@ substitutes into a filename, which parses
# on its own, so it is checked as written.
printf 'sandbox    ... '
if sh -n sandbox/entrypoint.sh 2>/dev/null && sh -n sandbox/tool-shim.sh 2>/dev/null; then
  printf 'parses\n'
else
  printf 'FAILED\n'; fail=1
fi

[ "$fail" = 0 ] && printf '\nALL GREEN\n' || printf '\nSOMETHING FAILED — do not commit\n'
exit "$fail"
