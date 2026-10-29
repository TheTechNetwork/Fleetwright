# Signed intents: a box obeys a person, not the coordinator

**Status: phases 1–3 built (`signers` is the default; delegations, signed
sign-ins and the browser signing page are built). Phase 4 is built on the box:
reboot, upgrade, update and a restore of somebody else's work are checked
against admins the machine pins in `pinned-admins.json`. A machine with nobody
pinned still takes the coordinator's word. The phones can pin the signed-in
person; they do not yet list who is pinned or remove them.** This is
SEC-COORD-2 in `docs/security.md` §4.1 and the third row of `docs/trust.md`'s
table. A box with `signers` on, which is the default, refuses an intent a
person did not sign. A box with nobody pinned still accepts the coordinator's
word for who is an admin.

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

**The console and the browser page.** This said once that the console would
sign with a non-extractable WebCrypto key. Measured against the code, that is
both unneeded and unsafe:

- **The console needs nothing.** It sends one intent, `list`, which needs no
  signature. Its answer buttons open the session's Remote Control link; they
  do not send `answer`.
- **The browser page cannot hold the key.** `/me` (`member-page.js`) is the
  page that does send intents from a browser: `connect` and `link`, for a
  member with no phone. The coordinator serves that page. A key the page held
  would sign whatever the coordinator's script asked it to, and the coordinator
  is the party this is built to distrust. Non-extractable does not help: the
  script never needs to read the key, only to ask it to sign.
- **What works.** A page the coordinator neither serves nor can script, on an
  origin of its own: the minter's, on a hostname the coordinator does not
  share. That page holds the key and signs. It is built; see "The browser",
  below.

