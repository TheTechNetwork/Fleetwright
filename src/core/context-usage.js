// How full a session's context window is, read from the one place that knows.
//
// ROADMAP called this "the one fact of this group the host does not yet know —
// it lives in the transcript, not in any status the CLI exposes". That is
// still true, and the transcript is enough: every assistant entry Claude Code
// writes carries the request's `usage`, and the three input counts of the LAST
// one — what was sent, what was newly cached, what was read from cache — are
// exactly the tokens that were in the window when the model last answered.
// That is the number Claude Code's own status line draws as context used.
//
// TWO READERS, ONE PARSER. A sandboxed session's transcript lives in a volume
// the hub cannot read (it is owned by the session's user namespace), so the
// hook inside the container reads it and posts the answer with every lifecycle
// event — sandbox/hook.mjs, which cannot import this file and so carries a copy
// of `contextFromLines`, kept in step by test/context-usage.test.js the way the
// title reader is. An unsandboxed session's transcript is a file on this box,
// under the service user's own home, and its path arrives with the SessionStart
// hook; the hub reads it here, on demand, and only when the file has changed.
//
// WHAT IS NOT SAID. The size of the window is not in the transcript, and this
// module does not guess it from the model's name: that would be a table about
// somebody else's product, wrong the week a model changes its window, and a
// percentage drawn from it would be the confident kind of wrong. `tokens` and
// `model` are the facts; a screen shows them as they are. `null` is CANNOT
// TELL — no transcript, no assistant turn yet, a shape this does not read — and
// is never rendered as empty.

import { openSync, readSync, closeSync, fstatSync } from 'node:fs';

/** How much of the end of a transcript is read. Transcripts run to tens of
 * megabytes; the last assistant entry is within the last few hundred KB even
 * when a tool result before it was large, and reading the whole file on every
 * event would be a tax on every turn of every session. */
export const TAIL_BYTES = 512 * 1024;

/**
 * @typedef {object} ContextUsage
 * @property {number} tokens   input + cache-creation + cache-read of the last assistant turn
 * @property {string|null} model  the model that answered it, as the transcript names it
 */

/**
 * The last assistant turn's context, from transcript lines (oldest first).
 *
 * Mirrored in sandbox/hook.mjs. Change both, and the parity test says if you did
 * not.
 *
 * @param {string[]} lines
 * @returns {ContextUsage|null}
 */
export function contextFromLines(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"assistant"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'assistant') continue;
    // A sidechain is a subagent's turn, with a window of its own; it says
    // nothing about the conversation the person is in.
    if (entry.isSidechain === true) continue;
    const usage = entry?.message?.usage;
    if (!usage || typeof usage !== 'object') continue;
    const n = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
    const input = n(usage.input_tokens);
    if (input === null) continue;
    const tokens = input + (n(usage.cache_creation_input_tokens) ?? 0) + (n(usage.cache_read_input_tokens) ?? 0);
    const model = typeof entry.message.model === 'string' && entry.message.model ? entry.message.model.slice(0, 64) : null;
    return { tokens, model };
  }
  return null;
}

/**
 * The tail of a file, as lines. The first line is dropped when the read did
 * not start at the beginning of the file, because it is almost certainly a
 * partial line.
 *
 * @param {string} file
 * @param {number} [bytes]
 * @returns {string[]|null} null when the file cannot be read
 */
export function readTailLines(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    let read = 0;
    while (read < buf.length) {
      const got = readSync(fd, buf, read, buf.length - read, start + read);
      if (got <= 0) break;
      read += got;
    }
    const lines = buf.toString('utf8', 0, read).split('\n');
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * The context of the last assistant turn in a transcript file, or null.
 * @param {string|null|undefined} file
 * @returns {ContextUsage|null}
 */
export function contextFromTranscript(file) {
  if (!file) return null;
  const lines = readTailLines(file);
  return lines ? contextFromLines(lines) : null;
}

/**
 * Is this a path the hub should be willing to read as a transcript?
 *
 * The hook says where the transcript is, and the hook runs as the service
 * user on this box, so it can only name files that user can read anyway. The
 * shape is checked all the same: an absolute path to a `<uuid>.jsonl`, which
 * is what Claude Code writes and the only thing this reads, so a record can
 * never carry a path to something else that some later reader trusts.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function cleanTranscriptPath(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  if (!value.startsWith('/')) return null;
  if (!/\/[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/.test(value)) return null;
  if (value.includes('\0') || value.includes('/../')) return null;
  return value;
}

/**
 * Reads transcripts on demand and remembers the answer until the file moves.
 *
 * /api/state is asked every health interval and by every console poll, and a
 * box may hold a dozen sessions; re-reading half a megabyte per session per ask
 * would be the wrong trade. A file whose size and mtime have not changed has
 * the same last assistant turn it had a moment ago.
 */
export class ContextReader {
  /** @param {{ stat?: (p: string) => { size: number, mtimeMs: number }, read?: (p: string) => ContextUsage|null }} [deps] */
  constructor({ stat = defaultStat, read = contextFromTranscript } = {}) {
    this.stat = stat;
    this.read = read;
    /** @type {Map<string, { size: number, mtimeMs: number, value: ContextUsage|null }>} */
    this.cache = new Map();
  }

  /**
   * @param {string|null|undefined} file
   * @returns {ContextUsage|null}
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
    const value = this.read(file);
    this.cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, value });
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
