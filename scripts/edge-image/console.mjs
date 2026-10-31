// A serial console, driven: the part of scripts/edge-image/drive.mjs that
// can be tested without a VM. Bytes come in as the guest sends them, in
// whatever pieces the pipe hands over, and two questions are asked of them:
// has a prompt appeared, and has a command finished, with what status.
//
// WHY SENTINELS. A console has no out-of-band channel: there is no exit code
// in the stream, only text, and the shell's own prompt is not safe to wait
// for because a command's output can contain it. So every command is sent
// with an echo of a marker nobody else prints, and the marker carries the
// command's exit status, which is the only way the status reaches us.
//
// THE TRAP IS THE ECHO. A tty echoes what is typed, so the marker appears
// twice: once in the typed line, once when the echo runs. The typed line is
// written as two adjacent quoted strings, `"__FW_""DONE_3_$?__"`, which the
// shell joins and expands into `__FW_DONE_3_0__`, and which does not contain
// that text as typed. The regular expression waited for only matches the
// expanded form, with digits where `$?` was.

import { StringDecoder } from 'node:string_decoder';

const PREFIX = '__FW_';

/**
 * The marker for one command: how it is typed and how it reads back.
 *
 * @param {number} id
 * @returns {{ typed: string, done: RegExp, echoed: string }}
 */
export function sentinel(id) {
  return {
    // `$?` is the status of what ran before the `;`, which is the command.
    typed: `; echo "${PREFIX}""DONE_${id}_$?__"`,
    done: new RegExp(`${PREFIX}DONE_${id}_(\\d+)__`),
    // The tail of the typed marker as the tty echoes it, used to find where
    // the command's own output begins.
    echoed: `DONE_${id}_$?__"`,
  };
}

/**
 * The command's own output out of the text between typing it and its marker:
 * after the echoed line when the tty echoed one, up to the marker.
 *
 * @param {string} window @param {string} echoed
 */
