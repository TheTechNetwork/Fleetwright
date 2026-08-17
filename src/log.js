// Logging: line-per-event to stdout/stderr, which is all systemd needs
// (journalctl -u agent-hub). No dependency, no log file to rotate.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = LEVELS.info;

/** @type {NodeJS.WritableStream|null} */
let override = null;

/** @param {string} level */
export function setLogLevel(level) {
  threshold = LEVELS[/** @type {keyof typeof LEVELS} */ (level)] ?? LEVELS.info;
}

/**
 * Send every level to one stream instead of the usual stdout/stderr split.
 *
 * For a process whose stdout is a data channel rather than a console — the
 * fleet sidecar in stdio mode writes newline-delimited JSON there — an info
 * line landing on stdout is not noise, it is a corrupted message. Such a
 * process calls setLogStream(process.stderr) at startup.
 *
 * @param {NodeJS.WritableStream|null} stream null restores the default split
 */
export function setLogStream(stream) {
  override = stream;
}

/**
 * @param {keyof typeof LEVELS} level
 * @param {NodeJS.WriteStream} stream
 * @param {unknown[]} args
 */
function emit(level, stream, args) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  (override || stream).write(`${ts} ${level.toUpperCase().padEnd(5)} ${args.map(fmt).join(' ')}\n`);
}

/** @param {unknown} v */
function fmt(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  /** @param {...unknown} args */
  debug: (...args) => emit('debug', process.stdout, args),
  /** @param {...unknown} args */
  info: (...args) => emit('info', process.stdout, args),
  /** @param {...unknown} args */
  warn: (...args) => emit('warn', process.stderr, args),
  /** @param {...unknown} args */
  error: (...args) => emit('error', process.stderr, args),
};
