// A member's engines through the real launch (docs/engines.md): a start from
// the fleet, the session manager's own `#launch` and `handOn`, a real tmux
// pane, the real runner (sandbox/engine.mjs) in it, and the session's own
// socket between them.
//
// WHAT STANDS IN, and nothing else does: podman, which is a script that runs
// the pane's command on this machine instead of in a container; Claude Code,
// which is a process that says its turn failed at a usage limit and never
// brings Remote Control up; and OpenCode, which is an Agent Client Protocol
// agent that answers one turn. No real engine is run and none is asked
// anything.
//
// Driven through a real tmux for the reason
// test/runner-api-key-remote-control.test.js is: the wait was the bug, and a
// fake pane would answer whatever the test told it to.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { Registry } from '../src/core/registry.js';
import { SessionManager } from '../src/core/sessions.js';
import { HookSocketServer } from '../src/core/hook-socket.js';
import { answerEngineCredential } from '../src/core/engine-box.js';
import { applyVault } from '../src/core/vault-store.js';
import { dispatch } from '../src/adapters/commands.js';
import { killSession } from '../src/core/tmux.js';

const tmux = spawnSync('tmux', ['-V']).status === 0;
const RUNNER = fileURLToPath(new URL('../sandbox/engine.mjs', import.meta.url));
const q = (/** @type {string} */ s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Wait until `said()` is true, or say what never happened. */
async function until(/** @type {() => boolean} */ said, /** @type {string} */ what, ms = 20_000) {
  const by = Date.now() + ms;
  while (!said()) {
    if (Date.now() > by) assert.fail(`waited ${ms} ms and never saw: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * A box whose sessions run "in a container": the podman here keeps volumes as
 * files, answers the helper containers a launch and a handoff run, and for a
 * session's own `run -it` execs what the image would have, on this machine,
 * with the session's socket where the mount would have put it.
 */
function box(/** @type {import('node:test').TestContext} */ t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fw-el-'));
  const node = process.execPath;
  // Claude Code, at its account's limit on its first turn, and with no Remote
  // Control link however long anyone waits.
  writeFileSync(path.join(dir, 'claude.mjs'), `
import { post } from ${JSON.stringify(RUNNER)};
const socket = process.env.AGENT_SESSION_HOOK_SOCKET;
await post(socket, '/internal/session-event', { event: 'UserPromptSubmit' });
await post(socket, '/internal/session-event', { event: 'StopFailure', detail: 'Claude usage limit reached. Your limit will reset at 3pm' });
setInterval(() => {}, 1000);
`);
  // OpenCode's ACP agent, signed in, with the model that is asked for.
  writeFileSync(path.join(dir, 'opencode.mjs'), `
import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const model = (now) => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: now, options: [] }];
createInterface({ input: process.stdin }).on('line', (text) => {
  const m = JSON.parse(text);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's-1', configOptions: model('opencode/big-pickle') } });
  else if (m.method === 'session/set_config_option') send({ id: m.id, result: { configOptions: model(m.params.value) } });
  else if (m.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Read HANDOFF.md and carried on.' } } } });
    send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
});
`);
  writeFileSync(path.join(dir, 'opencode'), `#!/bin/sh\nexec ${q(node)} ${q(path.join(dir, 'opencode.mjs'))} "$@"\n`, { mode: 0o755 });
  const podmanBin = path.join(dir, 'podman');
  writeFileSync(podmanBin, `#!/bin/sh
D=${q(dir)}
case "$1" in
  --version) echo 'podman version 5.0.0'; exit 0 ;;
  image) exit 0 ;;
  volume)
    case "$2" in
      inspect) [ -e "$D/vol-$3" ]; exit $? ;;
      create) : > "$D/vol-$3"; exit 0 ;;
    esac
    exit 0 ;;
  container) exit 1 ;;
  run) ;;
  *) exit 0 ;;
esac
if [ "$2" != "-it" ]; then
  # A helper container over a volume. The one this test reads is the handoff
  # note being written; a sign-in being seeded succeeds; and the workspace
  # holds no checkout.
  for last; do :; done
  if [ "$last" = "HANDOFF.md" ]; then cat > "$D/HANDOFF-$(ls "$D" | grep -c '^HANDOFF-').md"; exit 0; fi
  if [ "$last" = "sh" ]; then cat > /dev/null; exit 0; fi
  exit 7
fi
# A session's own container: what the image would run, with its socket where
# the mount would have put it.
own=''
shift 2
while [ $# -gt 0 ]; do
  case "$1" in
    -v) case "$2" in *:/run/hub) own="\${2%%:*}" ;; esac; shift ;;
    img) shift; break ;;
  esac
  shift
done
export AGENT_SESSION_HOOK_SOCKET="$own/hub.sock" HOME="$D/home" FLEETWRIGHT_OPENCODE_BIN="$D/opencode"
case "$1" in
  fleetwright-engine) shift; exec ${q(node)} ${q(RUNNER)} "$@" ;;
  claude) exec ${q(node)} "$D/claude.mjs" ;;
esac
exit 127
`, { mode: 0o755 });

  const RC_TIMEOUT = 1000;
  const cfg = /** @type {any} */ ({
    stateDir: path.join(dir, 'state'), profileDir: path.join(dir, 'profiles'), workdir: path.join(dir, 'work'),
    stateFile: path.join(dir, 'state.json'), spoolFile: path.join(dir, 'spool'), hostname: 'box-1',
    sandbox: true, sandboxHookSocket: true, sandboxHookSocketDir: path.join(dir, 's'), sandboxImage: 'img', sandboxUserns: 'host', sandboxExtraArgs: [],
    podmanBin, claudeBin: 'claude', engines: ['codex', 'opencode'],
    remoteControl: true, rcTimeoutMs: RC_TIMEOUT, rcRequired: false, skipPermissions: false, maxSessions: 5, binTtlMs: 0, loginEnabled: false,
  });
  const registry = new Registry({ stateFile: cfg.stateFile, spoolFile: cfg.spoolFile });
  /** @type {SessionManager} */
  let sm;
  const hooks = new HookSocketServer({
    dir: cfg.sandboxHookSocketDir,
    onSessionStart: () => ({ ok: true }),
    onSessionEvent: (e) => sm.recordEvent(e),
    engineCredential: (name, kind, value) => answerEngineCredential(cfg, registry.get(name), kind, value),
  });
  sm = new SessionManager(cfg, registry, hooks);
  sm.machine = { freeMemBytes: () => 64 * 2 ** 30, load1: () => 0, cpus: () => 8 };
  const name = `cc-engines-${process.pid}`;
  t.after(async () => {
    killSession(name);
    await hooks.close(name);
    rmSync(dir, { recursive: true, force: true });
  });
  const notes = () => readdirSync(dir).filter((f) => f.startsWith('HANDOFF-')).sort().map((f) => readFileSync(path.join(dir, f), 'utf8'));
  return { dir, cfg, registry, sm, name, RC_TIMEOUT, notes };
}

