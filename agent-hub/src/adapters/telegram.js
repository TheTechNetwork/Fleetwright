// Telegram adapter — long polling, no webhook.
//
// This is why Telegram is the recommended surface: getUpdates is an OUTBOUND
// long-poll, so the box needs no public hostname, no inbound firewall rule, no
// TLS certificate and no tunnel. It works identically on a datacentre VM, a
// laptop behind NAT and a Raspberry Pi on someone's home wifi — which is the
// whole point of a tool coworkers deploy themselves.
//
// The trade for that simplicity: exactly one poller may run per bot token.
// Telegram answers a second concurrent getUpdates with HTTP 409, so two hubs
// sharing one token will fight. One bot per hub.

import { dispatch, commandMenu } from './commands.js';
import { log } from '../log.js';

// Telegram's hard cap on a message body.
const MAX_MESSAGE = 4096;

export class TelegramAdapter {
  /**
   * @param {import('../config.js').Config} cfg
   * @param {{ sessions: import('../core/sessions.js').SessionManager, login: import('../core/login.js').LoginFlow }} deps
   */
  constructor(cfg, { sessions, login }) {
    this.cfg = cfg;
    this.sessions = sessions;
    this.login = login;
    this.base = `${cfg.telegram.apiBase}/bot${cfg.telegram.token}`;
    this.offset = 0;
    this.running = false;
    /** @type {AbortController|null} */
    this.abort = null;
    this.allowed = new Set(cfg.telegram.allowedUsers);
  }

  get name() {
    return 'telegram';
  }

  async start() {
    if (!this.cfg.telegram.token) return false;

    const me = await this.#call('getMe', {});
    if (!me.ok) {
      log.error(`telegram: getMe failed (${me.error}) — adapter not started. Is AGENT_HUB_TELEGRAM_TOKEN right?`);
      return false;
    }
    log.info(
      `telegram: connected as @${me.result.username} · ${this.allowed.size} allowed user(s)` +
        (this.allowed.size ? '' : ' — everything but /whoami will be refused'),
    );

    await this.#registerCommands();

    this.running = true;
    this.#loop().catch((e) => log.error('telegram: poll loop died', e));
    return true;
  }

  /**
   * Register the command list with Telegram, which is what makes the client
   * autocomplete commands as you type "/" and show a menu button. Derived from
   * the shared registry, so adding a command is enough — nothing here needs
   * updating.
   *
   * Best effort: a failure here costs autocomplete, not function.
   */
  async #registerCommands() {
    const commands = commandMenu(this.cfg);
    const r = await this.#call('setMyCommands', { commands });
    if (r.ok) log.info(`telegram: registered ${commands.length} commands for autocomplete`);
    else log.warn(`telegram: setMyCommands failed (${r.error}) — autocomplete will be stale`);

