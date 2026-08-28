// Delivering a build to testers, and the one call that must not be made.
//
// The upload worked, the build processed, App Store Connect reported it VALID
// and in front of the internal testers — and the job went red on the step
// after, with a sentence that reads like a permissions problem:
//
//   POST /v1/betaGroups/<id>/relationships/builds → 422
//     Builds cannot be assigned to this internal group.:
//     Cannot add internal group to a build.
//
// It is a correct rule described confusingly. An internal group receives every
// build automatically; asking for that is describing work that has already
// happened. External is the opposite — nothing reaches anybody until the build
// is given to the group and Apple has reviewed it.
//
// The two audiences are genuinely different deliveries, which is exactly why
// one script serving both needs this pinned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../tools/testflight-distribute.mjs', import.meta.url), 'utf8');

test('an internal audience never posts a build assignment', () => {
  // The guard has to come BEFORE the POST, not around it — an early return is
  // what makes the call unreachable rather than merely conditional.
  const guard = SRC.indexOf('if (IS_INTERNAL) {');
  // The CALL, not the comment that quotes the failing URL. Searching for the
  // bare path found the explanation above the fix and reported the ordering
  // backwards, which is a fair warning about grepping source for behaviour.
  const post = SRC.indexOf('await api(`/v1/betaGroups/${group.id}/relationships/builds`');
  assert.ok(guard > 0, 'the internal early-return is gone');
  assert.ok(post > 0, 'the external assignment is gone');
  assert.ok(guard < post, 'internal must return before the assignment, not after it');

  // And the return is a real one, inside the guard.
  const block = SRC.slice(guard, post);
  assert.match(block, /\breturn\b/);
});

test('the external path still assigns and still submits for review', () => {
  // The half that must keep working. External testers see nothing without
  // both of these, and a fix for internal that quietly disabled them would
  // look like success on every run.
  assert.match(SRC, /relationships\/builds/);
  assert.match(SRC, /betaAppReviewSubmissions/);
});

test('the group is still looked up for both audiences', () => {
  // Failing loudly when the group named in the workflow does not exist is
  // still worth doing — that is a typo somebody should hear about, and it is
  // separate from whether a build gets assigned to it.
  assert.match(SRC, /isInternalGroup/);
  assert.match(SRC, /no \$\{AUDIENCE\} group named/);
});

test('the 422 that caused this is written down where it will be read', () => {
  // The message is the confusing part, so it lives next to the code that
  // reacts to it rather than in a commit nobody re-reads.
  assert.match(SRC, /Cannot add internal group to a build/);
});
