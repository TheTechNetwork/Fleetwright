// `fleet_engine_signin`, the MCP tool over `enginesignin` (docs/engines.md,
// "Signing in on the machine"; docs/mcp.md): generated from the verb, named
// in two words, withheld until an operator allows it, and when allowed one
// intent beside the machine it names.

import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '../src/mcp/server.js';
import { toolsFor, verbOfTool, DEFAULT_DENY } from '../src/mcp/tools.js';
import { VERBS } from '../src/fleet/protocol/intents.js';

/** A server whose transport and fleet are both collected rather than real. */
function serverWith(/** @type {any} */ reply, /** @type {any} */ opts = {}) {
  /** @type {any[]} */
  const written = [];
  /** @type {any[]} */
  const sent = [];
  const server = new McpServer({
    coordinator: 'https://fleet.example',
    credential: 'fwk_test_secret',
    write: (/** @type {string} */ line) => written.push(JSON.parse(line)),
    fetch: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return { status: 200, json: async () => reply };
    }),
    ...opts,
  });
  return { server, written, sent };
}
const call = (/** @type {number} */ id, /** @type {any} */ args) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'fleet_engine_signin', arguments: args } });

test('the tool is the verb under a name of two words, with the verb’s own parameters and a machine to name', () => {
  const tool = toolsFor({ allow: ['enginesignin'] }).find((t) => t.verb === 'enginesignin');
  assert.equal(tool?.name, 'fleet_engine_signin');
  assert.deepEqual(tool?.inputSchema.required, ['member', 'engine', 'action']);
  // Not the key a phone has its answer sealed to: an agent has none, so its answers are in the clear.
  assert.equal(tool?.inputSchema.properties.reply, undefined);
  assert.deepEqual(tool?.inputSchema.properties.engine.enum, VERBS.enginesignin.params.engine.values);
  assert.deepEqual(tool?.inputSchema.properties.action.enum, ['start', 'status', 'cancel', 'signout']);
  assert.equal(typeof tool?.inputSchema.properties.host?.description, 'string');
  assert.equal(tool?.mutating, true);
  // Whoever picks the tool is told, before calling it, that what it hands back is not checked here.
  assert.match(String(tool?.description), /THE PAGE AND CODE ARE UNVERIFIED HERE: the machine signs them and a phone checks that signature before it shows a code, and this server cannot/);
  // The way back from a tool's name to its verb, which is not always what is left after `fleet_`.
  assert.deepEqual([verbOfTool('fleet_engine_signin'), verbOfTool('fleet_stop'), verbOfTool('fleet_read_log')], ['enginesignin', 'stop', 'read_log']);
  // Every other verb's tool is still named as it was.
  for (const t of toolsFor({ allow: DEFAULT_DENY }).filter((x) => x.verb && x.name !== 'fleet_engine_signin' && !x.local && x.name !== 'fleet_read_log')) assert.equal(t.name, `fleet_${t.verb}`);
});

test('it is withheld unless an operator allows it, and says so under its own name, with the word that allows it', async () => {
  assert.equal(toolsFor().some((t) => t.verb === 'enginesignin'), false);
  const { server, written, sent } = serverWith({ ok: true });
  await server.handleLine(call(1, { member: 'debbie', engine: 'codex', action: 'start', host: 'ops-box' }));
  assert.equal(written[0].result.isError, true);
  assert.match(written[0].result.content[0].text, /^fleet_engine_signin is not exposed by this server\./);
  assert.match(written[0].result.content[0].text, /FLEETWRIGHT_MCP_ALLOW=enginesignin /);
  assert.deepEqual(sent, []);
});

test('allowed, a call is one enginesignin intent beside the machine it names, and the box’s answer is what the agent reads, a refusal included', async () => {
  const waiting = { ok: true, state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH', text: 'Open https://auth.openai.com/codex/device and enter ABCD-EFGH to sign Codex in for debbie on ops-box. The code lasts about 15 more minutes.' };
  const { server, written, sent } = serverWith(waiting, { allow: ['enginesignin'] });
  await server.handleLine(call(1, { member: 'debbie', engine: 'codex', action: 'start', host: 'ops-box' }));
  assert.deepEqual([sent[0].url, sent[0].body.verb, sent[0].body.params, sent[0].body.host], ['https://fleet.example/api/intent', 'enginesignin', { member: 'debbie', engine: 'codex', action: 'start' }, 'ops-box']);
  assert.equal(written[0].result.isError, undefined);
  assert.match(written[0].result.content[0].text, /Open https:\/\/auth\.openai\.com\/codex\/device and enter ABCD-EFGH /);
  // AND THAT THE CODE IS UNVERIFIED, in the words the agent reads, whether or
  // not the answer came signed: this server has no list of approved machines
  // to hold a signature to.
  const unverified = /\n\nUNVERIFIED\. This server cannot check that the page and code above came from the machine and not from the fleet’s coordinator, which carries them\. A phone checks the machine’s signature against the machines approved for the member’s credentials before it shows a code\. Tell the person the code is unverified, or have them sign in from the Fleetwright app, on the member’s Credentials\.$/;
  assert.match(written[0].result.content[0].text, unverified);
  const signedToo = serverWith({ ...waiting, signedAt: 1764000001000, hostKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, signature: 'sig' }, { allow: ['enginesignin'] });
  await signedToo.server.handleLine(call(7, { member: 'debbie', engine: 'codex', action: 'status', host: 'ops-box' }));
  assert.match(signedToo.written[0].result.content[0].text, unverified);
  // An answer with no code has nothing to be unverified about.
  const over = serverWith({ ok: true, state: 'signed_in', text: 'Codex is signed in for debbie on ops-box.' }, { allow: ['enginesignin'] });
  await over.server.handleLine(call(8, { member: 'debbie', engine: 'codex', action: 'status', host: 'ops-box' }));
  assert.equal(over.written[0].result.content[0].text, 'Codex is signed in for debbie on ops-box.');
  // What the verb needs is asked for before anything is sent.
  await server.handleLine(call(2, { member: 'debbie', action: 'start', host: 'ops-box' }));
  assert.equal(written[1].result.isError, true);
  assert.equal(sent.length, 1);

  const refused = serverWith({ ok: false, error: { code: 'member_not_delegated' }, text: 'What eli@example.com granted this connection does not cover signing an engine in for Debbie: it names no member.' }, { allow: ['enginesignin'] });
  await refused.server.handleLine(call(3, { member: 'debbie', engine: 'codex', action: 'status', host: 'ops-box' }));
  assert.equal(refused.written[0].result.isError, true);
  assert.match(refused.written[0].result.content[0].text, /does not cover signing an engine in for Debbie/);
});
