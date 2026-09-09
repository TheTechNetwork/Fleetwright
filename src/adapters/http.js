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
    // The same, for the two versions of the page an unauthenticated browser
    // gets. Built at startup because building them per request would mean
    // reading the stylesheet on a path anybody can reach without a token.
    this.gatePage = gatePage(false);
    this.refusedPage = gatePage(true);
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
        // can act on, not a bare 401 body — and "act on" is a field it can
        // type into, because the thing it would be told to do by hand is a
        // query parameter this same route reads twenty lines below.
        //
        // REFUSED IS NOT THE SAME SCREEN AS NOT ASKED. If a credential came
        // with the request it was wrong, and the page says so rather than
        // repeating the instructions at somebody who has already followed
        // them. That is docs/psychology.md §7 on the smallest surface in the
        // product: the difference between "you have not tried" and "that one
        // does not work" is the whole answer, and it is free to publish.
        res.writeHead(401, {
          'content-type': 'text/html; charset=utf-8',
          // A cached 401 outlives the token that would have fixed it.
          'cache-control': 'no-store',
        });
        return res.end(presentedCredential(req, url) ? this.refusedPage : this.gatePage);
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
        // `Secure` when the browser reached us over TLS — which behind the
        // Cloudflare Tunnel the comment at the top of this file recommends is
        // every time, and which the tunnel says so with x-forwarded-proto.
        // Not unconditionally: on the loopback default this is plain http,
        // and a Secure cookie there is one the browser never sends back, so
        // "?token= once" would silently stop working on the box itself.
        const tls = req.socket && /** @type {any} */ (req.socket).encrypted
          || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
        headers['set-cookie'] = `agent_hub_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${tls ? '; Secure' : ''}`;
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
        // NULL IS CANNOT TELL, and the health frame already treats it that way
        // — sidecar.js reads this as a number or null and both phones render
        // the null as "not reported" rather than as zero.
        //
        // It has to be caught HERE rather than swallowed in list(): a store
        // that refuses used to answer [] and this reported nobody linked, on a
        // box with people linked. Letting it throw instead would take the whole
        // of /api/state with it, which is a worse answer than an honest gap.
        claudeAccounts: (() => {
          try {
            return new Accounts(this.cfg.stateDir).list().length;
          } catch {
            return null;
          }
        })(),
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
        // WHAT THE SIDECAR ALREADY KNOWS THIS BOX IS LABELLED, comma-joined.
        // agent-hub can derive the auto labels itself — it owns the config they
        // come from — but AGENT_FLEET_LABELS is in the SIDECAR's env file and
        // nothing here can read it. Without this, `/labels -arm64` would say
        // "this box does not have that" about a label the app is displaying.
        //
        // Context and not an argument, by the same rule as the two above: it is
        // something this box was given rather than something a caller typed.
        // Charset-checked here rather than trusted from its usual caller,
        // because a value validated only by its usual caller is validated only
        // until there are two.
        ['hostLabels', /^[A-Za-z0-9][A-Za-z0-9_.,-]{0,1023}$/],
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
        // Split back into a list here, so a command reads labels and never a
        // string it has to remember to parse.
        { sessions: this.sessions, login: this.login, cfg: this.cfg, actor, ...meta,
          ...(meta.hostLabels ? { hostLabels: String(meta.hostLabels).split(',').filter(Boolean) } : {}) },
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

// --- the page a browser gets instead of the UI -------------------------------
//
// THE ONE SCREEN THAT WAS NOT IN THE DESIGN SYSTEM. This page used to be a
// string of inline styles — `system-ui`, `34rem`, `4rem`, one colour nowhere
// and therefore whatever the browser's default was — while the stylesheet
// next door defined a type scale, six steps of space, five radii and two
// palettes. It is the first thing a person sees on a box they have just
// stood up, and it looked like a different product from the one they were
// about to open.
//
// WHERE THE NUMBERS COME FROM, which is the decision worth recording. There
// were two ways to give this page the design system and only one of them
// survives contact with `test/design-parity.test.js`:
//
//   Write the literals here.   Rejected. A colour written twice is a colour
//                              that drifts, and the whole reason that test
//                              reads three files is that three copies of
//                              `#3866D6` did exactly this. A fourth copy on
//                              the least-visited screen in the product is the
//                              copy nobody would notice going stale.
//
//   Grow parity a 4th surface. Rejected too, for the opposite reason. That
//                              test asserts a surface declares EVERY token in
//                              the table, both themes — twenty colours and
//                              twenty-one numbers. This page uses a third of
//                              them, so passing would mean shipping tokens no
//                              rule here references, on an unauthenticated
//                              path, forever.
//
// So it does neither: it READS the palette out of `console.css` at startup and
// keeps only the tokens its own rules use. One place a web colour is written,
// no fourth copy to keep in step, and `test/gate-page.test.js` holds the half
// that is left — that every `var(--…)` below is a token the stylesheet really
// declares, and that this file writes no colour of its own.
//
// The light overrides are read from the `prefers-color-scheme` block rather
// than the `[data-theme]` one because this page has no theme switch to honour.
// design-tokens.test.js already holds those two blocks identical, so which one
// is read is not a choice about which values arrive.

