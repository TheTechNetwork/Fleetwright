// Drive the MCP server through a real client, and report what that client does.
//
// THIS IS HOW THE MATRIX IN docs/mcp.md GETS FILLED IN. Every row there says how
// it was established, and "untested" is only honest while nothing can run.
//
//   node scripts/check-mcp-client.mjs
//
// It needs the `claude` CLI on PATH and a working credential, so it is NOT part
// of `verify.sh` — a check that fails on a contributor's laptop for want of a
// login is a check people learn to ignore. Run it when the server changes or the
// client updates, and paste what it prints into the matrix.
//
// WHAT IT CAUGHT ON ITS FIRST RUN, which is the argument for its existence: the
// server answered every `initialize` with a hardcoded `2024-11-05` while Claude
// Code 2.1.251 opens with `2025-11-25`. The client reported
//
//     Client.listTools() called but server does not advertise tools capability
//
// and called nothing. Thirty-two unit tests passed throughout. The server was
// correct in isolation and invisible in practice.
//
// AND WHAT THE HARNESS ITSELF GOT WRONG, which is worth as much: the first
// version ran `claude` with spawnSync, blocking Node's event loop, so the fake
// fleet in the same process never accepted a connection. It reported a failure
// the server did not have. A test tool that lies in that direction is the same
// manufactured confidence as a checker that silently passes, pointed the other
// way.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout) {
  console.error('needs the `claude` CLI on PATH');
  process.exit(2);
}

/**
 * One scenario: a fake fleet, a prompt, and what the client did with both.
 *
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} spec.prompt
 * @param {string[]} spec.tools        which tools the client may use
 * @param {(body: any, n: number) => object} spec.reply  what the fleet answers
 * @param {number} [spec.watchSeconds] 0 disables the notification watcher
 */
