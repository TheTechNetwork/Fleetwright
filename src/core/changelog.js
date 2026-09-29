// What changed between the release a box runs and the one waiting for it.
//
// THE QUESTION A PHONE ASKS BEFORE PRESSING APPLY. "fleetwright 0.3.1 is
// waiting" is a fact with nothing behind it: whether to take it tonight or
// leave it until morning depends on what is in it, and the only place that
// said was CHANGELOG.md on GitHub, read in a browser. The box does not hold the
// notes for a version it has not installed yet, so they are fetched — from the
// tag itself, not from the release page, because the release body is whatever
// was pasted into a box and the changelog is written once, for people, and is
// what every store already ships.
//
// The parser is shared with scripts/release-notes.mjs, which reads the same
// file for TestFlight, Play and the GitHub release. One reading of the heading
// format, or the notes a phone shows could disagree with the notes a store
// shows for the same version.

/** `## 0.2.1 — 2026-09-02`. The dash may be an em dash or a hyphen. */
const HEADING = /^##\s+(\d+\.\d+\.\d+)\s*(?:[—-]\s*(.*))?$/;

/** Where the changelog lives when nothing configured says otherwise. */
export const DEFAULT_REPO = 'TheTechNetwork/Fleetwright';

/**
 * Every version section in a changelog, in file order.
 *
 * @param {string} text
 * @returns {Array<{ version: string, date: string, body: string }>}
 */
