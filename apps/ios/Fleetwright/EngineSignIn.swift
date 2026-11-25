import SwiftUI
import UIKit

/// Signing an engine in on the machine it runs on, from this phone
/// (docs/engines.md, "Signing in on the machine"). EngineSignIn.kt is the
/// same thing on Android, in the same words, and
/// test/engines-in-apps.test.js holds the two to each other.
///
/// WHAT HAPPENS. A custodian asks one machine to sign Codex, or OpenCode on
/// GitHub Copilot, in for a member. The engine there makes a short code,
/// the person enters it at OpenAI or GitHub in any browser, and the engine
/// keeps its sign-in on that machine. Nothing is pasted and nothing secret
/// crosses the fleet.
///
/// THE CODE IS SHOWN ONLY AFTER THREE CHECKS, IN ORDER, and so is who is
/// signed in. The answer comes through the fleet, so it is sealed to a key
/// this phone made for that one request, and the fleet carries what it
/// cannot read. Sealing says nothing about who wrote it, because the key it
/// is sealed to is public. What only the machine can do is sign the answer
/// with the key a custodian approved for this member's credentials. So:
/// open it, hold its key to the member's approved machines, check the
/// signature over this phone's own request, and only then read anything
/// out. `EngineSignin.verified` is those steps and the only way to the
/// code, its page or the account. When one fails, none of the three is
/// drawn, and the screen says which in one sentence that stays.
///
/// NOTHING HERE IS KEPT. The code and its page live in this view's state
/// and go with it: not held for sending later, not logged, not in a
/// notification. Copy and Open the sign-in page are the two ways out.

/// Who is signed in to an engine on a machine, by that machine's own
/// checked word. `email` and `plan` are nil where the engine names none,
/// which is always so for OpenCode: it keeps a token and no name.
struct EngineSignedIn: Equatable {
    let since: Double
    let email: String?
    let plan: String?
}

/// What a machine said of an engine's sign-in, read out of an answer only
/// after every check passed. `code` and `page` are there together while a
/// code is out, and both nil otherwise.
struct EngineSigninSaid: Equatable {
    let code: String?
    let page: String?
    let signedIn: EngineSignedIn?
}

/// One answer, after the checks: what it said, or which check it failed.
enum EngineSigninCheck: Equatable {
    case verified(EngineSigninSaid)
    /// Nothing sealed came with it, or it did not open with this request's key.
    case unopened
    /// The key it carries is not a machine approved for the whole of this
    /// member's credentials, under the name of the machine that was asked.
    case unapproved
    /// That key did not sign this answer to this request.
    case unsigned
}

/// Where an engine can be signed in for one member, and what to say where
/// it cannot.
struct EngineSigninPlaces: Equatable {
    /// The machines to offer, by name.
    var offered: [String] = []
    /// One sentence for a member with nowhere to sign in, or nothing when
    /// there is nothing certain to say.
    var missing: String = ""
}

/// What the screen shows of one machine. Everything about a code or an
/// account in it came through `EngineSignin.verified`.
struct EngineSigninShown: Equatable {
    var signedIn: EngineSignedIn? = nil
    var code: String? = nil
    var page: String? = nil
    /// How long the code still lasts, as the machine's answer said.
    var minutes: Int? = nil
    /// Where the last attempt stands, or a refusal as it came.
    var says: String = ""
    var bad: Bool = false
    /// An answer about a code that is out failed a check. The code is not
    /// shown, and Cancel still is, so the machine does not go on asking the
    /// provider for the rest of the code's life.
    var cancel: Bool = false
}

/// The sentences, in one place. The same on Android, word for word.
enum EngineSigninWords {
    /// What the block is headed, by engine.
    static func title(_ engine: String) -> String {
        engine == "opencode" ? "OpenCode on GitHub Copilot" : engineName(engine)
    }

    /// Where the code is entered.
    static func provider(_ engine: String) -> String {
        engine == "opencode" ? "GitHub" : "OpenAI"
    }

