import Foundation

/// The row's word for a code the fleet sends beside its sentence.
///
/// THE FLEET KEEPS SENDING ITS SENTENCE (`reason`, `text`), because terminals
/// print it and an older phone shows it. Beside it, where the sentence used to
/// be all there was, it now sends a short code, and this is the table that
/// turns the code into the one to three words a row gets
/// (docs/design-system.md, "Words"): the verdict on the row, the sentence on
/// the page under Details. A code this build has never met, or none at all
/// from an older coordinator, falls back to the sentence, so nothing is lost
/// and nothing is made up (C-5).
///
/// THE SAME WORDS ON BOTH PHONES, by name and by value: Android's
/// `ReasonWords` holds the same four tables, and test/reasons-in-apps.test.js
/// reads both and fails a row that differs. The same test reads the
/// coordinator for every code it can send, so a new code there without a
/// word here is a failing test, not a sentence on a row.
enum ReasonWords {
    /// `reasonCode` beside `host.reason` on the fleet snapshot (registry.js).
    /// `ok` is not here: a healthy machine's row says nothing extra.
    static let host: [String: String] = [
        "no_login": "No Claude login",
        "runner_no_login": "No Claude login",
        "pool_no_login": "No Claude login",
        "login_expired": "Login expired",
        "hub_unreachable": "Not answering",
        "fetching_login": "Getting login…",
        "never_reported": "No report yet",
        "silent": "Not reporting",
        "dropped": "Dropped",
        "connecting": "Connecting…",
    ]

    /// The title over a refusal, by `error.code`, and for `host_unavailable`
    /// by `error.why` as well (`host_unavailable:offline`). A code with no
    /// `why` is looked up bare; the two `unsandboxed` and `host_outdated`
    /// words are the start's own (Fleet.Reply.refusedStartTitle).
    static let refusal: [String: String] = [
        "no_hosts": "No machine available",
        "host_unavailable:offline": "Machine offline",
        "host_unavailable:not_yours": "Not your machine",
        "host_unavailable:enrolled_by_other": "Someone else's machine",
        "host_unavailable:pools_own": "A pool's own machine",
        "host_unavailable:temporary_other": "Someone else's temporary machine",
        "host_unavailable:no_credentials": "No credentials for you",
        "host_unavailable": "Machine unavailable",
        "host_unreachable": "Machine offline",
        "host_busy": "Machine busy",
        "at_capacity": "Machine full",
        "stale_placement": "Out of date. Ask again",
        "name_unavailable": "Name in use",
        "ambiguous_host": "Which machine?",
        "no_host_matches": "No machine with those tags",
        "unsandboxed": "Not started: only admins run sessions there",
        "signature_required": "Needs a signed request",
        "no_minter": "No vault set up",
        "minter_unreachable": "Vault not answering",
        "too_many": "Too many changes",
        "host_outdated": "Machine needs an update",
        "relay_plain": "Needs HTTPS",
        "lab_taken": "Lab in use",
        "unreachable": "Couldn't reach it",
        "not_found": "Not found",
        "bad_params": "Request refused",
        "unknown_verb": "Request refused",
        "stale": "Request refused",
        "bad_envelope": "Request refused",
    ]

    /// Any other code, and no code at all.
    static let refused = "Refused"

    /// `failed.code` on a machine kept ready that did not come (vm-standby.js).
    static let standby: [String: String] = [
        "not_joined": "Didn't join",
        "refused": "Refused",
        "unreachable": "Couldn't reach",
    ]

    /// A label per `event` kind the fleet records (core.js `record({`). An
    /// `intent` is labelled with its verb after this word; a kind this build
    /// has never met is shown as the kind itself.
    static let activity: [String: String] = [
        "intent": "Asked for",
        "claude.ended": "Claude login ended",
        "claude.refused": "Claude login refused",
        "claude.deposited": "Claude token saved",
        "claude.forgotten": "Claude token forgotten",
        "claude.deposit-refused": "Claude token refused",
        "client.admin": "First admin",
        "client.revoked": "Device revoked",
        "client.withdrawn": "Device withdrawn",
        "clients.full": "Device limit reached",
        "console.away": "Console from away",
        "delegation.dropped": "Delegation withdrawn",
        "delegation.kept": "Delegation kept",
        "device.plaintext": "Unencrypted notifications",
        "devices.full": "Phone limit reached",
        "enrol.cancelled": "Pairing cancelled",
        "holder.approved": "Pool machine joined",
        "holder.asked": "Pool machine asking",
        "holder.declined": "Pool machine declined",
        "holder.pin": "Pool machine pinned",
        "host.asked-back": "Asked to forget",
        "host.demoted": "Machine demoted",
        "host.dropped": "Connection dropped",
        "host.enrolled": "Machine enrolled",
        "host.refused": "Machine refused",
        "host.retired": "Machine retired",
        "host.returned": "Machine back",
        "host.revoked": "Machine revoked",
        "linked.repo": "Repository linked",
        "relay.opened": "Relay opened",
        "runner.claude": "Runner Claude login",
        "runner.claude-refused": "Runner login refused",
        "runner.large": "Larger machines",
        "runner.repo": "Runner repository",
        "runner.requested": "Runner requested",
        "runner.start-failed": "Session not started",
        "runner.started": "Runner started",
        "runner.token": "Runner token",
        "runner.token-refused": "Runner token refused",
        "test": "Test notification",
        "vault.changed": "Vault changed",
        "vault.refused": "Vault change refused",
        "vm.claude": "Machine Claude login",
        "vm.claude-refused": "Machine login refused",
        "vm.control": "Machine control",
        "vm.requested": "Machine requested",
        "vm.standby": "Machines kept ready",
        "vm.taken": "Ready machine taken",
        "vm.ticket-reused": "Ticket reused",
        "xo.act": "Hypervisor action",
        "xo.pool-back": "Pool back",
        "xo.pool-lost": "Pool lost",
    ]

    /// The row's word for a machine's `reasonCode`, or nil for `ok`, for a
    /// code never met and for none: then the row shows the sentence.
    static func host(_ code: String?) -> String? {
        guard let code else { return nil }
        return host[code]
    }

    /// The title over a refusal.
    static func refusal(code: String?, why: String?) -> String {
        guard let code else { return refused }
        if let why, let word = refusal["\(code):\(why)"] { return word }
        return refusal[code] ?? refused
    }

    /// The word for why a ready machine did not come, or nil to show its sentence.
    static func standby(_ code: String?) -> String? {
        guard let code else { return nil }
        return standby[code]
    }

    /// The label for an event: "Asked for start" for an intent, the kind's
    /// label, or the kind itself when this build has no word for it.
    static func activity(_ event: String, verb: String? = nil) -> String {
        guard let label = activity[event] else { return event }
        if event == "intent", let verb, !verb.isEmpty { return "\(label) \(verb)" }
        return label
    }
}
