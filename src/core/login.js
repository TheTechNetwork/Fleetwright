// Authenticating this box's Claude account, driven from chat or the web UI.
//
// Why this is here at all: agent-hub's promise is that a coworker can stand up
// their own instance. Without this, the very first step of that — logging
// Claude in — is the one thing that still forces them onto SSH with a terminal.
//
// `claude auth login` is an interactive flow: it prints an authorization URL,
// waits for you to visit it, and then waits for you to paste back a code. So
// the hub runs it in its own tmux pane, scrapes the URL out, hands it to the
// requester, and types the code they send back into that same pane.
//
// The pane is deliberately NOT a regular session: it is excluded from the
// session list, never counts against the concurrency cap, and is torn down as
// soon as the flow finishes either way.
//
// Trust note: anyone who can run these commands can point this box at a Claude
// account, and can read the authorization URL. That is the same level of trust
// as starting a session (unsupervised shell), so it sits behind the same
// allowlist — but it is worth knowing it is not a *lesser* permission.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { Accounts, extractOauthAccount } from './accounts.js';
import { hasSession, newSession, killSession, capturePane, sendKeys } from './tmux.js';
import { sleep } from './claude.js';
import { dewrapPane } from './pane.js';
import { markOnboardingComplete } from './trust.js';
import { log } from '../log.js';

/**
 * @typedef {object} AuthStatus
 * @property {boolean} loggedIn
 * @property {string} [authMethod]
 * @property {string} [email]
 * @property {string} [orgName]
 * @property {string} [subscriptionType]
 * @property {string} [error]
 */

