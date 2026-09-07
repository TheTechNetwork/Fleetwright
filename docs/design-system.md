# The design system

**Status: implemented on three surfaces and checked by a test.** The numbers
live in [`test/fixtures/parity/design-tokens.json`](../test/fixtures/parity/design-tokens.json);
`src/web/console/console.css`, `apps/ios/Fleetwright/Design.swift` and
`apps/android/app/src/main/java/network/thetech/fleetwright/Design.kt` each
declare them, and `test/design-parity.test.js` fails a change that moves one and
not the others.

**Scope:** what everything is set in, spaced by, rounded to and coloured with.
Not what the screens *say* — that is `docs/console-design.md` for the console
and `docs/app-parity.md` for the apps — and not the argument for saying it,
which is `docs/psychology.md`.

---

## 1. Why this exists

Three surfaces were built one at a time and each took its look from wherever it
stood:

- **The console** had a palette and no system. Sizes were picked per rule
  (`0.76rem` here, `0.94rem` there, a `clamp()` in the headline), space came off
  four unnamed steps, one radius did every job, and every card was a 1px border.
- **iOS** was stock SwiftUI: a grouped `List`, `.font(.headline)`,
  `.foregroundStyle(.secondary)`. Defensible, fast, and it produced an app that
  looks like the settings screen of a product nobody has named.
- **Android** was Material 3 with `dynamicColorScheme` — *the phone's wallpaper*.
  The same screen came out teal on one device and mauve on another, none of it
  agreed with the console, and "amber means something is waiting for you" cannot
  be true when amber is whatever the wallpaper had.

None of that is a bug and all of it is the same problem: a person who reads a
notification on a phone, opens the app, and then opens the console is looking at
three products. The fleet is one thing. It should look like one thing.

## 2. The system

Every value below is in the shared table, in these units: **px** on the web,
**pt** on iOS, **dp/sp** on Android.

### Type — seven sizes

| Token | Size | Tracking | What it is for |
|---|---|---|---|
| `greeting` | 26 | -0.9 | The assurance line. Once per screen |
| `title` | 22 | -0.8 | The question a session is asking; a sheet's title |
| `section` | 19 | -0.7 | A group of rows, named |
| `body` | 16 | — | Session titles, anything read in order to decide |
| `bodySmall` | 14 | — | The basis under a headline, second-rank prose |
| `label` | 13 | — | Chips, host ids, ordinals |
| `micro` | 12 | — | The line under a name. Never load-bearing |

Headings are tightened and nothing else is: large text at normal tracking reads
loose and accidental, and the same tracking on 13pt costs legibility and buys
nothing. There is no token for it below `section`, and the console's test fails
a rule that tries.

**The face is Inter Tight, and it is nowhere bundled.** On the web it is used
when the machine already has it, with the system UI stack behind it — the
console ships as one inlined file that must open on a phone with no network and
inside viewers that run no scripts, and an `@import` from a font CDN turns
"openable" into "openable if you are online". In the apps it would mean a binary
in the bundle and a licence to carry. What is load-bearing is the *scale*, and
the scale is what is written down.

**The reader's own font size still works.** iOS scales every size through
`@ScaledMetric` against the nearest system text style; Android uses `sp`; the
web uses `rem`. A design system that pins text takes the setting away, on an app
whose whole job is to be readable in a hurry.

### Space — three questions

| Token | Value | The question it answers |
|---|---|---|
| `page` | 26 | How far from the edge of the screen |
| `group` | 22 | How far between groups of cards |
| `groupTight` | 16 | Between cards in a list, and a card's own padding |
| `inside` | 12 | Inside a component |
| `insideTight` | 8 | Inside a row: a glyph and its word |
| `hair` | 4 | A line and the line under it |

Anything tappable is at least 44pt / 48dp tall regardless of what the label
needed, because this gets used on a phone whether or not it was designed to.

### Radius — a hierarchy

| Token | Value | Used by |
|---|---|---|
| `frame` | 54 | The device frame. Nothing draws it yet; it is the store screenshots' number, kept here so there is one of it |
| `card` | 22 | The assurance card, an Ask |
| `cardSmall` | 18 | A session card, a host card |
| `row` | 14 | A row, an option button |
| `chip` | 8 | An ordinal, a status chip |

### Colour

Dark is the default and the one tuned for a dark room: the ground is `#0b0d10`
rather than `#000`, so a lit card does not punch a hole in the retina, and ink
is `#e6e9ef` rather than `#fff`, so a wall of text is not glare.