/** Every token the rules below reference. Kept in step by test/gate-page.test.js. */
const GATE_TOKENS = [
  '--font', '--mono',
  '--t-greeting', '--t-body', '--t-body-small', '--t-label',
  '--ls-greeting',
  '--s-page', '--s-group', '--s-group-tight', '--s-inside', '--s-inside-tight', '--s-hair',
  '--r-card', '--r-row', '--r-chip',
  '--bg', '--card', '--inner', '--ink', '--ink-dim', '--accent', '--bad',
  '--ring', '--highlight', '--shadow-drop', '--card-shadow',
];

/**
 * The body of `<opener> … { … }`, brace-matched.
 *
 * Deliberately small, and it can be: `console.css` has no nested rules and is
 * written to be read this way — test/design-tokens.test.js and
 * test/design-parity.test.js both already parse it with the same few lines.
 *
 * @param {string} css @param {string} opener
 */
function cssBlock(css, opener) {
  const at = css.indexOf(opener);
  if (at < 0) throw new Error(`console.css no longer has ${opener}`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}' && (depth -= 1) === 0) return css.slice(open + 1, i);
  }
  throw new Error(`console.css never closes ${opener}`);
}

/**
 * `--name: value` pairs from a rule body, commentary removed so a note about a
 * token is never read as one.
 *
 * @param {string} body
 */
function cssDeclarations(body) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [, name, value] of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim().replace(/\s+/g, ' ');
  }
  return out;
}

/**
 * The design system's palette and scale, narrowed to what this page uses.
 *
 * @param {string[]} names
 * @returns {string} a stylesheet fragment: the base palette, then the light one
 */
function borrowedPalette(names) {
  const css = readFileSync(resource('src', 'web', 'console', 'console.css'), 'utf8');
  const dark = cssDeclarations(cssBlock(css, ':root {'));
  const light = cssDeclarations(cssBlock(css, ":root:not([data-theme='dark']) {"));

  const emit = (/** @type {Record<string, string>} */ from) =>
    names.filter((n) => from[n]).map((n) => `${n}:${from[n]}`).join(';');

  const missing = names.filter((n) => !dark[n]);
  if (missing.length) throw new Error(`console.css no longer declares ${missing.join(', ')}`);

  return `:root{color-scheme:dark light;${emit(dark)}}`
    + `@media (prefers-color-scheme:light){:root{${emit(light)}}}`;
}

/**
 * Did this request carry a credential at all?
 *
 * Not "was it valid" — #authorised has already said no. This separates the
 * person who has not been given a token yet from the one whose token, cookie
 * or header is wrong, because those two need different sentences and only one
 * of them is helped by being told how tokens work.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {URL} url
 */
function presentedCredential(req, url) {
  return url.searchParams.has('token')
    || Boolean(req.headers.authorization)
    || Boolean(readCookie(String(req.headers.cookie || ''), 'agent_hub_token'));
}

/**
 * The whole page, as one response.
 *
 * ONE RESPONSE IS A CONSTRAINT, NOT A SHORTCUT. Every byte a browser would
 * have to come back for — a stylesheet, a font, a script — would be a second
 * request on a path that has no token, so the CSS is inlined and there is no
 * script at all. Which also means the form has to work without one: it is a
 * plain GET to `/`, whose `token` parameter this same route reads and turns
 * into a cookie. Nothing here is a control that does not do anything.
 *
 * @param {boolean} refused  a credential came with the request and was wrong
 */
function gatePage(refused) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agent-hub — a token is required</title>
<style>
${borrowedPalette(GATE_TOKENS)}
*{box-sizing:border-box}
body{
  margin:0;
  /* The page centres its one card rather than sitting under the top edge:
   * there is exactly one thing to do here and no second screen to scroll to.
   * Centred by margin:auto on the card and not by align-items, which
   * clips the top of a flex child taller than its line — which this card
   * becomes at 200% zoom on a short screen. */
  min-height:100dvh;
  display:flex;
  padding:var(--s-page);
  background:var(--bg);
  color:var(--ink);
  font-family:var(--font);
  font-size:var(--t-body);
  line-height:1.5;
  -webkit-text-size-adjust:100%;
}
.gate{
  margin:auto;
  width:100%;
  /* Wide enough for the two code spans below to sit on one line on a laptop,
   * and it is a max rather than a width, so the phone gets the whole column. */
  max-width:34rem;
  background:var(--card);
  border-radius:var(--r-card);
  box-shadow:var(--card-shadow);
  padding:var(--s-group);
}
${refused ? `.gate{box-shadow:inset 0 1px 0 var(--highlight),var(--shadow-drop),0 0 0 1px color-mix(in srgb,var(--bad) 55%,transparent)}\n` : ''}\
h1{
  margin:0;
  font-size:var(--t-greeting);
  font-weight:600;
  letter-spacing:var(--ls-greeting);
}
.lede{margin:var(--s-inside) 0 0;color:var(--ink-dim)}
/* Refused states are a word and a glyph first. The glyph is the x the
 * session vocabulary already uses for broken, in the mono face, so the tone
 * agrees with something that is readable without it. */
