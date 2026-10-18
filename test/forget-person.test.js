// Somebody removed from the fleet, forgotten by one of the fleet's own boxes.
//
//   node --test test/forget-person.test.js
//
// The coordinator's half (test/config-frame.test.js) is that each such box
// owes the forgetting until it says it is done. This is the box's half, end to
// end over the real pieces: the coordinator sends `forgetperson`, the sidecar
// carries it, the hub's own loopback API does it to its own files, and the
// box's yes is what settles the debt. Before it, a removed member's session
// on such a box kept running as them and came back after a reboot, and the
// hourly renewal went on minting their GitHub token (ninth audit).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { Sidecar } from '../src/fleet/host/sidecar.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { HttpAdapter } from '../src/adapters/http.js';
import { ensureApiToken } from '../src/core/api-token.js';
import { Registry } from '../src/core/registry.js';
import { SessionManager } from '../src/core/sessions.js';
import { Accounts } from '../src/core/accounts.js';
import { Connections } from '../src/core/connectors.js';
import { renewProviderTokens } from '../src/core/keepalive.js';
import { applyVault, heldFor } from '../src/core/vault-store.js';
import { admit } from './helpers/enrolled-hosts.js';

const LOGGER = { info() {}, warn() {}, error() {}, debug() {} };
const NINA = 'nina@example.test';
const KIM = 'kim@example.test';
const CREDENTIAL = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-x', expiresAt: Date.now() + 3_600_000 } });

/** @param {() => boolean} done @param {string} what */
async function until(done, what) {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(done(), what);
}

test('a box told to forget somebody removed ends their sessions and every sign-in it keeps for them, and nobody else’s', async (t) => {
  const core = new CoordinatorCore({ logger: LOGGER });
  await core.issueClient({ email: 'boss@example.test' }, 'phone');
  const nina = /** @type {any} */ (await core.issueClient({ email: NINA }, 'phone'));
  await core.issueClient({ email: KIM }, 'phone');

  // The box's own fleetwright: its registry, its stores, its loopback API.
  const stateDir = mkdtempSync(join(tmpdir(), 'fw-forget-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const cfg = /** @type {any} */ ({
    stateDir, bind: '127.0.0.1', port: 0, token: '', hostname: 'ops-box', workdir: stateDir,
    maxSessions: 4, binTtlMs: 7 * 86_400_000, sandbox: false, claudeBin: 'claude', remoteControl: false, skipPermissions: false,
  });
  const registry = new Registry({ stateFile: join(stateDir, 'state.json'), spoolFile: join(stateDir, 'spool.jsonl') });
  const tag = randomBytes(4).toString('hex');
  const ninaJob = `nina-${tag}`;
  const kimJob = `kim-${tag}`;
  // Hers ended with the box and is due back on its next boot; his is stopped.
  registry.upsert(ninaJob, { status: 'running', resumeOnBoot: true, uuid: 'u-nina', createdBy: `fleet:${NINA}` });
  registry.upsert(kimJob, { status: 'stopped', uuid: 'u-kim', createdBy: `fleet:${KIM}` });
  const sessions = new SessionManager(cfg, registry, null);
  sessions.reconcile = () => {};
  const accounts = new Accounts(stateDir);
  const connections = new Connections(stateDir);
  for (const who of [NINA, KIM]) {
    accounts.save(who, CREDENTIAL);
    connections.save(who, 'github', `ghu_${who.slice(0, 4)}000000000000000000000000`, who, null);
    connections.saveRenewal(who, 'github', { clientId: 'Iv23liTEST', refresh: `ghr_${who.slice(0, 4)}00000000000000000000000`, expiresIn: 1 });
  }
  applyVault(cfg, { accounts: [NINA, KIM].map((email) => ({ email, login: '', items: [{ name: 'cloudflare', value: 'cf_access', expiresAt: null }] })) });

  const hubToken = ensureApiToken(cfg);
  const adapter = new HttpAdapter(cfg, { sessions, login: /** @type {any} */ ({}), token: hubToken });
  await adapter.start();
  t.after(() => adapter.server?.close());
  const port = /** @type {any} */ (adapter.server).address().port;

  await admit(core, 'ops-box', { enrolledBy: 'boss@example.test' });
  const sidecar = new Sidecar({
    hub: new HubClient({ baseUrl: `http://127.0.0.1:${port}`, token: hubToken }),
    transport: /** @type {any} */ ({ origin: 'https://fleet.test', onMessage() {}, start: async () => true, stop: async () => {}, send: () => true }),
    hostId: 'ops-box', watch: false, healthIntervalMs: 0, renewIntervalMs: 0, vaultIntervalMs: 0,
  });
  core.registry.connect('ops-box', (/** @type {any} */ frame) => {
    void sidecar.handle(frame).then((reply) => { if (reply?.kind === 'reply') void core.onHostMessage('ops-box', reply); });
  }, { actsFor: null });

  core.revokeClient(nina.client.id);
  await until(() => core.hostIds.get('ops-box')?.forgetFrom === undefined, 'the box did not say it forgot her, so the fleet still owes it');

  // HER SESSION: out of the list, in the bin, and marked to stay down there,
  // so taking it back out cannot relaunch it as her on the next boot.
  assert.deepEqual(registry.list().map((r) => r.name), [kimJob]);
  const binned = registry.bin.get(ninaJob);
  assert.equal(binned?.resumeOnBoot, false, 'binned as due back on boot');
  assert.equal(binned?.status, 'stopped');
  // HER SIGN-INS, renewal included; his untouched.
  assert.deepEqual(accounts.list(), [KIM]);
  assert.equal(connections.tokenFor(NINA, 'github'), null);
  assert.equal(connections.readRenewal(NINA, 'github'), null, 'her refresh token is still here for the renewal to spend');
  assert.ok(connections.tokenFor(KIM, 'github') && connections.readRenewal(KIM, 'github'));
  assert.equal(heldFor(cfg, NINA), null);
  assert.ok(heldFor(cfg, KIM));
  /** @type {string[]} */
  const renewed = [];
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = async (_url, init) => {
    renewed.push(JSON.parse(String(/** @type {any} */ (init).body)).refresh_token);
    return new Response(JSON.stringify({ access_token: 'ghu_new0000000000000000000000000', refresh_token: 'ghr_new0000000000000000000000000', expires_in: 28_800 }));
  };
  await renewProviderTokens(cfg, { secrets: { githubClientSecret: 'clientsecret000000000000000000000000' } });
  globalThis.fetch = real;
  assert.deepEqual(renewed, ['ghr_kim@00000000000000000000000'], 'the renewal still spends a removed member’s refresh token');

  // What the fleet was told is what the box said.
  const said = core.recentEvents(null).filter((/** @type {any} */ e) => e.event === 'host.asked-back').map((/** @type {any} */ e) => e.text);
  assert.ok(said.some((text) => /says it has forgotten somebody .*: 1 session of theirs stopped/.test(text)), said.join('\n'));

  // Asked again, as a box that did not confirm would be: nothing more to do.
  const again = await new HubClient({ baseUrl: `http://127.0.0.1:${port}`, token: hubToken }).forgetPerson(NINA);
  assert.equal(again.ok, true);
  assert.deepEqual(again.forgot, { sessions: 0, claude: false, providers: [], vault: false });
});
