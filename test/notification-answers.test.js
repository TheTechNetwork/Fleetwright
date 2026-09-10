// The words on a notification's buttons, held equal with the words the fleet
// wrote.
//
// THE SAME ARRANGEMENT AS THE PALETTE, and for the same reason. `ANSWER_TITLES`
// in src/fleet/host/prompt.js is where the fleet decides what its answers are
// called; iOS needs them at category-registration time and Android at
// notification-build time, so each app declares its own copy, and three copies
// of a string is three copies of a string. design-parity.test.js reads three
// files to keep a colour equal; this reads three files to keep a sentence
// equal, and the failure it prevents is worse — a button that says one thing
// and types the answer to another.
//
// WHAT THIS CANNOT ANSWER, said plainly: whether a tap becomes the right digit,
// and whether an hour-old notification is refused. Those are questions about a
// function rather than about two files, and grepping a source for a word passes
// whether the function is right or not. They are run:
// apps/ios/FleetwrightTests/NotificationAnswersTests.swift and the Kotlin
// beside it execute the decision against the cases that matter, in CI, on the
// platforms that have the types.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { ANSWER_TITLES } from '../src/fleet/host/prompt.js';
import { PROMPT_CATEGORY } from '../src/fleet/coordinator/core.js';
import { PUSH_TTL_S } from '../src/fleet/push.js';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const has = (/** @type {string} */ p) => existsSync(new URL(`../${p}`, import.meta.url));

const SWIFT = 'apps/ios/Fleetwright/NotificationAnswers.swift';
const KOTLIN = 'apps/android/app/src/main/java/network/thetech/fleetwright/NotificationAnswers.kt';

/** The surfaces that exist. Android arrives in the layer above this one. */
const SURFACES = [['iOS', SWIFT], ['Android', KOTLIN]].filter(([, p]) => has(p));

test('the apps that have this feature declare the fleet\'s own words for it', () => {
  assert.ok(SURFACES.length, 'no app declares the answers, so this test is checking nothing');

  for (const [platform, path] of SURFACES) {
    const source = read(path);
    for (const [kind, titles] of Object.entries(ANSWER_TITLES)) {
      for (const [slot, title] of Object.entries(titles)) {
        assert.ok(
          source.includes(`"${title}"`),
          `${platform} does not offer "${title}" for ${kind}.${slot}`,
        );
      }
    }
  }
});

test('no app has invented an answer of its own', () => {
  // THE HALF A "DOES IT CONTAIN THE STRING" CHECK CANNOT SEE. Asserting the
  // fleet's words are present says nothing about a fourth button somebody added
  // on one platform — which is how two phones stop offering the same choices
  // while every existing check stays green. Same shape as the reverse direction
  // in design-parity.test.js.
  const ours = new Set(Object.values(ANSWER_TITLES).flatMap((t) => Object.values(t)));

  for (const [platform, path] of SURFACES) {
    const rows = titleRows(read(path), platform);
    assert.ok(rows.length, `${platform} has no answer table to read`);
    for (const { kind, titles } of rows) {
      assert.ok(ANSWER_TITLES[kind], `${platform} offers answers for "${kind}", which the fleet does not ask about`);
      assert.equal(titles.length, 2, `${platform} gives ${kind} ${titles.length} buttons rather than two`);
      for (const title of titles) {
        assert.ok(ours.has(title), `${platform} offers "${title}", which the fleet did not write`);
      }
    }
    assert.equal(rows.length, Object.keys(ANSWER_TITLES).length, `${platform} answers a different set of questions`);
  }
});

/**
 * The vocabulary table, one row per kind.
 *
 * READ AS ROWS RATHER THAN AS A BAG OF STRINGS, because the interesting failure
 * is positional: a platform that has all six of the fleet's words and has put
 * "In full" under `permission` passes every check that only asks which strings
 * are present. One row is one kind, and the quotes on it are its kind then its
 * two buttons, in both languages:
 *
 *   Swift    "resume": (a: "From a summary", b: "In full"),
 *   Kotlin   "resume" to Answers("From a summary", "In full"),
 *
 * @param {string} source @param {string} platform
 */
function titleRows(source, platform) {
  const at = source.search(/\btitles\b[^\n]*(=|:)/);
  assert.ok(at >= 0, `${platform} declares no answer table`);
  const lines = source.slice(at).split('\n');
  /** @type {{ kind: string, titles: string[] }[]} */
  const rows = [];
  for (const line of lines.slice(1)) {
    const quoted = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    // The table ends at the first line that closes it and carries no strings.
    if (!quoted.length) {
      if (/^\s*[)\]]/.test(line)) break;
      continue;
    }
    rows.push({ kind: quoted[0], titles: quoted.slice(1) });
  }
  return rows;
}

test('every app refuses an answer after the hour the coordinator would have delivered it for', () => {
  // ONE NUMBER, three files. PUSH_TTL_S is the window a provider may hold a
  // notification; both clocks start at the same sentAt, so an app with a
  // different figure is an app that either answers questions the host stopped
  // asking or refuses ones it is still asking.
  for (const [platform, path] of SURFACES) {
    const source = read(path);
    assert.match(
      source,
      new RegExp(`window[^\\n]*=\\s*${PUSH_TTL_S}\\b`),
      `${platform} does not use the ${PUSH_TTL_S}s window push.js sets`,
    );
  }
});

test('every app registers the categories under the name the coordinator sends', () => {
  // The category is what makes the buttons appear at all, and it is matched by
  // string. A prefix that drifts is a notification with no buttons on it and
  // nothing anywhere saying why.
  for (const [platform, path] of SURFACES) {
    assert.match(
      read(path),
      new RegExp(`categoryPrefix[^\\n]*"${PROMPT_CATEGORY.replace('.', '\\.')}"`),
      `${platform} listens for a category the coordinator does not send`,
    );
  }
});

test('a slot id is the same letter on every surface and on the wire', () => {
  // `answers` arrives as `a:1,b:3`. The letters are the contract between the
  // host's resolution and the app's buttons, and they are three characters that
  // nothing would notice going wrong until a button typed the other answer.
  for (const [platform, path] of SURFACES) {
    const source = read(path);
    assert.match(source, /slotA[^\n]*"fleet\.answer\.a"/, `${platform} names the first button something else`);
    assert.match(source, /slotB[^\n]*"fleet\.answer\.b"/, `${platform} names the second button something else`);
  }
  assert.deepEqual(
    [...new Set(Object.values(ANSWER_TITLES).flatMap((t) => Object.keys(t)))].sort(),
    ['a', 'b'],
    'the fleet writes a slot the apps have no button for',
  );
});

test('the words fit on a lock screen and say what they do', () => {
  // A truncated button is a button somebody has to guess at, and guessing is
  // the thing this whole surface exists to remove (docs/psychology.md §2).
  // Nothing generic either: "Yes" and "OK" are answers to a question you can
  // still see, and the person reading this cannot.
  for (const [kind, titles] of Object.entries(ANSWER_TITLES)) {
    for (const [slot, title] of Object.entries(titles)) {
      assert.ok(title.length <= 24, `${kind}.${slot} is "${title}", too long for a notification action`);
      assert.doesNotMatch(title, /^(yes|no|ok|cancel|confirm)$/i, `${kind}.${slot} is a generic "${title}"`);
    }
  }
});
