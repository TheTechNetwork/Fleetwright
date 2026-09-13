import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decideRelease, verifyDownload, fileUrl } from '../src/core/release.js';

const good = { version: '2026.09.01-2', file: 'fleetwright-host.tar.gz', sha256: 'a'.repeat(64), protocol: 2 };

test('a newer release is worth acting on', () => {
  const d = decideRelease({ manifest: good, installed: 'main-1', protocol: 2 });
  assert.equal(d.act, true);
  assert.match(d.message, /main-1 → 2026\.09\.01-2/);
});

test('the same version is not', () => {
  const d = decideRelease({ manifest: good, installed: good.version, protocol: 2 });
  assert.equal(d.act, false);
  assert.equal(d.reason, 'current');
});

test('a forward protocol bump is offered, not deadlocked', () => {
  // THE DEADLOCK THIS UNDOES. The gate was `m.protocol !== protocol`, which
  // refused every bump — and taking the release is the only way to cross one,
  // so a v2 host could never reach v3. Negotiation (PROTOCOL_MIN) makes the
  // forward move safe: the updated host down-speaks to whatever the coordinator
  // supports. So a v2 host IS offered the v3 release.
  const d = decideRelease({ manifest: { ...good, version: 'v9', protocol: 3 }, installed: 'v1', protocol: 2 });
  assert.equal(d.act, true, 'a v2 host must be able to take the v3 release — it is the only path to v3');
});

test('a protocol DOWNGRADE is refused', () => {
  // The one direction negotiation does not cover: moving to an older protocol
  // can drop a host below the coordinator's floor, and nothing legitimate asks
  // a host to go backwards.
  const d = decideRelease({ manifest: { ...good, version: 'v9', protocol: 1 }, installed: 'v1', protocol: 2 });
  assert.equal(d.act, false);
  assert.equal(d.reason, 'protocol');
  assert.match(d.message, /downgrade, not an update/);
});

test('a manifest missing a protocol is still usable', () => {
  // Older manifests do not carry one. Absent is not a mismatch — treating it as
  // one would strand every host on the release before this field existed.
  const { protocol, ...noProtocol } = good;
  assert.equal(decideRelease({ manifest: noProtocol, installed: '1', protocol: 2 }).act, true);
});

test('the filename is a name, never a path', () => {
  for (const file of ['../../etc/cron.d/x', '/etc/passwd', 'a/b.tar.gz', '.hidden', '']) {
    const d = decideRelease({ manifest: { ...good, file }, installed: '1', protocol: 2 });
    assert.equal(d.act, false, `should refuse ${JSON.stringify(file)}`);
  }
});

test('the VERSION is a name too, which is the one that was missed', () => {
  // `file` looks like a filename so it was validated. `version` looks like a
  // label — and then releasePaths turns it into <base>/releases/<version> and
  // <base>/releases/.incoming-<version>, which get mkdir'd, written to,
  // renamed and symlinked.
  //
  // `../../../../tmp/pwned` normalises straight out of the releases directory,
  // and the first thing that happens to it is mkdirSync({recursive: true}).
  for (const version of ['../../../../tmp/pwned', '/etc/cron.d/x', 'a/b', '.hidden', '']) {
    const d = decideRelease({ manifest: { ...good, version }, installed: '1', protocol: 2 });
    assert.equal(d.act, false, `should refuse version ${JSON.stringify(version)}`);
  }
  // And the shapes CI actually produces still pass.
  for (const version of ['main-42', '2026.09.01-2', 'v0.1.1']) {
    assert.equal(decideRelease({ manifest: { ...good, version }, installed: '1', protocol: 2 }).act, true, version);
  }
});

test('a manifest that is not a manifest is refused rather than guessed at', () => {
  for (const manifest of [null, 'a string', 42, {}, { version: '1' }, { ...good, sha256: 'nope' }]) {
    assert.equal(decideRelease({ manifest, installed: '1', protocol: 2 }).act, false);
  }
});

test('the digest is checked against the bytes that arrived', () => {
  const bytes = new TextEncoder().encode('a release');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  assert.equal(verifyDownload(bytes, { ...good, sha256, bytes: bytes.length }).ok, true);
  // Wrong content, right length: the case a length check alone would pass.
  const other = new TextEncoder().encode('b release');
  const bad = verifyDownload(other, { ...good, sha256, bytes: other.length });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /digest mismatch/);
  // BOTH digests are shown, because the next question is which one is wrong.
  assert.match(bad.message, new RegExp(sha256));
});

test('a file is fetched from beside its own manifest', () => {
  // One setting, so it cannot point at another deployment's tarball, and moving
  // a release host is one value rather than two that have to agree.
  assert.equal(
    fileUrl('https://releases.example/fleet/manifest.json', 'host-1.tar.gz'),
    'https://releases.example/fleet/host-1.tar.gz',
  );
});
