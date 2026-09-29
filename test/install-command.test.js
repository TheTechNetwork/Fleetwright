// The one line that installs a box and joins it, offered beside every pin.
//
// Round 4 of docs/auth-and-join.md, closing beta finding G1 (#332): the pin is
// the whole of how a host joins, and the installer already knew which fleet
// from the /install shim — so the only thing between "mint a pin in the app"
// and "a box in the fleet" was carrying six digits from a phone to a
// terminal. The app now shows the line that carries them.
//
// WHERE THE PIN RIDES IS THE DECISION. Not in the URL: `/install?pin=` puts a
// live credential in the coordinator's request path and makes the shim carry
// a secret, which test/worker-routes.test.js forbids. As an environment
// variable on the command line, it reaches the installer through the shell
// that runs it and nothing else.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installCommand } from '../src/fleet/coordinator/enrollment.js';
import { Coordinator } from '../src/fleet/coordinator/server.js';
import { Fleet } from '../worker/src/fleet-do.js';
import worker from '../worker/src/worker.js';

const ADMIN = 'a-token-at-least-16ch';
const SH = readFileSync(new URL('../install/install.sh', import.meta.url), 'utf8');
const IOS_CLIENT = readFileSync(new URL('../apps/ios/Fleetwright/Fleet.swift', import.meta.url), 'utf8');
const IOS_VIEW = readFileSync(new URL('../apps/ios/Fleetwright/FleetView.swift', import.meta.url), 'utf8');
const DROID_CLIENT = readFileSync(new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/Fleet.kt', import.meta.url), 'utf8');
const DROID_VIEW = readFileSync(new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/SettingsPanel.kt', import.meta.url), 'utf8');

test('the command names the fleet and carries the pin as a variable, never in the URL', () => {
  const line = installCommand({ origin: 'https://fleet.example', installUrl: 'https://raw.example/bootstrap.sh', code: '123456' });
  assert.equal(line, 'curl -fsSL https://fleet.example/install | sudo FLEETWRIGHT_ENROL_PIN=123456 sh');
  assert.equal(/\?/.test(String(line)), false, 'no query string');

  // A path or a trailing slash on the origin is normalised to the origin.
  assert.match(String(installCommand({ origin: 'https://fleet.example/some/path', installUrl: 'x', code: '000000' })), /^curl -fsSL https:\/\/fleet\.example\/install /);
});

test('no command when it would not work: no installer published, no address, or not a pin', () => {
  // C-5: a line that 404s is worse than no line. The apps fall back to the
  // two-step form.
  assert.equal(installCommand({ origin: 'https://fleet.example', installUrl: '', code: '123456' }), null);
  assert.equal(installCommand({ origin: null, installUrl: 'x', code: '123456' }), null);
  assert.equal(installCommand({ origin: 'nonsense', installUrl: 'x', code: '123456' }), null);
  assert.equal(installCommand({ origin: 'https://fleet.example', installUrl: 'x', code: '12345' }), null);
  assert.equal(installCommand({ origin: 'https://fleet.example', installUrl: 'x', code: '12345a' }), null);
});

/** The Worker over a Durable Object with an in-memory storage stub. */
function workerFleet(/** @type {Record<string, string>} */ extraEnv = {}) {
  const storage = new Map();
  const state = {
    storage: {
      get: async (/** @type {string} */ k) => storage.get(k),
      put: async (/** @type {string} */ k, /** @type {any} */ v) => storage.set(k, JSON.parse(JSON.stringify(v))),
    },
    blockConcurrencyWhile: (/** @type {() => any} */ fn) => fn(),
    getWebSockets: () => [],
    setAlarm: () => {},
  };
  const env = { FLEETWRIGHT_API_TOKEN: ADMIN, ...extraEnv };
  const fleet = new Fleet(/** @type {any} */ (state), env);
  return (/** @type {any} */ body) =>
    worker.fetch(
      new Request('https://fleet.example/api/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
        body: JSON.stringify(body),
      }),
      /** @type {any} */ ({ FLEET: { idFromName: () => 'id', get: () => fleet }, ...env }),
    );
}

test('the Worker offers the line when it publishes an installer, and names its configured origin', async () => {
  const mint = workerFleet({ FLEETWRIGHT_INSTALL_URL: 'https://raw.example/bootstrap.sh', FLEETWRIGHT_PUBLIC_ORIGIN: 'https://fleet.thetech.network' });
  const reply = /** @type {any} */ (await (await mint({ kind: 'host' })).json());
  assert.equal(reply.ok, true);
  assert.equal(reply.install, `curl -fsSL https://fleet.thetech.network/install | sudo FLEETWRIGHT_ENROL_PIN=${reply.code} sh`);
});

test('the Worker offers none for a device pin, and none when it publishes no installer', async () => {
  const withInstaller = workerFleet({ FLEETWRIGHT_INSTALL_URL: 'https://raw.example/bootstrap.sh' });
  const device = /** @type {any} */ (await (await withInstaller({ kind: 'device' })).json());
  assert.equal(device.ok, true);
  assert.equal(device.install, null, 'no installer spends a device pin');

  const without = workerFleet();
  const host = /** @type {any} */ (await (await without({ kind: 'host' })).json());
  assert.equal(host.ok, true);
  assert.equal(host.install, null, 'its /install answers 404, so the line would too');
});

test('the Node coordinator answers null: it publishes no installer', async (t) => {
  const c = new Coordinator({ apiToken: ADMIN, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  const port = await c.listen(0, '127.0.0.1');
  t.after(() => c.close());
  const reply = /** @type {any} */ (await (await fetch(`http://127.0.0.1:${port}/api/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ kind: 'host' }),
  })).json());
  assert.equal(reply.ok, true);
  assert.equal(reply.install, null);
});

test('the installer spends a pin that arrived with the command, and only asks when none did', () => {
  const fn = /enrol_host\(\) \{[\s\S]*?\n\}/.exec(SH);
  assert.ok(fn, 'enrol_host is gone');
  assert.match(fn[0], /local pin="\$\{FLEETWRIGHT_ENROL_PIN:-\}"/, 'the pin from the command is not read');
  assert.match(fn[0], /ask pin "Enrolment pin"/, 'and without one it still asks');
  // Six digits or nothing, whichever way it arrived.
  assert.ok(fn[0].indexOf('FLEETWRIGHT_ENROL_PIN') < fn[0].indexOf('${#pin} -ne 6'), 'the command\'s pin skips the six-digit check');

  // Defined OUTSIDE the wizard, so an unattended install that was handed a pin
  // joins too — and the address written whether or not there is a terminal.
  const wizard = SH.indexOf('if [ "$WIZARD" = yes ]; then\n  say "Setup"');
  assert.ok(SH.indexOf('enrol_host() {') < wizard, 'enrol_host is only reachable from the wizard');
  assert.ok(SH.indexOf('WRITTEN WHETHER OR NOT THERE IS A TERMINAL') < wizard);
  assert.match(SH, /if \[ "\$WIZARD" != yes \] && \[ "\$CHECK_ONLY" != 1 \] && \[ -n "\$\{FLEETWRIGHT_ENROL_PIN:-\}" \]; then\n\s+say "Joining the fleet"\n\s+enrol_host/);
});

test('the iOS app reads the line off the reply and shows it beside the pin, and only when there is one', () => {
  // A capability only reachable by curl is a capability the product does not
  // have (test/enroll-ephemeral.test.js). The line is the product here: on a
  // fresh box it is the whole join.
  assert.match(IOS_CLIENT, /let install: String\?/, 'the reply\'s install field is not decoded');
  assert.match(IOS_CLIENT, /struct MintedPin \{\n\s+let code: String\n\s+let install: String\?/);
  assert.match(IOS_VIEW, /pinInstall = minted\.install/);
  // Shown only when the coordinator offered one — an older coordinator or one
  // with no installer gets the two-step form, never a line that would 404.
  assert.match(IOS_VIEW, /if let install = pinInstall \{[\s\S]{0,600}?Text\(install\)[\s\S]{0,200}?\.textSelection\(\.enabled\)/);
  assert.match(IOS_VIEW, /\} else \{\n\s+Text\("On that box: fleetwright-sidecar enrol \\\(pin\)"\)/);
  // A bound pin re-keys a box that exists; no install line for it.
  assert.match(IOS_VIEW, /mintHostPin\(hostId: hostId, readmit: readmit\)\.code/);
});

test('the Android app reads the line off the reply and shows it beside the pin, and only when there is one', () => {
  assert.match(DROID_CLIENT, /data class MintedPin\(val code: String, val install: String\?\)/);
  // org.json renders a JSON null as the string "null"; a command to paste must
  // never be the word null.
  assert.match(DROID_CLIENT, /if \(json\.isNull\("install"\)\) null else json\.optString\("install"\)\.ifBlank \{ null \}/);
  assert.match(DROID_VIEW, /\.onSuccess \{ pinInstall = it\.install \?: "" \}/);
  assert.match(DROID_VIEW, /if \(pinInstall\.isNotBlank\(\)\) \{[\s\S]{0,700}?SelectionContainer \{\n\s+Text\(pinInstall/);
  assert.match(DROID_VIEW, /\} else \{\n\s+Text\(\n\s+"On that box: fleetwright-sidecar enrol \$pin/);
  // A bound pin re-keys a box that exists; no install line for it.
  assert.match(DROID_VIEW, /pinInstall = ""\n\s+pin = runCatching \{\n\s+Fleet\(settings\)\.mintHostPin\(hostId = host\.hostId, readmit = host\.revoked\)\n\s+\}\.map \{ it\.code \}/);
});
