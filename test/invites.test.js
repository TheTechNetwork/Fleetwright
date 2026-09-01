// Letting somebody into the fleet without a deploy.
//
//   node --test test/
//
// `AGENT_FLEET_AUTH_ALLOW` is an environment variable, so adding a person meant
// editing wrangler.toml, committing, and waiting for a deploy — a CODE CHANGE
// PER PERSON, performed by the one person who can already do everything. For a
// product whose premise is "nothing to ssh into", it was the last thing you had
// to be at a keyboard to do.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Invites } from '../src/fleet/coordinator/invites.js';
import { isAllowed } from '../src/fleet/coordinator/oidc.js';

test('an invited person can sign in; the env list still decides on its own', () => {
  // TWO LISTS ANSWERING TWO QUESTIONS. The env one says who this DEPLOYMENT
  // belongs to and survives losing all state, which is what makes it the
  // bootstrap: a coordinator whose storage is empty still knows its owner, so
  // there is always somebody who can let everybody else back in.
  const invites = new Invites();
  const env = ['owner@example.com'];

  assert.equal(isAllowed('guest@example.com', env) || invites.has('guest@example.com'), false);

  invites.add('guest@example.com', { invitedBy: 'owner@example.com' });

  assert.equal(isAllowed('guest@example.com', env) || invites.has('guest@example.com'), true);
  assert.equal(isAllowed('owner@example.com', env), true, 'and the owner never depended on storage');
});

test('a whole domain cannot be invited from a phone', () => {
  // The env list allows `@domain` entries; this deliberately does not. Inviting
  // a company from a phone is a decision whose blast radius nobody can see at
  // the moment they make it — every future address there, admitted by a tap.
  // The env list keeps that power because editing it is already a deliberate
  // act with review attached.
  const invites = new Invites();
  const r = invites.add('@example.com', { invitedBy: 'owner@example.com' });

  assert.equal(r.ok, false);
  assert.equal(invites.has('anyone@example.com'), false);
});

test('nonsense is refused without being echoed back in full', () => {
  const invites = new Invites();
  for (const bad of ['', 'not an email', 'a@b', `${'x'.repeat(400)}@example.com`, null, 42]) {
    assert.equal(invites.add(/** @type {any} */ (bad), { invitedBy: 'o@e.com' }).ok, false, String(bad));
  }
  assert.equal(invites.list().length, 0);
});

test('inviting somebody twice is agreement, not an error', () => {
  // Somebody re-inviting a person is asking "did that work?", and a refusal
  // there reads as a fault.
  const invites = new Invites();
  const first = invites.add('guest@example.com', { invitedBy: 'o@e.com', note: 'the client' });
  const again = invites.add('GUEST@example.com', { invitedBy: 'o@e.com' });

  assert.equal(again.ok, true);
  assert.match(again.message, /already invited/);
  assert.equal(invites.list().length, 1, 'and case is not a second person');
  assert.equal(again.invite?.at, first.invite?.at, 'the original date survives');
  assert.equal(again.invite?.note, 'the client', 'and so does the note');
});

test('withdrawing an invitation does not sign anybody out, and says so', () => {
  // Conflating the two would make "un-invite" quietly mean "revoke every device
  // they hold", which is a bigger action than the word suggests.
  const invites = new Invites();
  invites.add('guest@example.com', { invitedBy: 'o@e.com' });

  const r = invites.remove('guest@example.com');

  assert.equal(r.ok, true);
  assert.equal(invites.has('guest@example.com'), false);
  assert.match(r.message, /keeps working until you revoke it/);
});

test('invitations survive a restart', () => {
  const invites = new Invites();
  invites.add('guest@example.com', { invitedBy: 'owner@example.com', note: 'the client' });

  const restored = new Invites();
  restored.load(JSON.parse(JSON.stringify(invites.toJSON())));

  assert.equal(restored.has('guest@example.com'), true);
  assert.equal(restored.list()[0].invitedBy, 'owner@example.com');
  assert.equal(restored.list()[0].note, 'the client');
});

test('a corrupt stored row is dropped rather than taken as an invitation', () => {
  // Loading is the one path where this data has been outside our hands.
  const restored = new Invites();
  restored.load([{ email: '@example.com' }, { email: 'not an email' }, null, 'nope', { email: 'ok@example.com' }]);

  assert.deepEqual(restored.list().map((i) => i.email), ['ok@example.com']);
});

