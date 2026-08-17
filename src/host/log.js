// A minimal leveled logger. agent-fleet has no runtime dependencies, and a log
// line is a log line.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

let threshold = LEVELS.info;

/** @param {string} level */
export function setLogLevel(level) {
  threshold = LEVELS[/** @type {keyof typeof LEVELS} */ (level)] ?? LEVELS.info;
}

/** @param {keyof typeof LEVELS} level @param {unknown[]} parts */
function emit(level, parts) {
  if (LEVELS[level] < threshold) return;
  const line = `# ${new Date().toISOString()} ${level.toUpperCase()}`;
  // stderr for everything: stdout is a transport in `--transport stdio` mode,
  // and a log line written into it would be parsed as a reply.
  console.error(line, ...parts);
}

/**
 * @typedef {object} Logger
 * @property {(...args: unknown[]) => void} debug
 * @property {(...args: unknown[]) => void} info
 * @property {(...args: unknown[]) => void} warn
 * @property {(...args: unknown[]) => void} error
 */

/** @type {Logger} */
export const log = {
  debug: (...p) => emit('debug', p),
  info: (...p) => emit('info', p),
  warn: (...p) => emit('warn', p),
  error: (...p) => emit('error', p),
};

/** A logger that says nothing — the default outside the entrypoint, so nothing
 * writes to a stream a caller may be using as a transport.
 * @type {Logger} */
export const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
