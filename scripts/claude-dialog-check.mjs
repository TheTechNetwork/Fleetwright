// The pinned Claude Code, asked what it still says.
//
//   node scripts/claude-dialog-check.mjs
//
// Installs @anthropic-ai/claude-code at the version in claude-pin.js (or uses
// CLAUDE_BIN) and refuses a trust, permission or resume question that binary
// still contains and the matchers do not know. Dialog drift fails here, in
// CI, instead of in a session nobody is watching.
//
// It does not start a session. The questions are contiguous strings in the
// binary; a logged-in pane is not required, and a credential in CI is the
// thing this check is avoiding.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dialogProblems } from '../src/fleet/host/claude-dialogs.js';
import { CLAUDE_CODE_VERSION } from '../src/fleet/host/claude-pin.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The native binary for this machine, not the wrapper.
 *
 * @param {string} prefix  an npm prefix the package was installed into
 */
function binaryIn(prefix) {
  const plat = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  if (!plat || !arch) throw new Error(`no pinned Claude Code build for ${process.platform} ${process.arch}`);
  return path.join(prefix, 'node_modules', `@anthropic-ai`, `claude-code-${plat}-${arch}`, 'claude');
}

function binary() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const prefix = mkdtempSync(path.join(tmpdir(), 'claude-dialog-'));
  process.on('exit', () => rmSync(prefix, { recursive: true, force: true }));
  execFileSync(
    'npm',
    ['install', '--no-audit', '--no-fund', '--prefix', prefix, `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`],
    { cwd: root, stdio: 'inherit' },
  );
  return binaryIn(prefix);
}

const bin = binary();
const blob = execFileSync('strings', ['-n', '12', bin], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const problems = dialogProblems(blob);
if (problems.length) {
  console.error(`Claude Code ${CLAUDE_CODE_VERSION} (${bin}) asks something this fleet does not recognise:`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`Claude Code ${CLAUDE_CODE_VERSION}: trust, permission and resume questions are ones the fleet reads.`);
