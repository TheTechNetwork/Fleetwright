// A notification you can answer, and the two things that have to be true for
// that to be safe.
//
// THE FIRST IS THAT THE BUTTON MEANS WHAT IT SAYS. A notification action's
// title is fixed when the app registers its categories, not when a notification
// arrives — iOS offers no way to put a per-notification word on a button — so
// the words cannot be the labels the CLI drew. They are the fleet's own, in
// prompt.js beside the questions the fleet already writes, and the DIGIT each
// one types is resolved on the host against the labels that pane actually
// rendered. A CLI release that inserts an option renumbers the dialog; an app
// holding "the first button means 1" would then answer a question that is not
// the one on its own button. That is the failure this arrangement exists for
// and the one most of the file below is about.
//
// THE SECOND IS THAT IT IS STILL BEING ASKED. `sentAt` has been sealed into
// every envelope since #351 and neither app has ever read it, which was
// harmless while a tap only navigated: the session list is refreshed from the
// coordinator, so a stale tap landed on current information. An action is not
// harmless, and the window is held here in the same place the delivery TTL
// already lives.
//
// What this file does NOT test is either app. Swift and Kotlin compile in CI;
// what is checkable here is the payload they are given and the vocabulary they
// have to agree with, and that is what the parity test at the bottom is for.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readPrompt, answerActions, describePrompt, ANSWER_TITLES } from '../src/fleet/host/prompt.js';
import { CoordinatorCore, promptForPush } from '../src/fleet/coordinator/core.js';
import { PUSH_TTL_S, fcmPusher } from '../src/fleet/push.js';

const RESUME = `This session is 4 hours old and has 87 messages.

  1. Resume from summary
  2. Resume full session
  3. Don't ask me again`;

const PERMISSION = `Do you want to proceed?

  bash: rm -rf build

  1. Yes
  2. Yes, and don't ask me again for rm commands
  3. No, tell Claude what to do differently`;

const TRUST = `Do you trust the files in this folder?

/home/eli/work/private-client-repo

  1. Yes, proceed
  2. No, exit`;

/** A service account real enough for the sender to sign a token with. */
async function serviceAccount() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return {
    client_email: 'svc@example.iam.gserviceaccount.com',
    project_id: 'p',
    private_key: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64')}\n-----END PRIVATE KEY-----\n`,
  };
}

/** @param {string} pane */
const actionsFor = (pane) => answerActions(/** @type {any} */ (readPrompt(pane)));

// --- the words are ours, the numbers are the pane's -------------------------

test('every dialog we recognise resolves to two of our own answers', () => {
  assert.deepEqual(actionsFor(RESUME), [{ slot: 'a', index: 1 }, { slot: 'b', index: 2 }]);
  assert.deepEqual(actionsFor(TRUST), [{ slot: 'a', index: 1 }, { slot: 'b', index: 2 }]);
  // NOT 1 AND 2. readPrompt drops "don't ask me again", so the option numbered
  // 2 on screen is not an option at all and "no" is the third — which is the
  // whole reason the digit is resolved rather than assumed.
  assert.deepEqual(actionsFor(PERMISSION), [{ slot: 'a', index: 1 }, { slot: 'b', index: 3 }]);
});

test('a CLI that renumbers its options moves the digit and not the button', () => {
  // THE FAILURE THIS DESIGN IS FOR, written as the thing that must keep
  // working. The app holds "the first button says Allow this once" and nothing
  // else; if the numbering shifts, the same button types a different digit and
  // still means what it says. An app holding the digit would quietly start
  // answering something else.
  const shifted = `Do you want to proceed?

  bash: rm -rf build

  1. Read the file first
  2. Yes
  3. No, tell Claude what to do differently`;
  assert.deepEqual(actionsFor(shifted), [{ slot: 'a', index: 2 }, { slot: 'b', index: 3 }]);
  assert.equal(ANSWER_TITLES.permission.a, 'Allow this once');
});

