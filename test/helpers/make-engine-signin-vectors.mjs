// Makes the sealed answers under `more` in
// test/fixtures/parity/engine-signin-answer.json, and prints them.
//
// NOT RUN BY ANY TEST. A seal uses a fresh key and nonce and an ECDSA
// signature a fresh number, so no two runs print the same thing, and the
// fixture is what was printed once. What a test can hold, and
// test/engine-signin-answer.test.js does, is that each vector opens, that
// its bytes are the ones the box's own code builds, and that its signature
// holds over them. This file is kept so that anybody can see exactly how
// they were made, and make more the same way:
//
//   node test/helpers/make-engine-signin-vectors.mjs
//
// EVERY RUN MAKES A NEW KEY FOR THE MACHINE, so the fixture's vectors are not
// all under one: the first five were printed by one run, and
// `next-signed-in` and `next-failed-quoted` by a later one, taken from the
// end of what it printed. Each carries its own key and that key's id, and a
// test takes both from the vector it picked, so that changes nothing.
//
// AS A BOX MAKES ONE (src/fleet/host/sidecar.js, where an enginesignin
// answer is sealed): `signed` is the request's id, the key's own id, the
// member, the engine, the page and code while a code is out, `at`, and who
// is signed in; it is signed over `signinAnswerInput(signed)`; and
// `{ v: 1, ...signed, hostKey, signature }` is sealed to the asker's key
// under ENGINE_SIGNIN_AAD.
//
// EACH HAS A `name` a test picks it by. `asked` is the machine the phone
// asked, which a grant must name.
//
// TWO SHAPES. `main` is that, as it is on main. `next` adds three fields to
// `signed` BEFORE it is signed: `state` (the same word as the clear one),
// `detail` (a string or null) and, while a code is out, `expiresAt` (whole
// milliseconds). Its bytes are `signingInput('engine-signin-answer',
// { v: 1, ...signed })`, which is the function `signinAnswerInput` calls,
// given every field. A phone checks the signature over everything it
// opened, so both shapes pass the same check.
import { generateKeyPair, sign, signingInput } from '../../src/fleet/crypto.js';
import { keyId, signinAnswerInput } from '../../src/fleet/protocol/intent-signature.js';
import { newDepositKey, seal, ENGINE_SIGNIN_AAD } from '../../src/fleet/seal.js';

const pair = await generateKeyPair();
const hostKey = { kty: 'EC', crv: 'P-256', x: pair.publicJwk.x, y: pair.publicJwk.y };
const host = await keyId(hostKey);

/** @param {string} name @param {string} why @param {'main'|'next'} shape @param {Record<string, any>} said */
async function make(name, why, shape, said) {
  /** @type {any} */
  const signed = { id: said.id, host, member: said.member, engine: said.engine, ...(said.code ? { url: said.url, code: said.code } : {}), at: said.at, signedIn: said.signedIn };
  if (shape === 'next') {
    signed.state = said.state;
    signed.detail = said.detail ?? null;
    if (said.code) signed.expiresAt = said.expiresAt;
  }
  const input = shape === 'main' ? signinAnswerInput(signed) : signingInput('engine-signin-answer', { v: 1, ...signed });
  const signature = await sign(pair.privateJwk, input);
  const opened = { v: 1, ...signed, hostKey, signature };
  const mine = await newDepositKey();
  const jwk = JSON.parse(mine.secret);
  return {
    name, why, shape, asked: 'ops-box',
    recipient: { d: jwk.d, x: jwk.x, y: jwk.y, publicKey: mine.publicKey },
    sealed: await seal({ to: mine.publicKey, aad: ENGINE_SIGNIN_AAD, payload: opened }),
    opened, host, signingInput: input,
  };
}

const at = 1764100000000;
console.log(JSON.stringify([
  await make('opencode-signed-in', 'OpenCode signed in, which names no account: `who` is null, and no code is out', 'main',
    { id: 'app-0b6f2c1e-51a7-4d0e-9c3b-7a1d2e3f4a51', member: 'debbie', engine: 'opencode', at, state: 'signed_in', signedIn: { since: at - 60_000, who: null } }),
  await make('none', 'nothing here: no attempt and nobody signed in, so `signedIn` is null and that is the machine’s word too', 'main',
    { id: 'app-0b6f2c1e-51a7-4d0e-9c3b-7a1d2e3f4a52', member: 'debbie', engine: 'codex', at: at + 1000, state: 'none', signedIn: null }),
  await make('next-waiting', 'the next shape, a code out: `state`, `detail` and when the code runs out are inside what is signed', 'next',
    { id: 'app-0b6f2c1e-51a7-4d0e-9c3b-7a1d2e3f4a53', member: 'debbie', engine: 'codex', at: at + 2000, state: 'waiting', detail: null,
      url: 'https://auth.openai.com/codex/device', code: 'QRST-5678', expiresAt: at + 2000 + 15 * 60_000, signedIn: null }),
  await make('next-failed', 'the next shape, an attempt that failed: the engine’s own reason is inside what is signed', 'next',
    { id: 'app-0b6f2c1e-51a7-4d0e-9c3b-7a1d2e3f4a54', member: 'debbie', engine: 'codex', at: at + 3000, state: 'failed',
      detail: 'device auth failed with status 403 Forbidden', signedIn: null }),
  await make('foreign-page', 'a code beside a page that is not the provider’s own, signed all the same: a phone draws no code for it', 'main',
    { id: 'app-0b6f2c1e-51a7-4d0e-9c3b-7a1d2e3f4a55', member: 'debbie', engine: 'codex', at: at + 4000, state: 'waiting',
      url: 'https://auth.openai.com.example.test/codex/device', code: 'LMNO-2468', signedIn: null }),
  // THE COMMONEST ANSWER A BOX SENDS, and no vector had it: Codex signed in,
  // which names its account, in the next shape. `who` is an object inside an
  // object inside what is signed, and a phone that wrote either in another
  // order than the box does would refuse every Codex sign-in there is.
  await make('next-signed-in', 'the next shape, Codex signed in: `state` is signed_in and `who` names the account and its plan', 'next',
    { id: 'app-0b6f2c1e-51a7-4d0e-9c3b-7a1d2e3f4a56', member: 'debbie', engine: 'codex', at: at + 5000, state: 'signed_in', detail: null,
      signedIn: { since: at - 120_000, who: { email: 'debbie@example.com', plan: 'plus' } } }),
  // AN ENGINE'S REASON IS ITS OWN WORDS, and they can hold the three
  // characters a JSON writer may spell more than one way: a quote, a
  // backslash and a slash. The bytes signed spell them one way, and a phone
  // that spelled one differently could not check an answer that had it.
  await make('next-failed-quoted', 'the next shape, a reason with a quote, a backslash and a slash in it, each signed as the box writes it', 'next',
    { id: 'app-0b6f2c1e-51a7-4d0e-9c3b-7a1d2e3f4a57', member: 'debbie', engine: 'codex', at: at + 6000, state: 'failed',
      detail: 'the provider said "no" for C:\\Users\\debbie at /codex/device', signedIn: null }),
], null, 2));
