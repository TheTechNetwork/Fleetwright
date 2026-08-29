# The person on the other end

This project is as much a psychological design as a technical one. Not in the
sense of persuasion or engagement — there is none of that here and there will
not be — but in the sense that every decision is made by a human brain under
conditions we chose, and we can choose better ones.

None of what follows is new. It is already argued, in comments, in at least four
places in this codebase. Writing it down once means the next surface inherits it
instead of re-deriving it, and means a proposal can be argued with on these
grounds rather than only on security or cost.

## The emotional fact this product exists inside

Running autonomous agents on machines you own produces a specific, low-grade,
continuous anxiety: *what is it doing right now, has it broken something, is it
stuck waiting on me, has it been stuck for an hour.*

That anxiety is unbounded because the information is unavailable. The product's
real job is to **convert unbounded anxiety into bounded knowledge** — and the
important consequence is that *"nothing needs you"* is the most important state
in the system, not the least. It is the state a person is in ninety-five percent
of the time, and a surface that only becomes useful when something is wrong
leaves the anxiety exactly where it was.

A screen that says *nothing needs you, and here is why I am confident of that*
does more psychological work than one showing ten metrics.

## The principles, and where each already lives

### 1. An interruption costs far more than the time it takes to answer

The expensive part is not the tap. It is reacquiring the context needed to
decide — what was this session doing, why is it asking, does yes break anything.

Two things follow. **Minimise the number of interruptions**, which the watcher
already argues for itself:

> An event fires on a TRANSITION, never on a state. A session sitting at a
> prompt for an hour is one notification, not 180 — because the second one tells
> you nothing the first did not, and a phone that cries wolf gets its
> notifications turned off, which costs you the one that mattered.

And **make each interruption carry enough that nothing has to be reacquired**.
That is the whole argument for `src/fleet/host/prompt.js`: a notification saying
`resumed (summary)` forces a person to go and find out what is being asked. One
saying *"Resume from summary, or in full?"* can be answered from a lock screen
without loading anything into your head.

### 2. A decision made at 3am from a lock screen has the least context it will
### ever have — so bound what can be decided there

This is why *"don't ask me again"* is never offered on any notification path,
and it is worth being precise about why. It is not primarily a security rule. It
is that a permanent, global, every-future-session grant is exactly the decision
a tired person should not be able to make in one tap, with a phone in one hand,
in the dark. `src/core/claude.js` already filtered it out of the resume dialog;
`prompt.js` now filters it everywhere.

The general form: **the reversibility of an action should scale with the context
available where it is offered.** A lock screen is the lowest-context surface we
have, so only reversible things belong on it.

### 3. Recognition beats recall

A session is named `cc-brave-otter`. Nobody remembers what `cc-brave-otter` is.
They remember *"the billing importer refactor"*.

The generated name is for the system — stable, unique, safe in a path and a
tmux target. The `title` is for the person. Both apps already render
`title ?? name`, and both show the name underneath when they differ, because the
name is what everything else keys on and hiding it makes support impossible.
The rule for any new surface: **lead with what a person would recognise, keep
what the system needs, and never make somebody translate between them.**

### 4. Confirmations must differ in kind, not repeat in number

Already argued at length in `src/core/reboot.js`:

> Tapping yes three times is one decision made three times; a person who misread
> the first prompt misreads all three. So each step asks for something different
> in kind, and each is harder to produce by accident than the last.

Three taps is one decision. A tap, then a PIN that cannot be typed in advance,
then the hostname typed out, is three. The third exists because *"wrong box"* is
the mistake actually worth preventing, and typing the hostname is the only step
that requires having read which machine you are talking to.

Corollary, and the reason revoking a host asks once rather than three times:
**proportionality**. A reboot kills every session mid-thought and cannot be
undone. Revoking a host is disruptive and recoverable. One clear question is the
right answer for the second; three of a different kind for the first. Escalating
everything trains people to click through everything, which is how the reboot
ceremony stops working too.

### 5. Never colour alone

Stated as an accessibility rule and true as a cognitive one. Colour is
pre-attentive — it is *fast* — which makes it excellent reinforcement and
terrible as the sole carrier of meaning. A colour-blind reader loses it
entirely; everybody loses it in sunlight; and a person glancing at a screen
reads the shape and the word before they have consciously processed the hue.

So every state in this system carries a word and a symbol, and the tint only
agrees with them.

### 6. Say what is wrong AND what to do about it

Half the error messages in this codebase are two sentences where one would do,
and that is deliberate. `agent-fleet-sidecar doctor` does not say
`unauthorised`; it says the host is not enrolled and prints the command that
enrols it. The registry works to make *"we don't know"* unrepresentable as a
benign value — it produces `claude is not logged in on this host`, not a blank.

A person reading an error is already frustrated and already has less working
memory available than usual. A message that ends at the diagnosis makes them go
and find the remedy in that state. The remedy is cheap for us to include and
expensive for them to look up.

### 7. Silence must be trustworthy before it is comfortable

If the fleet can be quiet because everything is fine, and *also* quiet because a
host dropped, a token expired or push broke, then quiet means nothing and the
anxiety comes straight back.

This is why a degraded host must never silently vanish from a list — a bug this
branch fixed — why push registration has a *"send a test notification"* button,
and why the console should render the registry's `reason` string rather than
hiding it. **The system has to be able to distinguish "nothing is happening"
from "I have lost the ability to tell you", and say which.**

## Where it was written down and not done

Three of these were argued in this document, agreed, and absent from both
phones. Worth recording, because the gap between a principle and a surface is
where all of them go to die.

**"Nothing needs you" was nowhere.** The document calls it the most important
state in the system and both apps rendered a list of rows. A list is not that:
reading five rows and concluding that none of them is asking anything is work,
and it is work somebody redoes every time they open the app — which is the loop
the anxiety runs in, restarted rather than closed. There is now one line at the
top of both, and it is two sentences on purpose: the headline, and **why it is
confident**. A reassurance with no basis is one somebody has to take on faith.

It leads with the most urgent true clause and nothing else, so a banner cannot
say "3 machines healthy" while a session is waiting. And §7 gets its own branch:
a fleet nobody can hear from is not a fleet with nothing running, and the app
says which — *"the coordinator has no health from any machine, so this cannot
say whether anything is running"*.

**"Running" was doing two jobs.** A session mid-build and one that had not moved
since Tuesday rendered identically, in the same font, and the difference is the
entire question somebody opens the app to ask. The watcher had measured it since
idle-restart shipped and the session list did not carry it. Both apps now show
*"quiet for 20m"* — with a five-minute floor, because a pane pauses constantly
and a counter that resets every few seconds is noise that teaches people to
ignore the field, and never for a session at a prompt, which is still because
somebody has to answer it.

**And a host could be signed in while every session it started came up signed
out.** §7 again: the system has to be able to distinguish "nothing is happening"
from "I have lost the ability to tell you". `claude auth status` answers about
the box's home directory; a sandboxed session runs on a copy. Both are published
now, and the coordinator degrades a host on the second — narrowly, only when the
token has expired and there is nothing to renew it with, because a warning that
fires on the ordinary case is one people stop reading.

## What this rules out

Anything that manufactures engagement. No streaks, no badges that exist to be
cleared, no notification whose purpose is to bring somebody back, no metric
presented because it moves rather than because it is decidable on. The
interruption budget belongs to the sessions, and spending any of it on the
product itself is spending it against the person.