test('both coordinators gate invites the same way, in every direction', () => {
  // The Worker and the Node coordinator are required to behave identically, and
  // they have drifted before — an admin check that existed on one and not the
  // other, caught only because the tests happened to exercise that one. Same
  // rule, both files, asserted here rather than hoped for.
  const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  for (const [name, file] of [
    ['Node', 'src/fleet/coordinator/server.js'],
    ['Worker', 'worker/src/fleet-do.js'],
  ]) {
    const src = read(file);
    // Admin on EVERY method, reading included: a list of who has been invited
    // is a list of colleagues, and a member has no reason to hold one.
    assert.match(src, /\/api\/invites'\)\s*&&\s*client\s*&&\s*!client\.admin|startsWith\('\/api\/invites'\) && client && !client\.admin/,
      `${name} does not gate invites on admin for every method`);
    // And the sign-in consults both lists. This asserted that the string
    // `invites.has(who.email)` appeared in each file, which was the best
    // available check while the four sign-in checks were COPIED into both.
    // They are one function now — so the property to assert is that neither
    // coordinator has grown its own copy back.
    assert.match(src, /#identify\(/, `${name} does not use the shared sign-in check`);
    assert.doesNotMatch(
      src,
      /isAllowed\(who\.email/,
      `${name} has its own copy of the allowlist check again — identity.js is the one place it belongs`,
    );
    // Stored, or an invitation lasts until the next restart.
    assert.match(src, /invites/, `${name} does not persist invitations`);
  }

  // And the shared function is the one that consults both lists.
  const identity = read('src/fleet/coordinator/identity.js');
  assert.match(identity, /invites\.has\(who\.email\)/, 'identity.js does not honour an invitation at sign-in');
  assert.match(identity, /isAllowed\(who\.email/, 'identity.js does not consult the env allowlist');
});

// --- the email, which is a courtesy and not a credential --------------------

test('the invitation email grants nothing and names the address', async () => {
  // EVERY INVITATION EMAIL ANYBODY HAS RECEIVED CONTAINS A LINK THAT GRANTS
  // SOMETHING. This one must not, because there is nothing here to grant — the
  // person signs in as themselves and the coordinator checks the verified
  // address against a list.
  //
  // What makes it worth sending anyway is the one fact that prevents the most
  // likely failure: WHICH ADDRESS to use. Somebody invited at one address signs
  // in with whichever Google account their phone was holding, is refused as
  // "not on this fleet's list", and cannot tell they are on it under another
  // name.
  const { composeInvite } = await import('../src/fleet/coordinator/invite-email.js');
  const mail = composeInvite({
    email: 'guest@example.com',
    fleet: 'the workshop fleet',
    invitedBy: 'owner@example.com',
    note: 'the billing work',
    apps: { ios: 'https://testflight.apple.com/join/ABC', android: 'https://play.google.com/store/apps/details?id=x' },
  });

  assert.match(mail.text, /Sign in with this address: guest@example\.com/);
  assert.match(mail.text, /nothing in this email to click for access and no code to enter/);
  assert.match(mail.text, /the billing work/);
  // BOTH STORES, EACH LABELLED. One link cannot serve two phones, and the
  // recipient's is the one thing an invitation cannot know in advance.
  assert.match(mail.text, /iPhone or iPad — https:\/\/testflight/);
  assert.match(mail.text, /Android — https:\/\/play\.google\.com/);
  // The TestFlight step people miss, detected from the URL rather than
  // configured — somebody who taps it on a laptop concludes it is broken.
  assert.match(mail.text, /install Apple's TestFlight app first/);
  // No token, no code, no redeem link. Asserted rather than assumed, because
  // this is the file where somebody would helpfully add one.
  assert.equal(/token|code=|invite=|redeem|accept/i.test(mail.text.replace('no code to enter', '')), false);
});

test('a deployment with no app link says so rather than sending a dead end', async () => {
  const { composeInvite } = await import('../src/fleet/coordinator/invite-email.js');
  const mail = composeInvite({ email: 'g@example.com', fleet: 'a fleet' });
  assert.match(mail.text, /has not published a link/);
});

test('a deployment that ships one phone does not imply the other', async () => {
  // Listing "Android — " with nothing after it, or naming a store this fleet
  // has not published to, sends somebody looking for an app that is not there.
  const { composeInvite } = await import('../src/fleet/coordinator/invite-email.js');
  const mail = composeInvite({
    email: 'g@example.com',
    fleet: 'a fleet',
    apps: { android: 'https://play.google.com/store/apps/details?id=x' },
  });
  assert.match(mail.text, /Android — https/);
  assert.equal(/iPhone|iPad|TestFlight/i.test(mail.text), false);
  assert.equal(/has not published a link/.test(mail.text), false);
});

test('not being configured to send is not a failure', async () => {
  // Most deployments will never set this up. An invitation reporting an error
  // because a courtesy was unavailable sends somebody looking for a problem
  // they do not have.
  const { sendInvite } = await import('../src/fleet/coordinator/invite-email.js');
  const about = { email: 'g@example.com', fleet: 'a fleet', invitedBy: 'o@e.com' };

  assert.deepEqual(await sendInvite(null, about), { sent: false, why: 'no email is configured for this fleet' });
  assert.match((await sendInvite({ send: async () => {}, from: null }, about)).why, /no sender address/);
});

test('a refused send is reported, because the person inviting is the one who can fix it', async () => {
  // Cloudflare refuses for reasons an operator can act on and would otherwise
  // never see: an unverified recipient, a plan that does not include sending, a
  // sender domain that is not theirs.
  const { sendInvite } = await import('../src/fleet/coordinator/invite-email.js');
  const r = await sendInvite(
    { from: 'fleet@example.com', send: async () => { throw new Error('E_RECIPIENT_NOT_VERIFIED'); } },
    { email: 'g@example.com', fleet: 'a fleet', invitedBy: 'o@e.com' },
  );

  assert.equal(r.sent, false);
  assert.match(r.why, /E_RECIPIENT_NOT_VERIFIED/);
});

test('the invitation stands whether or not the email went', async () => {
  // The list is the authority and the mail is a courtesy. `add` succeeds before
  // sending is ever attempted, so an invitation whose email bounced is still an
  // invitation — and the reply says which happened rather than implying an
  // email went when it did not.
  const invites = new Invites();
  const r = invites.add('guest@example.com', { invitedBy: 'o@e.com' });
  assert.equal(r.ok, true);
  assert.equal(invites.has('guest@example.com'), true);
});

test('the email binding is configured, and configuring it did not orphan a var', () => {
  // `[[send_email]]` is a TOML TABLE HEADER, so it ends `[vars]` wherever it
  // lands. Put in the middle of that table it would silently move every
  // variable after it out of scope — the Worker would deploy, and the
  // allowlist, the GitHub client id and the demo host would simply be
  // undefined. Nothing here would fail; sign-in would just start refusing
  // everybody.
  //
  // So the file is PARSED rather than read, and the vars that must survive are
  // named. A test that only checked the binding exists would have passed on a
  // file that had broken authentication.
  const toml = readFileSync(new URL('../worker/wrangler.toml', import.meta.url), 'utf8');
  // Minimal reader: table headers and `key = "value"` at top level, which is
  // all this assertion needs and avoids a dependency for one file.
  const vars = new Set();
  let table = null;
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#') || !line) continue;
    const header = /^\[+([^\]]+)\]+$/.exec(line);
    if (header) { table = header[1]; continue; }
    const kv = /^([A-Za-z0-9_]+)\s*=/.exec(line);
    if (kv && table === 'vars') vars.add(kv[1]);
  }

  for (const name of ['AGENT_FLEET_AUTH_ALLOW', 'AGENT_FLEET_GITHUB_CLIENT_ID', 'AGENT_FLEET_DEMO_HOST']) {
    assert.ok(vars.has(name), `${name} fell out of [vars] — sign-in or the demo would break silently`);
  }
  assert.ok(vars.has('AGENT_FLEET_INVITE_FROM'), 'no sender address, so no invitation email can be sent');
  assert.match(toml, /\[\[send_email\]\]/, 'the email binding is not declared');
});

test('the Worker sends through Email Sending, not the reply API', () => {
  // TWO CLOUDFLARE PRODUCTS WITH SIMILAR NAMES, and the first version of this
  // used the wrong one. `EmailMessage` from `cloudflare:email` wraps a raw MIME
  // document and is how you REPLY to mail a Worker received — a different thing
  // from sending to somebody who has never written to you. Email Sending takes
  // a plain object and builds the MIME itself.
  //
  // Asserted because the two are easy to confuse and the failure is invisible
  // until somebody actually invites a person: everything typechecks, bundles
  // and deploys.
  const src = readFileSync(new URL('../worker/src/fleet-do.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  assert.ok(!/cloudflare:email/.test(code), 'still importing the reply API');
  assert.ok(!/new EmailMessage/.test(code), 'still building a raw MIME message');
  // `from` is shorthand in the call, so this must not insist on a colon after
  // it — the first version of this assertion did, and failed on correct code.
  assert.match(code, /binding\.send\(\{[^}]*\bto:[^}]*\bfrom\b[^}]*\bsubject:[^}]*\btext:/s,
    'not calling send() with the sending shape');
});
