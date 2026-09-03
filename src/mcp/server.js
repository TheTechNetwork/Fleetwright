// The fleet as an MCP server.
//
// "An MCP server is a thin adapter over /api/intent, not new architecture" —
// ROADMAP, and it turned out to be true. The intent protocol was designed as a
// fixed set of typed verbs with structured replies and refusals that name a
// reason, which is the same shape MCP asks for, so the tools are GENERATED from
// the verb registry rather than written out (see tools.js).
//
// WHAT THIS IS, PRECISELY. A member of the fleet, holding one device credential,
// with exactly that person's visibility. Not an admin channel and not a second
// authority: the coordinator decides what a caller may do and has not changed.
// If the credential belongs to somebody who can see three sessions, so does the
// agent using this.
//
// NO SDK. MCP over stdio is JSON-RPC 2.0 with three methods that matter, and
// this repository ships one runtime dependency on purpose. A dependency is
// worth adding when it does something hard; framing `{"jsonrpc":"2.0"}` is not
// hard, and the protocol is small enough to read in one sitting.
//
// Framing is newline-delimited JSON, which is what the stdio transport uses.

import { toolsFor, DEFAULT_DENY } from './tools.js';

/**
 * MCP revisions this server understands, newest first.
 *
 * NEGOTIATED, NOT ANNOUNCED. This used to be one constant answered to every
 * client regardless of what they asked for, and Claude Code 2.1.251 — which
 * opens with `2025-11-25` — responded by reporting
 *
 *     Client.listTools() called but server does not advertise tools capability
 *
 * and calling no tools at all. Every unit test passed; the server was simply
 * invisible. A hardcoded version is not "following the convention", it is
 * ignoring the half of the handshake that exists to be answered.
 *
 * The spec's rule is: echo the client's version if you support it, otherwise
 * answer with your own and let the client decide. Nothing in `tools/list` or
 * `tools/call` differs across these revisions, so supporting them is a matter
 * of saying so.
 */
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * @typedef {object} Options
 * @property {string} coordinator   origin of the fleet
 * @property {string} credential    a device token (fwk_…)
 * @property {string[]|null} [allow] verbs to expose beyond the safe set
 * @property {number} [budgetMinutes] how long work here is expected to take
 * @property {typeof fetch} [fetch]
 * @property {(line: string) => void} [write]
 * @property {(m: string) => void} [log]
 * @property {() => number} [now]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {number} [watchMs]   how often to look at started sessions; 0 disables
 * @property {Set<string>|null} [started]  sessions this caller started, when the transport keeps them
 * @property {number} [maxWaitMs]  ceiling on a blocking tool, for transports with
 *   a request timeout. Over stdio a long wait is just a long wait; over HTTP an
 *   uncapped one is a dropped connection, which a client cannot tell from a
 *   broken server.
 * @property {(fn: () => void, ms: number) => any} [setTimer]
 */

/**
 * What to tell the caller when the intent never came back.
 *
 * "Could not reach the fleet" was said for EVERY failure, and it is a claim
 * about the network. When the thing that actually broke was a bug inside this
 * server, that sentence sent the reader looking at hosts, at connectivity, at
 * their own credential — none of which were involved. One agent spent a whole
 * session concluding "the fleet is down" from a `this`-reference error.
 *
 * A caller can act on "retry" and can act on "tell the operator". They cannot
 * act on a sentence that names the wrong layer.
 *
 * @param {unknown} e
 */
function describeFailure(e) {
  const message = String(/** @type {any} */ (e)?.message || e);
  // A TypeError from the runtime is this server misusing an API — never a
  // network condition. Nothing the caller varies will change it.
  // A BODY THAT WILL NOT PARSE IS NOT AN OUTAGE. `Unexpected token 'e',
  // "error code: 1101" is not valid JSON` was reported as "the fleet may be
  // down; retrying is reasonable" — advice that could not work, for an error
  // that was not what it said. The same mistake this function was written to
  // fix, in a new place: naming the wrong layer.
  //
  // The parse failure is the evidence, so quote what actually arrived rather
  // than a guess about why.
  if (/is not valid JSON|Unexpected token|JSON\.parse/i.test(message)) {
    return (
      `The coordinator answered with something that is not JSON: ${message}. ` +
      'That is a gateway or a server error rather than a refusal from the fleet — a Cloudflare "error code: 1101" ' +
      'means the Worker threw. Retrying will not change it; whoever operates this coordinator needs its logs.'
    );
  }
  const internal = e instanceof TypeError || /Illegal invocation|is not a function|Cannot read /i.test(message);
  return internal
    ? `The MCP server itself failed before it could reach the fleet: ${message}. ` +
        'This is a bug in the server, not a problem with your request or with the fleet — ' +
        'nothing you change will get past it. Whoever operates this coordinator has to fix it.'
    : `Could not reach the fleet: ${message}. The fleet may be down or this coordinator unreachable; retrying is reasonable.`;
}

