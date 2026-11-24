// A box's side of engines (docs/engines.md): which engines it runs, the
// sign-in it hands a session's runner, and the note it writes when one
// engine stops and the next takes over.
//
// Everything here is the box's own knowledge and no other party's. The
// coordinator asks what a box runs and believes the answer; the session
// asks for a sign-in and is answered for its own member and nobody else.

import { ENGINES, DEFAULT_ENGINE, HANDS_ON, API_PROVIDER_IDS, API_KEY_ITEMS, API_PROVIDERS, providerOf, credentialOf, turnWords } from '../fleet/protocol/engines.js';
import { ENGINE_ITEMS, vaultEngineItem, keepEngineItem } from './vault-store.js';
import { emailFromActor } from './accounts.js';
import { RESULT_FILE } from '../fleet/protocol/tasks.js';

/** The file a box writes when one engine stops and the next takes over. */
export const HANDOFF_FILE = 'HANDOFF.md';
/** How much of what the engine last printed the note keeps, in characters. */
export const HANDOFF_TAIL = 2000;

/**
 * The engines this box runs, Claude Code first.
 *
 * Another engine runs behind the runner, which reports to the session's own
 * socket and asks it for a sign-in, so a box runs one only where sessions
 * are in a container with that socket, and where its operator says the
 * image carries it (`FLEETWRIGHT_ENGINES`). The operator's word is the whole
 * of it: nothing here can see into the image cheaply, and a wrong word is a
 * session that says the command was not found.
 *
 * @param {{ sandbox?: boolean, sandboxHookSocket?: boolean, engines?: string[] }} cfg
 * @returns {string[]}
 */
export function boxEngines(cfg) {
  const more = cfg.sandbox && cfg.sandboxHookSocket
    ? (cfg.engines ?? []).map((e) => String(e).trim().toLowerCase()).filter((e) => Object.hasOwn(ENGINES, e) && e !== DEFAULT_ENGINE)
    : [];
  return [DEFAULT_ENGINE, ...new Set(more)];
}

/**
 * The metered API providers an engine on this box may bill to
 * (docs/api-engines.md): the ones its operator named, and only on a box that
 * runs OpenCode, which is the engine that speaks to them. None unless said.
 *
 * @param {{ sandbox?: boolean, sandboxHookSocket?: boolean, engines?: string[], apiProviders?: string[] }} cfg
 * @returns {string[]}
 */
export function boxApiProviders(cfg) {
  if (!boxEngines(cfg).includes('opencode')) return [];
  return [...new Set((cfg.apiProviders ?? []).map((p) => String(p).trim().toLowerCase()).filter((p) => API_PROVIDER_IDS.includes(p)))];
}

/**
 * Which of a session's engines takes over from the one whose turn just
 * ended, as its place in the member's list, or -1 for none.
 *
 * Only for the endings another provider is the answer to (HANDS_ON): a
 * limit, a missing sign-in, the wrong model. Only from the engine the pane
 * is on now, so a late or repeated report of an earlier engine's ending
 * moves nothing. And only to an engine this box runs.
 *
 * @param {{ engines?: Array<{ engine: string, model?: string }>|null, engineAt?: number }|null|undefined} rec
 * @param {{ engine: string, reason: string }} turn
 * @param {string[]} runs  what this box runs (boxEngines)
 * @param {string[]} [providers]  the API providers it may bill to (boxApiProviders)
 */
export function nextEngine(rec, turn, runs, providers = []) {
  if (!rec?.engines || !HANDS_ON.includes(turn.reason)) return -1;
  const from = rec.engineAt ?? 0;
  if (rec.engines[from]?.engine !== turn.engine) return -1;
  return rec.engines.findIndex((e, i) => {
    const provider = providerOf(e);
    return i > from && runs.includes(e.engine) && (provider === null || providers.includes(provider));
  });
}

/**
 * An engine's runner asking the session's socket for its sign-in, or handing
 * a renewed one back.
 *
 * THE GRANT IS THE RECORD. A session is answered for a kind only when its
 * own record names an engine that runs on that kind, and always from the
 * vault of whoever the session runs as. So a Claude Code session cannot ask
 * for its member's Codex sign-in out of curiosity, and nothing a session
 * says chooses whose vault is read.
 *
 * @param {{ stateDir: string, sandbox?: boolean, sandboxHookSocket?: boolean, engines?: string[], apiProviders?: string[] }} cfg
 * @param {{ createdBy?: string|null, engines?: Array<{ engine: string, model?: string }>|null }|null|undefined} rec  the session's record
 * @param {string} kind
 * @param {string|null} value  null to ask; text to hand back a renewed sign-in
 * @returns {{ ok: true, kind: string, value?: string } | { ok: false, error: string, message: string }}
 */
