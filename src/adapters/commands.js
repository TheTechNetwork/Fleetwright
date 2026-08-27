// The command registry: one text-in / text-out surface that every adapter
// shares.
//
// This is the portability seam. Telegram, the web UI and the CLI do not
// implement commands — they parse a line, call dispatch(), and render the
// reply. Adding Slack or WhatsApp means writing an adapter that does those two
// things; it does not mean re-implementing "what does /start mean".
//
// Adding a command means adding one entry to COMMANDS below. Deliberately
// launcher-shaped for now — start/resume/stop/list/status — with the pane
// already readable via ctx.sessions.peek() when two-way driving is wanted.

/**
 * @typedef {object} Ctx
 * @property {import('../core/sessions.js').SessionManager} sessions
 * @property {import('../core/login.js').LoginFlow} login
 * @property {import('../config.js').Config} cfg
 * @property {string} actor        stable id of who is asking, e.g. "telegram:12345"
 * @property {string} [actorLabel] human name for logs/records
 */

/**
 * @typedef {object} Button
 * @property {string} label   what the user sees
 * @property {string} command the command line tapping it runs
 */

/**
 * @typedef {object} Reply
 * @property {string} text                 plain text; adapters may format it
 * @property {import('../core/registry.js').SessionRecord[]} [sessions] structured payload for rich surfaces
 * @property {Button[]} [buttons]          offered choices — Telegram renders these as tappable
 * @property {boolean} [ok]
 */

import { describe } from '../core/login.js';
import { runUpdate, updateStatus, updateAvailable, canSelfRestart } from '../core/update.js';
import { systemUpdates, describeSystemUpdates, refreshPackageLists, runUpgrade } from '../core/upgrades.js';
import { reboot } from '../core/reboot.js';
import { identity as fleetIdentity, enrol as fleetEnrol } from '../core/fleet-identity.js';
import { readLogs, resolveSource, unitInstalled, LOG_SOURCES } from '../core/logs.js';

/**
 * Split a command line into its verb, positional arguments and flags.
 * Flags may appear anywhere, so `/new api --safe` and `/new --safe api` both
 * work — nobody should have to remember an order.
 *
 * @param {string} line
 * @returns {{ name: string, args: string[], flags: Set<string> }}
 */