/**
 * The session record out of a `status` reply.
 *
 * THE REPLY HAS NEVER HAD A `session` KEY. Both callers read
 * `reply.session ?? reply` and then `.status`, which is `undefined` on every
 * real fleet — the coordinator answers `{ ok, text, sessions: [record] }`, the
 * shape `/status <name>` has always returned (src/adapters/commands.js).
 *
 * So `fleet_await` — the tool this server calls the path that works — could
 * never see a session end, and polled until its own timeout while telling the
 * caller it was "still running". The watcher shared the parse and therefore
 * emitted no notification, ever, on a live fleet.
 *
 * IT PASSED BECAUSE THE FAKE FLEET INVENTED THE SHAPE. `check-mcp-client.mjs`
 * answers `{ ok: true, session: { status: 'stopped' } }`, so the feature was
 * correct against the harness and blind against the coordinator. That is a
 * THIRD way that harness has lied, on top of the two already written down in
 * it — and the reason its fake now answers in the real shape.
 *
 * Matched by name when there is one, because `list` returns many.
 *
 * @param {any} reply
 * @param {string} [name]
 */
function sessionFrom(reply, name = '') {
  const many = Array.isArray(reply?.sessions) ? reply.sessions : null;
  if (many) {
    const found = name ? many.find((/** @type {any} */ s) => s?.name === name) : many[0];
    if (found) return found;
  }
  // `session` and the bare reply are kept as fallbacks rather than deleted: a
  // host that answers either still works, and neither costs anything.
  return reply?.session ?? reply ?? null;
}

/**
 * A health frame, as something a model can act on.
 *
 * Not JSON.stringify: the frame carries fields that answer nothing here
 * (protocol version, the raw session list) and the two that decide whether work
 * can be placed — free capacity and whether Claude is logged in — would be
 * buried among them.
 *
 * @param {any} h
 */
function describeHealth(h) {
  const lines = [];
  // WHICH BOX. On a two-host fleet this returned capacity, load and a login
  // banner with no host name anywhere in it, and a beta tester could not tell
  // which machine they were reading about.
  //
  // I closed that issue (#311) on the strength of the same commit that fixed
  // the login banner, and the banner was all it fixed. Caught by running the
  // tool afterwards rather than by re-reading the diff.
  if (h.hostId) lines.push(String(h.hostId));
  if (typeof h.running === 'number' && typeof h.maxSessions === 'number') {
    lines.push(`${h.running}/${h.maxSessions} sessions running, ${h.free ?? '?'} free`);
  }
  if (Array.isArray(h.loadavg) && h.loadavg.length) lines.push(`load ${h.loadavg.map(Number).join(' ')}`);
  if (Array.isArray(h.labels)) lines.push(`tags: ${h.labels.length ? h.labels.join(', ') : 'none'}`);
  // WHETHER A SESSION CAN ACTUALLY RUN — and `loggedIn` is not that fact.
  //
  // This said "NOT LOGGED IN — a session here cannot do anything" whenever
  // `loggedIn` was false, which under one-account-per-person is the ORDINARY
  // state of every box. The health frame's own comment says so: claudeAccounts
  // replaced loggedIn as the thing to judge a host on, "a machine has no Claude
  // account of its own any more". I read the field and ignored the paragraph
  // beside it.
  //
  // Two beta testers hit it from opposite ends of the funnel. One believed the
  // fleet was down and was a call away from giving up; the other filed it while
  // `fleet_start` was working on the same box in the same minute. It is the
  // most expensive sentence this server has ever printed.
  //
  // claudeAccounts is the real signal, and null is CANNOT TELL — an older host
  // that does not send it must not be reported as broken.
  if (typeof h.claudeAccounts === 'number') {
    lines.push(
      h.claudeAccounts > 0
        ? `claude: ${h.claudeAccounts} account${h.claudeAccounts === 1 ? '' : 's'} linked — sessions run as whoever starts them`
        : 'claude: NOBODY HAS LINKED AN ACCOUNT — a session started here cannot do anything. ' +
            'Link one from the app, from Telegram with /login for <email>, or on the box with `agent-hub login for <email>`',
    );
  } else if (h.loggedIn === true) {
    // An older host with no claudeAccounts field. Its own login is all we know.
    lines.push('claude: the box itself is logged in (this host predates per-person accounts)');
  }
  if (h.hub && h.hub.reachable === false) lines.push('hub: unreachable from the sidecar');

  // THE COUNTDOWN, BEFORE IT MATTERS. A returning beta tester learned their
  // token had eleven minutes left from `fleet_verify`, which they called out of
  // desperation after everything else had misled them. By then they had spent
  // most of the eleven minutes reading errors.
  //
  // The state travels on every health frame. Only `verify` ever looked at it.
  if (h.credential?.state === 'expired') {
    lines.push(
      h.credential.refreshable === false
        ? 'credential: EXPIRED and cannot renew itself — sessions started here come up signed out'
        : 'credential: expired, and due to renew itself',
    );
  } else if (Number.isFinite(Number(h.credential?.expiresAt))) {
    const mins = Math.round((Number(h.credential.expiresAt) - Date.now()) / 60_000);
    if (mins <= 60) lines.push(`credential: ${mins <= 0 ? 'expiring now' : `${mins} minutes left`}`);
  }

  // AND WHETHER THIS BOX IS BEHIND. A host two releases back refuses verbs the
  // coordinator offers, and nothing said so until somebody tripped over it —
  // the tester met it as "does not know that command" on their sixth call.
  if (Number(h.updates?.appBehind) > 0) {
    lines.push(
      `code: ${h.updates.appBehind} commit${h.updates.appBehind === 1 ? '' : 's'} behind — it may refuse newer verbs. ` +
        'Run `agent-hub update --restart` on it.',
    );
  }
  return lines.length ? lines.join('\n') : 'ok';
}

