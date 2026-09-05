// The update channel, set from the app.
//
// The property under test is not "a file gets written" — it is that what the
// app is TOLD matches what the box will actually do. Every failure this
// repository has paid for has the same shape: an answer that was true where it
// was written and quietly false one layer up. So each test here asserts the
// reply and the subsequent read together.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CHANNELS, readChannel, writeChannel, pinnedByEnv } from '../src/core/channel.js';
import { manifestUrlFor } from '../src/core/release.js';
import { dispatch } from '../src/adapters/commands.js';
import { VERBS } from '../src/fleet/protocol/intents.js';
import { toCommandLine } from '../src/fleet/host/sidecar.js';

/** @param {object} [extra] */
function fixture(extra = {}) {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'channel-'));
  return { cfg: /** @type {any} */ ({ stateDir, releaseChannel: '', ...extra }), stateDir };
}

test('an ordinary box is NOT pinned, so the picker appears', async () => {
  // THE BUG EVERY BOX IN THE FLEET HAD, and the fixtures in this file are why
  // it survived: they construct `{ releaseChannel: '' }` by hand, which is what
  // an unset environment OUGHT to produce — and config.js was defaulting it to
  // 'stable'. Every test here passed against a value production never had.
  //
  // The consequence on a phone: `pinnedByEnv` decides whether the environment
  // is FORCING a channel by asking whether the value is a known channel, so a
  // default of 'stable' pinned every box on earth. The picker never rendered,
  // /channel refused every change, and both apps said "set on the box" about a
  // setting nobody had set.
  //
  // So this test goes through loadConfig rather than around it.
  const { loadConfig } = await import('../src/config.js');
  const clean = loadConfig({});
  assert.equal(pinnedByEnv(clean), false, 'an unset environment still pins the channel');
  assert.equal(readChannel(clean), 'stable', 'unset should still MEAN stable');

  // And a box whose operator did set it is still pinned, which is the whole
  // point of the field.
  assert.equal(pinnedByEnv(loadConfig({ AGENT_HUB_RELEASE_CHANNEL: 'rolling' })), true);
  assert.equal(readChannel(loadConfig({ AGENT_HUB_RELEASE_CHANNEL: 'rolling' })), 'rolling');
});

