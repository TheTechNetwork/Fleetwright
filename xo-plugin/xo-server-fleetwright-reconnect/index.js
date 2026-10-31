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
//     for it: trying again cannot help, and hammers the host with a wrong
//     password. It says so in xo-server's log once, and waits for a person.
//
// A SECOND SERVER FOR A POOL ANOTHER HOLDS stands by. Asked for, by someone
// whose pool master answers on two addresses by turns, so they listed it
// twice: Xen Orchestra turns the second away with "this pool is already
// connected", never retries it (the error ends its loop, xen-servers.mjs),
// and so did this, as a permanent error. Then the host moved to the other
// address, the first server dropped, and nothing ever tried the second: the
// pool was gone until a person pressed Reconnect. Now a server turned away
// that way is left alone only while the server that holds its pool is still
// connected; the moment that one is not, it is a disconnected server like any
// other, and is connected after the usual grace. Which server holds the pool
// is read from the error itself (xo-server puts `connectedServerId` and
// `poolId` on it); an error that names neither is taken as still held, the
// old behaviour, since guessing wrong would mean two servers fighting.
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
 * master refusing Xen Orchestra's user name and password. Xen Orchestra's
 * own loop stops on it too (xen-servers.mjs, `_connectXenServer`).
 *
 * @param {any} error
 */
function permanent(error) {
  if (!error || typeof error !== 'object') return false
  return String(error.code ?? error.data?.code ?? '') === 'SESSION_AUTHENTICATION_FAILED'
}

/**
 * Whether a server's last error is Xen Orchestra turning it away because
 * another server already holds its pool (`PoolAlreadyConnected`, thrown in
 * xen-servers.mjs once the connection is up and the pool is known).
 *
 * @param {any} error
 */
function turnedAway(error) {
  if (!error || typeof error !== 'object') return false
  return /PoolAlreadyConnected|pool is already connected/i.test(`${error.name ?? ''} ${error.message ?? ''}`)
}

/**
 * The server that holds the pool a turned-away server was refused for, if it
 * still does: the one the error names, or one connected to the pool the error
 * names, counted as holding while its status is `connected` whatever its
 * error, since xo-server keeps the pool for it until it is disconnected. An
 * error that names neither is answered with the turned-away server itself:
 * taken as still held, so that nothing is guessed.
 *
 * @param {Server} server the one turned away
 * @param {Server[]} servers every server, as this look saw them
 * @returns {Server|undefined}
 */
function holderOf(server, servers) {
  const e = server.error ?? {}
  const holder = e.connectedServerId ?? e.data?.connectedServerId
  const pool = e.poolId ?? e.data?.poolId
  if (holder === undefined && pool === undefined) return server
  return servers.find(s => s.id !== server.id && s.status === 'connected' && (s.id === holder || (pool !== undefined && s.poolId === pool)))
}

/**
 * @typedef {{ state: 'disconnected'|'connecting'|'permanent'|'standby', since: number, attempts: number, due: number }} Seen
 * @typedef {{ id: string, enabled?: boolean, status?: string, error?: any, label?: string, host?: string, poolId?: string }} Server
 */

/**
 * What to do about one server now, and what to remember about it.
 *
 * @param {Server} server
 * @param {Seen|undefined} prev what was remembered last time
 * @param {number} now
 * @param {Server[]} [servers] every server this look saw, for a pool held through another
 * @returns {{ action: 'none'|'connect'|'cycle'|'give-up'|'stand-by', next: Seen|undefined, holder?: Server }}
 */
function decide(server, prev, now, servers = []) {
  if (!server.enabled) return { action: 'none', next: undefined }
  if (server.status === 'connected' && !server.error) return { action: 'none', next: undefined }
  if (permanent(server.error)) {
    // SAID ONCE, then left for a person.
    if (prev?.state === 'permanent') return { action: 'none', next: prev }
    return { action: 'give-up', next: { state: 'permanent', since: now, attempts: 0, due: Infinity } }
  }
  if (turnedAway(server.error)) {
    const holder = holderOf(server, servers)
    if (holder !== undefined) {
      // STANDING BY, said once, for as long as the pool is held elsewhere.
      if (prev?.state === 'standby') return { action: 'none', next: prev }
      return { action: 'stand-by', next: { state: 'standby', since: now, attempts: 0, due: Infinity }, holder }
    }
    // THE POOL IS FREE: from here it is a disconnected server like any
    // other, its grace counted from the look that found the pool free and
    // its tries from nought. The refusal stays its last error until Xen
    // Orchestra tries it again, so only the step out of standing by resets
    // it; every later look carries the count on.
    if (prev?.state === 'standby') prev = undefined
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
  const attempts = prev && prev.state !== 'permanent' && prev.state !== 'standby' ? prev.attempts : 0
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
        const { action, next, holder } = decide(server, this._seen.get(server.id), this._now(), servers)
        if (next === undefined) this._seen.delete(server.id)
        else this._seen.set(server.id, next)
        await this._act(action, server, next, holder)
      }
    } finally {
      this._running = false
    }
  }

  /**
   * @param {'none'|'connect'|'cycle'|'give-up'|'stand-by'} action
   * @param {Server} server
   * @param {Seen|undefined} seen
   * @param {Server} [holder] for `stand-by`: the server that holds this one's pool
   */
  async _act(action, server, seen, holder) {
    const name = named(server)
    if (action === 'stand-by') {
      const by = holder === undefined || holder.id === server.id ? 'another server' : named(holder)
      this._log.info(`[fleetwright-reconnect] ${name} stands by: its pool is connected through ${by}, and it is connected if that one drops.`)
      return
    }
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
module.exports.turnedAway = turnedAway
module.exports.CHECK_MS = CHECK_MS
module.exports.DISCONNECTED_GRACE_MS = DISCONNECTED_GRACE_MS
module.exports.CONNECTING_STUCK_MS = CONNECTING_STUCK_MS
module.exports.MAX_BACKOFF_MS = MAX_BACKOFF_MS