    // Make the "/" menu reachable from the chat's menu button too, so the
    // command list is discoverable without typing anything.
    await this.#call('setChatMenuButton', { menu_button: { type: 'commands' } });
  }

  async stop() {
    this.running = false;
    this.abort?.abort();
  }

  async #loop() {
    // Backoff only on failure; a successful long-poll returns immediately and
    // we go straight back in, so a command is picked up the moment it is sent.
    let backoff = 1000;
    while (this.running) {
      try {
        const res = await this.#call('getUpdates', {
          offset: this.offset,
          timeout: 30,
          allowed_updates: ['message', 'callback_query'],
        }, 40_000);

        if (!res.ok) {
          if (res.status === 409) {
            log.error(
              'telegram: 409 Conflict — another process is polling this bot token. ' +
                'Only one agent-hub may use a given bot. Sleeping 30s.',
            );
            await sleep(30_000);
            continue;
          }
          log.warn(`telegram: getUpdates failed (${res.error}) — retrying in ${backoff}ms`);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 60_000);
          continue;
        }
        backoff = 1000;

        for (const update of res.result || []) {
          // Advance the offset BEFORE handling. A command that crashes the
          // handler must not be redelivered forever on every poll — that turns
          // one bad message into a permanent loop.
          this.offset = Math.max(this.offset, update.update_id + 1);
          try {
            await this.#handle(update);
          } catch (e) {
            log.error('telegram: handler error', e);
          }
        }
      } catch (e) {
        if (!this.running) return;
        log.warn(`telegram: poll error (${/** @type {Error} */ (e).message}) — retrying in ${backoff}ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  /** @param {any} update */
  async #handle(update) {
    if (update.callback_query) return this.#handleCallback(update.callback_query);

    const msg = update.message;
    if (!msg || !msg.text) return;
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id ?? '');
    const who = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || userId;
    const actor = `telegram:${userId}`;

    let text = msg.text.trim();
    // In a group, only act on messages actually addressed to the bot.
    if (msg.chat.type !== 'private' && !/^\//.test(text)) return;

    // Telegram reserves a bare /start for the bot intro. Honour that, but let
    // "/start myname" mean what it says everywhere else in agent-hub.
    if (/^\/start(@\S+)?$/.test(text)) text = '/help';

    // /whoami is answerable by anyone: it is how a new operator finds the id to
    // put in the allowlist, and it discloses only what the sender already knows
    // about themselves.
    const isWhoami = /^\/whoami(@\S+)?$/.test(text);
    if (!isWhoami && !this.allowed.has(userId)) {
      log.warn(`telegram: refused ${who} (${userId}): ${text.slice(0, 80)}`);
      await this.#send(
        chatId,
        `Not authorised.\n\nYour Telegram id is ${userId} — an operator can add it to ` +
          'AGENT_HUB_TELEGRAM_ALLOWED_USERS on the box and restart agent-hub.',
      );
      return;
    }

    log.info(`telegram: ${who} (${userId}) → ${text.slice(0, 120)}`);
    const reply = await dispatch(
      { sessions: this.sessions, login: this.login, cfg: this.cfg, actor, actorLabel: who },
      text,
    );
    await this.#send(chatId, reply.text, reply.buttons);
  }

  /**
   * A tapped inline button. Its callback_data IS the command line, so a button
   * is exactly equivalent to typing the command — there is no second code path
   * that could drift from the typed one.
   * @param {any} query
   */
  async #handleCallback(query) {
    const userId = String(query.from?.id ?? '');
    const chatId = query.message?.chat?.id;
    const who = query.from?.username ? `@${query.from.username}` : query.from?.first_name || userId;

    // Telegram spins the button until this is answered, so do it first.
    await this.#call('answerCallbackQuery', { callback_query_id: query.id });

    if (!this.allowed.has(userId)) {
      if (chatId) await this.#send(chatId, `Not authorised. Your Telegram id is ${userId}.`);
      return;
    }
    const line = String(query.data || '');
    if (!line || !chatId) return;

    log.info(`telegram: ${who} (${userId}) tapped → ${line.slice(0, 120)}`);
    const reply = await dispatch(
      { sessions: this.sessions, login: this.login, cfg: this.cfg, actor: `telegram:${userId}`, actorLabel: who },
      line,
    );
    await this.#send(chatId, reply.text, reply.buttons);
  }

  /**
   * @param {number|string} chatId
   * @param {string} text
   * @param {import('./commands.js').Button[]} [buttons]
   */
  async #send(chatId, text, buttons) {
    // No parse_mode on purpose. The replies carry session names, file paths and
    // URLs — all of which contain characters that Markdown/HTML modes require
    // escaping, and a single missed escape makes Telegram reject the whole
    // message. Plain text always renders, and Telegram auto-links bare URLs.
    const chunks = chunkText(text || '(no output)', MAX_MESSAGE);
    for (let i = 0; i < chunks.length; i++) {
      /** @type {Record<string, unknown>} */
      const params = { chat_id: chatId, text: chunks[i], disable_web_page_preview: true };
      // Buttons ride on the LAST chunk only, so they appear under the whole
      // reply rather than halfway through it.
      if (i === chunks.length - 1) {
        const keyboard = buildKeyboard(buttons);
        if (keyboard) params.reply_markup = { inline_keyboard: keyboard };
      }
      const r = await this.#call('sendMessage', params);
      if (!r.ok) log.warn(`telegram: sendMessage failed (${r.error})`);
    }
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {number} timeoutMs
   * @returns {Promise<{ ok: true, result: any } | { ok: false, error: string, status?: number }>}
   */
  async #call(method, params, timeoutMs = 15_000) {
    this.abort = new AbortController();
    const timer = setTimeout(() => this.abort?.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: this.abort.signal,
      });
      // Telegram's envelope: { ok, result } or { ok: false, description }.
      const body = /** @type {{ ok?: boolean, result?: any, description?: string }} */ (
        await res.json().catch(() => ({}))
      );
      if (!res.ok || body.ok !== true) {
        return { ok: false, status: res.status, error: body.description || `HTTP ${res.status}` };
      }
      return { ok: true, result: body.result };
    } catch (e) {
      return { ok: false, error: /** @type {Error} */ (e).message };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Turn the reply's offered choices into an inline keyboard, two per row.
 *
 * callback_data carries the command line verbatim and Telegram caps it at 64
 * BYTES — a longer one is rejected and the whole message fails to send, so an
 * over-long command is dropped rather than allowed to break the reply. Session
 * names are capped at 40 characters, so in practice this only bites on a very
 * long name plus a long verb.
 *
 * @param {import('./commands.js').Button[]|undefined} buttons
 */
function buildKeyboard(buttons) {
  if (!buttons || !buttons.length) return null;
  const usable = buttons.filter((b) => Buffer.byteLength(b.command, 'utf8') <= 64);
  for (const b of buttons) {
    if (!usable.includes(b)) log.warn(`telegram: button "${b.label}" dropped — callback_data over 64 bytes`);
  }
  if (!usable.length) return null;

  /** @type {Array<Array<{ text: string, callback_data: string }>>} */
  const rows = [];
  for (let i = 0; i < usable.length; i += 2) {
    rows.push(usable.slice(i, i + 2).map((b) => ({ text: b.label, callback_data: b.command })));
  }
  return rows;
}

/**
 * Split on line boundaries where possible so a wrapped reply stays readable.
 * @param {string} text
 * @param {number} max
 */
function chunkText(text, max) {
  if (text.length <= max) return [text];
  /** @type {string[]} */
  const out = [];
  let current = '';
  for (const line of text.split('\n')) {
    // A single line longer than the cap has to be cut somewhere.
    if (line.length > max) {
      if (current) out.push(current), (current = '');
      for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
      continue;
    }
    if (current.length + line.length + 1 > max) {
      out.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) out.push(current);
  return out;
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