/**
 * What the watcher has OBSERVED about a pane, as evidence rather than a verdict.
 *
 * A beta tester's sharpest request: "await detects ended-or-errored only, a
 * finished session looks exactly like an idle one, and I peeked in a loop like
 * everyone will. The fleet already watches panes well enough to answer resume
 * dialogs — the same watcher could publish its OBSERVATION. Judgement stays
 * mine; today even the evidence is manual."
 *
 * That is the right shape and the data was already here: `idleSince` and
 * `atRest` have travelled on every reply since idle tracking shipped, and
 * nothing rendered them. This does not decide a session is finished — deciding
 * is the caller's, which is docs/mcp.md's whole argument — it says how long the
 * pane has looked the same and whether it is sitting at a prompt.
 *
 * @param {any} session
 */
function describeStillness(session) {
  if (!session || typeof session !== 'object') return '';
  const since = Number(session.idleSince);
  if (!Number.isFinite(since) || since <= 0) return '';
  const mins = Math.max(0, Math.round((Date.now() - since) / 60_000));
  const how = mins < 1 ? 'less than a minute' : mins < 90 ? `${mins} minutes` : `${Math.round(mins / 60)} hours`;
  return session.atRest
    ? `The pane has been unchanged for ${how}, sitting at a ready prompt — which usually means it finished, ` +
        'and can also mean it is wedged. Reading it is the only way to tell.'
    : `The pane has been unchanged for ${how}, and is not at a prompt.`;
}

