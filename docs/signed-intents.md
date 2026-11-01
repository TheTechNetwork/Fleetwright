# Signed intents: a box obeys a person, not the coordinator

**Status: phases 1 and 2 built; phase 3's switch, delegations, signed
sign-ins and the browser signing page built; pinned admins built, with the
first admin set on each box by whoever runs it ([Pinned admins](#pinned-admins)).**
This is
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
| `forgetperson`, on removal | delete a person's sessions and sign-ins on a box, and drop their pin as an admin there unless it is the last | stays unsigned: it can only take away, which is denial of service |
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
  person on a box (`reboot`, `upgrade`, `update`, a new `channel` or `sandbox`
  image, `restore` of somebody else's work) are checked against **admins the box pins itself**: the first set on
  the box by whoever runs it, and anybody a pinned admin adds by a signed
  intent. A box nobody has pinned anyone on keeps taking the coordinator's
  word, exactly as before ([Pinned admins](#pinned-admins)).

  This said once that the first pin would be *the person whose signed
  approval enrolled it*. Built, that would not have been a pin the
  coordinator could not choose. Approving a box is a person adding its key to
  their own vault, which anybody signed in to the minter can do for any box
  key the coordinator shows them, and the answer that says who approved a box
  is not signed by the minter. And the bullet above is the larger hole: a
  coordinator that lists a throwaway account as a member gets that account's
  key listed, so it signs as `signed`. A first pin anything on the wire can
  make is a first pin the coordinator can make. So it is made on the box.

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
4. **Pinned admins** on each box. *Built: the first is set on the box, and a
   pinned admin adds and removes the rest from their phone (below).*

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

**A phone lists its key before the first tap that needs it.** Each phone
lists its key with the minter on its own, once it has a GitHub sign-in to do
that with, and signs nothing until it has. It used to start the listing in the
background and send the tap unsigned, so the first Apply update after a sign-in
reached a box that enforces a quarter of a second before the minter listed the
key, and was refused as not signed. Now a verb a box would want signed waits
for the listing, at most once in ten minutes, and goes signed if it landed; a
verb that goes unsigned anyway (`list`, `status`) still only starts it, so the
key is usually listed before the first tap that needs it.

**A key the list does not have is asked about again, once.** A box takes the
list every ten minutes, and a phone signs as soon as the minter lists its key,
so a phone added in between was refused on its first request: signed by a key
the minter does not list, about a key the minter had just listed. Now a box
that finds a key it does not have asks for the list again before it answers,
and checks again with what comes back. The list is taken or not on the same
terms as every list, so this changes when a box asks and nothing about what it
believes. It asks this way at most every two minutes (`MISS_REFRESH_MS` in
`intent-keys.js`): the coordinator allows a box twelve asks in ten minutes, and
a stream of strange keys must not spend the ones the regular refresh needs.
The refusal says which happened: the key is missing even from the list just
asked for; the box could not ask again (and why); or it asked moments ago, and
a phone added since then can try again in two minutes.

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

## Pinned admins

**What it guards.** `reboot`, `upgrade` with `apply`, `update`, `channel` and
`sandbox` with a `to`, and a `restore` of somebody else's binned session: the
verbs that reach every person's work on a box
(`src/fleet/host/pinned-admins.js`, `isBoxWide`). The channel decides what
code the next `update` installs, and the sandbox the image every next session
there runs in, so changing either is as box-wide as the update. `upgrade`
without `apply`, and `channel` or `sandbox` without `to`, report and change
nothing, so they are not among them. The coordinator gates the same verbs,
`restore` aside, by who may administer the box (`hosts.js administers`), and
the phones gate the channel and image pickers exactly as they gate Apply
update.

**While a box pins nobody** it behaves exactly as it did before pins existed:
the coordinator's word for who is an admin is the only word there is. Every
box already deployed keeps working, and nobody has to set anything up. Nothing
changes until whoever runs a box pins somebody on it.

**Once it pins somebody**, those verbs need a signature or a delegation from
one of them, checked against the minter's key list as every signature is. The
check holds on a box that does not otherwise require signatures (`off`): an
unsigned actor is the coordinator naming an admin. A person restores their
own binned session on their own signature, pinned or not; whose a session is
comes from the hub's bin, and a session the box cannot attribute is refused,
because a guess would restore somebody else's work. The coordinator still
decides first who may administer a box (`hosts.js administers`), so pins can
only narrow that, never widen it: a fleet admin a box never pinned is let
through by the coordinator and refused by the box.

**The first pin never comes over the wire.** Whoever runs the box sets it, in
its own env file or at its own prompt, which is the same trust as everything
else in that env file:

- `FLEETWRIGHT_ADMINS=you@example.com,them@example.com` in
  `/etc/fleetwright-sidecar.env`, read when the sidecar starts and nobody is
  pinned yet. Once somebody is, the record is the box's word and the env line
  does not overrule it, or a restart would undo every change since.
- `fleetwright-sidecar pin-admin you@example.com`, run as the sidecar's user
  (`sudo -u fleetwright-sidecar …` on Linux, or `runuser -u` where there is
  no sudo). Run as root it is refused, with that command in the refusal,
  wherever another account could change the way to the record: the
  directory, or the nearest one that exists, and every directory above it up
  to `/`, as written and as links resolve, must be root's and writable by root
  alone (a root-owned sticky directory such as `/tmp` above it passes, since
  nobody else can rename what root put there). What root makes anywhere else,
  that account can swap for a link between root's calls
  ([`security.md`](security.md) G10), so root does not write there at all.

Pin people who have already signed in on a phone, so their address is bound
to their GitHub account at the minter (`address_taken`, above). An address
nobody has filed a key under can be claimed first by whoever files one.

**Over the wire**, `pinadmin` (`email`, `op`: `add` or `remove`) lets an admin
the box already pins add another or remove one, signed for that request. A
delegation is refused for it: a delegation is the coordinator holding a
standing permission, and changing who may reboot the box is not one to hand
it. It never makes the first pin, which a coordinator that lists a throwaway
account could otherwise make, and a removal always keeps somebody who can sign:
never the last name, and never one that would leave only addresses no key is
listed for (a typo, somebody who never signed in on a phone), by the same rule
as `forgetperson` below. Either would strand the box from a phone, and that is
done on the box or not at all. The phones offer it only to a pinned
admin, on a box that pins somebody; there is no "pin me".

**When an admin leaves the fleet**, `forgetperson` drops their pin, unless they
are the last pinned admin who can still sign. That one stays pinned, noted as
having left, and the box fails closed: their key is no longer listed, so
nobody signs as them, and those verbs are refused from everybody. *Can still
sign* is the minter's list where the box has it, and otherwise not noted as
having left: an admin who left earlier, or an address no key is filed under (a
typo in `FLEETWRIGHT_ADMINS`, somebody who never signed in on a phone), is not
counted as the one who stays. Counted, the last real admin would be dropped
beside them and the box would refuse everybody with nothing said.

**A stranded box says so.** Whenever it pins somebody and nobody it pins can
sign, its health carries `stranded`: `left` when every admin it pins left the
fleet, `unlisted` when none of them is on the minter's list for another
reason, and `unchecked` when the box holds no key list it may check with: it
has no key of its own to fetch one, has not fetched one yet, or holds one older
than the twenty minutes its signature check takes (`IntentKeys.current`), so
it can check nobody's signature. `unchecked` wins over `left`: a box whose
admins all left but which cannot check anybody is said to be the second, and
it refuses by saying it cannot check rather than that a request was not
signed. The phones then draw none of those verbs for
anybody, the box's own pinned admin included, and show one sentence; on
`unchecked`, which the coordinator passes on beside the sentence, not even a
person's Restore of their own work, which needs their signature checked too. The
sentence is the coordinator's (`PIN_SENTENCES` in
`src/fleet/protocol/intents.js`), keyed by that code, never text the box
wrote: it goes to everybody who sees the box, and a box's own words there
could put the addresses in front of people who are not shown them. None of
them names anybody. It stops when somebody pinned is listed again, as a
person let back into the fleet is. `forgetperson` is the coordinator's alone,
so a forged one can drop a pin and never add one, which is denial of service,
as the table above says.

**The way back is on the box**, for every way the record can be wrong, so
nobody edits the file by hand:

```sh
sudo -u fleetwright-sidecar fleetwright-sidecar admins          # who is pinned, and what is wrong
sudo -u fleetwright-sidecar fleetwright-sidecar pin-admin ADDR  # pin somebody, the first included
sudo -u fleetwright-sidecar fleetwright-sidecar unpin-admin ADDR  # unpin one, the last included
sudo -u fleetwright-sidecar fleetwright-sidecar reset-admins    # nobody pinned: the coordinator's word again
```

`pin-admin` also drops the admins noted as having left, and says whom: the
person pinning a new admin is replacing them, and kept, they would sit beside
the new one unable to sign. Naming one of them again pins them afresh.
Unpinning the last admin, or `reset-admins`, says when `FLEETWRIGHT_ADMINS`
will pin its people again at the next start. All four change the record only
as the account that owns it; as root they are refused with the `sudo -u` (or
`runuser -u`) form to run instead, and `admins`, which only reads, is not.

The running sidecar reads the record on every request, so none of these needs
a restart. A record that cannot be read refuses every guarded verb, from the
wire and from everybody, until `pin-admin` or `reset-admins` replaces it.
Somebody leaving the fleet on a box that pins nobody, or does not pin them, is
answered as it was before pins, without the lock, so a lock that cannot be
taken there never fails the reply.

**The record.** `pinned-admins.json` beside the host key, addresses
lowercased, readable by anyone on the box like `signers.json` beside it.
Written whole by rename, from a temp file created exclusively and synced
first, one change at a time under a lock file, so a `pin-admin` typed on the
box and a `pinadmin` from a phone never lose each other's change. The lock
holds its owner's token: a release removes only its own. A lock older than
thirty seconds was left by a process that died, and is broken by one waiter
at a time, under `pinned-admins.lock.break` created exclusively, which reads
the lock again first and removes it only if it is still stale and still the
token it saw: a lock another waiter has just taken in its place is fresh, and
is left alone. A break file a dead breaker left is removed after the same
thirty seconds, so changes on the box stop for that half minute at most.

**What a phone is shown.** A box's health carries whom it pins. Those are
people's addresses, so the coordinator shapes the field for every reader
(`core.js adminsSeenBy`): the fleet's admin and the people on the list see the
list; anybody else sees how many and that they are not one. That is what a
phone needs to draw Apply update, Apply upgrade, Reboot, the channel and
image pickers and another person's Restore only where the box will take them
from the person holding it (C-2). Somebody not pinned is told they are not
one, and no more: nothing promises that somebody can pin them, which is not
true on a stranded box, nor on an operator's box whose pinned admin the
coordinator will not let administer it. A box that says nothing about pins,
which is every box from before them, is drawn as before.

**What it does not stop.**

- Whoever runs the box can change its pins, as they can change everything
  else on it.
- **Pins hold only where the sidecar's account is not the session user's.**
  On a packaged Linux box the record sits in the sidecar account's own `0700`
  directory, which sessions and the hub cannot write. On a Mac, where the
  sidecar runs as the person's own account (`SIDECAR_USER=$RUN_USER`) and
  sessions run as that account too, outside any container; on a Linux box
  where the installer could not create the sidecar's account and fell back to
  the session user; and on a git checkout, a session runs as the account that
  owns `pinned-admins.json`. It can run `fleetwright-sidecar reset-admins`, or
  rewrite the file, and the pins are whatever it says. The record is the
  operator's word there only as far as the sessions on that box are.
- The coordinator can still drop or delay a pinned admin's intents, and can
  drop a pin with a forged `forgetperson`.
- A box that is itself a virtual machine can still be rebooted or deleted
  from outside it: `vmctl` and `xoact` act through the hypervisor's token,
  on the machine that holds it, and never reach this box's sidecar or its
  pins.
- A box whose operator pins nobody is where it was.

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