    static let offer = "Sign in on a machine"
    static let which = "Which machine?"
    static let openPage = "Open the sign-in page"
    static let copy = "Copy code"
    static let copied = "Copied"
    static let cancel = "Cancel"
    static let signOut = "Sign out"
    static let theCode = "the code"
    static let whoIsSignedIn = "who is signed in"

    static func offerOf(_ engine: String) -> String { "Sign \(engine) in on a machine" }
    static func on(_ box: String) -> String { "Sign in on \(box)" }
    static func asking(_ box: String) -> String { "Asking \(box)…" }
    static func codeFor(_ box: String) -> String { "Code to sign in on \(box)" }
    static func cancelOn(_ box: String) -> String { "Cancel the sign-in on \(box)" }
    static func signOutOf(_ engine: String, _ box: String) -> String { "Sign \(engine) out on \(box)" }
    static func signOutAsk(_ engine: String, _ box: String) -> String { "Sign \(engine) out on \(box)?" }

    /// A code read one character at a time, for VoiceOver: "W X Y Z dash 1
    /// 2 3 4". Read as a word, a code is a noise.
    static func spoken(_ code: String) -> String {
        code.map { $0 == "-" ? "dash" : String($0) }.joined(separator: " ")
    }

    /// While a code is out: what is being waited for, and how long the code
    /// still lasts when the machine said.
    static func waiting(_ provider: String, minutes: Int?) -> String {
        guard let minutes, minutes > 0 else { return "Waiting for you to approve it at \(provider)." }
        if minutes == 1 { return "Waiting for you to approve it at \(provider). This code lasts 1 more minute." }
        return "Waiting for you to approve it at \(provider). This code lasts \(minutes) more minutes."
    }

    /// "Signed in on ops-box as debbie@example.com (plus), since 25 Nov
    /// 2026 at 10:02." Without "as" where the engine names no account.
    static func signedIn(_ box: String, _ who: EngineSignedIn) -> String {
        var said = "Signed in on \(box)"
        if let email = who.email, !email.isEmpty {
            said += " as \(email)"
            if let plan = who.plan, !plan.isEmpty { said += " (\(plan))" }
        }
        if let when = taskTime(who.since) { said += ", since \(when)" }
        return said + "."
    }

    /// How an attempt that is over ended, by the machine's word for it. A
    /// state with nothing to say, and one this build has never met, say
    /// nothing: no sentence here claims more than the machine did.
    static func ended(_ state: String, engine: String, box: String, detail: String?) -> String {
        switch state {
        case "expired": return "The code ran out before it was approved. Start again for a new one."
        case "failed":
            guard let detail, !detail.isEmpty else { return "\(engine) did not sign in." }
            return "\(engine) did not sign in: \(detail)"
        case "cancelled": return "Cancelled."
        case "lost": return "\(box) restarted while it was waiting, so that attempt is gone. Start again."
        case "signed_out": return "Signed out on \(box)."
        case "ended": return "\(engine)’s sign-in on \(box) no longer works. Sign it in again."
        default: return ""
        }
    }

    /// Whether that ending is a fault to draw as one.
    static func endedBadly(_ state: String) -> Bool {
        ["expired", "failed", "lost", "ended"].contains(state)
    }

    static func unopened(_ box: String, _ what: String) -> String {
        "\(box)’s answer could not be opened, so \(what) is not shown."
    }

    static func unapproved(_ member: String?, _ what: String) -> String {
        guard let member else { return "This answer did not come from a machine approved for your credentials, so \(what) is not shown." }
        return "This answer did not come from a machine approved for \(member)’s credentials, so \(what) is not shown."
    }

    static func unsigned(_ box: String, _ what: String) -> String {
        "\(box)’s answer could not be checked, so \(what) is not shown."
    }

    static func refused(_ box: String) -> String { "\(box) refused that, and gave no reason." }

    static func noMachine(_ engine: String) -> String {
        "No machine that can take a session now runs \(engine)."
    }

