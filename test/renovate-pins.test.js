// What Renovate reads outside its built-in managers, each a pin somebody
// would otherwise have to remember: the Node and the JDK every workflow sets
// up, images a workflow runs, the iOS app's Swift packages, and the sandbox's
// Node line. Each custom manager has to find exactly the lines it is for, or
// the pin stops moving and nothing says so.
//
//   node --test test/renovate-pins.test.js
//
// ASKED FOR: "Ensure anything we download is in renovate following our
// renovate policies". The images and the installer have tests of their own:
// test/pin-images.test.js, pin-xo-installer.test.js, pin-guest-agent.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const config = JSON.parse(read('renovate.json'));
const WORKFLOWS = readdirSync(new URL('../.github/workflows/', import.meta.url)).filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`);

/** Every match Renovate's custom managers find in one file, with the manager's templates. @param {string} file */
function found(file) {
  const source = read(file);
  return config.customManagers
    .filter((/** @type {any} */ m) => m.managerFilePatterns.some((/** @type {string} */ p) => new RegExp(p.slice(1, -1)).test(file)))
    .flatMap((/** @type {any} */ m) => m.matchStrings.flatMap((/** @type {string} */ r) => [...source.matchAll(new RegExp(r, 'g'))].map((x) => ({
      datasource: x.groups?.datasource ?? m.datasourceTemplate,
      depName: x.groups?.depName ?? m.depNameTemplate,
      currentValue: x.groups?.currentValue,
    }))));
}

test('every exact node-version a workflow sets up is Renovate’s to move', () => {
  for (const file of WORKFLOWS) {
    const written = [...read(file).matchAll(/node-version: '(\d+\.\d+\.\d+)'/g)].map((m) => m[1]);
    const seen = found(file).filter((d) => d.datasource === 'node-version').map((d) => d.currentValue);
    assert.deepEqual(seen, written, file);
  }
  assert.ok(WORKFLOWS.some((f) => found(f).some((d) => d.datasource === 'node-version')), 'no workflow pin is read at all');
});

test('every java-version a workflow sets up is Renovate’s to move', () => {
  for (const file of WORKFLOWS) {
    const written = [...read(file).matchAll(/java-version: '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(found(file).filter((d) => d.datasource === 'java-version').map((d) => d.currentValue), written, file);
  }
});

test('an image a workflow runs is named by number, and Renovate reads it', () => {
  // A codename (bookworm) is a tag Renovate cannot move to the next release.
  for (const file of WORKFLOWS) {
    for (const m of read(file).matchAll(/docker run [^\n]*?\s(debian):([A-Za-z0-9._-]+)\s/g)) {
      assert.match(m[2], /^\d/, `${file}: debian:${m[2]} is a codename`);
    }
  }
  const images = WORKFLOWS.flatMap((f) => found(f).filter((d) => d.datasource === 'docker'));
  assert.ok(images.length >= 2, 'the installer and deb checks run images Renovate does not see');
  assert.doesNotMatch(read('worker/Containerfile'), /FROM \S+:bookworm/, 'the dockerfile manager cannot move a codename either');
});

test('every `# renovate:` comment in a workflow is read by a manager', () => {
  // mac-host.yml carried one for Claude Code that nothing read, and sat
  // thirteen releases behind the image it is meant to match.
  for (const file of WORKFLOWS) {
    const comments = (read(file).match(/# renovate: /g) ?? []).length;
    const annotated = found(file).filter((d) => d.datasource !== 'node-version' && d.datasource !== 'java-version' && d.datasource !== 'docker');
    assert.equal(annotated.length, comments, `${file}: ${comments} renovate comments, ${annotated.length} read`);
  }
});

test('the iOS app’s Swift packages and the sandbox’s Node line are read where they are written', () => {
  assert.deepEqual(found('apps/ios/project.yml'), [{ datasource: 'github-releases', depName: 'getsentry/sentry-cocoa', currentValue: /exactVersion: (\S+)/.exec(read('apps/ios/project.yml'))?.[1] }]);
  const node = found('sandbox/Containerfile').filter((d) => d.depName === 'node-major');
  assert.deepEqual(node, [{ datasource: 'node-version', depName: 'node-major', currentValue: /ARG NODE_MAJOR=(\d+)/.exec(read('sandbox/Containerfile'))?.[1] }]);
  const rule = config.packageRules.find((/** @type {any} */ r) => r.matchDepNames?.includes('node-major'));
  assert.equal(rule.allowedVersions, '/^\\d*[02468]$/', 'LTS lines only');
});

test('the Gradle wrapper is checked against Gradle’s published digest, which Renovate moves with it', () => {
  assert.match(read('apps/android/gradle/wrapper/gradle-wrapper.properties'), /^distributionSha256Sum=[0-9a-f]{64}$/m);
});
