// What a machine can say about itself without being told.
//
// Labels are how work is aimed — `tag: macos` on a start, and the scheduler
// filters before it ranks by capacity. They came only from AGENT_FLEET_LABELS,
// which means every one was somebody having remembered to type it into an env
// file at install time.
//
// So the facts that never change and are never wrong — the operating system,
// the architecture, whether the sandbox image has a browser in it — were the
// ones most likely to be missing, because they are the ones nobody thinks to
// write down. And a fleet where `tag: arm64` finds nothing, on a fleet of arm64
// boxes, teaches people that tags do not work.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { autoLabels } from '../src/fleet/host/auto-labels.js';

const linux = { platform: () => 'linux', arch: () => 'x64', readFile: () => 'ID=debian\n' };

test('a box reports its platform, architecture and distribution', () => {
  const got = autoLabels({}, linux);
  for (const label of ['linux', 'x64', 'debian']) {
    assert.ok(got.includes(label), `missing ${label}: ${got.join(' ')}`);
  }
});

test('both words for an architecture, because both are what people type', () => {
  // x64 is node's word; amd64 is everybody else's, including the container tags
  // this fleet publishes. Somebody tagging a start has seen the second one, and
  // a tag that requires knowing node's platform strings is a tag for people who
  // have read the source.
  assert.ok(autoLabels({}, linux).includes('amd64'));
  const arm = autoLabels({}, { ...linux, arch: () => 'arm64' });
  assert.ok(arm.includes('arm64') && arm.includes('aarch64'), arm.join(' '));
});

test('a Mac answers to the word somebody would reach for', () => {
  // `darwin` is what node calls it. Nobody tagging a job for a Mac types that,
  // so both are reported — a tag that requires knowing node's platform strings
  // is a tag for people who have read the source.
  const mac = autoLabels({}, {
    platform: () => 'darwin',
    arch: () => 'arm64',
    readFile: () => { throw new Error('ENOENT'); },
  });
  assert.ok(mac.includes('macos'), mac.join(' '));
  assert.ok(mac.includes('darwin'), mac.join(' '));
  assert.ok(mac.includes('arm64') && mac.includes('aarch64'));

  // And windows answers to the one word it has.
  const win = autoLabels({}, { platform: () => 'win32', arch: () => 'x64', readFile: () => { throw new Error('x'); } });
  assert.ok(win.includes('windows'), win.join(' '));
  assert.ok(!win.includes('win32'), 'it reports node\'s name for windows');
});

test('a box with no os-release is not a broken box', () => {
  // This is the set of things a machine will VOLUNTEER, and silence is one of
  // the answers. A Mac has no /etc/os-release and is not missing anything.
  const got = autoLabels({}, { ...linux, readFile: () => { throw new Error('ENOENT'); } });
  assert.ok(got.includes('linux'));
  assert.ok(!got.some((l) => l === 'undefined' || l === ''), got.join(' '));
});

test('a malformed os-release contributes nothing rather than nonsense', () => {
  // ID is a plain lowercase token by spec. Anything else is a file this does
  // not understand, and a label of `Debian GNU/Linux "13"` would be a tag
  // nobody can type and the scheduler can never match.
  const got = autoLabels({}, { ...linux, readFile: () => 'ID=Debian GNU/Linux "13"\n' });
  assert.deepEqual(got.filter((l) => l.includes(' ') || l.includes('"')), []);
});

test('a browser is a label, because only the box can answer that', () => {
  // It is a property of the IMAGE this box runs sessions in, and nothing else
  // on the machine can say. A box pointed at the `:web` tag says so, and
  // `tag: browser` finds it without anybody maintaining a list of which hosts
  // were configured how.
  const web = autoLabels({ sandboxImage: 'ghcr.io/o/fleetwright-session:web' }, linux);
  assert.ok(web.includes('browser'), web.join(' '));

  for (const image of ['ghcr.io/o/fleetwright-session:latest', 'ghcr.io/o/fleetwright-session', '']) {
    assert.ok(!autoLabels({ sandboxImage: image }, linux).includes('browser'), image);
  }
  // AND NOT A HOST THAT MERELY HAS "web" IN ITS NAME. `webhooks-runner:latest`
  // is not a browser, and a label that matched it would send a session that
  // needs Chromium to a box without one.
  assert.ok(!autoLabels({ sandboxImage: 'ghcr.io/o/webhooks-runner:latest' }, linux).includes('browser'));
});

test('the operator keeps their own labels', () => {
  // "gpu", "prod", "noisy-neighbour" are decisions, and no amount of
  // introspection produces them. The two sets are unioned; an operator naming
  // something this file also derives is not a conflict.
  const src = readFileSync(new URL('../bin/agent-fleet-sidecar', import.meta.url), 'utf8');
  assert.match(src, /labels: \[\.\.\.new Set\(\[\.\.\.cfg\.labels, \.\.\.autoLabels\(loadConfig\(\)\)\]\)\]\.sort\(\)/);
});
