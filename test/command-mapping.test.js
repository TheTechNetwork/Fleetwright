// Every verb's command line must be one the command actually parses.
//
// `/upgrade apply` looked right and did nothing: agent-hub's upgrade reads
// `flags.has('apply')`, and parse() only puts a DASH-PREFIXED token into flags,
// so a positional `apply` was silently the reporting mode. The symptom was
// exact and misleading — tapping "Apply upgrade" returned the check text,
// ending in the host's own hint, "/upgrade --apply to install them."
//
// `update` sent `--restart` and worked. Two mappings, one convention, and
// nothing checked that they agreed. This is that check.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toCommandLine } from '../src/fleet/host/sidecar.js';
import { parse } from '../src/adapters/commands.js';

test('a verb that means "do it" produces a line that says so', () => {
  // The two that carry an opt-in, and the exact pair that disagreed.
  const upgrade = parse(toCommandLine({ verb: 'upgrade', params: { apply: 'yes' } }));
  assert.ok(upgrade.flags.has('apply'), 'upgrade --apply does not reach the command as a flag');

  const update = parse(toCommandLine({ verb: 'update', params: { restart: 'yes' } }));
  assert.ok(update.flags.has('restart'), 'update --restart does not reach the command as a flag');
});

test('and the reporting mode still reports', () => {
  assert.equal(parse(toCommandLine({ verb: 'upgrade', params: {} })).flags.has('apply'), false);
  assert.equal(parse(toCommandLine({ verb: 'update', params: {} })).flags.has('restart'), false);
});

test('every option-shaped param arrives as a flag, not a positional', () => {
  // The general form, so the next verb with an opt-in cannot repeat this.
  // A param whose value is the enum "yes" is an option: it means "do the
  // thing", and an option that arrives as a bare word is an option the command
  // never sees.
  const optIns = [
    ['update', { restart: 'yes' }, 'restart'],
    ['upgrade', { apply: 'yes' }, 'apply'],
    ['connect', { provider: 'github', scope: 'host' }, 'host'],
    ['unlink', { provider: 'github', scope: 'host' }, 'host'],
  ];
  for (const [verb, params, flag] of optIns) {
    const line = toCommandLine({ verb, params, actor: 'a@b.com' });
    assert.ok(parse(line).flags.has(flag), `${verb}: "${line}" does not carry --${flag} as a flag`);
  }
});

test('positional verbs stay positional', () => {
  // The other convention, and it is equally load-bearing: /reboot takes a pin
  // and a hostname as words, /logs takes a source and a count. Turning those
  // into flags would break them just as quietly.
  const reboot = parse(toCommandLine({ verb: 'reboot', params: { pin: '123456', confirm: 'box' } }));
  assert.deepEqual(reboot.args, ['123456', 'box']);
  assert.equal(reboot.flags.size, 0);

  const logs = parse(toCommandLine({ verb: 'logs', params: { service: 'hub', lines: 50 } }));
  assert.deepEqual(logs.args, ['hub', '50']);
});

test('a credential is still one token on the line', () => {
  // The secret sits between a provider and an optional flag. It is charset-
  // constrained so it cannot split or become a flag itself — checked here
  // because this is the line where that would show up.
  const p = parse(toCommandLine({ verb: 'link', params: { provider: 'github', secret: 'ghp_x1', scope: 'host' }, actor: 'a@b.com' }));
  assert.deepEqual(p.args, ['github', 'ghp_x1']);
  assert.ok(p.flags.has('host'));
});