export function answerEngineCredential(cfg, rec, kind, value = null) {
  if (!rec) return { ok: false, error: 'no_session', message: 'This machine has no record of this session.' };
  // WHAT ITS MEMBER'S ENGINES RUN ON: each engine's own item, or the key of
  // the provider its model names (docs/api-engines.md).
  const granted = (rec.engines ?? []).map((e) => credentialOf(e));
  if (!ENGINE_ITEMS.includes(kind) || !granted.includes(kind)) {
    return { ok: false, error: 'not_granted', message: 'This session’s member names no engine that runs on that sign-in.' };
  }
  // A KEY, only for a provider this box's operator turned on. A box that was
  // told to stop billing a provider stops handing its key out, whatever the
  // vault left here before.
  if (API_KEY_ITEMS.includes(kind)) {
    const provider = API_PROVIDER_IDS.find((id) => API_PROVIDERS[/** @type {keyof typeof API_PROVIDERS} */ (id)].item === kind);
    if (!provider || !boxApiProviders(cfg).includes(provider)) {
      return { ok: false, error: 'not_granted', message: 'The operator of this machine has not turned that API provider on.' };
    }
  }
  const who = emailFromActor(rec.createdBy ?? null) ?? String(rec.createdBy || '').toLowerCase();
  if (!who) return { ok: false, error: 'no_owner', message: 'Nobody was identified as this session’s owner, so there is no vault to read.' };
  if (value === null) {
    const held = vaultEngineItem(cfg, who, kind);
    if (!held) return { ok: false, error: 'not_held', message: `this machine holds no ${kind} sign-in for this member` };
    return { ok: true, kind, value: held };
  }
  return keepEngineItem(cfg, who, kind, value)
    ? { ok: true, kind }
    : { ok: false, error: 'not_kept', message: 'That does not read as the sign-in this machine holds, so it was not kept.' };
}

/**
 * The note a box writes when one engine stops and another takes over
 * (docs/engines.md, "At a limit").
 *
 * MECHANICAL, AND IT SAYS SO. An engine at its limit cannot be asked to
 * summarize, so this is what the box can see: which engine stopped and why,
 * what the checkout says, and the last of the pane. It is a place to start
 * reading and not an account of the work.
 *
 * @param {{
 *   turn: import('../fleet/protocol/engines.js').TurnEnded,
 *   next: { engine: string, model?: string },
 *   taskId?: string|null, taskBranch?: string|null,
 *   firstMessage?: string|null,
 *   checkout?: { where: string, branch: string, status: string, log: string }|null,
 *   pane?: string|null,
 *   at: number,
 * }} facts
 */
export function handoffNote({ turn, next, taskId = null, taskBranch = null, firstMessage = null, checkout = null, pane = null, at }) {
  const says = (/** @type {string} */ id) => ENGINES[/** @type {keyof typeof ENGINES} */ (id)]?.says ?? id;
  const when = new Date(at).toISOString().replace('T', ' ').slice(0, 16);
  const tail = String(pane ?? '').replace(/\s+$/, '');
  const lines = [
    `# Handoff: ${says(turn.engine)} to ${says(next.engine)}`,
    '',
    `Written by this machine at ${when} UTC, not by either engine. It is what the machine could see, and a place to start reading.`,
    '',
    `- **Why:** ${turnWords(turn)}${turn.detail && turn.reason !== 'error' ? ` Its own words: ${turn.detail}` : ''}`,
    `- **Continuing on:** ${says(next.engine)}${next.model ? ` (${next.model})` : ''}`,
    ...(taskId ? [`- **Task:** ${taskId}${taskBranch ? `, on the branch ${taskBranch}` : ''}. Write ${RESULT_FILE} at the top of the workspace when you stop, as the first message says.`] : []),
    '',
    '## What was asked',
    '',
    firstMessage ? firstMessage : 'This machine no longer holds the first message of this session (it was restarted since). The task’s page has the brief.',
    '',
    '## The checkout',
    '',
    ...(checkout
      ? [
          `In \`${checkout.where}\`, on the branch \`${checkout.branch}\`.`,
          '',
          'Uncommitted changes (`git status --short`):',
          '',
          '```',
          checkout.status.replace(/^\n+|\s+$/g, '') || '(none)',
          '```',
          '',
          'Last commits (`git log -5 --oneline`):',
          '',
          '```',
          checkout.log.trim() || '(none)',
          '```',
        ]
      : ['No git checkout was found at the top of the workspace or one directory down.']),
    '',
    `## The last of what ${says(turn.engine)} printed`,
    '',
    '```',
    tail ? tail.slice(-HANDOFF_TAIL) : '(nothing could be read off the pane)',
    '```',
    '',
  ];
  return lines.join('\n');
}

/** The line added to a session's first message for the engine that takes over. */
export function continuationMessage(/** @type {string|null} */ firstMessage, /** @type {string} */ from) {
  const lead = `You are continuing work that ${ENGINES[/** @type {keyof typeof ENGINES} */ (from)]?.says ?? from} began in this workspace and could not finish. Read ${HANDOFF_FILE} at the top of the workspace first: it says why it stopped and what the checkout looked like.`;
  return firstMessage ? `${firstMessage}\n\n----------\n\n${lead}` : lead;
}
