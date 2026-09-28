// The names this project had before it was Fleetwright everywhere, and the one
// place that still knows them.
//
// Fleetwright began as a spin-off of agent-hub (docs/lineage.md), and until the
// rename its settings were AGENT_HUB_* and AGENT_FLEET_*, its files
// /etc/agent-hub.env and /var/lib/agent-fleet, its units agent-hub.service.
// Every box installed before the rename is made of those names, and the
// coordinator's secrets in Cloudflare are stored under them. So the code reads
// only FLEETWRIGHT_* and the new paths, and this module is what lets it do that
// on a machine that has not been migrated yet:
//
//   adoptLegacyEnv   copies AGENT_HUB_X / AGENT_FLEET_X to FLEETWRIGHT_X when
//                    the new name is unset. Called by every config loader and
//                    by the Worker's entry, so a box whose unit still loads
//                    /etc/agent-hub.env, and a coordinator whose secrets were
//                    put under the old names, both keep working unchanged.
//   preferExisting   (legacy-paths.js, host only — a Worker has no disk) a
//                    default path: the new one if it exists, else the old one
//                    if THAT exists, else the new one. A box that has not run
//                    the migrating installer keeps finding its state; a fresh
//                    box never sees an old name.
//
// install/install.sh does the real migration — moves the files, renames the
// units, leaves symlinks at the old paths — the next time it runs on a box,
// which the next update does. This file is what makes the time between the new
// code arriving and that happening safe. It can go once no box reports an old
// name, and not before; the same rule docs/packaging.md applies to the git path.

// No imports: the coordinator Worker loads this too, and has no node:fs.

const LEGACY = /^AGENT_(?:HUB|FLEET)_(.+)$/;

/**
 * Copy legacy-named settings onto their FLEETWRIGHT_ names, in place, without
 * overwriting anything already set under the new name. Returns the env.
 *
 * The new name wins when both exist: an operator who has written
 * FLEETWRIGHT_X has said something more recent than whatever the old file held.
 *
 * @template {Record<string, any>} T
 * @param {T} env
 * @returns {T}
 */
export function adoptLegacyEnv(env) {
  if (!env || typeof env !== 'object') return env;
  for (const key of Object.keys(env)) {
    const m = LEGACY.exec(key);
    if (!m) continue;
    const next = `FLEETWRIGHT_${m[1]}`;
    if (env[next] === undefined || env[next] === '') /** @type {any} */ (env)[next] = env[key];
  }
  return env;
}

/**
 * The same, as a copy — for an env that must not be written to, such as the
 * one a Worker is handed.
 *
 * @template {Record<string, any>} T
 * @param {T} env
 * @returns {T}
 */
export function withCurrentNames(env) {
  if (!env || typeof env !== 'object') return env;
  if (!Object.keys(env).some((k) => LEGACY.test(k))) return env;
  return adoptLegacyEnv({ ...env });
}

/** Each unit's name from before the rename. */
export const LEGACY_UNITS = Object.freeze({
  fleetwright: 'agent-hub',
  'fleetwright-sidecar': 'agent-fleet-sidecar',
  'fleetwright-coordinator': 'agent-fleet-coordinator',
  'fleetwright-upgrade': 'agent-hub-upgrade',
  'fleetwright-apt-update': 'agent-hub-apt-update',
  'fleetwright-confirm': 'agent-fleet-confirm',
});