    static func notApproved(_ box: String, _ engine: String, _ member: String?) -> String {
        guard let member else { return "\(box) runs \(engine) and is not approved for your credentials. Approve it from its page, then sign in." }
        return "\(box) runs \(engine) and is not approved for \(member)’s credentials. Approve it below, then sign in."
    }

    static func tooOld(_ box: String, _ engine: String) -> String {
        "\(box) runs \(engine) and is too old to sign it in. Update fleetwright on \(box)."
    }

    /// What signing out costs, said before it is done.
    static func signOutCost(_ member: String?, pasted: Bool) -> String {
        var stops = "Your sessions stop running on it there. Signing in again takes a new code."
        if let member {
            stops = "Sessions started as \(member) stop running on it there. Signing in again takes a new code."
        }
        return pasted ? stops + " A pasted sign-in is still kept, and the next session there runs on that." : stops
    }
}

enum EngineSignin {
    /// The protocol a machine speaks once it can sign an engine in.
    static let protocolNeeded = 22
    /// How often a waiting sign-in is asked after, in nanoseconds.
    static let pollEvery: UInt64 = 4_000_000_000
    /// How long to leave a machine that was approved a moment ago before
    /// asking it once more: it hears of an approval about two seconds on.
    static let approvalSettles: UInt64 = 3_000_000_000

    /// The engine a machine can sign in for one of the vault's two pasted
    /// items, or nil for any other item: `codex` is Codex's own, and
    /// `copilot` is OpenCode's.
    static func engine(ofItem item: String) -> String? {
        switch item {
        case "codex": return "codex"
        case "copilot": return "opencode"
        default: return nil
        }
    }

    /// What one sealed answer says, or which check it failed.
    ///
    /// THE ORDER IS THE WHOLE OF IT, and no step is skipped. Opening comes
    /// first because there is nothing to check until it is open. The key
    /// comes before the signature because a signature that holds under a
    /// key nobody approved proves nothing. Reading anything out comes last.
    ///
    /// - `sealed`: what the answer carried, or nil when it carried none.
    /// - `key`: the key this phone made for that request.
    /// - `grants`: the member's approved machines, from a vault list this
    ///   phone fetched itself, never from the answer or the fleet's listing.
    /// - `host`, `id`, `member`, `engine`: this phone's own request. The
    ///   signature is checked over these and not over what the answer
    ///   claims they were, which is what ties it to this request.
    static func verified(sealed: [String: String]?, key: Seal.OneUseKey, grants: [PhoneVault.Grant],
                         host: String, id: String, member: String, engine: String) -> EngineSigninCheck {
        // 1. OPEN IT, with the key made for this request and under this
        // purpose's own name. No sealed part at all is a failure too:
        // something on the way took it out.
        guard let sealed, let opened = try? Seal.open(key, aad: Seal.engineSigninAAD, sealed: sealed) else { return .unopened }

        // 2. THE KEY IT CARRIES IS A MACHINE APPROVED FOR THIS MEMBER: for
        // the whole of the member's credentials, under the name of the
        // machine that was asked. The key's id is worked out here from the
        // key itself and must be the one the answer names.
        guard let jwk = opened["hostKey"] as? [String: Any],
              let kty = jwk["kty"] as? String, kty == "EC",
              let crv = jwk["crv"] as? String, crv == "P-256",
              let x = jwk["x"] as? String, let y = jwk["y"] as? String
        else { return .unapproved }
        let hostKey = Fleet.Host.PublicKey(kty: kty, crv: crv, x: x, y: y)
        let keyId = PhoneVault.keyHash(hostKey)
        guard opened["host"] as? String == keyId,
              PhoneVault.approval(grants, hostId: host, key: hostKey) == .approved
        else { return .unapproved }

        // 3. THAT KEY SIGNED THIS ANSWER TO THIS REQUEST: everything that
        // was opened but the key and the signature, with the request's own
        // id, member and engine in place of whatever the answer says they
        // were, in the bytes every signature here is made over.
        guard let signature = opened["signature"] as? String else { return .unsigned }
        var signed = opened
        signed.removeValue(forKey: "hostKey")
        signed.removeValue(forKey: "signature")
        signed["host"] = keyId
        signed["id"] = id
        signed["member"] = member
        signed["engine"] = engine
        guard XOSetupKey.holds(IntentSigning.signingInput("engine-signin-answer", signed), sig: signature, hostKey: hostKey)
        else { return .unsigned }

        // 4. ONLY NOW IS ANYTHING READ OUT TO BE SHOWN.
        let code = opened["code"] as? String
        let page = opened["url"] as? String
        let out = code != nil && page != nil
        var signedIn: EngineSignedIn?
        if let there = opened["signedIn"] as? [String: Any], let since = (there["since"] as? NSNumber)?.doubleValue {
            let who = there["who"] as? [String: Any]
            signedIn = EngineSignedIn(since: since, email: who?["email"] as? String, plan: who?["plan"] as? String)
        }
        return .verified(EngineSigninSaid(code: out ? code : nil, page: out ? page : nil, signedIn: signedIn))
    }

