package network.thetech.fleetwright

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * Talking to the coordinator.
 *
 * Deliberately HttpURLConnection rather than a client library. The whole API is
 * four endpoints returning flat JSON — §7 designed it that way so a Shortcut
 * could call it — and a dependency here would be carried for the life of the
 * app to save about thirty lines.
 */
class Fleet(
    private val settings: Settings,
    /**
     * Where a command goes when the fleet cannot be reached. Null for a Fleet
     * built for a one-off read, which carries no queue at all.
     */
    private val outbox: Outbox? = null,
) {

    /** A session as the coordinator reports it, with its host attached. */
    data class Session(
        val name: String,
        val title: String?,
        val status: String,
        val hostId: String?,
        val rcUrl: String?,
        val resumable: Boolean,
        /** Where the work is happening. Null from an older sidecar. */
        val cwd: String? = null,
        /**
         * When it started, epoch millis. A DURATION would be stale the moment
         * it was serialised; the arithmetic belongs here, where the clock is
         * live.
         */
        val startedAt: Long? = null,
        /** Whose Claude account it runs on: an email, or "shared". */
        val account: String? = null,
        /**
         * What it is asking, when it is asking. Present only while a prompt is
         * on screen; the id is what makes answering it later safe.
         */
        val prompt: Prompt? = null,
        /**
         * When this session's pane last changed, epoch millis.
         *
         * A timestamp rather than a duration, for the same reason [startedAt]
         * is: the phone doing the arithmetic is the only place it stays right
         * while a screen is open.
         *
         * Null for a session that is not running, and for one showing a
         * prompt: that pane is still because somebody has to answer it, which
         * is the opposite of idle.
         */
        val idleSince: Long? = null,
        /**
         * Is the pane showing the session's own prompt — finished, or between
         * things, and waiting for input?
         *
         * THE DIFFERENCE A TIMER CANNOT SEE. A finished session and a wedged
         * one both stop changing, and this app rendered both as "quiet for
         * 3h" — true of each, useful about neither, when which one it is is
         * the whole question somebody opens the app to ask.
         */
        val atRest: Boolean = false,
        /**
         * How full its window is: the tokens in context at the last assistant
         * turn, and the model that answered, as the host read them off the
         * transcript. No size and no percentage — the transcript does not say
         * how big the window is, and a table of models here would be wrong the
         * week one changed. Null is CANNOT TELL: not running, no turn yet, an
         * older host. Drawn as nothing, never as empty.
         */
        val context: ContextUsage? = null,
        /**
         * Since when it has been blocked on a person, epoch millis on the host's
         * clock, or null when it is not.
         *
         * THE "SINCE WHEN" THE STATE SENTENCE NEVER HAD. "Waiting for you" said
         * the same thing about a dialog that went up a moment ago and one that
         * has sat there since last night, and those are different errands. A
         * floor rather than a stopwatch: where only the pane showed it, the
         * host stamps the first look that saw it.
         *
         * Set even when the host could not read the question, so a session
         * waiting on something with no [prompt] still reads as waiting.
         */
        val awaitingSince: Long? = null,
        /**
         * How this run has spent its time — working, waiting on a person, at
         * its own prompt — from the session's own hooks. Closed totals and when
         * the open stretch began; the phone adds the open part, for the same
         * reason [startedAt] is a timestamp. Null is CANNOT TELL: an image older
         * than the hooks, a run that has said nothing yet.
         */
        val phases: Phases? = null,
        /**
         * What the conversation has cost, as Claude Code itself counted it. The
         * host reads the figure Claude Code writes into its transcript and never
         * prices anything; neither does this app. Null is CANNOT TELL and is
         * drawn as nothing, never as $0.00.
         */
        val spent: Spent? = null,
        /**
         * THE ARCHIVE (#346): the private repository it is pushed to before
         * it stops, and what happened the last time it was. All null on a
         * session with no archive and from a host older than archiving, and
         * nothing is drawn then: no archive is not "not archived".
         */
        val archive: String? = null,
        val archiveAt: Long? = null,
        val archiveOk: Boolean? = null,
        val archiveText: String? = null,
    ) {
        /**
         * The archive line for the session's page, or null when it has none.
         * Before the first push it says so rather than implying one landed
         * (C-5); after, it is the host's own sentence about the last push.
         * Same words as iOS, held equal by test/linked-repos-in-apps.test.js.
         */
        val archiveLine: String? get() {
            val repo = archive?.takeIf { it.isNotBlank() } ?: return null
            if (archiveAt != null) archiveText?.takeIf { it.isNotBlank() }?.let { return it }
            return "Pushed to $repo before it stops. Nothing has been pushed yet."
        }

        // Not `Context`: android.content.Context is imported in this file, and a
        // nested class of the same name is a reading trap for whoever is next.
        data class ContextUsage(val tokens: Long?, val model: String?)

        /** Every field nullable, though the host always sends all six. */
        data class Phases(
            val since: Long?,
            val current: String?,
            val currentSince: Long?,
            val workingMs: Long?,
            val awaitingMs: Long?,
            val readyMs: Long?,
        )

        /**
         * The parts of Claude Code's figure this app draws. [complete] is false
         * when it said some model had no known price, which makes the dollars a
         * floor.
         */
        data class Spent(val usd: Double?, val complete: Boolean, val outputTokens: Long?, val asOf: Long?)

        /**
         * Blocked on a person: a question the host could read, or the host
         * saying it is waiting on one it could not.
         */
        val isWaitingOnYou: Boolean get() = prompt != null || awaitingSince != null || status == "awaiting-input"

        /**
         * "12m": how long it has waited on a person, or null under a minute and
         * when it is not waiting. Coarse, like [age], because the question is "a
         * moment or an hour", and the figure is a floor.
         */
        fun waitedFor(now: Long = System.currentTimeMillis()): String? {
            val since = awaitingSince?.takeIf { it > 0 } ?: return null
            val seconds = (now - since) / 1000
            if (seconds < 60) return null
            return coarse(seconds)
        }

        /**
         * "Worked 42m · waited on you 3m · at its prompt 1h 10m", or null.
         *
         * WORKING VERSUS WAITING, which is the question the stillness clock
         * cannot answer: forty minutes of work and two hours on a dialog look
         * the same on a pane. A stretch under a minute is left out rather than
         * drawn as noise, except the working one, which is the line's subject.
         * And when the host began counting well after the session started (a
         * restart of the box's hub), it says so instead of letting the missing
         * hours read as none. Same words as iOS, held equal by
         * test/telemetry-in-apps.test.js.
         */
        fun timeLine(now: Long = System.currentTimeMillis()): String? {
            if (!isRunning) return null
            val p = phases ?: return null
            val since = p.since ?: return null
            val current = p.current ?: return null
            val currentSince = p.currentSince ?: return null
            var working = p.workingMs ?: return null
            var waiting = p.awaitingMs ?: return null
            var ready = p.readyMs ?: return null
            val open = if (current == "ended") 0L else maxOf(0L, now - currentSince)
            when (current) {
                "working" -> working += open
                "awaiting" -> waiting += open
                "ready" -> ready += open
            }
            val parts = mutableListOf("Worked ${span(working)}")
            if (waiting >= 60_000) parts += "waited on you ${span(waiting)}"
            if (ready >= 60_000) parts += "at its prompt ${span(ready)}"
            val started = startedAt
            if (started != null && since - started >= 300_000) parts += "counted for the last ${span(now - since)}"
            return parts.joinToString(" · ")
        }

        /**
         * "$12.40 at API prices · 48k tokens out", or null.
         *
         * "AT API PRICES" because that is what the figure is: Claude Code prices
         * its own tokens at the API's list price, and on a Pro or Max sign-in
         * that is not what anybody is billed. A bare dollar sign would read as a
         * bill. "At least" when Claude Code said it could not price everything,
         * and "as of" when a running session's figure is from its last pause —
         * it is written when a turn ends, not during one. Same words as iOS.
         */
        fun spentLine(now: Long = System.currentTimeMillis()): String? {
            val s = spent ?: return null
            val parts = mutableListOf<String>()
            s.usd?.takeIf { it >= 0 }?.let { usd ->
                parts += "${if (s.complete) "" else "at least "}\$${String.format(java.util.Locale.ROOT, "%.2f", usd)} at API prices"
            }
            s.outputTokens?.takeIf { it >= 0 }?.let { out ->
                parts += "${compactTokens(out)}${if (out < 1000) "" else " tokens"} out"
            }
            if (parts.isEmpty()) return null
            val asOf = s.asOf
            if (isRunning && asOf != null && asOf > 0) {
                val age = (now - asOf) / 1000
                if (age >= 300) parts += "as of ${coarse(age)} ago"
            }
            return parts.joinToString(" · ")
        }

        /** What to show. The name is the identity; the title is for people. */
        val label: String get() = title?.takeIf { it.isNotBlank() } ?: name

        /**
         * "248k in context", or null when the host did not say. Same words as
         * iOS, held equal by test/context-and-usage-in-apps.test.js.
         */
        val contextLine: String? get() {
            if (!isRunning) return null
            val tokens = context?.tokens?.takeIf { it >= 0 } ?: return null
            return "${compactTokens(tokens)} in context"
        }

        companion object {
            /**
             * 412 → "412 tokens", 248_717 → "248k", 1_200_000 → "1.2M". Coarse
             * on purpose: the question is "how full", never the exact count.
             */
            fun compactTokens(tokens: Long): String = when {
                tokens < 1000 -> "$tokens tokens"
                tokens < 1_000_000 -> "${tokens / 1000}k"
                else -> String.format(java.util.Locale.ROOT, "%.1fM", tokens / 1_000_000.0)
            }

            /**
             * 42 minutes → "42m", 70 → "1h 10m", 120 → "2h". Finer than [age],
             * because "worked 1h" for seventy minutes hides most of an hour.
             */
            fun span(ms: Long): String {
                val minutes = ms / 60_000
                if (minutes < 1) return "under 1m"
                if (minutes < 60) return "${minutes}m"
                val rest = minutes % 60
                return if (rest == 0L) "${minutes / 60}h" else "${minutes / 60}h ${rest}m"
            }

            /** The same coarse units as [age]: "9m", "3h", "2d". */
            fun coarse(seconds: Long): String = when {
                seconds < 3600 -> "${seconds / 60}m"
                seconds < 86_400 -> "${seconds / 3600}h"
                else -> "${seconds / 86_400}d"
            }
        }

        val isRunning: Boolean get() = status == "running"

        /**
         * How long it has been quiet, once that is long enough to mean
         * something.
         *
         * "Running" was doing two jobs: a session mid-build and one that has
         * not moved since Tuesday looked identical, in the same font, and the
         * difference is the entire question somebody opens this app to ask.
         *
         * NOTHING UNDER FIVE MINUTES. A pane pauses constantly — waiting on a
         * network call, thinking, between tool calls — and a counter that
         * resets every few seconds is noise that trains people to ignore the
         * field. This answers "has it been stuck for an hour", which is the
         * anxiety in docs/psychology.md, not "is it typing".
         */
        val quietFor: String? get() {
            val howLong = idleFor ?: return null
            // TWO SENTENCES, BECAUSE THEY ARE TWO SITUATIONS. A session at its
            // own prompt finished, or is between things, and needs nothing —
            // saying "quiet" about it invites a person to worry at the most
            // common state in the fleet. A pane stopped mid-work with no
            // prompt on it is the one worth a second look.
            return if (atRest) "ready · idle $howLong" else "quiet for $howLong"
        }

        /**
         * How long the pane has been still, as "9m" / "3h" / "2d", or null
         * under five minutes and whenever the question does not apply: a
         * stopped session, or one showing a prompt, whose pane is still
         * because somebody has to answer it.
         */
        val idleFor: String? get() {
            if (!isRunning || prompt != null) return null
            val since = idleSince?.takeIf { it > 0 } ?: return null
            val seconds = (System.currentTimeMillis() - since) / 1000
            if (seconds < 300) return null
            return when {
                seconds < 3600 -> "${seconds / 60}m"
                seconds < 86_400 -> "${seconds / 3600}h"
                else -> "${seconds / 86_400}d"
            }
        }

        /**
         * The one sentence about what this session is doing, owned here and
         * nowhere else. Same words as iOS, held equal by
         * test/session-screen.test.js.
         *
         * Every sentence is a fact the frame carries, and nothing is promoted
         * to a claim the frame does not make: a pane at its own prompt is "at
         * its prompt", not "finished", because a session between two steps
         * looks exactly the same; a quiet pane with no prompt is "quiet", not
         * "stuck", for the same reason. `ended` is the one word the host
         * itself uses for a session that concluded.
         */
        val stateSentence: String get() {
            // HOW LONG, once it is long enough to say: the difference between a
            // question to answer now and a person who is not coming.
            if (isWaitingOnYou) return waitedFor()?.let { "Waiting for you · $it" } ?: "Waiting for you"
            if (isRunning) {
                if (atRest) return idleFor?.let { "At its prompt · idle $it" } ?: "At its prompt"
                idleFor?.let { return "Quiet for $it" }
                return "Working"
            }
            // "Ended", not "Finished": a crash and a success share this
            // status, and the screen cannot tell them apart (C-5).
            if (status == "ended") return "Ended"
            if (status == "stopped") return if (resumable) "Stopped · can be resumed" else "Stopped"
            return status
        }

        /**
         * Worth counting as "a session somebody might want to look at". A
         * finished one is not.
         */
        val looksStalled: Boolean get() = quietFor != null && !atRest

        /** The last path component — what a person recognises about a checkout. */
        val workspace: String? get() = cwd?.takeIf { it.isNotBlank() }?.trimEnd('/')?.substringAfterLast('/')

        /**
         * "3h" — coarse on purpose. The exact age of a session is never the
         * question; "since this morning" or "still going after two days" is.
         */
        val age: String? get() {
            val started = startedAt ?: return null
            if (started <= 0) return null
            val seconds = (System.currentTimeMillis() - started) / 1000
            return when {
                seconds < 60 -> "just now"
                seconds < 3600 -> "${seconds / 60}m"
                seconds < 86_400 -> "${seconds / 3600}h"
                else -> "${seconds / 86_400}d"
            }
        }
    }

    data class Prompt(
        val id: String?,
        val question: String?,
        val options: List<Option>,
    ) {
        data class Option(val index: Int, val label: String)
    }

    /**
     * What a box says about itself. Everything optional: an older sidecar
     * sends none of it, and the app must show a host with less information
     * rather than no host at all.
     */
    /**
     * A session that was forgotten and is still recoverable.
     *
     * `expiresAt` is a timestamp rather than a rendered string so the phone
     * does the arithmetic — "two days left" stays right while the screen is
     * open, and a server-rendered string would freeze the moment it was sent.
     */
    data class Binned(val name: String, val title: String?, val expiresAt: Long) {
        val remaining: String?
            get() {
                if (expiresAt <= 0L) return null
                val left = expiresAt - System.currentTimeMillis()
                if (left <= 0L) return "gone"
                if (left < 3_600_000L) return "goes within the hour"
                if (left < 86_400_000L) return "${left / 3_600_000L}h left"
                val days = left / 86_400_000L
                return "$days day${if (days == 1L) "" else "s"} left"
            }
    }

    data class FleetHost(
        val hostId: String,
        val state: String?,
        val reason: String?,
        val loggedIn: Boolean?,
        /**
         * How many people have connected a Claude account on this machine.
         *
         * The field that replaced [loggedIn] as the one worth judging a host
         * on: a machine has no Claude account of its own, so `loggedIn: false`
         * is the ordinary state of every box. Zero here is the real fault; null
         * is an older host and is not one.
         */
        val claudeAccounts: Int? = null,
        /**
         * On a runner, what a session there signs in with when nobody has
         * linked an account: "owner", "key" or "none". Null on a permanent box,
         * and on a runner that has not heard back yet.
         */
        val runnerAuth: String? = null,
        /** A runner: a machine somebody started for an hour, expected to vanish. */
        val ephemeral: Boolean = false,
        val accountEmail: String?,
        val accountPlan: String?,
        val accountOrg: String?,
        val version: String?,
        /**
         * What the box's disk holds, on a packaged box: the release `current`
         * points at, which is what the service would run after a restart.
         * Null on a checkout and on a host too old to say.
         *
         * When this differs from [version] the box is waiting on a restart and
         * nothing else. That is its own state; it used to read as "up to date",
         * because "up to date" was measuring what was left to download, which
         * was nothing, about a service fourteen releases behind its own disk.
         */
        val installed: String? = null,
        /**
         * Whether root's half of the box is this release's: "current",
         * "stale", or null for cannot tell (a checkout, a box with no helper,
         * or a host too old to say).
         *
         * The update helper is what every update runs as root, and the
         * installer is the only thing that writes it. A box whose helper the
         * installer never refreshed takes every update, restarts its services,
         * and refreshes nothing root owns: the units, the hook and the sudoers
         * rules stay as an earlier installer left them. The host compares the
         * two copies without root and says which.
         */
        val helper: String? = null,
        val behind: Int?,
        /**
         * What the operating system has waiting, already in prose from the host
         * — "4 packages (2 security)". Sent since maintenance shipped and shown
         * nowhere until now, which is why upgrade looked like a verb that could
         * only report and never act.
         */
        val systemUpdates: String?,
        val rebootRequired: Boolean,
        /**
         * What a release-installed box found waiting for it.
         *
         * NOT INTERCHANGEABLE with [behind], and only one is ever set: a
         * release has no git history to count, so `appBehind` is null on those
         * boxes — CANNOT TELL — which is why a packaged host showed nothing
         * here for as long as the packaging existed.
         */
        val release: Release? = null,
        /**
         * What the box allows from the app: system upgrades, and reboot. Each
         * is a root-owned sudoers rule on the machine, and a phone cannot
         * write that rule and must not be able to — so the app draws a button
         * only where it would work, and names the one line on the box that
         * turns it on elsewhere.
         *
         * NULL IS CANNOT TELL, from a host too old to say, and is not "off":
         * the buttons stay, and the host's own refusal explains.
         */
        val grantUpgrades: Boolean? = null,
        val grantReboot: Boolean? = null,
        /**
         * Forgotten, still recoverable. Empty on a host that has not been
         * updated — which renders as no section at all, the correct answer for
         * a box where forget still deletes.
         */
        val bin: List<Binned> = emptyList(),
        /**
         * What a session started on this box would actually be given.
         *
         * NOT THE SAME QUESTION AS [loggedIn], which is the distinction that
         * cost an evening: `loggedIn` reports on the box's own home directory,
         * while a sandboxed session runs on a copy of a credential file taken
         * when its volume was made. A box can report itself signed in and hand
         * every new session a token that expired hours ago.
         *
         * Null means the host could not tell — an older host, or one that does
         * not sandbox. Never rendered as a fault.
         */
        val credential: Credential? = null,
        /**
         * Which releases this box installs — "stable" or "rolling".
         *
         * NULL IS CANNOT TELL, not "stable". A host older than the channel verb
         * sends nothing, and labelling it stable would be the app asserting
         * something it was never told — the same rule [credential] is written
         * around.
         */
        val channel: String? = null,
        /**
         * The box's environment is forcing the channel, so the control is shown
         * as an answer rather than as a choice. Said before somebody taps,
         * rather than discovered by a refusal afterwards.
         */
        val channelPinned: Boolean = false,
        /**
         * Which image new sessions run in, and whether the box's environment
         * names it outright.
         *
         * NULL IS CANNOT TELL, the same rule as [channel] above. A host older
         * than the sandbox verb sends nothing, and rendering that as "minimal"
         * would tell somebody their box has no browser when it might.
         */
        val sandboxVariant: String? = null,
        val sandboxImage: String? = null,
        val sandboxPinned: Boolean = false,
        /**
         * What `tag` matches on for this box: os, architecture, distribution,
         * whether its image has a browser, plus anything set from an app or in
         * FLEETWRIGHT_LABELS.
         */
        val labels: List<String> = emptyList(),
        /**
         * WHICH OF THOSE CAN BE TAKEN OFF. The flat list cannot say — `arm64`
         * and `gpu` look identical in it, and the host refuses to drop one of
         * them. Rendering the flat list would put a Remove on every chip and
         * let somebody discover by tapping which ones do nothing.
         */
        val setLabels: List<String> = emptyList(),
        /**
         * Which service journals this box can read: some of `hub`,
         * `coordinator`, `sidecar`, in the host's order. A button is drawn for
         * exactly these — a box that never ran a coordinator would otherwise
         * offer one that answers "no log entries", which reads as a broken
         * service rather than an absent one.
         *
         * NULL IS CANNOT TELL: a host older than this field. The verb works
         * there too, but this app has not been told which of the three will
         * say anything, so it says that instead of guessing.
         */
        val logs: List<String>? = null,
        /**
         * How many characters of house rules this box writes into every new
         * session as ~/.claude/CLAUDE.md. A NUMBER, not a flag: rules are read
         * on every turn of every session, so the size is the cost and the only
         * fact a person deciding about them needs.
         *
         * Three states. A count is what every new session here gets. Zero is a
         * rules file that is on the box and NOT in use, a fault somebody should
         * see rather than silence. Null is no file at all, the normal case and
         * also what a host too old to send this looks like; the sheet says
         * nothing for it rather than guessing.
         */
        val houseRules: Int? = null,
        /**
         * The host's own answer to "is there something to apply", and the only
         * one that is right for every kind of box. Null from a host too old to
         * send it, and null from a host that could not find out.
         */
        val appPendingReported: Boolean? = null,
    ) {
        /**
         * Two separate answers, because they are two actions on two things.
         *
         * THE FALLBACK IS WRONG ON A PACKAGED BOX and survives only for hosts
         * that predate [appPendingReported]. `behind` is null on a release —
         * there is no history to count — so `?: 0` reads CANNOT TELL as NOTHING
         * WAITING, and `release.available` is null both when nothing is waiting
         * and when the check could not reach GitHub. Two flavours of "we do not
         * know" rendering as "you are current", with the Apply button hidden.
         */
        /**
         * The release on disk that this service is not yet running, or null
         * when there is no gap or no way to know. A difference between two
         * strings, never a flag from the host: a phone cannot be told "restart
         * waiting" by a frame that does not also show its work.
         */
        val restartWaitingFor: String?
            get() = installed?.takeIf { it.isNotBlank() && version?.isNotBlank() == true && it != version }

        /**
         * True only when the host said so. Null and "current" both read as
         * nothing to say: a line about root's half being fine is a line about
         * a thing nobody is thinking about.
         */
        val rootHalfBehind: Boolean
            get() = helper == "stale"

        val appPending: Boolean
            get() = appPendingReported ?: ((behind ?: 0) > 0 || release?.available != null)

        /** Can this box answer the question at all? */
        val appStatusKnown: Boolean
            get() = appPendingReported != null || (behind ?: 0) > 0 || release?.available != null
        val systemPending: Boolean get() = !systemUpdates.isNullOrBlank()
    }

    /**
     * @property available the version waiting, or null for none — which is also
     *   what a box that could not reach GitHub reports. [message] is the only
     *   thing that knows the difference, which is why it travels.
     * @property configured whether this box knows where to look at all. False
     *   is the state of every box installed before the installer wrote the
     *   manifest URL, and cannot be told apart from "nothing waiting" by the
     *   version alone.
     */
    data class Release(
        val available: String?,
        val configured: Boolean,
        val message: String?,
    )

    /**
     * @property summary the host's own sentence, shown verbatim. It is written
     *   for a person rather than for a terminal, and it is the only place that
     *   knows which of the three states it is describing.
     */
    /**
     * How much of an account's limit is used, on the Claude row of a person's
     * connections: the four windows Claude Code's own /usage draws, or the
     * host's reason there is no answer. On the ACCOUNT's row and not on each
     * host, because an account is a person's — the same address linked on
     * three boxes is one plan with one window, and the coordinator keeps the
     * freshest box's answer. Null on the row is CANNOT TELL and is drawn as
     * nothing.
     */
    data class UsageReport(val checkedAt: Long?, val windows: Windows?, val why: String?) {
        data class Windows(val fiveHour: Window?, val sevenDay: Window?, val sevenDayOpus: Window?, val sevenDaySonnet: Window?)

        /**
         * @property used percent of the window used, 0-100, as the endpoint gave it
         * @property resetsAt when it resets, epoch millis; the phone does the arithmetic
         */
        data class Window(val used: Double?, val resetsAt: Long?)

        /**
         * Worth colouring: a window that is nearly spent. Ninety percent,
         * because the next session start is what a person is deciding on.
         */
        val isNearLimit: Boolean get() =
            listOf(windows?.fiveHour, windows?.sevenDay, windows?.sevenDayOpus, windows?.sevenDaySonnet).any { (it?.used ?: 0.0) >= 90.0 }
    }

    data class Credential(
        val state: String?,
        val expiresAt: Long?,
        val refreshable: Boolean?,
        val account: String?,
        val summary: String?,
    ) {
        /**
         * Worth interrupting somebody over. Deliberately narrow: an expired
         * token that can renew itself is the ordinary state of a box nobody
         * has touched for an hour.
         */
        val isDead: Boolean get() = state == "expired" && refreshable == false
    }

    /** Mirrors `waiting` in the host's `/updates` reply. */
    data class Waiting(
        val appKind: String? = null,
        val appPending: Boolean? = null,
        val appAvailable: String? = null,
        val appConfigured: Boolean? = null,
        val appBehind: Int? = null,
        val appText: String? = null,
        val systemPending: Boolean = false,
        val systemText: String? = null,
        /** What the box allows from the app, beside what is waiting; null when the host did not say. */
        val grantUpgrades: Boolean? = null,
        val grantReboot: Boolean? = null,
    )

    data class Reply(
        val ok: Boolean,
        /**
         * WHAT THE HOST SAID, WHICH MAY BE NOTHING BUT WHITESPACE.
         *
         * `tmux capture-pane` returns every row of the visible region, so a
         * session that has printed nothing answers Output with forty newlines
         * rather than with the empty string. Screens here have always gated
         * their cards on `isNotBlank()`, so this app drew nothing rather than
         * drawing an empty card the height of the screen — which is better and
         * still not right: a button that reports nothing when it is pressed is
         * a button somebody presses again.
         *
         * Read it through [said], which takes the padding off and offers a
         * sentence for the case where there was never anything else.
         */
        val text: String,
        val sessions: List<Session>,
        /**
         * What could be connected and what is, when the reply is about
         * credentials. Never a token — the host does not send one and there is
         * no field here that could hold one.
         */
        val connections: Connections? = null,
        /** What a stored token can do, when it was just asked. Never the token. */
        val check: Check? = null,
        /** The sign-in page a machine started `claude setup-token` on. */
        val url: String? = null,
        /** The token that machine made, sealed to a key only this phone holds. Ciphertext the coordinator cannot read. */
        val sealed: JSONObject? = null,
        /**
         * A directory listing, as DATA. The rendered text is for a person;
         * parsing it back out of the prose is how an app breaks the first time
         * the wording changes — the same argument that put the authorization
         * URL in a field rather than in a message.
         */
        val entries: List<Entry> = emptyList(),
        /**
         * What a session could be started ON, as DATA and with the host each
         * one lives on. Same reasoning as [entries]: a picker built by parsing
         * the rendered text would be a picker built from column padding.
         *
         * NULL IS NOT EMPTY. Null means nobody answered the question — a
         * coordinator or a host too old to know the verb — and empty means this
         * fleet genuinely has no profiles. A picker has to tell those apart or
         * it offers "nothing yet" as if it were the fleet's answer.
         */
        val profiles: List<Profile>? = null,
        /**
         * The named secrets a session could be GRANTED, by name only, with the
         * host each one lives on. Same NULL-IS-NOT-EMPTY rule as [profiles]:
         * null is nobody-answered (a host too old to know the verb), empty is
         * this fleet holds none. The value is never here.
         */
        val secrets: List<Secret>? = null,
        /**
         * Which releases this box takes, when the reply is about that.
         *
         * IT TRAVELS SO THE APP DOES NOT HAVE TO WAIT. The fleet list is
         * rebuilt from the coordinator's cache, which is a health frame old —
         * so a picker that only trusted the list showed the value somebody had
         * just changed away from. This is the box's own answer about itself,
         * and the most recent thing anybody has.
         */
        val channel: String? = null,
        val channelPinned: Boolean = false,
        /**
         * Which image new sessions run in, after this reply, for the same
         * reason the channel travels: the list is rebuilt from a cache that is
         * a health frame old, so a control trusting only the list shows the
         * value somebody just changed away from.
         */
        val sandboxVariant: String? = null,
        val sandboxImage: String? = null,
        val sandboxPinned: Boolean = false,
        /**
         * The labels SET from an app, after this reply. Not the whole list: a
         * label the machine derives is not this verb's to report, and merging
         * the two here would let a reply put `arm64` into the removable set.
         */
        val setLabels: List<String>? = null,
        /**
         * What a check found, as DATA. The host computes `{ app, system }`
         * precisely so a row can render a state instead of parsing a sentence,
         * and this reply carried none of it — so Check printed "main-57 →
         * main-63 (available)" into a text box while the row beside it went on
         * showing a fifteen-minute-old cache that said "up to date", with no
         * Apply button, because the button reads the row.
         */
        val waiting: Waiting? = null,
        /**
         * Which machine answered, when the coordinator says. `xosetup` names
         * it on every phase, so the screen can say where the setup is running
         * even after the app was closed and reopened on the job alone.
         */
        val hostId: String? = null,
        /**
         * What every permanent machine found at a Xen Orchestra address, one
         * entry each. NULL IS NOT EMPTY: null is a reply that was not about
         * probing (or a coordinator too old for the verb), empty is a fleet
         * with no permanent machine to ask.
         */
        val probes: List<Probe>? = null,
        /** Where a hypervisor setup has got to, when the reply is about one. */
        val xosetup: Setup? = null,
        /**
         * The coordinator's `error.code` on a refusal, or null. A code, not a
         * sentence, because a screen that decides from the text decides from
         * whatever the wording is this week: `unknown_job` is what tells the
         * setup poll to stop asking.
         */
        val code: String? = null,
    )

    /**
     * One machine's answer to `xoprobe`. `xo` is three-valued on purpose:
     * null is "answered, and it could not tell what by", which is not "not
     * Xen Orchestra". `cert` is the SHA-256 of the certificate that answered,
     * lowercase hex, and null when nothing did or nothing was TLS.
     * `certificate` is what that certificate says about itself and whether
     * the machine trusts it (core.js `narrowCertificate`); null is "could not
     * read it", which is shown as exactly that and never as "fine".
     */
    data class Probe(
        val hostId: String,
        val reachable: Boolean,
        val xo: Boolean?,
        val tls: Boolean,
        val cert: String?,
        val version: String?,
        val certificate: Certificate? = null,
        /**
         * What the machine found over SSH at the address, said when Xen
         * Orchestra did not answer there: what a pool with no Xen Orchestra is
         * added from. NULL IS A MACHINE THAT DID NOT SAY, too old to look or
         * one that found Xen Orchestra: never one that found nothing
         * (`narrowSsh` in src/fleet/coordinator/core.js).
         */
        val ssh: SshProbe? = null,
    )

    /**
     * `narrowSsh` is the shape. [reachable] and [deploy] keep null as cannot
     * tell: a machine without ssh-keyscan has not found the address
     * unreachable. [missing] is what it lacks to install with, by name.
     */
    data class SshProbe(val reachable: Boolean?, val keys: List<SshKey>, val deploy: Boolean?, val missing: List<String>)

    /**
     * One host key, as OpenSSH names its type and prints its fingerprint, and
     * the same digest in hex ([sha256]), which is the pin an install is begun with.
     */
    data class SshKey(val type: String, val fingerprint: String, val sha256: String)

    /**
     * A certificate as a probe describes it. `trusted` is true only when the
     * machine said so and named no problem; `problems` is a subset of
     * XoSetup.CERT_PROBLEMS, in the machine's order; the dates are ISO 8601;
     * every text field is null when the machine did not say.
     */
    data class Certificate(
        val trusted: Boolean,
        val problems: List<String>,
        val subject: String?,
        val issuer: String?,
        val notBefore: String?,
        val notAfter: String?,
        val names: List<String>,
    )

    /**
     * An `xosetup` answer. After `begin`: the job, the key the machine made
     * for it, the machine's signature over that key and the enrolment key
     * that made the signature (XoSetup.verifyKeySig). After anything else:
     * the step the machine is on, out of how many, by its key, and the
     * sentence the machine wrote about it.
     */
    /**
     * How far a build has got: stage of stages, and thousandths of the whole.
     * [build] is what it is a build of (`edge`, `image` or `holder`), null
     * from a machine before it said.
     */
    data class BuildPart(val stage: Int, val stages: Int, val fill: Int, val build: String? = null)

    data class Setup(
        val job: String,
        /** waiting, running, done, failed or cancelled. */
        val state: String,
        val step: Int?,
        val of: Int?,
        val phase: String?,
        val text: String?,
        val key: String?,
        val keySig: String?,
        val hostKey: JSONObject?,
        val fingerprint: String?,
        /**
         * Once done: the limited user's token, sealed by the machine to the
         * key this phone sent inside the sign-in, as epk.iv.ct. The machine
         * keeps no copy (XoHandoff).
         */
        val handoff: String? = null,
        /**
         * What else a job on this machine can be, from `begin`: "policy" on a
         * machine that can change what the fleet may use on a pool. EMPTY IS
         * A MACHINE OLDER THAN THAT, and the phone sends it no policy sign-in
         * at all rather than one it would run as a setup.
         */
        val can: List<String> = emptyList(),
        /**
         * A policy job waiting on the person (`choosing`): the pool's storage,
         * networks and capacity, sealed by the machine to the key this phone
         * sent inside the sign-in, as epk.iv.ct (XoPolicy.openInventory).
         */
        val inventory: String? = null,
        /**
         * While a step that can say how far it has got is running (the edge
         * router's build): which stage of how many, and how far through the
         * whole build in thousandths. Null from an older machine.
         */
        val part: BuildPart? = null
    )

    /**
     * A task profile: a file on ONE host whose content becomes a new session's
     * first message.
     *
     * THE CONTENT IS NOT HERE AND NEVER WILL BE. The protocol carries a name;
     * the words live on the box and get there by somebody with a shell on it. A
     * phone that could supply them would be writing the instructions of an
     * agent running as root in a container — see docs/task-at-start.md.
     *
     * @property hostId which machine has it. Load-bearing rather than
     *   decorative: `start` on a host that does not have this profile is
     *   refused, so a picker that lost the attribution sends people at the
     *   wrong box.
     */
    data class Profile(
        val name: String,
        val summary: String = "",
        val chars: Int = 0,
        val hostId: String? = null,
    )

    /**
     * A named secret a session can be GRANTED at start. The NAME only: the value
     * stays on the host and reaches the session over the credential broker,
     * never through this app — see docs/trust.md. A phone that carried the value
     * would be the durable credential this design exists to withhold.
     *
     * @property hostId which machine holds it. Load-bearing like a profile's:
     *   `start --secret` on a host without it is refused, so a picker that lost
     *   the attribution aims at the wrong box.
     */
    data class Secret(
        val name: String,
        val hostId: String? = null,
    )

    /** One thing in a session's workspace. */
    data class Entry(
        val name: String,
        /**
         * "dir", "file" or "link". A string rather than an enum because the
         * host decides what kinds exist, and an app that crashed on an unknown
         * one could not be extended without a release.
         */
        val kind: String,
        val size: Long,
    ) {
        val isDirectory: Boolean get() = kind == "dir"
    }

    /**
     * @property granted scope names it HAS. Null where the provider will not
     *   say — a different fact from an empty list, and rendering it as "none"
     *   would be a lie about Cloudflare in particular.
     * @property missing asked for and not granted. Null means "cannot tell".
     */
    data class Check(
        val ok: Boolean,
        val account: String?,
        val granted: List<String>?,
        val missing: List<String>?,
        val message: String?,
        /** The machine that checked, when the coordinator asked every box and answered from one that holds the token. */
        val hostId: String? = null,
    )

    /**
     * The connector picker, rendered from what the HOST publishes.
     *
     * Deliberately not a hardcoded list of providers in the app. A provider
     * added to the host's table appears here on the next refresh, with its real
     * URL and its real scopes, without a Play release — which is the entire
     * reason the verbs are connect/link/unlink and not github/cloudflare.
     */
    data class Connections(
        val catalogue: List<Available> = emptyList(),
        val connected: List<Linked> = emptyList(),
    ) {
        data class Available(
            val provider: String,
            val label: String,
            /**
             * The provider's OWN token page with the scopes pre-ticked — or,
             * for Claude, the authorization URL this box just minted.
             *
             * Null for Claude until a flow has actually been started: there is
             * no static page to send anybody to, and null is the honest answer
             * rather than a missing field.
             */
            val url: String?,
            val hint: String,
            val env: List<String>,
            /**
             * What this asks for, when the provider will say what a token was
             * granted. Empty for Cloudflare, which will not.
             */
            val wants: List<String> = emptyList(),
            /**
             * `"app"` when the coordinator has rewritten this to a provider app
             * authorization. Absent means the paste route, which is the normal
             * case and not a lesser one.
             */
            val flow: String? = null,
        ) {
            /** Nothing to copy, so nothing to paste. The point of the App. */
            val isAppFlow: Boolean get() = flow == "app"
            /**
             * Claude is a sign-in; the rest are tokens to paste. Which one
             * decides the shape of the row, so it is asked once rather than at
             * four places in the UI.
             */
            val isSignIn: Boolean get() = provider == "claude"
        }

        /**
         * @property missing permissions this token does NOT have that are now
         *   asked for. Three states, and they are genuinely three: a list means
         *   "short by these", empty means "checked, nothing missing", and NULL
         *   means we cannot tell — an older record, or a provider that will not
         *   say. Rendering null as "fine" is how somebody finds out four hours
         *   into a session instead.
         */
        data class Linked(
            val provider: String,
            val label: String?,
            val account: String?,
            val updatedAt: Long,
            val missing: List<String>? = null,
            /**
             * This token can no longer renew itself.
             *
             * It still WORKS, which is what makes it worth saying early: an
             * eight-hour token that cannot renew stops within the day, and the
             * failure without this is "it worked yesterday" with nothing on any
             * screen explaining it. Set when the box swept renewal material it
             * could not use, and cleared the moment a fresh token is stored.
             */
            val needsReconnect: Boolean = false,
            /** What this account has left, on the Claude row. Null from a host that has not said. */
            val usage: UsageReport? = null,
        )

        fun linked(provider: String): Linked? = connected.firstOrNull { it.provider == provider }
    }

    suspend fun list(): Reply = intent("list")

    /**
     * Start a session.
     *
     * Everything past `name` is optional and stays optional: a spoken start
     * cannot open a text field, so there has to be a good outcome when none of
     * it is supplied.
     *
     * `title` and `brief` are prose and travel as intent PARAMETERS. On the far
     * side the sidecar keeps them out of the command line for the same reason a
     * title reading "refactor auth --dangerous" must never arrive as a flag.
     *
     * No `host`: the coordinator's dispatch() has no placement preference to
     * hand one to, so it would be accepted, ignored, and look like it worked.
     */
    suspend fun start(
        name: String? = null,
        title: String? = null,
        brief: String? = null,
        mode: String? = null,
        host: String? = null,
        profile: String? = null,
        secret: String? = null,
        task: String? = null,
    ): Reply = intent(
        "start",
        buildMap {
            if (!name.isNullOrBlank()) put("name", name)
            if (!title.isNullOrBlank()) put("title", title)
            if (!brief.isNullOrBlank()) put("brief", brief)
            if (!mode.isNullOrBlank()) put("mode", mode)
            // WHAT THE SESSION WILL BE DOING, by name. Without it the session
            // comes up idle at an empty prompt — which is what every session
            // did before protocol v3, and what nothing said out loud.
            //
            // A NAME, never the words: the file is on the host. An unknown one
            // is refused by that host, listing what it does have, so a stale
            // picker fails with something a person can act on.
            if (!profile.isNullOrBlank()) put("profile", profile)
            // OR THE WORDS THEMSELVES (protocol v7): what to do, as the
            // session's first message, sent as typed. A host too old to take
            // one is refused by the coordinator rather than started idle.
            if (!task.isNullOrBlank()) put("task", task)
            // WHAT THE SESSION MAY REACH, by name. A NAME, never the value: the
            // host resolves it and the session fetches the value at runtime over
            // the broker, so nothing here carries a credential. An unknown name
            // is refused by the host, like a profile. See docs/trust.md.
            if (!secret.isNullOrBlank()) put("secret", secret)
        },
        // A placement PREFERENCE, beside the intent and never inside it —
        // `start` declares no host parameter, and a host receiving one would
        // refuse the whole intent. The coordinator refuses a bad pick by name.
        host = host,
    )

    suspend fun stop(name: String): Reply = intent("stop", mapOf("name" to name))

    /**
     * Ask for a temporary machine — macOS, Windows, Linux or an Android emulator.
     *
     * It does NOT return a host. GitHub has to find hardware, boot it and
     * install what a session needs, so the runner appears in the fleet minutes
     * later as a temporary host owned by whoever asked. Anything it runs is
     * lost when it goes.
     *
     * `host` is which permanent box dispatches it, and matters only in a fleet
     * with several: the dispatch is made with that person's GitHub connection
     * on that machine, so the coordinator refuses rather than guessing when
     * more than one could. See docs/runner-central.md.
     */
    /**
     * Ask for a temporary machine, and optionally a session to start on it.
     *
     * `start` is the session the New session sheet described — title, brief
     * and mode — held by the coordinator with the dispatch and started on the
     * runner when it joins. It travels BESIDE the params, as `host` does: the
     * box that dispatches the run never sees it.
     */
    suspend fun provision(
        platform: String,
        minutes: Int? = null,
        host: String? = null,
        start: Map<String, String>? = null,
        template: String? = null,
        network: String? = null,
        group: String? = null,
    ): Reply {
        // FROM THIS PHONE WHEN IT CAN, with no permanent box: signed in to
        // GitHub here, it makes the dispatch itself (PhoneGitHub.startRunner).
        // Otherwise a box with your GitHub connection does, as it always did.
        // A MACHINE FROM YOUR HYPERVISOR is never GitHub's: a box holding the
        // pool's token makes it (protocol 8, `template`).
        val phone = PhoneGitHub(settings)
        // NOR IS A LAB, which is a machine from your hypervisor in a lab.
        if (platform != "vm" && platform != "lab" && phone.signedIn) {
            return runCatching { phone.startRunner(this, platform, minutes, start) }
                .getOrElse { Reply(false, it.message ?: "that did not work", emptyList()) }
        }
        return intent(
            "provision",
            (if (template == null) mapOf("platform" to platform) else mapOf("platform" to platform, "template" to template)) +
                // A NETWORK OF YOUR POOL instead of behind the edge router (protocol 9).
                (if (network == null) emptyMap() else mapOf("network" to network)) +
                // AND A GROUP NETWORK beside it, to reach the others in that group (protocol 10).
                (if (group == null) emptyMap() else mapOf("group" to group)),
            host,
            numeric = if (minutes == null) emptyMap() else mapOf("minutes" to minutes),
            extra = if (start == null) emptyMap() else mapOf("start" to JSONObject(start.toMap())),
        )
    }

    /** Where to start a runner from this phone, and the ticket to start it with. */
    suspend fun prepareRunnerDispatch(platform: String, minutes: Int?, start: Map<String, String>?): JSONObject =
        withContext(Dispatchers.IO) {
            val body = JSONObject().put("platform", platform)
            if (minutes != null) body.put("minutes", minutes)
            if (start != null) body.put("start", JSONObject(start.toMap()))
            post("/api/runners/dispatch", body)
        }

    /** What this phone needs to open GitHub's sign-in page itself: the client id and the callback. */
    suspend fun githubDeviceStart(): JSONObject = withContext(Dispatchers.IO) { get("/api/github/device") }

    /** A sign-in or renewal sealed to the minter, relayed; the answer comes back sealed to this phone. */
    suspend fun githubDeviceToken(sealed: JSONObject): JSONObject =
        withContext(Dispatchers.IO) { post("/api/github/device", JSONObject().put("sealed", sealed)) }

    /** What this phone needs to open Cloudflare's sign-in page itself, for the person's vault. */
    suspend fun cloudflareDeviceStart(): JSONObject = withContext(Dispatchers.IO) { get("/api/cloudflare/device") }

    /** A request to the person's vault, sealed to the minter; the answer comes back sealed to this phone. */
    suspend fun vault(sealed: JSONObject): JSONObject =
        withContext(Dispatchers.IO) { post("/api/vault", JSONObject().put("sealed", sealed)) }

    /** The key the fleet says its minter has, to compare with the pin. */
    suspend fun claudeLoginKey(): JSONObject = withContext(Dispatchers.IO) { get("/api/claude-login") }

    /**
     * The minter's key from the minter itself, at the fleet's address. The
     * deploy routes this one path past the coordinator (worker/src/minter.js,
     * KEY_PATH), so it is a key to seal to that the coordinator did not
     * choose, and nobody has to paste a pin. Null when nothing there answers
     * with one: a fleet whose minter was given no route.
     */
    suspend fun minterOwnKey(): String? = withContext(Dispatchers.IO) {
        runCatching { send("GET", "/.well-known/fleetwright-minter", null, authenticated = false) }.getOrNull()
            ?.takeIf { it.optBoolean("ok") }
            ?.optString("key")
            ?.takeIf { Seal.KEY_RE.matches(it) }
    }

    /** A Claude login sealed to the minter, for your own runners. */
    suspend fun depositClaudeLogin(sealed: JSONObject): JSONObject =
        withContext(Dispatchers.IO) { send("PUT", "/api/claude-login", JSONObject().put("sealed", sealed)) }

    /**
     * What a runner repository check found, as data — so a screen shows each
     * answer rather than parsing the sentence. NULL IS "CANNOT TELL", not
     * "no": a personal GitHub token cannot see whether the Fleetwright app is
     * installed, and saying "not installed" would send somebody to reinstall
     * something that was never the problem.
     */
    data class RunnerRepoCheck(
        val repo: String,
        val isPublic: Boolean?,
        val installed: Boolean?,
        val actionsWrite: Boolean?,
        val platforms: List<String>,
        val missing: List<String>,
        val ok: Boolean,
        val message: String,
    )

    /** Your own runner repository, the fleet's beside it, and — after a set —
     * what the check found. `repo` null is an answer: you have not set one. */
    data class RunnerRepoSetting(
        val ok: Boolean?,
        val repo: String?,
        val fleet: String?,
        val text: String?,
        val runnerRepo: RunnerRepoCheck?,
    )

    suspend fun runnerRepoSetting(): Result<RunnerRepoSetting> = withContext(Dispatchers.IO) {
        runCatching { parseRunnerRepoSetting(get("/api/runner-repo")) }
    }

    /** Saved only if a permanent box's check with YOUR GitHub connection
     * passes. The check comes back either way, so a refusal can say which
     * answer stopped it. */
    suspend fun setRunnerRepo(repo: String): Result<RunnerRepoSetting> = withContext(Dispatchers.IO) {
        runCatching { parseRunnerRepoSetting(send("PUT", "/api/runner-repo", JSONObject().put("repo", repo))) }
    }

    suspend fun clearRunnerRepo(): Result<RunnerRepoSetting> = withContext(Dispatchers.IO) {
        runCatching { parseRunnerRepoSetting(send("DELETE", "/api/runner-repo", null)) }
    }

    /**
     * What a linked-repository check found, for one role (#346). The same
     * "null is cannot tell" as the runner check: asked as the GitHub App, the
     * fleet cannot see whether YOU can push, and says so with a null.
     */
    data class LinkedRepoCheck(
        val role: String,
        val repo: String,
        val isPublic: Boolean?,
        val installed: Boolean?,
        /** "write", "read" or "none": what this connection can do with its files. */
        val contents: String?,
        val push: Boolean?,
        /** For templates: which of .claude, .github and default.json it carries. */
        val carries: List<String>?,
        val ok: Boolean,
        val message: String,
        /** For runners: the whole runner check, drawn the way Temporary machines draws it. */
        val runnerRepo: RunnerRepoCheck?,
    )

    /** Every role this person has linked, by role, and the fleet's runner
     * repository beside them: what they get for runners with none of their own. */
    data class LinkedRepos(val ok: Boolean?, val links: Map<String, String>, val fleetRunners: String?)

    /** The answer to linking or unlinking one role. */
    data class LinkedRepoReply(val ok: Boolean?, val role: String?, val repo: String?, val text: String?, val linkedRepo: LinkedRepoCheck?)

    suspend fun linkedRepos(): Result<LinkedRepos> = withContext(Dispatchers.IO) {
        runCatching {
            val json = get("/api/linked-repos")
            val links = mutableMapOf<String, String>()
            json.optJSONArray("links")?.let { a ->
                for (i in 0 until a.length()) {
                    val l = a.optJSONObject(i) ?: continue
                    val role = l.optString("role")
                    val repo = l.optString("repo")
                    if (role.isNotBlank() && repo.isNotBlank()) links[role] = repo
                }
            }
            LinkedRepos(
                ok = if (json.has("ok") && !json.isNull("ok")) json.optBoolean("ok") else null,
                links = links,
                fleetRunners = json.optJSONObject("fleet")?.optString("runners")?.takeIf { it.isNotBlank() && it != "null" },
            )
        }
    }

    /** Linked only if the role's check passes; the check comes back either
     * way, so a refusal says which answer stopped it. */
    suspend fun linkRepo(role: String, repo: String): Result<LinkedRepoReply> = withContext(Dispatchers.IO) {
        runCatching { parseLinkedRepoReply(send("PUT", "/api/linked-repos/$role", JSONObject().put("repo", repo))) }
    }

    suspend fun unlinkRepo(role: String): Result<LinkedRepoReply> = withContext(Dispatchers.IO) {
        runCatching { parseLinkedRepoReply(send("DELETE", "/api/linked-repos/$role", null)) }
    }

    private fun parseLinkedRepoReply(json: JSONObject): LinkedRepoReply {
        fun maybe(o: JSONObject, key: String): Boolean? =
            if (o.has(key) && !o.isNull(key)) o.optBoolean(key) else null
        fun text(o: JSONObject, key: String): String? = o.optString(key).takeIf { it.isNotBlank() && it != "null" }
        val check = json.optJSONObject("linkedRepo")?.let { c ->
            LinkedRepoCheck(
                role = c.optString("role"),
                repo = c.optString("repo"),
                isPublic = maybe(c, "public"),
                installed = maybe(c, "installed"),
                contents = text(c, "contents"),
                push = maybe(c, "push"),
                carries = c.optJSONArray("carries")?.let { a -> (0 until a.length()).mapNotNull { i -> a.optString(i).takeIf { it.isNotBlank() } } },
                ok = c.optBoolean("ok", false),
                message = c.optString("message"),
                // The runner check inside it, read the way the runner setting reads it.
                runnerRepo = c.optJSONObject("runnerRepo")?.let { parseRunnerRepoSetting(JSONObject().put("runnerRepo", it)).runnerRepo },
            )
        }
        return LinkedRepoReply(ok = maybe(json, "ok"), role = text(json, "role"), repo = text(json, "repo"), text = text(json, "text"), linkedRepo = check)
    }

    /**
     * What every host in the fleet can start a session on.
     *
     * Fans out, because a profile is a file on one box: asking a single machine
     * answers with whatever that machine happens to have and hides the one
     * somebody is looking for.
     *
     * Returns null when nobody answered the question — an old coordinator, or
     * hosts that refuse the verb by name. That is a different thing from a
     * fleet with no profiles, and the caller shows no picker rather than an
     * empty one.
     */
    suspend fun profiles(): List<Profile>? = runCatching { intent("profiles", emptyMap()).profiles }.getOrNull()

    /**
     * The named secrets the fleet holds, by name only. Null when nobody
     * answered — an old coordinator or a host that refuses the verb — which the
     * caller treats as "no picker" rather than "no secrets". The value is never
     * among the answer; it stays on the host behind the broker.
     */
    suspend fun secrets(): List<Secret>? = runCatching { intent("secrets", emptyMap()).secrets }.getOrNull()

    /** One session in detail, or the fleet when no name is given. */
    suspend fun status(name: String? = null): Reply =
        intent("status", buildMap { if (!name.isNullOrBlank()) put("name", name) })

    /**
     * Answer a waiting prompt by selecting an option the HOST published.
     *
     * An ordinal, never text: send-keys into a pane reaches a root shell.
     * `promptId` is what the host checks against the live pane, so a
     * notification tapped four minutes late cannot answer a different question.
     */
    suspend fun answer(name: String, option: Int, promptId: String? = null): Reply =
        intent(
            "answer",
            buildMap {
                put("name", name)
                if (!promptId.isNullOrBlank()) put("promptId", promptId)
            },
            numeric = mapOf("option" to option),
        )

    /** A service journal, or what a session printed. */
    suspend fun logs(host: String? = null, session: String? = null, service: String? = null, lines: Int? = null): Reply =
        intent(
            "logs",
            buildMap {
                if (!session.isNullOrBlank()) put("name", session)
                if (!service.isNullOrBlank()) put("service", service)
            },
            host = host,
            numeric = buildMap { if (lines != null) put("lines", lines) },
        )

    /** Pull code on one box. Restarting is opt-in. */
    suspend fun update(host: String, restart: Boolean = false): Reply =
        intent("update", if (restart) mapOf("restart" to "yes") else emptyMap(), host = host)

    /**
     * What is waiting for a box — both this software and the operating system.
     *
     * ONE ROUND TRIP AND ONE ANSWER. Asking `update` and `upgrade` separately
     * is what produced a screen saying "The box is up to date." directly above
     * "1 commit behind": two true sentences about different subjects with
     * nothing saying which was which. It also forces the app-side check, which
     * otherwise reports from a cache refreshed every fifteen minutes.
     */
    suspend fun updates(host: String): Reply = intent("updates", emptyMap(), host = host)

    /**
     * Which releases a box installs — and, with [to], change it.
     *
     * Bare is a question. The verb exists because the channel used to be a line
     * in `/etc/fleetwright.env`, which meant a shell on the box — the one thing
     * somebody holding only a phone does not have.
     */
    suspend fun channel(host: String, to: String? = null): Reply =
        intent("channel", buildMap { if (!to.isNullOrBlank()) put("to", to) }, host = host)

    /**
     * Which image new sessions on a box run in — and, with [to], change it.
     *
     * [channel]'s sibling, and bare is a question for the same reason. The
     * browser variant shipped as a second tag and choosing it meant editing
     * FLEETWRIGHT_SANDBOX_IMAGE in a root-owned file and restarting the service.
     */
    suspend fun sandbox(host: String, to: String? = null): Reply =
        intent("sandbox", buildMap { if (!to.isNullOrBlank()) put("to", to) }, host = host)

    /**
     * The labels a box carries, and with [add] or [remove], change them.
     *
     * ONE AT A TIME AND NEVER A LIST, which is the verb's shape rather than a
     * simplification here: a call that replaced the whole list would make two
     * people editing labels from two phones a last-write-wins race over a value
     * neither of them read.
     *
     * A label the machine derives about itself is refused by the host, with the
     * reason. The screen does not offer it, but the refusal is what makes that
     * true rather than a convention this app happens to follow.
     */
    suspend fun labels(host: String, add: String? = null, remove: String? = null): Reply =
        intent(
            "labels",
            buildMap {
                if (!add.isNullOrBlank()) put("add", add)
                if (!remove.isNullOrBlank()) put("remove", remove)
            },
            host = host,
        )

    /** What the OS has waiting, and optionally install it. */
    suspend fun upgrade(host: String, apply: Boolean = false): Reply =
        intent("upgrade", if (apply) mapOf("apply" to "yes") else emptyMap(), host = host)

    /**
     * Reboot a box. Two steps: bare asks for a pin and names what will die;
     * pin plus hostname does it.
     */
    suspend fun reboot(host: String, pin: String? = null, confirm: String? = null): Reply =
        intent(
            "reboot",
            buildMap {
                if (!pin.isNullOrBlank()) put("pin", pin)
                if (!confirm.isNullOrBlank()) put("confirm", confirm)
            },
            host = host,
        )

    /**
     * The last lines of a session's pane — what it is actually doing.
     *
     * The verb that makes this more than a list of names. Everything else says
     * a session exists; this says whether it is stuck.
     */
    suspend fun peek(name: String): Reply = intent("peek", mapOf("name" to name))

    // --- the workspace -------------------------------------------------------
    //
    // Five calls rather than one taking an operation, matching the five verbs.
    // Every one names a session, because a workspace belongs to one; and every
    // one carries the host explicitly, because a session lives on ONE box and a
    // browse that fanned out would read a directory that exists on two machines
    // with different contents in it.

    /** List one directory. Paths are relative to the workspace root. */
    suspend fun files(name: String, path: String = "", host: String? = null): Reply =
        intent("files", buildMap { put("name", name); if (path.isNotBlank()) put("path", path) }, host = host)

    /**
     * Read a text file. The host refuses binary and anything over 256KB and
     * says which, so the app shows its reason rather than an empty screen.
     */
    suspend fun readFile(name: String, path: String, host: String? = null): Reply =
        intent("readfile", mapOf("name" to name, "path" to path), host = host)

    /** Write a file, creating it and any missing directories. */
    suspend fun writeFile(name: String, path: String, content: String, host: String? = null): Reply =
        intent("writefile", mapOf("name" to name, "path" to path, "content" to content), host = host)

    /** Copy within the workspace. Both ends are confined by the host. */
    suspend fun copyFile(name: String, path: String, to: String, host: String? = null): Reply =
        intent("copyfile", mapOf("name" to name, "path" to path, "to" to to), host = host)

    /**
     * Delete. NOT recoverable — [forget] is the recoverable one and takes the
     * whole workspace, which is why the UI asks before calling this.
     */
    suspend fun deleteFile(name: String, path: String, host: String? = null): Reply =
        intent("deletefile", mapOf("name" to name, "path" to path), host = host)

    /** Forget a session and delete its volumes. Not undoable — the UI asks first. */
    /** Stop a session and put it in the bin. Recoverable — see [restore]. */
    suspend fun forget(name: String): Reply = intent("forget", mapOf("name" to name))

    /**
     * Take a forgotten session back out of the bin.
     *
     * The volumes were never deleted, so this is a record move: the
     * conversation and the workspace come back exactly as they were. Pinned to
     * the box still holding them, which the coordinator resolves.
     */
    suspend fun restore(name: String): Reply = intent("restore", mapOf("name" to name))

    /** Delete for good. What [forget] used to do, kept as its own word. */
    suspend fun purge(name: String): Reply = intent("purge", mapOf("name" to name))

    /**
     * Ask the coordinator to send this device a notification now.
     *
     * Push fails silently by nature: a registration that never arrived and a
     * provider that was never configured look identical from a phone, which is
     * to say they look like nothing at all. This is the only way to find out
     * before the notification that matters.
     */
    suspend fun testPush(token: String?): Reply = withContext(Dispatchers.IO) {
        val body = JSONObject().apply { if (token != null) put("token", token) }
        runCatching {
            val json = post("/api/devices/test", body)
            Reply(ok = json.optBoolean("ok", false), text = json.optString("text"), sessions = emptyList())
        }.getOrElse { Reply(ok = false, text = it.message ?: "could not reach the coordinator", sessions = emptyList()) }
    }

    /**
     * What can be connected on this box, and what already is.
     *
     * One round trip: the catalogue and the current state arrive together, so
     * a picker never renders its provider list from one answer and its status
     * from another.
     */
    suspend fun connections(host: String? = null): Reply = intent("connect", emptyMap(), host = host)

    /**
     * Begin connecting a credential. Returns a URL to open — never a secret.
     *
     * `scope` is left off for a person's own credential, which needs no
     * permission: the HOST derives whose account it is from the verified
     * identity on the request, and there is no parameter that could name
     * somebody else. "host" logs THE BOX in and is admin-only.
     */
    suspend fun connect(host: String, provider: String, scope: String? = null): Reply =
        intent("connect", buildMap { put("provider", provider); if (scope != null) put("scope", scope) }, host = host)

    /**
     * Hand back the token or the authorization code.
     *
     * Goes to the SAME host `connect` was asked of, which the caller carries.
     * Claude's flow is a login waiting in a pane on that box; a code typed into
     * a different one would be a live credential landing where nothing asked
     * for it.
     */
    suspend fun link(host: String, provider: String, secret: String, scope: String? = null): Reply =
        intent(
            "link",
            buildMap { put("provider", provider); put("secret", secret); if (scope != null) put("scope", scope) },
            host = host,
        )

    /**
     * Store a token on EVERY box, because it is the person's and not any one
     * machine's. No host is named, so the coordinator fans it out.
     */
    suspend fun linkEverywhere(provider: String, secret: String): Reply =
        intent("link", mapOf("provider" to provider, "secret" to secret))

    /** Forget a token everywhere it was stored. */
    suspend fun unlinkEverywhere(provider: String): Reply = intent("unlink", mapOf("provider" to provider))

    /**
     * Ask the provider what a STORED credential can actually do.
     *
     * Different from checking at link time, which checks a value somebody just
     * pasted. A token can be revoked, expire, or have its permissions narrowed
     * at the provider long afterwards, and nothing here would know until a
     * session failed.
     */
    suspend fun verify(host: String? = null, provider: String): Reply =
        intent("verify", mapOf("provider" to provider), host = host)

    /**
     * Make a Claude token for your runners on one machine, which runs `claude
     * setup-token` in a pane there. With no code the reply carries the sign-in
     * page in `url`; with the code that page showed and [reply], it carries the
     * token sealed to [reply] in `sealed`.
     *
     * NEVER HELD. The outbox keeps what it holds on disk and replays it, and a
     * code is a live credential for the minutes it lasts. Passing an id is what
     * keeps a send that could not reach the fleet out of the outbox.
     */
    suspend fun setupToken(host: String, code: String? = null, reply: String? = null): Reply =
        intent(
            "setuptoken",
            buildMap { if (code != null) put("code", code); if (reply != null) put("reply", reply) },
            host = host,
            idempotencyKey = "app-" + java.util.UUID.randomUUID().toString(),
        )

    /**
     * Ask every permanent machine whether it can reach a Xen Orchestra
     * address, and which certificate answered. The reply's [Reply.probes]
     * names each machine, so the setup can be offered only on one that can.
     * Admin only; the coordinator says so if not.
     *
     * Never held: a probe held overnight and replayed is a port scan nobody
     * asked for, and by then the person has put the phone down.
     */
    suspend fun xoprobe(address: String): Reply =
        intent("xoprobe", mapOf("address" to address), idempotencyKey = "app-" + java.util.UUID.randomUUID().toString())

    /**
     * One phase of onboarding a hypervisor. docs/hypervisors.md, and the verb
     * in src/fleet/protocol/intents.js.
     *
     * `begin` goes to the machine chosen ([host]) with the address and the
     * certificate fingerprint the person accepted, or, for a Xen Orchestra
     * that answers in plain HTTP, no [pin] and [plain] set to "accepted"
     * once the person has read what crosses that network. Every later phase
     * names the job alone: the coordinator routes it to the machine that
     * answered `begin`, whatever host this phone might name, because the key
     * is in that machine's memory and nowhere else.
     *
     * `policy` names the job and carries the person's choice of what the
     * fleet may use on the pool, sealed to the same key (XoPolicy.sealChoice);
     * the job is one whose sealed sign-in said so, which only the machine
     * can read.
     *
     * NEVER HELD, for the same reason as [setupToken] and more so: `run`
     * carries the admin sign-in, sealed, and a sealed sign-in on a phone's
     * disk waiting to be replayed is a credential kept. Passing an id is what
     * keeps a send that could not reach the fleet out of the outbox.
     */
    suspend fun xosetup(
        phase: String,
        job: String? = null,
        address: String? = null,
        pin: String? = null,
        sealed: String? = null,
        host: String? = null,
        trust: String? = null,
        plain: String? = null,
    ): Reply =
        intent(
            "xosetup",
            buildMap {
                put("phase", phase)
                if (job != null) put("job", job)
                if (address != null) put("address", address)
                if (pin != null) put("pin", pin)
                if (sealed != null) put("sealed", sealed)
                // ONLY WHEN THE PERSON SAID SO, and only about a certificate
                // that needed saying: the host refuses `connect` on one that
                // does not check out unless this is "accepted", and a trusted
                // one is never asked about (XoSetup.trustFor).
                if (trust != null) put("trust", trust)
                // THE SAME RULE FOR NO CERTIFICATE AT ALL. With no pin the
                // host refuses `begin` unless this is "accepted", which the
                // sheet sends only after the person ticked the box under the
                // sentence that says their password would cross the network
                // readable. Never beside a pin: the two are different setups.
                if (plain != null) put("plain", plain)
            },
            host = host,
            idempotencyKey = "app-" + java.util.UUID.randomUUID().toString(),
        )

    /** Forget a stored credential. Does NOT revoke it at the provider. */
    suspend fun unlink(host: String, provider: String, scope: String? = null): Reply =
        intent("unlink", buildMap { put("provider", provider); if (scope != null) put("scope", scope) }, host = host)

    suspend fun resume(name: String, choice: String? = null): Reply =
        intent("resume", buildMap {
            put("name", name)
            if (choice != null) put("choice", choice)
        })

    /**
     * Spend an ID token for a credential of this device's own.
     *
     * The reply is the ONLY time the credential exists in full — the
     * coordinator keeps a hash of it. Losing it means signing in again, which
     * is the correct cost: a coordinator that could hand back an existing
     * credential is a coordinator that could be made to.
     */
    suspend fun signIn(idToken: String, deviceName: String): Pair<String, String> = withContext(Dispatchers.IO) {
        val body = JSONObject().put("idToken", idToken).put("deviceName", deviceName)
        val json = post("/api/session", body, authenticated = false)
        if (!json.optBoolean("ok", false)) {
            throw IllegalStateException(json.optString("text").ifBlank { "The coordinator refused the sign-in." })
        }
        val token = json.optString("token")
        if (token.isBlank()) throw IllegalStateException("The coordinator issued no credential.")
        // The name it chose looks like "Pixel 9 (someone@example.com)". The
        // address inside it is what the app shows, so a phone signed into the
        // wrong account is visible rather than merely wrong.
        val label = json.optJSONObject("client")?.optString("name") ?: ""
        token to (Regex("\\(([^)]*@[^)]*)\\)").find(label)?.groupValues?.get(1) ?: "")
    }

    /**
     * Whether this fleet can start a temporary machine, and where from.
     *
     * The `runners` field of /api/hosts: the repository holding the runner
     * workflows, or null. NULL IS AN ANSWER — the coordinator knows it has no
     * runner repository — and an older coordinator that omits the field means
     * the same. A failed request is neither, which is why this is a [Result]
     * rather than a null that would quietly hide the control after one blink
     * of the network.
     */
    suspend fun runners(): Result<String?> = withContext(Dispatchers.IO) {
        runCatching {
            get("/api/hosts").optJSONObject("runners")?.optString("repo")?.takeIf { it.isNotBlank() && it != "null" }
        }
    }

    /**
     * A machine image on one of your pools: what a new machine from your own
     * hypervisor is cloned from (docs/hypervisors.md, "Machines from your
     * pool"). `template` is what `provision` takes.
     */
    data class VmImage(
        val template: String,
        val name: String,
        val pool: String?,
        val poolName: String?,
        val address: String,
        val hosts: List<String>,
        /** The pool's networks a machine from it can go on besides the uplink; null from an older coordinator. */
        val networks: List<VmNetwork>? = null,
        /** The pool's group networks, for machines that work together; null from an older coordinator. */
        val groups: List<VmNetwork>? = null,
        /**
         * The pool's labs (docs/hypervisors.md, "Labs"): networks of their own
         * on its edge router, open or closed; null from a coordinator older
         * than labs, and empty when the pool has none.
         */
        val labs: List<VmLab>? = null,
    ) {
        /** "New machine from Fleetwright Debian 13 on rack", for a picker. */
        val label: String get() = "New machine from $name" + (poolName?.let { " on $it" } ?: "")

        /** The first free lab of that kind, or null when none is. */
        fun freeLab(open: Boolean): VmLab? = labs?.firstOrNull { it.open == open && it.free }
    }

    /**
     * A lab on the pool's edge router: open reaches the internet, closed only
     * the fleet and Claude. Free is what the box saw, never assumed.
     */
    data class VmLab(val id: String, val name: String, val open: Boolean, val free: Boolean)

    private fun labsOf(a: JSONArray?): List<VmLab>? = a?.let {
        (0 until it.length()).mapNotNull { j ->
            val l = it.optJSONObject(j) ?: return@mapNotNull null
            val id = l.optString("id").takeIf { s -> s.isNotBlank() } ?: return@mapNotNull null
            // Free only when the coordinator said so in so many words.
            VmLab(id, l.optString("name").ifBlank { id }, l.optBoolean("open", false), l.opt("free") == true)
        }
    }

    /**
     * The machine images you can start a machine from: the `vmImages` field of
     * /api/hosts, one per image, from the boxes holding a pool token you kept
     * in your vault. Empty is an answer (none of yours); an older coordinator
     * omits the field, which reads the same.
     */
    private fun networksOf(a: JSONArray?): List<VmNetwork>? = a?.let {
        (0 until it.length()).mapNotNull { j ->
            val n = it.optJSONObject(j) ?: return@mapNotNull null
            val id = n.optString("id").takeIf { s -> s.isNotBlank() } ?: return@mapNotNull null
            VmNetwork(id, n.optString("name").ifBlank { id })
        }
    }

    suspend fun vmImages(): Result<List<VmImage>> = withContext(Dispatchers.IO) {
        runCatching {
            val list = get("/api/hosts").optJSONArray("vmImages") ?: return@runCatching emptyList()
            (0 until list.length()).mapNotNull { i ->
                val o = list.optJSONObject(i) ?: return@mapNotNull null
                val template = o.optString("template").takeIf { it.isNotBlank() } ?: return@mapNotNull null
                val hosts = o.optJSONArray("hosts")
                VmImage(
                    template = template,
                    name = o.optString("name").ifBlank { "Machine image" },
                    pool = o.optString("pool").takeIf { it.isNotBlank() && it != "null" },
                    poolName = o.optString("poolName").takeIf { it.isNotBlank() && it != "null" },
                    address = o.optString("address"),
                    hosts = if (hosts == null) emptyList() else (0 until hosts.length()).map { hosts.optString(it) },
                    networks = networksOf(o.optJSONArray("networks")),
                    groups = networksOf(o.optJSONArray("groups")),
                    labs = labsOf(o.optJSONArray("labs")),
                )
            }
        }
    }

    /** A network of your pool a new machine can go on. */
    data class VmNetwork(val id: String, val name: String)

    /**
     * A machine made on one of your pools, as the box holding the pool last
     * saw it (docs/hypervisors.md, "Working a machine"). Every field but the
     * name may be null, and null is CANNOT TELL: Xen Orchestra had not said,
     * or the box had not looked since.
     */
    data class VmMachine(
        val name: String,
        /** Its id in Xen Orchestra, for the console link. */
        val vm: String?,
        /** Xen Orchestra's power state: Running, Halted, Suspended, Paused. */
        val state: String?,
        val ip: String?,
        /** When it is removed, ms since the epoch. */
        val until: Long?,
        val madeAt: Long?,
        val cpus: Int?,
        /** Bytes. */
        val memory: Long?,
        val image: String?,
        val network: String?,
        /** What it sent and received, as the hypervisor counted it; null is cannot tell, and a stopped machine has none. */
        val net: Traffic?,
        /** The Xen Orchestra it is on. */
        val address: String,
        /** Kept ready, and not yet taken by a session. */
        val standby: Boolean = false,
        /** The group network it is also on, by name, and its address there; null when in none, or from an older coordinator. */
        val group: String? = null,
        val groupIp: String? = null,
        /** The lab it is in, and whether that lab is open; null when in none, or from an older coordinator. */
        val lab: InLab? = null,
    ) {
        data class InLab(val name: String, val open: Boolean)

        /**
         * Bytes a second through the machine's network interfaces, one point
         * an interval, oldest first, as Xen Orchestra's `vm.stats` counted
         * them. A null point is a sample nobody counted, never a zero.
         */
        data class Traffic(
            /** Seconds between points. */
            val interval: Double,
            /** When the newest point was counted, ms since the epoch. */
            val end: Long,
            val rx: List<Double?>,
            val tx: List<Double?>,
        ) {
            /** The whole span the points cover, in minutes. */
            val minutes: Int get() = Math.round(rx.size * interval / 60).toInt()
            /** Bytes over the span: each counted point times its interval. */
            val received: Double get() = rx.filterNotNull().sum() * interval
            val sent: Double get() = tx.filterNotNull().sum() * interval
            /** Points neither side counted. */
            val gaps: Int get() = rx.zip(tx).count { (r, t) -> r == null && t == null }
        }

        /**
         * The console in Xen Orchestra's own web UI, which signs you in there:
         * this phone never holds the pool's token.
         */
        val consoleUrl: String? get() = if (vm == null || address.isBlank()) null else "https://$address/#/vms/$vm/console"

        /** `ssh fleetwright@192.168.1.40`, or null without an address. */
        val sshCommand: String? get() = ip?.let { "ssh fleetwright@$it" }

        companion object {
            /** The longest a machine lives, from when it was made (xo-pools.js). */
            const val MAX_MINUTES = 350
        }
    }

    /** A machine's `net`, or null for anything that is not a whole one: the same rule the coordinator keeps. */
    private fun traffic(o: JSONObject): VmMachine.Traffic? {
        val interval = o.optDouble("interval").takeIf { it > 0 } ?: return null
        val end = o.optDouble("end").takeIf { it > 0 }?.toLong() ?: return null
        fun points(k: String): List<Double?>? {
            val a = o.optJSONArray(k) ?: return null
            return (0 until a.length()).map { i -> if (a.isNull(i)) null else a.optDouble(i).takeIf { !it.isNaN() && it >= 0 } }
        }
        val rx = points("rx") ?: return null
        val tx = points("tx") ?: return null
        return if (rx.size == tx.size) VmMachine.Traffic(interval, end, rx, tx) else null
    }

    /**
     * The machines on your pools: the `vmMachines` field of /api/hosts.
     * Empty is an answer (none); an older coordinator omits the field.
     */
    suspend fun vmMachines(): Result<List<VmMachine>> = withContext(Dispatchers.IO) {
        runCatching {
            val list = get("/api/hosts").optJSONArray("vmMachines") ?: return@runCatching emptyList()
            fun JSONObject.str(k: String) = optString(k).takeIf { has(k) && !isNull(k) && it.isNotBlank() }
            fun JSONObject.num(k: String) = if (has(k) && !isNull(k)) optDouble(k).takeIf { !it.isNaN() } else null
            (0 until list.length()).mapNotNull { i ->
                val o = list.optJSONObject(i) ?: return@mapNotNull null
                VmMachine(
                    name = o.str("name") ?: return@mapNotNull null,
                    vm = o.str("vm"),
                    state = o.str("state"),
                    ip = o.str("ip"),
                    until = o.num("until")?.toLong(),
                    madeAt = o.num("madeAt")?.toLong(),
                    cpus = o.num("cpus")?.toInt(),
                    memory = o.num("memory")?.toLong(),
                    image = o.str("image"),
                    network = o.str("network"),
                    net = o.optJSONObject("net")?.let { traffic(it) },
                    address = o.optString("address"),
                    standby = o.optBoolean("standby", false),
                    group = o.str("group"),
                    groupIp = o.str("groupIp"),
                    lab = o.optJSONObject("lab")?.let { l ->
                        val name = l.optString("name").takeIf { it.isNotBlank() }
                        if (name == null || !l.has("open")) null else VmMachine.InLab(name, l.optBoolean("open", false))
                    },
                )
            }
        }
    }

    /**
     * What you keep ready on your hypervisor (docs/hypervisors.md, "Machines
     * kept ready"): an image, how many, its network, and how many are ready
     * now and being made.
     */
    data class VmStandby(val template: String, val count: Int, val network: String?, val ready: Int, val starting: Int)

    /**
     * What you keep ready: the `vmStandby` field of /api/hosts. Null is
     * keeping none, and so is an older coordinator, which omits it.
     */
    suspend fun vmStandby(): Result<VmStandby?> = withContext(Dispatchers.IO) {
        runCatching {
            val o = get("/api/hosts").optJSONObject("vmStandby") ?: return@runCatching null
            VmStandby(
                template = o.optString("template"),
                count = o.optInt("count", 0),
                network = o.optString("network").takeIf { o.has("network") && !o.isNull("network") && it.isNotBlank() },
                ready = o.optInt("ready", 0),
                starting = o.optInt("starting", 0),
            )
        }
    }

    /**
     * Keep [count] machines from [template] ready on [network] (null is behind
     * the edge router), or none with 0. The fleet ends the ones no longer wanted.
     */
    suspend fun setVmStandby(template: String?, count: Int, network: String?): Result<Reply> = withContext(Dispatchers.IO) {
        runCatching {
            val body = JSONObject().put("count", count).put("network", network ?: JSONObject.NULL)
            if (template != null) body.put("template", template)
            val json = send("PUT", "/api/vm-standby", body)
            Reply(ok = json.optBoolean("ok", false), text = json.optString("text", ""), sessions = emptyList())
        }
    }

    /**
     * Work a machine on your pool: `reboot`, `extend` by [minutes], `resize`
     * to [cpus] and [memoryGib], or `stop`, which removes it.
     *
     * NEVER HELD on this phone: a restart or an end replayed hours later, when
     * the fleet answers again, is not what anybody asked for. The key is what
     * keeps it out of the outbox.
     */
    suspend fun vmctl(name: String, action: String, minutes: Int? = null, cpus: Int? = null, memoryGib: Int? = null): Reply =
        intent(
            "vmctl",
            mapOf("name" to name, "action" to action),
            numeric = listOfNotNull(minutes?.let { "minutes" to it }, cpus?.let { "cpus" to it }, memoryGib?.let { "memory" to it }).toMap(),
            idempotencyKey = "app-" + java.util.UUID.randomUUID().toString(),
        )

    /**
     * Whether the person this credential belongs to is the fleet's admin.
     *
     * The same flag the coordinator's destructive-route guard reads, so a row
     * drawn from it cannot disagree with the refusal. A failure (an older
     * coordinator that does not serve it) is CANNOT TELL, not "no".
     */
    suspend fun me(): Result<Boolean> = withContext(Dispatchers.IO) {
        // A reply without the field is an older coordinator's "no such route",
        // which is not an answer about this person.
        runCatching {
            val reply = get("/api/me")
            check(reply.has("admin")) { "This fleet does not say who is an admin." }
            reply.optBoolean("admin", false)
        }
    }

    /** The machines in this fleet, with their key fingerprints. */
    suspend fun enrolledHosts(): List<Host> = withContext(Dispatchers.IO) {
        runCatching {
            val json = get("/api/hosts/enrolled")
            val array = json.optJSONArray("hosts") ?: return@runCatching emptyList<Host>()
            (0 until array.length()).mapNotNull { i ->
                val o = array.optJSONObject(i) ?: return@mapNotNull null
                Host(
                    hostId = o.optString("hostId"),
                    fingerprint = o.optString("fingerprint"),
                    revoked = o.optLong("revokedAt", 0L) > 0L,
                    lastSeenAt = o.optLong("lastSeenAt", 0L).takeIf { it > 0L },
                    publicJwk = o.optJSONObject("publicJwk"),
                    ephemeral = o.optBoolean("ephemeral", false),
                )
            }
        }.getOrDefault(emptyList())
    }

    /**
     * Mint a six-digit pin for a machine to join with.
     *
     * This is how a host gets in now: no shared token to copy onto every box,
     * one pin, ten minutes, single use.
     *
     * @param ephemeral admits a host that is EXPECTED to vanish — a CI runner.
     *   Decided here, when the pin is minted, rather than claimed by the host:
     *   a machine that could declare itself temporary is a machine that could
     *   decline to be cleaned up. See docs/ephemeral-hosts.md.
     * @param hostId BINDS the pin to one machine's name, which is what
     *   readmitting or re-keying an existing host requires. An unbound pin is
     *   handed out to ADD a box and must not be spendable on taking over one
     *   that already exists, so the coordinator refuses both cases unless the
     *   pin names the host.
     * @param readmit additionally permits bringing back a host that was
     *   revoked, so undoing a removal is a decision somebody makes rather than
     *   a side effect of holding a pin.
     */
    suspend fun mintHostPin(
        ephemeral: Boolean = false,
        hostId: String? = null,
        readmit: Boolean = false,
    ): MintedPin = withContext(Dispatchers.IO) {
        val body = JSONObject().put("kind", "host").put("ephemeral", ephemeral)
        // OMITTED WHEN ABSENT rather than sent as null: a null hostId binds the
        // pin to nothing and reads, on the wire, as somebody having meant to.
        if (!hostId.isNullOrBlank()) body.put("hostId", hostId).put("readmit", readmit)
        val json = post("/api/enroll", body)
        val code = json.optString("code").ifBlank {
            throw IllegalStateException(json.optString("text").ifBlank { "Could not mint a pin." })
        }
        // `isNull` first: org.json's optString renders a JSON null as the
        // string "null", which would be shown as a command to paste.
        val install = if (json.isNull("install")) null else json.optString("install").ifBlank { null }
        MintedPin(code, install)
    }

    /**
     * A pin, and — when the coordinator publishes an installer — the one line
     * that installs a fresh box and joins it with that pin. `install` is null
     * on a coordinator that does not (its /install answers 404, so the line
     * would too) and on an older coordinator that omits the field; the screen
     * then shows the two-step form and nothing that would fail. C-5.
     */
    data class MintedPin(val code: String, val install: String?)

    /** Remove a machine from the fleet. It is disconnected as well as revoked. */
    suspend fun revokeHost(hostId: String): Reply = withContext(Dispatchers.IO) {
        runCatching {
            val json = send("DELETE", "/api/hosts/" + hostId, null)
            Reply(json.optBoolean("ok", false), json.optString("text"), emptyList())
        }.getOrElse { Reply(false, it.message ?: "could not reach the coordinator", emptyList()) }
    }

    /**
     * A member of the fleet, reporting or not. `lastSeenAt` is milliseconds
     * since the epoch, or null for a box that enrolled and never connected —
     * which is a different fact from one that went away, and is shown as one.
     */
    /**
     * `publicJwk` is the box's own public key, which a phone approves for its
     * person's vault by (PhoneVault): null from a coordinator too old to list it.
     */
    data class Host(
        val hostId: String,
        val fingerprint: String,
        val revoked: Boolean,
        val lastSeenAt: Long? = null,
        val publicJwk: JSONObject? = null,
        val ephemeral: Boolean = false,
    )

    /**
     * A device that holds a credential for this fleet. No secret in it — the
     * coordinator keeps a hash, which is what makes them worth hashing.
     */
    data class Client(
        val id: String,
        val name: String?,
        /**
         * The person it was minted for. Null on a credential from before
         * sign-in carried one, which is worth showing as absent rather than
         * attributed to whoever happens to be looking.
         */
        val email: String?,
        val createdAt: Long?,
        /**
         * Null means it has never been used — not "used long ago". Somebody
         * deciding what to revoke needs those two to look different.
         */
        val lastSeenAt: Long?,
    )

    /** One thing that happened, as the fleet recorded it. */
    data class Event(
        val event: String,
        val at: Long,
        val hostId: String?,
        val name: String?,
        val text: String?,
        /**
         * The verified email of whoever asked. Null for events the fleet
         * originated itself — "the fleet did this" and "somebody did this" are
         * not the same news.
         */
        val actor: String?,
        val verb: String?,
        val url: String?,
    )

    /**
     * WHICH DEVICES CAN REACH THIS FLEET.
     *
     * Documented on both coordinators since devices existed, implemented by
     * neither app: a phone that was lost could be revoked only by somebody with
     * a terminal, which is the one thing this product exists not to require.
     * Sign-in mints one credential per device on purpose — so revoking one
     * leaves every other alone — and that is worth nothing while nobody can see
     * the list.
     */
    suspend fun clients(): List<Client> = withContext(Dispatchers.IO) {
        runCatching {
            val json = get("/api/clients")
            val arr = json.optJSONArray("clients") ?: return@runCatching emptyList<Client>()
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                Client(
                    id = o.optString("id"),
                    name = o.optString("name").takeIf { it.isNotBlank() && it != "null" },
                    email = o.optString("email").takeIf { it.isNotBlank() && it != "null" },
                    createdAt = o.optLong("createdAt", 0L).takeIf { it > 0L },
                    // `has` first: optLong would turn a missing field into 0,
                    // and "never used" must not render as 1970.
                    lastSeenAt = o.takeIf { it.has("lastSeenAt") && !it.isNull("lastSeenAt") }?.optLong("lastSeenAt"),
                )
            }
        }.getOrDefault(emptyList())
    }

    /**
     * Somebody allowed to sign in, by address. Permission to attempt a sign-in,
     * not a credential: there is nothing here to replay or steal into an
     * account. Matches the iOS `Fleet.Invite` field for field.
     */
    data class Invite(
        val email: String,
        val invitedBy: String?,
        val at: Long?,
        val note: String?,
    )

    /**
     * Who has been invited. Admin only, in every direction including reading —
     * a list of who has been invited is a list of colleagues — and the refusal
     * is thrown rather than turned into an empty list, because an empty list
     * is a lie a member would believe.
     */
    suspend fun invites(): List<Invite> = withContext(Dispatchers.IO) {
        val json = get("/api/invites")
        if (!json.optBoolean("ok", true)) throw java.io.IOException(json.optString("text").ifBlank { "refused" })
        val arr = json.optJSONArray("invites") ?: return@withContext emptyList<Invite>()
        (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            Invite(
                email = o.optString("email"),
                invitedBy = o.optString("invitedBy").takeIf { it.isNotBlank() && it != "null" },
                at = o.takeIf { it.has("at") && !it.isNull("at") }?.optLong("at"),
                note = o.optString("note").takeIf { it.isNotBlank() && it != "null" },
            )
        }
    }

    suspend fun invite(email: String, note: String?): Reply = withContext(Dispatchers.IO) {
        val body = JSONObject().put("email", email)
        if (!note.isNullOrBlank()) body.put("note", note)
        runCatching {
            val json = post("/api/invites", body)
            Reply(json.optBoolean("ok", false), json.optString("text"), emptyList())
        }.getOrElse { Reply(false, it.message ?: "could not reach the coordinator", emptyList()) }
    }

    suspend fun uninvite(email: String): Reply = withContext(Dispatchers.IO) {
        runCatching {
            val json = send("DELETE", "/api/invites/" + java.net.URLEncoder.encode(email, "UTF-8"), null)
            Reply(json.optBoolean("ok", false), json.optString("text"), emptyList())
        }.getOrElse { Reply(false, it.message ?: "could not reach the coordinator", emptyList()) }
    }

    suspend fun revokeClient(id: String): Reply = withContext(Dispatchers.IO) {
        runCatching {
            val json = send("DELETE", "/api/clients/" + id, null)
            Reply(json.optBoolean("ok", false), json.optString("text"), emptyList())
        }.getOrElse { Reply(false, it.message ?: "could not reach the coordinator", emptyList()) }
    }

    /**
     * The runner tokens that are yours — every one for an admin.
     *
     * The same row as a device credential, because it is one: the coordinator
     * keeps them in a second registry with a different prefix so that one can
     * never authenticate a request. `email` is who a run using it is
     * attributed to. Throws on a refusal, so the screen shows the reason
     * rather than an empty list.
     */
    suspend fun runnerTokens(): List<Client> = withContext(Dispatchers.IO) {
        val json = get("/api/runner-tokens")
        if (!json.optBoolean("ok", true)) throw java.io.IOException(json.optString("text").ifBlank { "refused" })
        val arr = json.optJSONArray("tokens") ?: return@withContext emptyList<Client>()
        (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            Client(
                id = o.optString("id"),
                name = o.optString("name").takeIf { it.isNotBlank() && it != "null" },
                email = o.optString("email").takeIf { it.isNotBlank() && it != "null" },
                createdAt = o.optLong("createdAt", 0L).takeIf { it > 0L },
                lastSeenAt = o.takeIf { it.has("lastSeenAt") && !it.isNull("lastSeenAt") }?.optLong("lastSeenAt"),
            )
        }
    }

    /**
     * Mint one for a repository. THE TOKEN IS RETURNED ONCE and the
     * coordinator keeps a hash, like every other secret it issues. Returns
     * id to token; throws with the coordinator's own sentence on a refusal.
     */
    suspend fun mintRunnerToken(name: String): Pair<String, String> = withContext(Dispatchers.IO) {
        val json = post("/api/runner-tokens", JSONObject().put("name", name))
        val token = json.optString("token")
        if (token.isBlank()) throw java.io.IOException(json.optString("text").ifBlank { "could not mint a runner token" })
        json.optString("id") to token
    }

    suspend fun revokeRunnerToken(id: String): Reply = withContext(Dispatchers.IO) {
        runCatching {
            val json = send("DELETE", "/api/runner-tokens/" + id, null)
            Reply(json.optBoolean("ok", false), json.optString("text"), emptyList())
        }.getOrElse { Reply(false, it.message ?: "could not reach the coordinator", emptyList()) }
    }

    /**
     * What happened while you were asleep.
     *
     * Push wakes a phone; this is what it missed. Half of that pair shipped —
     * the notification arrives, and an app that has been closed since yesterday
     * has no way to find out what it was about beyond whatever sentence fitted
     * on the lock screen.
     */
    suspend fun events(): List<Event> = withContext(Dispatchers.IO) {
        runCatching {
            val json = get("/api/events")
            val arr = json.optJSONArray("events") ?: return@runCatching emptyList<Event>()
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                Event(
                    event = o.optString("event"),
                    at = o.optLong("at", 0L),
                    hostId = o.optString("hostId").takeIf { it.isNotBlank() && it != "null" },
                    name = o.optString("name").takeIf { it.isNotBlank() && it != "null" },
                    text = o.optString("text").takeIf { it.isNotBlank() && it != "null" },
                    actor = o.optString("actor").takeIf { it.isNotBlank() && it != "null" },
                    verb = o.optString("verb").takeIf { it.isNotBlank() && it != "null" },
                    url = o.optString("url").takeIf { it.isNotBlank() && it != "null" },
                )
            }
        }.getOrDefault(emptyList())
    }

    /**
     * Register this device for push.
     *
     * Called with whatever token the messaging SDK hands us. Kept separate from
     * the SDK on purpose: the server side of push is finished and testable, and
     * this is the single line that connects it once Firebase exists.
     */
    suspend fun registerDevice(token: String): Boolean = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("platform", "android")
            .put("token", token)
        runCatching { post("/api/devices", body).optBoolean("ok", false) }.getOrDefault(false)
    }

    /**
     * Every action is one intent. The coordinator decides which host it lands
     * on — an app that picked the host would have to know which box holds which
     * session, which is exactly the thing the coordinator exists to know.
     */
    /**
     * @param numeric keys the protocol types as `int`. They must be sent as
     *   JSON NUMBERS — validateIntent requires a safe integer and refuses
     *   `"2"`, and that refusal would arrive AFTER the version handshake had
     *   already agreed, which is the worst-shaped failure this protocol has.
     */
    /** Send a held command again, under the id it was queued with. */
    suspend fun resend(entry: Outbox.Held): Reply =
        intent(entry.verb, entry.params, entry.host, idempotencyKey = entry.id)

    private suspend fun intent(
        verb: String,
        params: Map<String, String> = emptyMap(),
        host: String? = null,
        numeric: Map<String, Int> = emptyMap(),
        idempotencyKey: String? = null,
        extra: Map<String, Any> = emptyMap(),
    ): Reply =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("verb", verb)
                .put("params", JSONObject(params.toMap()).also { p -> numeric.forEach { (k, v) -> p.put(k, v) } })
                .put("actor", "app:android")
                // An idempotency key the SERVER honours: a retry of `start`
                // returns the original outcome instead of a second session.
                // Supplied by the caller when this command has been HELD, so
                // a retry carries the id it was queued under. Minted here only
                // for a command being sent for the first time.
                .put("id", idempotencyKey ?: ("app-" + java.util.UUID.randomUUID().toString()))
            if (!host.isNullOrBlank()) body.put("host", host)
            extra.forEach { (k, v) -> body.put(k, v) }
            try {
                val json = post("/api/intent", body)
                Reply(
                    ok = json.optBoolean("ok", false),
                    text = json.optString("text", ""),
                    code = json.optJSONObject("error")?.optString("code")?.takeIf { it.isNotBlank() && it != "null" },
                    sessions = parseSessions(json.optJSONArray("sessions")),
                    connections = parseConnections(json.optJSONObject("connections")),
                    entries = json.optJSONArray("entries")?.let { a ->
                        (0 until a.length()).mapNotNull { i ->
                            a.optJSONObject(i)?.let { e ->
                                val n = e.optString("name")
                                if (n.isBlank()) null
                                else Entry(n, e.optString("kind", "file"), e.optLong("size", 0L))
                            }
                        }
                    } ?: emptyList(),
                    // ABSENT STAYS NULL. `optJSONArray` returns null for a
                    // missing key and for an explicit null alike, which is
                    // exactly the distinction wanted here: no key means nobody
                    // answered, `[]` means nothing to offer.
                    channel = json.optString("channel").takeIf { it.isNotBlank() && it != "null" },
                    channelPinned = json.optBoolean("channelPinned"),
                    sandboxVariant = json.optJSONObject("sandbox")?.optString("variant")?.takeIf { it.isNotBlank() && it != "null" },
                    sandboxImage = json.optJSONObject("sandbox")?.optString("image")?.takeIf { it.isNotBlank() && it != "null" },
                    sandboxPinned = json.optJSONObject("sandbox")?.optBoolean("pinned") == true,
                    // ABSENT STAYS NULL, present-and-empty is a real answer.
                    // `optJSONArray` returns null for both a missing key and an
                    // explicit null, which is the distinction wanted: no key
                    // means this reply was not about labels, `[]` means none are
                    // set here — and the second one must clear the last chip.
                    setLabels = json.optJSONArray("setLabels")?.let { arr ->
                        (0 until arr.length()).mapNotNull { i -> arr.optString(i).takeIf { it.isNotBlank() } }
                    },
                    waiting = json.optJSONObject("waiting")?.let { w ->
                        val a = w.optJSONObject("app")
                        val sy = w.optJSONObject("system")
                        Waiting(
                            appKind = a?.optString("kind")?.takeIf { it.isNotBlank() && it != "null" },
                            // `has` first: optBoolean turns a missing field into
                            // false, and "nobody could find out" is not "nothing
                            // is waiting".
                            appPending = a?.takeIf { it.has("pending") && !it.isNull("pending") }?.optBoolean("pending"),
                            appAvailable = a?.optString("available")?.takeIf { it.isNotBlank() && it != "null" },
                            appConfigured = a?.takeIf { it.has("configured") && !it.isNull("configured") }?.optBoolean("configured"),
                            appBehind = a?.optInt("behind", -1)?.takeIf { it >= 0 },
                            appText = a?.optString("text")?.takeIf { it.isNotBlank() && it != "null" },
                            systemPending = sy?.optBoolean("pending") == true,
                            systemText = sy?.optString("text")?.takeIf { it.isNotBlank() && it != "null" },
                            // `has` first, for the same reason as `pending`: a
                            // missing grant is a host that did not say, not off.
                            grantUpgrades = w.optJSONObject("grants")?.takeIf { it.has("upgrades") && !it.isNull("upgrades") }?.optBoolean("upgrades"),
                            grantReboot = w.optJSONObject("grants")?.takeIf { it.has("reboot") && !it.isNull("reboot") }?.optBoolean("reboot"),
                        )
                    },
                    profiles = json.optJSONArray("profiles")?.let { a ->
                        (0 until a.length()).mapNotNull { i ->
                            a.optJSONObject(i)?.let { p ->
                                val n = p.optString("name")
                                if (n.isBlank()) null
                                else Profile(
                                    name = n,
                                    summary = p.optString("summary", ""),
                                    chars = p.optInt("chars", 0),
                                    hostId = p.optString("hostId").takeIf { it.isNotBlank() && it != "null" },
                                )
                            }
                        }
                    },
                    secrets = json.optJSONArray("secrets")?.let { a ->
                        (0 until a.length()).mapNotNull { i ->
                            a.optJSONObject(i)?.let { s ->
                                val n = s.optString("name")
                                if (n.isBlank()) null
                                else Secret(
                                    name = n,
                                    hostId = s.optString("hostId").takeIf { it.isNotBlank() && it != "null" },
                                )
                            }
                        }
                    },
                    check = json.optJSONObject("check")?.let { c ->
                        fun list(key: String): List<String>? =
                            if (!c.has(key) || c.isNull(key)) null
                            else c.optJSONArray(key)?.let { a ->
                                (0 until a.length()).mapNotNull { i -> a.optString(i).takeIf { it.isNotBlank() } }
                            } ?: emptyList()
                        Check(
                            ok = c.optBoolean("ok", false),
                            account = c.optString("account").takeIf { it.isNotBlank() && it != "null" },
                            granted = list("granted"),
                            missing = list("missing"),
                            message = c.optString("message").takeIf { it.isNotBlank() && it != "null" },
                            hostId = c.optString("hostId").takeIf { it.isNotBlank() && it != "null" },
                        )
                    },
                    url = json.optString("url").takeIf { it.isNotBlank() && it != "null" },
                    sealed = json.optJSONObject("sealed"),
                    hostId = json.optString("hostId").takeIf { it.isNotBlank() && it != "null" },
                    probes = json.optJSONArray("probes")?.let { a ->
                        (0 until a.length()).mapNotNull { i ->
                            a.optJSONObject(i)?.let { p ->
                                val id = p.optString("hostId")
                                if (id.isBlank()) null
                                else Probe(
                                    hostId = id,
                                    reachable = p.optBoolean("reachable", false),
                                    // `has` and `isNull` first: optBoolean would
                                    // turn "could not tell" into "not Xen
                                    // Orchestra", which is a different answer.
                                    xo = p.takeIf { it.has("xo") && !it.isNull("xo") }?.optBoolean("xo"),
                                    tls = p.optBoolean("tls", false),
                                    cert = p.optString("cert").takeIf { XoSetup.PIN_RE.matches(it) },
                                    version = p.optString("version").takeIf { it.isNotBlank() && it != "null" },
                                    certificate = XoSetup.certificate(p.optJSONObject("certificate")),
                                    ssh = p.optJSONObject("ssh")?.let { s ->
                                        // `has` and `isNull` first, for the reason `xo` gives.
                                        fun maybe(key: String): Boolean? = s.takeIf { it.has(key) && !it.isNull(key) }?.optBoolean(key)
                                        SshProbe(
                                            reachable = maybe("reachable"),
                                            keys = s.optJSONArray("keys")?.let { a ->
                                                (0 until a.length()).mapNotNull { i ->
                                                    a.optJSONObject(i)?.let { k ->
                                                        val fp = k.optString("fingerprint")
                                                        val hex = k.optString("sha256")
                                                        if (XoDeploy.SSH_KEY_RE.matches(fp) && XoSetup.PIN_RE.matches(hex)) SshKey(k.optString("type"), fp, hex) else null
                                                    }
                                                }
                                            } ?: emptyList(),
                                            deploy = maybe("deploy"),
                                            missing = s.optJSONArray("missing")?.let { a ->
                                                (0 until a.length()).mapNotNull { i -> a.optString(i, "").takeIf { it.isNotBlank() && !a.isNull(i) } }
                                            } ?: emptyList(),
                                        )
                                    },
                                )
                            }
                        }
                    },
                    xosetup = json.optJSONObject("xosetup")?.let { s ->
                        val job = s.optString("job")
                        if (!XoSetup.JOB_RE.matches(job)) null
                        else Setup(
                            job = job,
                            state = s.optString("state").takeIf { it.isNotBlank() && it != "null" } ?: "waiting",
                            step = s.optInt("step", -1).takeIf { it >= 0 },
                            of = s.optInt("of", -1).takeIf { it >= 1 },
                            phase = s.optString("phase").takeIf { it.isNotBlank() && it != "null" },
                            text = s.optString("text").takeIf { it.isNotBlank() && it != "null" },
                            key = s.optString("key").takeIf { it.isNotBlank() && it != "null" },
                            keySig = s.optString("keySig").takeIf { it.isNotBlank() && it != "null" },
                            hostKey = s.optJSONObject("hostKey"),
                            fingerprint = s.optString("fingerprint").takeIf { it.isNotBlank() && it != "null" },
                            handoff = s.optString("handoff").takeIf { it.split(".").size == 3 },
                            can = s.optJSONArray("can")?.let { a ->
                                (0 until a.length()).mapNotNull { i -> a.optString(i, "").takeIf { it.isNotBlank() && !a.isNull(i) } }
                            } ?: emptyList(),
                            inventory = s.optString("inventory").takeIf { it.split(".").size == 3 },
                            part = s.optJSONObject("part")?.let { p ->
                                val stage = p.optInt("stage", -1)
                                val stages = p.optInt("stages", -1)
                                val fill = p.optInt("fill", -1)
                                val build = p.optString("build").takeIf { it.isNotBlank() && !p.isNull("build") }
                                if (stage in 1..stages && fill in 0..1000) BuildPart(stage, stages, fill, build) else null
                            },
                        )
                    },
                )
            } catch (e: Exception) {
                // HELD, NOT LOST — but only when the fleet could not be
                // REACHED. A refusal is an answer, and replaying an answer is
                // how somebody's revoked credential retries all night. See
                // isDeliveryFailure.
                // NOT HELD WHEN IT CARRIES MORE THAN PARAMS: the outbox
                // replays verb, params and host, and a replay that dropped a
                // session request would start a machine nobody is waiting on.
                val entry =
                    if (idempotencyKey == null && extra.isEmpty() && isDeliveryFailure(e)) outbox?.hold(verb, params, host) else null
                if (entry != null) {
                    Reply(
                        ok = true,
                        text = "Held on this phone. ${entry.summary} will be sent when the fleet answers again.",
                        sessions = emptyList(),
                    )
                } else {
                    Reply(ok = false, text = e.message ?: "could not reach the coordinator", sessions = emptyList())
                }
            }
        }

    /**
     * What every machine is reporting right now.
     *
     * /api/hosts, not /api/hosts/enrolled: enrolled is the membership list
     * (fingerprints, who added it), this is what they are SAYING. Both are
     * shown in settings; they answer different questions.
     */
    suspend fun fleetHosts(): List<FleetHost> = withContext(Dispatchers.IO) {
        runCatching {
            val json = get("/api/hosts")
            val arr = json.optJSONArray("hosts") ?: return@runCatching emptyList()
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                val health = o.optJSONObject("health")
                val account = health?.optJSONObject("account")
                val updates = health?.optJSONObject("updates")
                FleetHost(
                    hostId = o.optString("hostId"),
                    state = o.optString("state").takeIf { it.isNotBlank() },
                    reason = o.optString("reason").takeIf { it.isNotBlank() && it != "null" },
                    loggedIn = if (health?.has("loggedIn") == true) health.optBoolean("loggedIn") else null,
                    claudeAccounts = if (health?.has("claudeAccounts") == true && !health.isNull("claudeAccounts")) {
                        health.optInt("claudeAccounts")
                    } else null,
                    runnerAuth = health?.optString("runnerAuth")?.takeIf { it == "owner" || it == "key" || it == "none" },
                    ephemeral = o.optBoolean("ephemeral", false),
                    accountEmail = account?.optString("email")?.takeIf { it.isNotBlank() && it != "null" },
                    accountPlan = account?.optString("plan")?.takeIf { it.isNotBlank() && it != "null" },
                    accountOrg = account?.optString("org")?.takeIf { it.isNotBlank() && it != "null" },
                    version = health?.optJSONObject("version")?.optString("head")?.takeIf { it.isNotBlank() },
                    installed = health?.optJSONObject("version")?.optString("installed")?.takeIf { it.isNotBlank() },
                    // Only the two words the host uses; anything else, and a
                    // missing field, is null. "null" as a string is what
                    // optString makes of a JSON null, and it must not become
                    // a third state.
                    helper = health?.optJSONObject("version")?.optString("helper")?.takeIf { it == "current" || it == "stale" },
                    behind = updates?.optInt("appBehind", -1)?.takeIf { it >= 0 },
                    // `has` first: optBoolean would turn a missing field into
                    // false, which is the difference between "nothing waiting"
                    // and "nobody could find out" — the whole point of the field.
                    appPendingReported =
                        updates?.takeIf { it.has("appPending") && !it.isNull("appPending") }?.optBoolean("appPending"),
                    systemUpdates = updates?.optString("system")?.takeIf { it.isNotBlank() && it != "null" },
                    rebootRequired = updates?.optBoolean("rebootRequired") == true,
                    release = updates?.optJSONObject("release")?.let { r ->
                        Release(
                            available = r.optString("available").takeIf { it.isNotBlank() && it != "null" },
                            configured = r.optBoolean("configured"),
                            message = r.optString("message").takeIf { it.isNotBlank() && it != "null" },
                        )
                    },
                    // `has` first: optBoolean turns a missing grant into false,
                    // and a host too old to say is not a host that refuses.
                    grantUpgrades = updates?.optJSONObject("grants")?.takeIf { it.has("upgrades") && !it.isNull("upgrades") }?.optBoolean("upgrades"),
                    grantReboot = updates?.optJSONObject("grants")?.takeIf { it.has("reboot") && !it.isNull("reboot") }?.optBoolean("reboot"),
                    channel = health?.optString("channel")?.takeIf { it.isNotBlank() && it != "null" },
                    channelPinned = health?.optBoolean("channelPinned") == true,
                    sandboxVariant = health?.optJSONObject("sandbox")?.optString("variant")?.takeIf { it.isNotBlank() && it != "null" },
                    sandboxImage = health?.optJSONObject("sandbox")?.optString("image")?.takeIf { it.isNotBlank() && it != "null" },
                    sandboxPinned = health?.optJSONObject("sandbox")?.optBoolean("pinned") == true,
                    labels = health?.optJSONArray("labels")?.let { arr ->
                        (0 until arr.length()).mapNotNull { i -> arr.optString(i).takeIf { it.isNotBlank() } }
                    } ?: emptyList(),
                    setLabels = health?.optJSONArray("setLabels")?.let { arr ->
                        (0 until arr.length()).mapNotNull { i -> arr.optString(i).takeIf { it.isNotBlank() } }
                    } ?: emptyList(),
                    bin = health?.optJSONArray("bin")?.let { arr ->
                        (0 until arr.length()).mapNotNull { i ->
                            arr.optJSONObject(i)?.let { b ->
                                val n = b.optString("name")
                                if (n.isBlank()) null
                                else Binned(
                                    name = n,
                                    title = b.optString("title").takeIf { it.isNotBlank() && it != "null" },
                                    expiresAt = b.optLong("expiresAt", 0L),
                                )
                            }
                        }
                    } ?: emptyList(),
                    credential = health?.optJSONObject("credential")?.let { c ->
                        Credential(
                            state = c.optString("state").takeIf { it.isNotBlank() && it != "null" },
                            expiresAt = c.optLong("expiresAt", 0L).takeIf { it > 0L },
                            refreshable = if (c.has("refreshable")) c.optBoolean("refreshable") else null,
                            account = c.optString("account").takeIf { it.isNotBlank() && it != "null" },
                            summary = c.optString("summary").takeIf { it.isNotBlank() && it != "null" },
                        )
                    },
                    // ABSENT STAYS NULL, and present-and-empty is a real
                    // answer: a box with none of the three units installed.
                    logs = health?.optJSONArray("logs")?.let { arr ->
                        (0 until arr.length()).mapNotNull { i -> arr.optString(i).takeIf { it.isNotBlank() } }
                    },
                    // ABSENT AND JSON-NULL BOTH STAY NULL, and 0 is kept as 0:
                    // optInt would read a missing key as 0, which is the one
                    // collapse this field exists to prevent — "no file" drawn
                    // as "a file that is not in use".
                    houseRules = health?.takeIf { it.has("houseRules") && !it.isNull("houseRules") }?.optInt("houseRules"),
                )
            }
        }.getOrDefault(emptyList())
    }

    /**
     * Never throws and never half-parses: a malformed row is dropped, because a
     * picker missing one provider is recoverable and a crash on the settings
     * screen is not.
     */
    private fun parseConnections(o: JSONObject?): Connections? {
        if (o == null) return null
        val catalogue = o.optJSONArray("catalogue")
        val connected = o.optJSONArray("connected")
        return Connections(
            catalogue = (0 until (catalogue?.length() ?: 0)).mapNotNull { i ->
                catalogue?.optJSONObject(i)?.let { c ->
                    val provider = c.optString("provider")
                    if (provider.isBlank()) return@let null
                    val env = c.optJSONArray("env")
                    Connections.Available(
                        provider = provider,
                        label = c.optString("label", provider),
                        // optString turns a JSON null into the string "null",
                        // which would be rendered as a link somebody could tap.
                        url = c.optString("url").takeIf { it.isNotBlank() && it != "null" },
                        hint = c.optString("hint", ""),
                        env = (0 until (env?.length() ?: 0)).mapNotNull { k -> env?.optString(k) },
                        wants = c.optJSONArray("wants")?.let { w ->
                            (0 until w.length()).mapNotNull { k -> w.optString(k).takeIf { it.isNotBlank() } }
                        } ?: emptyList(),
                        flow = c.optString("flow").takeIf { it.isNotBlank() && it != "null" },
                    )
                }
            },
            connected = (0 until (connected?.length() ?: 0)).mapNotNull { i ->
                connected?.optJSONObject(i)?.let { c ->
                    val provider = c.optString("provider")
                    if (provider.isBlank()) return@let null
                    Connections.Linked(
                        provider = provider,
                        label = c.optString("label").takeIf { it.isNotBlank() && it != "null" },
                        account = c.optString("account").takeIf { it.isNotBlank() && it != "null" },
                        updatedAt = c.optLong("updatedAt", 0L),
                        // has("missing") distinguishes null — "cannot tell" —
                        // from an empty array, which means "checked, nothing
                        // missing". optJSONArray alone collapses the two.
                        missing = if (!c.has("missing") || c.isNull("missing")) null
                        else c.optJSONArray("missing")?.let { m ->
                            (0 until m.length()).mapNotNull { k -> m.optString(k).takeIf { it.isNotBlank() } }
                        } ?: emptyList(),
                        needsReconnect = c.optBoolean("needsReconnect"),
                        // A window the host did not send, or sent as null,
                        // stays null rather than reading as 0% used.
                        usage = c.optJSONObject("usage")?.let { u ->
                            fun window(o: JSONObject?, key: String): UsageReport.Window? =
                                o?.optJSONObject(key)?.let { w ->
                                    UsageReport.Window(
                                        used = w.takeIf { it.has("used") && !it.isNull("used") }?.optDouble("used"),
                                        resetsAt = w.optLong("resetsAt", 0L).takeIf { it > 0L },
                                    )
                                }
                            val w = u.optJSONObject("windows")
                            UsageReport(
                                checkedAt = u.optLong("checkedAt", 0L).takeIf { it > 0L },
                                windows = w?.let {
                                    UsageReport.Windows(
                                        fiveHour = window(it, "fiveHour"),
                                        sevenDay = window(it, "sevenDay"),
                                        sevenDayOpus = window(it, "sevenDayOpus"),
                                        sevenDaySonnet = window(it, "sevenDaySonnet"),
                                    )
                                },
                                why = u.optString("why").takeIf { it.isNotBlank() && it != "null" },
                            )
                        },
                    )
                }
            },
        )
    }

    /** A number the host sent, or null when it sent none — never optLong's 0. */
    private fun longOrNull(o: JSONObject, key: String): Long? =
        if (o.has(key) && !o.isNull(key)) o.optLong(key) else null

    private fun parseSessions(array: JSONArray?): List<Session> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull { i ->
            val o = array.optJSONObject(i) ?: return@mapNotNull null
            Session(
                name = o.optString("name"),
                title = o.optString("title").takeIf { it.isNotBlank() && it != "null" },
                status = o.optString("status", "unknown"),
                hostId = o.optString("hostId").takeIf { it.isNotBlank() },
                rcUrl = o.optString("rcUrl").takeIf { it.isNotBlank() && it != "null" },
                resumable = o.optBoolean("resumable", o.optString("uuid").isNotBlank()),
                cwd = o.optString("cwd").takeIf { it.isNotBlank() && it != "null" },
                startedAt = o.optLong("startedAt").takeIf { it > 0 },
                account = o.optString("account").takeIf { it.isNotBlank() && it != "null" },
                prompt = o.optJSONObject("prompt")?.let { pr ->
                    val opts = pr.optJSONArray("options")
                    Prompt(
                        id = pr.optString("id").takeIf { it.isNotBlank() },
                        question = pr.optString("question").takeIf { it.isNotBlank() && it != "null" },
                        options = if (opts == null) emptyList() else (0 until opts.length()).mapNotNull { k ->
                            opts.optJSONObject(k)?.let { Prompt.Option(it.optInt("index"), it.optString("label")) }
                        },
                    )
                },
                idleSince = o.optLong("idleSince").takeIf { it > 0 },
                atRest = o.optBoolean("atRest"),
                // A count the host read, or null — never 0 for a missing key:
                // optLong would read absent as 0, and "empty window" is a
                // claim the host did not make.
                context = o.optJSONObject("context")?.let { c ->
                    Session.ContextUsage(
                        tokens = c.takeIf { it.has("tokens") && !it.isNull("tokens") }?.optLong("tokens"),
                        model = c.optString("model").takeIf { it.isNotBlank() && it != "null" },
                    )
                },
                // Each number null when absent, never optLong's 0: a session
                // that "worked 0m" or "cost $0.00" is a claim the host did not
                // make.
                awaitingSince = longOrNull(o, "awaitingSince")?.takeIf { it > 0 },
                phases = o.optJSONObject("phases")?.let { p ->
                    Session.Phases(
                        since = longOrNull(p, "since"),
                        current = p.optString("current").takeIf { it.isNotBlank() && it != "null" },
                        currentSince = longOrNull(p, "currentSince"),
                        workingMs = longOrNull(p, "workingMs"),
                        awaitingMs = longOrNull(p, "awaitingMs"),
                        readyMs = longOrNull(p, "readyMs"),
                    )
                },
                spent = o.optJSONObject("spent")?.let { s ->
                    Session.Spent(
                        usd = s.takeIf { it.has("usd") && !it.isNull("usd") }?.optDouble("usd")?.takeIf { !it.isNaN() },
                        complete = s.optBoolean("complete", false),
                        outputTokens = longOrNull(s, "outputTokens"),
                        asOf = longOrNull(s, "asOf"),
                    )
                },
                archive = o.optString("archive").takeIf { it.isNotBlank() && it != "null" },
                archiveAt = o.optLong("archiveAt").takeIf { it > 0 },
                // `has` first, for the same reason as everywhere else: a
                // missing field read as false would be "the push failed".
                archiveOk = if (o.has("archiveOk") && !o.isNull("archiveOk")) o.optBoolean("archiveOk") else null,
                archiveText = o.optString("archiveText").takeIf { it.isNotBlank() && it != "null" },
            )
        }
    }

    private fun parseRunnerRepoSetting(json: JSONObject): RunnerRepoSetting {
        /** `has` first: optBoolean turns a missing or null field into false,
         * and "nobody could tell" is not "no". */
        fun maybe(o: JSONObject, key: String): Boolean? =
            if (o.has(key) && !o.isNull(key)) o.optBoolean(key) else null
        fun words(o: JSONObject, key: String): List<String> =
            o.optJSONArray(key)?.let { a -> (0 until a.length()).mapNotNull { i -> a.optString(i).takeIf { it.isNotBlank() } } }
                ?: emptyList()
        fun text(o: JSONObject, key: String): String? = o.optString(key).takeIf { it.isNotBlank() && it != "null" }
        val check = json.optJSONObject("runnerRepo")?.let { c ->
            RunnerRepoCheck(
                repo = c.optString("repo"),
                isPublic = maybe(c, "public"),
                installed = maybe(c, "installed"),
                actionsWrite = maybe(c, "actionsWrite"),
                platforms = words(c, "platforms"),
                missing = words(c, "missing"),
                ok = c.optBoolean("ok", false),
                message = c.optString("message"),
            )
        }
        return RunnerRepoSetting(
            ok = maybe(json, "ok"),
            repo = text(json, "repo"),
            fleet = text(json, "fleet"),
            text = text(json, "text"),
            runnerRepo = check,
        )
    }

    private fun post(path: String, body: JSONObject, authenticated: Boolean = true): JSONObject =
        send("POST", path, body, authenticated)

    private fun get(path: String): JSONObject = send("GET", path, null)

    /**
     * Somewhere cleartext cannot escape to: the device, or the emulator's route
     * to the machine hosting it.
     *
     * A TAILNET ADDRESS IS NOT ON THIS LIST, deliberately. WireGuard encrypts
     * it, which is a good argument at the wrong layer — the app cannot tell a
     * tailnet IP from anything else in that range, and Tailscale issues real
     * HTTPS certificates for ts.net names anyway. `tailscale cert` serves that
     * workflow; an exception here would serve every other plain-http address
     * too.
     */
    private fun isLocal(host: String?): Boolean = when (host?.lowercase()) {
        "localhost", "127.0.0.1", "::1", "[::1]", "10.0.2.2" -> true
        else -> false
    }

    private fun send(
        method: String,
        path: String,
        body: JSONObject?,
        authenticated: Boolean = true,
    ): JSONObject {
        val base = settings.coordinatorUrl.trimEnd('/')
        val url = URL("$base$path")
        // NOT OVER CLEARTEXT — see res/xml/network_security_config.xml, which
        // enforces the same rule one layer down. Both exist because they fail
        // differently: the platform refuses the socket with a stack trace, and
        // this refuses the request with a sentence somebody can act on.
        if (!url.protocol.equals("https", ignoreCase = true) && !isLocal(url.host)) {
            throw IllegalStateException(
                "Refusing to send your credential over plain http. Use https:// for ${url.host}.",
            )
        }
        val connection = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            doOutput = body != null
            // Long, because a `start` waits out the Remote Control check on the
            // host — up to about twenty seconds — and a short timeout here
            // reports a working fleet as unreachable.
            connectTimeout = 15_000
            readTimeout = 120_000
            setRequestProperty("content-type", "application/json")
            if (authenticated && settings.credential.isNotBlank()) {
                setRequestProperty("authorization", "Bearer ${settings.credential}")
                // AN ADMIN SEEING THE FLEET AS A MEMBER: the coordinator answers
                // this as a member's request, so every list and refusal is the
                // one a member gets, not an imitation of it drawn here.
                if (settings.viewAsMember) setRequestProperty("x-fleetwright-view", "member")
            }
        }
        if (body != null) connection.outputStream.use { it.write(body.toString().toByteArray()) }
        val status = connection.responseCode
        val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
            ?.bufferedReader()?.use { it.readText() } ?: ""
        if (status == 401) {
            // A credential is revoked by somebody deliberately removing this
            // device. Clearing it here is what turns "every request fails" into
            // "sign in again", which is the actual remedy.
            if (authenticated && settings.credential.isNotBlank()) {
                settings.credential = ""
                settings.signedInAs = ""
                throw IllegalStateException("This device is no longer allowed in. Sign in again.")
            }
            throw IllegalStateException(
                runCatching { JSONObject(text).optString("text") }.getOrNull()?.ifBlank { null }
                    ?: "The coordinator refused that.",
            )
        }
        return runCatching { JSONObject(text) }
            .getOrElse { throw IllegalStateException("Unexpected reply from the coordinator (HTTP $status)") }
    }
}