export function sliceOutput(window, echoed) {
  // Carriage returns go first, so an echo a line editor redrew with one in
  // the middle is still found; the driver turns the echo off after the first
  // command, so this is for that one and for a guest that ignored it.
  let text = window.replace(/\r/g, '');
  const at = text.indexOf(echoed);
  if (at >= 0) {
    const nl = text.indexOf('\n', at + echoed.length);
    text = nl >= 0 ? text.slice(nl + 1) : '';
  } else {
    // With the echo off, the window opens on the prompt the shell printed
    // after the last marker, `# ` on its own, and then the output. The
    // prompt goes; a command whose own first line began with "# " would
    // lose those two characters, and none asked here prints one.
    text = text.replace(/^\n*# /, '');
  }
  return text.replace(/\n$/, '');
}

/** @param {string} s */
const lastLines = (s, n = 12) => s.replace(/\r/g, '').split('\n').filter(Boolean).slice(-n).join('\n');

export class Console {
  /**
   * @param {{ send: (text: string) => void, log?: (text: string) => void }} io
   *   `send` writes to the guest; `log` sees every byte received, as text,
   *   and every line sent, which is how the console log on disk is made.
   */
  constructor({ send, log = () => {} }) {
    this.send = send;
    this.log = log;
    this.decoder = new StringDecoder('utf8');
    /** Everything received and not yet consumed by a match. */
    this.buf = '';
    /** @type {null | { pattern: RegExp, label: string, resolve: (r: { match: RegExpMatchArray, before: string }) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }} */
    this.waiter = null;
    this.ids = 0;
    this.closed = false;
  }

  /** Bytes from the guest. @param {Buffer|string} chunk */
  feed(chunk) {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (!text) return;
    this.log(text);
    this.buf += text;
    this.check();
  }

  /** The guest went away: whatever is waited for now will not come. */
  close() {
    this.closed = true;
    this.check();
  }

  check() {
    const w = this.waiter;
    if (!w) return;
    const m = this.buf.match(w.pattern);
    if (m && m.index !== undefined) {
      this.waiter = null;
      clearTimeout(w.timer);
      const before = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      w.resolve({ match: m, before });
    } else if (this.closed) {
      this.waiter = null;
      clearTimeout(w.timer);
      w.reject(new Error(`the console closed while waiting for ${w.label}. The last of it:\n${lastLines(this.buf)}`));
    }
  }

  /**
   * Wait until `pattern` appears in what has arrived since the last match,
   * and consume through it. Answers the match and the text before it. One
   * waiter at a time: the console is one conversation.
   *
   * `label` is what the wait is called in an error, and every wait names
   * one: the pattern itself is never put into a message. A regex is not a
   * sentence a person reads, and one of them matches the password prompt,
   * which a scanner reads as the password on its way to a log.
   *
   * @param {RegExp} pattern @param {{ timeout: number, label: string }} how  timeout in ms
   * @returns {Promise<{ match: RegExpMatchArray, before: string }>}
   */
  waitFor(pattern, { timeout, label }) {
    if (this.waiter) return Promise.reject(new Error(`already waiting for ${this.waiter.label}`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`${label} did not appear within ${Math.round(timeout / 1000)}s. The last of the console:\n${lastLines(this.buf)}`));
      }, timeout);
      this.waiter = { pattern, label, resolve, reject, timer };
      this.check();
    });
  }

  /**
   * A line longer than this is refused before it is sent. A terminal line
   * has a size, MAX_INPUT, which FreeBSD's sys/syslimits.h puts at 255; a
   * line past it is not answered, not even with a prompt, and the driver
   * waited ten minutes on one of 507 characters before this existed. Two
   * hundred leaves room for the sentinel and for being wrong about the
   * exact number by a little.
   */
  static LINE_MAX = 200;

  /**
   * The refusal says nothing derived from the line, not even its length:
   * the same check guards the password, an error's words end up on stderr
   * and in the log, and a scanner reads a number taken from a password as
   * the password. The caller's label says which line it was.
   *
   * @param {string} text  a line about to be sent, sentinel included
   */
  #fits(text) {
    if (text.length > Console.LINE_MAX) throw new Error(`a line longer than the console takes (${Console.LINE_MAX} characters) was not sent`);
  }

  /** Type a line, carriage return and all, as a terminal would. @param {string} text */
  type(text) {
    this.#fits(text);
    this.log(`\n>>> ${text}\n`);
    this.send(`${text}\r`);
  }

  /**
   * Type a line the log must not carry, the login password: what is sent is
   * the same, and the log says only that it was. The console log is uploaded
   * from every run, and a password in it is a password published, default or
   * not.
   *
   * @param {string} text @param {string} label  what the log says instead
   */
  typeSecret(text, label) {
    this.#fits(text);
    this.log(`\n>>> [${label}]\n`);
    this.send(`${text}\r`);
  }

  /**
   * Run one command in a POSIX shell on the console and wait for it to
   * finish. The answer is its exit status and what it printed, without the
   * echoed command line.
   *
   * @param {string} cmd @param {{ timeout: number, label?: string }} how
   * @returns {Promise<{ status: number, output: string }>}
   */
  async run(cmd, { timeout, label = cmd }) {
    const s = sentinel(++this.ids);
    this.type(cmd + s.typed);
    const { match, before } = await this.waitFor(s.done, { timeout, label });
    return { status: Number(match[1]), output: sliceOutput(before, s.echoed) };
  }

  /**
   * Run a command and insist it succeeded, naming it and its output when it
   * did not, so a failure in the log reads as a sentence and not a number.
   *
   * @param {string} cmd @param {{ timeout: number, label?: string }} how
   */
  async must(cmd, how) {
    const r = await this.run(cmd, how);
    if (r.status !== 0) throw new Error(`\`${how.label ?? cmd}\` exited ${r.status}:\n${lastLines(r.output)}`);
    return r;
  }
}