test('a member’s engines through the real launch: no wait for a link an engine never has, the task on the note, and a third engine tried', { skip: !tmux && 'needs tmux' }, async (t) => {
  const { cfg, registry, sm, name, RC_TIMEOUT, notes } = box(t);
  // Debbie keeps a Claude token and a Copilot token on this box, and no Codex
  // sign-in: Codex fails its check before a turn, at once.
  assert.equal(applyVault(cfg, { accounts: [{ principal: 'member:debbie', member: 'debbie', login: '', problems: [], items: [
    { name: 'claude', value: `sk-ant-oat01-${'x'.repeat(40)}`, expiresAt: null },
    { name: 'copilot', value: 'gho_0123456789abcdef', expiresAt: null },
  ] }] }).ok, true);

  const began = Date.now();
  const reply = await dispatch(/** @type {any} */ ({
    sessions: sm, cfg, actor: 'fleet:debbie@members.invalid', via: 'fleet',
    memberEngines: 'codex,claude-code,opencode=github-copilot/gpt-4.1',
    task: 'Task t12. Fix the login redirect.',
    taskId: 't12', taskBranch: 'task/t12-fix-the-login',
    member: 'debbie', memberName: 'Debbie', memberRole: 'engineer', startedBy: 'fleet:dana@example.com',
  }), `/new ${name}`);
  const took = Date.now() - began;

  // THE START. Codex has no Remote Control and was never asked for one
  // (claude.js, buildCommand), so there is nothing to wait for and nothing
  // that failed to come up. It waited twice the timeout and then said
  // "but Remote Control did not come online" about every such session.
  assert.equal(reply.ok, true, reply.text);
  assert.match(reply.text, new RegExp(`^Started "${name}" in .* on Codex\\.$`, 'm'), reply.text);
  assert.doesNotMatch(reply.text, /Remote Control/, reply.text);
  assert.ok(took < 2 * RC_TIMEOUT, `the start took ${took} ms, which is the wait for a Remote Control link`);

  // CODEX → CLAUDE CODE → OPENCODE. Codex reports no sign-in within a moment
  // of its pane opening. Claude Code takes over and says it is at its limit
  // while the box is still waiting for its Remote Control link, which is when
  // that report used to be dropped: the session sat on an engine at its limit
  // with OpenCode never tried.
  await until(() => registry.get(name)?.engineAt === 2, 'the session on its third engine');
  assert.deepEqual((registry.get(name)?.engineLog ?? []).map((/** @type {any} */ e) => [e.from, e.to, e.reason]), [['codex', 'claude-code', 'auth'], ['claude-code', 'opencode', 'limit']]);
  await until(() => registry.get(name)?.turn?.engine === 'opencode', 'OpenCode’s turn ending');
  assert.equal(registry.get(name)?.turn?.reason, 'done');
  assert.equal(registry.get(name)?.status, 'running');

  // THE TASK WAS ON THE RECORD BEFORE THE FIRST ENGINE COULD REPORT. The note
  // written as Codex stopped names it; it used to be written from a record
  // the start had not yet finished filling in.
  const [first, second] = notes();
  assert.match(first, /^# Handoff: Codex to Claude Code$/m);
  assert.match(first, /\*\*Task:\*\* t12, on the branch task\/t12-fix-the-login\./);
  assert.match(second, /^# Handoff: Claude Code to OpenCode$/m);
  const rec = /** @type {any} */ (registry.get(name));
  assert.deepEqual([rec.member, rec.memberName, rec.startedBy, rec.taskId, rec.taskBranch], ['debbie', 'Debbie', 'fleet:dana@example.com', 't12', 'task/t12-fix-the-login']);
  // No link is left on a session whose pane is not Claude Code's.
  assert.equal(rec.rcUrl ?? null, null);
  assert.ok(existsSync(path.join(cfg.sandboxHookSocketDir, name)), 'the session kept its own socket across both moves');
});
