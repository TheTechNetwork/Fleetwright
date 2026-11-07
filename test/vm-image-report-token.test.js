// A machine image is promoted on proof, never on a power state.
//
// THE RESIDUAL THIS PINS. The build waits for its VM to say `done` before a
// halt counts as installed (vm-image.js, STOPPED IS NOT DONE) — but only when
// the build had a report token. The token is whatever the coordinator answered,
// a failed ask became null (xo-setup.js, reporter), and with null the old rule
// was back: any halt was "installed", and a maintenance reboot, a stop from Xen
// Orchestra or an install cut off mid-step became the template every later
// machine was cloned from. So: no token, no install; and only `done` ends the
// wait onto the template.
//
// Driven against a scripted Xen Orchestra rather than the stand-in, because
// what is under test is the build's own decisions, not the server's answers.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureImage, noReportToken, DEBIAN_IMAGE, IMAGES, VM_IMAGE } from '../src/fleet/host/vm-image.js';

/** A token in the shape the coordinator mints (intents.js, IMAGE_REPORT_TOKEN_RE). */
const TOKEN = `fwi_${'ab'.repeat(6)}_${'cd'.repeat(24)}`;

/**
 * A pool with XCP-ng's blank template and a base disk kept from an earlier
 * build, so nothing is downloaded or uploaded here; the build VM is made,
 * grown, and then either started or not.
 */
function scriptedPool({ power = 'Halted' } = {}) {
  /** @type {Array<[string, any]>} */
  const calls = [];
  const baseTag = `${VM_IMAGE.baseTag}:${DEBIAN_IMAGE.key}:${IMAGES[DEBIAN_IMAGE.key].build}`;
  const admin = {
    async call(/** @type {string} */ method, /** @type {any} */ params) {
      calls.push([method, params]);
      const f = params?.filter ?? {};
      switch (method) {
        case 'xo.getAllObjects':
          if (f.type === 'VM-template') {
            return {
              tpl: { id: 'tpl', type: 'VM-template', $pool: 'p1', name_label: VM_IMAGE.template, isDefaultTemplate: true, $VBDs: [], tags: [] },
              base: { id: 'base', type: 'VM-template', $pool: 'p1', name_label: 'Fleetwright base', tags: [VM_IMAGE.baseTag, baseTag], $VBDs: ['vbd-base'] },
            };
          }
          if (f.type === 'VM') return {};
          if (f.type === 'VBD') return { v: { VDI: f.VM === 'base' ? 'vdi-base' : 'vdi1' } };
          if (f.type === 'VDI') return { d: { id: f.id, $SR: 'sr1', name_label: 'root' } };
          if (f.id === 'vm1') return { vm1: { id: 'vm1', power_state: power, startTime: 1 } };
          return {};
        case 'resourceSet.getAll':
          return [{ id: 'rs-made', name: 'fleetwright-made', objects: ['base'] }];
        case 'vm.create':
          return 'vm1';
        default:
          return {};
      }
    },
  };
  const srs = [{ id: 'sr1', $pool: 'p1', size: 200 * 1024 ** 3, physical_usage: 0, name_label: 'Local' }];
  /** @type {string[]} */
  const said = [];
  let clock = 0;
  const opts = {
    admin, pool: 'p1', poolName: 'Home', uplink: 'net', setId: 'rs-0', srs, fleetSrs: ['sr1'],
    address: 'xo.example', pin: null, plain: false, imageDir: '/nonexistent', coordinatorUrl: 'https://fleet.test',
    say: (/** @type {string} */ t) => said.push(t),
    getAgent: async () => Buffer.from('agent'),
    addressesOf: async () => ['192.0.2.1'],
    now: () => clock,
    // Every poll is two and a half minutes later: past DONE_GRACE_MS on the
    // second look at a halted VM, well short of the install timeout.
    sleep: async () => { clock += 150_000; },
    pollMs: 1,
    getImage: async () => { throw new Error('nothing should be downloaded: the base is kept'); },
    upload: async () => { throw new Error('nothing should be uploaded: the base is kept'); },
  };
  const method = (/** @type {string} */ m) => calls.filter(([c]) => c === m);
  return { admin, opts, calls, said, method };
}

test('no report token, no install: refused before the VM starts, with the next step named', async () => {
  for (const [reporter, asked] of /** @type {Array<[any, boolean]>} */ ([[null, false], [async () => null, true]])) {
    const pool = scriptedPool();
    await assert.rejects(
      ensureImage({ ...pool.opts, reporter, vmReport: () => null }),
      (/** @type {Error} */ e) => {
        assert.equal(e.message, noReportToken(asked));
        return true;
      },
    );
    assert.match(noReportToken(asked), asked ? /did not get an answer/ : /older than report tokens; update it/);
    assert.equal(pool.method('vm.start').length, 0, 'the install never began');
    assert.equal(pool.method('vm.createCloudInitConfigDrive').length, 0);
    // The build VM that was made is removed; the kept base and the pool's
    // image, if any, are untouched.
    assert.deepEqual(pool.method('vm.delete').map(([, p]) => p.id), ['vm1']);
    assert.equal(pool.method('vm.convertToTemplate').length, 0);
  }
});

test('a VM that powers off without saying done is kept, named, and not the template', async () => {
  const pool = scriptedPool({ power: 'Halted' });
  await assert.rejects(
    ensureImage({ ...pool.opts, reporter: async () => TOKEN, vmReport: () => null }),
    /stopped before it said the install was done \(it never reported in\), so it was not made the template\. Home still has no Debian 13 machine image\./,
  );
  assert.equal(pool.method('vm.start').length, 1, 'the install was started');
  assert.equal(pool.method('vm.convertToTemplate').length, 0, 'STOPPED IS NOT DONE');
  // Kept for looking at, named for what happened; not deleted.
  assert.ok(pool.method('vm.set').some(([, p]) => p.id === 'vm1' && /stopped before done/.test(p.name_label)));
  assert.deepEqual(pool.method('vm.delete'), []);
});

test('a VM that says done and then powers off is promoted', async () => {
  const pool = scriptedPool({ power: 'Halted' });
  const text = await ensureImage({ ...pool.opts, reporter: async () => TOKEN, vmReport: () => ({ step: 'done', detail: null, at: 0 }) });
  assert.match(text, /^The machine image is ready on Home: Fleetwright Debian 13/);
  assert.deepEqual(pool.method('vm.convertToTemplate').map(([, p]) => p.id), ['vm1']);
  assert.ok(pool.method('tag.add').some(([, p]) => p.id === 'vm1' && p.tag === VM_IMAGE.tag));
});
