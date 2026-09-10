// House rules: how work is done on this box, on every turn of every session.
//
// A PROFILE AND THESE ARE NOT THE SAME THING, and the difference is what the
// cost is charged on. A profile is a session's first message — it is what the
// session was asked to do, it is paid for once, and picking the wrong one
// produces a session doing the wrong job, loudly. House rules are read on
// every turn forever, they are paid for on every turn forever, and picking the
// wrong ones produces a session doing the right job slightly worse, quietly.
//
// So the two are kept apart: profiles are a directory somebody chooses from by
// name, this is one file that either exists or does not.
//
// WHY IT IS NEEDED AT ALL. Claude Code reads `~/.claude/CLAUDE.md`. A
// sandboxed session's `~/.claude` is the fresh `claude-<name>` volume, which is
// seeded with credentials and nothing else on purpose — so a box whose owner
// had written house rules for their own shell had sessions that never saw one
// line of them. There was no way to fix that short of baking a file into the
// image, which is a rebuild per edit.
//
// THE RULE THIS OBEYS is the one docs/wanted.md set for profiles:
//
//     The coordinator may NAME a profile; it may never CARRY one.
//
// This needs even less than that. Nothing about house rules crosses the wire —
// no verb sets them, no field carries them, and not even a name is sent. The
// content lives in a file on the box that a person with a shell put there, and
// the whole of the fleet's involvement is reporting that it is there.
//
// WHETHER THIS HELPS IS NOT SETTLED, and this file is not the place that
// settles it. docs/wanted.md is blunt about it: always-on rules are the
// expensive kind of injection, "a 2,000-token house style is a 2,000-token tax
// on a one-line question", and nobody here has measured whether the tax buys
// anything. What this provides is the CAPABILITY and the number — the size is
// reported wherever the fact is, so somebody deciding can see what they are
// spending.

import { readFileSync, statSync } from 'node:fs';

/**
 * The most house rules a box may hand its sessions.
 *
 * Not a round number pulled out of the air. This is charged on every turn, so
 * the cap is set where the tax stops being background noise: 12,000 characters
 * is roughly 3,000 tokens, which is already several times what a careful
 * CLAUDE.md needs and is a real cost on a one-line question.
 *
 * A profile's cap (8,000, in profiles.js) is smaller and paid once. That these
 * two numbers are close and mean different things is worth knowing before
 * anybody "harmonises" them.
 */
export const RULES_MAX = 12_000;

/**
 * REFUSED, NOT TRUNCATED, past the cap — the opposite of what a profile does,
 * and the difference is not fussiness.
 *
 * A profile cut short is a shorter instruction: the session does less of what
 * was asked, and the person who reads the pane sees where it stopped. Rules cut
 * short are DIFFERENT RULES. Half of "never force-push, except on a branch you
 * created" is a licence. Truncation cannot be made safe here, so a file over
 * the cap is not used at all and says so, which somebody can act on.
 *
 * @typedef {object} HouseRules
 * @property {boolean} ok        whether sessions on this box will get them
 * @property {string|null} text  the content, when ok
 * @property {number} chars      what it costs, whether or not it is used
 * @property {string|null} why   why not, when not ok
 */

/**
 * What this box gives its sessions, if anything.
 *
 * NULL IS "THERE ARE NONE", which is the normal case and not a fault. Every
 * host worked this way until this existed.
 *
 * A file that is present and unusable is NOT null — it comes back with `ok:
 * false` and a reason, because "you wrote rules and they are being ignored" is
 * a thing somebody needs told. Silently treating an oversized or unreadable
 * file as an absent one is how a person spends an evening wondering why their
 * rules do nothing.
 *
 * @param {import('../config.js').Config} cfg
 * @returns {HouseRules|null}
 */
export function readHouseRules(cfg) {
  const file = cfg.rulesFile;
  if (!file) return null;

  /** @type {import('node:fs').Stats} */
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return null; // not there, which is the normal case
  }
  if (!stat.isFile()) {
    return { ok: false, text: null, chars: 0, why: `${file} is not a file` };
  }
  // Checked on the stat before the read, so an enormous file is refused
  // without being pulled into memory first. Bytes are not characters, but a
  // file whose BYTES exceed the cap cannot have fewer characters than the cap,
  // so this direction of the check is sound and the exact count comes below.
  if (stat.size > RULES_MAX) {
    return {
      ok: false,
      text: null,
      chars: stat.size,
      why:
        `${file} is ${stat.size} characters and the limit is ${RULES_MAX}. ` +
        'It is not being used: rules are read on every turn of every session, and half a rule is a different rule, ' +
        'so an oversized file is refused rather than cut short. Shorten it and start a new session.',
    };
  }

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, text: null, chars: stat.size, why: `${file} could not be read: ${String(e).slice(0, 120)}` };
  }

  // A file of blank lines is a file somebody meant to write and did not. It is
  // not rules, and reporting it as rules would be this project's own C-5
  // failure: claiming a state on evidence that does not support it.
  if (!text.trim()) {
    return { ok: false, text: null, chars: text.length, why: `${file} is empty` };
  }
  if (text.length > RULES_MAX) {
    return {
      ok: false,
      text: null,
      chars: text.length,
      why: `${file} is ${text.length} characters and the limit is ${RULES_MAX}. It is not being used.`,
    };
  }

  return { ok: true, text, chars: text.length, why: null };
}

/**
 * The one-line answer for a status screen, or null when there is nothing to
 * say — which is the case on a box with no rules file, and saying "no house
 * rules" there would be a line about a feature nobody is using.
 *
 * @param {HouseRules|null} rules
 * @returns {string|null}
 */
export function describeHouseRules(rules) {
  if (!rules) return null;
  if (!rules.ok) return `House rules: NOT IN USE — ${rules.why}`;
  return `House rules: ${rules.chars} characters, given to every new session on this box.`;
}
