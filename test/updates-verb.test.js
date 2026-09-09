// One answer, two subjects, each named.
//
// THE BUG THIS EXISTS FOR, from a screenshot of a real fleet: the app's Check
// button printed "The box is up to date." directly above a line reading
// "running 0223f94 · 1 commit behind", with an Apply update button beside it.
//
// Both sentences were true. Check called `upgrade`, which is the operating
// system; the commit count came from the host's own timer. Neither said what it
// was about, so the screen contradicted itself — and whichever half somebody
// believed, the other taught them not to trust the screen.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readFileSync } from 'node:fs';

import { dispatch } from '../src/adapters/commands.js';
import { Sidecar } from '../src/fleet/host/sidecar.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { startStubHub } from './helpers/stub-hub.js';
import { VERBS, isMutating } from '../src/fleet/protocol/intents.js';
import { toCommandLine } from '../src/fleet/host/sidecar.js';
import { iosSources } from './helpers/ios-sources.js';

/** A box laid out the way a release install leaves one. */
function packagedBox(installed = 'v0.2.2') {
  const base = mkdtempSync(path.join(tmpdir(), 'updates-'));
  const dir = path.join(base, 'releases', installed);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: installed }));
  mkdirSync(path.join(dir, 'lib'), { recursive: true });
  writeFileSync(path.join(dir, 'lib', 'agent-hub.mjs'), '');
  symlinkSync(dir, path.join(base, 'current'));
  return { base, installDir: path.join(base, 'current') };
}

test('the verb is a read, takes nothing, and is free to add', () => {
  assert.equal(isMutating('updates'), false);
  assert.deepEqual(Object.keys(VERBS.updates.params), []);
  // A NEW VERB RATHER THAN A `check` PARAM ON `update`. Adding a param is a
  // flag day — bad_params arrives after the version handshake has agreed — and
  // v3 hosts were in the field. An older host answers `unknown_verb` to this
  // and strands nothing.
  assert.deepEqual(Object.keys(VERBS.update.params).sort(), ['restart']);
  assert.equal(toCommandLine({ verb: 'updates', params: {}, actor: '' }), '/updates');
});

test('both halves answer, and each says which one it is', async () => {
  const box = packagedBox();
  try {
    const r = await dispatch(
      /** @type {any} */ ({ cfg: { installDir: box.installDir, stateDir: box.base, hostname: 'h', releaseManifest: '' } }),
      '/updates',
    );
    assert.equal(r.ok, true);
    // THE ASSERTION THIS FILE IS FOR. Neither line may be a bare verdict about
    // "the box": one is this software and one is the operating system, and a
    // reader has to be able to tell which they are looking at.
    assert.match(r.text, /^Fleetwright: /m);
    assert.match(r.text, /^Operating system: /m);
    assert.doesNotMatch(r.text, /The box is up to date/);
  } finally {
    rmSync(box.base, { recursive: true, force: true });
  }
});

test('the answer travels as data, not only as prose', async () => {
  const box = packagedBox();
  try {
    const r = await dispatch(
      /** @type {any} */ ({ cfg: { installDir: box.installDir, stateDir: box.base, hostname: 'h', releaseManifest: '' } }),
      '/updates',
    );
    // A row that decided whether to show "Apply update" by searching the prose
    // would break the first time the wording changed — the same rule that put
    // `profiles`, `entries` and `channel` in fields.
    // TRI-STATE ON THE APP HALF: true, false, or null for cannot-tell. The
    // system half is genuinely binary — apt either has packages waiting or it
    // does not, and it says separately when it could not look.
    assert.ok([true, false, null].includes(r.waiting.app.pending));
    assert.equal(typeof r.waiting.system.pending, 'boolean');
    // And it says which KIND of box it measured, because "3 commits behind" and
    // "v0.2.3 is waiting" are answers to different questions and only one of
    // them is available on any given machine.
    assert.equal(r.waiting.app.kind, 'release');
  } finally {
    rmSync(box.base, { recursive: true, force: true });
  }
});

