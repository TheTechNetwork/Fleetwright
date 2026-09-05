// What fraction of the fleet a release is for.
//
// SPLIT OUT SO IT CAN BE TESTED, for the same reason scripts/coverage-verdict.mjs
// is: build-host-package.mjs builds a package as its first act, so importing it
// from a test bundles the whole project as a side effect. A rule with no test of
// its own is how this one shipped wrong in every release the project has made.

/**
 * @param {string|undefined} raw the RELEASE_ROLLOUT repository variable
 * @returns {number} 0–1
 */
export function rolloutFraction(raw) {
  // ABSENT, EMPTY AND UNPARSEABLE ALL MEAN EVERYBODY.
  //
  // The line this replaces was `Number(process.env.RELEASE_ROLLOUT ?? 1) || 0`.
  // `?? 1` was written for an absent variable, and the workflow passes
  // `${{ vars.RELEASE_ROLLOUT }}` — an unset repository variable expands to the
  // EMPTY STRING, which is present, so `??` never fired. `Number('')` is 0 and
  // `|| 0` kept it there.
  //
  // Every manifest this project has ever published said `rollout: 0`, which
  // decideRelease reads as "this release goes to nobody". v0.2.2, v0.2.3 and
  // every rolling build were unreachable by the update path that exists to
  // install them, and nothing said so: a host asking got "not in that group
  // yet", which is a sentence about a rollout somebody chose.
  const text = String(raw ?? '').trim();
  if (text === '') return 1;
  const n = Number(text);
  // FAILING OPEN IS DELIBERATE. A typo in a repository variable should not
  // quietly stop a fleet updating — that is the failure this replaces, and it
  // was silent and total. docs/packaging.md already states the rule: "a rollout
  // nobody configured must not hold a fleet back."
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}
