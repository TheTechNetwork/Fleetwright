// Is there a release waiting for this box, asked on a timer rather than when
// somebody looks.
//
// THE GAP THIS CLOSES. `updateAvailable` answers "how many commits behind" by
// running git, which a packaged box does not have — `updateStatus` returns
// `packaged: true` and no number. So a released host reported `appBehind: null`
// for ever, both phones read null as CANNOT TELL and showed nothing, and the
// only way to find out whether an update existed was to type `/update` and
// read the answer. The release pipeline was complete and nothing was looking at
// it.
//
// IT REUSES applyRelease's DRY RUN rather than re-implementing the decision.
// That matters more than the saved lines: the question "is there one waiting"
// and the question "may I install it" have to be answered by the same code, or
// a box says an update is available and then refuses to take it — protocol
// mismatch, wrong channel, not yet in the rollout. One path, one answer.

import { applyRelease } from './release-apply.js';
import { readChannel } from './channel.js';
import { manifestUrlFor } from './release.js';
import { PROTOCOL_VERSION } from '../fleet/protocol/intents.js';

/**
 * What the last check found.
 *
 * @typedef {object} ReleaseCheck
 * @property {string|null} available the version waiting, or null for none
 * @property {string} message        the host's own sentence about it
 * @property {boolean} configured    whether this box knows where to look
 * @property {boolean} ok            whether the CHECK ITSELF got an answer
 * @property {string} [reason]       which decision rule fired, when one did —
 *   'protocol' (a newer release this host cannot take yet), 'current', and so
 *   on. Absent when the check could not decide at all. Lets a caller render
 *   "up to date to a compatible version" as a state rather than a sentence.
 *
 * `ok` is the field that separates "asked, and nothing is waiting" from
 * "could not ask". Both of those are `available: null`, and until this existed
 * the only thing telling them apart was the wording of `message` — so the
 * caller that had to know sniffed it for the words "could not check", and a
 * refusal phrased any other way was read as "up to date". `applyRelease`
 * already draws the line (`ok: false` for a layout it cannot swap, a manifest
 * that answered 404, a protocol it does not speak); this carries that answer
 * out instead of throwing it away and guessing it back.
 */

/**
 * Ask, without downloading anything.
 *
 * Never throws. A box that cannot reach GitHub still runs sessions perfectly
 * well, and a check that took the process down with it would turn "offline"
 * into "broken".
 *
 * @param {import('../config.js').Config} cfg
 * @param {{ fetch?: typeof fetch }} [opts]
 * @returns {Promise<ReleaseCheck>}
 */
export async function checkRelease(cfg, { fetch: doFetch = fetch } = {}) {
  if (!cfg.releaseManifest) {
    // NOT SILENCE. Every box installed before the installer learned to write
    // this is in exactly this state, and a screen that shows nothing cannot be
    // told apart from one that has checked and found nothing waiting.
    return {
      available: null,
      configured: false,
      // Not an answer about releases, so not `ok`. Nothing was asked.
      ok: false,
      message:
        'This box does not know where its releases come from, so it cannot check for updates.\n' +
        'Set AGENT_HUB_RELEASE_MANIFEST in /etc/agent-hub.env, or re-run the installer with --upgrade.',
    };
  }

  const channel = readChannel(cfg);
  const target = manifestUrlFor(cfg.releaseManifest, channel);
  try {
    const r = await applyRelease({
      installDir: cfg.installDir,
      manifestUrl: target.url,
      protocol: PROTOCOL_VERSION,
      channel,
      // The hostname, for the same reason /update passes it: a staged rollout
      // needs a name that is stable per machine and nothing more.
      hostKey: cfg.hostname,
      dryRun: true,
      fetch: doFetch,
    });
    // `changed` is always false on a dry run, so the version field is what says
    // whether there is one — and it is only set when the decision was to act.
    // `r.ok` IS THE HALF THAT USED TO BE DROPPED. applyRelease answers false
    // for every state where it could not even decide — a box unpacked by hand
    // with no `current` symlink to swap, a manifest that answered 404, a
    // release built for a protocol this box does not speak — and true both for
    // "here is one" and for "you are current". Keeping only `version` collapsed
    // the first group into the second.
    return { available: r.version ?? null, configured: true, ok: r.ok, reason: r.reason, message: r.message };
  } catch (e) {
    return {
      available: null,
      configured: true,
      ok: false,
      message: `could not check for a release: ${/** @type {Error} */ (e).message}`,
    };
  }
}
