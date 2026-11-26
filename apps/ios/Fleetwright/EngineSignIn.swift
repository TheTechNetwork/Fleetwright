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
/// NOTHING THE FLEET COULD HAVE WRITTEN IS DRAWN HERE. A refusal's sentence
/// and an engine's reason arrive outside the seal, and a fleet that lies can
/// put a code of its own in either, to be read beside the real one. So a
/// refusal is this phone's own sentence, chosen by the refusal's code
/// (`EngineSigninWords.refusal`), and how an attempt ended, why it failed
/// and when its code runs out are read from inside the checked answer when
/// the machine put them there. A machine from before it did gets this
/// phone's fixed sentences, chosen by the word beside the answer, with no
/// reason and no countdown. That word never makes a code or a sign-in.
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
///
/// `state`, `detail` and `expiresAt` are the machine's own word for how the
/// attempt stands, the engine's reason when it failed, and when the code
/// runs out, from inside what it signed. All three are nil from a machine
/// from before it signed them, which is told from one that did by `state`.
struct EngineSigninSaid: Equatable {
    let code: String?
    let page: String?
    let signedIn: EngineSignedIn?
    var state: String? = nil
    var detail: String? = nil
    var expiresAt: Double? = nil
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
    /// How many minutes the code still lasts, worked out from when the
    /// machine's checked answer says it runs out. Nil when it did not say,
    /// or said something a code's life cannot be.
    var minutes: Int? = nil
    /// The machine did not say when the code runs out: one from before it
    /// signed that. Then the sentence says how long a code lasts and no more.
    var fixedLife: Bool = false
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
    /// Under Sign in on a machine where a machine is signed in already: the
    /// same button changes the account, and nothing said so.
    static let replaces = "Signing in on a machine that is signed in replaces that sign-in."
    /// No answer at all: the request did not reach the fleet, or what came
    /// back was not an answer. Nobody refused anything.
    static let notReached = "Your fleet did not answer. Check the connection, then try again."

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

    /// What VoiceOver is told when a code arrives: which machine it is for,
    /// then the code, a character at a time. The button under the reader's
    /// finger goes when the code comes, up to most of a minute after it was
    /// pressed, and nothing said so.
    static func codeArrived(_ box: String, _ code: String) -> String {
        "\(codeFor(box)): \(spoken(code))"
    }

    /// While a code is out: what is being waited for, and how long the code
    /// still lasts when the machine's checked answer said when it runs out.
    /// `fixedLife` is a machine that did not say: then how long any code
    /// lasts, which is known, and no count of what is left, which is not.
    static func waiting(_ provider: String, minutes: Int?, fixedLife: Bool = false) -> String {
        let said = "Waiting for this code to be approved at \(provider)."
        guard let minutes, minutes > 0 else { return fixedLife ? said + " A code lasts 15 minutes." : said }
        if minutes == 1 { return said + " It lasts 1 more minute." }
        return said + " It lasts \(minutes) more minutes."
    }

    /// "Signed in on ops-box as debbie@example.com, on the plus plan, since
    /// 25 Nov 2026 at 10:02." Without "as" where the engine names no account.
    static func signedIn(_ box: String, _ who: EngineSignedIn) -> String {
        var said = "Signed in on \(box)"
        if let email = who.email, !email.isEmpty {
            said += " as \(email)"
            if let plan = who.plan, !plan.isEmpty { said += ", on the \(plan) plan" }
        }
        if let when = taskTime(who.since) { said += ", since \(when)" }
        return said + "."
    }

    /// The most of an engine's own reason that is drawn. The machine keeps
    /// it to one line of 200 characters, and this holds it to that.
    static let detailMost = 200