export function sections(text) {
  const lines = String(text || '').split('\n');
  /** @type {Array<{ version: string, date: string, body: string }>} */
  const out = [];
  /** @type {{ version: string, date: string, lines: string[] } | null} */
  let current = null;
  for (const line of lines) {
    const m = HEADING.exec(line.trim());
    if (m) {
      if (current) out.push({ version: current.version, date: current.date, body: current.lines.join('\n').trim() });
      current = { version: m[1], date: (m[2] || '').trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) out.push({ version: current.version, date: current.date, body: current.lines.join('\n').trim() });
  return out;
}

/**
 * Fit notes into a limit WITHOUT cutting a word in half.
 *
 * Play refuses more than 500 characters per locale and refusing is the good
 * case — a truncated sentence that ends mid-clause reads as a bug in the app.
 * Trimmed at a paragraph boundary where one fits, at a line otherwise, and the
 * ellipsis says a fuller version exists rather than pretending this is all.
 *
 * @param {string} body
 * @param {number} max
 * @param {string} [repo] whose changelog the tail points at
 */
export function fit(body, max, repo = DEFAULT_REPO) {
  if (!max || body.length <= max) return body;
  const tail = `\n\nFull notes: github.com/${repo}/blob/main/CHANGELOG.md`;
  const room = max - tail.length;
  // A negative or tiny budget means the caller's limit cannot hold a pointer
  // as well as prose. Prose wins: a note that is only a URL is not a note.
  if (room < 80) return body.slice(0, max);
  let cut = body.lastIndexOf('\n\n', room);
  if (cut < room / 2) cut = body.lastIndexOf('\n', room);
  if (cut < room / 2) cut = body.lastIndexOf(' ', room);
  if (cut < 0) cut = room;
  return body.slice(0, cut).trimEnd() + tail;
}

/**
 * `v0.3.1`, `0.3.1` → [0, 3, 1]. Anything else — `main-63`, a sha, a rolling
 * build — is null, which is CANNOT COMPARE and never a version of zero.
 *
 * @param {string|null|undefined} v
 * @returns {number[]|null}
 */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Negative when a is older than b, zero when equal, positive when newer.
 * Both must parse; the caller decides what an unparseable one means.
 *
 * @param {number[]} a @param {number[]} b
 */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * The sections a box would be taking: everything newer than what it runs, up
 * to and including what is waiting, NEWEST FIRST — the way a changelog reads.
 *
 * A box that skipped releases gets all of them: a Pi on 0.2.3 offered 0.3.1
 * is taking 0.3.0 as well, and notes that named only the last step would hide
 * the rename that is the bigger change. A box whose own version does not
 * parse (a rolling build, a checkout) gets just the waiting version's notes,
 * because there is no line to draw and guessing one either hides a section or
 * shows the whole file.
 *
 * @param {ReturnType<typeof sections>} all
 * @param {string|null|undefined} installed
 * @param {string} available
 */
export function notesBetween(all, installed, available) {
  const to = parseVersion(available);
  if (!to) return [];
  const from = parseVersion(installed);
  return all
    .filter((s) => {
      const v = parseVersion(s.version);
      if (!v || compareVersions(v, to) > 0) return false;
      return from ? compareVersions(v, from) > 0 : compareVersions(v, to) === 0;
    })
    .sort((a, b) => compareVersions(/** @type {number[]} */ (parseVersion(b.version)), /** @type {number[]} */ (parseVersion(a.version))));
}

/**
 * Which repository's changelog. Read off the manifest URL when the box has
 * one that points at GitHub, so a fork that publishes its own releases reads
 * its own notes; ours otherwise, which is right for a box installed from our
 * apt repository, whose env file names no manifest at all.
 *
 * @param {{ releaseManifest?: string }} cfg
 */
export function changelogRepo(cfg) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(String(cfg?.releaseManifest || ''));
  return m ? m[1] : DEFAULT_REPO;
}

/**
 * The changelog as it was at the tag of the version waiting. The tag rather
 * than main: main may already describe a version nothing has published, and
 * notes for a release that is not the one being offered are the wrong notes.
 *
 * @param {{ releaseManifest?: string }} cfg
 * @param {string} version  with or without the leading v
 */
export function changelogUrl(cfg, version) {
  const v = String(version).replace(/^v/, '');
  return `https://raw.githubusercontent.com/${changelogRepo(cfg)}/v${v}/CHANGELOG.md`;
}

/**
 * Fetched once per version, kept for the life of the process. The sidecar
 * asks `/updates` every fifteen minutes and a person pressing Check asks it
 * again; the notes for 0.3.1 do not change between those. A FAILURE IS NOT
 * CACHED: a box that could not reach GitHub at 03:00 should answer at 03:15.
 *
 * @type {Map<string, Array<{ version: string, date: string, body: string }>>}
 */
const cache = new Map();

/** For tests, and for nothing else. */
export function forgetNotes() {
  cache.clear();
}

/**
 * The notes for what is waiting, or why there are none.
 *
 * Never throws: the release check that this rides on is already a thing a box
 * survives failing, and a missing changelog is a missing changelog, not a
 * missing update.
 *
 * `ok: false` with a message is CANNOT TELL — the phone says the notes could
 * not be fetched, which is a different sentence from "there are none". A
 * version that has no section (a rolling build, a tag cut before the
 * changelog existed) is `ok: true` with an empty list: asked, and nothing to
 * show.
 *
 * @param {{ releaseManifest?: string }} cfg
 * @param {{ installed?: string|null, available: string }} versions
 * @param {{ fetch?: typeof fetch }} [opts]
 * @returns {Promise<{ ok: boolean, notes: ReturnType<typeof sections>, message?: string }>}
 */
export async function fetchNotes(cfg, { installed = null, available }, { fetch: doFetch = fetch } = {}) {
  // A rolling build is `main-63`: no tag of its own to read, and no section
  // in any changelog. Asked and answered, without a request.
  if (!parseVersion(available)) return { ok: true, notes: [] };
  const url = changelogUrl(cfg, available);
  let all = cache.get(url);
  if (!all) {
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        return { ok: false, notes: [], message: `the notes for ${available} could not be fetched: GitHub answered ${res.status}` };
      }
      all = sections(await res.text());
      cache.set(url, all);
    } catch (e) {
      return { ok: false, notes: [], message: `the notes for ${available} could not be fetched: ${/** @type {Error} */ (e).message}` };
    }
  }
  return { ok: true, notes: notesBetween(all, installed, available) };
}

/**
 * The changelog is Markdown written for a page, and a chat reply and a text
 * box on a phone render neither bold nor code. The markers are noise there —
 * `**A box on the old names moves itself over**` reads as a typo — so they
 * come off, and nothing else does: the words are the notes.
 *
 * @param {string} body
 */
export function plainText(body) {
  return String(body)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^#+\s+/gm, '');
}

/**
 * The notes as one piece of prose, for a reply that has to carry them.
 *
 * Each version keeps its own heading, so a box taking two releases reads two
 * dated sections rather than one run of paragraphs; each is fitted, because a
 * changelog section is written to be complete and a reply is not the place
 * for all of it. Empty when there is nothing, so a caller can leave the line
 * out rather than print "What changed:" over nothing.
 *
 * @param {ReturnType<typeof sections>} notes
 * @param {{ max?: number, repo?: string }} [opts]
 */
export function describeNotes(notes, { max = 1500, repo = DEFAULT_REPO } = {}) {
  return notes
    .map((s) => `What changed in ${s.version}${s.date ? ` (${s.date})` : ''}:\n\n${fit(plainText(s.body), max, repo)}`)
    .join('\n\n');
}
