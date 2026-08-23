// The console, rendered.
//
// The first version of this page was 1,650 lines of hand-rolled DOM and I
// shipped it broken, because the only checks available to me were "does it
// parse" and "does it mention innerHTML" — both of which it passed. A component
// that returns a value can be rendered to a string here and asserted on, and
// that is the entire reason this is JSX.
//
// Every test below is a claim from docs/psychology.md that would otherwise be a
// paragraph nobody can enforce.

import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'preact-render-to-string';

// From build/, not src/: node cannot import .jsx, so scripts/build-web.mjs
// compiles the components with preact left external and the tests render THOSE.
// `npm test` builds first — see the pretest script.
import { Console, Confidence, HostCard, Ask, Wall } from '../build/console/components.js';
import { sessionState, byUrgency, standingClaims, headline, scrub, HOST_STATES } from '../build/console/state.js';

// A connected healthy host HAS reported recently — the first version of this
// fixture omitted healthAt, and the freshness claim correctly refused to vouch
// for it, which downgraded the headline. The model working, and a fixture that
// described a machine that cannot exist.
const NOW = Date.now();
const HEALTHY = { hostId: 'deb13-staging', state: 'healthy', connected: true, healthAt: NOW - 2000, health: { labels: ['linux'] } };
const WORKING = { name: 'cc-brave-otter', title: 'refactor the billing importer', status: 'running', hostId: 'deb13-staging' };
const WAITING = {
  name: 'cc-quiet-badger',
  title: 'upgrade the payment SDK',
  status: 'running',
  hostId: 'deb13-staging',
  prompt: { id: 'ab12', kind: 'resume', question: 'Resume this session from a summary, or in full?', options: [{ index: 1, label: 'Resume from summary' }, { index: 2, label: 'Resume full session' }] },
};

test('it renders at all, which the last one did not', () => {
  const html = render(<Console snap={{ hosts: [HEALTHY], sessions: [WORKING], events: [] }} />);
  assert.ok(html.length > 200, 'produced markup');
  assert.match(html, /deb13-staging/);
  assert.match(html, /refactor the billing importer/);
});

test('"nothing needs you" is a claim with its working shown, not an empty state', () => {
  // docs/psychology.md: this is where a person is ninety-five percent of the
  // time. A surface that only becomes useful when something is wrong leaves the
  // anxiety exactly where it was.
  const html = render(<Confidence snap={{ hosts: [HEALTHY], sessions: [WORKING], enrolled: 1, now: NOW }} />);
  assert.match(html, /Nothing needs you/);
  assert.match(html, /All 1 enrolled machines are connected\./);
  assert.match(html, /Every machine has reported in the last minute\./);
  assert.match(html, /Every connected machine can take work\./);
  assert.match(html, /class="[^"]*settled/);
});

test('quiet that cannot be vouched for is never reported as quiet', () => {
  // psychology.md §7: if the fleet is silent because everything is fine, and
  // also silent because a host dropped, then silence means nothing.
  const degraded = { hostId: 'attic-pi', state: 'degraded', connected: true, reason: 'claude is not logged in on this host' };
  const snap = { hosts: [HEALTHY, degraded], sessions: [], enrolled: 2, now: Date.now() };

  const head = headline(snap);
  assert.equal(head.settled, false);
  assert.match(head.text, /not seeing the whole fleet/);

  const html = render(<Confidence snap={snap} />);
  assert.equal(html.includes('Nothing needs you'), false);
  assert.match(html, /claude is not logged in on this host/, 'the registry sentence, verbatim');
});

test('a claim that holds is still shown, because a claim that vanishes is one nobody is checking', () => {
  // This is the correction the design review made to my first version, which
  // BRANCHED: one headline and the reasons for whichever thing was worst, so a
  // single degraded host hid the fact that everything else was fine and being
  // watched. You cannot tell "this is fine" from "this is not being checked".
  const degraded = { hostId: 'attic-pi', state: 'degraded', connected: true, reason: 'not logged in' };
  const claims = standingClaims({ hosts: [HEALTHY, degraded], sessions: [], enrolled: 2, now: Date.now() });

  const ids = claims.map((c) => c.id).sort();
  assert.deepEqual(ids, ['capability', 'coverage', 'freshness', 'self']);
  assert.ok(claims.some((c) => c.ok === true), 'some still hold');
  assert.ok(claims.some((c) => c.ok === false), 'and the failing one is among them, not instead of them');

  // Every claim is present in the markup whether it passes or fails.
  const html = render(<Confidence snap={{ hosts: [HEALTHY, degraded], sessions: [], enrolled: 2, now: Date.now() }} />);
  for (const c of claims) assert.ok(html.includes(c.claim), `missing claim: ${c.claim}`);
});

test('a failing claim carries the remedy, not just the diagnosis', () => {
  // psychology.md §6: a person reading an error has less working memory
  // available than usual, and the remedy is cheap for us and expensive for them.
  const claims = standingClaims({ hosts: [{ hostId: 'a', state: 'degraded', connected: true, reason: 'x' }], enrolled: 2, sessions: [], now: Date.now() });
  const failing = claims.filter((c) => c.ok === false);
  assert.ok(failing.length);
  assert.ok(failing.every((c) => c.remedy), 'every failing claim says what to do');
});

