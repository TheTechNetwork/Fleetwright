import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VARIANTS, imageFor, variantOf, readVariant, writeVariant, sessionImage, pinnedByEnv,
} from '../src/core/sandbox-variant.js';

const GHCR = 'ghcr.io/thetechnetwork/fleetwright-session:latest';
const box = (over = {}) => ({ stateDir: mkdtempSync(path.join(tmpdir(), 'variant-')), sandboxImage: GHCR, sandboxImagePinned: false, ...over });

test('a box that has never been asked runs the image with no browser', () => {
  const cfg = box();
  assert.equal(readVariant(cfg), 'minimal');
  assert.equal(sessionImage(cfg), GHCR);
});

test('choosing the browser variant swaps the tag and nothing else', () => {
  const cfg = box();
  const r = writeVariant(cfg, 'browser');
  assert.equal(r.ok, true);
  assert.equal(r.image, 'ghcr.io/thetechnetwork/fleetwright-session:web');
  // AND IT SURVIVES THE PROCESS. The whole point of the state directory over
  // the env file is that the answer outlives the command that set it.
  assert.equal(readVariant(cfg), 'browser');
  assert.equal(sessionImage(cfg), 'ghcr.io/thetechnetwork/fleetwright-session:web');
});

test('the repository is preserved, so a fork stays on its own registry', () => {
  // AGENT_HUB_SANDBOX_IMAGE_OWNER exists because a fork's CI published an image
  // nothing pulled. Hard-coding our repository in the browser tag would have
  // reintroduced that exact bug in one line, and only for the browser variant —
  // so a fork's minimal sessions would be theirs and its browser sessions ours.
  const cfg = box({ sandboxImage: 'ghcr.io/someone-else/fleetwright-session:latest' });
  assert.equal(writeVariant(cfg, 'browser').image, 'ghcr.io/someone-else/fleetwright-session:web');
});

test('a registry port is not mistaken for a tag', () => {
  // `localhost:5000/img` has a colon that is a PORT. Splitting on the last
  // colon without checking for a following slash would rewrite the registry
  // host and pull from somewhere that does not exist.
  assert.equal(imageFor(box({ sandboxImage: 'localhost:5000/agent-session:latest' }), 'browser'),
    'localhost:5000/agent-session:web');
  // And an image with no tag at all cannot be re-tagged blind: `repo` means
  // `repo:latest` to podman, but writing `repo:web` for a box that never said
  // it had a web image is inventing one.
  assert.equal(imageFor(box({ sandboxImage: 'localhost:5000/agent-session' }), 'browser'), null);
});

test('a digest is left exactly alone', () => {
  // `repo@sha256:…` names ONE image. Swapping a tag into it would run something
  // else entirely while the caller believed it had changed a setting.
  const cfg = box({ sandboxImage: 'ghcr.io/x/session@sha256:' + 'a'.repeat(64) });
  assert.equal(imageFor(cfg, 'browser'), null);
  const r = writeVariant(cfg, 'browser');
  assert.equal(r.ok, false);
  assert.match(r.message, /digest names one exact image/);
  assert.equal(sessionImage(cfg), cfg.sandboxImage);
});

test('an image named in the environment refuses rather than being overridden', () => {
  // The channel's rule, for the same reason: writing a file the next read
  // ignores would show one image in the app while the box ran another, and
  // nothing anywhere would say so.
  const cfg = box({ sandboxImage: 'localhost/mine:latest', sandboxImagePinned: true });
  assert.equal(pinnedByEnv(cfg), true);
  const r = writeVariant(cfg, 'browser');
  assert.equal(r.ok, false);
  assert.match(r.message, /AGENT_HUB_SANDBOX_IMAGE is set/);
  assert.match(r.message, /\/etc\/agent-hub\.env/);
  assert.equal(sessionImage(cfg), 'localhost/mine:latest');
});

test('an image that is neither variant is reported as neither', () => {
  // NOT ROUNDED TO THE DEFAULT. A value that cannot tell "something else" from
  // "the default" is this repository's most-repeated bug, and here it would
  // have told somebody their custom image has no browser when it might.
  assert.equal(variantOf('localhost/mine:dev'), null);
  assert.equal(readVariant(box({ sandboxImage: 'localhost/mine:dev', sandboxImagePinned: true })), 'custom');
  // `:latest` IS a claim we make, and it is the one this convention exists for
  // — `podman build -t localhost/agent-session:latest` off our Containerfile
  // with the browser layer off is exactly the minimal variant, and that is the
  // documented way to build locally.
  assert.equal(variantOf('localhost/agent-session:latest'), 'minimal');
});

test('webhooks-runner is not a browser', () => {
  // Matched on the TAG, never on "web" appearing somewhere in the name. The
  // consequence of getting this wrong is a session routed to a box that has no
  // Chromium, with the label saying it does.
  assert.equal(variantOf('ghcr.io/x/webhooks-runner:latest'), 'minimal');
  assert.equal(variantOf('ghcr.io/x/session:web'), 'browser');
});

test('a value that is not a variant is refused and lists what is', () => {
  const r = writeVariant(box(), 'chrome');
  assert.equal(r.ok, false);
  assert.match(r.message, /minimal, browser/);
});

test('a half-written file cannot be left behind by a power cut', () => {
  const cfg = box();
  writeVariant(cfg, 'browser');
  // Written to a temp name and renamed, so what is on disk is always a whole
  // word. The temp file must not survive either.
  assert.deepEqual(readdirSync(cfg.stateDir), ['sandbox-variant']);
  assert.equal(readFileSync(path.join(cfg.stateDir, 'sandbox-variant'), 'utf8'), 'browser\n');
  assert.equal(statSync(path.join(cfg.stateDir, 'sandbox-variant')).mode & 0o777, 0o644);
});

test('a stored word that is not a variant is ignored, not trusted', () => {
  // Somebody editing the file by hand, or a partial write from an older shape.
  const cfg = box();
  writeFileSync(path.join(cfg.stateDir, 'sandbox-variant'), 'chromium\n');
  assert.equal(readVariant(cfg), 'minimal');
});

test('VARIANTS and the verb agree, because the app renders one from the other', async () => {
  const { VERBS } = await import('../src/fleet/protocol/intents.js');
  assert.deepEqual(VERBS.sandbox.params.to.values, [...VARIANTS]);
});

// THE TRIPWIRE. Every place that runs, builds, pulls or inspects the session
// image must resolve the variant; a site left reading the static config would
// build one image and run another, which is exactly the "true where it was
// written, quietly false one layer up" shape this repository keeps paying for.
//
// Comments are stripped before the search, because three tests in this
// repository have now fired on the prose explaining why something was removed.
test('nothing runs the configured image where it should resolve the variant', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  // The ones allowed to see it: where it is DEFINED, where it is RE-TAGGED, and
  // the release manifest's own type declaration.
  const allowed = new Set(['config.js', 'core/sandbox-variant.js', 'core/release.js']);
  const offenders = [];
  const walk = (dir, prefix = '') => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), rel); continue; }
      if (!e.name.endsWith('.js') || allowed.has(rel)) continue;
      const code = readFileSync(path.join(dir, e.name), 'utf8')
        .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
      if (code.includes('cfg.sandboxImage') || code.includes('config.sandboxImage')) offenders.push(rel);
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], `these read the configured image instead of resolving it: ${offenders.join(', ')}`);
});