.refused{
  display:flex;
  align-items:baseline;
  gap:var(--s-inside-tight);
  margin:var(--s-inside) 0 0;
  color:var(--bad);
  font-size:var(--t-body-small);
}
.refused .glyph{font-family:var(--mono);font-weight:700}
form{
  display:flex;
  flex-wrap:wrap;
  gap:var(--s-inside-tight);
  margin:var(--s-group) 0 0;
}
label{
  flex:1 0 100%;
  color:var(--ink-dim);
  font-size:var(--t-label);
}
input{
  /* min-width:0 so the field may shrink below its intrinsic size instead of
   * pushing the button off a 390px screen. */
  flex:1 1 12rem;
  min-width:0;
  min-height:44px;
  padding:0 var(--s-inside);
  background:var(--inner);
  color:var(--ink);
  border:0;
  border-radius:var(--r-row);
  /* A HEAVIER EDGE THAN THE SYSTEM'S HAIRLINE, and the only place on this page
   * that departs from it. An empty field carries no text of its own, so its
   * boundary is the entire signal that it is there and can be typed into, and
   * --ring is a 7%-white hairline that does not come near the 3:1 WCAG
   * 1.4.11 asks of a control's edge. --ink-dim does: 5.9:1 on the card in
   * dark, 6.0:1 in light. The button keeps the hairline, because it has a
   * label doing that job. */
  box-shadow:0 0 0 1px var(--ink-dim);
  font:inherit;
  font-family:var(--mono);
}
button{
  /* 44px, and it wraps under the field rather than shrinking, because this is
   * opened on a phone at least as often as on a laptop. */
  flex:0 1 auto;
  min-height:44px;
  padding:0 var(--s-group-tight);
  background:var(--inner);
  color:var(--ink);
  border:0;
  border-radius:var(--r-row);
  box-shadow:0 0 0 1px var(--ring);
  font:inherit;
  font-size:var(--t-body-small);
  cursor:pointer;
}
/* MOTION 1: hover and state only, and nothing transitions into it. */
input:hover,button:hover{box-shadow:0 0 0 1px var(--accent)}
input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.note{margin:var(--s-group-tight) 0 0;color:var(--ink-dim);font-size:var(--t-body-small)}
code{
  font-family:var(--mono);
  font-size:var(--t-label);
  background:var(--inner);
  border-radius:var(--r-chip);
  padding:0 var(--s-hair);
  /* A long token or header name breaks inside the span instead of pushing the
   * card wider than the screen. */
  overflow-wrap:anywhere;
}
/* Forced-colours mode paints no box-shadow, and a card separated only by one
 * is then not separated at all — the same rule, and the same reason, as the
 * bottom of console.css. */
@media (forced-colors:active){
  .gate,input,button{border:1px solid}
}
</style>
<main class="gate">
  <h1>agent-hub</h1>
  <p class="lede">This is a host in a fleet, and it has no sign-in — one token opens everything it serves.</p>
${refused ? '  <p class="refused"><span class="glyph" aria-hidden="true">x</span> <span>The token this browser sent was not accepted.</span></p>\n' : ''}\
  <form method="get" action="/">
    <label for="token">Token</label>
    <input id="token" name="token" type="password" required autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
    <button type="submit">Remember this token</button>
  </form>
  <p class="note">Sending it here is the same as appending <code>?token=…</code> to this address once — the answer sets a cookie, so it is not in every link afterwards. A program should send an <code>Authorization: Bearer …</code> header instead and carry no cookie at all.</p>
</main>
`;
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
    let bytes = 0;
    req.on('data', (c) => {
      body += c;
      // A request body here is a command line or a uuid. Anything approaching a
      // megabyte is either a bug or an attempt to exhaust memory. Counted in
      // BYTES off the chunk, not characters off the string: `body.length` is
      // UTF-16 units, so a body of four-byte characters was a quarter the size
      // it looked before the cap fired.
      bytes += c.length;
      if (bytes > 1_000_000) req.destroy();
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
