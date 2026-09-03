// Unit tests for the pure parsing logic — the parts that read text produced by
// somebody else's program, which is exactly where the silent bugs live.
//
//   node --test test/
//
// Every case in here is either a real capture taken off a running box or a
// bug that shipped and had to be found the hard way.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../src/adapters/commands.js';
import { parseResumeDialog, extractRcUrl, diagnoseRc } from '../src/core/claude.js';
import { dewrapPane } from '../src/core/pane.js';
import { isValidName, generateName } from '../src/core/names.js';

test('parse separates verb, positionals and flags in any order', () => {
  const none = new Map();
  assert.deepEqual(parse('/new api --safe'), { name: 'new', args: ['api'], flags: new Set(['safe']), values: none });
  assert.deepEqual(parse('/new --safe api'), { name: 'new', args: ['api'], flags: new Set(['safe']), values: none });
  assert.deepEqual(parse('new api /srv/work'), {
    name: 'new',
    args: ['api', '/srv/work'],
    flags: new Set(),
    values: none,
  });
});

test('a flag may carry a value, and it does not become a positional', () => {
  // `--profile reviewer` was the obvious spelling and is the wrong one: /new
  // already has two positionals, so a following word cannot be told apart from
  // a session name. `=` makes it one token and removes the ambiguity entirely.
  const r = parse('/new api --safe --profile=reviewer');
  assert.deepEqual(r.args, ['api'], 'the value leaked into the positionals');
  assert.equal(r.flags.has('safe'), true);
  assert.equal(r.values.get('profile'), 'reviewer');

  // The em-dash tolerance applies to this form too. A phone keyboard rewrites
  // `--` as you type it, and a flag that silently does nothing is the worst way
  // for a flag to fail — which this repository has already paid for once.
  assert.equal(parse('/new —profile=reviewer').values.get('profile'), 'reviewer');

  // A value containing `=` keeps every character after the first one: splitting
  // on the last would corrupt the value, and splitting on all of them would
  // silently drop most of it.
  assert.equal(parse('/x --k=a=b').values.get('k'), 'a=b');
});

test('parse accepts the Telegram group form /cmd@botname', () => {
  assert.equal(parse('/list@my_agent_bot').name, 'list');
});

test('parse of an empty line yields no command', () => {
  assert.equal(parse('   ').name, '');
});

test('session names reject anything that could reach a shell', () => {
  assert.ok(isValidName('api-staging_2'));
  assert.ok(!isValidName('bad;name'));
  assert.ok(!isValidName('has space'));
  assert.ok(!isValidName('$(whoami)'));
  assert.ok(!isValidName(''));
  assert.ok(!isValidName('x'.repeat(41)));
});

test('generated names are valid and avoid collisions', () => {
  const taken = new Set(['cc-000000']);
  const name = generateName((n) => taken.has(n));
  assert.ok(isValidName(name));
  assert.ok(!taken.has(name));
});

// --- the resume dialog ------------------------------------------------------

const RESUME_PANE = [
  'This session is 6d 12h old and 347.8k tokens.',
  'Resuming the full session will consume a substantial portion of your usage limits.',
  '  > 1. Resume from summary (recommended)',
  '    2. Resume full session as-is',
  "    3. Don't ask me again",
].join('\n');

test('resume dialog is recognised and its numbers extracted', () => {
  const d = parseResumeDialog(RESUME_PANE);
  assert.ok(d);
  assert.equal(d.info, 'This session is 6d 12h old and 347.8k tokens.');
});

test('resume dialog never offers "Don\'t ask me again"', () => {
  // Taking that option flips a global preference for every future session,
  // interactive ones included, so it must not even be shown.
  const d = parseResumeDialog(RESUME_PANE);
  assert.equal(d.options.length, 2);
  assert.ok(!d.options.some((o) => /ask me again/i.test(o)));
  assert.match(d.options[0], /Resume from summary/);
  assert.match(d.options[1], /Resume full session/);
});

test('ordinary pane output is not mistaken for the dialog', () => {
  assert.equal(parseResumeDialog('Welcome to Claude Code\n> '), null);
});

// --- the login pane ---------------------------------------------------------

