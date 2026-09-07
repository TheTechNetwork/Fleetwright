// Where a SETTING goes, which is not where new work goes.
//
// `channel`, `sandbox` and `labels` change what a box IS — which releases it
// takes, which image its sessions run in, what work aimed at a tag finds there.
// None of them starts anything, and all three fell through to the new-work path
// in `place()`, which ranks by free capacity and round-robins.
//
// Both halves of that were reachable from a phone, and neither had a test,
// which is why `channel` shipped with it and nobody saw.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HostRegistry } from '../src/fleet/coordinator/registry.js';
import { place } from '../src/fleet/coordinator/scheduler.js';

/** Three boxes: two labelled `gpu` with room, one full and labelled `prod`. */
function fleet() {
  const r = new HostRegistry();
  for (const [id, free, labels] of [
    ['gpu-1', 4, ['linux', 'gpu']],
    ['gpu-2', 2, ['linux', 'gpu']],
    ['busy-box', 0, ['linux', 'prod']],
  ]) {
    r.connect(id, () => {});
    r.recordHealth(id, { hub: { reachable: true }, maxSessions: 4, running: 4 - free, free, labels });
  }
  return r;
}

const SETTINGS = ['channel', 'sandbox', 'labels'];

test('a busy box can still be configured', () => {
  // THE LIVE BUG, and it shipped with `channel`. The new-work path filters on
  // `schedulable()`, which drops a host with no free capacity — so changing the
  // release channel of a machine that was running four sessions answered
  // "busy-box is healthy: undefined", from a capacity check that has no
  // business being consulted about a setting.
  //
  // A box being busy is the ordinary state of a useful box, and it is also
  // exactly when somebody wants to move it off rolling.
  for (const verb of SETTINGS) {
    const p = place(fleet(), { verb, params: {} }, { preferHost: 'busy-box' });
    assert.equal(p.kind, 'host', `${verb} refused a full box`);
    assert.equal(p.host.hostId, 'busy-box');
  }
});

test('a tag reaches every box carrying it, and not one of them', () => {
  // THE OTHER HALF. `tag` was ranked by free capacity and round-robined, so
  // `channel { to: stable } + tag: prod` moved ONE production box and reported
  // success with nothing saying which. "Defaults per label" is the reason
  // placement travels beside the intent at all: `host` says which one, `tag`
  // says which ones.
  for (const verb of SETTINGS) {
    const p = place(fleet(), { verb, params: {} }, { preferLabels: ['gpu'] });
    assert.equal(p.kind, 'fanout', `${verb} did not fan out`);
    assert.deepEqual(p.hosts.map((h) => h.hostId).sort(), ['gpu-1', 'gpu-2']);
  }
});

test('a tag that matches a busy box still reaches it', () => {
  // The two fixes are the same fix: a setting is answered by a box whether or
  // not it has room, so the fan-out is over `reachable()` and not `schedulable()`.
  const p = place(fleet(), { verb: 'sandbox', params: {} }, { preferLabels: ['prod'] });
  assert.equal(p.kind, 'fanout');
  assert.deepEqual(p.hosts.map((h) => h.hostId), ['busy-box']);
});

test('a degraded box is reconfigurable, which is when it matters most', () => {
  // `reachable()` AND NOT `schedulable()`, and the difference is not capacity —
  // `schedulable()` filters on STATE. A box whose hub is unhappy or whose
  // claude is logged out is degraded, still connected, still holding every
  // session it is running.
  //
  // That is precisely the box somebody wants to move off rolling, or point at a
  // smaller image. A fan-out over `schedulable()` would skip it silently and
  // report success about the boxes that were fine already.
  //
  // Same set `logs`, `update`, `upgrade` and `reboot` all use, for the same
  // reason: a question about a box should reach anything on the end of a socket.
  const r = fleet();
  r.recordHealth('gpu-2', {
    hub: { reachable: false, reason: 'hub is down' }, maxSessions: 4, running: 2, free: 2, labels: ['linux', 'gpu'],
  });
  const p = place(r, { verb: 'sandbox', params: {} }, { preferLabels: ['gpu'] });
  assert.equal(p.kind, 'fanout');
  assert.deepEqual(p.hosts.map((h) => h.hostId).sort(), ['gpu-1', 'gpu-2']);
});

test('a named host still wins over a tag', () => {
  // The existing rule everywhere else in this file: somebody who says "this
  // box" means it.
  const p = place(fleet(), { verb: 'sandbox', params: {} }, { preferHost: 'gpu-1', preferLabels: ['gpu'] });
  assert.equal(p.kind, 'host');
  assert.equal(p.host.hostId, 'gpu-1');
});

test('a tag nothing carries is refused, and names what the fleet has', () => {
  // Silently reaching nothing is the worst answer available: it is
  // indistinguishable from the change having been applied everywhere it should.
  const p = place(fleet(), { verb: 'labels', params: { add: 'x' } }, { preferLabels: ['macos'] });
  assert.equal(p.kind, 'refused');
  assert.equal(p.code, 'no_host_matches');
  assert.match(p.reason, /Tags in this fleet: gpu, linux, prod\./);
});

test('with several boxes and nothing said, it asks rather than picks', () => {
  for (const verb of SETTINGS) {
    const p = place(fleet(), { verb, params: {} }, {});
    assert.equal(p.kind, 'refused', `${verb} picked a box on its own`);
    assert.equal(p.code, 'ambiguous_host');
  }
});

test('reboot and upgrade do NOT fan out on a tag', () => {
  // DELIBERATELY NOT THE SAME RULE. "Reboot everything labelled prod" is a
  // fleet-wide outage expressible in one line, and an upgrade is four apt runs
  // merged into one reply. A setting is reversible and says nothing while it
  // works; these are neither.
  for (const verb of ['reboot', 'upgrade', 'update', 'logs']) {
    const p = place(fleet(), { verb, params: {} }, { preferLabels: ['gpu'] });
    assert.equal(p.kind, 'refused', `${verb} fanned out on a tag`);
    assert.equal(p.code, 'ambiguous_host');
  }
});
