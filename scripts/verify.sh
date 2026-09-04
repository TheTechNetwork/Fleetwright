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

# VERIFY_SKIP_TESTS=1 runs everything EXCEPT the suite.
#
# For CI, and it is the reason CI can run this file rather than a copy of it.
# The suite is the one part of this script whose answer depends on which Node
# is running it, so it belongs in a version matrix; nothing else here does —
# `bash -n`, an esbuild bundle and a JSON comparison do not change between
# Node 24 and Node 26, and running them twice bought two identical answers.
#
# Skipping is ANNOUNCED rather than silent. A verification script that can
# quietly do less than it says is the same failure this file's header is about.
printf 'tests      ... '
if [ -n "${VERIFY_SKIP_TESTS:-}" ]; then
  printf 'skipped (VERIFY_SKIP_TESTS)\n'
elif out=$(npm test --silent 2>&1); then
  # BOTH REPORTER FORMATS, and the second one is why this line was blank.
  #
  # `# pass 1182` is TAP; `ℹ pass 1182` is the spec reporter, which is what
  # node emits now. The grep named only TAP, so it matched nothing and this
  # printed an empty summary after a suite of 1183 tests — the exit code was
  # still right, so nothing was WRONG, and that is the point: a line that
  # reports nothing looks exactly like a line reporting good news.
  printf '%s\n' "$(printf '%s' "$out" | grep -E '^(#|ℹ) (pass|fail)' | tr '\n' ' ')"
else
  # And the same on the failing side, where it matters more: with the spec
  # reporter there is no `not ok`, so a failed suite printed "FAILED" and then
  # nothing at all — no test name, no assertion, nothing to act on.
  printf 'FAILED\n%s\n' "$(printf '%s' "$out" | grep -E '^(not ok|✖)' | head -10)"; fail=1
fi

# COVERAGE, and it runs even when VERIFY_SKIP_TESTS does not.
#
# Its own flag on purpose. VERIFY_SKIP_TESTS exists because the suite's answer
# depends on which Node is running it and therefore belongs in CI's version
# matrix; coverage's answer does not — it is a property of the code — so it runs
# once, here, in the `checks` job that skips the suite. One place, one
# implementation, and CI keeps running this file rather than a copy of it.
#
# It runs the suite itself, so this is the second execution locally. Twenty-one
# seconds, against the class of bug that is the whole reason the comments in
# this file exist: code that shipped because nothing ever executed it.
#
# It fails on a DROP, never on a low number. See scripts/check-coverage.mjs.
printf 'coverage   ... '
if [ -n "${VERIFY_SKIP_COVERAGE:-}" ]; then
  printf 'skipped (VERIFY_SKIP_COVERAGE)\n'
elif out=$(node scripts/check-coverage.mjs 2>&1); then
  printf '%s\n' "$(printf '%s' "$out" | tail -1)"
else
  printf 'FAILED\n%s\n' "$out"; fail=1
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

# The demo Worker, bundled SEPARATELY and with no `--external` at all — because
# the point of it having its own script is that it needs nothing the platform
# has to provide. If `demo-worker.js` ever grows an import that drags the
# coordinator in, this is where it stops being true out loud.
printf 'demo       ... '
if out=$(cd worker && ./node_modules/.bin/esbuild src/demo-worker.js --bundle --format=esm --platform=neutral --outfile=/dev/null 2>&1); then
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

# THE DEPLOY FILTER, against the bundle it claims to describe.
#
# worker.yml names the directories whose changes redeploy the Worker, and that
# list has been wrong twice — src/core when the protocol module started
# importing it, and src/mcp, which was never named at all and cost a deploy:
# 0d3f8af changed src/mcp/authorize-page.js and otherwise only docs/ and test/,
# so the workflow never ran and production kept the old code.
#
# A missed deploy is the quietest failure here. Nothing is red, no job is
# visibly skipped, and the coordinator serves last week's code while main says
# otherwise. esbuild already knows the graph; this asks it.
printf 'deploy     ... '
if out=$(node scripts/check-worker-filter.mjs 2>&1); then
  printf '%s\n' "$out"
else
  printf 'FAILED\n%s\n' "$out"; fail=1
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