export function parse(line) {
  const parts = String(line || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return { name: '', args: [], flags: new Set() };
  // Accept "/start", "start", and Telegram's "/start@mybot" group form.
  const name = parts[0].replace(/^\//, '').split('@')[0].toLowerCase();

  /** @type {string[]} */
  const args = [];
  /** @type {Set<string>} */
  const flags = new Set();
  for (const part of parts.slice(1)) {
    // ONE dash is enough, and so is a dash a phone keyboard has helpfully
    // rewritten. Telegram on iOS turns `--` into an em dash as you type it, so
    // `/update --restart` arrives as `/update —restart` and used to be read as
    // a positional argument — the flag silently did nothing, which is the worst
    // way for a flag to fail. Buttons were unaffected because their payload is
    // never typed, so this broke only for people typing the command.
    // A LETTER after the dash, not \w: otherwise `-5` is a flag called "5"
    // rather than a negative number, and `/logs -5` stops meaning anything.
    const flag = /^(?:--|-|—|–)([a-z][\w-]*)$/i.exec(part);
    if (flag) flags.add(flag[1].toLowerCase());
    else args.push(part);
  }
  return { name, args, flags };
}

/**
 * Resolve the per-session permission override from flags.
 * Returns null when neither was given, meaning "use the global setting".
 * @param {Set<string>} flags
 * @returns {boolean|null}
 */
function permissionOverride(flags) {
  const safe = flags.has('safe') || flags.has('no-skip') || flags.has('prompt');
  const dangerous = flags.has('dangerous') || flags.has('skip') || flags.has('yolo');
  if (safe && dangerous) return null; // contradictory — fall back to the global setting
  if (safe) return false;
  if (dangerous) return true;
  return null;
}

/**
 * Tappable shortcuts for the sessions a command could act on. Capped, because
 * a chat client renders these as a keyboard and forty buttons is not a menu.
 * @param {import('../core/registry.js').SessionRecord[]} sessions
 * @param {(s: import('../core/registry.js').SessionRecord) => string} toCommand
 * @param {(s: import('../core/registry.js').SessionRecord) => string} toLabel
 * @returns {Button[]}
 */
function sessionButtons(sessions, toCommand, toLabel) {
  return sessions.slice(0, 8).map((s) => ({ label: toLabel(s), command: toCommand(s) }));
}

/**
 * How a session should read to a person.
 *
 * The name is the identity — a tmux target, a volume, what you type to resume —
 * and stays exactly as it is. The title is what the session is ABOUT, and is
 * the useful half once a box has six of them.
 * @param {import('../core/registry.js').SessionRecord} s
 */
function label(s) {
  return s.title ? `${s.name} · ${s.title}` : s.name;
}

/**
 * Does this session actually bypass permission checks?
 * @param {Ctx} ctx
 * @param {import('../core/registry.js').SessionRecord} s
 */
function effectiveSkip(ctx, s) {
  return s.skipPermissions === null ? ctx.cfg.skipPermissions : s.skipPermissions;
}

/**
 * Mark only the sessions that DIFFER from the global default, so the common
 * case stays quiet and an unusual one stands out.
 * @param {Ctx} ctx
 * @param {import('../core/registry.js').SessionRecord} s
 */
function modeSuffix(ctx, s) {
  if (s.skipPermissions === null || s.skipPermissions === ctx.cfg.skipPermissions) return '';
  return s.skipPermissions ? '  (permissions bypassed)' : '  (safe mode)';
}

/**
 * @param {string|undefined} word
 * @returns {'summary'|'full'|null}
 */
function parseResumeChoice(word) {
  const w = String(word || '').toLowerCase();
  if (w === 'summary' || w === 'summarised' || w === 'summarized' || w === '1') return 'summary';
  if (w === 'full' || w === 'all' || w === '2') return 'full';
  return null;
}

/**
 * `short` is the one-line description registered with Telegram's setMyCommands,
 * which is what makes the client autocomplete these as you type "/". Telegram
 * caps it at 256 characters and shows it inline, so keep it to a few words —
 * `help` is the longer text for /help.
 *
 * @type {Record<string, { aliases?: string[], usage: string, help: string, short?: string, hidden?: boolean, run: (ctx: Ctx, args: string[], flags: Set<string>) => Promise<Reply>|Reply }>}
 */
export const COMMANDS = {
  help: {
    aliases: ['start_help', 'commands', '?'],
    usage: '/help',
    short: 'List every command',
    help: 'Show this list.',
    run: (ctx) => ({ ok: true, text: helpText(ctx) }),
  },

  new: {
    // `start` is here for the web UI and CLI, where it is the natural word.
    // Telegram reserves a bare /start as the bot-intro command, so its adapter
    // maps that one case to /help — see adapters/telegram.js.
    aliases: ['start', 'launch', 'run'],
    usage: '/new [name] [path] [--safe|--dangerous]',
    short: 'Start a new Claude session',
    help: 'Start a new session. --safe keeps permission prompts on for this one session.',
    run: async (ctx, args, flags) => {
      const [name, cwd] = args;
      const skipPermissions = permissionOverride(flags);
      const r = await ctx.sessions.start({ name, cwd, actor: ctx.actor, skipPermissions });
      let text = r.message;
      if (r.ok && skipPermissions === false) text += '\nPermission prompts are ON for this session.';
      if (r.ok && skipPermissions === true && !ctx.cfg.skipPermissions) {
        text += '\nPermission checks are BYPASSED for this session.';
      }
      return { ok: r.ok, text, sessions: r.session ? [r.session] : undefined };
    },
  },

  resume: {
    aliases: ['continue'],
    usage: '/resume <name> [summary|full]',
    short: 'Resume a stopped session',
    help: 'Bring a stopped session back with its conversation intact.',
    run: async (ctx, args) => {
      if (!args[0]) {
        // No name given: offer the ones that can actually be resumed rather
        // than making someone go and read /list first.
        const resumable = ctx.sessions.list().filter((s) => s.status !== 'running' && s.uuid);
        if (!resumable.length) return { ok: false, text: 'Nothing to resume. /list shows what exists.' };
        return {
          ok: false,
          text: 'Which session?',
          buttons: sessionButtons(resumable, (s) => `/resume ${s.name}`, (s) => s.name),
        };
      }
      const choice = parseResumeChoice(args[1]);
      if (args[1] && !choice) {
        return { ok: false, text: `"${args[1]}" is not a resume mode. Use "summary" or "full".` };
      }
      const r = await ctx.sessions.resume({ name: args[0], actor: ctx.actor, choice });
      // When the session parks at the dialog, turn the two options into taps.
      const waiting = ctx.sessions.awaitingChoice.has(args[0]);
      return {
        ok: r.ok,
        text: r.message,
        sessions: r.session ? [r.session] : undefined,
        buttons: waiting
          ? [
              { label: 'Resume from summary', command: `/resume ${args[0]} summary` },
              { label: 'Resume full session', command: `/resume ${args[0]} full` },
            ]
          : undefined,
      };
    },
  },

  stop: {
    aliases: ['kill', 'close'],
    usage: '/stop <name>',
    short: 'Stop a running session',
    help: 'Stop a session. Its conversation is kept so /resume still works.',
    run: (ctx, args) => {
      if (!args[0]) {
        const running = ctx.sessions.running();
        if (!running.length) return { ok: false, text: 'Nothing is running.' };
        return {
          ok: false,
          text: 'Which session?',
          buttons: sessionButtons(running, (s) => `/stop ${s.name}`, (s) => s.name),
        };
      }
      const r = ctx.sessions.stop({ name: args[0], actor: ctx.actor });
      return { ok: r.ok, text: r.message, sessions: r.session ? [r.session] : undefined };
    },
  },

  list: {
    aliases: ['ls', 'sessions', 'ps'],
    usage: '/list',
    short: 'Show all sessions',
    help: 'Show every session — running and resumable.',
    run: (ctx) => {
      const all = ctx.sessions.list();
      if (!all.length) {
        return { ok: true, text: 'No sessions yet. Start one with /new [name].', sessions: [] };
      }
      const running = all.filter((s) => s.status === 'running');
      const rest = all.filter((s) => s.status !== 'running');
      const lines = [`${running.length}/${ctx.cfg.maxSessions} running on ${ctx.cfg.hostname}`, ''];
      for (const s of running) {
        lines.push(`▶ ${label(s)}${modeSuffix(ctx, s)}${s.rcUrl ? `\n   ${s.rcUrl}` : ''}`);
      }
      if (rest.length) {
        lines.push('', 'Resumable:');
        for (const s of rest) {
          lines.push(`◼ ${label(s)}${s.uuid ? '' : '  (no saved conversation)'}`);
        }
      }
      // One tap per session: stop what's running, resume what isn't.
      const buttons = [
        ...sessionButtons(running, (s) => `/stop ${s.name}`, (s) => `Stop ${s.name}`),
        ...sessionButtons(
          rest.filter((s) => s.uuid),
          (s) => `/resume ${s.name}`,
          (s) => `Resume ${s.name}`,
        ),
      ].slice(0, 10);
      return { ok: true, text: lines.join('\n'), sessions: all, buttons };
    },
  },

  status: {
    aliases: ['info'],
    usage: '/status [name]',
    short: 'Hub health, or one session',
    help: 'Hub health, or details for one session.',
    run: (ctx, args) => {
      if (!args[0]) {
        const all = ctx.sessions.list();
        const running = all.filter((s) => s.status === 'running').length;
        const auth = ctx.login.status();
        return {
          ok: true,
          text: [
            `agent-hub on ${ctx.cfg.hostname}`,
            `${running}/${ctx.cfg.maxSessions} sessions running, ${all.length} known`,
            `workdir: ${ctx.cfg.workdir}`,
            `claude: ${auth.loggedIn ? `logged in as ${auth.email || 'unknown'}` : 'NOT LOGGED IN — run /login'}`,
          ].join('\n'),
        };
      }
      const s = ctx.sessions.get(args[0]);
      if (!s) return { ok: false, text: `No session named "${args[0]}".` };
      const lines = [
        `${label(s)} — ${s.status}`,
        `cwd: ${s.cwd}`,
        `permissions: ${effectiveSkip(ctx, s) ? 'bypassed (--dangerously-skip-permissions)' : 'prompts enabled'}` +
          (s.skipPermissions === null ? ' [global default]' : ' [set for this session]'),
        `conversation: ${s.uuid || 'none recorded (cannot be resumed)'}`,
        s.rcUrl ? `remote control: ${s.rcUrl}` : null,
        s.detail ? `last: ${s.detail}` : null,
        s.createdBy ? `started by: ${s.createdBy}` : null,
      ].filter(Boolean);
      return { ok: true, text: /** @type {string[]} */ (lines).join('\n'), sessions: [s] };
    },
  },

  forget: {
    usage: '/forget <name>',
    short: 'Stop and erase a session',
    help: 'Stop a session and erase its record, so it can no longer be resumed.',
    run: (ctx, args) => {
      if (!args[0]) return { ok: false, text: 'Which session? Try /forget <name>.' };
      const r = ctx.sessions.forget({ name: args[0] });
      return { ok: r.ok, text: r.message };
    },
  },

  // --- Claude account ------------------------------------------------------

  login: {
    aliases: ['auth'],
    usage: '/login [console|status|cancel|logout]',
    short: 'Log this box into Claude',
    help: 'Log this box into a Claude account without SSH. Bare /login starts the subscription flow.',
    run: async (ctx, args) => {
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'status') return { ok: true, text: describe(ctx.login.status()) };
      if (sub === 'cancel') return { ok: true, text: ctx.login.cancel().message };
      if (sub === 'logout') {
        const r = ctx.login.logout();
        return { ok: r.ok, text: r.message };
      }
      const current = ctx.login.status();
      if (current.loggedIn && sub !== 'force' && sub !== 'console') {
        return {
          ok: true,
          text: `${describe(current)}\n\nAlready logged in. /login force to replace it, or /login logout first.`,
        };
      }
      const r = await ctx.login.start({
        actor: ctx.actor,
        mode: sub === 'console' ? 'console' : 'claudeai',
      });
      return { ok: r.ok, text: r.message };
    },
  },

  code: {
    usage: '/code <value>',
    short: 'Send back the login code',
    help: 'Send back the authorization code from the /login page.',
    run: async (ctx, args) => {
      if (!args[0]) return { ok: false, text: 'Paste the code: /code <value>' };
      const r = await ctx.login.submitCode(args.join(''));
      return { ok: r.ok, text: r.message };
    },
  },

  logs: {
    aliases: ['log', 'journal'],
    usage: '/logs [hub|coordinator|sidecar] [lines]',
    short: 'Recent service logs',
    help: 'The last lines of a service log. Defaults to the session manager, 40 lines.',
    run: (ctx, args) => {
      // Either order, because nobody remembers which comes first.
      const words = args.filter(Boolean);
      const lines = words.map(Number).find((n) => Number.isFinite(n) && n > 0) ?? null;
      const source = words.find((w) => resolveSource(w)) ?? null;

      const unknown = words.find((w) => !resolveSource(w) && !Number.isFinite(Number(w)));
      if (unknown) {
        return {
          ok: false,
          text: `"${unknown}" is not a service I can read. Try: ${Object.keys(LOG_SOURCES).join(', ')}.`,
          buttons: logButtons(ctx),
        };
      }

      const r = readLogs(ctx.cfg, { source, lines });
      // The other services are one tap away, since "why did that fail" is
      // rarely answered by exactly one of them.
      return { ok: r.ok, text: r.text, buttons: logButtons(ctx, r.source) };
    },
  },

  update: {
    // NOT 'upgrade': that is a command of its own, further down, and having it
    // as an alias here too means the lookup table is decided by declaration
    // order. It happens to resolve the right way today — `upgrade` is defined
    // after `update`, so it overwrites — and if anybody reordered this object,
    // /upgrade would quietly start restarting the service instead of
    // installing system packages.
    aliases: ['pull'],
    usage: '/update [--restart]',
    short: 'Pull the latest code',
    help:
      'Pull the latest code onto this box. --restart applies it immediately ' +
      '(sessions are left running).',
    run: (ctx, _args, flags) => {
      const status = updateStatus(ctx.cfg);
      if (!status.ok) return { ok: false, text: status.message ?? 'Could not read the checkout.' };

      // --check answers "is there anything" without changing the box, which is
      // what a notification wants and what somebody asks before deciding to
      // restart a machine with sessions running on it.
      if (flags.has('check')) {
        const avail = updateAvailable(ctx.cfg, { force: true });
        if (!avail.ok) return { ok: true, text: `${status.dir} (${status.branch})\n\n${avail.message}` };
        return {
          ok: true,
          text:
            `${status.dir} (${status.branch})\n\n` +
            (avail.behind
              ? `${avail.behind} commit${avail.behind === 1 ? '' : 's'} behind ${avail.upstream}. /update to pull.`
              : 'Up to date.'),
          buttons: avail.behind ? [{ label: 'Update now', command: '/update' }] : undefined,
        };
      }

      const restart = flags.has('restart') || flags.has('apply');
      const r = runUpdate(ctx.cfg, { restart, actor: ctx.actor });

      // Offer the restart as a tap rather than making someone remember a flag.
      // Only when there is something to apply and we can actually do it.
      const buttons =
        r.ok && r.changed && !r.restarting && canSelfRestart()
          ? [{ label: 'Restart to apply', command: '/update --restart' }]
          : undefined;

      return { ok: r.ok, text: `${status.dir} (${status.branch})\n\n${r.message}`, buttons };
    },
  },

  upgrade: {
    aliases: ['sysupdate'],
    usage: '/upgrade [--apply]',
    short: 'System packages on this box',
    help:
      'What the operating system has waiting, and — if it has been turned on — ' +
      'apply it. Separate from /update, which is this app rather than the box.',
    run: (ctx, _args, flags) => {
      if (flags.has('apply') || flags.has('yes')) {
        const r = runUpgrade(ctx.cfg, { actor: ctx.actor });
        return { ok: r.ok, text: r.text };
      }
      // Somebody is waiting for this answer, so refresh before giving it —
      // rate-limited inside, and a no-op when it is not permitted.
      refreshPackageLists(ctx.cfg);
      const s = systemUpdates();
      if (!s.supported) return { ok: true, text: `No package information here (${s.reason ?? 'unsupported'}).` };
      const summary = describeSystemUpdates(s);
      if (!summary) return { ok: true, text: 'The box is up to date.' };

      const shown = s.packages.slice(0, 12).join(', ');
      return {
        ok: true,
        text:
          `${summary}\n\n${shown}${s.packages.length > 12 ? `, …and ${s.count - 12} more` : ''}` +
          '\n\n/upgrade --apply to install them.',
        buttons: ctx.cfg.systemUpgrade ? [{ label: 'Install updates', command: '/upgrade --apply' }] : undefined,
      };
    },
  },

  reboot: {
    usage: '/reboot [pin] [hostname]',
    short: 'Reboot this box',
    help:
      'Reboot the machine. Three confirmations, each asking for something ' +
      'different: the command, a one-time PIN, and the hostname typed out. ' +
      'Every running session dies — a reboot takes the tmux server with it.',
    run: async (ctx, args) => {
      const running = (await ctx.sessions.list()).filter((s) => s.status === 'running').map((s) => s.name);
      const r = reboot(ctx.cfg, args, { actor: ctx.actor, sessions: running });
      return { ok: r.ok, text: r.text };
    },
  },

  enroll: {
    aliases: ['enrol', 'join'],
    usage: '/enroll <pin>',
    short: 'Join this box to a fleet',
    help:
      'Join this box to its coordinator with a six-digit pin. Mint the pin in ' +
      'the app; it is good for ten minutes and works once. The pin buys one ' +
      'exchange — this box generates its own key and never sends the private half.',
    run: async (ctx, args) => {
      const r = await fleetEnrol(args[0] || '', { actor: ctx.actor });
      return { ok: r.ok, text: r.text };
    },
  },

  identity: {
    aliases: ['fleet'],
    usage: '/identity',
    short: "Show this box's fleet identity",
    help:
      "Show this box's host id, its key fingerprint, and whether the " +
      'coordinator currently accepts it. The fingerprint is what you compare ' +
      'against the one the app shows for this host.',
    run: async () => {
      const r = await fleetIdentity();
      return { ok: r.ok, text: r.text };
    },
  },

  whoami: {
    usage: '/whoami',
    short: 'Show the id the hub sees you as',
    help: 'Show the id this hub sees you as — what goes in the allowlist.',
    run: (ctx) => ({ ok: true, text: `You are: ${ctx.actor}` }),
  },
};

/**
 * One button per service this box actually has, minus the one being shown.
 * Offering a unit that is not installed is offering a button that answers
 * "no log entries" — which looks like a broken service rather than an absent
 * one.
 * @param {Ctx} ctx
 * @param {string} [current]
 * @returns {Button[]}
 */
function logButtons(ctx, current) {
  return Object.entries(LOG_SOURCES)
    .filter(([key, { unit }]) => key !== current && unitInstalled(ctx.cfg, unit))
    .map(([key, { what }]) => ({ label: `Logs: ${what}`, command: `/logs ${key}` }));
}

/** name or alias → canonical command name */
const LOOKUP = (() => {
  /** @type {Record<string, string>} */
  const m = {};
  for (const [name, def] of Object.entries(COMMANDS)) {
    m[name] = name;
    for (const a of def.aliases || []) m[a] = name;
  }
  return m;
})();

/**
 * The command menu a chat client can register for autocomplete. Derived from
 * COMMANDS rather than written out separately, so a new command shows up in
 * the client's "/" menu without anyone remembering to update a second list.
 *
 * @param {import('../config.js').Config} cfg
 * @returns {Array<{ command: string, description: string }>}
 */
export function commandMenu(cfg) {
  return Object.entries(COMMANDS)
    .filter(([name, def]) => {
      if (def.hidden || !def.short) return false;
      if (!cfg.loginEnabled && (name === 'login' || name === 'code')) return false;
      return true;
    })
    .map(([name, def]) => ({
      // Telegram requires lowercase, 1-32 chars, [a-z0-9_].
      command: name.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32),
      description: String(def.short).slice(0, 256),
    }));
}

