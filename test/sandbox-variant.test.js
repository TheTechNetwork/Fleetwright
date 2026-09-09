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

test('an image in the environment that is not one of ours refuses rather than being overridden', () => {
  // Writing a file the next read ignores would show one image in the app while
  // the box ran another, and nothing anywhere would say so.
  const cfg = box({ sandboxImage: 'localhost/mine:latest', sandboxImagePinned: true });
  assert.equal(pinnedByEnv(cfg), true);
  const r = writeVariant(cfg, 'browser');
  assert.equal(r.ok, false);
  assert.match(r.message, /AGENT_HUB_SANDBOX_IMAGE names/);
  assert.match(r.message, /\/etc\/agent-hub\.env/);
  assert.equal(sessionImage(cfg), 'localhost/mine:latest');
});

test('an image in the environment that IS one of ours is a starting point, not a pin', () => {
  // THE BUG A PERSON HIT. install.sh wrote AGENT_HUB_SANDBOX_IMAGE on every
  // install, set to the default, and the old rule read any named image as a
  // decision — so the picker on both phones answered "set on the box, remove
  // it from /etc/agent-hub.env" on every box the installer had ever made. A
  // named image that is one of our tags is the variant the box starts on;
  // the stored word wins once somebody chooses.
  const cfg = box({ sandboxImage: GHCR, sandboxImagePinned: true });
  assert.equal(pinnedByEnv(cfg), false);
  assert.equal(readVariant(cfg), 'minimal', 'the env tag is the answer until somebody chooses');
  const r = writeVariant(cfg, 'browser');
  assert.equal(r.ok, true, r.message);
  assert.equal(readVariant(cfg), 'browser');
  assert.equal(sessionImage(cfg), GHCR.replace(/:latest$/, ':web'));

  // Starting on the browser tag works the same way round.
  const web = box({ sandboxImage: GHCR.replace(/:latest$/, ':web'), sandboxImagePinned: true });
  assert.equal(readVariant(web), 'browser');
  assert.equal(writeVariant(web, 'minimal').ok, true);
  assert.equal(sessionImage(web), GHCR);

  // A localhost build off our Containerfile is minimal, and still not
  // switchable: the other tag was never built.
  const local = box({ sandboxImage: 'localhost/agent-session:latest', sandboxImagePinned: true });
  assert.equal(readVariant(local), 'minimal');
  assert.equal(pinnedByEnv(local), true);
  assert.equal(writeVariant(local, 'browser').ok, false);
});

test('the installer does not write the default image into the env file', () => {
  // The other half of the bug above. A default the code already derives has
  // no business in a root-owned file, because the moment it is there it reads
  // as something somebody chose.
  const sh = readFileSync(new URL('../install/install.sh', import.meta.url), 'utf8');
  const pulled = sh.slice(sh.indexOf('ok "pulled $IMAGE"'), sh.indexOf('IMAGE=""', sh.indexOf('ok "pulled $IMAGE"')));
  assert.match(pulled, /if \[ -n "\$\{AGENT_HUB_SANDBOX_IMAGE:-\}" \]; then\s+set_env "\$ENV_FILE" AGENT_HUB_SANDBOX_IMAGE/, 'a named image is kept');
  assert.match(pulled, /AGENT_HUB_SANDBOX_IMAGE_OWNER "\$IMAGE_OWNER"/, 'an owner is kept as the owner');
  const lines = pulled.split('\n');
  const writes = lines.map((l, i) => [l, i]).filter(([l]) => /set_env "\$ENV_FILE" AGENT_HUB_SANDBOX_IMAGE "\$IMAGE"/.test(String(l)));
  assert.equal(writes.length, 1, 'one write of the full image, and only one');
  assert.match(String(lines[Number(writes[0][1]) - 1]), /if \[ -n "\$\{AGENT_HUB_SANDBOX_IMAGE:-\}" \]/, 'and it is guarded by whether a person named one');
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