test('the permanent form of yes is never on a button', () => {
  // readPrompt already refuses to carry "don't ask me again" — a global
  // preference flipped from a lock screen, with the least context anybody will
  // ever have. This is the second lock on the same door: `^yes$` rather than a
  // prefix match, so a dialog that offers only the permanent form offers no
  // button at all rather than the wrong one.
  const onlyPermanent = `Do you want to proceed?

  1. Yes, and don't ask me again for rm commands
  2. No, tell Claude what to do differently`;
  const p = /** @type {any} */ (readPrompt(onlyPermanent));
  assert.deepEqual(p.options.map((/** @type {any} */ o) => o.index), [2], 'the permanent yes reached the options');
  assert.deepEqual(answerActions(p), [], 'a lock screen was offered a permanent grant');
});

test('one button is not a decision, so half a match is no match', () => {
  // A notification with a single action reads as a recommendation. If only one
  // side of the question survived, the honest surface is the one that existed
  // before any of this: open the session and answer it with the pane in front
  // of you.
  const onlyYes = `Do you trust the files in this folder?

/home/eli/work/x

  1. Yes, proceed
  2. Something we have never seen`;
  assert.deepEqual(actionsFor(onlyYes), []);
});

test('a dialog we do not recognise offers nothing, as it always did', () => {
  assert.equal(readPrompt('some pane with no dialog on it'), null);
  assert.deepEqual(answerActions({ kind: 'nothing-we-know', options: [] }), []);
});

// --- the setting that decides what may be quoted does not decide this --------

test('a fleet that forbids quoting the session still gets answerable notifications', () => {
  // AGENT_FLEET_PROMPT_TEXT is about what may LEAVE THE BOX. The labels are
  // matched here and never travel; what travels is a slot and a digit, and the
  // words on the buttons were ours before the pane was ever read.
  //
  // This is the property that makes the feature worth having on exactly the
  // fleets most likely to want it: the ones careful enough to have turned the
  // quoting off.
  const prompt = /** @type {any} */ (readPrompt(PERMISSION));
  const shown = describePrompt(prompt, false);

  assert.deepEqual(shown.options, [], 'the labels travelled on a fleet that forbade it');
  assert.equal(shown.question, 'A tool wants permission to run.');
  assert.deepEqual(answerActions(prompt), [{ slot: 'a', index: 1 }, { slot: 'b', index: 3 }]);
});

// --- what the coordinator will put on the wire ------------------------------

test('the coordinator narrows a host prompt rather than forwarding it', () => {
  // A host is a machine somebody else enrolled, and this payload goes out under
  // the coordinator's name. Everything not needed to answer stops here.
  const narrowed = promptForPush({
    id: 'deadbeef',
    kind: 'permission',
    question: 'A tool wants permission to run.',
    options: [{ index: 1, label: 'Yes' }],
    actions: [{ slot: 'a', index: 1 }, { slot: 'b', index: 3 }],
    somethingElse: 'a field a future host invented',
  });

  assert.deepEqual(narrowed, {
    id: 'deadbeef', kind: 'permission', answers: 'a:1,b:3', category: 'fleet.prompt.permission',
  });
});

test('a malformed prompt produces a notification with no actions, not a bad one', () => {
  for (const [what, prompt] of /** @type {[string, any][]} */ ([
    ['nothing at all', null],
    ['a string', 'a:1,b:2'],
    ['an id that is not one of ours', { id: 'nope', kind: 'permission', actions: [{ slot: 'a', index: 1 }, { slot: 'b', index: 2 }] }],
    ['a kind with punctuation in it', { id: 'deadbeef', kind: 'permission; drop', actions: [{ slot: 'a', index: 1 }, { slot: 'b', index: 2 }] }],
    ['an option the answer verb would refuse', { id: 'deadbeef', kind: 'permission', actions: [{ slot: 'a', index: 0 }, { slot: 'b', index: 42 }] }],
    ['a slot that is not a slot', { id: 'deadbeef', kind: 'permission', actions: [{ slot: 'aa', index: 1 }, { slot: 'b', index: 2 }] }],
    ['one action', { id: 'deadbeef', kind: 'permission', actions: [{ slot: 'a', index: 1 }] }],
    ['the same slot twice', { id: 'deadbeef', kind: 'permission', actions: [{ slot: 'a', index: 1 }, { slot: 'a', index: 2 }] }],
  ])) {
    assert.equal(promptForPush(prompt), null, `${what} produced a payload`);
  }
});

