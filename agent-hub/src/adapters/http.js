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
import { dispatch } from './commands.js';
import { describe } from '../core/login.js';
import { log } from '../log.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export class HttpAdapter {
  /**
   * @param {import('../config.js').Config} cfg
   * @param {{ sessions: import('../core/sessions.js').SessionManager, login: import('../core/login.js').LoginFlow }} deps
   */
  constructor(cfg, { sessions, login }) {
    this.cfg = cfg;
    this.sessions = sessions;
    this.login = login;
    /** @type {import('node:http').Server|null} */
    this.server = null;
    // Read once at startup: the UI is a single static file and re-reading it
    // per request buys nothing.
    this.html = readFileSync(path.join(HERE, '..', 'web', 'index.html'), 'utf8');
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
        const gate = this.cfg.token ? 'token required' : 'no token (loopback only)';
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
        loginPending: this.login.isPending() ? { url: this.login.pending?.url ?? null } : null,
        sessions,
      });
    }

    // One command endpoint rather than a REST verb per action: the web UI and
    // the chat adapters then genuinely share a code path, so a command can
    // never work in one surface and be missing from the other.
    if (p === '/api/command' && method === 'POST') {
      const body = await readJson(req);
      const line = String(body.command || '');
      log.info(`http: ${clientLabel(req)} → ${line.slice(0, 120)}`);
      const reply = await dispatch(
        { sessions: this.sessions, login: this.login, cfg: this.cfg, actor: 'web' },
        line,
      );
      return json(res, 200, reply);
    }

    if (p === '/api/peek' && method === 'GET') {
      const name = url.searchParams.get('name') || '';
      const text = this.sessions.peek(name, 60);
      if (text === null) return json(res, 404, { error: 'not running' });
      return json(res, 200, { name, text });
    }

    return json(res, 404, { error: 'not found' });
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {URL} url
   */
  #authorised(req, url) {
    // No token configured is only reachable on loopback (config.js refuses to
    // start otherwise), so there is nothing to check.
    if (!this.cfg.token) return true;

    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const cookie = readCookie(req.headers.cookie || '', 'agent_hub_token');
    const query = url.searchParams.get('token') || '';

    return [bearer, cookie, query].some((v) => v && safeEqual(v, this.cfg.token));
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
