#!/usr/bin/env node
// Register a coordinator with the relays, once, and print what to set.
//
//   node scripts/relay-register.mjs --relay https://fleet.thetech.network --callback https://your.coordinator
//
// FOR A COORDINATOR THAT IS NOT OURS: one that has no APNs key or Firebase
// account to wake the apps with, and no GitHub App secret to finish a
// sign-in with. docs/relay-terms.md says what the relays are told and keep.
//
// What it does: makes a P-256 key here, on this machine, registers its public
// half and the coordinator's callback with the relay, and prints the four
// values the coordinator needs. The private half is printed and kept nowhere
// else, so put it where the coordinator's secrets go (`wrangler secret put`)
// and nowhere it would be committed. Without --callback, the fleet uses the
// push relay only and no key is made.

import { webcrypto as crypto } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    relay: { type: 'string' },
    callback: { type: 'string' },
  },
});
const relay = String(values.relay || '').replace(/\/+$/, '');
if (!/^https:\/\/[^/\s]+$/.test(relay)) {
  console.error('Give the relay as --relay https://<host>, the origin it answers on.');
  process.exit(2);
}

/** @param {Uint8Array} bytes */
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

/** @type {Record<string, string>} */
const body = {};
let privateJwk = null;
if (values.callback) {
  const origin = String(values.callback).replace(/\/+$/, '');
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  body.key = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  body.callback = `${origin}/oauth/github/relayed`;
}

const res = await fetch(`${relay}/relay/v1/fleets`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const answer = await res.json().catch(() => null);
if (!res.ok || !answer?.ok) {
  console.error(`The relay did not register this fleet (${res.status}): ${answer?.text ?? 'no answer'}`);
  process.exit(1);
}

console.log('Set these on the coordinator. The last two are secrets.\n');
console.log(`FLEETWRIGHT_RELAY_URL=${relay}`);
console.log(`FLEETWRIGHT_RELAY_FLEET=${answer.fleet}`);
console.log(`FLEETWRIGHT_RELAY_SECRET=${answer.secret}`);
if (privateJwk) {
  console.log(`FLEETWRIGHT_RELAY_KEY=${JSON.stringify({ kty: 'EC', crv: 'P-256', x: privateJwk.x, y: privateJwk.y, d: privateJwk.d })}`);
  console.log('\nAnd FLEETWRIGHT_GITHUB_CLIENT_ID to the App\'s public client id, with no client secret.');
}
console.log('\nPush also needs FLEETWRIGHT_PUSH=1, as it does with credentials of your own.');
