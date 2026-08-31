import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Read rather than run. This tool talks to Play and nothing else, so there is
// no seam to test through — but the two things that go wrong here are both
// visible in the source, and both fail in the worst possible place: at the
// commit call, after the bundle has already uploaded, on a track somebody is
// watching.
const SRC = readFileSync(new URL('../tools/play-release.mjs', import.meta.url), 'utf8');

test('status and userFraction move together', () => {
  // Play rejects userFraction on a completed release and rejects an inProgress
  // one without it. They are one decision expressed as two fields, so the
  // failure mode is a reasonable-looking edit that 400s at the end.
  assert.match(SRC, /status: 'inProgress', userFraction: ROLLOUT/);
  assert.match(SRC, /\{ status: 'completed' \}/);
  // Never both. A conditional that emitted userFraction alongside completed
  // would read fine and be refused.
  assert.equal(/userFraction[^}]*status: 'completed'/.test(SRC), false);
});

test('an unset rollout ships the whole track', () => {
  // The dangerous default is the other way round: a staged rollout has to be
  // finished by hand in the console, so defaulting to one leaves every release
  // permanently half-shipped by a pipeline that reported success.
  assert.match(SRC, /if \(!raw\) return null;/);
  assert.match(SRC, /return f === 1 \? null : f;/);
});

test('a nonsense rollout is refused rather than sent', () => {
  // 10 meaning "10 percent" would otherwise be sent as 1000% and rejected by
  // Play with a message about the edit, not about the variable.
  assert.match(SRC, /f <= 0 \|\| f > 1/);
  assert.match(SRC, /PLAY_ROLLOUT must be a fraction/);
});
