// Drive the MCP server through a real client, and report what that client did.
//
// THIS IS HOW THE MATRIX IN docs/mcp.md GETS FILLED IN. Every row there says
// how it was established, and "untested" was the honest entry until something
// could run. This is that something.
//
//   node scripts/check-mcp-client.mjs
//
// It needs the `claude` CLI on PATH and a working Claude credential, so it is
// NOT part of `verify.sh` — a check that fails on a contributor's laptop for
// want of a login is a check people learn to ignore. Run it when the server or
// the client changes, and paste what it prints into the matrix.
//
// WHAT IT CAUGHT ON ITS FIRST RUN, which is the argument for its existence: the
// server answered every `initialize` with a hardcoded `2024-11-05` while Claude
// Code 2.1.251 opened with `2025-11-25`. The client reported
//
//     Client.listTools() called but server does not advertise tools capability
//
// and called nothing. Thirty-two unit tests passed throughout. The server was
// correct in isolation and invisible in practice, which is the exact gap a
// conformance run against a real client exists to close.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(path.join(tmpdir(), 'mcpcheck-'));
const wire = path.join(work, 'wire.log');
const hits = path.join(work, 'hits.txt');
writeFileSync(wire, '');
writeFileSync(hits, '');

if (!spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout) {
  console.error('needs the `claude` CLI on PATH');
  process.exit(2);
}

// A fleet that answers one thing, so the assertion is on the round trip rather
// than on anything real.
const fleet = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    appendFileSync(hits, `${body}\n`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, text: 'sunlit-harbor running on deb132' }));
  });
});
await new Promise((r) => fleet.listen(0, '127.0.0.1', () => r(null)));
const port = /** @type {any} */ (fleet.address()).port;

// A tee between client and server: the wire is the evidence, and without it a
// failure is "the model did not use the tool" with nothing behind it.
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
        },
      },
    },
  }),
);

// ASYNC, AND THIS IS NOT A STYLE CHOICE. The first version used spawnSync,
// which blocks Node's event loop — so the fake fleet created above never
// accepted a connection, and the harness reported
//
//   tools called      : fleet_list
//   reached the fleet : NOTHING
//
// which reads as a broken server and was a broken harness. The manual version
// of this ran the fleet as a SEPARATE PROCESS and worked, which is exactly how
// a test tool ends up trusted while being wrong.
const out = await new Promise((resolve) => {
  const child = spawn(
    'claude',
    [
      '-p',
      'List the fleet sessions using the MCP tool. Reply with only what the tool returned.',
      '--mcp-config', config,
      '--allowedTools', 'mcp__fleetwright__fleet_list',
      '--output-format', 'json',
    ],
    { cwd: ROOT },
  );
  let stdout = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', () => {});
  const killer = setTimeout(() => child.kill('SIGKILL'), 180_000);
  child.on('close', () => {
    clearTimeout(killer);
    resolve(stdout);
  });
});
fleet.close();
const parsed = (() => {
  try {
    return JSON.parse(out.slice(out.indexOf('{')));
  } catch {
    return null;
  }
})();
const log = readFileSync(wire, 'utf8');
const asked = /"protocolVersion":"([0-9-]+)"[^]*?"clientInfo":\{"name":"([^"]+)"[^]*?"version":"([^"]+)"/.exec(log);
const agreed = /<<<[^]*?"protocolVersion":"([0-9-]+)"/.exec(log);
const clientCaps = /"capabilities":\{(.*?)\},"clientInfo"/.exec(log);
const called = [...log.matchAll(/"method":"tools\/call","params":\{"name":"([a-z_]+)"/g)].map((m) => m[1]);
const reached = readFileSync(hits, 'utf8').trim().split('\n').filter(Boolean);

console.log('client            :', asked ? `${asked[2]} ${asked[3]}` : 'unknown');
console.log('protocol offered  :', asked?.[1] ?? '?');
console.log('protocol agreed   :', agreed?.[1] ?? '?');
console.log('client capabilities:', clientCaps?.[1] ?? '?');
console.log('tools called      :', called.length ? [...new Set(called)].join(', ') : 'NONE');
console.log('reached the fleet :', reached.length ? reached[0] : 'NOTHING');
console.log('result            :', parsed ? JSON.stringify(parsed.result) : '(unparseable)');
console.log('logging/setLevel  :', /logging\/setLevel/.test(log) ? 'sent by client' : 'not sent — this client does not use the logging capability');

const ok = called.length > 0 && reached.length > 0 && parsed && parsed.is_error === false;
rmSync(work, { recursive: true, force: true });
if (!ok) {
  console.error('\nThe client did not complete a round trip. The wire log above is the evidence.');
  process.exit(1);
}
console.log('\nround trip ok');