    /// Where `engine` can be signed in for a member, from what the machines
    /// report and what the member's vault approves (C-2).
    ///
    /// A MACHINE IS OFFERED ONLY WHEN IT WOULD TAKE THE REQUEST: it takes
    /// sessions now, which only a connected machine does, it is not a
    /// temporary one, it says it runs the engine, it is new enough to know
    /// how, and its key is approved for the whole of this member's
    /// credentials under its own name. The last is the check the answer is
    /// held to afterwards, made here first with the key the fleet lists,
    /// so no start is sent to a machine whose answer could not be shown.
    ///
    /// WITH NOWHERE TO OFFER, ONE SENTENCE SAYS WHAT IS MISSING, and never
    /// a button that would be refused. With no machines heard from at all
    /// it says nothing: that is not known to be "none" (C-5).
    static func places(engine: String, hosts: [Fleet.FleetHost], keys: [Fleet.Host], grants: [PhoneVault.Grant],
                       member: String?) -> EngineSigninPlaces {
        guard !hosts.isEmpty else { return EngineSigninPlaces() }
        let name = engineName(engine)
        let running = hosts.filter { host in
            host.takesSessions == true && host.ephemeral != true && (host.health?.engines ?? []).contains(engine)
        }
        guard !running.isEmpty else { return EngineSigninPlaces(missing: EngineSigninWords.noMachine(name)) }
        var offered: [String] = []
        var unapproved: [String] = []
        var old: [String] = []
        for host in running {
            guard (host.health?.`protocol` ?? 0) >= protocolNeeded else {
                old.append(host.hostId)
                continue
            }
            guard let key = keys.first(where: { $0.hostId == host.hostId })?.publicJwk else { continue }
            if PhoneVault.approval(grants, hostId: host.hostId, key: key) == .approved {
                offered.append(host.hostId)
            } else {
                unapproved.append(host.hostId)
            }
        }
        if !offered.isEmpty { return EngineSigninPlaces(offered: offered.sorted()) }
        if let box = unapproved.sorted().first { return EngineSigninPlaces(missing: EngineSigninWords.notApproved(box, name, member)) }
        if let box = old.sorted().first { return EngineSigninPlaces(missing: EngineSigninWords.tooOld(box, name)) }
        return EngineSigninPlaces()
    }

