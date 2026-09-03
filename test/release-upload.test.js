// The release artifacts have to actually reach the release.
//
// `host-release.yml` builds a host tarball and a manifest on every push, and
// attaches them when a release is published. The build has been green for
// weeks. The attach failed on v0.2.0 with
//
//   failed to run git: fatal: not a git repository
//
// because that job deliberately does not check the repository out — it
// downloads an artifact and uploads it — and `gh` works out which repository it
// means from the git remote. So no release carries a host tarball or a
// manifest, `/update` by manifest has nothing to point at, and the installer
// cannot fetch a package. One missing environment variable held up the whole
// packaging plan, with a green job sitting above it.
//
// Nothing else in this repository could have caught that: the workflow parses,
// the shell is valid, and the failure only exists when a release is published.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const YML = readFileSync(new URL('../.github/workflows/host-release.yml', import.meta.url), 'utf8');

test('every gh call knows which repository it means', () => {
  // Either a checkout or GH_REPO. Asserted per STEP rather than per file,
  // because a second `gh` step added later inherits neither by accident.
  const steps = YML.split(/^      - /m).slice(1);
  for (const step of steps) {
    if (!/\bgh \w/.test(step)) continue;
    const named = /GH_REPO:/.test(step) || /--repo\b/.test(step);
    assert.ok(named, `a gh step has no repository context:\n${step.split('\n')[0]}`);
    // And a token, or it is authenticated as nobody.
    assert.ok(/GH_TOKEN:/.test(step), `a gh step has no token:\n${step.split('\n')[0]}`);
  }
});

test('the attach job uploads both artifacts a package install needs', () => {
  // A tarball with no manifest is a file nobody can verify or discover; a
  // manifest with no tarball is a promise of something absent. Both, or the
  // release is not one a box can install from.
  assert.match(YML, /gh release upload[^\n]*\.tar\.gz[^\n]*manifest\.json/);
  // --clobber, so re-running a release does not fail on the artifact it
  // uploaded last time.
  assert.match(YML, /--clobber/);
});

test('it only asks for write permission on the job that writes', () => {
  // The file argues this at length and it is worth keeping: a workflow that
  // holds contents: write for the whole run has that permission during the
  // build, which is where untrusted input would arrive.
  assert.match(YML, /^permissions:\n  contents: read$/m, 'the workflow-level permission is not read-only');
  const attach = YML.slice(YML.indexOf('  attach:'));
  assert.match(attach, /permissions:\n      contents: write/);
  assert.match(attach, /if: github\.event_name == 'release'/);
});
