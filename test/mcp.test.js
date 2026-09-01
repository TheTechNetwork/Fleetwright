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

test('no verb parameter is unreachable from any tool', () => {
  // This used to say the PLAIN tool must offer every parameter of its verb, so
  // that a hand-maintained list could not drift from the protocol. The property
  // it was really protecting is that nothing becomes unreachable — and a verb
  // may now be split across two tools on purpose: `logs` does two jobs, so
  // fleet_logs is the service journal and fleet_read_log is the session's
  // output. Both are generated; neither invents anything; between them every
  // parameter is still callable.
  const tools = toolsFor();
  for (const [verb, def] of Object.entries(VERBS)) {
    const forVerb = tools.filter((t) => t.verb === verb && !t.local);
    if (!forVerb.length) continue; // denied by default, which is its own test
    const offered = new Set(forVerb.flatMap((t) => Object.keys(t.inputSchema.properties)));
    for (const param of Object.keys(def.params || {})) {
      assert.ok(offered.has(param), `${verb}: no tool offers ${param}`);
    }
  }
});

test('every exposed tool is a real verb, with the verb\'s own parameters', () => {
  // The point of generating them. A hand-written tool list is a second list to
  // keep in step, and it goes wrong silently: a tool offering a parameter the
  // host will refuse, or missing one the verb needs, found by an agent
  // mid-task rather than by anybody reading either file.
  for (const tool of toolsFor()) {
    const def = VERBS[tool.verb];
    assert.ok(def, `${tool.name} names a verb that does not exist`);
    // An alias may narrow — fleet_read_log is `logs` with the service half
    // dropped, because a tool that does two jobs reads as whichever one it is
    // named after. It may not INVENT, which is what the second loop checks.
    // An alias may narrow (fleet_read_log drops the service half) or replace
    // the schema entirely (fleet_await waits locally and takes its own
    // parameters). What none of them may do is claim to be the plain verb.
    const isAlias = tool.name !== `fleet_${tool.verb}`;
    if (isAlias) continue;
    for (const param of Object.keys(tool.inputSchema.properties)) {
      // `host` and `tag` are PLACEMENT, carried beside the intent rather than
      // in it — which is also why a tag could never be a verb parameter:
      // adding one to an existing verb is a flag day.
      if (param === 'host' || param === 'tag') continue;
      assert.ok(param in (def.params || {}), `${tool.name} offers ${param}, which ${tool.verb} does not take`);
    }
  }
});

