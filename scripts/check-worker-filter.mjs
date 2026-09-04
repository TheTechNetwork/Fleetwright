// The Worker's deploy filter, checked against the bundle it is supposed to
// describe. See scripts/worker-filter.mjs for the two times it was wrong and
// what the second one cost.
//
// IT ASKS ESBUILD RATHER THAN READING IMPORTS. A grep for `from '../../src/`
// would answer a different question — which files mention each other — and
// would be wrong in both directions: it counts an import that is only reached
// from a Node-only branch, and misses one added through a re-export. The
// bundler resolves the graph for real because it has to produce the bundle, and
// `--metafile` is that graph written down. Same flags verify.sh bundles with,
// so it is the same graph the deploy ships.

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load } from 'js-yaml';

import { uncovered, prefixes } from './worker-filter.mjs';

const WORKFLOW = '.github/workflows/worker.yml';
const ESBUILD = path.join('worker', 'node_modules', '.bin', 'esbuild');

let failures = 0;
const fail = (what) => {
  console.error(what);
  failures++;
};

const work = mkdtempSync(path.join(tmpdir(), 'wf-bundle-'));
const metaPath = path.join(work, 'meta.json');

// The same invocation as verify.sh's `worker` line, plus --metafile. If the two
// ever differ they are describing different bundles, and this check would be
// certifying something the deploy does not ship.
const run = spawnSync(
  path.resolve(ESBUILD),
  [
    'src/worker.js',
    '--bundle',
    '--format=esm',
    '--platform=neutral',
    '--outfile=/dev/null',
    '--external:node:*',
    '--external:cloudflare:*',
    `--metafile=${metaPath}`,
  ],
  { cwd: 'worker', stdio: 'pipe', encoding: 'utf8' },
);

if (run.status !== 0) {
  // A bundle that does not build is verify.sh's `worker` line's problem, not
  // this one's. Saying so is better than reporting a filter result computed
  // from nothing.
  console.error(
    `the Worker did not bundle, so there is no graph to check against:\n${run.stderr || run.stdout}`,
  );
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

/** @type {{inputs: Record<string, unknown>}} */
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
rmSync(work, { recursive: true, force: true });

// esbuild writes paths relative to its working directory, which is worker/.
// Joining and normalising is what turns `../src/mcp/http.js` into the
// `src/mcp/http.js` a workflow filter is written in — and, importantly, keeps
// `src/worker.js` distinct from it as `worker/src/worker.js`.
const bundled = Object.keys(meta.inputs)
  .map((p) => path.normalize(path.join('worker', p)).split(path.sep).join('/'))
  .filter((p) => !p.includes('node_modules/'))
  .sort();

if (!bundled.length) {
  console.error('esbuild reported no repository files in the bundle, which cannot be right');
  process.exit(1);
}

const doc = /** @type {any} */ (load(readFileSync(WORKFLOW, 'utf8')));
// `on` is YAML 1.1's boolean true, which js-yaml honours — so the key is not
// the string 'on'. Both are read rather than one, because which one appears
// depends on quoting in the workflow and a checker that silently found neither
// would pass on every commit.
const on = doc?.on ?? doc?.[true];
const paths = on?.push?.paths;
if (!Array.isArray(paths)) {
  console.error(`${WORKFLOW}: could not read on.push.paths — the filter may have moved`);
  process.exit(1);
}

const missing = uncovered(paths, bundled);
if (missing.length) {
  const dirs = [...new Set(missing.map((f) => f.split('/').slice(0, 2).join('/')))];
  fail(
    `${WORKFLOW}: the deploy filter does not name ${missing.length} file${missing.length === 1 ? '' : 's'} that are IN the Worker bundle:\n` +
      missing.map((f) => `    ${f}`).join('\n') +
      `\n\n  A push to main touching only these does not run this workflow, so the\n` +
      `  Worker is not redeployed and production keeps the old code — silently,\n` +
      `  with nothing red anywhere. Add to on.push.paths:\n` +
      dirs.map((d) => `    - '${d}/**'`).join('\n'),
  );
}

// The `changes` job answers the same question on a pull request, in shell,
// because it runs before any npm install. Two lists, so: every prefix the
// trigger names must appear literally in that job's script.
const changesRun = (doc?.jobs?.changes?.steps || [])
  .map((/** @type {any} */ s) => s?.run)
  .filter((/** @type {unknown} */ r) => typeof r === 'string')
  .join('\n');

if (!changesRun) {
  fail(`${WORKFLOW}: the changes job has no run: step, so nothing gates the check on a pull request`);
} else {
  for (const prefix of prefixes(paths)) {
    if (!changesRun.includes(prefix)) {
      fail(
        `${WORKFLOW}: on.push.paths names '${prefix}/**' and the changes job does not mention it.\n` +
          `  The trigger would deploy on that path and the pull request would skip the check for it —\n` +
          `  which is the wrong way round: the change ships without ever having been bundled.`,
      );
    }
  }
}

if (failures) process.exit(1);
console.log(`${bundled.length} bundled files, all named`);
