// The store listing, as data, from the document somebody actually wrote.
//
// WHY THIS EXISTS. The copy for both stores has always lived in
// apps/store-listing.md — reviewed in pull requests, argued over, kept current
// — and then somebody retyped it into two web consoles. The pipeline builds,
// signs, uploads, distributes to testers and submits for review without a human
// touching anything, and stops one step short of the words on the page.
//
// That last step is where a listing goes stale: nobody re-pastes a description
// they only changed slightly, so the repository and the store drift, and the
// repository is the one that looks authoritative.
//
// THE DOCUMENT STAYS THE SOURCE, rather than being replaced by a YAML file with
// the prose moved into it. It is written for a person deciding what the app
// should say, it carries the reasoning and the alternates, and a version of it
// that reads like configuration would stop being read. So this parses it, the
// same way scripts/release-notes.mjs parses CHANGELOG.md.
//
// IT REFUSES RATHER THAN GUESSES. A heading it cannot find, or one whose block
// is empty, is an error naming the heading — because the failure mode of a
// lenient parser here is a store page that publishes an empty description.

import { readFileSync } from 'node:fs';

/** Where the one document lives. Both stores read it; neither owns it. */
export const LISTING_PATH = new URL('../apps/store-listing.md', import.meta.url);

/**
 * The first fenced block under a heading.
 *
 * FIRST, DELIBERATELY. "Short description" carries a primary and two
 * alternates, with the primary first and the alternates introduced as
 * alternates. Taking the last would publish an A/B candidate; taking all of
 * them would publish three sentences glued together.
 *
 * @param {string} md @param {RegExp} heading
 * @returns {string|null}
 */
function blockUnder(md, heading) {
  const lines = md.split('\n');
  const at = lines.findIndex((l) => l.startsWith('## ') && heading.test(l));
  if (at < 0) return null;
  for (let i = at + 1; i < lines.length; i++) {
    // The next heading ends the section — a missing block must not be filled
    // from the section below it.
    if (lines[i].startsWith('## ')) return null;
    if (lines[i].trimEnd() === '```') {
      const body = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trimEnd() === '```') return body.join('\n').trim() || null;
        body.push(lines[j]);
      }
      return null;
    }
  }
  return null;
}

/** @param {string} md @param {RegExp} heading @param {string} what */
function required(md, heading, what) {
  const got = blockUnder(md, heading);
  if (!got) {
    throw new Error(
      `apps/store-listing.md has no usable "${what}" — expected a fenced block under that heading.\n` +
        'The document is the source for both stores; a missing block is a store page with an empty field.',
    );
  }
  return got;
}

/**
 * What both stores need, read once.
 *
 * @param {string|URL} [path]
 */
export function storeListing(path = LISTING_PATH) {
  const md = readFileSync(path, 'utf8');
  const name = required(md, /App name/i, 'App name');
  const short = required(md, /Short description/i, 'Short description');
  const full = required(md, /Full description/i, 'Full description');
  // THE FIELDS APP STORE CONNECT STILL WANTED TYPED after the description
  // arrived: the first submission was refused for every one of them, with the
  // answers in nobody's head. Required, like the rest — an empty keyword
  // field is a store page nobody finds.
  const keywords = required(md, /^## Keywords/i, 'Keywords');
  const supportUrl = required(md, /^## Support URL/i, 'Support URL');
  const privacyPolicyUrl = required(md, /^## Privacy policy URL/i, 'Privacy policy URL');
  const copyright = required(md, /^## Copyright/i, 'Copyright');

  // THE LIMITS ARE APPLE'S AND GOOGLE'S, checked here rather than discovered on
  // upload. A field one character over is refused by the API with a message
  // about the attribute, on a release run, minutes after the build.
  const tooLong = [
    ['App name', name, 30],
    ['Short description', short, 80],
    ['Full description', full, 4000],
    ['Keywords', keywords, 100],
  ].filter(([, v, max]) => String(v).length > Number(max));
  if (tooLong.length) {
    throw new Error(
      tooLong.map(([k, v, max]) => `${k} is ${String(v).length} characters; the limit is ${max}`).join('\n'),
    );
  }

  for (const [k, v] of [['Support URL', supportUrl], ['Privacy policy URL', privacyPolicyUrl]]) {
    if (!/^https:\/\/\S+$/.test(v)) throw new Error(`${k} is not one https URL: ${JSON.stringify(v)}`);
  }

  return { name, short, full, keywords, supportUrl, privacyPolicyUrl, copyright };
}