test('required stays required, and enums keep their values', () => {
  const tools = toolsFor({ allow: ['answer'] }).filter((t) => t.name === `fleet_${t.verb}`);
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

// --- being told, rather than polling ----------------------------------------

/** A server with a fake clock, so a blocking tool can be tested without waiting. */
function awaitServer(replies) {
  const written = [];
  let clock = 0;
  let i = 0;
  const server = new McpServer({
    coordinator: 'https://fleet.example',
    credential: 'fwk_a_b',
    write: (line) => written.push(JSON.parse(line)),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    fetch: async () => ({ status: 200, json: async () => replies[Math.min(i++, replies.length - 1)] }),
  });
  return { server, written, calls: () => i };
}

test('waiting returns the moment a session needs a person', async () => {
  // "should mcp be able to notify llm a task needs help or a task is complete?"
  // An MCP server can send notifications and cannot reliably WAKE a model: a
  // notification arrives on the transport, and whether it reaches the model
  // depends on the client — one not in a turn is not listening. A tool that
  // BLOCKS needs no waking. The return value is the notification.
  const { server, written, calls } = awaitServer([
    { ok: true, session: { status: 'running', awaiting: false } },
    { ok: true, session: { status: 'running', awaiting: false } },
    { ok: true, session: { status: 'running', awaiting: true, detail: 'Do you trust this project?' } },
  ]);
  await server.handleLine(rpc(1, 'tools/call', { name: 'fleet_await', arguments: { name: 'mine', seconds: 300 } }));

  assert.match(written[0].result.content[0].text, /waiting for an answer/);
  assert.match(written[0].result.content[0].text, /Do you trust this project\?/);
  assert.equal(calls() >= 3, true, 'it should have kept asking until something changed');
  // Not an error: needing a person is an outcome, not a failure.
  assert.equal(written[0].result.isError, undefined);
});

test('waiting returns when the session ends, and points at the output', async () => {
  const { server, written } = awaitServer([
    { ok: true, session: { status: 'running', awaiting: false } },
    { ok: true, session: { status: 'stopped', awaiting: false } },
  ]);
  await server.handleLine(rpc(1, 'tools/call', { name: 'fleet_await', arguments: { name: 'mine' } }));
  assert.match(written[0].result.content[0].text, /has ended/);
  // The pane is gone by now; the log is not.
  assert.match(written[0].result.content[0].text, /fleet_read_log/);
});

test('a session still running at the deadline is not a failure', async () => {
  // Calling it one would push an agent into stopping work that is going fine.
  const { server, written } = awaitServer([{ ok: true, session: { status: 'running', awaiting: false } }]);
  await server.handleLine(rpc(1, 'tools/call', { name: 'fleet_await', arguments: { name: 'mine', seconds: 10 } }));
  assert.equal(written[0].result.isError, undefined);
  assert.match(written[0].result.content[0].text, /still running after 10s/);
  assert.match(written[0].result.content[0].text, /not a failure/);
});

test('an errored session is reported as an error', async () => {
  const { server, written } = awaitServer([{ ok: true, session: { status: 'error', awaiting: false } }]);
  await server.handleLine(rpc(1, 'tools/call', { name: 'fleet_await', arguments: { name: 'mine' } }));
  assert.equal(written[0].result.isError, true);
  assert.match(written[0].result.content[0].text, /has failed/);
});

test('read_log is the session half of logs, and says why it is not peek', () => {
  const tool = toolsFor().find((t) => t.name === 'fleet_read_log');
  assert.equal(tool.verb, 'logs');
  // The service half is dropped: a tool that does two jobs reads as whichever
  // one it is named after, which is why `fleet_logs` was never reached for
  // collecting a job's output.
  assert.equal('service' in tool.inputSchema.properties, false);
  assert.deepEqual(tool.inputSchema.required, ['name']);
  // It used to promise "Survives the session ending", and an agent that
  // believed it followed the documented order — collect, then stop — and was
  // answered "no container and no pane" by the tool that had promised to
  // survive. Output lives in the container; a STOP removes it. The order is
  // stated on both tools now.
  assert.match(tool.description, /BEFORE YOU STOP THE SESSION/);
  assert.match(String(toolsFor().find((t) => t.name === 'fleet_stop')?.description), /fleet_read_log FIRST/);
});

// --- the notification convention, followed ----------------------------------

test('logging is declared, so a client that supports it can find out', async () => {
  // "The bar is implementing the protocols and documenting which clients
  // implement them correctly." A server that keeps quiet because support varies
  // has decided on every client's behalf; declaring the capability is how one
  // that DOES support it discovers there is something to show.
  const { server, written } = serverWith();
  await server.handleLine(rpc(1, 'initialize'));
  assert.deepEqual(written[0].result.capabilities.logging, {});
});

test('a level set by the client is accepted, not ignored', async () => {
  // A server that declares the capability and then ignores setLevel is worse
  // than one that never declared it.
  const { server, written } = serverWith();
  await server.handleLine(rpc(1, 'logging/setLevel', { level: 'debug' }));
  assert.deepEqual(written[0].result, {});
  assert.equal(server.logLevel, 'debug');
});

/** A server whose watcher can be driven a tick at a time. */
function watchedServer(sequence) {
  const written = [];
  let i = 0;
  /** @type {Array<() => void>} */
  const timers = [];
  const server = new McpServer({
    coordinator: 'https://fleet.example',
    credential: 'fwk_a_b',
    write: (line) => written.push(JSON.parse(line)),
    watchMs: 1,
    setTimer: (fn) => timers.push(fn),
    fetch: async () => ({ status: 200, json: async () => sequence[Math.min(i++, sequence.length - 1)] }),
  });
  return { server, written, tick: async () => { const fn = timers.shift(); if (fn) await fn(); } };
}

test('a session that needs help is announced without being asked', async () => {
  // The case that matters: an agent that has moved on and would otherwise never
  // look again. fleet_await is the guaranteed path; this is the courtesy that
  // reaches a client which is not currently in a tool call.
  const { server, written, tick } = watchedServer([
    { ok: true, text: 'started' },
    { ok: true, session: { status: 'running', awaiting: true } },
  ]);
  await server.handleLine(rpc(1, 'tools/call', { name: 'fleet_start', arguments: { name: 'mine' } }));
  await tick();

  const note = written.find((m) => m.method === 'notifications/message');
  assert.ok(note, 'expected a notification');
  assert.equal(note.params.level, 'warning');
  assert.equal(note.params.data.state, 'awaiting');
  // A notification has no id. One with an id is a request, and a client that
  // takes it as one will wait for a reply that never comes.
  assert.equal('id' in note, false);
});

test('a finished session is announced once, and then stops being watched', async () => {
  const { server, written, tick } = watchedServer([
    { ok: true, text: 'started' },
    { ok: true, session: { status: 'stopped' } },
  ]);
  await server.handleLine(rpc(1, 'tools/call', { name: 'fleet_start', arguments: { name: 'mine' } }));
  await tick();
  await tick();

  const notes = written.filter((m) => m.method === 'notifications/message');
  assert.equal(notes.length, 1, 'a session ends once');
  assert.match(notes[0].params.data.message, /has ended/);
  // And the watcher lets go: a timer alive after the last session is a stdio
  // server that will not exit, which a client reads as a hung process.
  assert.equal(server.started.size, 0);
});

test('nothing is announced about sessions this conversation did not start', async () => {
  // Watching the fleet would mean narrating somebody else's work to an agent
  // with no business in it — the same scope `stop` is held to.
  const { server, written, tick } = watchedServer([{ ok: true, session: { status: 'running', awaiting: true } }]);
  await server.handleLine(rpc(1, 'tools/call', { name: 'fleet_list', arguments: {} }));
  await tick();
  assert.equal(written.filter((m) => m.method === 'notifications/message').length, 0);
});

test('watching can be turned off entirely', async () => {
  // For a client that shows notifications to the PERSON rather than the model,
  // a session finishing is a line they did not ask for.
  const { server, written } = serverWith({ ok: true, text: 'started' }, { watchMs: 0 });
  await server.handleLine(rpc(1, 'tools/call', { name: 'fleet_start', arguments: { name: 'mine' } }));
  assert.equal(server.watching, false);
  assert.equal(written.filter((m) => m.method === 'notifications/message').length, 0);
});

// --- the handshake ----------------------------------------------------------

test('the protocol version is negotiated, not announced', async () => {
  // THE BUG A REAL CLIENT FOUND AND THIRTY-TWO TESTS DID NOT. This server
  // answered every initialize with a hardcoded '2024-11-05'. Claude Code
  // 2.1.251 opens with '2025-11-25', and reported:
  //
  //   Client.listTools() called but server does not advertise tools capability
  //
  // — then called nothing. The server was correct in isolation and invisible in
  // practice. A hardcoded version is not following the convention; it is
  // ignoring the half of the handshake that exists to be answered.
  const { server, written } = serverWith();
  await server.handleLine(rpc(1, 'initialize', { protocolVersion: '2025-11-25' }));
  assert.equal(written[0].result.protocolVersion, '2025-11-25');
});

test('a revision we know is echoed, and one we do not gets ours', async () => {
  // The spec's rule: echo the client's version when supported, otherwise answer
  // with your own and let the client decide whether to continue.
  for (const [asked, expected] of [
    ['2025-11-25', '2025-11-25'],
    ['2024-11-05', '2024-11-05'],
    ['1999-01-01', '2025-11-25'],
    [undefined, '2025-11-25'],
  ]) {
    const { server, written } = serverWith();
    await server.handleLine(rpc(1, 'initialize', asked ? { protocolVersion: asked } : {}));
    assert.equal(written[0].result.protocolVersion, expected, `asked ${asked}`);
  }
});

test('tools are advertised on every revision we accept', () => {
  // The capability itself was never the problem, which is why this asserts the
  // pairing rather than the field: a version mismatch is what made a correctly
  // declared capability unreadable.
  assert.ok(toolsFor().length > 0);
});