    /// What the screen shows of a machine after one answer from it.
    ///
    /// A NO WITH NO CODE BESIDE IT IS NOT A MACHINE'S REFUSAL: the fleet was
    /// not reached. Everything that was checked before stands, the code
    /// included, and the sentence says what went wrong.
    ///
    /// A REFUSAL is the machine's or the fleet's own sentence, shown as it
    /// came. It carries no code and no account, so what was checked before
    /// stands: who is signed in, and the code while the refusal says one is
    /// still out.
    ///
    /// AN ANSWER goes through `verified` before anything of it is used. One
    /// that fails shows nothing of a code, a page or an account, old or
    /// new, and says which check it failed. One that passes shows the code
    /// when the checked part carries one, and otherwise a sentence for how
    /// the attempt ended. The state beside it is not signed, so it picks
    /// the sentence and is never the reason a code is drawn.
    static func shown(after reply: Fleet.Reply, before: EngineSigninShown, key: Seal.OneUseKey, grants: [PhoneVault.Grant],
                      host: String, id: String, member: String, engine: String, memberName: String?) -> EngineSigninShown {
        let state = reply.state?.text ?? ""
        guard reply.ok == true else {
            let text = reply.text ?? ""
            let says = text.isBlank ? EngineSigninWords.refused(host) : text
            guard reply.error?.code != nil else {
                var kept = before
                kept.says = says
                kept.bad = true
                return kept
            }
            var next = EngineSigninShown(signedIn: before.signedIn, says: says, bad: true)
            if state == "waiting" {
                next.code = before.code
                next.page = before.page
                next.minutes = before.minutes
                next.cancel = before.code == nil
            }
            return next
        }
        let what = state == "waiting" ? EngineSigninWords.theCode : EngineSigninWords.whoIsSignedIn
        switch verified(sealed: reply.sealed, key: key, grants: grants, host: host, id: id, member: member, engine: engine) {
        case .unopened:
            return EngineSigninShown(says: EngineSigninWords.unopened(host, what), bad: true, cancel: state == "waiting")
        case .unapproved:
            return EngineSigninShown(says: EngineSigninWords.unapproved(memberName, what), bad: true, cancel: state == "waiting")
        case .unsigned:
            return EngineSigninShown(says: EngineSigninWords.unsigned(host, what), bad: true, cancel: state == "waiting")
        case .verified(let said):
            var next = EngineSigninShown(signedIn: said.signedIn)
            if let code = said.code, let page = said.page {
                next.code = code
                next.page = page
                next.minutes = reply.expiresInMinutes?.value
                return next
            }
            next.says = EngineSigninWords.ended(state, engine: engineName(engine), box: host, detail: reply.detail?.text)
            next.bad = EngineSigninWords.endedBadly(state)
            return next
        }
    }

    /// The sign-in page as something to open, only when it is an https
    /// address: the one page a code is entered on is never anything else.
    static func pageURL(_ page: String?) -> URL? {
        guard let page, let url = URL(string: page), url.scheme?.lowercased() == "https" else { return nil }
        return url
    }
}

/// The code's type: the scale's title size, set in the monospaced face so
/// an O and a 0 are told apart, and scaled by the reader's own setting.
private let engineCodeRole = Design.Role(size: Design.Text.title, weight: .semibold, tracking: 0,
                                         design: .monospaced, relativeTo: .title2)

/// One engine's sign-in on the member's machines, on that member's
/// Credentials: who is signed in where, Sign in on a machine, the code
/// while one is out, and Sign out.
///
/// ASKED WHEN THE PAGE OPENS, of each machine it could be signed in on, so
/// a sign-in made earlier says who it is, and a code that is still out
/// (from this phone before it left the page, or from another custodian's)
/// is shown again. While a code is out the machine is asked every few
/// seconds, and the asking stops when this view goes. LEAVING DOES NOT
/// CANCEL: only Cancel does.
///
/// EVERY REQUEST IS ITS OWN: a new id and a new key each time, a poll
/// included, because the machine signs its answer over the id and seals it
/// to the key.
struct EngineMachineSignIn: View {
    let settings: Settings
    /// "codex", or "opencode" for GitHub Copilot.
    let engine: String
    /// The member it is signed in for, by id: the one whose vault is on
    /// screen, or this person's own member.
    let member: String
    /// That member's name, for a sentence, or nil for this person's own.
    let memberName: String?
    /// What every machine reports of itself.
    let hosts: [Fleet.FleetHost]
    /// The machines in this fleet, with the keys the fleet lists for them.
    let keys: [Fleet.Host]
    /// The machines approved in this member's vault, as this phone read them.
    let grants: [PhoneVault.Grant]
    /// Whether the vault also keeps a pasted sign-in for this engine.
    let pasted: Bool