test('a box nobody has asked is on stable', () => {
  const { cfg, stateDir } = fixture();
  try {
    assert.equal(readChannel(cfg), 'stable');
    assert.equal(pinnedByEnv(cfg), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('what was set is what the next read gets', () => {
  const { cfg, stateDir } = fixture();
  try {
    const r = writeChannel(cfg, 'rolling');
    assert.equal(r.ok, true);
    assert.equal(r.channel, 'rolling');
    // The point of the whole feature: a second process, reading fresh, agrees.
    assert.equal(readChannel(cfg), 'rolling');
    // And back again, because a switch that only goes one way is a trap.
    assert.equal(writeChannel(cfg, 'stable').ok, true);
    assert.equal(readChannel(cfg), 'stable');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a channel nobody has heard of is refused, and the file is untouched', () => {
  const { cfg, stateDir } = fixture();
  try {
    writeChannel(cfg, 'rolling');
    const r = writeChannel(cfg, 'nightly');
    assert.equal(r.ok, false);
    assert.match(r.message, /not a channel/);
    // Refused means refused: the box did not quietly move, and did not quietly
    // fall back to stable either.
    assert.equal(readChannel(cfg), 'rolling');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('the environment wins, and setting the channel says so rather than lying', () => {
  const { cfg, stateDir } = fixture({ releaseChannel: 'rolling' });
  try {
    assert.equal(pinnedByEnv(cfg), true);
    assert.equal(readChannel(cfg), 'rolling');

    const r = writeChannel(cfg, 'stable');
    // THE ASSERTION THIS FILE EXISTS FOR. Writing a file that the next read
    // ignores would leave the app showing `stable` while the box kept taking
    // prereleases, with nothing anywhere saying which was true.
    assert.equal(r.ok, false);
    assert.match(r.message, /AGENT_HUB_RELEASE_CHANNEL/);
    assert.match(r.message, /agent-hub\.env/);
    assert.equal(readChannel(cfg), 'rolling');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('the name this channel had for one afternoon still reads', () => {
  // #366 shipped `prerelease` as the value and the docs said so for a few
  // hours. Anybody who copied it into their environment or their state file
  // should get the channel they asked for — falling back to stable would be
  // the silent wrong answer this whole module is written against, and it would
  // be silent in the direction that matters: a box quietly not taking the
  // builds somebody deliberately opted it into.
  const { cfg, stateDir } = fixture();
  try {
    writeFileSync(path.join(stateDir, 'release-channel'), 'prerelease\n');
    assert.equal(readChannel(cfg), 'rolling');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }

  const pinned = fixture({ releaseChannel: 'prerelease' });
  try {
    assert.equal(readChannel(pinned.cfg), 'rolling');
    assert.equal(pinnedByEnv(pinned.cfg), true);
  } finally {
    rmSync(pinned.stateDir, { recursive: true, force: true });
  }
});

test('the old name is readable and NOT settable', () => {
  // Read-only on purpose: accepting it as a written answer would keep a name
  // that existed for an afternoon alive for ever, in files written years later
  // by people who never saw the docs that used it.
  const { cfg, stateDir } = fixture();
  try {
    const r = writeChannel(cfg, 'prerelease');
    assert.equal(r.ok, false);
    assert.match(r.message, /stable, rolling/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a corrupt or half-written file reads as stable rather than throwing', () => {
  const { cfg, stateDir } = fixture();
  try {
    writeFileSync(path.join(stateDir, 'release-channel'), 'prerel');
    assert.equal(readChannel(cfg), 'stable');
    // Whitespace and case are how a person edits a one-word file by hand.
    writeFileSync(path.join(stateDir, 'release-channel'), '  PreRelease \n');
    assert.equal(readChannel(cfg), 'rolling');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('an unwritable state directory is reported, not swallowed', () => {
  const { cfg, stateDir } = fixture();
  try {
    chmodSync(stateDir, 0o500);
    const r = writeChannel(cfg, 'rolling');
    // Running the suite as root defeats a mode bit, so this asserts the pair
    // that must hold either way: the answer and the box agree.
    assert.equal(readChannel(cfg), r.ok ? 'rolling' : 'stable');
    if (!r.ok) assert.match(r.message, /could not write/);
  } finally {
    chmodSync(stateDir, 0o700);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// --- the command, and the way an app reads it -------------------------------

test('/channel answers with data, not only a sentence', async () => {
  const { cfg, stateDir } = fixture();
  try {
    const ctx = /** @type {any} */ ({ cfg });
    const asked = await dispatch(ctx, '/channel');
    assert.equal(asked.channel, 'stable');
    assert.equal(asked.channelPinned, false);

    const set = await dispatch(ctx, '/channel rolling');
    assert.equal(set.ok, true);
    assert.equal(set.channel, 'rolling');
    // A picker rendered by parsing the sentence would break the first time the
    // wording changed, which is why the field is asserted and not the prose.
    assert.equal((await dispatch(ctx, '/channel')).channel, 'rolling');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('/channel tells a pinned box it cannot be changed from here', async () => {
  const { cfg, stateDir } = fixture({ releaseChannel: 'rolling' });
  try {
    const asked = await dispatch(/** @type {any} */ ({ cfg }), '/channel');
    // Said in the answer rather than discovered by trying, and carried as a
    // flag so an app can disable the control instead of offering a change it
    // knows will be refused.
    assert.equal(asked.channelPinned, true);
    assert.match(asked.text, /cannot be changed from here/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('nothing still tells somebody to set the name that was renamed', () => {
  // The rename's loose end, and the kind that survives a green suite: a
  // REFUSAL message naming the old value. It is read at exactly the moment
  // somebody is trying to do the thing, and following it would leave them
  // setting a value that is only understood by a compatibility shim.
  for (const f of ['../src/core/release.js', '../src/core/channel.js', '../src/adapters/commands.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /AGENT_HUB_RELEASE_CHANNEL=prerelease/, `${f} still tells somebody to set the old value`);
  }
});

test('the channel verb and the command cannot drift apart', () => {
  // The verb's enum and the module's list are the same two words, so adding a
  // third channel in one place fails here rather than at a phone.
  assert.deepEqual(VERBS.channel.params.to.values, [...CHANNELS]);
  assert.equal(toCommandLine({ verb: 'channel', params: {}, actor: '' }), '/channel');
  assert.equal(toCommandLine({ verb: 'channel', params: { to: 'rolling' }, actor: '' }), '/channel rolling');
});

test('/update takes the stored channel, and the channel moves the address', () => {
  // Two regressions in one, both of the shape this repository keeps paying
  // for. Reading cfg.releaseChannel would mean the channel took effect only
  // after a restart — a shell, which is the thing the feature removes. And
  // fetching the configured URL regardless of channel would leave a box that
  // had switched to prerelease taking stable builds while reporting otherwise,
  // because `releases/latest/download` skips prereleases by definition.
  const src = readFileSync(new URL('../src/adapters/commands.js', import.meta.url), 'utf8');
  const update = src.slice(src.indexOf('  update: {'));
  const body = update.slice(0, update.indexOf('\n  },'));
  assert.match(body, /const channel = readChannel\(ctx\.cfg\)/);
  assert.match(body, /manifestUrlFor\(ctx\.cfg\.releaseManifest, channel\)/);
  assert.match(body, /manifestUrl: target\.url/);
  assert.doesNotMatch(body, /channel: ctx\.cfg\.releaseChannel/);
  assert.doesNotMatch(body, /manifestUrl: ctx\.cfg\.releaseManifest/);
});

test('the two channels are two addresses, and a mirror is left alone', () => {
  const stable = 'https://github.com/o/r/releases/latest/download/manifest.json';
  const rolling = 'https://github.com/o/r/releases/download/rolling/manifest.json';

  assert.deepEqual(manifestUrlFor(stable, 'rolling'), { url: rolling, derived: true });
  assert.deepEqual(manifestUrlFor(rolling, 'stable'), { url: stable, derived: true });
  // Already right stays put rather than being rewritten twice.
  assert.deepEqual(manifestUrlFor(stable, 'stable'), { url: stable, derived: true });
  assert.deepEqual(manifestUrlFor(rolling, 'rolling'), { url: rolling, derived: true });

  // A mirror matches neither shape. Returned UNCHANGED and flagged, because
  // inventing a path inside somebody else's release host would produce a 404
  // on every update and blame the channel for it.
  const mirror = 'https://releases.example.com/agent-hub/manifest.json';
  assert.deepEqual(manifestUrlFor(mirror, 'rolling'), { url: mirror, derived: false });
});

test('a box on a mirror is told the switch does not move its address', async () => {
  const { cfg, stateDir } = fixture({ releaseManifest: 'https://releases.example.com/m.json' });
  try {
    const r = await dispatch(/** @type {any} */ ({ cfg }), '/channel rolling');
    assert.equal(r.ok, true);
    // Said rather than left to be discovered by a box that never updates.
    assert.match(r.text, /same manifest on either channel/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a box on GitHub is told where its updates will come from', async () => {
  const { cfg, stateDir } = fixture({
    releaseManifest: 'https://github.com/o/r/releases/latest/download/manifest.json',
  });
  try {
    const r = await dispatch(/** @type {any} */ ({ cfg }), '/channel rolling');
    assert.match(r.text, /releases\/download\/rolling\/manifest\.json/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
