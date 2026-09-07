# Working on Fleetwright

The conventions that are not in the code, for whoever is next — a person or an
agent. Everything else about how this is built is in the comments, which are the
documentation here and are written to be read.

## Before touching an interface

Load **antislop** (installed as a skill), plus `antislop-ui` for a screen,
`antislop-copywriting` for words, `antislop-human` for contrast and keyboards,
and `antislop-layoutmobile` for anything that reflows.

It expects a `DESIGN.md` for direction. Ours is
[`docs/design-system.md`](docs/design-system.md) — the type scale, the spacing,
the radii and both palettes, with a test that keeps the console and the two
phones agreeing on every number.

### The dials, set once, for this product

| Dial | Value | Why |
|---|---|---|
| **ENERGY** | 1, calm | A fleet console is read in a hurry, often at night, often because something is wrong. It should not say hello. |
| **RHYTHM** | 1, uniform | Every host row is the same shape on purpose. A row that looks different should mean something is different, and the design system spends that signal on the card that is asking a question. |
| **MOTION** | 1, hover and state only | Nothing here animates for pleasure. A session changing state is news; a parallax is not. |

`docs/design-system.md` says the same thing in its own words: calm recedes,
trouble comes forward.

### What the rules already have tests for

Do not re-litigate these; change the test if you disagree with the rule.

| Rule | Enforced by |
|---|---|
| One palette, no stray colours | `test/design-tokens.test.js` fails a colour written outside the palette |
| The three surfaces agree | `test/design-parity.test.js` reads the literals in `console.css`, `Design.swift` and `Design.kt` |
| Contrast and forced colours | `console.css` restores borders under `@media (forced-colors: active)`; the palette is checked in the same test |
| Tap targets, mobile reflow | 44px minimum, checked when the console is rendered at 390px |
| C-2, functional completeness | Buttons appear only when the action exists — see the `updates` verb work: "Apply update" is offered when something is waiting and not otherwise |
| C-5, evidence over claims | The rule this repository argues about most. A screen may not report a state it does not know: `null` is *cannot tell* and never *nothing*, and "up to date" is a claim that needs an answer behind it |

## The one rule we do not follow, and why

**R-02 forbids the em dash in any text.** This project does not, in UI strings.

It is 41 of them across the two apps and 26 more in the host's replies, and they
are not decoration: this product's voice is long sentences that name a thing and
then qualify it, and the em dash is the joint. Rewriting them to commas would
not make them sound less generated, it would make them sound less like anything.

The rule's purpose is that text should read as human and specific rather than as
a model's default register. Held to that purpose these strings pass, and
antislop's own framing is that it "bans technique without purpose, not
techniques themselves" — so this is recorded as a decision with a reason rather
than quietly ignored, which is the thing that would actually make the rest of
the rule set noise.

If you want them gone, it is a mechanical change and this paragraph is what
should be deleted with it.

## Everything else

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — one pull request per layer, and why.
- [`docs/ci.md`](docs/ci.md) — what ships where, and the few things still done by hand.
- `./scripts/verify.sh` — the whole gate, the same locally and in CI.