test('a session asking something answerable says which question, and how', async () => {
  /** @type {any[]} */
  const sends = [];
  const c = new CoordinatorCore({
    newId: () => 'test-id',
    push: { async send(devices, message) { sends.push({ devices, message }); return { sent: 1, dead: [] }; } },
  });
  await c.registerDevice({ platform: 'ios', token: 'b'.repeat(40) });

  await c.onHostMessage('unabandoned', {
    kind: 'event',
    event: 'session.awaiting-input',
    name: 'bigjob',
    text: 'A tool wants permission to run.',
    prompt: {
      id: 'deadbeef',
      kind: 'permission',
      question: 'A tool wants permission to run.',
      options: [],
      actions: [{ slot: 'a', index: 1 }, { slot: 'b', index: 3 }],
    },
  });

  const { data } = sends[0].message;
  assert.equal(data.promptId, 'deadbeef');
  assert.equal(data.promptKind, 'permission');
  assert.equal(data.answers, 'a:1,b:3');
  // And everything that was already there still is.
  assert.equal(data.name, 'bigjob');
  assert.equal(data.event, 'session.awaiting-input');
});

test('a notification with nothing to answer carries no empty keys', async () => {
  // An empty promptId on every host event is bytes of nothing in a payload both
  // providers cap at 4 KB — and it is also a lie an app has to test for. A key
  // that is present and empty reads as "answerable, badly".
  /** @type {any[]} */
  const sends = [];
  const c = new CoordinatorCore({
    newId: () => 'test-id',
    push: { async send(devices, message) { sends.push({ devices, message }); return { sent: 1, dead: [] }; } },
  });
  await c.registerDevice({ platform: 'ios', token: 'b'.repeat(40) });

  await c.onHostMessage('unabandoned', {
    kind: 'event',
    event: 'session.awaiting-input',
    name: 'bigjob',
    text: 'is waiting for you',
  });

  const { data } = sends[0].message;
  assert.equal('promptId' in data, false);
  assert.equal('answers' in data, false);
});

test('the question does not go into the ring, which has a wider audience', async () => {
  // Push is filtered to whoever owns the session. The event ring is served by
  // /api/events under its own, broader scoping — so the prompt rides beside the
  // event to #notify rather than on it, and this is the assertion that keeps
  // somebody from "tidying" it onto the event object later.
  const c = new CoordinatorCore({ newId: () => 'test-id' });
  await c.onHostMessage('unabandoned', {
    kind: 'event',
    event: 'session.awaiting-input',
    name: 'bigjob',
    text: 'A tool wants permission to run.',
    prompt: { id: 'deadbeef', kind: 'permission', actions: [{ slot: 'a', index: 1 }, { slot: 'b', index: 3 }] },
  });

  const recorded = c.events.at(-1);
  assert.equal(recorded?.event, 'session.awaiting-input');
  assert.equal('prompt' in /** @type {any} */ (recorded), false, 'the prompt was recorded into the ring');
});

// --- what makes the buttons appear at all -----------------------------------

test('a notification with answers names a category, and one without does not', async () => {
  // iOS draws actions only when the payload names a category the app
  // registered, and draws none when it does not. So this field is the
  // difference between a notification you can answer and one you can only open
  // — and its absence is what keeps every other notification exactly as it was.
  /** @type {any[]} */
  const sends = [];
  const c = new CoordinatorCore({
    newId: () => 'test-id',
    push: { async send(devices, message) { sends.push(message); return { sent: 1, dead: [] }; } },
  });
  await c.registerDevice({ platform: 'ios', token: 'b'.repeat(40) });

  await c.onHostMessage('unabandoned', {
    kind: 'event',
    event: 'session.awaiting-input',
    name: 'bigjob',
    text: 'Do you trust the files in this folder?',
    prompt: { id: 'deadbeef', kind: 'trust', actions: [{ slot: 'a', index: 1 }, { slot: 'b', index: 2 }] },
  });
  await c.onHostMessage('unabandoned', { kind: 'event', event: 'session.ended', name: 'bigjob' });

  assert.equal(sends[0].category, 'fleet.prompt.trust');
  assert.equal(sends[1].category, undefined);
});

