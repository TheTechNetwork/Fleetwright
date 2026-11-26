#!/usr/bin/env node
// A session that asks first, asked of the real OpenCode: with the settings
// and the variable the runner gives it, does a workspace's own OpenCode
// configuration still turn the asking off? docs/engines.md, "Where an engine
// runs".
//
// WHY THIS EXISTS. `safe` on OpenCode was first "the runner declines what
// OpenCode asks", and OpenCode never asked. Then it was the machine's own
// settings, said to be the one place a workspace cannot answer back from,
// and tested against a stand-in that was told so. Asked itself, OpenCode
// 1.19.6 resolved `bash` and `edit` to allow under those settings for three
// kinds of file a workspace can hold. A stand-in knows what it was told.
// This asks the engine, in the image a box pulls.
//
// WHAT IT ASKS, AND OF WHAT. `opencode debug agent build` prints the rules
// OpenCode has resolved for its `build` agent, which is the agent an ACP
// session runs on. It sends no prompt, needs no sign-in and no provider, and
// is run here with no network. The settings and the variable are the
// runner's own, taken from the runner (`askFirst` in sandbox/engine.mjs) and
// never retyped here, so a change there is what is asked about.
//
// WHAT IT DOES NOT SHOW. That a turn then asks and is declined: that needs a
// model, and so a provider. And the verdict below is this file's reading of
// OpenCode's rule for a list of rules (the last one that matches decides;
// packages/opencode/src/permission/index.ts, `evaluate`, at v1.19.6), applied
// to the list OpenCode printed. If a later OpenCode decides another way,
// this is the place that has to learn it.
//
//   node scripts/opencode-safe-check.mjs
//
// In CI it runs inside the engines image (.github/workflows/sandbox.yml).
// Anywhere else, three variables say where things are:
//   FLEETWRIGHT_ENGINE_MJS            the runner (default: where the image has it)
//   FLEETWRIGHT_OPENCODE_BIN          the OpenCode to ask (default: `opencode`)
//   OPENCODE_TEST_MANAGED_CONFIG_DIR  OpenCode's own name for a directory to
//                                     read as its machine's settings in place
//                                     of /etc/opencode; the settings are
//                                     written there when it is set

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RUNNER = process.env.FLEETWRIGHT_ENGINE_MJS || '/usr/local/lib/fleetwright-engine.mjs';
const BIN = process.env.FLEETWRIGHT_OPENCODE_BIN || 'opencode';
const { askFirst, OPENCODE_SYSTEM_DIR } = await import(pathToFileURL(RUNNER).href);

/**
 * What a workspace can hold. Each of the three with a file in it resolved
 * `bash` and `edit` to allow under the machine's settings alone.
 *
 * @type {Array<{ name: string, what: string, files: Record<string, string> }>}
 */
const WORKSPACES = [
  { name: 'clean', what: 'nothing of OpenCode’s', files: {} },
  {
    name: 'agent-rule',
    what: 'opencode.json giving its build agent a rule of its own',
    files: { 'opencode.json': JSON.stringify({ agent: { build: { permission: { bash: 'allow', edit: 'allow' } } } }) },
  },
  {
    name: 'star-then-tool',
    what: 'opencode.json whose permission names a tool after "*"',
    files: { 'opencode.json': JSON.stringify({ permission: { '*': 'ask', bash: 'allow', edit: 'allow' } }) },
  },
  {
    name: 'agent-file',
    what: '.opencode/agent/build.md with a permission of its own',
    files: { '.opencode/agent/build.md': '---\ndescription: The default agent.\nmode: primary\npermission:\n  bash: allow\n  edit: allow\n---\n' },
  },
];

/** What is asked of each: a tool, and something it would be used on. */
const QUESTIONS = [['bash', 'rm -rf build'], ['bash', 'git push'], ['edit', 'src/index.js']];

