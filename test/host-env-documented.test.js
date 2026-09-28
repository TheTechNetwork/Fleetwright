// Every setting a box reads is written down in the file an operator edits.
//
// TWO PROCESSES, TWO FILES, ONE RULE. fleetwright reads `/etc/fleetwright.env` and
// the sidecar reads `/etc/fleetwright-sidecar.env`, and the split is deliberate
// — different privileges, different secrets. Both halves are checked here
// because the failure is the same in both and it is not a documentation
// failure: a setting nobody wrote down is a setting nobody sets, including the
// four that decide what a notification may quote and when a session is
// restarted underneath somebody.
//
// THE WORKER HAS HAD THIS TEST SINCE #353 AND THE HOST HAS NOT, which is the
// wrong way round: `wrangler.toml` is edited by whoever forks the coordinator,
// and `/etc/fleetwright.env` is edited by everyone who installs a box.
//
// An audit counted thirteen `FLEETWRIGHT_*` variables that `config.js` reads and
// the example file never named. Three of them decide things an operator would
// want to know about before somebody else does:
//
//   FLEETWRIGHT_USER                     which unix user holds the sudoers rules
//   FLEETWRIGHT_SANDBOX_ALLOW_UNSAFE_ARGS  turns off the mount refusals
//   FLEETWRIGHT_SANDBOX                  whether a session is contained at all
//
// The sandbox block even said so out loud — "described in docs/sidecar.md and
// sandbox/README.md; these are the ones that were not" — which is the failure
// the Worker's version of this test is written about: a variable that lives
// only in a paragraph somewhere else is one the person editing this file will
// never set.
//
// So the example file is the canonical list. It is what install.sh copies to
// /etc/fleetwright.env, it explains what every absence DOES, and this keeps it
// honest as config.js grows.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const CONFIG = read('src/config.js');
const EXAMPLE = read('install/fleetwright.env.example');

// THE SIDECAR'S SETTINGS COME FROM TWO PLACES, which is why this is a
// concatenation rather than one file: `config.js` holds everything the running
// process reads, and `bin/fleetwright-sidecar` holds the two that are read
// before it exists — the path to the env file itself, and the flag that quiets
// enrolment.
//
// COMMENTS ARE STRIPPED FIRST. `config.js` explains at length that
// FLEETWRIGHT_HOST_TOKEN was replaced by a keypair, and a scan of the raw text
// reads that paragraph as a setting the file must document — which would have
// this test demand an example line for a variable whose whole point is that it
// no longer exists.
const SIDECAR = [read('src/fleet/host/config.js'), read('bin/fleetwright-sidecar')]
  .map((src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))
  .join('\n');
const SIDECAR_EXAMPLE = read('install/fleetwright-sidecar.env.example');

/**
 * Every FLEETWRIGHT_* name config.js reads.
 *
 * Quoted literals only. `str('FLEETWRIGHT_X', ...)`, `bool(...)`, `int(...)` and
 * the one `'FLEETWRIGHT_SANDBOX_IMAGE' in process.env` all match, because they
 * all spell the name out — which is the property that makes this checkable at
 * all, and worth keeping if a fourth accessor is ever added.
 */
function readsFromEnv() {
  return [...new Set([...CONFIG.matchAll(/'(FLEETWRIGHT_[A-Z0-9_]+)'/g)].map((m) => m[1]))].sort();
}

/** Every FLEETWRIGHT_* name the example file mentions, commented out or not. */
function documented() {
  return new Set([...EXAMPLE.matchAll(/(FLEETWRIGHT_[A-Z0-9_]+)/g)].map((m) => m[1]));
}

test('every setting the host reads is named in the example env file', () => {
  const have = documented();
  const missing = readsFromEnv().filter((name) => !have.has(name));
  assert.deepEqual(
    missing,
    [],
    `read by src/config.js and absent from install/fleetwright.env.example:\n  ${missing.join('\n  ')}`,
  );
});

