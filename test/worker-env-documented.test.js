// Every setting the Worker reads is written down where a fork would look.
//
// From #353: `AGENT_FLEET_ACTIONS_AUDIENCE` is read by `fleet-do.js` and
// appeared in NO file — not wrangler.toml, not wrangler.production.toml, not
// docs/. Four more were in prose but absent from the config a fork actually
// edits, which is nearly as bad: a fork operator configures the file in front
// of them, and a variable that only exists in a paragraph is one they will
// never set.
//
// The default config is the fork-safe one, so its comment block is the
// canonical list — that is the file somebody deploys, and it already explains
// what every absence DOES. This keeps that list honest as the code grows.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WRANGLER = readFileSync(new URL('../worker/wrangler.toml', import.meta.url), 'utf8');

/** Everything the Worker reads off `env`. */
function readsFromEnv() {
  const dir = fileURLToPath(new URL('../worker/src/', import.meta.url));
  /** @type {Set<string>} */
  const names = new Set();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/\benv\.((?:AGENT_FLEET|SENTRY)_[A-Z0-9_]+)/g)) names.add(m[1]);
  }
  return [...names].sort();
}

/**
 * Whether the config's prose names a variable.
 *
 * WILDCARDS COUNT, because the list uses them where a family shares one
 * behaviour — `AGENT_FLEET_GITHUB_*` covers the client id, the secret and the
 * app slug, and all three are unset together or not at all. Requiring the
 * literal string would push somebody to expand a group that reads better as
 * one line, which is a worse document in the name of a passing test.
 */
function documented(name) {
  if (WRANGLER.includes(name)) return true;
  // `AGENT_FLEET_GITHUB_*` and the like.
  for (const m of WRANGLER.matchAll(/((?:AGENT_FLEET|SENTRY)_[A-Z0-9_]*)\*/g)) {
    if (name.startsWith(m[1])) return true;
  }
  // `AGENT_FLEET_APP_IOS/_ANDROID` — one entry, two variables sharing a stem.
  for (const m of WRANGLER.matchAll(/((?:AGENT_FLEET|SENTRY)_[A-Z0-9_]+)\/(_[A-Z0-9_]+)/g)) {
    const stem = m[1].slice(0, m[1].lastIndexOf('_'));
    if (name === `${stem}${m[2]}`) return true;
  }
  return false;
}

test('every setting the Worker reads is named in the fork-safe config', () => {
  const missing = readsFromEnv().filter((n) => !documented(n));
  assert.deepEqual(
    missing,
    [],
    `read by the Worker and written down nowhere a fork would look:\n  ${missing.join('\n  ')}`,
  );
});

test('the one that was in no file at all is in this one', () => {
  // Named on its own, because a wildcard could swallow it back into
  // `AGENT_FLEET_ACTIONS_*` and this is the variable the finding was about.
  assert.match(WRANGLER, /AGENT_FLEET_ACTIONS_AUDIENCE/);
  // AND WHAT ITS ABSENCE DOES, which is the column that makes this list worth
  // reading: unset is not "any audience", it is this coordinator's own origin.
  assert.match(WRANGLER, /UNSET IS NOT/);
});

test('the list says what happens when each one is absent', () => {
  // The block's own promise — "every absence has a defined, honest behaviour".
  // A list of names with no consequences beside them is a list somebody skims.
  // FROM the heading TO the `[vars]` table that follows it. `indexOf('[vars]')`
  // on its own finds an earlier mention inside a comment 4700 characters
  // above, so the slice came out empty and the count was zero — a test that
  // measured nothing and would have passed the moment the threshold dropped.
  const from = WRANGLER.indexOf('WHAT TO SET, AND WHAT HAPPENS');
  const block = WRANGLER.slice(from, WRANGLER.indexOf('\n[vars]', from));
  const arrows = (block.match(/unset →|Unset →/g) || []).length;
  assert.ok(arrows >= 10, `only ${arrows} entries say what their absence does`);
});