private const val SETTINGS_PREFS = "fleetwright-settings"
private const val LEGACY_SETTINGS_PREFS = "agent-fleet"

/**
 * The settings file, carried over from its name before the rename the first
 * time it is opened. Every type SharedPreferences can hold is copied; the old
 * file is cleared only after the copy has been committed, so a crash between
 * the two leaves the settings in both places rather than in neither.
 */
private fun migrated(context: Context): android.content.SharedPreferences {
    val prefs = context.getSharedPreferences(SETTINGS_PREFS, Context.MODE_PRIVATE)
    val legacy = context.getSharedPreferences(LEGACY_SETTINGS_PREFS, Context.MODE_PRIVATE)
    if (prefs.all.isNotEmpty() || legacy.all.isEmpty()) return prefs
    val edit = prefs.edit()
    for ((key, value) in legacy.all) {
        when (value) {
            is String -> edit.putString(key, value)
            is Boolean -> edit.putBoolean(key, value)
            is Int -> edit.putInt(key, value)
            is Long -> edit.putLong(key, value)
            is Float -> edit.putFloat(key, value)
            is Set<*> -> edit.putStringSet(key, value.filterIsInstance<String>().toSet())
        }
    }
    if (edit.commit()) legacy.edit().clear().apply()
    return prefs
}