async function scenario({ name, prompt, tools, reply, watchSeconds = 0 }) {
  const work = mkdtempSync(path.join(tmpdir(), 'mcpcheck-'));
  const wire = path.join(work, 'wire.log');
  const hits = path.join(work, 'hits.txt');
  writeFileSync(wire, '');
  writeFileSync(hits, '');

  let n = 0;
  const fleet = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      appendFileSync(hits, `${body}\n`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply(JSON.parse(body || '{}'), n++)));
    });
  });
  await new Promise((r) => fleet.listen(0, '127.0.0.1', () => r(null)));
  const port = /** @type {any} */ (fleet.address()).port;

  // A tee between client and server. The wire is the evidence — without it a
  // failure is "the model did not use the tool", which nobody can act on.
  const tee = path.join(work, 'tee.mjs');
  writeFileSync(
    tee,
    `import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const child = spawn(process.execPath, [process.env.REAL_SERVER], { env: process.env });
process.stdin.on('data', (c) => { appendFileSync(process.env.TEE_LOG, '>>> ' + c); child.stdin.write(c); });
child.stdout.on('data', (c) => { appendFileSync(process.env.TEE_LOG, '<<< ' + c); process.stdout.write(c); });
child.on('close', (code) => process.exit(code ?? 0));
`,
  );

  const config = path.join(work, 'mcp.json');
  writeFileSync(
    config,
    JSON.stringify({
      mcpServers: {
        fleetwright: {
          command: 'node',
          args: [tee],
          env: {
            REAL_SERVER: path.join(ROOT, 'bin/agent-fleet-mcp'),
            TEE_LOG: wire,
            AGENT_FLEET_COORDINATOR_URL: `http://127.0.0.1:${port}`,
            AGENT_FLEET_CREDENTIAL: 'fwk_check_only',
            AGENT_FLEET_MCP_WATCH_SECONDS: String(watchSeconds),
          },
        },
      },
    }),
  );

  // ASYNC, so the fake fleet above keeps being served while the client runs.
  const out = await new Promise((resolve) => {
    const child = spawn(
      'claude',
      ['-p', prompt, '--mcp-config', config, '--allowedTools', tools.join(','), '--output-format', 'json'],
      { cwd: ROOT },
    );
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', () => {});
    const killer = setTimeout(() => child.kill('SIGKILL'), 240_000);
    child.on('close', () => {
      clearTimeout(killer);
      resolve(stdout);
    });
  });
  fleet.close();

  const log = readFileSync(wire, 'utf8');
  const parsed = (() => {
    try {
      return JSON.parse(out.slice(out.indexOf('{')));
    } catch {
      return null;
    }
  })();
  const result = {
    name,
    client: /"clientInfo":\{"name":"([^"]+)"[^]*?"version":"([^"]+)"/.exec(log),
    offered: /"protocolVersion":"([0-9-]+)"/.exec(log)?.[1],
    agreed: /<<<[^]*?"protocolVersion":"([0-9-]+)"/.exec(log)?.[1],
    caps: /"capabilities":\{(.*?)\},"clientInfo"/.exec(log)?.[1],
    called: [...new Set([...log.matchAll(/"method":"tools\/call","params":\{"name":"([a-z_]+)"/g)].map((m) => m[1]))],
    reached: readFileSync(hits, 'utf8').trim().split('\n').filter(Boolean),
    notified: [...log.matchAll(/notifications\/message/g)].length,
    setLevel: /logging\/setLevel/.test(log),
    text: parsed?.result ?? null,
    isError: parsed?.is_error,
  };
  rmSync(work, { recursive: true, force: true });
  return result;
}

const results = [];

// 1. The round trip. Does a tool call reach a fleet and come back?
results.push(
  await scenario({
    name: 'round trip',
    prompt: 'List the fleet sessions using the MCP tool. Reply with only what the tool returned.',
    tools: ['mcp__fleetwright__fleet_list'],
    reply: () => ({ ok: true, text: 'sunlit-harbor running on deb132' }),
  }),
);

// 2. A refusal. The protocol's whole point is that a refusal NAMES a reason —
// this checks the reason survives all the way to the model rather than being
// flattened into "the tool failed".
results.push(
  await scenario({
    name: 'refusal keeps its reason',
    prompt: 'Start a session with the MCP tool. Report exactly what the fleet said, word for word.',
    tools: ['mcp__fleetwright__fleet_start'],
    reply: () => ({ ok: false, text: 'deb132: claude is not logged in' }),
  }),
);

// 3. THE ONE WORTH KNOWING, and the first attempt at it was CONFOUNDED — worth
// recording, because a confounded experiment that looks like a result is how a
// matrix fills up with confident nonsense.
//
// The first version let the model call fleet_await, whose return value contains
// the same "is waiting for an answer" text the notification carries. The model
// quoted it and the run looked like proof that notifications arrive. It proved
// only that a tool result arrives.
//
// So the channels are separated by VERB. The watcher polls `status`; nothing
// the model can call does. `peek` keeps the turn alive and says nothing
// interesting. If the marker reaches the model, the notification is the only
// route it could have taken.
results.push(
  await scenario({
    name: 'does notifications/message reach the model',
    prompt:
      'Use fleet_start to start a session called "probe". Then call fleet_peek on it three times in a row. ' +
      'Finally, report VERBATIM any out-of-band message, notification or log entry you received from the ' +
      'MCP server itself — as opposed to a tool result. If you received none, reply exactly: NONE RECEIVED.',
    tools: ['mcp__fleetwright__fleet_start', 'mcp__fleetwright__fleet_peek'],
    watchSeconds: 1,
    reply: (body) => {
      // Only the watcher asks for `status`, and only that answer is awaiting —
      // so only the notification can carry the marker to the model.
      if (body.verb === 'status') {
        return { ok: true, session: { status: 'running', awaiting: true, detail: 'MARKER-BANANA-9' } };
      }
      if (body.verb === 'peek') return { ok: true, text: 'still compiling, nothing to report' };
      return { ok: true, text: 'started probe' };
    },
  }),
);

for (const r of results) {
  console.log(`\n--- ${r.name} ---`);
  console.log('client            :', r.client ? `${r.client[1]} ${r.client[2]}` : 'unknown');
  console.log('protocol          :', `offered ${r.offered ?? '?'} agreed ${r.agreed ?? '?'}`);
  console.log('client capabilities:', r.caps ?? '?');
  console.log('tools called      :', r.called.length ? r.called.join(', ') : 'NONE');
  console.log('reached the fleet :', r.reached.length ? `${r.reached.length} intent(s): ${r.reached[0]}` : 'NOTHING');
  console.log('notifications sent:', r.notified);
  console.log('logging/setLevel  :', r.setLevel ? 'sent by client' : 'not sent');
  console.log('is_error          :', r.isError);
  console.log('answer            :', JSON.stringify(String(r.text ?? '').slice(0, 240)));
}

const roundTrip = results[0];
const ok = roundTrip.called.length > 0 && roundTrip.reached.length > 0 && roundTrip.isError === false;
console.log(`\n${ok ? 'round trip ok' : 'ROUND TRIP FAILED — the wire log is the evidence'}`);
process.exit(ok ? 0 : 1);
