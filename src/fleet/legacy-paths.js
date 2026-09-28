// Default paths across the rename — see legacy-names.js for the whole story.
// Host only: the Worker imports legacy-names.js and has no filesystem.

import { existsSync } from 'node:fs';
import { LEGACY_UNITS } from './legacy-names.js';

/**
 * The path to use by default: the current name if it exists, else the legacy
 * one if that exists, else the current name.
 *
 * @param {string} current
 * @param {string} legacy
 * @param {(p: string) => boolean} [exists]
 */
export function preferExisting(current, legacy, exists = existsSync) {
  if (exists(current)) return current;
  if (exists(legacy)) return legacy;
  return current;
}

/**
 * The systemd unit to talk to: the current name, unless this box still has
 * only the old one. A checkout updates by `git pull` and does not re-run the
 * installer, so new code can run for a while under units that have not been
 * renamed — and `systemctl start fleetwright-upgrade.service` against a box
 * whose unit, and whose sudoers rule, still say agent-hub-upgrade is a refusal
 * that reads like a bug.
 *
 * Accepts `name` or `name.service`/`.timer`, and answers in the same form.
 *
 * @param {string} unit
 * @param {{ dir?: string, exists?: (p: string) => boolean }} [opts]
 */
export function unitName(unit, { dir = '/etc/systemd/system', exists = existsSync } = {}) {
  const m = /^(.*?)(\.service|\.timer)?$/.exec(unit);
  const base = m?.[1] ?? unit;
  const suffix = m?.[2] ?? '';
  const legacy = LEGACY_UNITS[/** @type {keyof typeof LEGACY_UNITS} */ (base)];
  if (!legacy) return unit;
  const file = (/** @type {string} */ b) => `${dir}/${b}${suffix || '.service'}`;
  if (exists(file(base))) return unit;
  if (exists(file(legacy))) return `${legacy}${suffix}`;
  return unit;
}