    @State private var shown: [String: EngineSigninShown] = [:]
    /// Which request to each machine is the latest. An answer to an earlier
    /// one is dropped: a slow "nothing here" must not take away the code a
    /// later start brought.
    @State private var turns: [String: Int] = [:]
    /// The machine being asked for something other than where it stands.
    @State private var busy = ""
    @State private var choosing = false
    /// The machine a Sign out is waiting on, until the dialog is answered.
    @State private var signingOut: String?
    /// The code Copy was last pressed for.
    @State private var copiedCode = ""
    @Environment(\.openURL) private var openURL

    private var places: EngineSigninPlaces {
        EngineSignin.places(engine: engine, hosts: hosts, keys: keys, grants: grants, member: memberName)
    }

    /// The machine a code is out on, which is the one asked every few seconds.
    private var waitingOn: String? {
        shown.keys.sorted().first { shown[$0]?.code != nil }
    }

    /// Whether there is anything to say about this engine yet. With no
    /// machine to offer, nothing missing that is certain, and nothing a
    /// machine has said, the block is not drawn: a heading over nothing
    /// promises a sign-in the page cannot give.
    private var hasSomething: Bool {
        !places.offered.isEmpty || !places.missing.isEmpty
            || shown.values.contains { $0.signedIn != nil || $0.code != nil || !$0.says.isEmpty || $0.cancel }
    }

    var body: some View {
        if hasSomething { block }
    }

