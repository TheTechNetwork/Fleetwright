package network.thetech.fleetwright

/**
 * The row's word for a code the fleet sends beside its sentence.
 *
 * THE FLEET KEEPS SENDING ITS SENTENCE (`reason`, `text`), because terminals
 * print it and an older phone shows it. Beside it, where the sentence used to
 * be all there was, it now sends a short code, and this is the table that
 * turns the code into the one to three words a row gets
 * (docs/design-system.md, "Words"): the verdict on the row, the sentence on
 * the page under Details. A code this build has never met, or none at all
 * from an older coordinator, falls back to the sentence, so nothing is lost
 * and nothing is made up (C-5).
 *
 * THE SAME WORDS ON BOTH PHONES, by name and by value: iOS's `ReasonWords`
 * holds the same four tables, and test/reasons-in-apps.test.js reads both and
 * fails a row that differs. The same test reads the coordinator for every
 * code it can send, so a new code there without a word here is a failing
 * test, not a sentence on a row.
 */
object ReasonWords {
    /**
     * `reasonCode` beside `host.reason` on the fleet snapshot (registry.js).
     * `ok` is not here: a healthy machine's row says nothing extra.
     */
    val HOST: Map<String, String> = mapOf(
        "no_login" to "No Claude login",
        "runner_no_login" to "No Claude login",
        "pool_no_login" to "No Claude login",
        "login_expired" to "Login expired",
        "hub_unreachable" to "Not answering",
        "fetching_login" to "Getting login…",
        "never_reported" to "No report yet",
        "protocol_behind" to "Needs an update",
        "protocol_ahead" to "Newer than your fleet",
        "silent" to "Not reporting",
        "dropped" to "Dropped",
        "connecting" to "Connecting…",
    )

    /**
     * The title over a refusal, by `error.code`, and for `host_unavailable`
     * by `error.why` as well (`host_unavailable:offline`). A code with no
     * `why` is looked up bare; the two `unsandboxed` and `host_outdated`
     * words are the start's own (Fleet.Reply.refusedStartTitle).
     */
    val REFUSAL: Map<String, String> = mapOf(
        "no_hosts" to "No machine available",
        "host_unavailable:offline" to "Machine offline",
        "host_unavailable:not_yours" to "Not your machine",
        "host_unavailable:enrolled_by_other" to "Someone else's machine",
        "host_unavailable:pools_own" to "A pool's own machine",
        "host_unavailable:temporary_other" to "Someone else's temporary machine",
        "host_unavailable:no_credentials" to "No credentials for you",
        "host_unavailable" to "Machine unavailable",
        "host_unreachable" to "Machine offline",
        "host_busy" to "Machine busy",
        "at_capacity" to "Machine full",
        "stale_placement" to "Out of date. Ask again",
        "name_unavailable" to "Name in use",
        "ambiguous_host" to "Which machine?",
        "no_host_matches" to "No machine with those tags",
        "unsandboxed" to "Not started: only admins run sessions there",
        "signature_required" to "Needs a signed request",
        "no_minter" to "No vault set up",
        "minter_unreachable" to "Vault not answering",
        "too_many" to "Too many changes",
        "host_outdated" to "Machine needs an update",
        "relay_plain" to "Needs HTTPS",
        "lab_taken" to "Lab in use",
        "unreachable" to "Couldn't reach it",
        "not_found" to "Not found",
        "bad_params" to "Request refused",
        "unknown_verb" to "Request refused",
        "stale" to "Request refused",
        "bad_envelope" to "Request refused",
    )

    /** Any other code, and no code at all. */
    const val REFUSED = "Refused"

    /** `failed.code` on a machine kept ready that did not come (vm-standby.js). */
    val STANDBY: Map<String, String> = mapOf(
        "not_joined" to "Didn't join",
        "refused" to "Refused",
        "unreachable" to "Couldn't reach",
    )

    /**
     * A label per `event` kind the fleet records (core.js `record({`). An
     * `intent` is labelled with its verb after this word; a kind this build
     * has never met is shown as the kind itself.
     */
    val ACTIVITY: Map<String, String> = mapOf(
        "intent" to "Asked for",
        "browse.opened" to "Page through a machine",
        "claude.ended" to "Claude login ended",
        "claude.refused" to "Claude login refused",
        "claude.deposited" to "Claude token saved",
        "claude.forgotten" to "Claude token forgotten",
        "claude.deposit-refused" to "Claude token refused",
        "client.admin" to "First admin",
        "client.revoked" to "Device revoked",
        "client.withdrawn" to "Device withdrawn",
        "clients.full" to "Device limit reached",
        "console.away" to "Console from away",
        "delegation.dropped" to "Delegation withdrawn",
        "delegation.kept" to "Delegation kept",
        "device.plaintext" to "Unencrypted notifications",
        "devices.full" to "Phone limit reached",
        "enrol.cancelled" to "Pairing cancelled",
        "holder.approved" to "Pool machine joined",
        "holder.asked" to "Pool machine asking",
        "holder.declined" to "Pool machine declined",
        "holder.pin" to "Pool machine pinned",
        "host.asked-back" to "Asked to forget",
        "host.demoted" to "Machine demoted",
        "host.dropped" to "Connection dropped",
        "host.enrolled" to "Machine enrolled",
        "host.refused" to "Machine refused",
        "host.retired" to "Machine retired",
        "host.returned" to "Machine back",
        "host.revoked" to "Machine revoked",
        "linked.repo" to "Repository linked",
        "relay.opened" to "Relay opened",
        "runner.claude" to "Runner Claude login",
        "runner.claude-refused" to "Runner login refused",
        "runner.large" to "Larger machines",
        "runner.repo" to "Runner repository",
        "runner.requested" to "Runner requested",
        "runner.start-failed" to "Session not started",
        "runner.started" to "Runner started",
        "runner.token" to "Runner token",
        "runner.token-refused" to "Runner token refused",
        "test" to "Test notification",
        "vault.changed" to "Vault changed",
        "vault.refused" to "Vault change refused",
        "vm.claude" to "Machine Claude login",
        "vm.claude-refused" to "Machine login refused",
        "vm.control" to "Machine control",
        "vm.requested" to "Machine requested",
        "vm.standby" to "Machines kept ready",
        "vm.taken" to "Ready machine taken",
        "vm.ticket-reused" to "Ticket reused",
        "xo.act" to "Hypervisor action",
        "xo.pool-back" to "Pool back",
        "xo.pool-lost" to "Pool lost",
    )

    /**
     * The row's word for a machine's `reasonCode`, or null for `ok`, for a
     * code never met and for none: then the row shows the sentence.
     */
    fun host(code: String?): String? = code?.let { HOST[it] }

    /** The title over a refusal. */
    fun refusal(code: String?, why: String?): String {
        if (code == null) return REFUSED
        if (why != null) REFUSAL["$code:$why"]?.let { return it }
        return REFUSAL[code] ?: REFUSED
    }

    /** The word for why a ready machine did not come, or null to show its sentence. */
    fun standby(code: String?): String? = code?.let { STANDBY[it] }

    /**
     * The label for an event: "Asked for start" for an intent, the kind's
     * label, or the kind itself when this build has no word for it.
     */
    fun activity(event: String, verb: String? = null): String {
        val label = ACTIVITY[event] ?: return event
        return if (event == "intent" && !verb.isNullOrBlank()) "$label $verb" else label
    }
}
