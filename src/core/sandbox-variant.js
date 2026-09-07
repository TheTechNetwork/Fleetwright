// WHICH IMAGE A SESSION RUNS IN, and where that answer lives.
//
// There are two published images and the difference is Chromium: the default is
// small and has no browser, and `:web` is the same thing with one. Choosing
// between them used to mean editing AGENT_HUB_SANDBOX_IMAGE in a root-owned
// file and restarting the service — which is to say it was not a choice anybody
// with a phone could make, which is the same shape src/core/channel.js exists
// to fix. This file is that file's sibling, deliberately: same storage, same
// env-wins rule, same refuse-rather-than-lie behaviour.
//
// WHY A VARIANT AND NOT AN IMAGE NAME. The obvious API is "set the image", and
// it is the wrong one. A verb that takes an arbitrary image reference lets a
// coordinator name any registry on the internet and have this box pull it and
// run a session's credentials inside it — the `reply { text }` argument again,
// where a fixed verb set stops bounding anything the moment one of its verbs
// takes a free-form string. This one can express exactly two states, and both
// of them are tags on the repository this box was already configured with.
//
// A PER-SESSION CHOICE IS A PER-HOST CHOICE ROUTED TO. `start` gains no
// parameter here, because adding a param to an existing verb is a flag day
// (docs/intents.md) while adding a verb is free. Asking for a browser is
// therefore `tag: browser` in the envelope, beside the intent rather than
// inside it — the auto-label in src/fleet/host/auto-labels.js puts `browser` on
// exactly the hosts whose variant is the web one, so routing by that tag lands
// a session on a box that has one. And because the envelope also carries `host`
// and `tag`, "this host's default" and "every host labelled X's default" need
// no new mechanism at all: they are this verb fanned out by a field that
// already exists.

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/**
 * The only two answers, in the order a person would meet them.
 *
 * `minimal` is what a box gets by saying nothing, and stays the default on
 * purpose: the browser layer is ~400MB that most sessions never open, and a
 * default nobody chose should be the cheap one.
 */
export const VARIANTS = Object.freeze(['minimal', 'browser']);

/** The tag each variant means. `minimal` is the repository's own default tag. */
const TAGS = Object.freeze({ minimal: 'latest', browser: 'web' });

/** @param {import('../config.js').Config} cfg */
function variantFile(cfg) {
  return path.join(cfg.stateDir, 'sandbox-variant');
}

/**
 * Split an image reference into the part before the tag and the tag.
 *
 * DIGESTS ARE LEFT ALONE. `repo@sha256:…` names one exact image and swapping a
 * tag into it would silently run something else; a box pinned to a digest has
 * said something deliberate and gets `null` here, which the caller reads as
 * "this box's image is not ours to re-tag".
 *
 * @param {string} ref
 * @returns {{ repo: string, tag: string }|null}
 */
function split(ref) {
  const s = String(ref || '');
  if (s.includes('@')) return null;
  // The last colon, and only if no `/` follows it — `localhost:5000/img` is a
  // registry port and not a tag, and treating it as one would rewrite the host.
  const i = s.lastIndexOf(':');
  if (i < 0 || s.slice(i + 1).includes('/')) return { repo: s, tag: '' };
  return { repo: s.slice(0, i), tag: s.slice(i + 1) };
}

/**
 * The image reference for a variant on this box.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} variant
 * @returns {string|null} null when this box's image cannot be re-tagged
 */
export function imageFor(cfg, variant) {
  const tag = TAGS[/** @type {keyof typeof TAGS} */ (variant)];
  if (!tag) return null;
  const parts = split(cfg.sandboxImage);
  if (!parts || !parts.tag) return null;
  return `${parts.repo}:${tag}`;
}

/**
 * Which variant an image reference IS, or null if it is neither of ours.
 *
 * A TAG WE PUBLISH IS A CLAIM WE MAKE, and any other tag is `null` rather than
 * rounded to minimal. `:latest` off our Containerfile with the browser layer
 * switched off IS the minimal variant, whoever built it and wherever it lives,
 * which is why a local build answers rather than falling into "custom". A tag
 * we have never published says nothing about whether Chromium is in there, and
 * answering "minimal" would be a screen reporting a state it cannot know.
 *
 * Read off the tag rather than by searching the whole string for "web", because
 * `ghcr.io/x/webhooks-runner:latest` is not a browser and a session that needs
 * Chromium must not be told it has one. Same rule as auto-labels.js, and the
 * two agree by construction because this is where that answer comes from.
 *
 * @param {string} ref
 */
