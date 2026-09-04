// The checks that would have caught what shipped broken.
//
// Three bugs went to main this week and every one of them was invisible to
// every check that existed, because they were in the two places nothing looks:
// the SHELL inside a workflow, and the KEYS around it.
//
//   permissions:
//     contents: ${{ github.event_name == 'release' && 'write' || 'read' }}
//
//     Not a conditional permission — an invalid workflow. It failed before any
//     step ran, with "this run likely failed because of a workflow file issue"
//     and no line number, and it passed every check on the pull request because
//     the workflow only triggers on push to main.
//
//   fi"
//
//     A stray quote from an edit. The YAML parsed. CodeQL's `analyze (actions)`
//     parsed it too — it reads workflows for security patterns, not for shell.
//     The job enrolled a macOS runner into the fleet, connected it, and then
//     died on line 40, after paying for the runner to get there.
//
// Both are cheap to catch and neither was being caught, which is the actual
// complaint: "getting tired of this uncaught issues".

//
// IT PARSES THE YAML PROPERLY, and the first version of this did not. That one
// read `permissions:` blocks and `run:` scalars line by line to avoid a
// dependency — reasoning about a RUNTIME dependency (this repository ships
// exactly one, on purpose) applied to a DEV dependency that no host ever sees.
//
// The cost of hand-rolling was not elegance. A line-based reader silently
// misses shapes it does not know — quoted keys, anchors, a folded scalar with
// an indentation indicator — and a checker that quietly passes a broken
// workflow is worse than no checker, because it manufactures confidence. That
// is the exact failure this file exists to stop happening again.

import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load } from 'js-yaml';

// Takes a directory so the tests can point it at a throwaway tree and still run
// THIS file rather than a copy — a copied checker is a different checker.
const DIR = process.argv[2] || '.github/workflows';

/**
 * Keys whose value GitHub does NOT evaluate as an expression.
 *
 * Writing `${{ }}` in one of these is not a conditional anything: it is a
 * literal string where a literal string is not valid, and the workflow is
 * rejected at dispatch with no line number.
 */
const NO_EXPRESSIONS = ['permissions'];

let failures = 0;
const fail = (where, what) => {
  console.error(`  ${where}\n    ${what}`);
  failures++;
};

/**
 * Anywhere a `permissions:` value is an expression.
 *
 * Walks the parsed document rather than looking for a line, so it finds them at
 * workflow level, at job level, and anywhere a future GitHub adds them.
 *
 * @param {any} node @param {string} file @param {string} at
 */
function checkNoExpressions(node, file, at = '') {
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (NO_EXPRESSIONS.includes(key) && JSON.stringify(value ?? null).includes('${{')) {
      fail(
        `${file} · ${at}${key}`,
        `\`${key}:\` does not take an expression — the workflow is INVALID, and fails at dispatch ` +
          'with "this run likely failed because of a workflow file issue" and no line number',
      );
    }
    if (value && typeof value === 'object') checkNoExpressions(value, file, `${at}${key}.`);
  }
}

/**
 * Every `run:` step, parsed as the shell it will actually run under.
 *
 * `${{ }}` becomes a quoted placeholder first: it is not shell, and a raw one
 * would make every script a syntax error. Quoted keeps the SHAPE a real
 * substitution has, so `if [ -n "${{ inputs.x }}" ]` parses the way it will at
 * run time — an unquoted placeholder would be a false pass.
 *
 * @param {any} doc @param {string} file
 */
function checkShell(doc, file) {
  const work = mkdtempSync(path.join(tmpdir(), 'wf-'));
  try {
    // A COMPOSITE ACTION IS A JOB HERE TOO, and it was not, which made this
    // file do the thing its own header is about: it printed "checked 1
    // workflows" for an action.yml and looked at none of it. Composite actions
    // hold `runs.steps` rather than `jobs.<name>.steps`, so the walk below saw
    // an empty list and passed — a checker that quietly passes a broken file is
    // worse than no checker, because it manufactures confidence.
    const units = { ...(doc?.jobs || {}), ...(doc?.runs?.steps ? { runs: doc.runs } : {}) };
    for (const [jobName, job] of Object.entries(units)) {
      const steps = /** @type {any} */ (job)?.steps;
      if (!Array.isArray(steps)) continue;
      for (const [i, step] of steps.entries()) {
        if (typeof step?.run !== 'string') continue;
        // The resolved shell, in GitHub's own precedence order. A `pwsh` step
        // is not something bash can judge, and pretending otherwise would be
        // the false-failure half of the same mistake.
        const shell =
          step.shell || /** @type {any} */ (job)?.defaults?.run?.shell || doc?.defaults?.run?.shell || 'bash';
        // A CUSTOM SHELL STRING IS STILL A SHELL. GitHub lets a workflow name
        // the executable and its arguments — `C:\msys64\usr\bin\bash.exe -eo
        // pipefail {0}` is how a Windows job runs bash at all — and matching
        // only the bare words `bash` and `sh` skipped every step in the one
        // workflow least likely to be right. The executable's name is what
        // decides, not how it was spelled.
        const exe = String(shell).trim().split(/\s+/)[0].replace(/\\/g, '/').split('/').pop() || '';
        const language = exe.replace(/\.exe$/i, '');
        // `pwsh` is not something bash can judge, and pretending otherwise
        // would be the false-failure half of the same mistake.
        if (!/^(bash|sh)$/.test(language)) continue;
        const script = step.run.replace(/\$\{\{[^}]*\}\}/g, 'EXPR');
        const scriptFile = path.join(work, 'step.sh');
        writeFileSync(scriptFile, script);
        try {
          // The LOCAL bash, never the path the workflow named: that one is on a
          // GitHub runner, and this check runs here.
          execFileSync(language, ['-n', scriptFile], { stdio: 'pipe' });
        } catch (e) {
          const why = String(/** @type {any} */ (e).stderr || /** @type {any} */ (e).message)
            .replace(new RegExp(scriptFile, 'g'), 'step')
            .trim();
          fail(`${file} · ${jobName} · step ${i + 1}${step.name ? ` (${step.name})` : ''}`, why);
        }
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

for (const name of readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f))) {
  const file = path.join(DIR, name);
  let doc;
  try {
    doc = load(readFileSync(file, 'utf8'));
  } catch (e) {
    // A workflow that does not parse is one GitHub will not run either.
    fail(file, `not valid YAML: ${/** @type {any} */ (e).message}`);
    continue;
  }
  checkNoExpressions(doc, file);
  checkShell(doc, file);
}

if (failures) {
  console.error(`\n${failures} workflow problem${failures === 1 ? '' : 's'}.`);
  process.exit(1);
}
console.log(`checked ${readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).length} workflows`);