/**
 * Where the coordinator is and how to authenticate to it.
 *
 * §5 is explicit that a credential must never be baked into an app binary — it
 * is public the moment somebody pulls the APK — so this is entered once and
 * kept on the device.
 */
class Settings(context: Context) {
    // The file name, NOT a label. Renaming it orphans the settings on every
    // phone that already has the app — a stored URL and credential silently
    // gone, on the one screen where losing input costs the most. So when it
    // WAS renamed (it was "agent-fleet" before the project was Fleetwright
    // everywhere), the old file is copied across once, the first time this
    // runs, and only then emptied. Not "fleetwright": SessionKind already has
    // that file, and two owners of one file is how a key gets overwritten.
    private val prefs = migrated(context)

    /** Not sensitive: an origin, and the app talks to no other. */
    /**
     * Normalised on BOTH sides of the store: on write so nothing malformed is
     * ever persisted, and on read so a value written by an older build — which
     * predates the tidying — cannot reach an HTTP client unrepaired.
     */
    var coordinatorUrl: String
        get() = CoordinatorUrl.normalise(prefs.getString("coordinatorUrl", "") ?: "")
        set(value) = prefs.edit().putString("coordinatorUrl", CoordinatorUrl.normalise(value)).apply()

    /**
     * Where this app was pointed before somebody tapped into the demo, so that
     * leaving puts them back rather than making them re-type a URL to undo a tap.
     */
    var urlBeforeDemo: String
        get() = prefs.getString("urlBeforeDemo", "") ?: ""
        set(value) = prefs.edit().putString("urlBeforeDemo", value.trim()).apply()