| Token | Dark | Light | Meaning |
|---|---|---|---|
| `bg` | `#0b0d10` | `#f7f8fa` | The page |
| `card` | `#12151a` | `#ffffff` | A card |
| `inner` | `#171b22` | `#f1f3f7` | An inner surface: a button's ground, a quoted reply |
| `track` | `#232833` | `#e6eaf1` | Tracks and chips |
| `ink` | `#e6e9ef` | `#12151a` | Body text |
| `inkDim` | `#8b93a3` | `#5b6474` | Meta, stopped, unknown |
| `accent` | `#5b8bef` | `#3866d6` | **Interactive only.** Links, focus, hover |
| `accentDeep` | `#3866d6` | `#3866d6` | The brand blue, unchanged by theme |
| `ok` | `#4ade80` | `#0f7a52` | Healthy, finished |
| `attention` | `#fbbf24` | `#a15c00` | **Waiting for you, degraded, and nothing else** |
| `bad` | `#f87171` | `#c02b2b` | Broken, offline, refused |
| `active` | `#38bdf8` | `#0369a1` | Working |
| `unsure` | `#a78bfa` | `#6d43c8` | We cannot say |
| `idle` | `#6b7280` | `#9aa2b1` | Stopped |

Two rules the numbers alone do not carry, and the parity test asserts both:

- **The primary accent is `#3866D6`.** It stays exactly that as a fill and as
  the ramp's fourth step in both themes. Dark raises only the *interactive tint*
  to `#5b8bef`, because `#3866D6` as a hairline on a `#0b0d10` ground does not
  clear it.
- **`active` is a sky blue rather than a second indigo.** The accent means "you
  can tap this"; a status is not an action. A badge that borrows the accent
  teaches the accent two meanings, and a person then has to remember which.

**Never colour alone.** Every tone above reinforces a word that is already on
the screen. Delete the colour and the screen still reads — that is the rule from
`docs/psychology.md` §5, and it is why the vocabulary carries fourteen states on
a palette of four meanings.

### The ramp

Charts and contribution grids: five steps from the muted track colour to the
strongest blue the ground will carry, with the brand accent at step 4.

| Token | Dark | Light |
|---|---|---|
| `chart1` | `#232833` | `#e6eaf1` |
| `chart2` | `#2b3f66` | `#b9caea` |
| `chart3` | `#2f56a3` | `#7b9de2` |
| `chart4` | `#3866d6` | `#3866d6` |
| `chart5` | `#7aa7f7` | `#1e3f8f` |

Nothing draws one yet. It is defined here rather than invented later by whoever
builds the first chart, because a second set of blues is how two surfaces stop
matching.

### Cards have no borders

Zero visible edges anywhere. Separation is an inset highlight, a soft drop
shadow and a subtle 1px ring — and the ring is the one part of the system that
is *not* shared as a number, because the mechanism differs by platform:

| | How a card is separated |
|---|---|
| Web | One composed `--card-shadow`: `inset 0 1px 0` highlight, two-layer drop shadow, `0 0 0 1px` ring |
| iOS | `.background(fill, in: RoundedRectangle)`, a `.strokeBorder` overlay for the ring, `.shadow` under it |
| Android | `Modifier.shadow(…, clip = false).background(…).border(1.dp, …)` — Compose has no inset highlight, so the ring does that work too |

A shared hex for the ring would be a number that agrees while the surfaces do
not, so it is per-platform and the table says why.

**One card at a time wears a tone.** The card that is asking something — the
assurance card when the quiet cannot be vouched for, a session with an open
prompt — swaps its hairline ring for the tone the headline is already carrying.
Everything else keeps the hairline. Calm recedes, trouble comes forward, and
neither depends on the colour being seen.

**Where shadows are not painted, the borders come back.** Forced-colours mode on
the web drops every `box-shadow`, and a borderless card there is three panes of
text running together. `@media (forced-colors: active)` puts a border back, and
only there.

## 3. How it is kept honest

Three checks, each answering something the others cannot:

- **`test/design-parity.test.js`** reads the stylesheet, the Swift and the
  Kotlin and asserts every token in the shared table is declared with the same
  value on all three, in both themes — plus the reverse, that a scale has not
  gained a token in one place only. This is the check that would otherwise be
  somebody holding two phones next to a laptop.
- **`test/design-tokens.test.js`** reads `console.css` alone and fails a colour
  written outside the palette, an off-scale px value, heading tracking applied
  to body text, a card that draws a border, and the two light palettes drifting
  apart — which is silent until somebody flips the theme switch.
- **The app builds.** A token renamed in `Design.swift` and not at its call
  sites is an unresolved symbol; CI compiles both apps on every pull request
  that touches them.

What none of them can see is a token that is declared and never used. The
`frame` radius and the chart ramp are exactly that today, deliberately and on
the record here.

## 4. What is not done yet

The overhaul landed on the surfaces a person actually looks at first: the
console, the iOS session list and its cards, and the Android session list and
its cards, plus the theme both apps hang everything else on.

Still stock, and inheriting only what Material's slots and SwiftUI's defaults
pick up from the theme:

- iOS: the settings and fleet screens, credentials, the start sheet, the file
  browser, the recycle bin.
- Android: the settings panel, the start sheet, the credentials sheet, the file
  and bin sheets, the kinds sheet.

They are not broken — Android's Material slots are filled from the palette, so
an unrestyled screen is on the right colours and the right scale — but the
layout decisions on them are still Material's and SwiftUI's rather than this
document's. That is the next layer, and it is worth doing after the first has
been seen on a real phone rather than before.
