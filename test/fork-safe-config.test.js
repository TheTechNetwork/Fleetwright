// The config this repository publishes as its default must be safe to deploy.
//
// It was not. `worker/wrangler.toml` held our routes, our allowlist, our Sentry
// project, our GitHub App and our invite sender — so a fork that followed the
// README's deploy button and changed nothing got a coordinator that ADMITTED
// FOUR OF OUR ADDRESSES TO THEIR FLEET (docs/trust.md has coordinator → host as
// trusted absolutely), posted their errors to our Sentry, and served an
// installer that put our code on their machines.
//
// The code was never wrong about any of it. The comment beside the allowlist
// said "Empty ALLOW means nobody, deliberately"; sentry.js said an unset DSN
// posts nowhere. The committed VALUES defeated both — a document asserting
// something the configuration makes untrue, which is the failure app-parity.md
// exists to name.
//
// So there are two files, split by OWNERSHIP rather than capability, and this
// pins the split. Everything structural is identical in both, because a fork
// needs a Durable Object exactly as much as we do.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const DEFAULT = read('worker/wrangler.toml');
const PRODUCTION = read('worker/wrangler.production.toml');
const DEMO = read('worker/wrangler.demo.toml');

/**
 * Settings, not prose. Every one of these files explains at length what it does
 * NOT contain, so a grep over the raw text finds our hostname in the sentence
 * promising it is absent.
 *
 * @param {string} toml
 */
const settings = (toml) => toml.replace(/^\s*#.*$/gm, '');

/** Top-level `key = value` and `[vars]` entries, which is all this needs. */
function parse(toml) {
  /** @type {{ table: string|null, key: string, value: string }[]} */
  const out = [];
  let table = null;
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[+([^\]]+)\]+$/.exec(line);
    if (header) { table = header[1]; continue; }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (kv) out.push({ table, key: kv[1], value: kv[2] });
  }
  return out;
}

test('the default config names nobody, and could be deployed by anybody', () => {
  const bare = settings(DEFAULT);

  // THE ONE THAT MATTERS. An allowlist in the default config is a fork
  // admitting strangers to their own fleet.
  assert.equal(/AGENT_FLEET_AUTH_ALLOW\s*=/.test(bare), false,
    'the default config sets an allowlist — a fork deploying it admits whoever is on it');

  // Our identifiers, none of which mean anything useful to somebody else and
  // all of which do something when inherited.
  for (const ours of [
    'thetech.network',
    'elibrody2@gmail.com',
    'sentry.io',
    'Iv23liR4EwdP1xDxLt5E',
    'fleetwright-agents',
    'testflight.apple.com',
    'play.google.com',
    'raw.githubusercontent.com',
  ]) {
    assert.equal(bare.includes(ours), false, `the default config still names ${ours}`);
  }

  // No routes: `custom_domain` on a domain nobody else owns is a deploy that
  // fails, which is what broke the README's Deploy to Cloudflare button for
  // every fork.
  assert.equal(/^routes\s*=/m.test(bare), false, 'the default config claims a domain');

  // `[vars]` exists and is EMPTY rather than absent, so the table header is
  // there for somebody to add to and cannot silently move the entries below it
  // out of scope — the exact trap the send_email binding comment describes.
  assert.match(DEFAULT, /^\[vars\]$/m);
  assert.equal(parse(DEFAULT).filter((e) => e.table === 'vars').length, 0);
});

test('the production config is ours, says so, and is never the default', () => {
  const mine = settings(PRODUCTION);
  assert.match(mine, /^routes\s*=/m, 'our deployment has no route');
  assert.ok(mine.includes('fleet.thetech.network'));
  assert.match(PRODUCTION, /OUR deployment of the coordinator, and nobody else's/);

  // Same script, so `wrangler secret put` reaches both and a deploy from either
  // file replaces the same Worker.
  const nameOf = (/** @type {string} */ t) => parse(t).find((e) => e.table === null && e.key === 'name')?.value;
  assert.equal(nameOf(PRODUCTION), nameOf(DEFAULT));
  assert.notEqual(nameOf(DEMO), nameOf(DEFAULT), 'the demo shares a script with the coordinator again');

  // AND THE ALLOWLIST IS NOT HERE EITHER. It decides who can reach a fleet and
  // does not belong in a public repository at all — the secret block in
  // wrangler.toml has listed it as a secret all along, and the [vars] entry was
  // the bug. Cloudflare keeps vars and secrets in ONE namespace, so a var of
  // that name would clobber the secret on every deploy.
  assert.equal(/AGENT_FLEET_AUTH_ALLOW\s*=/.test(mine), false,
    'the allowlist is a var again — a deploy would clobber the secret');
});

test('the structural half is identical in both, key by key', () => {
  // A fork needs the Durable Object, the migrations and the rate limit exactly
  // as much as we do. Duplicating them is the cost of the split, and two copies
  // that must agree and are never compared is how one of them silently stops
  // matching — which for `[[migrations]]` means a deploy that cannot find its
  // class.
  const structural = (/** @type {string} */ t) =>
    parse(t)
      .filter((e) => e.table && e.table !== 'vars')
      .map((e) => `${e.table}.${e.key}=${e.value}`)
      .sort();

  assert.deepEqual(structural(PRODUCTION), structural(DEFAULT));

  // Named so the list cannot quietly become empty and pass.
  const both = structural(DEFAULT).join('\n');
  for (const required of ['durable_objects.bindings.class_name', 'migrations.tag', 'ratelimits.namespace_id']) {
    assert.match(both, new RegExp(required.replace(/\./g, '\\.')));
  }

  // And the identity lines, which decide what gets replaced by a deploy.
  for (const key of ['name', 'main', 'compatibility_date', 'compatibility_flags']) {
    const of = (/** @type {string} */ t) => parse(t).find((e) => e.table === null && e.key === key)?.value;
    assert.equal(of(PRODUCTION), of(DEFAULT), `${key} differs between the two configs`);
  }
});

test('CI deploys the production config, and it is a variable rather than a constant', () => {
  // A fork running this workflow must not deploy OUR config. The path comes
  // from a repository variable that our repository sets and a fork does not, so
  // the default is the safe file.
  const yml = read('.github/workflows/worker.yml');
  assert.match(yml, /WRANGLER_CONFIG/);
  assert.match(yml, /wrangler\.toml/, 'there is no safe default config path');
});
