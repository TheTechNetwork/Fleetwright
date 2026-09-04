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
    ) {
        /** What to show. The name is the identity; the title is for people. */
        val label: String get() = title?.takeIf { it.isNotBlank() } ?: name

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
            if (!isRunning || prompt != null) return null
            val since = idleSince?.takeIf { it > 0 } ?: return null
            val seconds = (System.currentTimeMillis() - since) / 1000
            if (seconds < 300) return null
            val howLong = when {
                seconds < 3600 -> "${seconds / 60}m"
                seconds < 86_400 -> "${seconds / 3600}h"
                else -> "${seconds / 86_400}d"
            }
            // TWO SENTENCES, BECAUSE THEY ARE TWO SITUATIONS. A session at its
            // own prompt finished, or is between things, and needs nothing —
            // saying "quiet" about it invites a person to worry at the most
            // common state in the fleet. A pane stopped mid-work with no
            // prompt on it is the one worth a second look.
            return if (atRest) "ready · idle $howLong" else "quiet for $howLong"
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
        val accountEmail: String?,
        val accountPlan: String?,
        val accountOrg: String?,
        val version: String?,
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
    ) {
        /** Two separate answers, because they are two actions on two things. */
        val appPending: Boolean get() = (behind ?: 0) > 0 || release?.available != null
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

    data class Reply(
        val ok: Boolean,
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
        },
        // A placement PREFERENCE, beside the intent and never inside it —
        // `start` declares no host parameter, and a host receiving one would
        // refuse the whole intent. The coordinator refuses a bad pick by name.
        host = host,
    )

    suspend fun stop(name: String): Reply = intent("stop", mapOf("name" to name))

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
     * in `/etc/agent-hub.env`, which meant a shell on the box — the one thing
     * somebody holding only a phone does not have.
     */
    suspend fun channel(host: String, to: String? = null): Reply =
        intent("channel", buildMap { if (!to.isNullOrBlank()) put("to", to) }, host = host)

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
    suspend fun connections(host: String): Reply = intent("connect", emptyMap(), host = host)

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
    ): String = withContext(Dispatchers.IO) {
        val body = JSONObject().put("kind", "host").put("ephemeral", ephemeral)
        // OMITTED WHEN ABSENT rather than sent as null: a null hostId binds the
        // pin to nothing and reads, on the wire, as somebody having meant to.
        if (!hostId.isNullOrBlank()) body.put("hostId", hostId).put("readmit", readmit)
        val json = post("/api/enroll", body)
        json.optString("code").ifBlank {
            throw IllegalStateException(json.optString("text").ifBlank { "Could not mint a pin." })
        }
    }

    /** Remove a machine from the fleet. It is disconnected as well as revoked. */
    suspend fun revokeHost(hostId: String): Reply = withContext(Dispatchers.IO) {
        runCatching {
            val json = send("DELETE", "/api/hosts/" + hostId, null)
            Reply(json.optBoolean("ok", false), json.optString("text"), emptyList())
        }.getOrElse { Reply(false, it.message ?: "could not reach the coordinator", emptyList()) }
    }

    data class Host(val hostId: String, val fingerprint: String, val revoked: Boolean)

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
            try {
                val json = post("/api/intent", body)
                Reply(
                    ok = json.optBoolean("ok", false),
                    text = json.optString("text", ""),
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
                        )
                    },
                )
            } catch (e: Exception) {
                // HELD, NOT LOST — but only when the fleet could not be
                // REACHED. A refusal is an answer, and replaying an answer is
                // how somebody's revoked credential retries all night. See
                // isDeliveryFailure.
                val entry =
                    if (idempotencyKey == null && isDeliveryFailure(e)) outbox?.hold(verb, params, host) else null
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
                    accountEmail = account?.optString("email")?.takeIf { it.isNotBlank() && it != "null" },
                    accountPlan = account?.optString("plan")?.takeIf { it.isNotBlank() && it != "null" },
                    accountOrg = account?.optString("org")?.takeIf { it.isNotBlank() && it != "null" },
                    version = health?.optJSONObject("version")?.optString("head")?.takeIf { it.isNotBlank() },
                    behind = updates?.optInt("appBehind", -1)?.takeIf { it >= 0 },
                    systemUpdates = updates?.optString("system")?.takeIf { it.isNotBlank() && it != "null" },
                    rebootRequired = updates?.optBoolean("rebootRequired") == true,
                    release = updates?.optJSONObject("release")?.let { r ->
                        Release(
                            available = r.optString("available").takeIf { it.isNotBlank() && it != "null" },
                            configured = r.optBoolean("configured"),
                            message = r.optString("message").takeIf { it.isNotBlank() && it != "null" },
                        )
                    },
                    channel = health?.optString("channel")?.takeIf { it.isNotBlank() && it != "null" },
                    channelPinned = health?.optBoolean("channelPinned") == true,
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
                    )
                }
            },
        )
    }

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
            )
        }
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

/**
 * Where the coordinator is and how to authenticate to it.
 *
 * §5 is explicit that a credential must never be baked into an app binary — it
 * is public the moment somebody pulls the APK — so this is entered once and
 * kept on the device.
 */
class Settings(context: Context) {
    // The file name, NOT a label. Renaming it would orphan the settings on
    // every phone that already has the app — a stored URL and credential
    // silently gone, on the one screen where losing input costs the most.
    private val prefs = context.getSharedPreferences("agent-fleet", Context.MODE_PRIVATE)

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