test('the file names nothing the host stopped reading', () => {
  // THE OTHER DIRECTION, and it is not symmetric: a variable documented and
  // never read is a setting somebody will set and then wonder about, which is
  // how FLEETWRIGHT_TELEGRAM_TOKEN spent a year looking live. Telegram is the
  // one exception, and it is allowed precisely because the file says
  // "archived" beside it and `fleetwright doctor` says so too.
  const reads = new Set(readsFromEnv());
  const stale = [...documented()].filter((name) => !reads.has(name) && !name.includes('TELEGRAM')).sort();
  assert.deepEqual(stale, [], `named in the example file and read nowhere:\n  ${stale.join('\n  ')}`);
});

test('the three that decide what a session is allowed to do are explained, not just listed', () => {
  // A NAME WITH NO SENTENCE IS NOT DOCUMENTATION. These are the ones where
  // guessing wrong is expensive, so each has to carry prose in the file rather
  // than appear in a bare list of defaults.
  for (const name of ['FLEETWRIGHT_USER', 'FLEETWRIGHT_SANDBOX_ALLOW_UNSAFE_ARGS', 'FLEETWRIGHT_SANDBOX']) {
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

// --- the sidecar, same rule ------------------------------------------------

/**
 * Every FLEETWRIGHT_* name the sidecar reads.
 *
 * Two accessor shapes rather than one: `str(env, 'FLEETWRIGHT_X', …)` inside
 * config.js and a bare `process.env.FLEETWRIGHT_X` in the bin script, which
 * runs before a config object exists.
 */
function sidecarReadsFromEnv() {
  const found = [...SIDECAR.matchAll(/(?:'|process\.env\.)(FLEETWRIGHT_[A-Z0-9_]+)/g)].map((m) => m[1]);
  return [...new Set(found)].sort();
}

/** @param {string} text */
const namesIn = (text) => new Set([...text.matchAll(/(FLEETWRIGHT_[A-Z0-9_]+)/g)].map((m) => m[1]));

test('every setting the sidecar reads is named in its example env file', () => {
  // Four were not, and they are not obscure: what a notification may quote of
  // a session, how long a quiet pane waits before the sidecar restarts it, and
  // the two the process reads before this file is loaded at all. The first is a
  // decision about whose lock screen a path may appear on and it was reachable
  // only by reading config.js.
  const have = namesIn(SIDECAR_EXAMPLE);
  const missing = sidecarReadsFromEnv().filter((name) => !have.has(name));
  assert.deepEqual(
    missing,
    [],
    `read by the sidecar and absent from install/fleetwright-sidecar.env.example:\n  ${missing.join('\n  ')}`,
  );
});

test('the sidecar file names nothing the sidecar stopped reading', () => {
  // The other direction, and there is no exception here — the sidecar has no
  // archived surface the way fleetwright has Telegram. A name in this file that
  // nothing reads is a setting somebody will set and then wonder about.
  // The hub's own settings count as read: since the rename both files share
  // one prefix, and the sidecar file names the hub's FLEETWRIGHT_TOKEN to say
  // which value its own must match.
  const reads = new Set([...sidecarReadsFromEnv(), ...readsFromEnv()]);
  const stale = [...namesIn(SIDECAR_EXAMPLE)].filter((name) => !reads.has(name)).sort();
  assert.deepEqual(stale, [], `named in the sidecar example and read nowhere:\n  ${stale.join('\n  ')}`);
});

test('the setting that decides what leaves this box is explained, not just listed', () => {
  // FLEETWRIGHT_PROMPT_TEXT is the sidecar's equivalent of the three above: it
  // decides whether a path or a command line travels to a lock screen through
  // somebody else's servers, on a fleet that may not belong to the person
  // holding the phone. A bare `#FLEETWRIGHT_PROMPT_TEXT=0` in a list of
  // defaults is not something anybody makes that decision from.
  const at = SIDECAR_EXAMPLE.indexOf('#FLEETWRIGHT_PROMPT_TEXT=');
  assert.ok(at > 0, 'FLEETWRIGHT_PROMPT_TEXT is not offered as a settable line');
  const before = SIDECAR_EXAMPLE.slice(0, at).split('\n').slice(0, -1).reverse();
  const prose = [];
  for (const line of before) {
    if (!line.startsWith('#')) break;
    if (/^# ---/.test(line)) break;
    prose.push(line.replace(/^#\s?/, ''));
  }
  assert.ok(prose.join(' ').trim().length > 40, 'it is listed with no explanation of what setting it does');
});