**MCP callers** (`docs/mcp.md`) are the coordinator acting on a person's
behalf, so nothing they send can carry the person's signature. Under
enforcement they act only through a **delegation the person signs on their
phone**: "the coordinator may send these verbs, to any box, as me, until this
time", for a day or a week, listed and revocable in the app, and checked by the
box exactly as an intent is ([Delegations](#delegations)). Without one, an MCP
call to an enforcing box is refused with a sentence saying where to allow it.

## What the coordinator still says alone

Some intents have no person asking at the moment they are sent. Each is listed,
with what a coordinator forging it could do:

| Verb, and when the coordinator sends it | Forged, it could | Under enforcement |
|---|---|---|
| `forgetperson`, on removal | delete a person's sessions and sign-ins on a box | stays unsigned: it can only take away, which is denial of service |
| `vmlogin`, a machine asking for its owner's login | have a box hand a login to a machine that box made | stays unsigned; the box already checks the machine is one it made, running, and asked once (`XoPools#handLogin`) |
| `mint`, a runner's token | ask a box to mint for a job | stays unsigned; the minter checks GitHub's own job token |
| `exchange`, `link`, `renew`, finishing a sign-in | write a credential into a person's row | delegated: the phone signs a delegation when it finishes the sign-in, for one provider, that box and ten minutes, and the coordinator carries it to the box (built) |
| `vmctl stop` and `provision`, keeping machines ready | stop or make machines from a person's pool | delegated: the phone signs two when the person sets "keep N ready", making machines from that image and ending machines, for a month, signed again daily (built) |
| a runner's held `start` | start a session on a runner | delegated: the phone signs, with the `provision`, a delegation for that start's title, brief, mode and task on any box, for an hour (built) |

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
  work) are checked against **admins the box pins itself**, by the `pinadmin`
  intent. The first pin is the person who signs it, naming themselves; a
  pinned admin adds the rest. Enrolment is a pin the coordinator minted, so it
  is not one of these: a box with nobody pinned keeps taking the coordinator's
  word until somebody signs one. See [Phase 4, as built](#phase-4-as-built).

## Phases

1. **Observe.** The minter gains `devicekey`, the signed key directory and a
   signing key at the well-known address. The coordinator carries `sig` and
   `kid` unchanged. A box pins the minter's key, fetches the directory, checks
   every intent, and **enforces nothing**: it counts signed, unsigned and
   failing intents in its health report and writes a failing one to its own
   log, so the fleet can see what enforcement would refuse before anything is.
2. **Phones sign.** *Built. The console needs nothing, and the browser page
   needs an origin the coordinator does not serve (above).* A key per device in
   the Secure Enclave on iOS and the Android Keystore with StrongBox where there
   is one, registered with the minter at sign-in; every intent signed. Not
   behind Face ID per request: the key never leaves the hardware, and a
   prompt on every tap is how a safety feature gets switched off.
3. **Enforce, box by box.** `FLEETWRIGHT_REQUIRE_SIGNED=1` on a box refuses
   what phase 1 counted, then becomes the default once a release's health
   reports show no unsigned intents from current apps. Delegations and the
   sign-in signatures above ship here. *The switch, its `signers` mode, the
   delegations and the signed sign-ins are built (below), and `signers` is the
   default, and the browser signs through a page of the minter's (below).*
4. **Pinned admins** on each box. *Built, below. The phone pins the signed-in person and does not yet list or remove.*

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

**What a phone asks of no box** goes unsigned, because a signature is for one
box. Most of those only read (`list`, `profiles`, `status` without a name). The
ones that change something are a `start` or `provision` with no box chosen,
and `link` and `unlink` across the fleet.

## Phase 3, as built so far

**The switch.** `FLEETWRIGHT_REQUIRE_SIGNED`, in a box's own env file and
nowhere the coordinator can reach, in one of three ways:

- `off` takes everything and counts it.
- `signers`, the default, refuses what is not signed or delegated by anybody
  this box has been shown a key for, and anything with nobody named. A box runs an intent with
  nobody named as itself (`src/core/accounts.js`, the box's own row), so leaving
  that open would let a coordinator drop the name and act as the box.
- `all` refuses what is not signed or delegated, from anybody.

A value that is none of these stops the sidecar starting.

**Who signs, remembered.** A box keeps the people it has been shown a key for
in `signers.json` beside the minter's key, and goes on enforcing for them across
a restart and across a list that leaves them out. Leaving somebody off the
members list it sends is all a coordinator can do to that list. A person stops
being a signer only when the minter lists them, signed, with no keys: which it
does for a person who removed every key they filed.

**What the box refuses.** Every intent that `needsSignature` names, from a
person the mode covers, unless it is signed or delegated by a key the minter
lists for them. The refusal is `signature_required`, with the reason in words:

- not signed;
- signed by a key the minter does not list for that person;
- a signature or delegation that does not hold for what arrived;
- a delegation that does not cover this intent, here, now;
- a delegation its maker revoked;
- the box has no key list from the minter yet, or no key of its own to ask for
  one.

The last one refuses on purpose. Enforcement that lapsed while the list was
late would be enforcement a coordinator could lapse by holding the list back.

**What it still takes unsigned.** The verbs whose answers a box reports by
itself (`list`, `status`, `health`, `updates`, `profiles`), and the three the
coordinator says alone in the table above (`forgetperson`, `vmlogin`, `mint`).
`intent-signature.js` holds both lists, and the box and the coordinator read
the same ones.

**The coordinator refuses first.** A box that enforces says so in its health:
`signatures.enforcing` is `true` for `all` and `signers` for `signers`. For an
`all` box, and for an intent with nobody named to a `signers` box, the
coordinator refuses what would arrive unsigned and undelegated, sends nothing,
and says which of two things happened: nobody signed or delegated it, or a
person signed it and the fleet changed it on the way.

A named person's request to a `signers` box is sent, because only the box knows
whether it has seen that person's key. When the box refuses it for having
neither a signature nor a delegation, the coordinator adds to the box's words
what to do about it, as steps: open the app, go to You → Delegations, and under
An MCP client tap Allow for a day or Allow for a week. The coordinator's own
refusal ends the same way.

## Phase 4, as built

**The record.** `pinned-admins.json` beside the host key (`xoStateDir`, the
directory `bin/fleetwright-sidecar` already passes). Emails, lowercased, mode
`0600`, written by rename. No directory is not a broken record: the box has
nowhere to have pinned anyone, and box-wide verbs proceed. A missing file is
nobody pinned. A file that cannot be read or parsed refuses every box-wide
verb, because cannot tell is not "nobody".

**While it is empty.** Reboot, upgrade, update and restore behave as they did:
the coordinator's word for who is an admin is the only word there is. A box
enrolled before anyone could pin keeps working.

**Once anybody is pinned.** Those verbs need a verdict of `signed` or
`delegated`, and the actor's address in the set. The check holds on a box
that does not otherwise require signatures: an unsigned actor is the
coordinator naming an admin. Restore of the asker's own binned session is
allowed for a signed actor who is not pinned. Whose it is comes from the
hub's bin (`createdBy`, `fleet:<email>` or a bare address). A bin the box
cannot read, a session that is not in it, or a row with no owner refuses:
cannot tell whose it is, and only a pinned admin may restore somebody else's.

**`pinadmin`.** `email` and `op` (`add` or `remove`). It always needs a real
signature or delegation. The first `add` must name the signer. After that a
pinned admin adds or removes. The last pinned admin cannot be removed, which
would open the box back up to the coordinator's word. Nothing is written on a
refusal. The coordinator places it like reboot: one named box, an admin or
the one person the box acts for, and a tag does not fan it out. It is not an
MCP tool.

**The phones.** "Pin me on this machine", on the machine's page, only when
this person may administer it and the phone knows who they are signed in as.
The host checks that the signed actor is that address, so a stale sign-in is
refused. There is no list of who is pinned, and no remove, until the page can
say who is there.

## Delegations

A delegation is what a person signs on their phone to let the coordinator send
something in their name later, when they are not there to sign it
(`delegationSigningInput` in `intent-signature.js`):

```
agent-fleet/v1/delegation
<canonical JSON of { actor, expires, hosts, id, issuedAt, match, v: 1, verbs }>
```

- **What it names, all of it signed:** the person, the verbs, the boxes (or
  `["*"]` for whichever box the fleet places it on), parameters the intent must
  carry exactly (`match`), and a window of at most a month.
- **How a box checks it:** against the same key list it checks a signature with,
  and then whether it covers this intent, to this box, now. A box takes a
  delegation only on an intent with no signature, because what the person
  signed for this request is the stronger word.
- **What a coordinator can do with one:** exactly what it names, as often as it
  likes, inside its window. It is a standing permission and not a single
  request, which is why each is as short and as narrow as its purpose allows.
- **Taking one back** goes to the minter, not the coordinator, because the
  coordinator is what carries it. The phone files the id in its own keys' row
  (`revokedelegation`, beside `devicekey`), the minter lists revoked ids beside
  each person's keys, and a box refuses a revoked one from the next list it
  takes, within ten minutes. Withdrawing it from the coordinator as well stops
  an honest one carrying it.

**The coordinator keeps them** (`delegations.js`): per person, at most eight
live at once, under one Durable Object value. A renewal covering exactly what an
older one covers replaces it, and a short one (an hour or less) gives way when a
person's allowance is full. A standing one is never dropped to make room. `send`
carries, with an intent that would go unsigned, the delegation that covers it
and runs out soonest, and nothing when none does.

**What each phone signs, and when.** Both phones sign these with the same key
they sign intents with, and only once it is listed:

| For | Verbs | Boxes | Match | Lasts |
|---|---|---|---|---|
| A request the fleet places (no box named) | that verb | any | every parameter as sent | ten minutes |
| A start held until a runner or a pool machine joins | `start` | any | the title, brief, mode and task kept | an hour |
| Finishing a GitHub or Cloudflare sign-in | `exchange`, `link`, `renew` | the box it was for, or any | the provider | ten minutes |
| Keeping machines ready: making them | `provision` | any | `platform: vm` and the image | a month, signed again daily while kept |
| Keeping machines ready: ending them | `vmctl` | any | `action: stop` | a month, the same |
| An MCP client, chosen under You → Delegations | what the MCP tools offer, less `exchange` and `update` | any | nothing | a day or a week |

The phones list every delegation under You → Delegations, with Revoke.

**What an enforcing box still refuses**, because nothing a person signs covers it
yet:

- a browser's Claude sign-in on a machine (`setuptoken`) from a browser that
  has not listed a key with the signing page below; the page lists one before
  it offers to make the sign-in;
- linked repositories and the runner repository when the minter cannot answer
  and the coordinator asks a box instead (`linkrepo`, `runnerrepo`), unless an
  MCP delegation covers them;
- a removal's hand-back to a box leaving the fleet (`stop`, `unlink`), which
  that box's owner could ignore anyway.

## The browser

`/me` (`member-page.js`) is served by the coordinator, so it cannot keep a key
(above). The key is kept by a **signing page** the minting Worker serves on a
hostname of its own (`src/fleet/minter/sign-page.js`), and `/me` asks it.

**Where it is.** A repository variable, `FLEETWRIGHT_SIGNING_HOST`, names a
hostname in a zone the Cloudflare account holds, `sign.fleet.example.com` say.
The deploy (`.github/workflows/worker.yml`) gives the minter that hostname as a
Custom Domain, tells it the fleet's origin (`FLEETWRIGHT_FLEET_ORIGIN`), and
tells the coordinator the page's (`FLEETWRIGHT_SIGNING_ORIGIN`). A Custom
Domain sends every path to the minter, and its POST routes trust that only the
coordinator's binding reaches them, so on the signing host the minter answers
four GETs, the page, GitHub's and Cloudflare's ways back to it and the public
key, and every other path is a 404. Unset, there is no signing page, and a
browser cannot reach the vault: `/me` says so and sends its members to the app.

**Listing the browser's key** is a phone's listing, done by the page:

1. The page makes a P-256 key, not extractable, and keeps it in its own
   origin's IndexedDB. No script can read the private half out, the page's
   included.
2. It signs in to GitHub with a PKCE verifier it keeps, in a window of its own.
   The App's callback is the coordinator's, and a state starting `s.` is sent
   on to the configured signing origin and nowhere else (`oauth.js`,
   `signerReturnUrl`). The code is worth nothing without the verifier, so the
   coordinator seeing it changes nothing; no change to the GitHub App is
   needed.
3. It seals the code and verifier to the minter's deposit key, read from its
   own origin rather than from anything relayed, and the minter finishes the
   sign-in. Then the vault's `devicekey` request, sealed the same way, lists
   the key for the address `/me` is signed in as, which the page shows before
   anything is sent. Both go through `/me`, which adds the browser's fleet
   credential, to `/api/github/device` and `/api/vault` and nowhere else; `/me`
   carries bytes it cannot open.

**The vault, and what it signs.** With the same GitHub sign-in, held in the
window's memory and nowhere else, the page opens the person's vault and does
what the phone's Credentials screen does ([vault.md](./vault.md), "From a
browser"). Every vault request is sealed to the minter and every answer sealed
back to a key made for it. It signs one verb, `setuptoken`, in intents it
builds itself when the person makes a Claude sign-in on a machine: both halves
signed for that machine, the second carrying a key the page made, so the
sign-in comes back sealed to the page. Nothing `/me` sends is signed any more.
It used to send the page each change to an account, to link on machines, and
every machine now refuses a person's link (the vault holds it), so that went,
and a `/me` from before is told so rather than left waiting. `/me` carries four
requests for the page and no others: `/api/github/device`, `/api/vault`,
`GET /api/hosts/enrolled`, and `/api/intent` for `setuptoken` alone.

**What it does not stop.** The coordinator serves `/me`, which carries
everything the page sends, so it can drop or delay it, and it answers the list
of machines, so it could offer a key of its own to approve: which is why each
machine shows the fingerprint the page works out from its key, to compare with
what `fleetwright-sidecar identity` prints. It can also serve a page of its own
that looks like this one and phish a GitHub authorization, which is the same
bound a phone's key has: a key is listed, and a vault opened, by whoever
finishes a GitHub sign-in as the person (`docs/security.md`, SEC-COORD-2). A browser that clears its site data loses
its key, and lists a new one the same way; the old one stays on the minter's
list, unusable, until it is removed from the app under You, Devices.

`test/sign-page.test.js` runs all of it in Chromium against the real minter,
the coordinator's callbacks and `/me`: listing, approving a machine, a named
secret, a Claude sign-in made on a machine, GitHub and Cloudflare, and that
nothing `/me` carried held a secret in the clear.

`docs/security.md` changes in step: SEC-COORD-2 moves from aspirational to
observed after phase 1, and to enforced only after phase 3 is the default.
