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
// NO YAML LIBRARY. This repository ships one runtime dependency and adding a
// second to lint with would be a strange trade — so the two things it needs are
// read line by line: a `permissions:` block, and `run:` block scalars. Both are
// well-defined shapes in YAML's indentation rules, and a checker that is wrong
// about an exotic file fails loudly rather than silently passing it.

import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DIR = '.github/workflows';

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

/** Indentation of a line, or -1 for blank/comment. */
const indentOf = (line) => (/^\s*(#|$)/.test(line) ? -1 : line.length - line.trimStart().length);

/**
 * `permissions:` blocks, and whether anything in one is an expression.
 *
 * @param {string[]} lines @param {string} file
 */
function checkNoExpressions(lines, file) {
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)permissions:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, indent, inline] = m;
    const body = inline ? [inline] : [];
    for (let j = i + 1; j < lines.length; j++) {
      const at = indentOf(lines[j]);
      if (at === -1) continue;
      if (at <= indent.length) break;
      body.push(lines[j]);
    }
    for (const line of body) {
      if (line.includes('${{')) {
        fail(
          `${file}:${i + 1} · permissions`,
          '`permissions:` does not take an expression — the workflow is INVALID, and fails at dispatch ' +
            'with "this run likely failed because of a workflow file issue" and no line number',
        );
        break;
      }
    }
  }
}

/**
 * Every `run:` block scalar, parsed as shell.
 *
 * Expressions become a quoted placeholder first: `${{ ... }}` is not shell and
 * would make every script a syntax error. A placeholder keeps the shape a real
 * substitution has, so `if [ -n "${{ inputs.x }}" ]` still parses the way it
 * will at run time.
 *
 * @param {string[]} lines @param {string} file
 */
function checkShell(lines, file) {
  const work = mkdtempSync(path.join(tmpdir(), 'wf-'));
  try {
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)-?\s*run:\s*([|>][-+]?)?\s*$/.exec(lines[i]);
      if (!m) continue;
      const indent = m[1].length;
      const body = [];
      for (let j = i + 1; j < lines.length; j++) {
        const at = indentOf(lines[j]);
        if (at === -1) {
          body.push('');
          continue;
        }
        if (at <= indent) break;
        body.push(lines[j]);
      }
      if (!body.length) continue;
      const script = body.join('\n').replace(/\$\{\{[^}]*\}\}/g, 'EXPR');
      const scriptFile = path.join(work, 'step.sh');
      writeFileSync(scriptFile, script);
      try {
        execFileSync('bash', ['-n', scriptFile], { stdio: 'pipe' });
      } catch (e) {
        const why = String(e.stderr || e.message).replace(new RegExp(scriptFile, 'g'), 'step').trim();
        fail(`${file}:${i + 1} · run`, why);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

for (const name of readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f))) {
  const file = path.join(DIR, name);
  const lines = readFileSync(file, 'utf8').split('\n');
  checkNoExpressions(lines, file);
  checkShell(lines, file);
}

if (failures) {
  console.error(`\n${failures} workflow problem${failures === 1 ? '' : 's'}.`);
  process.exit(1);
}
console.log(`checked ${readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).length} workflows`);