/** @param {Ctx} ctx */
export function helpText(ctx) {
  const lines = [`agent-hub on ${ctx.cfg.hostname}`, ''];
  for (const [name, def] of Object.entries(COMMANDS)) {
    if (name === 'help') continue;
    if (!ctx.cfg.loginEnabled && (name === 'login' || name === 'code')) continue;
    lines.push(`${def.usage}\n   ${def.help}`);
  }
  return lines.join('\n');
}

/**
 * Run one command line.
 * @param {Ctx} ctx
 * @param {string} line
 * @returns {Promise<Reply>}
 */
export async function dispatch(ctx, line) {
  const { name, args, flags } = parse(line);
  if (!name) return { ok: false, text: helpText(ctx) };

  const canonical = LOOKUP[name];
  if (!canonical) {
    return { ok: false, text: `Unknown command "${name}". Try /help.` };
  }
  if (!ctx.cfg.loginEnabled && (canonical === 'login' || canonical === 'code')) {
    return { ok: false, text: 'Login from agent-hub is disabled (AGENT_HUB_LOGIN=0).' };
  }

  try {
    return await COMMANDS[canonical].run(ctx, args, flags);
  } catch (e) {
    const err = /** @type {Error} */ (e);
    return { ok: false, text: `${canonical} failed: ${err.message}` };
  }
}