test('a box that cannot tell says so instead of reporting nothing waiting', async () => {
  // Neither a checkout nor a release. `pending: false` here means CANNOT TELL,
  // and the text is what carries that — a row rendering only the boolean would
  // show the same thing as a box that had checked and found nothing.
  const dir = mkdtempSync(path.join(tmpdir(), 'updates-none-'));
  try {
    const r = await dispatch(
      /** @type {any} */ ({ cfg: { installDir: dir, stateDir: dir, hostname: 'h', releaseManifest: '' } }),
      '/updates',
    );
    assert.equal(r.waiting.app.kind, 'unknown');
    assert.equal(r.waiting.app.pending, false);
    assert.match(r.text, /Fleetwright: .+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the OS half never claims the box is up to date', async () => {
  // `upgrade`'s reply used to be "The box is up to date." — a sentence about
  // apt with no subject. Whatever this box's apt says, the words that caused
  // the contradiction must not come back.
  const dir = mkdtempSync(path.join(tmpdir(), 'updates-os-'));
  try {
    const r = await dispatch(
      /** @type {any} */ ({ cfg: { installDir: dir, stateDir: dir, hostname: 'h', releaseManifest: '' } }),
      '/updates',
    );
    assert.doesNotMatch(r.text, /The box is up to date/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a checkout that could be migrated says that, not a commit count', async () => {
  // THE DEFECT THIS VERB EXISTS TO REMOVE, ONE SCREEN OVER. /update on such a
  // box offers to move it onto packaged releases; /updates counting commits at
  // the same time would be two answers to the same question disagreeing —
  // which is what "The box is up to date." above "1 commit behind" was.
  //
  // The helper is not installed on a machine running the suite, so the state
  // here is `no_helper` and the count is the honest answer. What is asserted is
  // that the two agree: whatever /updates says about a checkout, /update's
  // migration answer does not contradict it.
  const dir = mkdtempSync(path.join(tmpdir(), 'updates-checkout-'));
  mkdirSync(path.join(dir, '.git'));
  try {
    const cfg = /** @type {any} */ ({
      installDir: dir,
      stateDir: dir,
      hostname: 'h',
      releaseManifest: 'https://github.com/o/r/releases/latest/download/manifest.json',
    });
    const updates = await dispatch(/** @type {any} */ ({ cfg }), '/updates');
    const update = await dispatch(/** @type {any} */ ({ cfg }), '/update --check');

    // Neither claims this box is current while the other offers it something.
    const bothSayWaiting = /waiting|behind|move/i.test(updates.text) === /waiting|behind|move/i.test(update.text);
    assert.ok(
      bothSayWaiting || !updates.waiting.app.pending,
      `/updates and /update --check disagree:\n${updates.text}\n---\n${update.text}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// --- the check that nobody could act on -------------------------------------
//
// THE COMPLAINT, from a screenshot of a real fleet: a host row reading
// "main-57 · up to date · rolling" with only Check and Reboot beside it, and
// Check's own answer printed underneath saying "Fleetwright: main-57 → main-63
// (available)". The box had just been told there was an update and the screen
// offered no way to take it.
//
// Three separate defects, each of which alone was enough:
//
//   THE REPLY'S DATA WAS DROPPED. `/updates` returns `{ app, system }` — kind,
//     pending, version — precisely so a row can render a state instead of
//     parsing a sentence, and the sidecar forwarded only `text`.
//
//   THE ROW READ A DIFFERENT COMPUTATION. Health reports from a cache the host
//     refreshes every fifteen minutes; the verb computes fresh, because
//     somebody is standing there having pressed a button. Two answers to one
//     question, and the button is gated on the stale one.
//
//   BOTH APPS INVENTED "UP TO DATE". `appBehind` is null on every packaged box
//     — there is no history to count — and `release.available` is null both
//     when nothing is waiting and when the check could not reach GitHub. Read
//     as `?? 0` and `!= nil`, all three of those became "you are current".

test('a release carries whether the box knows where to look', async () => {
  // `available: null` IS TWO DIFFERENT ANSWERS — nothing waiting, and could not
  // ask — and only `configured` and `message` tell them apart. Dropping it here
  // is what let a box that had never once reached GitHub render as up to date.
  const box = packagedBox();
  try {
    const r = await dispatch(
      /** @type {any} */ ({ cfg: { installDir: box.installDir, stateDir: box.base, hostname: 'h', releaseManifest: '' } }),
      '/updates',
    );
    assert.equal(r.waiting.app.kind, 'release');
    assert.equal(typeof r.waiting.app.configured, 'boolean');
  } finally {
    rmSync(box.base, { recursive: true, force: true });
  }
});

test('a box that cannot swap a release is not told nothing is waiting', async () => {
  // REPORTED FROM A BETA HOST, after changing channels from the app. The box
  // ran v0.2.3, whose layout check refused the very directory it was installed
  // in, and the screen said both of these at once:
  //
  //   Fleetwright: /opt/fleetwright/releases/v0.2.3 is not a release layout,
  //                so there is no symlink to swap.
  //   Operating system: No system packages are waiting.
  //
  // The refusal was rendered, and the row beside it was fed `pending: false` —
  // "nothing waiting" — because the only thing separating "asked, nothing
  // there" from "could not ask" was whether the message happened to read
  // "could not check". This one does not. Neither does an unreachable
  // manifest's, which is every offline box.
  const base = mkdtempSync(path.join(tmpdir(), 'updates-hand-'));
  const dir = path.join(base, 'fleetwright');
  mkdirSync(path.join(dir, 'lib'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: 'v0.2.3' }));
  writeFileSync(path.join(dir, 'lib', 'agent-hub.mjs'), '');
  try {
    const r = await dispatch(
      /** @type {any} */ ({
        cfg: {
          installDir: dir,
          stateDir: base,
          hostname: 'h',
          releaseManifest: 'https://github.com/o/r/releases/latest/download/manifest.json',
        },
      }),
      '/updates',
    );
    assert.equal(r.waiting.app.kind, 'release');
    // NULL IS CANNOT TELL. `false` here is the app rendering "up to date" over
    // the top of a refusal explaining that it could not look.
    assert.equal(r.waiting.app.pending, null, 'a box that could not check was reported as up to date');
    assert.equal(r.waiting.app.ok, false);
    assert.match(r.text, /not a release layout/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/** A sidecar in front of a stub hub that answers /updates with a given block. */
async function sidecarAnswering(t, waiting) {
  const stub = await startStubHub({
    onCommand: (line) => (line.startsWith('/updates') ? { ok: true, text: 'checked', waiting } : { ok: true, text: 'ok' }),
  });
  t.after(() => stub.close());
  /** @type {object[]} */
  const sent = [];
  /** @type {any[]} */
  const adopted = [];
  /** @type {((m: unknown) => Promise<void>)|null} */
  let handler = null;
  const sidecar = new Sidecar({
    hub: new HubClient({ baseUrl: stub.baseUrl, token: null, readTimeoutMs: 2000 }),
    transport: /** @type {any} */ ({
      origin: 'https://coord.example',
      onMessage: (h) => { handler = h; },
      send: (m) => { sent.push(m); },
      start: async () => true,
      stop: async () => true,
    }),
    hostId: 'h1',
    healthIntervalMs: 0,
    watch: false,
    updates: () => ({ appBehind: null, system: null, rebootRequired: false, release: null, appPending: null }),
    adoptUpdates: (w) => adopted.push(w),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  await sidecar.start();
  t.after(() => sidecar.stop());
  const ask = () =>
    /** @type {any} */ (handler)({
      v: PROTOCOL_VERSION, kind: 'intent', id: 'idem-0000042', verb: 'updates', params: {}, issuedAt: Date.now(),
    });
  return { sent, adopted, ask };
}

test('the check answer reaches the app as data, not only as prose', async (t) => {
  const waiting = {
    app: { kind: 'release', pending: true, available: 'main-63', configured: true, text: 'main-57 → main-63 (available)' },
    system: { supported: true, pending: false, count: 0, text: 'No system packages are waiting.' },
  };
  const { sent, ask } = await sidecarAnswering(t, waiting);
  await ask();
  const reply = sent.find((m) => /** @type {any} */ (m).kind === 'reply');
  // A row deciding whether to offer Apply update by searching the prose would
  // break the first time the wording changed — and until now it could not even
  // do that, because the prose was all it got.
  assert.deepEqual(/** @type {any} */ (reply).waiting, waiting);
});

test('the fresh check becomes the cached answer, and the fleet is told', async (t) => {
  const { sent, adopted, ask } = await sidecarAnswering(t, {
    app: { kind: 'release', pending: true, available: 'main-63', configured: true, text: 'available' },
    system: { supported: true, pending: false, count: 0, text: 'none' },
  });
  await ask();
  // A CHECK IS A READ THAT CHANGES WHAT THIS BOX KNOWS. `updates` moves nothing
  // on the machine, so it is deliberately not in isMutating() — which is why it
  // refreshed nothing, and why the row went on contradicting the reply for up
  // to fifteen minutes.
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].app.available, 'main-63');
  // The frame is built from this.health(), which does its own I/O, so this
  // waits for it rather than assuming a tick is enough.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !sent.some((m) => /** @type {any} */ (m).kind === 'health')) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(
    sent.some((m) => /** @type {any} */ (m).kind === 'health'),
    'the check refreshed nothing the coordinator can see',
  );
});

test('a reply with no waiting block adopts nothing', async (t) => {
  // An older hub answers with prose alone. Adopting `undefined` would replace a
  // real cached answer with nothing, which is worse than the staleness.
  const { adopted, ask } = await sidecarAnswering(t, undefined);
  await ask();
  assert.equal(adopted.length, 0);
});

test('the host answers "is there something waiting" itself, in three states', () => {
  // Both apps derived it as `behind > 0 || release.available != null`, which is
  // right for a checkout and wrong for every other kind of box. The host knows
  // which kind it is; nobody else has to guess.
  // IT MOVED, AND MOVING IT WAS THE POINT. This lived in the sidecar, computed
  // from a config the sidecar does not have — so it answered null on every box
  // for ever. It is now in the command, in the process that HAS the manifest
  // URL, and the sidecar adopts the answer.
  const cmds = readFileSync(new URL('../src/adapters/commands.js', import.meta.url), 'utf8');
  const release = cmds.slice(cmds.indexOf("kind: 'release',"), cmds.indexOf('available: r.available,'));
  // NULL IS A VALUE HERE and means CANNOT TELL: the box does not know where its
  // releases come from, or could not reach them. A boolean cannot say that, and
  // `false` says the reassuring half of it.
  //
  // READ FROM A FIELD. This used to assert the opposite of what it asserts now
  // — that the state was decided by matching the message against
  // /could not check/i — and that mechanism was the defect rather than the
  // guard. applyRelease phrases most of its refusals otherwise ("is not a
  // release layout", "could not reach the release manifest"), so each of them
  // came back as `false`, and a beta host was told nothing was waiting
  // directly beneath the sentence explaining that it could not look.
  assert.match(release, /r\.ok !== true \? null : Boolean\(r\.available\)/);
  assert.doesNotMatch(release, /r\.message/, 'the state is being read out of the prose again');

  // And the sidecar no longer has an opinion of its own to disagree with.
  const src = readFileSync(new URL('../bin/agent-fleet-sidecar', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /function appPending\(/, 'the sidecar computes it again');
});

test('neither app claims a box is current when nobody could find out', () => {
  const ios = iosSources();
  // The branch that used to fire on every packaged host.
  assert.match(ios, /appStatusKnown == false \{[\s\S]{0,600}?update status unknown/);
  // And the button reads the host's answer rather than re-deriving it.
  assert.match(ios, /updates\?\.appUpdatePending == true \{\s+Button\("Apply update"\)/);
  assert.doesNotMatch(ios, /updates\?\.appPending == true \{\s+Button/);

  const act = readFileSync(
    new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt', import.meta.url), 'utf8');
  assert.match(act, /!host\.appStatusKnown -> parts\.add\("update status unknown"\)/);
  // A migratable checkout counts no commits and names no release version, so
  // both of the old signals were silent on it and it rendered as current
  // beside its own Apply button.
  assert.match(act, /host\.appPending -> parts\.add\("update waiting"\)/);

  const kt = readFileSync(
    new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/Fleet.kt', import.meta.url), 'utf8');
  // `has` before `optBoolean`, because optBoolean turns a missing field into
  // false — which is the exact difference this field exists to carry.
  assert.match(kt, /it\.has\("appPending"\) && !it\.isNull\("appPending"\)/);
  assert.match(kt, /appPendingReported \?\: \(\(behind \?\: 0\) > 0/);
});

test('both apps apply the check the host just ran', () => {
  // Even with an immediate frame the app's own refresh races it, and losing
  // that race restores the row that said "up to date".
  const ios = iosSources();
  // The reply lands on the screen that asked for it. It used to be patched into
  // the list by applyWaiting; the machine's page holds its own health and
  // updates that instead, which is the same rule with one fewer indirection.
  assert.match(ios, /if let w = reply\.waiting \{ health = health\?\.withUpdates\(w\) \}/);

  const act = readFileSync(
    new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt', import.meta.url), 'utf8');
  assert.match(act, /r\.waiting\?\.let \{ w ->/);
  // AFTER the refresh, not before it — the refresh is what would otherwise
  // overwrite it.
  const check = act.slice(act.indexOf('val r = Fleet(settings).updates(host.hostId)'));
  assert.ok(
    check.indexOf('fleetHosts = Fleet(settings).fleetHosts()') < check.indexOf('r.waiting?.let'),
    'the reply is applied before the refresh that overwrites it',
  );
});

// --- the answer nobody could ever get ---------------------------------------
//
// "Why is update status unknown? Why isn't that loaded into the app
// automatically, why a check to get it, and an app restart loses it?"
//
// Three symptoms, one cause, and it was permanent rather than transient.

test('the sidecar asks agent-hub rather than recomputing with a config it lacks', () => {
  // THE BUG. The sidecar worked this out itself: loadConfig(), then
  // checkRelease(). But loadConfig() reads agent-hub's SCHEMA out of the
  // SIDECAR's environment, and /etc/agent-fleet-sidecar.env carries no
  // AGENT_HUB_* keys at all — the installer copies exactly three things into
  // it: the hub URL, the hub token and the coordinator URL.
  //
  // So `releaseManifest` was the empty default, checkRelease answered
  // `configured: false` — "this box does not know where its releases come
  // from" — and appPending was null. On every packaged host, from the day it
  // was installed, with no amount of waiting fixing it.
  //
  // Pressing Check worked, which made it look like a refresh problem: that goes
  // through agent-hub, which reads /etc/agent-hub.env and HAS the manifest. Two
  // processes, two configurations, one question, and the one that could answer
  // it was not the one being asked. The answer then survived only until the
  // timer overwrote it with null again.
  const src = readFileSync(new URL('../bin/agent-fleet-sidecar', import.meta.url), 'utf8');
  const refresh = src.slice(src.indexOf('async function refreshUpdates()'), src.indexOf('setTimeout(() => void refreshUpdates()'));

  assert.match(refresh, /await hub\.command\('\/updates'\)/, 'the sidecar computes this itself again');
  assert.match(refresh, /adoptUpdates\(reply\.waiting\)/);

  // CODE, NOT COMMENTS. The paragraph above this explains what it used to do,
  // and naming `loadConfig` and `checkRelease` there is the point of it — a
  // test that matched them anywhere would fail because somebody wrote down why
  // they are gone.
  const code = refresh.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /loadConfig\(\)/, 'it is reading agent-hub settings from the sidecar env again');
  assert.doesNotMatch(code, /checkRelease|updateAvailable/, 'two processes are answering one question again');
});

test('the env file the sidecar reads has none of the settings it needed', () => {
  // The fact underneath the bug, asserted so the fix is not undone by somebody
  // "tidying" the template. If AGENT_HUB_RELEASE_MANIFEST is ever added here,
  // that is a second place for it to be right or wrong.
  const template = readFileSync(new URL('../install/agent-fleet-sidecar.env.example', import.meta.url), 'utf8');
  assert.doesNotMatch(template, /AGENT_HUB_RELEASE_MANIFEST|AGENT_HUB_INSTALL_DIR/);
});

test('rebootRequired survives the two paths becoming one', () => {
  // It was the ONE field only the sidecar's own computation produced. Folding
  // the paths together without carrying it would have made a box needing a
  // reboot quietly stop saying so — a regression with no error attached.
  const cmds = readFileSync(new URL('../src/adapters/commands.js', import.meta.url), 'utf8');
  assert.match(cmds, /rebootRequired: s\.rebootRequired/);

  const src = readFileSync(new URL('../bin/agent-fleet-sidecar', import.meta.url), 'utf8');
  // Carried over when ABSENT rather than defaulted to false: an older hub not
  // sending it must not be read as an answer.
  assert.match(src, /typeof sys\.rebootRequired === 'boolean'/);
  assert.match(src, /lastUpdates\?\.rebootRequired \?\? false/);
});
