'use strict'

// FLEETWRIGHT'S RECONNECT WATCHDOG, an xo-server plugin. docs/hypervisors.md,
// "When Xen Orchestra loses a pool".
//
// Asked for, about the alert "10.10.10.230 shows no pools ... Reconnecting
// its servers usually brings them back": "Has to be a better way ... Can we
// patch xen to auto reconnect?" Xen Orchestra already retries a server that
// drops (xo-server's _xenServerAutoReconnect.mjs, since 2026-07-20), and this
// covers what that loop leaves, read from its source rather than assumed:
//
//   - A SERVER STUCK "connecting". When event fetching keeps failing,
//     xo-server forgets the pool and marks the server `connecting`; its own
//     loop only ever acts on `disconnected`, so nothing retries it. This is
//     what Reconnect in the app does by hand: disable, then enable again.
//   - A SERVER LEFT "disconnected" on a Xen Orchestra older than that loop.
//     On a newer one the loop gets there first, and this only acts once the
//     server has stayed disconnected for longer than the loop's first tries.
//
// WHAT IT LEAVES ALONE, as Xen Orchestra and the app both do:
//   - a server a person turned off (`enabled: false`), which stays off;
//   - a server whose pool master refuses the password Xen Orchestra keeps
//     for it, or whose pool is already connected through another server:
//     trying again cannot help, and the first hammers the host with a wrong
//     password. It says so in xo-server's log once, and waits for a person.
//
// IT RUNS INSIDE XEN ORCHESTRA, as the installer's update plugin does, so it
// holds no token and no password: it calls the same methods `server.enable`
// and `server.disable` reach, as xo-server itself. It has no settings, so
// Xen Orchestra loads it the first time it sees it and keeps loading it.
//
// IT BACKS OFF: after acting on a server it waits twice as long before the
// next try, up to half an hour, so a pool master that is genuinely down is
// not asked every minute for a day.

/** How often the servers are looked at. */
const CHECK_MS = 60e3
/** How long a server may stay `disconnected` before this connects it: past Xen Orchestra's own first quick retries. */
const DISCONNECTED_GRACE_MS = 3 * 60e3
/** How long a server may stay `connecting` before it counts as stuck. A large pool's first fetch takes a minute or two. */
const CONNECTING_STUCK_MS = 10 * 60e3
/** The longest wait between two tries on one server. */
const MAX_BACKOFF_MS = 30 * 60e3

/**
 * Whether a server's last error is one trying again cannot fix: the pool
 * master refusing Xen Orchestra's user name and password, or the pool already
 * connected through another server. Xen Orchestra's own loop stops on the
 * same two (xen-servers.mjs, `_connectXenServer`).
 *
 * @param {any} error
 */
function permanent(error) {
  if (!error || typeof error !== 'object') return false
  const code = String(error.code ?? error.data?.code ?? '')
  const text = `${error.name ?? ''} ${error.message ?? ''}`
  return code === 'SESSION_AUTHENTICATION_FAILED' || /PoolAlreadyConnected|pool is already connected/i.test(text)
}

/**
 * @typedef {{ state: 'disconnected'|'connecting'|'permanent', since: number, attempts: number, due: number }} Seen
 * @typedef {{ id: string, enabled?: boolean, status?: string, error?: any, label?: string, host?: string }} Server
 */

/**
 * What to do about one server now, and what to remember about it.
 *
 * @param {Server} server
 * @param {Seen|undefined} prev what was remembered last time
 * @param {number} now
 * @returns {{ action: 'none'|'connect'|'cycle'|'give-up', next: Seen|undefined }}
 */
function decide(server, prev, now) {
  if (!server.enabled) return { action: 'none', next: undefined }
  if (server.status === 'connected' && !server.error) return { action: 'none', next: undefined }
  if (permanent(server.error)) {
    // SAID ONCE, then left for a person.
    if (prev?.state === 'permanent') return { action: 'none', next: prev }
    return { action: 'give-up', next: { state: 'permanent', since: now, attempts: 0, due: Infinity } }
  }
  /** @type {'disconnected'|'connecting'|null} */
  const state =
    server.status === 'disconnected' ? 'disconnected' : server.status === 'connecting' || server.status === 'connected' ? 'connecting' : null
  // `disconnecting`, or anything newer: something is already happening.
  if (state === null) return { action: 'none', next: prev }
  const wait = state === 'disconnected' ? DISCONNECTED_GRACE_MS : CONNECTING_STUCK_MS
  // THE TRIES CARRY ACROSS A CHANGE OF STATE: a try that fails moves the
  // server from connecting back to disconnected, and starting the count again
  // there would mean the wait never grew. Only a healthy server clears it.
  const attempts = prev && prev.state !== 'permanent' ? prev.attempts : 0
  const backoff = Math.min(wait * 2 ** attempts, MAX_BACKOFF_MS)
  if (prev?.state !== state) return { action: 'none', next: { state, since: now, attempts, due: now + backoff } }
  if (now < prev.due) return { action: 'none', next: prev }
  return {
    action: state === 'disconnected' ? 'connect' : 'cycle',
    next: { state, since: prev.since, attempts: attempts + 1, due: now + Math.min(wait * 2 ** (attempts + 1), MAX_BACKOFF_MS) },
  }
}

