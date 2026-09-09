// Every setting the host reads is written down in the file an operator edits.
//
// THE WORKER HAS HAD THIS TEST SINCE #353 AND THE HOST HAS NOT, which is the
// wrong way round: `wrangler.toml` is edited by whoever forks the coordinator,
// and `/etc/agent-hub.env` is edited by everyone who installs a box.
//
// An audit counted thirteen `AGENT_HUB_*` variables that `config.js` reads and
// the example file never named. Three of them decide things an operator would
// want to know about before somebody else does:
//
//   AGENT_HUB_USER                     which unix user holds the sudoers rules
//   AGENT_HUB_SANDBOX_ALLOW_UNSAFE_ARGS  turns off the mount refusals
//   AGENT_HUB_SANDBOX                  whether a session is contained at all
//
// The sandbox block even said so out loud — "described in docs/sidecar.md and
// sandbox/README.md; these are the ones that were not" — which is the failure
// the Worker's version of this test is written about: a variable that lives
// only in a paragraph somewhere else is one the person editing this file will
// never set.
//
// So the example file is the canonical list. It is what install.sh copies to
// /etc/agent-hub.env, it explains what every absence DOES, and this keeps it
// honest as config.js grows.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CONFIG = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
const EXAMPLE = readFileSync(new URL('../install/agent-hub.env.example', import.meta.url), 'utf8');

/**
 * Every AGENT_HUB_* name config.js reads.
 *
 * Quoted literals only. `str('AGENT_HUB_X', ...)`, `bool(...)`, `int(...)` and
 * the one `'AGENT_HUB_SANDBOX_IMAGE' in process.env` all match, because they
 * all spell the name out — which is the property that makes this checkable at
 * all, and worth keeping if a fourth accessor is ever added.
 */
function readsFromEnv() {
  return [...new Set([...CONFIG.matchAll(/'(AGENT_HUB_[A-Z0-9_]+)'/g)].map((m) => m[1]))].sort();
}

/** Every AGENT_HUB_* name the example file mentions, commented out or not. */
function documented() {
  return new Set([...EXAMPLE.matchAll(/(AGENT_HUB_[A-Z0-9_]+)/g)].map((m) => m[1]));
}

test('every setting the host reads is named in the example env file', () => {
  const have = documented();
  const missing = readsFromEnv().filter((name) => !have.has(name));
  assert.deepEqual(
    missing,
    [],
    `read by src/config.js and absent from install/agent-hub.env.example:\n  ${missing.join('\n  ')}`,
  );
});

test('the file names nothing the host stopped reading', () => {
  // THE OTHER DIRECTION, and it is not symmetric: a variable documented and
  // never read is a setting somebody will set and then wonder about, which is
  // how AGENT_HUB_TELEGRAM_TOKEN spent a year looking live. Telegram is the
  // one exception, and it is allowed precisely because the file says
  // "archived" beside it and `agent-hub doctor` says so too.
  const reads = new Set(readsFromEnv());
  const stale = [...documented()].filter((name) => !reads.has(name) && !name.includes('TELEGRAM')).sort();
  assert.deepEqual(stale, [], `named in the example file and read nowhere:\n  ${stale.join('\n  ')}`);
});

test('the three that decide what a session is allowed to do are explained, not just listed', () => {
  // A NAME WITH NO SENTENCE IS NOT DOCUMENTATION. These are the ones where
  // guessing wrong is expensive, so each has to carry prose in the file rather
  // than appear in a bare list of defaults.
  for (const name of ['AGENT_HUB_USER', 'AGENT_HUB_SANDBOX_ALLOW_UNSAFE_ARGS', 'AGENT_HUB_SANDBOX']) {
    const at = EXAMPLE.indexOf(`#${name}=`);
    assert.ok(at > 0, `${name} is not offered as a settable line`);
    // The comment block immediately above it: walk back over contiguous
    // comment lines and require something more than a section rule.
    // `slice(0, -1)` drops the empty string between the previous newline and
    // `at`, which is not a comment line and would end the walk before it began.
    const before = EXAMPLE.slice(0, at).split('\n').slice(0, -1).reverse();
    const prose = [];
    for (const line of before) {
      if (!line.startsWith('#')) break;
      if (/^# ---/.test(line)) break;
      prose.push(line.replace(/^#\s?/, ''));
    }
    assert.ok(
      prose.join(' ').trim().length > 40,
      `${name} is listed with no explanation of what setting it does`,
    );
  }
});