export function variantOf(ref) {
  const parts = split(ref);
  if (!parts) return null;
  for (const [name, tag] of Object.entries(TAGS)) if (parts.tag === tag) return name;
  return null;
}

/**
 * Whether the environment is naming the image outright, and so overriding this.
 *
 * @param {import('../config.js').Config} cfg
 */
export function pinnedByEnv(cfg) {
  return Boolean(cfg.sandboxImagePinned);
}

/**
 * Which variant this box runs sessions in.
 *
 * Read at the moment it is needed rather than cached at startup, because the
 * whole point is that it changes without a restart.
 *
 * @param {import('../config.js').Config} cfg
 * @returns {'minimal'|'browser'|'custom'}
 */
export function readVariant(cfg) {
  // AN IMAGE SOMEBODY NAMED WINS, and is reported as what it is. A box pointed
  // at `localhost/my-session:latest` is on neither variant, and answering
  // "minimal" because that is the fallback would be this repository's oldest
  // bug: a value that cannot tell "something else" from "the default".
  if (pinnedByEnv(cfg)) return /** @type {any} */ (variantOf(cfg.sandboxImage) ?? 'custom');
  // A caller with no state directory is asking about a configuration rather
  // than about a running box — auto-labels does this in tests. Said out loud,
  // because the alternative was a TypeError from path.join swallowed by the
  // catch below, which happens to give the right answer for the wrong reason
  // and would stop doing so the first time somebody moved a line.
  if (!cfg.stateDir) return /** @type {any} */ (variantOf(cfg.sandboxImage) ?? 'custom');
  try {
    const stored = String(readFileSync(variantFile(cfg), 'utf8')).trim().toLowerCase();
    if (VARIANTS.includes(stored)) return /** @type {any} */ (stored);
  } catch {
    // No file is the ordinary case and means minimal, which is what a box that
    // has never been asked should be running.
  }
  return /** @type {any} */ (variantOf(cfg.sandboxImage) ?? 'custom');
}

/**
 * The image a session on this box should run in, right now.
 *
 * EVERY PLACE THAT RUNS, BUILDS, PULLS OR INSPECTS THE SESSION IMAGE GOES
 * THROUGH HERE. A site left reading `cfg.sandboxImage` would build one image
 * and run another — true where it was written, quietly false one layer up,
 * which is the failure this repository keeps paying for. There is a tripwire
 * test for exactly that, in test/sandbox-variant.test.js.
 *
 * @param {import('../config.js').Config} cfg
 */
export function sessionImage(cfg) {
  if (pinnedByEnv(cfg)) return cfg.sandboxImage;
  const wanted = readVariant(cfg);
  return imageFor(cfg, wanted) ?? cfg.sandboxImage;
}

/**
 * Put this box on a variant.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} value
 * @returns {{ ok: boolean, variant?: string, image?: string, message: string }}
 */
export function writeVariant(cfg, value) {
  const wanted = String(value || '').trim().toLowerCase();
  if (!VARIANTS.includes(wanted)) {
    return { ok: false, message: `"${String(value).slice(0, 30)}" is not a sandbox variant. It is one of: ${VARIANTS.join(', ')}.` };
  }
  // REFUSED RATHER THAN OVERRIDDEN, for the same reason as the release channel:
  // writing a file the next read ignores would show one image in the app while
  // the box ran another, and nothing anywhere would say so.
  if (pinnedByEnv(cfg)) {
    return {
      ok: false,
      message:
        `AGENT_HUB_SANDBOX_IMAGE is set to "${cfg.sandboxImage}" in this box's environment, ` +
        'which wins over anything set here.\n' +
        'Remove it from /etc/agent-hub.env and restart if you want to choose the variant from the app.',
    };
  }
  const image = imageFor(cfg, wanted);
  if (!image) {
    return {
      ok: false,
      message:
        `this box's sandbox image is "${cfg.sandboxImage}", which has no tag to swap — ` +
        'a digest names one exact image, and changing it here would run something else.',
    };
  }

  const file = variantFile(cfg);
  const tmp = `${file}.tmp`;
  try {
    // Written and renamed, so a box that loses power mid-write has either the
    // old variant or the new one and never half a word.
    writeFileSync(tmp, `${wanted}\n`, { mode: 0o644 });
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return { ok: false, message: `could not write ${file}: ${/** @type {Error} */ (e).message}` };
  }
  return {
    ok: true,
    variant: wanted,
    image,
    message:
      wanted === 'browser'
        ? `New sessions on this box run in ${image}, which has Chromium. Running sessions keep the image they started in.`
        : `New sessions on this box run in ${image}, which has no browser. Running sessions keep the image they started in.`,
  };
}
