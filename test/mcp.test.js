import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '../src/mcp/server.js';
import { toolsFor, DEFAULT_DENY } from '../src/mcp/tools.js';
import { VERBS } from '../src/fleet/protocol/intents.js';

/** A server whose transport and fleet are both collected rather than real. */
function serverWith(reply = { ok: true, text: 'done' }, opts = {}) {
  const written = [];
  const sent = [];
  const server = new McpServer({
    coordinator: 'https://fleet.example',
    credential: 'fwk_test_secret',
    write: (line) => written.push(JSON.parse(line)),
    fetch: async (url, init) => {
      sent.push({ url, body: JSON.parse(String(init.body)), headers: init.headers });
      return { status: 200, json: async () => (typeof reply === 'function' ? reply() : reply) };
    },
    ...opts,
  });
  return { server, written, sent };
}

const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

// --- the tools come from the verbs ------------------------------------------

test('every exposed tool is a real verb, with the verb\'s own parameters', () => {
  // The point of generating them. A hand-written tool list is a second list to
  // keep in step, and it goes wrong silently: a tool offering a parameter the
  // host will refuse, or missing one the verb needs, found by an agent
  // mid-task rather than by anybody reading either file.
  for (const tool of toolsFor()) {
    const def = VERBS[tool.verb];
    assert.ok(def, `${tool.name} names a verb that does not exist`);
    for (const param of Object.keys(def.params || {})) {
      assert.ok(param in tool.inputSchema.properties, `${tool.name} is missing ${param}`);
    }
    for (const param of Object.keys(tool.inputSchema.properties)) {
      // `host` is placement, carried beside the intent rather than in it.
      if (param === 'host') continue;
      assert.ok(param in (def.params || {}), `${tool.name} offers ${param}, which ${tool.verb} does not take`);
    }
  }
});

test('required stays required, and enums keep their values', () => {
  const tools = toolsFor({ allow: ['answer'] });
  for (const tool of tools) {
    const def = VERBS[tool.verb];
    const wanted = Object.entries(def.params || {}).filter(([, s]) => s.required).map(([p]) => p).sort();
    assert.deepEqual((tool.inputSchema.required || []).sort(), wanted, tool.name);
    for (const [param, spec] of Object.entries(def.params || {})) {
      if (spec.type === 'enum') {
        assert.deepEqual(tool.inputSchema.properties[param].enum, spec.values, `${tool.name}.${param}`);
      }
    }
  }
});

test('the dangerous verbs are not exposed by default', () => {
  // Not a security boundary — whoever runs this holds a credential and can call
  // the API directly. It is about what an agent reaches for unasked, which is a
  // different question from what a person may do.
  const exposed = toolsFor().map((t) => t.verb);
  for (const verb of ['reboot', 'purge', 'forget', 'connect', 'unlink', 'answer']) {
    assert.equal(exposed.includes(verb), false, `${verb} should not be exposed by default`);
  }
  assert.deepEqual(exposed.includes('list'), true);
  assert.deepEqual(exposed.includes('start'), true);
  // `stop` IS exposed, and used not to be. Withholding it made "clean up after
  // yourself" an instruction the agent could not follow, and an instruction
  // that cannot be followed is a lie the moment it is read. It is scoped in the
  // server instead — see the test below.
  assert.deepEqual(exposed.includes('stop'), true);
});

test('a withheld verb can be allowed explicitly, one at a time', () => {
  const exposed = toolsFor({ allow: ['answer'] }).map((t) => t.verb);
  assert.equal(exposed.includes('answer'), true);
  // And allowing one does not open the rest.
  assert.equal(exposed.includes('reboot'), false);
});

// --- the protocol -----------------------------------------------------------

test('initialize is answered, and a notification is not', async () => {
  const { server, written } = serverWith();
  await server.handleLine(rpc(1, 'initialize'));
  assert.equal(written.length, 1);
  assert.equal(written[0].result.serverInfo.name, 'fleetwright');

  // ANSWERING A NOTIFICATION IS A PROTOCOL ERROR that some clients tolerate and
  // others hang on. It has no id, so there is nobody to answer.
  await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(written.length, 1, 'a notification must not be replied to');
});

test('a line that is not JSON never reaches stdout', async () => {
  // stdout IS the protocol. A stray line there desynchronises the client, and
  // the symptom is a server that "does not work" with nothing to read.
  const logged = [];
  const { server, written } = serverWith({ ok: true }, { log: (m) => logged.push(m) });
  await server.handleLine('this is not json');
  assert.equal(written.length, 0);
  assert.equal(logged.length, 1);
});

