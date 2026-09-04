// HTTP adapter: the browser UI, a JSON API, and the endpoint the Claude Code
// SessionStart hook posts conversation uuids to.
//
// The server is ALWAYS started, even in a Telegram-only deployment, because
// the hook needs somewhere to report. What varies is the bind address:
// 127.0.0.1 by default (no token needed — reaching it already means shell
// access), and anything wider requires a token (enforced in config.js).
//
// To expose the UI: point a Cloudflare Tunnel at 127.0.0.1:8790 and leave the
// bind loopback. That way the port is never listening on a routable interface,
// and Cloudflare Access can gate it in front of the token.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

import { cleanText, TITLE_MAX, BRIEF_MAX } from '../core/text.js';
import { MAX_WRITE_BYTES } from '../core/files.js';
import { dispatch } from './commands.js';
import { describe } from '../core/login.js';
import { log } from '../log.js';
import { redactCommandLine } from '../core/redact.js';
import { readCredentialState, describeCredential } from '../core/claude-credential.js';
import { Accounts } from '../core/accounts.js';
import { pickCredentialSource } from '../core/podman.js';
import { apiTokenFile } from '../core/api-token.js';
import { resource } from '../core/resources.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export class HttpAdapter {
  /**
   * @param {import('../config.js').Config} cfg
   * @param {{ sessions: import('../core/sessions.js').SessionManager, login: import('../core/login.js').LoginFlow, token?: string|null }} deps
   */
  constructor(cfg, { sessions, login, token = null }) {
    this.cfg = cfg;
    this.sessions = sessions;
    this.login = login;
    // RESOLVED, NOT READ FROM CONFIG. An unset AGENT_HUB_TOKEN used to mean "no
    // gate at all", which stopped being defensible when the credential verbs
    // landed on this endpoint — see src/core/api-token.js. The caller passes
    // the generated one; cfg.token is only the explicitly configured case.
    this.token = token ?? cfg.token ?? '';
    /** @type {import('node:http').Server|null} */
    this.server = null;
    // Read once at startup: the UI is a single static file and re-reading it
    // per request buys nothing.
    this.html = readFileSync(resource('src', 'web', 'index.html'), 'utf8');
  }

  get name() {
    return 'http';
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.#route(req, res).catch((e) => {
          log.error('http: unhandled', e);
          json(res, 500, { error: 'internal error' });
        });
      });
      this.server.on('error', reject);
      this.server.listen(this.cfg.port, this.cfg.bind, () => {
        const gate = this.cfg.token ? 'token required' : `token required (${apiTokenFile(this.cfg.stateDir)})`;
        log.info(`http: listening on ${this.cfg.bind}:${this.cfg.port} · ${gate}`);
        resolve(true);
      });
    });
  }

  async stop() {
    await new Promise((r) => (this.server ? this.server.close(() => r(null)) : r(null)));
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async #route(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const method = req.method || 'GET';
    const p = url.pathname;

    if (p === '/healthz') return json(res, 200, { ok: true, host: this.cfg.hostname });

    // --- the SessionStart hook -------------------------------------------
    // Loopback only, and never token-gated: the hook runs as a child of a
    // claude process on this same box, and making it carry the operator token
    // would mean writing that token into a world-readable hook script.
    if (p === '/internal/session-start' && method === 'POST') {
      if (!isLoopback(req)) return json(res, 403, { error: 'loopback only' });
      const body = await readJson(req);
      const r = this.sessions.recordUuid({
        name: String(body.name || ''),
        cwd: body.cwd ? String(body.cwd) : null,
        uuid: String(body.uuid || ''),
        // What the person asked for, read out of the transcript by the hook.
        title: body.title ? String(body.title) : null,
      });
      return json(res, r.ok ? 200 : 400, r);
    }

    // --- everything below is operator surface ------------------------------
    if (!this.#authorised(req, url)) {
      if (p === '/' || p === '/index.html') {
        // A browser hitting the root without a token should get something it
        // can act on, not a bare 401 body.
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(
          '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<body style="font-family:system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem">' +
            '<h1>agent-hub</h1><p>A token is required. Append <code>?token=…</code> once and ' +
            'this browser will remember it, or send an <code>Authorization: Bearer …</code> header.</p>',
        );
      }
      return json(res, 401, { error: 'unauthorised' });
    }

    if ((p === '/' || p === '/index.html') && method === 'GET') {
      // Setting the cookie here is what makes "?token=… once" work: the UI
      // then fetches its API without carrying the token in every URL.
      const token = url.searchParams.get('token');
      /** @type {Record<string,string>} */
      const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
      if (token) {
        headers['set-cookie'] = `agent_hub_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
      }
      res.writeHead(200, headers);
      return res.end(this.html);
    }

    if (p === '/api/state' && method === 'GET') {
      const sessions = this.sessions.list();
      return json(res, 200, {
        host: this.cfg.hostname,
        workdir: this.cfg.workdir,
        maxSessions: this.cfg.maxSessions,
        running: sessions.filter((s) => s.status === 'running').length,
        loginEnabled: this.cfg.loginEnabled,
        auth: { ...this.login.status(), summary: describe(this.login.status()) },
        // WHAT A SESSION WOULD GET, which is not the same question as `auth`
        // above. `auth` reports on the box's home directory; a sandboxed
        // session runs on a COPY taken at volume creation. The two answers
        // came apart in production — "logged in" on a box where every new
        // session came up logged out — so both are published and the client
        // decides which one it is asking about.
        //
        // Never the token, and nothing derived from it: an expiry, whether
        // there is something to renew with, and the account it names. All
        // three are already visible to anyone who can run `claude auth status`
        // on the box.
        credential: this.cfg.sandbox ? credentialSummary(this.cfg) : null,
        // HOW MANY PEOPLE CAN START A SESSION HERE. Zero is the only
        // Claude-shaped fault a HOST can have now that a machine has no
        // account of its own — whose account is missing is a per-session
        // question, answered by name at the point somebody asks.
        claudeAccounts: new Accounts(this.cfg.stateDir).list().length,
        loginPending: this.login.isPending() ? { url: this.login.pending?.url ?? null } : null,
        sessions,
        // What has been forgotten but not yet deleted. Additive: an older
        // sidecar or console ignores the field, and a newer one can offer the
        // undo — a bin nobody can see is not a bin, it is a delay.
        bin: this.sessions.binned(),
      });
    }

    // One command endpoint rather than a REST verb per action: the web UI and
    // the chat adapters then genuinely share a code path, so a command can
    // never work in one surface and be missing from the other.
    if (p === '/api/command' && method === 'POST') {
      const body = await readJson(req);
      const line = String(body.command || '');

      // Prose travels beside the command, never inside it. Everything in `line`
      // gets split on whitespace, so a title with spaces would arrive as
      // arguments — and a title containing something that looks like a flag
      // would arrive as a flag. Same reasoning as the ordinal in `answer`.
      //
      // Validated with the same cleanText the fleet protocol uses. Two doors
      // into one store must not disagree about what is acceptable, and this
      // door is reachable by anything holding the hub token, not only by the
      // sidecar that already validated.
      /** @type {Record<string, string>} */
      const meta = {};
      /** @type {Array<['title'|'brief', number]>} */
      const FIELDS = [
        ['title', TITLE_MAX],
        ['brief', BRIEF_MAX],
      ];
      for (const [field, max] of FIELDS) {
        if (body[field] === undefined || body[field] === null) continue;
        const r = cleanText(body[field], { max, label: field });
        if (!r.ok) return json(res, 400, { ok: false, text: r.error });
        meta[field] = r.value;
      }

      // WHICH TASK PROFILE, which is a NAME rather than prose and so does not
      // go through cleanText — that collapses whitespace and strips control
      // characters, which would silently turn a wrong name into a different
      // wrong name. A name is exactly right or it is refused.
      //
      // It is accepted as a field as well as on the command line so that the
      // web UI and the fleet do not have to spell it differently. The content
      // is never accepted here in any form: it is a file on this box, because a
      // caller that could supply the words would be writing the instructions of
      // an agent with root in a container.
      if (body.profile !== undefined && body.profile !== null) {
        if (typeof body.profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(body.profile)) {
          return json(res, 400, { ok: false, text: 'profile must be a plain name — letters, digits, dash, underscore' });
        }
        meta.profile = body.profile;
      }

      // FILE CONTENT, WHICH DOES NOT GO THROUGH cleanText. That collapses runs
      // of whitespace and strips control characters — right for a title and
      // catastrophic for a file, which would come back reindented and with its
      // blank lines joined, reported as written. Bounded and otherwise
      // untouched, the same rule the protocol's `raw` type states.
      if (body.content !== undefined && body.content !== null) {
        if (typeof body.content !== 'string') {
          return json(res, 400, { ok: false, text: 'content must be text' });
        }
        if (Buffer.byteLength(body.content) > MAX_WRITE_BYTES) {
          return json(res, 400, { ok: false, text: 'content is larger than this will write' });
        }
        if (body.content.includes('\0')) {
          return json(res, 400, { ok: false, text: 'content contains a null byte' });
        }
        meta.content = body.content;
      }

      // WHAT A DISPATCH NEEDS AND THE COMMAND LINE MUST NOT CARRY.
      //
      // Three values, and each is here rather than in `line` for its own
      // reason. The TICKET is a credential: on the command line it would be in
      // the journal of every surface that logs one, which is the whole argument
      // src/core/redact.js is built around, and beside the command it is in
      // none of them. The REPOSITORY and the COORDINATOR are not secrets and
      // are still not arguments — they are context this box was given (one on
      // the coordinator's config frame, one from its own configuration), not
      // something the caller typed, and mixing the two on one line is how a
      // caller ends up able to supply either.
      //
      // Each is charset-checked here rather than trusted from the sidecar.
      // This endpoint is reachable by anything holding the hub token, so a
      // value that is only validated by its usual caller is validated only
      // until there are two.
      for (const [field, re] of /** @type {Array<[string, RegExp]>} */ ([
        // `fwt_<id>_<secret>`, and bounded well above it.
        ['ticket', /^[A-Za-z0-9_-]{1,128}$/],
        ['runnerRepo', /^[A-Za-z0-9._-]{1,80}\/[A-Za-z0-9._-]{1,80}$/],
        // An origin, not a URL with a path: this becomes a workflow input that
        // tells a machine which fleet to join.
        ['coordinator', /^https?:\/\/[A-Za-z0-9._-]{1,253}(:\d{1,5})?$/],
      ])) {
        if (body[field] === undefined || body[field] === null) continue;
        if (typeof body[field] !== 'string' || !re.test(body[field])) {
          // The value is not quoted back — one of these is a credential, and a
          // refusal travels to a log like every other one.
          return json(res, 400, { ok: false, text: `${field} is not in the form this accepts` });
        }
        meta[field] = body[field];
      }

      // WHO ASKED, when the caller can say.
      //
      // This used to be the literal 'web' for every HTTP caller, so every
      // session recorded "web" as its creator no matter who started it — the
      // coordinator had verified an email, the sidecar was holding it, and the
      // record one hop away could not have it.
      //
      // BE PRECISE ABOUT WHAT THIS IS WORTH. agent-hub does not verify the
      // actor and cannot: it has one token, and whoever holds that token can
      // already run any command as anyone. So this records what an
      // ALREADY-TRUSTED caller says, and it is exactly as trustworthy as the
      // hub token — no more. The verification happens at the coordinator,
      // which checks an OIDC identity before it ever gets here.
      //
      // That is still strictly better than 'web': a value that is sometimes
      // right beats one that is never informative. It is not an audit trail,
      // and docs/accounts.md says so where somebody might rely on it.
      //
      // TWO THINGS THIS MUST NOT DO, both learned from the same audit.
      //
      // The limit is 134, not 120: the protocol accepts an actor of 128
      // characters (ACTOR_RE) and the sidecar prepends `fleet:` before posting
      // it here. At 120 a verified member whose address ran long failed this
      // test — and fell through to `web`, which is not "unknown", it is THE
      // BOX. That member's credential would then be written to the shared row
      // every session on the machine reads, and they could finish a login the
      // operator had started. An identity check that degrades into a DIFFERENT
      // valid identity is worse than one that fails.
      //
      // So a supplied-but-malformed actor is now a REFUSAL rather than a
      // substitution. `web` remains the answer only when nobody claimed to be
      // anybody, which is the honest meaning of it.
      const claimed = typeof body.actor === 'string' ? body.actor.trim() : '';
      if (claimed && !/^[A-Za-z0-9._:@+-]{1,134}$/.test(claimed)) {
        return json(res, 400, { ok: false, text: 'actor is not a well-formed identity' });
      }
      const actor = claimed || 'web';

      // Redact BEFORE truncating: slicing a secret to 120 characters logs a
      // shorter secret, not a safer one.
      log.info(`http: ${clientLabel(req)} → ${redactCommandLine(line).slice(0, 120)}`);
      const reply = await dispatch(
        { sessions: this.sessions, login: this.login, cfg: this.cfg, actor, ...meta },
        line,
      );
      return json(res, 200, reply);
    }

    if (p === '/api/peek' && method === 'GET') {
      const name = url.searchParams.get('name') || '';
      const text = this.sessions.peek(name, 60);
      if (text === null) {
        // NAMES THE WAY BACK. `peek` is documented as "how you find out
        // whether work is done" and answers "not running" on every session a
        // returning user has — which is all of them, and the only ones whose
        // output they want. Resuming restores the pane and the transcript.
        const known = this.sessions.list().some((s) => s.name === name);
        return json(res, 404, {
          error: 'not running',
          text: known
            ? `"${name}" is not running, so there is no live pane to read. Resume it to bring the transcript ` +
              'back — that is usually where the output you are looking for is.'
            : `No session called "${name}".`,
        });
      }
      return json(res, 200, { name, text });
    }

    return json(res, 404, { error: 'not found' });
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {URL} url
   */
  #authorised(req, url) {
    // FAILS CLOSED. There used to be an early `return true` here for the case
    // where no token was configured, justified by the listener being on
    // loopback — which conflated "somebody has a shell on this box" with
    // "somebody has THIS SERVICE'S shell". Those differ by every other account
    // on the machine, and the endpoint now writes credentials.
    //
    // A missing token is now a refusal rather than a pass: if generation failed
    // there is no way to tell the sidecar from anything else, and answering
    // everybody is the wrong side of that to err on.
    if (!this.token) return false;

    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const cookie = readCookie(req.headers.cookie || '', 'agent_hub_token');
    const query = url.searchParams.get('token') || '';

    return [bearer, cookie, query].some((v) => v && safeEqual(v, this.token));
  }
}

// --- helpers ---------------------------------------------------------------

/**
 * Constant-time compare, length-safe.
 * @param {unknown} a @param {unknown} b
 */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** @param {import('node:http').IncomingMessage} req */
function isLoopback(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** @param {import('node:http').IncomingMessage} req */
function clientLabel(req) {
  return req.socket.remoteAddress || 'unknown';
}

/** @param {string} header @param {string} name */
function readCookie(header, name) {
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      // A request body here is a command line or a uuid. Anything approaching a
      // megabyte is either a bug or an attempt to exhaust memory.
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * The shared credential a sandboxed session inherits, described without
 * quoting any of it.
 *
 * The SHARED one specifically: this endpoint has no actor, so it cannot answer
 * "whose". `/verify claude` does that, because it runs as somebody. What this
 * answers is the question a fleet dashboard asks — is this box in a state
 * where starting a session is worth doing — and the shared credential is what
 * makes that true or false for everyone who has not linked their own.
 *
 * @param {import('../config.js').Config} cfg
 */
function credentialSummary(cfg) {
  const picked = pickCredentialSource(cfg, null);
  if (!picked.source) return null;
  const state = readCredentialState(picked.source);
  return {
    state: state.state,
    expiresAt: state.expiresAt,
    refreshable: state.refreshable,
    account: state.account,
    plan: state.plan,
    summary: describeCredential(state, 'this box'),
  };
}