    /// How an attempt that is over ended, by the machine's word for it. A
    /// state with nothing to say, and one this build has never met, say
    /// nothing: no sentence here claims more than the machine did.
    ///
    /// `standing` IS A SIGN-IN THE CHECKED ANSWER SAYS IS THERE. Then the
    /// attempt that ended was a newer one, and the sentence says so and that
    /// the sign-in stands: "Codex did not sign in" under "Signed in on
    /// ops-box" reads as its opposite. Signed out, or no longer working,
    /// beside a sign-in the machine signed for says nothing.
    static func ended(_ state: String, engine: String, box: String, detail: String?, standing: Bool = false) -> String {
        let why = String((detail ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(detailMost))
        if standing {
            switch state {
            case "expired": return "A newer code ran out before it was approved. The sign-in above stands."
            case "failed":
                return why.isEmpty ? "A newer attempt did not sign in. The sign-in above stands."
                    : "The sign-in above stands. A newer attempt did not sign in: \(why)"
            case "cancelled": return "A newer attempt was cancelled. The sign-in above stands."
            case "lost": return "\(box) restarted while a newer attempt was waiting, so that attempt is gone. The sign-in above stands."
            default: return ""
            }
        }
        switch state {
        case "expired": return "The code ran out before it was approved. Start again for a new one."
        case "failed": return why.isEmpty ? "\(engine) did not sign in." : "\(engine) did not sign in: \(why)"
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

    /// What to do about an answer that failed a check. Said after what is
    /// not shown, because a sentence that only says an answer could not be
    /// checked leaves a person to guess whether to wait, try again or worry.
    static func then(_ codeOut: Bool) -> String {
        codeOut ? "Cancel it, and tell whoever runs this fleet." : "Tell whoever runs this fleet."
    }

    static func unopened(_ box: String, codeOut: Bool) -> String {
        "\(box)’s answer could not be opened, so \(codeOut ? theCode : whoIsSignedIn) is not shown. \(then(codeOut))"
    }

    static func unapproved(_ member: String?, codeOut: Bool) -> String {
        let what = codeOut ? theCode : whoIsSignedIn
        guard let member else { return "This answer did not come from a machine approved for your credentials, so \(what) is not shown. \(then(codeOut))" }
        return "This answer did not come from a machine approved for \(member)’s credentials, so \(what) is not shown. \(then(codeOut))"
    }

    static func unsigned(_ box: String, codeOut: Bool) -> String {
        "\(box)’s answer could not be checked, so \(codeOut ? theCode : whoIsSignedIn) is not shown. \(then(codeOut))"
    }

    /// A code came with a page that is not the provider's own. The machine
    /// signed for it, so the machine is what to look at.
    static func foreignPage(_ box: String, _ provider: String) -> String {
        "\(box) gave a sign-in page that is not \(provider)’s, so the code is not shown. \(then(true))"
    }

    /// A refusal's code as it may be printed: lower-case words joined by
    /// underscores, at most 40 characters, which is what every code the
    /// fleet and its machines send is. Anything else is not printed at all,
    /// because the code comes from outside the seal like the sentence does.
    static func printable(_ code: String) -> Bool {
        code.count <= 40 && code.range(of: "^[a-z]+(_[a-z]+)*$", options: .regularExpression) != nil
    }

    /// WHAT A REFUSAL SAYS, IN THIS PHONE'S OWN WORDS, BY ITS CODE. The
    /// fleet's sentence is never drawn here (the header says why), so each
    /// code a sign-in can be refused with has its sentence here, and each
    /// says what to do next. A code this build has not met names the machine
    /// and the code and nothing else from the answer. The same table as
    /// Android, held equal by test/engines-in-apps.test.js, which also holds
    /// it to every code the machine's own code refuses with.
    static func refusal(_ code: String, box: String, engine: String, member: String?) -> String {
        let whose = member.map { "\($0)’s" } ?? "your"
        let whom = member ?? "you"
        switch code {
        case "not_approved": return "\(box) is not approved for \(whose) credentials, or has not heard yet that it is. If it was approved a moment ago, try again shortly. Otherwise approve it first."
        case "approval_unknown": return "\(box) has not heard from the vault which credentials it is approved for. It asks every ten minutes. Try again in a few minutes."
        case "custody_unknown": return "Your fleet has not heard yet who may sign an engine in for \(whom). Try again in a few minutes."
        case "not_custodian": return "The vault does not list you as somebody who may sign an engine in for \(whom). A custodian adds you from \(whose) Credentials."
        case "not_signed_in": return "Signing an engine in needs you signed in to this fleet. Sign in again under You."
        case "no_member": return "The vault does not hold this member yet. File it from Organization, under Custody, then try again."
        case "member_unchecked": return "\(box) has no list from the vault of who may act for a member, so it signs no engine in. Try again in a few minutes."
        case "signature_required": return "\(box) takes this only when this phone signed it, and this phone’s key is not listed yet. Sign in to GitHub under Runners, then try again."
        case "host_outdated", "hub_outdated", "unknown_verb": return "\(box) is too old to sign an engine in. Update fleetwright on \(box)."
        case "no_engine": return "\(box) does not run \(engine). Sign it in on a machine that does."
        case "host_unavailable": return "\(box) is not connected, or does not act for you. Try again when it is back, or use another machine."
        case "host_timeout", "hub_timeout": return "\(box) did not answer in time. Try again."
        case "hub_unreachable": return "fleetwright on \(box) is not answering. Try again, and if it goes on, whoever runs \(box) restarts it."
        case "answer_unsigned": return "\(box) could not sign its answer, so nothing of it is shown. Try again, or cancel the sign-in."
        case "bad_params": return "\(box) did not take the request as this app sent it. Update this app and fleetwright on \(box)."
        case "no_image": return "\(box) has not fetched its session image yet. Start a session there first, then sign in."
        case "no_podman": return "\(box) has no podman to run a sign-in in. Whoever runs \(box) installs it."
        case "no_egress": return "\(box) could not set up internet access for this sign-in. Whoever runs \(box) looks at its internet access settings."
        case "device_code_off": return "\(engine) says signing in with a code is not turned on for this account or its workspace. Turn it on there, or paste a sign-in instead."
        case "signin_failed": return "\(engine) ended on \(box) before it gave a code. Start again."
        case "no_code": return "\(engine) gave no code on \(box) in time, and nothing is waiting. Start again."
        case "busy": return "\(engine) is being signed out on \(box) right now. Try again in a moment."
        case "signout_failed": return "\(engine) was not signed out on \(box), and what \(box) knows of the sign-in is unchanged. Try again."
        case "state_unreadable": return "\(box) cannot read its own record of sign-ins, so it cannot say where this one stands. Whoever runs \(box) looks at its state directory."
        default: return printable(code) ? "\(box) refused that (\(code))." : "\(box) refused that."
        }
    }

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

    /// What signing out costs, said before it is done, and only what is
    /// known: the machine forgets this sign-in, so a session that starts
    /// there afterwards cannot use the engine. Whether one that is running
    /// stops is not known, and is not said. With a pasted sign-in kept, the
    /// next session runs on that, which is said in place of "cannot".
    static func signOutCost(_ member: String?, engine: String, box: String, pasted: Bool) -> String {
        if pasted { return "\(box) forgets this sign-in. A pasted sign-in is still kept, and the next session there runs on that." }
        guard let member else { return "\(box) forgets this sign-in, and your new sessions there cannot use \(engine) until it is signed in again. Signing in again takes a new code." }
        return "\(box) forgets this sign-in, and new sessions as \(member) there cannot use \(engine) until it is signed in again. Signing in again takes a new code."
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

        // 4. ONLY NOW IS ANYTHING READ OUT TO BE SHOWN. An empty code or an
        // empty page is no code, as it is on Android: a code is something
        // to enter. `since` is a number or the sign-in is not said; a true
        // is a number to Foundation, and is not one here.
        let code = (opened["code"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let page = (opened["url"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let out = code != nil && page != nil
        var signedIn: EngineSignedIn?
        if let there = opened["signedIn"] as? [String: Any], let since = wholeNumber(there["since"]) {
            let who = there["who"] as? [String: Any]
            signedIn = EngineSignedIn(since: since, email: who?["email"] as? String, plan: who?["plan"] as? String)
        }
        // HOW IT STANDS, WHY IT FAILED AND WHEN THE CODE RUNS OUT, where the
        // machine signed for them. A reason is read only beside a state,
        // and an end only beside a code.
        let state = (opened["state"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let detail: String? = state == nil ? nil : (opened["detail"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return .verified(EngineSigninSaid(code: out ? code : nil, page: out ? page : nil, signedIn: signedIn,
                                          state: state, detail: detail, expiresAt: out ? wholeNumber(opened["expiresAt"]) : nil))
    }

    /// The one page each engine's code is entered on: Codex's own device
    /// page at OpenAI (codex-rs/login, `{issuer}/codex/device`), and
    /// GitHub's, which is where OpenCode's Copilot sign-in sends a person.
    /// Nil for an engine no machine signs in.
    ///
    /// A CODE IS DRAWN ONLY BESIDE THAT PAGE. The three checks say the
    /// machine signed the answer. They do not say the page is the
    /// provider's: a machine that was made to sign another page would send
    /// somebody to enter a real code somewhere that is not OpenAI or GitHub.
    /// So after the checks the page is held to this, letter for letter, and
    /// with any other the code is not drawn and neither is its button.
    static func page(of engine: String) -> String? {
        switch engine {
        case "codex": return "https://auth.openai.com/codex/device"
        case "opencode": return "https://github.com/login/device"
        default: return nil
        }
    }

    /// A whole number out of an opened answer, or nil for anything else: a
    /// word, a fraction, and a true or false, which Foundation would
    /// otherwise hand over as 1 or 0.
    static func wholeNumber(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number as CFTypeRef) != CFBooleanGetTypeID() else { return nil }
        let whole = number.doubleValue
        return whole == whole.rounded() ? whole : nil
    }

    /// How many minutes a code still lasts, from when the machine's checked
    /// answer says it runs out and this phone's own clock. Nil when it did
    /// not say, when the time has passed, and when it comes to more than
    /// the fifteen minutes a code lasts: a number that cannot be right is
    /// not said.
    static func minutesLeft(_ expiresAt: Double?, now: Double) -> Int? {
        guard let expiresAt else { return nil }
        let left = ((expiresAt - now) / 60_000).rounded(.up)
        guard left >= 1, left <= 15 else { return nil }
        return Int(left)
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
    /// NOTHING FROM OUTSIDE THE SEAL IS DRAWN: not the answer's sentence,
    /// not the engine's reason beside it, not its count of minutes. Each
    /// could carry a code a lying fleet wants entered.
    ///
    /// A NO WITH NO CODE BESIDE IT IS NOT A MACHINE'S REFUSAL: the fleet was
    /// not reached, or did not answer as a fleet does. Everything that was
    /// checked before stands, the code included, and one fixed sentence
    /// says so.
    ///
    /// A REFUSAL is said in this phone's own words for its code. It carries
    /// no code and no account, so what was checked before stands: who is
    /// signed in, and the code while the refusal says one is still out.
    ///
    /// A REFUSED ASK OF WHERE IT STANDS (`poll`) IS THAT ASK FAILING, and
    /// nothing about the sign-in. One machine not answering in time, once
    /// in fifteen minutes of asking, took the code off the screen, ended
    /// the asking and took Cancel with it, with the attempt still out. So
    /// everything stays, the sentence says what happened, and the asking
    /// goes on.
    ///
    /// AN ANSWER goes through `verified` before anything of it is used. One
    /// that fails shows nothing of a code, a page or an account, old or
    /// new, and says which check it failed and what to do. One that passes
    /// shows the code when the checked part carries one beside the page
    /// that engine's code is entered on (`page(of:)`), and otherwise a
    /// sentence for how the attempt ended: by the machine's own checked
    /// word and reason where it signed them, and by the word beside the
    /// answer, with no reason, from a machine that did not. That word is
    /// not signed, so it picks among this phone's sentences and is never
    /// the reason a code or a sign-in is drawn.
    ///
    /// `now` is this phone's clock in milliseconds, which the minutes a
    /// code still lasts are worked out against.
    static func shown(after reply: Fleet.Reply, before: EngineSigninShown, poll: Bool, key: Seal.OneUseKey, grants: [PhoneVault.Grant],
                      host: String, id: String, member: String, engine: String, memberName: String?,
                      now: Double = Date().timeIntervalSince1970 * 1000) -> EngineSigninShown {
        let state = reply.state?.text ?? ""
        guard reply.ok == true else {
            guard let code = reply.error?.code else {
                var kept = before
                kept.says = EngineSigninWords.notReached
                kept.bad = true
                return kept
            }
            let says = EngineSigninWords.refusal(code, box: host, engine: engineName(engine), member: memberName)
            if poll {
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
                next.fixedLife = before.fixedLife
                next.cancel = before.code == nil
            }
            return next
        }
        let codeOut = state == "waiting"
        switch verified(sealed: reply.sealed, key: key, grants: grants, host: host, id: id, member: member, engine: engine) {
        case .unopened:
            return EngineSigninShown(says: EngineSigninWords.unopened(host, codeOut: codeOut), bad: true, cancel: codeOut)
        case .unapproved:
            return EngineSigninShown(says: EngineSigninWords.unapproved(memberName, codeOut: codeOut), bad: true, cancel: codeOut)
        case .unsigned:
            return EngineSigninShown(says: EngineSigninWords.unsigned(host, codeOut: codeOut), bad: true, cancel: codeOut)
        case .verified(let said):
            var next = EngineSigninShown(signedIn: said.signedIn)
            if let code = said.code, let page = said.page {
                guard page == EngineSignin.page(of: engine) else {
                    next.says = EngineSigninWords.foreignPage(host, EngineSigninWords.provider(engine))
                    next.bad = true
                    next.cancel = true
                    return next
                }
                next.code = code
                next.page = page
                next.minutes = minutesLeft(said.expiresAt, now: now)
                next.fixedLife = said.expiresAt == nil
                return next
            }
            let ending = said.state ?? state
            next.says = EngineSigninWords.ended(ending, engine: engineName(engine), box: host, detail: said.detail,
                                                standing: said.signedIn != nil)
            next.bad = !next.says.isEmpty && EngineSigninWords.endedBadly(ending)
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
    /// What a button here last started, so that leaving the page ends it.
    @State private var acting: Task<Void, Never>?
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
                    // THE SAME BUTTON CHANGES THE ACCOUNT on a machine that
                    // is signed in, and that is said where it is true.
                    if places.offered.contains(where: { shown[$0]?.signedIn != nil }) {
                        Text(EngineSigninWords.replaces)
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
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
        // LEAVING THE PAGE ENDS WHAT A BUTTON STARTED, as it ends the asking.
        // A start waiting out its second try was still sent after the page
        // had gone, and a code was then out with nobody looking at it.
        .onDisappear { acting?.cancel() }
        .confirmationDialog(EngineSigninWords.signOutAsk(engineName(engine), signingOut ?? ""),
                            isPresented: Binding(get: { signingOut != nil }, set: { if !$0 { signingOut = nil } }),
                            titleVisibility: .visible) {
            Button(EngineSigninWords.signOut, role: .destructive) {
                if let host = signingOut {
                    acting = Task { await ask("signout", of: host) }
                }
            }
        } message: {
            Text(EngineSigninWords.signOutCost(memberName, engine: engineName(engine), box: signingOut ?? "", pasted: pasted))
        }
    }

    /// Sign in on a machine, and which one when more than one could.
    @ViewBuilder private func offer(_ offered: [String]) -> some View {
        Button(busy.isEmpty ? EngineSigninWords.offer : EngineSigninWords.asking(busy)) {
            if offered.count == 1, let only = offered.first {
                acting = Task { await ask("start", of: only) }
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
                    acting = Task { await ask("start", of: host) }
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
            Text(EngineSigninWords.waiting(EngineSigninWords.provider(engine), minutes: one.minutes, fixedLife: one.fixedLife))
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
                acting = Task { await ask("cancel", of: host) }
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
    ///
    /// ASKING WHERE IT STANDS NEVER OUTRANKS A BUTTON. An answer is shown
    /// only when no later request to that machine has started, which is
    /// right for a slow "nothing here" against a later start. But the asking
    /// every few seconds is a request too, and one that began while a Sign
    /// out was still being done made this throw the Sign out's own answer
    /// away: the screen went on saying Signed in over a machine that had
    /// signed out. So while a button's request to a machine is out, that
    /// machine is not asked where it stands, and once the button's answer
    /// is shown it is asked once, which is also how a refused Cancel finds
    /// the code again.
    ///
    /// A REQUEST THAT WAS CANCELLED SAYS NOTHING. Leaving the page cancels
    /// the asking, and the request then fails as cancelled: that was drawn
    /// as "cancelled", in red, under a code that was still out.
    @MainActor
    private func ask(_ action: String, of host: String, again: Bool = false) async {
        if action == "start", !places.offered.contains(host) { return }
        let quiet = action == "status"
        if quiet, busy == host { return }
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
                if Task.isCancelled {
                    busy = ""
                    return
                }
                await ask(action, of: host, again: true)
                return
            }
            if turns[host] == turn {
                let next = EngineSignin.shown(after: reply, before: before, poll: quiet, key: sealTo, grants: grants, host: host, id: id,
                                              member: member, engine: engine, memberName: memberName)
                shown[host] = next
                // A CODE THAT ARRIVES IS SAID ALOUD, once, for somebody who
                // cannot see that the button they pressed became a code.
                if let code = next.code, code != before.code {
                    UIAccessibility.post(notification: .announcement, argument: EngineSigninWords.codeArrived(host, code))
                }
            }
        } catch {
            if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled {
                if !quiet { busy = "" }
                return
            }
            if turns[host] == turn {
                var next = before
                next.says = error.localizedDescription
                next.bad = true
                shown[host] = next
            }
        }
        if !quiet {
            busy = ""
            await ask("status", of: host)
        }
    }
}