    /**
     * This device's own credential, encrypted with a key held in the Android
     * Keystore that never leaves it.
     *
     * The same reasoning as the iOS keychain: this credential can start and
     * stop sessions on every machine in the fleet. MODE_PRIVATE keeps other
     * apps out on a healthy device, but the file is plain text on disk —
     * readable with root, in some backup configurations, and by anything that
     * gets at the data directory. The ciphertext is still kept in
     * SharedPreferences; only the key is special, and it is not extractable.
     *
     * NOTHING IS CARRIED OVER from the build that asked for an admin token.
     * That token was the fleet's break-glass credential and every phone had the
     * same one; silently promoting it to this device's credential would
     * preserve exactly what this replaces. It is deleted, and the app asks the
     * person to sign in.
     */
    var credential: String
        get() = prefs.getString("credential.enc", null)?.let { decrypt(it) } ?: ""
        set(value) {
            val trimmed = value.trim()
            prefs.edit().apply {
                if (trimmed.isEmpty()) remove("credential.enc") else putString("credential.enc", encrypt(trimmed))
                // Swept on every write, so an upgrade removes the old one the
                // first time anybody signs in.
                remove("apiToken")
                remove("apiToken.enc")
            }.apply()
        }

    /**
     * This phone's own GitHub sign-in (PhoneGitHub), encrypted under the same
     * Keystore key as the fleet credential: a token that starts your runners.
     */
    var githubSignIn: String
        get() = prefs.getString("githubSignIn.enc", null)?.let { decrypt(it) } ?: ""
        set(value) {
            prefs.edit().apply {
                if (value.isBlank()) remove("githubSignIn.enc") else putString("githubSignIn.enc", encrypt(value))
            }.apply()
        }

