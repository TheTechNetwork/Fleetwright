import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Run the checker over one made-up workflow, in a throwaway tree.
 *
 * The checker reads `.github/workflows` relative to the working directory, so
 * a temporary copy is the whole setup — no flag, no injection point, and the
 * thing being tested is the thing that runs in CI.
 */
function check(yaml) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wfcheck-'));
  try {
    mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, '.github/workflows/x.yml'), yaml);
    cpSync(path.join(ROOT, 'scripts/check-workflows.mjs'), path.join(dir, 'scripts/check-workflows.mjs'));
    try {
      execFileSync(process.execPath, ['scripts/check-workflows.mjs'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
      return { ok: true, output: '' };
    } catch (e) {
      return { ok: false, output: String(e.stdout || '') + String(e.stderr || '') };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('it catches the stray quote that killed a live runner', () => {
  // The actual bug, reduced. The YAML parsed, CodeQL's `analyze (actions)`
  // parsed it, and the job enrolled a macOS runner into the fleet, connected
  // it, and then died on line 40 — after paying for the runner to get there.
  const r = check(`
name: X
on: workflow_dispatch
jobs:
  host:
    runs-on: ubuntu-latest
    steps:
      - name: Run as a host
        run: |
          if [ -n "\${SOMETHING:-}" ]; then
            echo "yes"
          fi"
          echo "unreachable"
`);
  assert.equal(r.ok, false);
  assert.match(r.output, /unexpected EOF|syntax error/);
});

test('it catches an expression in permissions', () => {
  // Not a conditional permission — an invalid workflow. It failed before any
  // step ran, with no line number, and passed every check on the pull request
  // because the workflow only triggers on push to main.
  const r = check(`
name: X
on: workflow_dispatch
jobs:
  package:
    runs-on: ubuntu-latest
    permissions:
      contents: \${{ github.event_name == 'release' && 'write' || 'read' }}
    steps:
      - run: echo hi
`);
  assert.equal(r.ok, false);
  assert.match(r.output, /does not take an expression/);
});

test('a workflow that is fine passes', () => {
  // A checker that fails on correct input gets disabled within a week, and
  // takes the two above with it.
  const r = check(`
name: X
on: workflow_dispatch
permissions:
  contents: read
  id-token: write
jobs:
  host:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ inputs.thing }}"
      - name: Multi
        run: |
          set -euo pipefail
          if [ -n "\${{ inputs.pin }}" ]; then
            echo "have a pin"
          else
            echo "none"
          fi
          for i in 1 2 3; do echo "$i"; done
`);
  assert.equal(r.ok, true, r.output);
});

test('expressions do not make an otherwise-fine script fail', () => {
  // `${{ }}` is not shell. Substituting a placeholder keeps the SHAPE a real
  // substitution has — an unquoted one inside a test would be a false pass,
  // and a raw one would be a false failure on every workflow in the repo.
  const r = check(`
name: X
on: workflow_dispatch
jobs:
  host:
    runs-on: ubuntu-latest
    steps:
      - run: |
          case "\${{ inputs.mode }}" in
            a) echo one ;;
            *) echo other ;;
          esac
`);
  assert.equal(r.ok, true, r.output);
});
