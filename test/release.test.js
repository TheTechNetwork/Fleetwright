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

test('a protocol mismatch is refused, and refused BEFORE "up to date"', () => {
  // The order matters more than the refusal. A host on the wrong protocol that
  // is told "already up to date" has been told the opposite of what it needs to
  // do, and the mismatch would otherwise only surface after the update — when
  // it can no longer reach the coordinator to say so.
  const d = decideRelease({ manifest: { ...good, protocol: 3 }, installed: good.version, protocol: 2 });
  assert.equal(d.act, false);
  assert.equal(d.reason, 'protocol');
  assert.match(d.message, /Update the coordinator first/);
});

test('a manifest missing a protocol is still usable', () => {
  // Older manifests do not carry one. Absent is not a mismatch — treating it as
  // one would strand every host on the release before this field existed.
  const { protocol, ...noProtocol } = good;
  assert.equal(decideRelease({ manifest: noProtocol, installed: '1', protocol: 2 }).act, true);
});

test('the filename is a name, never a path', () => {
  // The one attacker-controlled field that reaches the filesystem.
  for (const file of ['../../etc/cron.d/x', '/etc/passwd', 'a/b.tar.gz', '.hidden', '']) {
    const d = decideRelease({ manifest: { ...good, file }, installed: '1', protocol: 2 });
    assert.equal(d.act, false, `should refuse ${JSON.stringify(file)}`);
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