    /**
     * The minting Worker's public key, as whoever runs the fleet gave it to
     * you. Not a secret: it is what this phone checks before sealing anything.
     */
    var minterPin: String
        get() = prefs.getString("minterPin", "") ?: ""
        set(value) = prefs.edit().putString("minterPin", value.trim()).apply()

    /**
     * An admin looking at the fleet as a member would, sent with every request
     * (see `send`). Kept across launches, and said on the session list, so an
     * admin cannot forget they are in it. Cleared with the credential.
     */
    var viewAsMember: Boolean
        get() = prefs.getBoolean("viewAsMember", false)
        set(value) = prefs.edit().putBoolean("viewAsMember", value).apply()

    /**
     * "Not now" on the Claude setup card on Sessions, remembered on this phone:
     * a card that cannot be put away is a card people learn not to read.
     */
    var claudeSetupPutOff: Boolean
        get() = prefs.getBoolean("claudeSetupPutOff", false)
        set(value) = prefs.edit().putBoolean("claudeSetupPutOff", value).apply()

    /**
     * A secret kept by name, encrypted under the same Keystore key as the
     * fleet credential: a hypervisor's token, and the key it comes back to
     * (XoHandoff). An empty value removes it.
     */
    fun putSecret(name: String, value: String) {
        prefs.edit().apply {
            if (value.isEmpty()) remove("secret.$name.enc") else putString("secret.$name.enc", encrypt(value))
        }.apply()
    }

