// Load a systemd EnvironmentFile into process.env.
//
// WHY THIS EXISTS AS A MODULE
//
// Each of these services is configured by an /etc file that systemd hands to
// the unit with EnvironmentFile=. systemd reads it as root before dropping to
// User=, so THE SERVICE ALWAYS WORKS. A person running the same binary from a
// shell gets nothing: their shell has never heard of that file.
//
// So every CLI subcommand — enrol, doctor, identity — has to load it for
// itself, and until now only bin/agent-hub did. `agent-fleet-sidecar enrol`
// therefore reported "AGENT_FLEET_COORDINATOR_URL is not set" on a box where
// the URL was sitting in /etc/agent-fleet-sidecar.env, correctly, having just
// been written by the installer that printed the command to run.
//
// It stayed hidden because every caller inside the project already passed the
// value explicitly: the installer enrols with the variables spelled out on the
// command line. The only path that went through the environment was the one a
// human types, which no test covers and no install exercises.
//
// Real environment variables win, so `AGENT_FLEET_HOST_ID=x agent-fleet-sidecar
// identity` still overrides the file, and systemd's own values are never
// second-guessed.

import { readFileSync } from 'node:fs';

/**
 * @param {string} file  the EnvironmentFile to read
 * @param {NodeJS.ProcessEnv} [env]  defaults to process.env; injectable for tests
 * @returns {string[]} the names actually set from the file, for diagnostics
 */
export function loadEnvFile(file, env = process.env) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // Not installed system-wide, or not readable by this user. Both are normal
    // — a checkout run from a working tree has no /etc file at all — so this is
    // not an error. What IS worth saying is when a required value is missing,
    // and that is the caller's job, where it can name the value.
    return [];
  }

  const set = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
    if (env[key] !== undefined) continue; // the real environment wins
    // systemd strips one layer of surrounding quotes; match that exactly,
    // otherwise a quoted value works as a service and not from a shell.
    env[key] = line
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
    set.push(key);
  }
  return set;
}