export class McpServer {
  /** @param {Options} opts */
  constructor({ coordinator, credential, allow = null, budgetMinutes = 15, fetch: doFetch = fetch, write, log = () => {},
    now = () => Date.now(),
    sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)),
    watchMs = 10_000,
    started = null,
    maxWaitMs = 0,
    setTimer = (/** @type {() => void} */ fn, /** @type {number} */ ms) => setTimeout(fn, ms).unref?.(),
  }) {
    this.coordinator = String(coordinator || '').replace(/\/+$/, '');
    this.credential = credential;
    this.budgetMinutes = budgetMinutes;
    // The tools describe THIS transport. A ceiling the caller cannot see is a
    // plan built on a number that will not be honoured.
    this.tools = toolsFor({ allow, budgetMinutes, maxWaitSeconds: maxWaitMs ? Math.floor(maxWaitMs / 1000) : 900 });
    // SESSIONS THIS SERVER STARTED. `stop` is withheld in general — ending work
    // that is not yours is not something an agent should reach for unasked —
    // but an agent that STARTED a session must be able to end it, or the
    // instructions below are asking for something it cannot do.
    // INJECTABLE, because a transport may have to supply the memory. Over
    // stdio the conversation is the process and a fresh Set is right; over HTTP
    // each request builds a new server, so the set is handed in per credential
    // (src/mcp/http.js) or `stop` refuses what this caller just started.
    /** @type {Set<string>} */
    this.started = started || new Set();
    // WRAPPED, NEVER STORED BARE. `this.fetch = fetch` then `this.fetch(...)`
    // calls the global with an McpServer as its receiver, and Cloudflare's
    // runtime refuses that:
    //
    //     Illegal invocation: function called with incorrect `this` reference.
    //
    // Node's fetch tolerates it, so every test passed, stdio worked, and the
    // Worker failed on EVERY tool call — deterministically, below the layer
    // that writes the good refusals, so the fleet answered nothing at all.
    // TRUE WHERE IT WAS WRITTEN, QUIETLY FALSE ONE LAYER UP, in the layer that
    // exists to carry the other layers.
    //
    // The arrow calls doFetch with `this` undefined, which is what a global
    // wants and what an injected test double does not care about.
    this.fetch = (/** @type {any} */ url, /** @type {any} */ init) => doFetch(url, init);
    // Every reply goes through here so the transport is injectable and the
    // whole server is testable without a pipe.
    this.write = write || ((line) => process.stdout.write(`${line}\n`));
    this.log = log;
    // Injected so a test can wait without waiting. A blocking tool tested with
    // real time is a test nobody runs.
    this.now = now;
    this.sleep = sleep;
    this.logLevel = 'info';
    // How often the watcher looks. 0 turns it off — for a client that shows
    // notifications to the person rather than the model, a session finishing is
    // a line they did not ask for.
    this.watchMs = watchMs;
    this.maxWaitMs = maxWaitMs;
    this.setTimer = setTimer;
    this.watching = false;
    /** @type {Map<string, string>} */
    this.seen = new Map();
  }

  /**
   * Tell the client when a session needs a person or finishes.
   *
   * BEST EFFORT, AND THAT IS A REAL KIND OF FEATURE. A server cannot make a
   * client wake a model — some surface these to it, some show them to the
   * person, some drop them — but "not guaranteed" is the ordinary shape of an
   * MCP capability, not a reason to leave the convention unfollowed. A client
   * that supports logging gets told; one that does not is exactly where it was.
   *
   * `fleet_await` remains the path that always works. This is the courtesy on
   * top of it, for the case that matters most: an agent that has moved on and
   * would otherwise never look again.
   *
   * Only sessions started in this conversation are watched — the same set
   * `stop` is scoped to. Watching the fleet would mean narrating somebody
   * else's work to an agent that has no business in it.
   */
  /** @param {string} level @param {string} text @param {Record<string, any>} data */
  #notify(level, text, data) {
    this.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { level, logger: 'fleetwright', data: { message: text, ...data } },
      }),
    );
  }

  /**
   * Watch what this conversation started, and say when something changes.
   *
   * Started lazily by the first `start`, and stopped when nothing is running —
   * a timer left alive after the last session is a stdio server that will not
   * exit, which looks to a client like a hung process.
   */
  #watchStarted() {
    if (this.watching || !this.watchMs) return;
    this.watching = true;
    const tick = async () => {
      if (!this.started.size) {
        this.watching = false;
        return;
      }
      for (const name of [...this.started]) {
        /** @type {any} */
        let session;
        try {
          /** @type {any} */
          const reply = await this.#intent('status', { name }, null);
          session = sessionFrom(reply, name);
        } catch {
          // A fleet that cannot be reached is not news worth waking anybody
          // for; the next tick will say so if it persists.
          continue;
        }
        const status = String(session?.status ?? '');
        const now = session?.awaiting ? 'awaiting' : status;
        if (now && now !== this.seen.get(name)) {
          this.seen.set(name, now);
          if (session?.awaiting) {
            // CARRIES WHAT IT IS WAITING FOR. "probe is waiting" tells an agent
            // to go and look; the question itself may be answerable without
            // looking. It also makes the notification distinguishable from the
            // tool result in a conformance run — the first attempt at measuring
            // whether these arrive was confounded because both channels said
            // the same words.
            const asking = String(session.detail ?? session.text ?? '').trim();
            this.#notify(
              'warning',
              `${name} is waiting for an answer and will not go further without one.${asking ? ` It says: ${asking}` : ''}`,
              { session: name, state: 'awaiting', ...(asking ? { asking } : {}) },
            );
          } else if (status === 'error') {
            this.#notify('error', `${name} failed. Its output is still readable with fleet_read_log.`, { session: name, state: 'error' });
          } else if (status === 'stopped') {
            this.#notify('info', `${name} has ended. Collect its output with fleet_read_log.`, { session: name, state: 'stopped' });
            this.started.delete(name);
          }
        }
      }
      if (this.started.size) {
        this.timer = this.setTimer(tick, this.watchMs);
      } else {
        this.watching = false;
      }
    };
    this.timer = this.setTimer(tick, this.watchMs);
  }

  /**
   * Wait until a session needs a person, finishes, or the clock runs out.
   *
   * ASKED DIRECTLY: "should mcp be able to notify llm a task needs help or a
   * task is complete?" — and the honest answer is that an MCP server can send
   * notifications but cannot reliably WAKE a model. A notification arrives on
   * the transport; whether it reaches the model depends on the client, and a
   * model that is not currently in a turn is not listening. Building on that
   * would produce a feature that works in one client and silently does nothing
   * in the next.
   *
   * A TOOL THAT BLOCKS NEEDS NO WAKING. The agent calls it and the return value
   * IS the notification. It works in every client, because it is just a tool
   * call that takes a while.
   *
   * The fleet already knows both facts and has for a long time — the host
   * watcher detects a session blocked on a dialog, and both events are already
   * considered worth waking a PERSON for (core.js NOTIFIABLE). This carries the
   * same two signals to the other kind of caller.
   *
   * Polling, deliberately, and slowly. The alternative is a streaming endpoint
   * on the coordinator, which is a real thing to build and to keep alive
   * through a Worker; asking every few seconds is unglamorous and cannot
   * silently stop working.
   *
   * @param {Record<string, any>} params
   * @param {string|null} host
   */
  async #await(params, host) {
    const name = String(params.name || '');
    // The ceiling is the transport's, not the caller's. Asking for ten minutes
    // over a connection that will be cut at thirty seconds is a request that
    // ends in silence rather than an answer.
    const ceiling = this.maxWaitMs ? this.maxWaitMs / 1000 : 900;
    const seconds = Math.min(ceiling, Math.max(5, Number(params.seconds) || 300));
    const deadline = this.now() + seconds * 1000;

    for (;;) {
      /** @type {any} */
      let reply;
      try {
        reply = await this.#intent('status', { name }, host);
      } catch (e) {
        return this.#text(describeFailure(e), true);
      }
      if (reply?.ok === false) return this.#text(String(reply.text ?? 'refused'), true);

      const session = sessionFrom(reply, name);
      const status = String(session?.status ?? '');
      // NEEDS A PERSON. The one state where waiting longer changes nothing:
      // something is blocking on an answer, and nobody is going to give it.
      if (session?.awaiting) {
        return this.#text(
          `${name} is waiting for an answer:\n${String(session.detail ?? session.text ?? '').trim()}\n\n` +
            'It will not go further until somebody answers. Read it with fleet_read_log if you need the whole story.',
        );
      }
      if (status === 'stopped' || status === 'error') {
        return this.#text(
          `${name} has ${status === 'error' ? 'failed' : 'ended'}. ` +
            'Its output is still readable with fleet_read_log — that survives the session, unlike the pane.',
          status === 'error',
        );
      }
      if (this.now() >= deadline) {
        // NOT AN ERROR. Still running after the time asked for is an answer,
        // and calling it a failure would push an agent into stopping work that
        // is going fine.
        const still = describeStillness(session);
        return this.#text(
          `${name} is still running after ${seconds}s. That is not a failure — it may just be slow. ` +
            (still ? `${still} ` : '') +
            (this.maxWaitMs
              ? 'This connection caps a single wait, so call fleet_await again to keep waiting. '
              : '') +
            'Or read it with fleet_read_log, or stop it if you have what you need.',
        );
      }
      await this.sleep(Math.min(5000, Math.max(1000, deadline - this.now())));
    }
  }

  /**
   * What the agent using this needs to know, in the one field MCP has for it.
   *
   * Deliberately about OWNERSHIP AND COST rather than about the API. An agent
   * that knows the verbs and not the consequences will start a runner, get its
   * answer, and leave a Mac idling until a timer nobody mentioned kills it.
   */
  #instructions() {
    return [
      'This fleet runs Claude Code sessions on real machines. You are a member of it, with one',
      "person's visibility — you see and can do exactly what they can.",
      '',
      'WORK YOU START IS WORK YOU OWN.',
      `Sessions are expected to finish within about ${this.budgetMinutes} minutes. Nothing in the fleet`,
      'reports "done" — a finished session looks exactly like an idle one — so deciding it is over is',
      'your job, not something you will be told.',
      '',
      'A SESSION YOU START COMES UP IDLE, AND YOU CANNOT GIVE IT A TASK.',
      'This is the first thing to know, because the obvious reading of fleet_start is wrong and the',
      'failure is silent. `brief` is a note for whoever opens the session later — it is stored, never',
      'typed in, never seen by the model in it. No verb sends text to a session. So a session you start',
      'and then wait on will sit at an empty prompt until it times out, with an empty log and no error',
      'anywhere. Two testers lost a session to that loop before anybody noticed it could not work.',
      '',
      'WHAT TO DO INSTEAD: start it, then hand the Remote Control URL from the reply to the person you',
      'are working with. They can drive it and you cannot. That is a handoff, not a failure — the fleet',
      'gets them a machine, and they bring the instructions.',
      '',
      'If nobody is going to drive it, do not start it.',
      '',
      'When a person IS driving, and you are watching on their behalf:',
      '  1. fleet_start, naming a host or a tag if you want a particular kind of machine',
      '  2. fleet_await — returns when the session ends or errors, or the wait runs out. Do not poll.',
      '     It cannot tell you a session is merely waiting at a prompt; fleet_status reports how long',
      '     the pane has been still, which is evidence rather than an answer.',
      '  3. fleet_read_log to collect what it produced — BEFORE stopping it, because stopping discards',
      '     the container output. A resumed session brings its transcript back; a stopped one does not.',
      '  4. fleet_stop WHEN YOU HAVE WHAT YOU CAME FOR, or when the time above has passed',
      '',
      'You may only stop sessions you started in this conversation. Anything else belongs to a person',
      'who is probably still using it.',
      '',
      'TEMPORARY HOSTS COST MONEY WHILE THEY LIVE. A host named gha-… is a CI runner: it exists for',
      'one job, belongs to whoever started it, and is destroyed when its job ends — taking any session',
      'on it with it. It is never chosen for you, so reaching one means naming it. Work left running',
      'there is not saved anywhere and is billed until the runner expires.',
      '',
      'TAGS PICK A KIND OF MACHINE. Pass `tag: "macos"` or `tag: "linux"` and the fleet finds a permanent',
      'host carrying it. If the only match is temporary you are told its name rather than sent there — a',
      'runner is offered, never chosen for you.',
      '',
      'Refusals name a reason. Read it — "claude is not logged in on deb132" is a different problem',
      'from "no hosts", and retrying will fix neither.',
    ].join('\n');
  }

  /** @param {string} line */
  async handleLine(line) {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      // No id to answer against, so there is nobody to tell. Logging to stderr
      // rather than stdout matters: stdout IS the protocol, and a stray line
      // there desynchronises the client.
      this.log('mcp: ignored a line that was not JSON');
      return;
    }
    // A BATCH IS A LIST, on this transport too. The array was handed straight
    // to handleMessage, where `array.id` is undefined — so it was treated as a
    // notification, answered with nothing, and the error swallowed. Silently:
    // no reply, no stderr. The HTTP transport handled the same batch correctly,
    // which made "the identical conversation in a different envelope" false in
    // the one place it is written down. The revisions this server advertises
    // require a server to accept one.
    if (Array.isArray(message)) {
      const replies = [];
      for (const one of message) {
        const reply = await this.handleMessage(one);
        if (reply) replies.push(reply);
      }
      // All notifications: nothing to write. Answering `[]` is a JSON-RPC error.
      if (replies.length) this.write(JSON.stringify(replies));
      return;
    }
    const reply = await this.handleMessage(message);
    if (reply) this.write(JSON.stringify(reply));
  }

  /**
   * One JSON-RPC message in, one reply out — or null when there is nobody to
   * answer.
   *
   * SEPARATE FROM THE FRAMING, so the same server works over stdio and over
   * HTTP. A remote transport is a different envelope around the identical
   * conversation, and a second implementation of the conversation is a second
   * thing to get wrong.
   *
   * @param {any} message
   * @returns {Promise<any|null>}
   */
  async handleMessage(message) {
    // A NOTIFICATION HAS NO ID AND GETS NO REPLY. Answering one is a protocol
    // error that some clients tolerate and others hang on.
    const isNotification = message.id === undefined || message.id === null;
    try {
      const result = await this.#dispatch(message);
      if (isNotification || result === undefined) return null;
      return { jsonrpc: '2.0', id: message.id, result };
    } catch (e) {
      if (isNotification) return null;
      const err = /** @type {any} */ (e);
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: typeof err.code === 'number' ? err.code : -32603, message: String(err.message || err) },
      };
    }
  }

  /** @param {any} message */
  async #dispatch(message) {
    switch (message.method) {
      case 'initialize': {
        // The client's revision when it is one we know; ours otherwise, which
        // is what tells a client it is talking to something older.
        const asked = String(message.params?.protocolVersion || '');
        const agreed = PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0];
        return {
          protocolVersion: agreed,
          // LOGGING, because that is the convention for a server with something
          // to say. Support varies — some clients surface these to the model,
          // some show them to the person, some drop them — and that is the
          // ordinary shape of an MCP capability rather than a reason to skip
          // one. Declaring it is how a client that DOES support it finds out.
          //
          // fleet_await stays the guaranteed path. This is the courtesy on top.
          capabilities: { tools: {}, logging: {} },
          serverInfo: { name: 'fleetwright', version: '1' },
          // THE CONTRACT, HANDED TO THE MODEL. This is the answer to "nothing
          // reports completion": the fleet does not need a new signal if the
          // thing driving it is told what it owns and what it costs. A deadline
          // in prose that the agent can act on beats a callback that has to be
          // built, and it is honest about who is deciding.
          instructions: this.#instructions(),
        };
      }
      // Notifications. Answered with undefined so nothing is written.
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined;
      case 'tools/list':
        return {
          tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        };
      case 'tools/call':
        return await this.#call(message.params || {});
      case 'logging/setLevel':
        // Accepted and honoured. A server that declares the capability and
        // then ignores the level is worse than one that never declared it.
        this.logLevel = String(message.params?.level || 'info');
        return {};
      case 'ping':
        return {};
      default: {
        const e = new Error(`unknown method ${message.method}`);
        /** @type {any} */ (e).code = -32601;
        throw e;
      }
    }
  }

  /** @param {{ name?: string, arguments?: Record<string, any> }} params */
  async #call({ name, arguments: args = {} }) {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      // NAMES WHAT IS AVAILABLE. A verb left out on purpose and a verb that
      // does not exist are different situations, and an agent told only "no"
      // will try again differently rather than stop.
      const withheld = DEFAULT_DENY.includes(String(name || '').replace(/^fleet_/, ''));
      return this.#text(
        withheld
          ? `${name} is not exposed by this server. It restarts machines, permanently destroys work, or moves ` +
              'credentials, so it is withheld from an agent by default — a policy about what to reach for ' +
              'unasked, not a lock.\n' +
              // NAMES THE LIFT. This said "ask the person running it", and a
              // beta tester WAS the person running it — with no way to know a
              // lift existed or what it was called. A refusal that hides its
              // own remedy from the one person who can apply it is worse than
              // a flat no.
              `Whoever runs this server can allow it with AGENT_FLEET_MCP_ALLOW=${String(name).replace(/^fleet_/, '')} ` +
              'in its environment. If that is you, that is the whole change.'
          : `No such tool: ${name}. Available: ${this.tools.map((t) => t.name).join(', ')}.`,
        true,
      );
    }

    const { host, tag, ...params } = args;

    // THE SERVER ENFORCES ITS OWN SCHEMA. It declared `required` and
    // `additionalProperties: false` and checked neither, trusting the client to
    // — so a caller who wrote `session:` instead of `name:` had it forwarded
    // silently, and the missing `name` became the literal string "undefined"
    // inside a refusal: `No host reports a session named "undefined"`.
    //
    // A beta tester spent their only documentation lookup working that out.
    // The schema already holds the answer; nothing was reading it.
    const declared = tool.inputSchema?.properties ?? {};
    const unknown = Object.keys(params).filter((k) => !(k in declared));
    if (unknown.length) {
      const near = (/** @type {string} */ bad) => {
        // Name the likely intent rather than only the mistake. `session` and
        // `name` are the pair that cost the tester their lookup.
        const options = Object.keys(declared).filter((k) => k !== 'host' && k !== 'tag');
        const hit = options.find((o) => o.includes(bad) || bad.includes(o) || (bad === 'session' && o === 'name'));
        return hit ? ` — did you mean \`${hit}\`?` : '';
      };
      return this.#text(
        `${tool.name} takes no parameter ${unknown.map((u) => `\`${u}\``).join(', ')}${near(unknown[0])} ` +
          `It takes: ${Object.keys(declared).join(', ')}.`,
        true,
      );
    }
    for (const need of tool.inputSchema?.required ?? []) {
      // MISSING IS NOT "undefined". A required parameter absent is a question
      // about the call, and answering it with a search for a session literally
      // named "undefined" sends somebody looking at the fleet.
      if (params[need] === undefined || params[need] === '') {
        return this.#text(`${tool.name} needs \`${need}\`, and none was given.`, true);
      }
    }

    // A LOCAL TOOL — the waiting happens here, not in the fleet.
    if (tool.local) return await this.#await(params, host ? String(host) : null);

    // ONLY WHAT THIS CONVERSATION STARTED. The instructions ask the agent to
    // clean up after itself, which means `stop` has to be available — and an
    // agent that could stop anything would eventually stop somebody's work
    // because a name looked familiar. The check lives here rather than in the
    // coordinator because it is about this SESSION of the server, which is the
    // only place that knows what "you started it" means.
    // SCOPED EXACTLY AS `stop` IS, and for the same reason. `forget` is exposed
    // now because the seven-day recycle bin made it the RECOVERABLE one — but
    // an agent that could forget anything would eventually forget somebody's
    // work because a name looked familiar. Clearing up after itself is tidy;
    // clearing up after other people is not its call.
    if ((tool.verb === 'stop' || tool.verb === 'forget') && !this.started.has(String(params.name || ''))) {
      return this.#text(
        `${params.name || 'that session'} was not started in this conversation, so it is not yours to ${tool.verb}. ` +
          'It belongs to somebody who is probably still using it.',
        true,
      );
    }

    /** @type {any} */
    let reply;
    try {
      reply = await this.#intent(tool.verb, params, host ? String(host) : null, tag ? String(tag) : null);
    } catch (e) {
      // A TOOL ERROR, NOT A PROTOCOL ERROR. The call was well-formed. isError
      // lets the agent see it and carry on rather than the client treating the
      // session as broken.
      return this.#text(describeFailure(e), true);
    }

    // Remembered only on success, and forgotten when stopped — so the set is
    // what is actually running because of this conversation.
    //
    // This block was here TWICE, near-identically, and only the surviving copy
    // starts the watcher. Harmless while they agreed; the next edit to one of
    // them is where that stops being true.
    if (reply?.ok !== false) {
      // THE NAME THE FLEET CHOSE, when the caller did not choose one.
      //
      // This read `params.name || reply.name`, and a reply has no `name` — it
      // carries `sessions: [record]`, the same shape that made fleet_await
      // blind. So `start` with no name recorded NOTHING, and the session the
      // fleet had just auto-named was unstoppable for the rest of the
      // conversation: `stop` answered "not started in this conversation",
      // which was false, about a session started fifteen seconds earlier.
      //
      // An agent worked this out from behaviour alone — the named session
      // stopped, the auto-named one never did — after three attempts at the
      // wrong fix, and left an idle session occupying a slot.
      const named = String(params.name || sessionFrom(reply)?.name || '');
      if (named && (tool.verb === 'start' || tool.verb === 'resume')) {
        this.started.add(named);
        this.#watchStarted();
      }
      if (tool.verb === 'stop' || tool.verb === 'forget') this.started.delete(named);
    }

    // Refusals arrive as data, and they name a reason — that is the property
    // the protocol was built for and the one an agent most needs, so it is
    // passed through rather than flattened into "failed".
    // WHERE IT LANDED. `start` answered "Started X in /home/user/agent-runs" and
    // never said which box, so on a two-host fleet finding out cost a
    // `fleet_list` and a scan — and the tool that then wants to read its log
    // asks you which box it was. Both beta testers filed this.
    //
    // The reply carries the hostId; nothing was putting it on the screen.
    if (reply?.ok !== false && (tool.verb === 'start' || tool.verb === 'resume')) {
      const landed = reply?.hostId || sessionFrom(reply)?.hostId;
      if (landed && !String(reply?.text ?? '').includes(landed)) {
        reply = { ...reply, text: `${reply?.text ?? ''}\nOn ${landed}.` };
      }
      // AND IT SAYS THE SESSION IS IDLE, which is the part nothing said.
      //
      // `brief` is stored and never delivered, so the loop these instructions
      // teach — start, await, read_log — produces an idle REPL, an empty log
      // and no error anywhere. A beta tester followed it exactly and lost the
      // session to it; on a paid runner that loop burns money until the budget
      // deadline.
      //
      // Delivering a task at start needs a protocol decision that is not made
      // yet (docs/task-at-start.md, #325). Saying so does not, and silence is
      // the expensive half: an agent told the session is idle stops waiting
      // for output that is never coming.
      if (tool.verb === 'start') {
        reply = {
          ...reply,
          text:
            `${reply?.text ?? ''}\n\nIT STARTED IDLE. Nothing here can hand it work — \`brief\` is a note for ` +
            'people, not a prompt, and no verb sends text to a session. Waiting on it will time out rather ' +
            'than finish.\n' +
            (reply?.rcUrl
              ? `Give this to the person who wants the work done and they can drive it: ${reply.rcUrl}`
              : 'Whoever wants the work done has to drive it, from the app or the session\'s Remote Control link ' +
                '— which appears on fleet_status once the session has published one.'),
        };
      }
    }

    // THE EVIDENCE, WHERE THE QUESTION IS ASKED. `status` and `peek` are what
    // somebody calls to find out whether work is done, and the watcher's
    // observation was arriving on the same reply unrendered.
    if (reply?.ok !== false && (tool.verb === 'status' || tool.verb === 'peek')) {
      const still = describeStillness(sessionFrom(reply, String(params.name || '')));
      if (still) reply = { ...reply, text: `${reply?.text ?? ''}\n\n${still}` };
    }

    const failed = reply?.ok === false;
    // THE PAYLOAD, WHEN THE TEXT DOES NOT CARRY IT. `health` answers
    // `{ ok: true, text: 'ok', health: {…} }`, and rendering `text` alone made
    // fleet_health return the single word "ok" — for a tool whose whole
    // description is "capacity and load". The interesting half was fetched,
    // sent across the fleet, and thrown away at the last hop.
    if (!failed && reply?.health && typeof reply.health === 'object') {
      return this.#text(describeHealth(reply.health), false);
    }
    const body = reply?.text ?? JSON.stringify(reply, null, 1);
    return this.#text(String(body), failed);
  }

  /**
   * @param {string} verb
   * @param {Record<string, any>} params
   * @param {string|null} host
   * @param {string|null} [tag]
   */
  async #intent(verb, params, host, tag = null) {
    const res = await this.fetch(`${this.coordinator}/api/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.credential}` },
      // Placement travels BESIDE the intent, never inside its params — a host
      // validates the intent, and a tag is not part of what it was asked to do.
      body: JSON.stringify({ verb, params, ...(host ? { host } : {}), ...(tag ? { tag } : {}) }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('this credential was refused — it may have been revoked from the app');
    }
    return await res.json();
  }

  /** @param {string} text @param {boolean} [isError] */
  #text(text, isError = false) {
    return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
  }
}