test('a tool call becomes one intent, with the credential and the host', async () => {
  const { server, written, sent } = serverWith({ ok: true, text: 'started sunlit-harbor' });
  await server.handleLine(rpc(2, 'tools/call', { name: 'fleet_start', arguments: { title: 'a build', host: 'gha-mac-1' } }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://fleet.example/api/intent');
  assert.equal(sent[0].body.verb, 'start');
  assert.equal(sent[0].body.params.title, 'a build');
  // `host` travels BESIDE the intent, not inside its params — it is placement,
  // and the protocol has no host parameter.
  assert.equal(sent[0].body.host, 'gha-mac-1');
  assert.equal('host' in sent[0].body.params, false);
  assert.match(sent[0].headers.authorization, /^Bearer fwk_/);
  assert.match(written[0].result.content[0].text, /sunlit-harbor/);
});

test('a refusal is passed through with its reason, not flattened to "failed"', async () => {
  // The property the protocol was built for and the one an agent most needs:
  // a refusal that names the obstacle can be acted on.
  const { server, written } = serverWith({ ok: false, text: 'deb132: claude is not logged in' });
  await server.handleLine(rpc(3, 'tools/call', { name: 'fleet_start', arguments: {} }));

  const result = written[0].result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /claude is not logged in/);
  // A tool error, not a JSON-RPC error: the call was well formed.
  assert.equal(written[0].error, undefined);
});

test('a withheld verb says it was withheld, not that it does not exist', async () => {
  // Two different situations. An agent told only "no" tries again differently
  // rather than stopping.
  const { server, written } = serverWith();
  await server.handleLine(rpc(4, 'tools/call', { name: 'fleet_reboot', arguments: {} }));
  assert.equal(written[0].result.isError, true);
  assert.match(written[0].result.content[0].text, /not exposed by this server/);

  await server.handleLine(rpc(5, 'tools/call', { name: 'fleet_nonsense', arguments: {} }));
  assert.match(written[0 + 1].result.content[0].text, /No such tool/);
});

test('an unreachable fleet is a tool error, not a dead session', async () => {
  const { server, written } = serverWith(undefined, {
    fetch: async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    },
  });
  await server.handleLine(rpc(6, 'tools/call', { name: 'fleet_list', arguments: {} }));
  assert.equal(written[0].result.isError, true);
  assert.match(written[0].result.content[0].text, /Could not reach the fleet/);
  assert.equal(written[0].error, undefined);
});

test('a revoked credential says so in words', async () => {
  const { server, written } = serverWith(undefined, {
    fetch: async () => ({ status: 403, json: async () => ({}) }),
  });
  await server.handleLine(rpc(7, 'tools/call', { name: 'fleet_list', arguments: {} }));
  assert.match(written[0].result.content[0].text, /revoked from the app/);
});

test('an unknown method is a JSON-RPC error with the right code', async () => {
  const { server, written } = serverWith();
  await server.handleLine(rpc(8, 'tools/nonsense'));
  assert.equal(written[0].error.code, -32601);
});

test('the secret never comes back out', () => {
  // A `secret` parameter is described as one so a client that redacts anything
  // redacts this — and nothing in the tool list carries a value.
  const linkTool = toolsFor({ allow: ['link'] }).find((t) => t.verb === 'link');
  const secretParam = Object.entries(VERBS.link.params).find(([, s]) => s.type === 'secret');
  assert.ok(secretParam, 'link should take a secret');
  assert.match(linkTool.inputSchema.properties[secretParam[0]].description, /never echoed back/);
  assert.equal(JSON.stringify(toolsFor()).includes('fwk_'), false);
});

// --- the binary, over a real pipe -------------------------------------------

