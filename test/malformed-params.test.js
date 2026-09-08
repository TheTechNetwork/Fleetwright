// `params` that is not an object, on both coordinators.
//
// Found while probing for #313 (a Cloudflare 1101 on /api/intent) rather than
// from a report — and that is the shape of it. Both coordinators did:
//
//   params: body.params && typeof body.params === 'object' ? body.params : {}
//
// which coerces a STRING, a number or a boolean to "no parameters" and runs the
// verb. The request succeeds, so nobody files anything. On `status` that is
// confusing; on `start` a session begins under a generated name in the default
// mode while the caller believes they asked for something else.
//
// ABSENT IS NOT MALFORMED. A missing `params`, or `null`, genuinely means "this
// verb takes none" and must keep working — the distinction this repository
// keeps paying for, one layer up from `checkParams`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkParams } from '../src/fleet/protocol/intents.js';

const sources = () => ({
  worker: readFileSync(new URL('../worker/src/fleet-do.js', import.meta.url), 'utf8'),
  node: readFileSync(new URL('../src/fleet/coordinator/server.js', import.meta.url), 'utf8'),
});

test('checkParams already refuses a non-object, which is why the coercion hid it', () => {
  // THE VALIDATOR WAS NEVER THE PROBLEM. It refuses a string outright — the
  // HTTP layer simply never handed it one, so the check that would have caught
  // this was unreachable from the door.
  assert.equal(checkParams('status', /** @type {any} */ ('nope')).code, 'bad_params');
  assert.equal(checkParams('status', /** @type {any} */ (42)).code, 'bad_params');
  assert.equal(checkParams('status', /** @type {any} */ ([])).code, 'bad_params');
});

test('neither coordinator coerces a malformed params to an empty object', () => {
  for (const [name, src] of Object.entries(sources())) {
    assert.doesNotMatch(
      src,
      /params: body\.params && typeof body\.params === 'object' \? body\.params : \{\}/,
      `${name} still swallows a malformed params`,
    );
    assert.match(src, /params must be a JSON object/, `${name} does not refuse one`);
  }
});

test('both refuse it the same way, because two coordinators are one contract', () => {
  // A body that means one thing on one coordinator and another on the other
  // means nothing. The repository already tests that they serve the same spec;
  // this is the same rule for how they read a request.
  for (const [name, src] of Object.entries(sources())) {
    assert.match(src, /body\.params !== undefined && body\.params !== null/, `${name} does not allow an absent params`);
    assert.match(src, /Array\.isArray\(body\.params\)/, `${name} lets an array through the type check`);
    assert.match(src, /code: 'bad_params'/, `${name} does not use the protocol's own code`);
  }
});

test('an absent or null params still means "this verb takes none"', () => {
  // THE HALF THAT MUST NOT BREAK. `list`, `profiles` and `updates` take no
  // parameters at all, and a phone that omits the field is not making a
  // mistake — refusing that would break every read in the product to fix a
  // typo nobody has made yet.
  for (const [name, src] of Object.entries(sources())) {
    assert.match(src, /params: body\.params \?\? \{\}/, `${name} no longer defaults an absent params`);
  }
  assert.equal(checkParams('list', {}).ok, true);
});