// A verbatim capture from `claude auth login --claudeai` in an 80-column tmux
// pane (CLI 2.1.233). Note the URL wraps across six lines and the prompt that
// follows it does not.
const LOGIN_PANE = [
  'Opening browser to sign in…',
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=t",
  'rue&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_u',
  'ri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreat',
  'e_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Am',
  'cp_servers+user%3Afile_upload&code_challenge=goOA15P6mc3lxSDMGhyU5kGCMH4VuWuR-kE',
  'P0MdW4-U&code_challenge_method=S256&state=BdlKPcnMGAOoaVqz6VKYhLJNyUoE2DuuCw2NHQ',
  'g7lTA',
  'Paste code here if prompted > ',
].join('\n');

const AUTH_URL_RE =
  /https:\/\/(?:claude\.com|claude\.ai|platform\.claude\.com|console\.anthropic\.com)\/[^\s"'<>]*/g;

function extractUrl(pane) {
  const matches = dewrapPane(pane).match(AUTH_URL_RE);
  const authorize = matches && matches.find((u) => /oauth|authorize/i.test(u));
  return authorize ? authorize.replace(/[)\].,]+$/, '') : null;
}

test('the wrapped authorization URL is reassembled exactly', () => {
  const url = extractUrl(LOGIN_PANE);
  assert.ok(url, 'no URL found — check AUTH_URL_RE against the real host');
  const u = new URL(url);
  assert.equal(u.host, 'claude.com');
  assert.equal(u.pathname, '/cai/oauth/authorize');
  assert.equal(u.searchParams.get('code_challenge'), 'goOA15P6mc3lxSDMGhyU5kGCMH4VuWuR-kEP0MdW4-U');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://platform.claude.com/oauth/code/callback');
});

test('the prompt after the URL is not glued onto the state parameter', () => {
  // Regression: de-wrapping used to join any newline followed by a non-space,
  // so "Paste" (from "Paste code here if prompted >") ended up appended to
  // state — a URL that loads and then fails authorization for no visible
  // reason.
  const url = extractUrl(LOGIN_PANE);
  const state = new URL(url).searchParams.get('state');
  assert.equal(state, 'BdlKPcnMGAOoaVqz6VKYhLJNyUoE2DuuCw2NHQg7lTA');
  assert.ok(!url.includes('Paste'));
});

test('de-wrapping leaves prose alone', () => {
  const prose = 'a short line\nanother short line\nthird';
  assert.equal(dewrapPane(prose), prose);
});

// --- the Remote Control URL -------------------------------------------------

// Verbatim from a container session on CLI 2.1.233 in an 80-column pane. At
// this width the URL lands on a line of its own and nothing wraps, which is
// exactly why the wrapping bug below stayed hidden.
const RC_PANE_80 = [
  '/remote-control is active · Continue here, on your phone, or at',
  'https://claude.ai/code/session_016zfBs7LYmQwg7WqfD6dY3M',
].join('\n');

const RC_URL = 'https://claude.ai/code/session_016zfBs7LYmQwg7WqfD6dY3M';

/**
 * Hard-wrap like a terminal does: a fixed-width grid breaks a line mid-token
 * with no hyphen and no marker. Building the fixtures this way rather than
 * pasting pre-wrapped text keeps them honest about what tmux actually hands us
 * at a given width.
 * @param {string} text @param {number} cols
 */
function wrapAt(text, cols) {
  return text
    .split('\n')
    .flatMap((line) => line.match(new RegExp(`.{1,${cols}}`, 'g')) || [''])
    .join('\n');
}

test('the Remote Control URL is read off an 80-column pane', () => {
  assert.equal(extractRcUrl(RC_PANE_80), RC_URL);
});

test('a flag survives one dash, and a phone keyboard rewriting two', () => {
  // Telegram on iOS turns `--` into an em dash as you type, so `/update
  // --restart` arrives as `/update \u2014restart`. That used to parse as a
  // positional argument: the flag silently did nothing, which is the worst way
  // for a flag to fail. Buttons were unaffected because their payload is never
  // typed — so this broke only for people typing the command, which is the
  // harder half to notice.
  for (const line of ['/update --restart', '/update -restart', '/update \u2014restart', '/update \u2013restart']) {
    const { name, flags } = parse(line);
    assert.equal(name, 'update', line);
    assert.ok(flags.has('restart'), `${line} should set the flag`);
  }
});

