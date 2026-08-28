// Enrolment used to end with "Start the sidecar: sudo systemctl restart
// agent-fleet-sidecar", printed whatever the box was doing. On the common path
// — a sidecar already running, which is what the installer leaves behind — that
// instruction is wrong: the running process reconnects on its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enrolNextStep } from '../src/fleet/host/enrol-next.js';

const base = { unitInstalled: true, state: 'inactive', tty: true, quiet: false, maxBackoffMs: 30_000 };

test('a running sidecar needs nothing, and says how long', () => {
  const r = enrolNextStep({ ...base, state: 'active' });
  assert.equal(r.kind, 'connects-itself');
  assert.match(r.text, /within 30s/);
  assert.doesNotMatch(r.text, /restart/);
});

test('a sidecar mid-start also needs nothing', () => {
  for (const state of ['activating', 'reloading']) {
    assert.equal(enrolNextStep({ ...base, state }).kind, 'connects-itself');
  }
});

test('a stopped sidecar is offered, not commanded', () => {
  const r = enrolNextStep({ ...base, state: 'inactive' });
  assert.equal(r.kind, 'offer-start');
});

test('a failed sidecar is offered too', () => {
  assert.equal(enrolNextStep({ ...base, state: 'failed' }).kind, 'offer-start');
});

test('the verb is start, never restart', () => {
  for (const state of ['inactive', 'failed', 'active']) {
    for (const quiet of [true, false]) {
      assert.doesNotMatch(enrolNextStep({ ...base, state, quiet }).text, /restart/);
    }
  }
});

test('no unit file means name no command — is-active says "inactive" for units it never heard of', () => {
  const r = enrolNextStep({ ...base, unitInstalled: false, state: 'inactive' });
  assert.equal(r.kind, 'no-service');
  assert.doesNotMatch(r.text, /systemctl/);
});

test('without a tty it states the command instead of asking into the void', () => {
  assert.equal(enrolNextStep({ ...base, tty: false }).kind, 'tell-start');
});

test('quiet never prompts — the installer enrols before it starts anything', () => {
  // Without this the installer would ask a question it is about to answer
  // itself, two lines later, by starting the service.
  assert.equal(enrolNextStep({ ...base, quiet: true }).kind, 'tell-start');
});
