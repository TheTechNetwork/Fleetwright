# Signed intents: a box obeys a person, not the coordinator

**Status: designed; phase 1 (observe only) is being built.** This is
SEC-COORD-2 in `docs/security.md` §4.1 and the third row of `docs/trust.md`'s
table. Until phase 3 ships, no document may say the coordinator cannot forge an
instruction, and none does.

## What it changes

A box today does whatever an intent the coordinator sends it says, and the
actor on that intent is a string the coordinator wrote. So a compromised
coordinator, which is the party this system is designed to distrust, owns every
box: it can start a session anywhere as anybody, read any file through
`readfile`, write a credential with `link`, reboot a box.

With signed intents, the phone that asks signs what it asks, and the box checks
the signature against a key it did not learn from the coordinator. The
coordinator is still the transport, so it can drop, delay or reorder what it
carries. It can no longer invent an intent in a person's name. Its worst case
goes from *owns the fleet* to *can deny service*, less the verbs listed under
[What the coordinator still says alone](#what-the-coordinator-still-says-alone),
which are stated rather than hidden.

## The trust root is the minter, not the enrolment pin

`docs/trust.md` puts the question exactly: the hard part is not signing, it is
**who tells a box which keys are real**. A key the coordinator hands out
verifies perfectly and proves nothing. `docs/plan.md` turned the obvious answer
down for a good reason: the enrolment pin is minted by the coordinator, so a pin
"committing to the phone's key" commits to whatever key a compromised
coordinator chose, and six digits cannot commit to a P-256 key against somebody
who can grind keypairs anyway.

**The fleet already has an authority on who a person is that the coordinator
cannot forge: the minting Worker** (`docs/vault.md`, "Who may ask"). It decides
whose vault a request is for from a GitHub token the phone signed in for
through the minter itself, refuses any other token (`not_a_device`), and since
G11 refuses a sign-in a box finished (`box_sign_in`). A box's key gets into a
person's vault only when that person approved it on their phone, after
comparing a fingerprint the box prints. None of that is the coordinator's word.

So the minter becomes the directory of phone keys, the way it is already the
directory of approved box keys:

- **A phone registers its signing key in its own vault**: a new operation,
  `devicekey`, in the request every vault change already is: sealed on the
  phone to the minter's deposit key, carrying the phone's GitHub device token,
  the fleet address it is signed in to, the time, and the public key. It lands
  under `v:<github id>`, at most eight keys a person, each labelled with the
  device's name, and is removed with the same operation and `remove: true`, or
  when the person forgets the device in the app.
- **A box learns keys from the minter, not from the coordinator.** It asks the
  way it already asks for vault items, signed by its own key and relayed by the
  coordinator, and the minter answers with the keys of the people the box may
  act for (below), **signed by the minter's signing key**.
- **A box pins the minter's signing key** from
  `https://<the fleet>/.well-known/fleetwright-minter`, fetched by the box
  itself. That route runs before the coordinator's Custom Domain, so the
  coordinator never sees the request and cannot answer it (`docs/vault.md`,
  "The minter's key"). This is the one new thing a box trusts, and today it
  trusts nothing there: vault answers are sealed to a key the box made for that
  request, which a coordinator could seal to just as well.

What this rests on is the minter's code and storage and the Cloudflare account
both Workers run in, which is already the vault's bound (`docs/vault.md`, "What
it cannot do"). That is narrower than the coordinator by construction: the
minter has no WebSocket to any box and runs no dispatch.

**Why not trust on first use alone.** A box that pins the first key it sees for
a person is safe against a coordinator compromised later, and gets the key
from the coordinator at first use, so it is exactly as safe as the coordinator
was on that day. It stays as a second line: a box keeps every key it has seen
for a person, and a key the minter stops listing is dropped, but a person whose
listed keys all change at once is recorded loudly, as `host.keys-replaced`.

**Why not an offline fleet key.** It is the textbook answer and it is a PKI:
ceremonies, rotation, a thing to lose. The minter already does the identity
half for the vault, with no ceremony anybody has to perform.

## The signature

The phone signs `signingInput('intent', { actor, host, id, issuedAt, params,
verb })`, the form every other signature in the fleet already takes
(`src/fleet/crypto.js`):

```
agent-fleet/v1/intent
<canonical JSON of { actor, host, id, issuedAt, params, verb }>
```

- **Canonical JSON** is keys sorted at every depth, no whitespace, strings as
  JSON escapes them, integers as integers. `params` is what `checkParams`
  returns for the verb, so the phone and the box sign and check the same thing,
  and a parameter an older box drops is not part of what it checks.
- **`host` is the box's id.** A signature for one box does not run on another,
  so the coordinator cannot take a `stop` meant for a test box to a production
  one. A start the person left to placement is signed for the box the
  coordinator chose, after the coordinator says which (one round trip more, on
  `start` only).
- **`actor` is the person's fleet address** as the intent carries it, the one
  the box already reads as `fleet:<address>`, so a signature cannot be moved
  from one person to another.
- **ECDSA P-256 with SHA-256**, the signature as `r || s`, 64 bytes, base64url.
  It is what WebCrypto produces and what CryptoKit's `rawRepresentation` is;
  Android's Keystore produces DER and the app converts it. The key id is the
  whole SHA-256 of the key's canonical JWK, as box keys are named
  (`boxKeyHash`).
- **Replay** is bounded twice: `issuedAt` must be within five minutes of the
  box's clock (`maxSkewMs`), and the box already answers a repeated `id` of a
  mutating intent with the outcome it gave the first time instead of doing it
  again, remembered ten minutes (`REPLAY_TTL_MS`; the sidecar refuses to start
  with a skew window as long as that). A read replayed inside the five minutes
  reads again, and the coordinator carried the first answer anyway.

The envelope gains two fields, `sig` and `kid`, appended as every field has
been (`test/protocol-appendonly.test.js`). A box that does not know them
ignores them, which is the observe phase on an older box for free.

## What is signed

**Every intent a phone or the console sends**, read-only ones included. The
plan once drew the line at "signed = mutating", and `readfile`, `peek` and
`logs` are why it moves: a forged read is how a compromised coordinator would
take a session's work, and nothing about it is read-only from the person's
side. The box enforces signatures on everything except a short unsigned list
whose answers are already in what a box reports by itself: `list`, `status`,
`health`, `updates` and `profiles`.

**Parameters the coordinator writes are not signed.** The protocol marks them
`setBy: 'fleet'`: a start's `archive` and `boxSecrets`, a resume's
`boxSecrets`, a provision's `ticket` and `repo`. The coordinator fills them in
after the person asked, from what it knows about that person, and replaces
anything a caller sent, so a phone cannot know them when it signs. They stay
the coordinator's word, like membership and admin below. Phase 1 found this the
measured way: the first correctly signed start in the end-to-end test failed at
the box, because `boxSecrets` had been added on the way.

**The console** signs with a non-extractable WebCrypto key kept in IndexedDB,
registered with the minter the way a phone's is. A browser profile is weaker
custody than a phone's secure hardware, and the device list in the app says
which kind each key is.

**MCP callers** (`docs/mcp.md`) are the coordinator acting on a person's
behalf, so nothing they send can carry the person's signature. Under
enforcement they act only through a **delegation the person signs on their
phone**: "the coordinator may send these verbs, to these boxes, as me, until
this time", at most a day, listed and revocable in the app, and checked by the
box exactly as an intent is. Without one, an MCP call to an enforcing box is
refused with a sentence saying which delegation would allow it.

## What the coordinator still says alone

Some intents have no person asking at the moment they are sent. Each is listed,
with what a coordinator forging it could do:

| Verb, and when the coordinator sends it | Forged, it could | Under enforcement |
|---|---|---|
| `forgetperson`, on removal | delete a person's sessions and sign-ins on a box | stays unsigned: it can only take away, which is denial of service |
| `vmlogin`, a machine asking for its owner's login | have a box hand a login to a machine that box made | stays unsigned; the box already checks the machine is one it made, running, and asked once (`XoPools#handLogin`) |
| `mint`, a runner's token | ask a box to mint for a job | stays unsigned; the minter checks GitHub's own job token |
| `exchange`, `link`, `renew`, finishing a sign-in | write a credential into a person's row | signed: the phone signs the sign-in when it starts it, for one provider, one box and ten minutes, and the coordinator carries that signature to the finish |
| `vmctl stop` and `provision`, keeping machines ready | stop or make machines from a person's pool | covered by a delegation the phone signs when the person sets "keep N ready", for that pool and those two verbs |
| a runner's held `start` | start a session on a runner | the person signed the `provision` that made the runner; the runner accepts the start that names that provision |

## Who may do what

A signature proves who asked. Whether that person may do it on this box is
still decided by the coordinator today: who is in the fleet, who is an admin,
whom a box acts for. Signing narrows what a compromised coordinator can do with
that, and does not remove it:

- **It cannot act as a real person** without that person's phone. Everything it
  does under enforcement carries the name of whoever's key signed it.
- **A fleet address belongs to the first GitHub account that files a key under
  it.** The vault takes the fleet address from inside the phone's seal and from
  the coordinator, and has always accepted that a dishonest coordinator could
  file a person's own credentials under the wrong name. A key under the wrong
  name is a forged actor, so `devicekey` binds the address to the GitHub
  account on first use and refuses another account's key for it afterwards
  (`address_taken`), until the first one removes its own. A person who never
  files a key can have their address claimed first, so their app shows every
  key filed under their address, and says so when one is not their own.
- **It could still say an outsider is a member.** Anybody can sign in to the
  minter with a GitHub account and register a key, so a compromised
  coordinator that also lists that outsider as a member could have an operator
  box run their sessions, attributed truthfully to them. The minter narrows it:
  it lists keys only for people the coordinator says are in the fleet, which
  can only take away, as the members list already does for the vault.
- **It could still say somebody is an admin.** So the verbs that reach every
  person on a box (`reboot`, `upgrade`, `update`, `restore` of somebody else's
  work) are checked against **admins the box pins itself**: the person whose
  signed approval enrolled it, and anybody they add by a signed intent. A box
  enrolled before this has no pinned admin and keeps taking the coordinator's
  word until somebody signs one.

## Phases

1. **Observe.** The minter gains `devicekey`, the signed key directory and a
   signing key at the well-known address. The coordinator carries `sig` and
   `kid` unchanged. A box pins the minter's key, fetches the directory, checks
   every intent, and **enforces nothing**: it counts signed, unsigned and
   failing intents in its health report and writes a failing one to its own
   log, so the fleet can see what enforcement would refuse before anything is.
2. **Phones and console sign.** *Phones built; the console not yet (below).* A key per device in the Secure Enclave on iOS,
   the Android Keystore with StrongBox where there is one, and WebCrypto in the
   console; registered with the minter at sign-in; every intent signed. Not
   behind Face ID per request: the key never leaves the hardware, and a
   prompt on every tap is how a safety feature gets switched off.
3. **Enforce, box by box.** `FLEETWRIGHT_REQUIRE_SIGNED=1` on a box refuses
   what phase 1 counted, then becomes the default once a release's health
   reports show no unsigned intents from current apps. Delegations and the
   sign-in signatures above ship here.
4. **Pinned admins** on each box.

## Phase 2, as built

**The phones sign** (`DeviceSigning.swift`, `DeviceSigning.kt`):

- **The key.** On iOS it lives in the Secure Enclave. Where there is none (the
  simulator), it is a software key in the keychain, kept on this device only.
  On Android it is a Keystore key, in StrongBox where the phone has it. The
  label the minter lists says which.
- **Listing it.** The phone lists the key with the minter once, through its own
  GitHub sign-in (`devicekey`). It signs only after that, and only for the
  account it is signed in as.
- **Which intents.** A phone signs every intent that names its box. It signs
  over the parameters exactly as sent.
- **The session verbs too.** `stop`, `peek`, `answer`, `resume`, `forget`,
  `restore` and `purge` name only a session, and the coordinator routes them to
  wherever that session is. So the phone names the box its list showed the
  session on, or the box a notification came from, and signs for that. Naming
  it changes nothing about where they go. When the session has moved, the
  intent reaches the box that holds it unsigned.
- **Matching the box byte for byte.** The canonical JSON is written out by hand
  on both phones, because neither platform's encoder writes what JavaScript's
  does. `test/fixtures/parity/intent-signing.json` holds the cases where
  encoders differ, and all three implementations are tested against it.

**The coordinator carries a signature only with what it was made over.**

- **What it keeps.** `dispatch` keeps the id, the person, the box they named and
  their parameters before anything shapes them.
- **What it checks.** `send` compares the signing input of what goes out with
  that, using the function the box uses.
- **When it drops the signature.** Each of the paths found while building
  phase 1 breaks the signature, so each sends the intent unsigned. That is what
  the box counts it as, rather than as a signature that does not hold:
  - the coordinator placing the intent;
  - fanning it out under new ids;
  - setting the actor to a pool's owner;
  - cleaning a value in `checkParams`;
  - dropping a parameter for an older box.

  `test/signed-carry.test.js` holds each of those.

**Still unsigned, and what phase 3 needs first:**

- **What a phone asks of no box.** A signature is for one box, so an intent
  the coordinator places or fans out goes unsigned. Most of those only read
  (`list`, `profiles`, `status` without a name). The ones that change something
  are a `start` or `provision` with no box chosen, and `link` and `unlink`
  across the fleet.
- **An intent the coordinator changes.** Under enforcement, the coordinator
  should refuse it, and say why, rather than send it unsigned to be refused by
  the box.
- **The console and MCP.** The console signs nothing yet. MCP callers need the
  delegations described above.

`docs/security.md` changes in step: SEC-COORD-2 moves from aspirational to
observed after phase 1, and to enforced only after phase 3 is the default.