    private var block: some View {
        let places = self.places
        return VStack(alignment: .leading, spacing: Design.Space.insideTight) {
            Text(EngineSigninWords.title(engine))
                .fleetType(.body)
                .foregroundStyle(Design.Palette.ink)
            ForEach(shown.keys.sorted(), id: \.self) { host in
                if let one = shown[host] { stands(host, one) }
            }
            // ONE THING AT A TIME: while a code is out, the next step is
            // that code, and a second start is not offered beside it.
            if waitingOn == nil {
                if !places.offered.isEmpty {
                    offer(places.offered)
                } else if !places.missing.isEmpty {
                    Text(places.missing)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .buttonStyle(.borderless)
        // A CHANGE OF STATE MOVES, and nothing else: a crossfade, which is
        // the one animation Reduce Motion keeps.
        .animation(Design.Motion.change, value: shown)
        .task(id: places.offered) {
            for host in places.offered { await ask("status", of: host) }
        }
        .task(id: waitingOn) {
            guard let host = waitingOn else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: EngineSignin.pollEvery)
                if Task.isCancelled { return }
                await ask("status", of: host)
            }
        }
        .confirmationDialog(EngineSigninWords.signOutAsk(engineName(engine), signingOut ?? ""),
                            isPresented: Binding(get: { signingOut != nil }, set: { if !$0 { signingOut = nil } }),
                            titleVisibility: .visible) {
            Button(EngineSigninWords.signOut, role: .destructive) {
                if let host = signingOut {
                    Task { await ask("signout", of: host) }
                }
            }
        } message: {
            Text(EngineSigninWords.signOutCost(memberName, pasted: pasted))
        }
    }

    /// Sign in on a machine, and which one when more than one could.
    @ViewBuilder private func offer(_ offered: [String]) -> some View {
        Button(busy.isEmpty ? EngineSigninWords.offer : EngineSigninWords.asking(busy)) {
            if offered.count == 1, let only = offered.first {
                Task { await ask("start", of: only) }
            } else {
                choosing.toggle()
            }
        }
        .accessibilityLabel(busy.isEmpty ? EngineSigninWords.offerOf(engineName(engine)) : EngineSigninWords.asking(busy))
        .frame(minHeight: 44)
        .disabled(!busy.isEmpty)
        if choosing, offered.count > 1 {
            Text(EngineSigninWords.which)
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
            ForEach(offered, id: \.self) { host in
                Button(EngineSigninWords.on(host)) {
                    choosing = false
                    Task { await ask("start", of: host) }
                }
                .frame(minHeight: 44)
                .disabled(!busy.isEmpty)
            }
        }
    }

    /// One machine: who is signed in there, the code while one is out, and
    /// how the last attempt ended.
    @ViewBuilder private func stands(_ host: String, _ one: EngineSigninShown) -> some View {
        if let signedIn = one.signedIn {
            Text(EngineSigninWords.signedIn(host, signedIn))
                .fleetType(.label)
                .foregroundStyle(Design.Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Button(EngineSigninWords.signOut, role: .destructive) { signingOut = host }
                .accessibilityLabel(EngineSigninWords.signOutOf(engineName(engine), host))
                .frame(minHeight: 44)
                .disabled(!busy.isEmpty)
        }
        if let code = one.code {
            Text(EngineSigninWords.codeFor(host))
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
                .fixedSize(horizontal: false, vertical: true)
            // LARGE, AND FREE TO WRAP: at the largest text size the code is
            // wider than the row, and it breaks at its dash into its two
            // groups, never clipped and never shrunk.
            Text(code)
                .fleetType(engineCodeRole)
                .foregroundStyle(Design.Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityLabel(EngineSigninWords.spoken(code))
            if let url = EngineSignin.pageURL(one.page) {
                Button(EngineSigninWords.openPage) { openURL(url) }
                    .frame(minHeight: 44)
            }
            Button(copiedCode == code ? EngineSigninWords.copied : EngineSigninWords.copy) {
                UIPasteboard.general.string = code
                copiedCode = code
            }
            .frame(minHeight: 44)
            Text(EngineSigninWords.waiting(EngineSigninWords.provider(engine), minutes: one.minutes))
                .fleetType(.label)
                .foregroundStyle(Design.Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        if !one.says.isEmpty {
            Text(one.says)
                .fleetType(.label)
                .foregroundStyle(one.bad ? Design.Palette.bad : Design.Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        if one.code != nil || one.cancel {
            Button(EngineSigninWords.cancel, role: .cancel) {
                Task { await ask("cancel", of: host) }
            }
            .accessibilityLabel(EngineSigninWords.cancelOn(host))
            .frame(minHeight: 44)
            .disabled(!busy.isEmpty)
        }
    }

    /// Ask one machine one thing, and show what its answer may show.
    ///
    /// A START GOES ONLY TO A MACHINE THAT IS OFFERED, which is one whose
    /// answer this phone could check. One that was approved a moment ago
    /// may not have heard yet, and says so: it is asked once more, a few
    /// seconds on, and never a third time.
    @MainActor
    private func ask(_ action: String, of host: String, again: Bool = false) async {
        if action == "start", !places.offered.contains(host) { return }
        let quiet = action == "status"
        if !quiet { busy = host }
        let turn = (turns[host] ?? 0) + 1
        turns[host] = turn
        let id = "app-\(UUID().uuidString)"
        let sealTo = Seal.newKey()
        let before = shown[host] ?? EngineSigninShown()
        do {
            let reply = try await Fleet(settings: settings).engineSignIn(
                member: member, engine: engine, action: action, host: host, reply: sealTo.publicKey, id: id
            )
            if action == "start", !again, reply.ok != true, reply.error?.code == "not_approved" {
                try? await Task.sleep(nanoseconds: EngineSignin.approvalSettles)
                await ask(action, of: host, again: true)
                return
            }
            if turns[host] == turn {
                shown[host] = EngineSignin.shown(after: reply, before: before, key: sealTo, grants: grants, host: host, id: id,
                                                 member: member, engine: engine, memberName: memberName)
            }
        } catch {
            if turns[host] == turn {
                var next = before
                next.says = error.localizedDescription
                next.bad = true
                shown[host] = next
            }
        }
        if !quiet { busy = "" }
    }
}