    fun secret(name: String): String? = prefs.getString("secret.$name.enc", null)?.let { decrypt(it) }

    /**
     * The Xen Orchestra addresses this phone keeps a token for, as XoHandoff
     * writes them: a JSON array of strings. Not a secret: the token is kept
     * apart, encrypted, and this is the list Machines shows them from.
     */
    var xoHeld: String
        get() = prefs.getString("xoHeld", "") ?: ""
        set(value) = prefs.edit().apply { if (value.isEmpty()) remove("xoHeld") else putString("xoHeld", value) }.apply()

    /** The hypervisor setups still owed a token, as XoHandoff writes them. Not a secret. */
    var xoPending: String
        get() = prefs.getString("xoPending", "") ?: ""
        set(value) = prefs.edit().apply { if (value.isEmpty()) remove("xoPending") else putString("xoPending", value) }.apply()

    /**
     * The machine that last got through to each Xen Orchestra address, as
     * XoSaved writes it: a JSON object of address to host. Not a secret.
     */
    var xoVia: String
        get() = prefs.getString("xoVia", "") ?: ""
        set(value) = prefs.edit().apply { if (value.isEmpty()) remove("xoVia") else putString("xoVia", value) }.apply()

    /**
     * When this phone last looked at each pool it manages directly, as Manage
     * writes it: a JSON object of address to epoch milliseconds. Not a secret;
     * it is what the screen says in place of a picture nobody is watching.
     */
    var xoLooked: String
        get() = prefs.getString("xoLooked", "") ?: ""
        set(value) = prefs.edit().apply { if (value.isEmpty()) remove("xoLooked") else putString("xoLooked", value) }.apply()