/** The name a person knows a server by, for the log. */
function named(/** @type {Server} */ server) {
  return server.label || server.host || server.id
}

class Watchdog {
  /**
   * @param {any} xo xo-server's app, as plugins are given it
   * @param {{ now?: () => number, every?: number, log?: Pick<Console, 'info'|'warn'> }} [opts]
   */
  constructor(xo, { now = Date.now, every = CHECK_MS, log = console } = {}) {
    this._xo = xo
    this._now = now
    this._every = every
    this._log = log
    /** @type {Map<string, Seen>} */
    this._seen = new Map()
    /** @type {ReturnType<typeof setInterval>|undefined} */
    this._timer = undefined
    this._running = false
  }

  load() {
    this._timer = setInterval(() => {
      this.check().catch(error => this._log.warn('[fleetwright-reconnect] could not read the servers', error))
    }, this._every)
    // xo-server's own work keeps the process alive; this never should.
    this._timer.unref?.()
  }

  unload() {
    clearInterval(this._timer)
    this._timer = undefined
    this._seen.clear()
  }

  /** One look at every server, and whatever it calls for. Never two at once. */
  async check() {
    if (this._running) return
    this._running = true
    try {
      /** @type {Server[]} */
      const servers = (await this._xo.getAllXenServers()) || []
      const ids = new Set(servers.map(s => s.id))
      for (const id of this._seen.keys()) if (!ids.has(id)) this._seen.delete(id)
      for (const server of servers) {
        const { action, next } = decide(server, this._seen.get(server.id), this._now())
        if (next === undefined) this._seen.delete(server.id)
        else this._seen.set(server.id, next)
        await this._act(action, server, next)
      }
    } finally {
      this._running = false
    }
  }

  /**
   * @param {'none'|'connect'|'cycle'|'give-up'} action
   * @param {Server} server
   * @param {Seen|undefined} seen
   */
  async _act(action, server, seen) {
    const name = named(server)
    if (action === 'give-up') {
      this._log.warn(
        `[fleetwright-reconnect] not reconnecting ${name}: ${server.error?.message || server.error?.code || 'its last error'} will not change by trying again. Fix it in Settings → Servers.`
      )
      return
    }
    if (action === 'connect') {
      this._log.info(`[fleetwright-reconnect] ${name} has been disconnected since ${new Date(seen?.since ?? 0).toISOString()}; connecting it`)
      // `enable: false`: never turn on a server a person is turning off right now.
      await this._xo.connectXenServer(server.id, { enable: false }).catch(error => this._failed(name, error))
      return
    }
    if (action === 'cycle') {
      this._log.info(`[fleetwright-reconnect] ${name} has been stuck connecting since ${new Date(seen?.since ?? 0).toISOString()}; disconnecting it and connecting it again`)
      // THE SAME AS RECONNECT IN THE APP: disable, then enable. Disabling
      // turns `enabled` off on its way, and it is turned back on whatever
      // happens, so this never leaves off a server a person had on.
      try {
        await this._xo.disconnectXenServer(server.id)
        await this._xo.connectXenServer(server.id, { enable: true })
      } catch (error) {
        this._failed(name, error)
      } finally {
        const now = await this._xo.getXenServer(server.id).catch(() => undefined)
        if (now !== undefined && !now.enabled) await this._xo.updateXenServer(server.id, { enabled: true }).catch(() => {})
      }
    }
  }

  /** @param {string} name @param {any} error */
  _failed(name, error) {
    // `incorrect state`: Xen Orchestra is already connecting it itself.
    this._log.warn(`[fleetwright-reconnect] ${name} did not connect: ${error?.message || error}`)
  }
}

/**
 * The plugin, as xo-server loads it: a factory given the app. No
 * configuration schema, so Xen Orchestra counts it configured and loads it
 * without anyone opening its settings.
 *
 * @param {{ xo: any }} opts
 */
module.exports = ({ xo }) => new Watchdog(xo)
module.exports.Watchdog = Watchdog
module.exports.decide = decide
module.exports.permanent = permanent
module.exports.CHECK_MS = CHECK_MS
module.exports.DISCONNECTED_GRACE_MS = DISCONNECTED_GRACE_MS
module.exports.CONNECTING_STUCK_MS = CONNECTING_STUCK_MS
module.exports.MAX_BACKOFF_MS = MAX_BACKOFF_MS
