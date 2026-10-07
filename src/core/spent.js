// What a session has cost, as Claude Code itself counted it.
//
// ROADMAP's "Per-session telemetry" row asked three things: what a session
// cost, how long it worked, and whether it is blocked on a person. The second
// and third are the hooks' (src/core/activity.js); this file is the first,
// and the first answer to it was going to be wrong in a familiar way.
//
// THE TEMPTING VERSION SUMS THE TRANSCRIPT. Every assistant entry carries the
// request's `usage`, so adding them up looks like the cost — and it is three
// mistakes. Claude Code writes one entry per content block with the SAME usage
// repeated on each (a real transcript on the box this was written on: 9,833
// assistant entries for 5,042 messages), so a naive sum roughly doubles it;
// a subagent's turns are not all in this file; and the dollars would need a
// price table, which context-usage.js already explains is a table about
// somebody else's product, wrong the week a price changes.
//
// CLAUDE CODE ALREADY DID THE ARITHMETIC. It writes a `cost-state` line into
// its own transcript —
//
//   {"type":"cost-state","totalCostUSD":12.4,"startTime":…,"totalDuration":…,
//    "modelUsage":{"<model>":{"inputTokens":…,"outputTokens":…,
//      "cacheReadInputTokens":…,"cacheCreationInputTokens":…,"costUSD":…}},
//    "hasUnknownModelCost":false, …}
//
// — the running total its own `/cost` draws, written so a resumed session can
// carry it on. That is the figure this reads, and the ONLY one: nothing here
// adds, prices or estimates. Observed against CLI 2.1.292 in October 2026;
// a transcript without such a line, or with one in a shape this does not
// read, is CANNOT TELL and is null, never zero.
//
// WHEN IT IS WRITTEN, which decides how stale it can be: after the Stop hooks,
// when a turn ends with nothing queued behind it (`stop_hook_summary`, then
// `last-prompt`, then `cost-state`). So a session in the middle of a long turn
// is reported as of its last pause, and `asOf` says when that was — the
// CLI's own `startTime + totalDuration`, so no clock here is involved.
//
// WHERE IT IS, which decides how it is read. The lines are irregular — on the
// transcript above the last one was 2.4 MB from the end and the widest gap was
// 16 MB — so the tail that context-usage.js reads is not enough, and reading
// the whole file on every event is a tax on every tool call. So the read is
// backwards from the end, stopping at the first one found or at `floor` (the
// point a previous read already covered), and bounded by SCAN_BYTES: a
// session whose last figure is further back than that says CANNOT TELL until
// it next pauses, rather than costing every tool call a scan of the file.
//
// TWO READERS, ONE PARSER, the same arrangement as context-usage.js: the hub
// reads an unsandboxed session's transcript here, and sandbox/hook.mjs — which
// cannot import this file — carries a copy of `spentFromEntry` and
// `readSpent`, kept in step by test/spent.test.js running both over one file.
//
// WHAT LEAVES THE BOX: one dollar figure, four token counts, a flag and a
// timestamp. Never a model name, never the transcript.

import { openSync, readSync, closeSync, fstatSync } from 'node:fs';

/** How far back from the end a read will look for the last figure. */
export const SCAN_BYTES = 32 * 1024 * 1024;
/** One read's worth. */
const CHUNK = 1024 * 1024;
const MARK = Buffer.from('"type":"cost-state"');

/**
 * @typedef {object} Spent
 * @property {number|null} usd        Claude Code's own total, at API prices
 * @property {boolean} complete       false unless it said every model had a known price
 * @property {number|null} inputTokens
 * @property {number|null} outputTokens
 * @property {number|null} cacheReadTokens
 * @property {number|null} cacheWriteTokens
 * @property {number|null} asOf       epoch ms the CLI wrote it, by its own clock
 */

/**
 * A `cost-state` entry in this module's words, or null when it is not one or
 * says nothing this reads.
 *
 * Mirrored in sandbox/hook.mjs. Change both; test/spent.test.js says if you
 * did not.
 *
 * @param {any} entry
 * @returns {Spent|null}
 */
export function spentFromEntry(entry) {
  if (!entry || typeof entry !== 'object' || entry.type !== 'cost-state') return null;
  const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const usd = num(entry.totalCostUSD);
  /** @type {Record<string, number|null>} */
  const tokens = { inputTokens: null, outputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null };
  const models = entry.modelUsage && typeof entry.modelUsage === 'object' && !Array.isArray(entry.modelUsage) ? Object.values(entry.modelUsage) : [];
  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    for (const key of Object.keys(tokens)) {
      const v = num(m[key]);
      if (v !== null && Number.isInteger(v)) tokens[key] = (tokens[key] ?? 0) + v;
    }
  }
  const start = num(entry.startTime);
  const took = num(entry.totalDuration);
  if (usd === null && Object.values(tokens).every((v) => v === null)) return null;
  return {
    usd,
    complete: entry.hasUnknownModelCost === false,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadTokens: tokens.cacheReadInputTokens,
    cacheWriteTokens: tokens.cacheCreationInputTokens,
    asOf: start !== null && took !== null ? start + took : null,
  };
}