test('an answerable push reaches iOS with a category and Android without a tray block', async () => {
  // TWO PLATFORMS, TWO MECHANISMS, and Android is the one that costs
  // something. A `notification` block is drawn by the system tray before the
  // app is consulted — which is why it is the default, since it survives a
  // force-stopped app — and it cannot carry actions. Android builds those in
  // onMessageReceived, which does not run once the tray has drawn the message.
  /** @type {any[]} */
  const bodies = [];
  const pusher = fcmPusher(
    await serviceAccount(),
    {
      logger: { info() {}, warn() {} },
      now: () => 1_700_000_000_000,
      fetchImpl: async (/** @type {any} */ url, /** @type {any} */ init) => {
        if (String(url).includes('oauth2')) {
          return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
        }
        bodies.push(JSON.parse(init.body).message);
        return new Response('{}', { status: 200 });
      },
    },
  );

  const device = [{ platform: 'android', token: 'a'.repeat(40) }];
  await pusher.send(device, {
    title: 't', body: 'b', category: 'fleet.prompt.permission',
    data: { name: 'cc-brave-otter', event: 'session.awaiting-input' },
  });
  await pusher.send(device, { title: 't', body: 'b', data: { name: 'cc-brave-otter', event: 'session.ended' } });

  assert.equal(bodies[0].notification, undefined, 'the tray drew it, so the app never got to add buttons');
  assert.equal(bodies[0].apns.payload.aps.category, 'fleet.prompt.permission');
  assert.equal(bodies[0].android.priority, 'HIGH', 'a data-only message needs the wake');
  // AND THE WORDS CAME WITH IT. Dropping the tray block is what takes the title
  // and body away — the tray was the only thing reading them — so they move
  // into data, with the category the app reads to know which two words its
  // buttons say. Without this the notification arrives blank.
  assert.equal(bodies[0].data.title, 't');
  assert.equal(bodies[0].data.body, 'b');
  assert.equal(bodies[0].data.category, 'fleet.prompt.permission');
  // AND NOTHING ELSE CHANGED. Every notification with nothing to answer keeps
  // the tray delivery it has always had, force-stopped app included.
  assert.deepEqual(bodies[1].notification, { title: 't', body: 'b' });
  assert.equal(bodies[1].apns.payload.aps.category, undefined);
  assert.equal('title' in bodies[1].data, false, 'the tray is drawing it, so data is carrying it twice');
});

// --- how long an answer is worth accepting ----------------------------------

test('the window an answer is offered for is the window it was deliverable for', () => {
  // ONE NUMBER, and it is already chosen and already argued for in push.js: an
  // hour is "long enough for a phone in a pocket on a train, short enough that
  // a question answered from a lock screen next morning is not one the host
  // asked yesterday". Both clocks start at `sentAt`, so reusing it makes the
  // rule sayable in one line — a notification is answerable for exactly as long
  // as it was deliverable — instead of two numbers somebody has to reconcile.
  assert.equal(PUSH_TTL_S, 3600);
});

test('the words on the buttons are declared once, for the apps to hold', () => {
  // THE SAME ARRANGEMENT AS THE PALETTE. docs/design-system.md keeps one table
  // of numbers and three files that declare them, because a value written three
  // times drifts. These are three strings written in three languages for the
  // same reason, and the app layers add themselves to this assertion.
  assert.deepEqual(ANSWER_TITLES, {
    resume: { a: 'From a summary', b: 'In full' },
    trust: { a: 'Trust this folder', b: 'Do not trust it' },
    permission: { a: 'Allow this once', b: 'Do not allow' },
  });

  // Every kind that can be answered has exactly two, and every title is short
  // enough for a lock screen to render whole.
  for (const [kind, titles] of Object.entries(ANSWER_TITLES)) {
    assert.deepEqual(Object.keys(titles), ['a', 'b'], `${kind} does not offer two answers`);
    for (const title of Object.values(titles)) {
      assert.ok(title.length <= 24, `"${title}" is too long for a notification action`);
    }
  }
});