test('the binary speaks the protocol on stdio, against a real socket', async () => {
  // EVERYTHING ABOVE TESTS THE CLASS. This tests the thing a client launches:
  // the argv handling, the readline framing, the serialisation, and that
  // nothing but protocol reaches stdout. Three separate bugs this week were in
  // exactly this gap — code that was right, in a wrapper nobody executed.
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:http');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  const fleet = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, text: `pretend ${JSON.parse(body).verb} ran` }));
    });
  });
  await new Promise((r) => fleet.listen(0, '127.0.0.1', () => r(null)));
  const port = /** @type {any} */ (fleet.address()).port;

  const mcp = spawn(process.execPath, [path.join(root, 'bin/agent-fleet-mcp')], {
    env: {
      ...process.env,
      AGENT_FLEET_COORDINATOR_URL: `http://127.0.0.1:${port}`,
      AGENT_FLEET_CREDENTIAL: 'fwk_abc_def',
    },
  });
  let out = '';
  mcp.stdout.on('data', (c) => (out += c));

  const send = (o) => mcp.stdin.write(`${JSON.stringify(o)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fleet_list', arguments: {} } });
  await new Promise((r) => setTimeout(r, 700));
  mcp.stdin.end();
  await new Promise((r) => mcp.on('close', () => r(null)));
  fleet.close();

  const replies = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(replies.length, 3, 'four messages, three replies — the notification gets none');
  assert.equal(replies[0].result.serverInfo.name, 'fleetwright');
  assert.ok(replies[1].result.tools.length > 0);
  assert.match(replies[2].result.content[0].text, /pretend list ran/);
});

test('the binary refuses to start without a fleet to talk to', async () => {
  // And says which of the two things is missing, on stderr, where a client
  // shows it — rather than starting and failing on the first call.
  const { spawnSync } = await import('node:child_process');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  const r = spawnSync(process.execPath, [path.join(root, 'bin/agent-fleet-mcp')], {
    env: { ...process.env, AGENT_FLEET_COORDINATOR_URL: '', AGENT_FLEET_CREDENTIAL: '' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '', 'nothing but protocol on stdout, even when refusing');
  assert.match(r.stderr, /AGENT_FLEET_CREDENTIAL/);
});

// --- the lifecycle contract -------------------------------------------------

test('initialize hands the agent the contract, not just the capabilities', async () => {
  // THE ANSWER TO "NOTHING REPORTS COMPLETION". The fleet does not need a new
  // signal if the thing driving it is told what it owns and what it costs — a
  // deadline in prose an agent can act on beats a callback that has to be
  // built, and it is honest about who is deciding.
  const { server, written } = serverWith({}, { budgetMinutes: 15 });
  await server.handleLine(rpc(1, 'initialize'));
  const text = written[0].result.instructions;

  assert.match(text, /15 minutes/);
  assert.match(text, /Work you start is work you own/i);
  assert.match(text, /finished session looks exactly like an idle one/);
  // The cost, because an agent that knows the verbs and not the consequences
  // leaves a Mac idling until a timer nobody mentioned kills it.
  assert.match(text, /cost money while they live/i);
  assert.match(text, /gha-/);
});

test('the budget in the instructions is the one it was configured with', async () => {
  const { server, written } = serverWith({}, { budgetMinutes: 45 });
  await server.handleLine(rpc(1, 'initialize'));
  assert.match(written[0].result.instructions, /45 minutes/);
  assert.equal(/15 minutes/.test(written[0].result.instructions), false);
});

test('an agent may stop what it started, and nothing else', async () => {
  // `stop` used to be withheld entirely, which made "clean up after yourself"
  // an instruction the agent could not follow — and an instruction that cannot
  // be followed is a lie the moment it is read.
  const { server, written } = serverWith({ ok: true, text: 'ok' });

  // Somebody else's session, by name.
  await server.handleLine(rpc(1, 'tools/call', { name: 'fleet_stop', arguments: { name: 'someone-elses' } }));
  assert.equal(written[0].result.isError, true);
  assert.match(written[0].result.content[0].text, /not yours to stop/);

  // Now start one, and it becomes stoppable.
  await server.handleLine(rpc(2, 'tools/call', { name: 'fleet_start', arguments: { name: 'mine' } }));
  await server.handleLine(rpc(3, 'tools/call', { name: 'fleet_stop', arguments: { name: 'mine' } }));
  assert.equal(written[2].result.isError, undefined);
});

test('a session that failed to start is not remembered as ours', async () => {
  // Otherwise a refused start hands the agent permission to stop a name it
  // never created — which, on a fleet where names are chosen by people, is
  // somebody else's session.
  const { server, written } = serverWith({ ok: false, text: 'no hosts' });
  await server.handleLine(rpc(1, 'tools/call', { name: 'fleet_start', arguments: { name: 'never-ran' } }));
  await server.handleLine(rpc(2, 'tools/call', { name: 'fleet_stop', arguments: { name: 'never-ran' } }));
  assert.match(written[1].result.content[0].text, /not yours to stop/);
});

test('stopping forgets it, so a second stop is refused', async () => {
  const { server, written } = serverWith({ ok: true, text: 'ok' });
  await server.handleLine(rpc(1, 'tools/call', { name: 'fleet_start', arguments: { name: 'mine' } }));
  await server.handleLine(rpc(2, 'tools/call', { name: 'fleet_stop', arguments: { name: 'mine' } }));
  await server.handleLine(rpc(3, 'tools/call', { name: 'fleet_stop', arguments: { name: 'mine' } }));
  assert.match(written[2].result.content[0].text, /not yours to stop/);
});

test('the tools carry the reminder, not only the preamble', () => {
  // A model that read the instructions twenty tool calls ago is not reliably
  // still holding them.
  const tools = toolsFor({ budgetMinutes: 15 });
  assert.match(tools.find((t) => t.verb === 'start').description, /own what you start/i);
  assert.match(tools.find((t) => t.verb === 'peek').description, /no completion signal/);
  assert.match(tools.find((t) => t.verb === 'stop').description, /Only sessions you started here/);
});