    /**
     * A Xen Orchestra sign-in the person chose to keep, as XoSaved sealed it
     * under its own fingerprint-bound key: ciphertext here, and nothing this
     * class can open. An empty value removes it.
     */
    fun xoSaved(address: String): String? = prefs.getString("xoSaved.$address", null)

    fun putXoSaved(address: String, sealed: String) {
        prefs.edit().apply { if (sealed.isEmpty()) remove("xoSaved.$address") else putString("xoSaved.$address", sealed) }.apply()
    }

    /** Who this device is signed in as. Not a secret — it is displayed. */
    var signedInAs: String
        get() = prefs.getString("signedInAs", "") ?: ""
        set(value) = prefs.edit().putString("signedInAs", value).apply()

    /**
     * Reachable AND allowed in. Both matter: a URL with no credential gets a
     * 401 on every call, which reads as a broken fleet rather than as a phone
     * that has not signed in.
     */
    val configured: Boolean get() = coordinatorUrl.isNotBlank() && credential.isNotBlank()
    val hasCoordinator: Boolean get() = coordinatorUrl.isNotBlank()

    // --- AES-GCM with a non-extractable Keystore key -------------------------
    //
    // No dependency, in keeping with the rest of this app. androidx.security's
    // EncryptedSharedPreferences would do the same job, but it has sat in alpha
    // for years and is a large surface for one string.

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                // Deliberately NOT setUserAuthenticationRequired: a push
                // notification has to be actionable on a locked phone, which is
                // the entire point of the app.
                .build(),
        )
        return generator.generateKey()
    }

    /** iv:ciphertext, both base64. The IV is not a secret and must not repeat. */
    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val bytes = cipher.doFinal(value.toByteArray())
        return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
            Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String? = runCatching {
        val (iv, body) = stored.split(":", limit = 2)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            key(),
            GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)),
        )
        String(cipher.doFinal(Base64.decode(body, Base64.NO_WRAP)))
    }.getOrNull() // A key lost to a backup restore or a reinstall means re-entering the token, not a crash.

    private companion object {
        const val KEY_ALIAS = "fleetwright.credential"
    }
}