// The pane prints the authorize URL after "If the browser didn't open, visit:".
// Match first-party hosts specifically rather than "any https URL", so a
// wrapped log line or a docs link in the banner can never be handed out as the
// login URL.
//
// Observed live (CLI 2.1.233): the subscription flow issues
//   https://claude.com/cai/oauth/authorize?code=true&client_id=…
// NOT claude.ai — getting this list wrong is silent, because the flow then
// runs normally, no URL is ever found, and the login just times out.
const AUTH_URL_RE =
  /https:\/\/(?:claude\.com|claude\.ai|platform\.claude\.com|console\.anthropic\.com)\/[^\s"'<>]*/g;
const SUCCESS_RE = /Login successful|Logged in as|Successfully (?:logged|signed) in|authentication successful/i;
const FAILURE_RE = /Login failed|Invalid code|authentication failed|Error: /i;
// The pane is waiting for the pasted code.
const AWAITING_CODE_RE = /paste (?:the |it |code)|enter the code|authorization code|Paste code here/i;

/**
 * May this actor finish that flow?
 *
 * The rule is not "the same string", and the difference is what keeps a
 * security fix from breaking the installer.
 *
 * FLEET IDENTITIES ARE INDIVIDUALS and must match exactly. `fleet:a@x` cannot
 * finish `fleet:b@x`'s login, and neither can finish a login the box started
 * for itself. That is the case this function exists for: it only became
 * reachable when `link` let any member send `/code`.
 *
 * EVERYTHING ELSE IS THE BOX. `web`, `cli`, `telegram:12345` — all of them are
 * somebody operating the machine directly, through a door that already
 * required the hub token or the Telegram allowlist. Treating them as one
 * identity is not a weakening; it is naming who they already are. It also
 * keeps a real flow working: the installer starts a login as `web`, and the
 * operator may well finish it from Telegram twenty minutes later.
 *
 * A flow with no recorded starter stays open, because that is what a flow
 * started before this existed looks like.
 *
 * @param {string|null|undefined} actor
 * @param {string|null|undefined} startedBy
 */
function sameActor(actor, startedBy) {
  if (!startedBy) return true;
  const a = String(actor || '').toLowerCase();
  const b = String(startedBy).toLowerCase();
  if (a === b) return true;
  // Neither is a verified fleet identity → both are the box itself.
  return !a.startsWith('fleet:') && !b.startsWith('fleet:');
}

export class LoginFlow {
  /** @param {import('../config.js').Config} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    /** @type {{ startedAt: number, startedBy: string|null, url: string|null, mode: string, linkFor?: string|null, linkDir?: string|null }|null} */
    this.pending = null;
  }

  /**
   * Current authentication state, straight from the CLI's own JSON. Reading
   * ~/.claude/.credentials.json directly would be faster but would encode a
   * private file format; `claude auth status --json` is the supported answer
   * and stays correct across auth methods (subscription, console, SSO).
   * @returns {AuthStatus}
   */
  status() {
    const r = spawnSync(this.cfg.claudeBin, ['auth', 'status', '--json'], {
      env: this.pending?.linkDir ? { ...process.env, CLAUDE_CONFIG_DIR: this.pending.linkDir } : process.env,
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (r.error) return { loggedIn: false, error: `could not run ${this.cfg.claudeBin}: ${r.error.message}` };
    const out = (r.stdout || '').trim();
    try {
      const parsed = JSON.parse(out);
      return { loggedIn: parsed.loggedIn === true, ...parsed };
    } catch {
      // Older CLIs, or an error printed as plain text.
      if (/not logged in|no credentials/i.test(out + (r.stderr || ''))) return { loggedIn: false };
      return { loggedIn: false, error: (out || r.stderr || 'unrecognised output from `claude auth status`').slice(0, 300) };
    }
  }

  /** Is a login waiting for a code right now? */
  isPending() {
    if (!this.pending) return false;
    if (!hasSession(this.cfg.loginSessionName)) {
      this.pending = null;
      return false;
    }
    if (Date.now() - this.pending.startedAt > this.cfg.loginTimeoutMs) {
      this.cancel();
      return false;
    }
    return true;
  }

  /**
   * Begin a login and return the authorization URL to hand to the requester.
   *
   * @param {{ actor?: string|null, mode?: 'claudeai'|'console', email?: string|null, sso?: boolean, linkFor?: string|null }} opts
   * @returns {Promise<{ ok: boolean, message: string, url?: string }>}
   */
  async start({ actor = null, mode = 'claudeai', email = null, sso = false, linkFor = null } = {}) {
    if (!this.cfg.loginEnabled) {
      return { ok: false, message: 'Login from agent-hub is disabled (AGENT_HUB_LOGIN=0).' };
    }
    if (this.isPending()) {
      // THE URL GOES BACK ONLY TO WHOEVER STARTED THE FLOW.
      //
      // It used to be returned to anybody who asked, which turned a refusal
      // into a disclosure: a second person could ask for a login, be told
      // "one is already waiting", receive the FIRST person's authorization
      // URL, open it, authorize with their own Claude account, and hand the
      // resulting code back. The code is bound by PKCE to the pane on this
      // box, so without the URL there is nothing an outsider can produce —
      // handing it over was the whole attack.
      const same = sameActor(actor, this.pending?.startedBy);
      return {
        ok: false,
        message: same
          ? `A login is already waiting for its code${this.pending?.url ? `:\n${this.pending.url}` : '.'}\n` +
            'Send the code with /code <value>, or /login cancel to start over.'
          : 'A login is already in progress on this box. Wait for it to finish, or ask whoever started it to /login cancel.',
      };
    }

    const name = this.cfg.loginSessionName;
    if (hasSession(name)) killSession(name); // stale pane from a crashed attempt

    const args = ['auth', 'login'];
    // Always pass the account type explicitly. Without it the flow opens with
    // an arrow-key menu, and driving a TUI menu blind over chat is exactly the
    // kind of fragility this scrape-the-URL approach cannot survive.
    args.push(mode === 'console' ? '--console' : '--claudeai');
    if (sso) args.push('--sso');
    if (email) args.push('--email', email);

    // LINKING somebody's own account, as opposed to logging in THE BOX.
    //
    // The flow is identical — same OAuth, same pane, same pasted code. The
    // difference is where the credential lands: an isolated CLAUDE_CONFIG_DIR,
    // so the box's own login is never touched, and on success the file moves
    // into the accounts store under that person's email. Without the
    // isolation, linking a client's account would log the whole box out of
    // the org account — the exact machine-wide blast radius accounts exist to
    // end.
    let linkDir = null;
    if (linkFor) {
      linkDir = path.join(this.cfg.stateDir, 'accounts', `pending-${linkFor}`);
      mkdirSync(linkDir, { recursive: true, mode: 0o700 });
    }

    const quoted = [this.cfg.claudeBin, ...args]
      .map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`)
      .join(' ');
    const envPrefix = linkDir ? `env CLAUDE_CONFIG_DIR='${linkDir.replace(/'/g, `'\\''`)}' ` : '';
    const spawned = newSession({ name, cwd: this.cfg.workdir, command: `exec ${envPrefix}${quoted}` });
    if (spawned.status !== 0) {
      return { ok: false, message: `Could not start the login: ${(spawned.stderr || 'tmux failed').trim().slice(0, 200)}` };
    }

    this.pending = { startedAt: Date.now(), startedBy: actor, url: null, mode, linkFor, linkDir };

    const url = await this.#waitForUrl();
    if (!url) {
      const pane = capturePane(name, 60).trim().split('\n').slice(-6).join('\n');
      this.cancel();
      return {
        ok: false,
        message: `The login did not produce an authorization URL.\nLast output:\n${pane || '(nothing)'}`,
      };
    }

    this.pending.url = url;
    log.info(`login: authorization URL issued${actor ? ` to ${actor}` : ''}`);
    return {
      ok: true,
      url,
      message:
        `Open this to authorize, then send me the code with /code <value>:\n${url}\n\n` +
        `The login expires in ${Math.round(this.cfg.loginTimeoutMs / 60000)} minutes. /login cancel aborts it.`,
    };
  }

  /** Poll the pane until the authorize URL appears. */
  async #waitForUrl() {
    const name = this.cfg.loginSessionName;
    for (let waited = 0; waited < 45_000; waited += 1000) {
      await sleep(1000);
      if (!hasSession(name)) return null; // exited — already logged in, or failed
      const text = capturePane(name, 200);
      const matches = dewrapPane(text).match(AUTH_URL_RE);
      if (!matches) continue;
      // Prefer a genuine authorize endpoint over any other first-party link
      // the banner may print.
      const authorize = matches.find((u) => /oauth|authorize/i.test(u));
      if (authorize) return authorize.replace(/[)\].,]+$/, '');
    }
    return null;
  }

  /**
   * Type the code the user pasted back into the waiting pane, then confirm the
   * result against `claude auth status`.
   *
   * The code is never logged: it is a live credential for the account being
   * attached, for the seconds before it is exchanged.
   *
   * WHO MAY FINISH A FLOW: only whoever started it.
   *
   * There is one pending flow per box, and this used to complete whichever one
   * was open regardless of who sent the code. That was survivable while `/code`
   * could only be reached from surfaces that already had the box — Telegram,
   * the CLI, the web UI. It stopped being survivable when `link` made it
   * reachable by any fleet member: an admin starts a login for the BOX, a
   * member sends a code for their own account, and every session on that
   * machine afterwards runs on an account the member controls. The reverse is
   * just as bad — a code landing in somebody else's `linkFor` slot puts the
   * sender's credential under the recipient's name.
   *
   * `startedBy` was already being recorded and simply never read.
   *
   * @param {string} code
   * @param {string|null} [actor]  who is sending it, as the caller knows them
   * @returns {Promise<{ ok: boolean, message: string, status?: AuthStatus }>}
   */
  async submitCode(code, actor = null) {
    // ONE MESSAGE FOR BOTH REFUSALS, byte-identical and deliberately so. A
    // distinct "that is not your login" would tell a member that somebody
    // else's flow is open right now, and when — which is the timing half of
    // the attack, handed over for free. Same discipline as the scheduler's
    // unknown_session refusal.
    const nothingWaiting = { ok: false, message: 'No login is waiting for a code. Start one with /login.' };
    if (!this.isPending()) return nothingWaiting;
    if (!sameActor(actor, this.pending?.startedBy)) {
      log.warn('login: a code arrived from somebody who did not start this login — refused');
      return nothingWaiting;
    }
    const trimmed = String(code || '').trim();
    // Codes are opaque, but they are one token — anything with whitespace or a
    // control character is a paste accident, and send-keys would scatter it
    // across the TUI.
    if (!trimmed || /\s/.test(trimmed) || trimmed.length > 512) {
      return { ok: false, message: 'That does not look like an authorization code. Paste just the code itself.' };
    }

    const name = this.cfg.loginSessionName;
    sendKeys(name, ['-l', trimmed]); // -l = literal, so nothing is read as a key name
    sendKeys(name, ['Enter']);

    // Watch the pane for an outcome, but treat `claude auth status` as the
    // authority — the banner wording is cosmetic and changes between releases.
    for (let waited = 0; waited < 60_000; waited += 2000) {
      await sleep(2000);
      const alive = hasSession(name);
      const text = alive ? capturePane(name, 80) : '';
      const st = this.status();
      if (st.loggedIn) {
        const link = this.pending?.linkFor && this.pending.linkDir
          ? { email: this.pending.linkFor, dir: this.pending.linkDir }
          : null;
        this.finish();
        if (link) {
          // The credential moves into the store and the isolated dir goes
          // away. The BOX is untouched: no markOnboardingComplete, because
          // that writes to the box's own config and this login was never for
          // the box.
          try {
            const raw = readFileSync(path.join(link.dir, '.credentials.json'), 'utf8');
            // The identity travels with the credential. Under CLAUDE_CONFIG_DIR
            // the state file lands at <dir>/.claude.json (verified empirically),
            // and its oauthAccount block is what the CLI inside a sandbox reads
            // logged-in-ness from — a credential stored without it seeds
            // sessions that come up logged out.
            let accountMeta = null;
            try {
              accountMeta = extractOauthAccount(readFileSync(path.join(link.dir, '.claude.json'), 'utf8'));
            } catch { /* older CLI, no state file — store the credential alone */ }
            const saved = new Accounts(this.cfg.stateDir).save(link.email, raw, accountMeta);
            rmSync(link.dir, { recursive: true, force: true });
            log.info(`login: linked a Claude account for ${link.email}`);
            return saved.ok
              ? { ok: true, status: st, message: `${saved.message}\nSessions ${link.email} starts now run on their own account.` }
              : { ok: false, message: saved.message };
          } catch (e) {
            rmSync(link.dir, { recursive: true, force: true });
            return { ok: false, message: `The login finished but the credential could not be stored: ${/** @type {Error} */ (e).message}` };
          }
        }
        // `claude auth login` writes credentials but does NOT mark the install
        // onboarded, so without this the very next session opens the first-run
        // wizard — "Select login method" — on an account that is already
        // logged in, and hangs there. Every fresh deployment hits this once.
        markOnboardingComplete(this.cfg);
        log.info(`login: succeeded as ${st.email || 'unknown account'}`);
        return { ok: true, status: st, message: `${describe(st)}\n\nReady — start a session with /new.` };
      }
      if (!alive || FAILURE_RE.test(text)) {
        const tail = text.trim().split('\n').slice(-5).join('\n');
        this.finish();
        return { ok: false, message: `Login failed.${tail ? `\n${tail}` : ''}` };
      }
      if (SUCCESS_RE.test(text)) continue; // pane says yes; wait for status to agree
    }

    return {
      ok: false,
      message: 'Sent the code but the login has not completed yet. Check /login status in a moment.',
    };
  }

  /** Tear the pane down without touching credentials. */
  cancel() {
    const name = this.cfg.loginSessionName;
    const had = hasSession(name);
    if (had) killSession(name);
    if (this.pending?.linkDir) rmSync(this.pending.linkDir, { recursive: true, force: true });
    this.pending = null;
    return { ok: true, message: had ? 'Login cancelled.' : 'No login was in progress.' };
  }

  /** Successful end of a flow — same teardown, different wording. */
  finish() {
    if (hasSession(this.cfg.loginSessionName)) killSession(this.cfg.loginSessionName);
    this.pending = null;
  }

  /**
   * Sign this box out. Running sessions are NOT killed: they hold their own
   * connections and killing them would destroy work as a side effect of an
   * account change. They will fail on their next API call, which is the
   * honest outcome.
   */
  logout() {
    const r = spawnSync(this.cfg.claudeBin, ['auth', 'logout'], { encoding: 'utf8', timeout: 30_000 });
    const st = this.status();
    if (st.loggedIn) {
      return { ok: false, message: `Logout did not take effect: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}` };
    }
    log.warn('login: logged out');
    return {
      ok: true,
      message: 'Logged out. Running sessions were left alone — they will fail on their next API call.',
    };
  }
}

/** @param {AuthStatus} st */
export function describe(st) {
  if (!st.loggedIn) {
    return st.error ? `Not logged in (${st.error})` : 'Not logged in. Run /login to authenticate this box.';
  }
  const bits = [`Logged in as ${st.email || 'unknown'}`];
  if (st.subscriptionType) bits.push(`plan: ${st.subscriptionType}`);
  if (st.authMethod) bits.push(`via: ${st.authMethod}`);
  if (st.orgName) bits.push(`org: ${st.orgName}`);
  return bits.join('\n');
}