test('a bare dash and a negative number stay arguments', () => {
  // The other direction: the pattern needs a word after the dash, so a stray
  // one is not a flag called "".
  assert.deepEqual([...parse('/peek -').flags], []);
  assert.deepEqual(parse('/peek -').args, ['-']);
  assert.deepEqual(parse('/logs -5').args, ['-5'], 'a negative number is an argument, not a flag');
});

test('the Remote Control URL survives a pane narrow enough to wrap it', () => {
  // The regression this guards: extractRcUrl matched the raw capture with no
  // de-wrapping, so a wrapped URL yielded a truncated one — well-formed,
  // plausible, and pointing at nothing.
  const oneLine = `/remote-control is active · Continue here, on your phone, or at ${RC_URL}`;
  for (const cols of [64, 70, 80, 100]) {
    const pane = wrapAt(oneLine, cols);
    assert.equal(extractRcUrl(pane), RC_URL, `wrapped at ${cols} columns`);
  }
});

test('a longer session id wraps at 80 columns and is still recovered whole', () => {
  const longUrl = `https://claude.ai/code/session_${'0123456789abcdef'.repeat(3)}`;
  assert.equal(extractRcUrl(wrapAt(longUrl, 80)), longUrl);
});

test('a box-drawing character after the URL is not swallowed into it', () => {
  // De-wrapping can only ever join MORE text onto the end of the URL, and the
  // pane is a TUI: a whitespace-free line following a full-width one may well
  // be a box border. Matching `\S+` would make it part of the URL.
  const pane = [`${RC_URL}${'x'.repeat(80 - RC_URL.length)}`, '╰──────────────────────────────────────────────────────────────╯'].join(
    '\n',
  );
  const found = extractRcUrl(pane);
  assert.ok(found);
  assert.ok(!/[╰╯─]/.test(found), `box drawing leaked into the URL: ${found}`);
});

test('a pane with no Remote Control URL yields null', () => {
  assert.equal(extractRcUrl('Welcome to Claude Code\n> '), null);
  // The status-line-only form: RC came up via remoteControlAtStartup rather
  // than --remote-control <name>, so there is no URL to hand out.
  assert.equal(extractRcUrl('/rc active'), null);
});

// --- why Remote Control is not up -------------------------------------------

test('a pane that says "not logged in" is reported as that, not as a timeout', () => {
  // Taken from a real session. Remote Control cannot come online without an
  // account, and "did not come online" sends somebody to look at timeouts and
  // networks for something the pane spells out in words.
  const pane = [
    '│   Opus 5 (1M context) · API Usage Billing   │',
    '',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    '                                                    Not logged in · Run /login',
  ].join('\n');

  const why = diagnoseRc(pane);
  assert.ok(why, 'the cause is on the screen');
  assert.match(why.detail, /not logged in/i);

  // THE REMEDY MUST NOT COST A CONVERSATION. This message is read at the worst
  // moment, and it used to end in "/forget the session and start it again so
  // the volume is seeded fresh" — correct when a resume never re-seeded, since
  // destroying the volume was then the only way to get a current credential
  // into one. A resume re-seeds now, so that advice throws away a week of work
  // to fix something a resume fixes, and a remedy that expensive when a
  // cheaper one exists is worse than no remedy at all.
  assert.ok(!/forget/i.test(why.remedy), 'the remedy tells somebody to destroy their conversation');
  assert.match(why.remedy, /resume/i, 'and does not name the cheap fix');
  // Cheapest first, ending at the one that loses something — how every other
  // remedy in this codebase is written.
  assert.ok(why.remedy.indexOf('Sign in again') < why.remedy.indexOf('/verify'));
});

test('a self-updated CLI is reported as needing a restart', () => {
  const why = diagnoseRc('  ✔ Update installed · Restart to apply');
  assert.ok(why);
  assert.match(why.detail, /updated itself/i);
  assert.match(why.remedy, /CLAUDE_VERSION/);
});

test('a healthy pane diagnoses nothing, so the real timeout still reads as one', () => {
  assert.equal(diagnoseRc('❯ ready\n  ⏵⏵ bypass permissions on'), null);
});

test('the diagnosis survives a wrapped pane', () => {
  // 80 columns splits that status line, which is exactly what defeated the RC
  // URL matcher this project started with.
  const wrapped = 'Not logged in ·\nRun /login';
  assert.ok(diagnoseRc(wrapped), 'dewrapped before matching, like everything else that reads a pane');
});