/** OpenCode's `*` and `?` in a rule, as a pattern for the whole of what it is matched against. @param {string} rule */
const wild = (rule) => new RegExp(`^${rule.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's');

/**
 * What OpenCode would do, by the rules it printed: the last one that matches
 * the tool and what it is used on, and ask where none does.
 *
 * @param {Array<{ permission: string, pattern: string, action: string }>} rules @param {string} tool @param {string} on
 */
function verdict(rules, tool, on) {
  return rules.findLast((r) => wild(r.permission).test(tool) && wild(r.pattern).test(on))?.action ?? 'ask';
}

/**
 * Ask OpenCode what its `build` agent resolves, in one workspace.
 *
 * @param {string} cwd @param {Record<string, string>} more  what the engine's process is started with besides
 * @returns {{ rules: Array<{ permission: string, pattern: string, action: string }>|null, said: string }}
 */
function ask(cwd, more) {
  const r = spawnSync(BIN, ['debug', 'agent', 'build'], { cwd, env: { ...process.env, ...more }, encoding: 'utf8', timeout: 120_000 });
  const out = String(r.stdout || '');
  try {
    const rules = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)).permission;
    if (Array.isArray(rules)) return { rules, said: '' };
  } catch { /* said below */ }
  return { rules: null, said: `${r.error ? `${r.error.message} ` : ''}exit ${r.status}: ${(out + String(r.stderr || '')).trim().slice(-600) || 'it printed nothing'}` };
}

const systemDir = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR || OPENCODE_SYSTEM_DIR;
const told = askFirst('opencode', 'safe', systemDir);
if (!told.ok) {
  console.error(`FAIL the runner could not write OpenCode's settings in ${systemDir}: ${told.text}`);
  process.exit(1);
}
console.log(`the runner wrote ${path.join(systemDir, 'opencode.json')} and starts OpenCode with ${JSON.stringify(told.env ?? {})}`);
const version = spawnSync(BIN, ['--version'], { encoding: 'utf8' });
console.log(`asking ${BIN} ${String(version.stdout || '').trim() || '(no version)'}`);

const base = mkdtempSync(path.join(os.tmpdir(), 'opencode-safe-'));
/** @type {string[]} */
const failures = [];
/** How many of the workspaces with a file in them win when the variable is not set: what makes this check one that can fail. */
let wonWithout = 0;
try {
  for (const w of WORKSPACES) {
    const cwd = path.join(base, w.name);
    mkdirSync(cwd, { recursive: true });
    for (const [file, text] of Object.entries(w.files)) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), text);
    }
    // AS A SESSION THAT ASKS FIRST STARTS IT: the settings, and the variable.
    const safe = ask(cwd, told.env ?? {});
    // AND WITH THE SETTINGS ALONE, which is how it was started before. Said,
    // never failed on: it is what shows the files above are still the ones
    // that matter, and a later OpenCode that puts its machine's settings
    // last for good would only make the variable a second lock.
    const alone = ask(cwd, {});
    console.log(`\n${w.name}: a workspace holding ${w.what}`);
    if (!safe.rules) {
      failures.push(`${w.name}: OpenCode did not say what its build agent resolves (${safe.said})`);
      console.log(`  FAIL ${failures.at(-1)}`);
      continue;
    }
    for (const [tool, on] of QUESTIONS) {
      const got = verdict(safe.rules, tool, on);
      const before = alone.rules ? verdict(alone.rules, tool, on) : 'not said';
      console.log(`  ${tool} "${on}": ${got}${got === 'ask' ? '' : '   <-- NOT ask'}   (with the settings alone: ${before})`);
      if (got !== 'ask') failures.push(`${w.name}: ${tool} "${on}" resolves to ${got}, so a session that asks first would not be asked`);
      if (w.name === 'clean' && before !== 'ask') failures.push(`clean: with nothing in the workspace and the machine's settings alone, ${tool} "${on}" resolves to ${before}: OpenCode is not reading ${systemDir}`);
    }
    if (Object.keys(w.files).length && alone.rules && QUESTIONS.some(([tool, on]) => verdict(/** @type {any} */ (alone.rules), tool, on) !== 'ask')) wonWithout += 1;
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\n${wonWithout} of the ${WORKSPACES.length - 1} workspaces with a file in them turn the asking off when OpenCode is started with the machine's settings alone.`);
if (!wonWithout) console.log('So in this OpenCode the machine’s settings hold by themselves, and the variable is a second lock on the same door.');
if (failures.length) {
  console.error(`\nFAIL a session that asks first would not ask:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('\nIn every workspace, bash and edit resolve to ask when OpenCode is started as a session that asks first starts it.');