test('a host reason is rendered verbatim and never truncated', () => {
  const reason = 'last health report was 71s ago, and the socket is still open';
  const html = render(<HostCard host={{ hostId: 'x', state: 'unknown', reason }} />);
  assert.match(html, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('offline and unknown are different things and say so', () => {
  // A box we KNOW is gone versus one we have not heard from. Collapsing them
  // reports the first as the second — more alarming, less accurate.
  const off = render(<HostCard host={{ hostId: 'a', state: 'offline' }} />);
  const unk = render(<HostCard host={{ hostId: 'b', state: 'unknown' }} />);
  assert.match(off, /Offline/);
  assert.match(unk, /Not sure/);
  assert.notEqual(HOST_STATES.offline.glyph, HOST_STATES.unknown.glyph);
});

test('every state carries a word, so colour is never the only carrier', () => {
  // docs/psychology.md §5. Enforced rather than asserted in prose.
  for (const [state, v] of Object.entries(HOST_STATES)) {
    const html = render(<HostCard host={{ hostId: 'h', state }} />);
    assert.match(html, new RegExp(v.word), `${state} has no word`);
    assert.ok(html.includes(v.glyph), `${state} has no glyph`);
  }
});

test('a waiting session is asked about first, above everything else', () => {
  const html = render(<Wall sessions={[WORKING, WAITING]} />);
  assert.ok(
    html.indexOf('Resume this session') < html.indexOf('refactor the billing importer'),
    'the question comes before the inventory',
  );
  assert.deepEqual([WORKING, WAITING].sort(byUrgency).map((s) => s.name), ['cc-quiet-badger', 'cc-brave-otter']);
});

test('the question and its options are shown, which is the entire product', () => {
  const html = render(<Ask session={WAITING} />);
  assert.match(html, /Resume this session from a summary, or in full\?/);
  assert.match(html, /Resume from summary/);
  assert.match(html, /Resume full session/);
});

test('withheld options say they were withheld rather than showing nothing', () => {
  // A permission dialog names a command, so without the fleet switch its labels
  // do not leave the box. An empty list would read as "no choices".
  const withheld = { ...WAITING, prompt: { ...WAITING.prompt, kind: 'permission', options: [] } };
  const html = render(<Ask session={withheld} />);
  assert.match(html, /does not send prompt text off the box/);
});

test('an unreachable coordinator says so before anything else', () => {
  const html = render(<Console snap={{ reachable: false, hosts: [HEALTHY], sessions: [WORKING], events: [], enrolled: 1, now: NOW }} />);
  assert.match(html, /This page is not talking to the coordinator/);
  assert.match(html, /not being updated/);
  assert.match(html, /each box is the authority on its own tmux/, 'and says your work is unaffected');
  assert.match(html, /class="[^"]*stale/, 'and the whole page is marked stale');
});

test('the ledger shows who, because the actor used to be thrown away', () => {
  const events = [{ event: 'intent', verb: 'stop', actor: 'eli@thetech.network', text: 'eli@thetech.network asked for stop bigjob', at: 1 }];
  const html = render(<Console snap={{ hosts: [HEALTHY], sessions: [], events }} />);
  assert.match(html, /eli@thetech\.network/);
});

test('a bidi override cannot make a button lie about what it does', () => {
  // An RLO inside an option label can render "Deny" while meaning "Approve",
  // six pixels from an irreversible action, on the origin holding every
  // credential. Replaced with a visible marker rather than deleted, so a label
  // that tried it looks wrong instead of looking fine.
  const rlo = '\u202EevorppA';
  assert.equal(scrub(rlo).includes('\u202E'), false);
  assert.match(scrub(rlo), /\uFFFD/);

  const nasty = { ...WAITING, prompt: { ...WAITING.prompt, options: [{ index: 1, label: rlo }] } };
  const html = render(<Ask session={nasty} />);
  assert.equal(html.includes('\u202E'), false);
});

test('a carriage return cannot make a pane show text the session never printed', () => {
  assert.equal(scrub('real output\rfake output').includes('\r'), false);
});

test('a session state is derived in one place and covers every stored status', () => {
  assert.equal(sessionState({ status: 'running' }), 'working');
  assert.equal(sessionState({ status: 'running', prompt: {} }), 'waiting');
  assert.equal(sessionState({ status: 'stopped' }), 'stopped');
  assert.equal(sessionState({ status: 'error' }), 'broken');
  assert.equal(sessionState({}), 'finished');
});

test('no rendered output can inject markup', () => {
  // A session can print anything, and this page is on the origin holding every
  // credential. Preact escapes by construction; this asserts it stays true.
  const nasty = { ...WAITING, title: '<img src=x onerror=alert(1)>', prompt: { ...WAITING.prompt, question: '</p><script>alert(2)</script>' } };
  const html = render(<Wall sessions={[nasty]} />);
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('<script>alert(2)'), false);
  assert.match(html, /&lt;img/);
});