/**
 * What the host said, with the terminal's padding off — or [nothing] when it
 * said nothing at all.
 *
 * The host stopped sending a pane of empty rows in its own change. This is
 * here because a phone in somebody's pocket talks to whatever host that fleet
 * is running, which is not always the newest one, and because trimming alone
 * would leave the opposite problem: a button that does nothing visible when it
 * is pressed. iOS spells the same rule `String.isBlank` and a `nothingSaid`
 * argument; Kotlin already has `ifEmpty`, so this is the whole of it.
 */
fun String.said(nothing: String = ""): String = trim().ifEmpty { nothing }

/** Where this person's machines come from, in one sentence. The same words
 * on both phones; test/runner-repo-in-apps.test.js holds them together. */
fun describeRunnerRepoSetting(saved: String?, fleet: String?): String = when {
    saved != null -> "Your machines come from $saved."
    fleet != null -> "Your machines come from the fleet's repository, $fleet. Set your own to use your free Actions minutes."
    else -> "Make a public repository from github.com/TheTechNetwork/Fleetwright-Runners-Template, install the Fleetwright GitHub App on it, and your machines come from there."
}

/** What a runner repository check found, one answer per fact. "can't tell"
 * is kept apart from "no" (C-5): a personal GitHub token cannot see whether
 * the app is installed, and that is not the same as it not being installed. */
fun describeRunnerCheck(check: Fleet.RunnerRepoCheck): String {
    fun word(value: Boolean?): String = when (value) {
        true -> "yes"
        false -> "no"
        null -> "can't tell"
    }
    val machines = if (check.platforms.isEmpty()) "none" else check.platforms.joinToString(", ")
    return "Public: ${word(check.isPublic)} · GitHub app: ${word(check.installed)} · " +
        "Actions write: ${word(check.actionsWrite)} · Machines: $machines"
}

/**
 * "5h 42% · resets in 2h · 7d 12%", or the reason there is no number.
 *
 * EVERY FIGURE IS THE ENDPOINT'S. The percentages are what the account's own
 * usage endpoint said, the reset is its timestamp with the phone doing the
 * arithmetic, and a report with no answer says so in the host's words rather
 * than drawing 0% — which would be the one reading worse than nothing. Drawn
 * under "connected as you@…" on the credentials sheet: an account's fact, on
 * the account's row, once. Same words as iOS, held equal by
 * test/context-and-usage-in-apps.test.js.
 */
fun describeUsage(report: Fleet.UsageReport, now: Long = System.currentTimeMillis()): String {
    val windows = report.windows ?: return buildString {
        append("usage not reported")
        report.why?.takeIf { it.isNotBlank() }?.let { append(" — ").append(it) }
    }
    val parts = mutableListOf<String>()
    windows.fiveHour?.let { w ->
        w.used?.let { used ->
            parts.add("5h ${Math.round(used)}%")
            w.resetsAt?.takeIf { it > 0 }?.let { parts.add("resets in ${describeUntil(it, now)}") }
        }
    }
    windows.sevenDay?.used?.let { parts.add("7d ${Math.round(it)}%") }
    windows.sevenDayOpus?.used?.let { parts.add("Opus 7d ${Math.round(it)}%") }
    windows.sevenDaySonnet?.used?.let { parts.add("Sonnet 7d ${Math.round(it)}%") }
    if (parts.isEmpty()) return "usage not reported"
    return parts.joinToString(" · ")
}

/**
 * "now" / "9m" / "2h" / "3d" until an epoch-millisecond instant. Coarse: the
 * question is whether to wait, not when to set an alarm.
 */
fun describeUntil(epochMs: Long, now: Long = System.currentTimeMillis()): String {
    val seconds = (epochMs - now) / 1000
    return when {
        seconds <= 0 -> "now"
        seconds < 3600 -> "${maxOf(1, seconds / 60)}m"
        seconds < 86_400 -> "${seconds / 3600}h"
        else -> "${seconds / 86_400}d"
    }
}