/**
 * The newest figure written after `floor`, read backwards from the end.
 *
 * Returns `through`: how far a later read may start its floor — the end of
 * the last complete line, so a line still being written is read again next
 * time rather than skipped. `value` is null when nothing was found between
 * `floor` and the end, and a caller keeps whatever it found before.
 *
 * Mirrored in sandbox/hook.mjs.
 *
 * @param {string|null|undefined} file
 * @param {number} [floor]  bytes already covered by an earlier read
 * @param {number} [scan]   how far back from the end to look at most
 * @returns {{ value: Spent|null, through: number } | null}  null when the file cannot be read
 */
export function readSpent(file, floor = 0, scan = SCAN_BYTES) {
  if (!file) return null;
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    // A file shorter than what was covered has been replaced; start again.
    const low = Math.max(floor <= size ? floor : 0, size - scan);
    let end = size;
    let through = -1;
    /** @type {Buffer} */
    let carry = Buffer.alloc(0);
    while (end > low) {
      const start = Math.max(low, end - CHUNK);
      const chunk = Buffer.alloc(end - start);
      let got = 0;
      while (got < chunk.length) {
        const n = readSync(fd, chunk, got, chunk.length - got, start + got);
        if (n <= 0) break;
        got += n;
      }
      const buf = Buffer.concat([chunk.subarray(0, got), carry]);
      if (through < 0) {
        // The first read is the end of the file: everything after its last
        // newline is a line still being written.
        const nl = buf.lastIndexOf(10);
        if (nl >= 0) through = start + nl + 1;
      }
      // The part before the first newline belongs to a line that started in
      // an earlier chunk, unless this chunk starts at the floor.
      const first = start > low ? buf.indexOf(10) : -1;
      if (start > low && first < 0) {
        carry = buf;
        end = start;
        continue;
      }
      const body = start > low ? buf.subarray(first + 1) : buf;
      const found = lastSpentIn(body);
      if (found) return { value: found, through: through < 0 ? low : through };
      carry = start > low ? buf.subarray(0, first + 1) : Buffer.alloc(0);
      end = start;
    }
    return { value: null, through: through < 0 ? low : through };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * The last parseable figure in a run of whole lines, or null.
 * @param {Buffer} body
 * @returns {Spent|null}
 */
function lastSpentIn(body) {
  let at = body.lastIndexOf(MARK);
  while (at >= 0) {
    const from = body.lastIndexOf(10, at) + 1;
    const nl = body.indexOf(10, at);
    const line = body.toString('utf8', from, nl < 0 ? body.length : nl);
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch {
      // A line still being written, or a quotation of one inside something
      // else: neither is a figure.
    }
    const spent = spentFromEntry(entry);
    if (spent) return spent;
    at = from > 0 ? body.lastIndexOf(MARK, from - 1) : -1;
  }
  return null;
}

/**
 * Reads unsandboxed sessions' transcripts on demand, remembering per file how
 * far it has read and what it found, so a figure is looked for only in what
 * was written since. /api/state is asked every health interval and by every
 * console poll; the scan backwards is paid once per file, not once per ask.
 */
export class SpentReader {
  /** @param {{ stat?: (p: string) => { size: number, mtimeMs: number }, read?: typeof readSpent }} [deps] */
  constructor({ stat = defaultStat, read = readSpent } = {}) {
    this.stat = stat;
    this.read = read;
    /** @type {Map<string, { size: number, mtimeMs: number, through: number, value: Spent|null }>} */
    this.cache = new Map();
  }

  /**
   * @param {string|null|undefined} file
   * @returns {Spent|null}
   */
  for(file) {
    if (!file) return null;
    let st;
    try {
      st = this.stat(file);
    } catch {
      this.cache.delete(file);
      return null;
    }
    const hit = this.cache.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.value;
    // Shorter than before is a different file under the same name.
    const prior = hit && st.size >= hit.size ? hit : null;
    const r = this.read(file, prior?.through ?? 0);
    if (!r) {
      this.cache.delete(file);
      return null;
    }
    const value = r.value ?? prior?.value ?? null;
    this.cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, through: r.through, value });
    return value;
  }

  /** @param {string|null|undefined} file */
  forget(file) {
    if (file) this.cache.delete(file);
  }
}

/** @param {string} p */
function defaultStat(p) {
  const fd = openSync(p, 'r');
  try {
    const st = fstatSync(fd);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } finally {
    closeSync(fd);
  }
}
