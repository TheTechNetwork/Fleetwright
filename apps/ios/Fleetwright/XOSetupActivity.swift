import ActivityKit
import Foundation

/// A hypervisor being added, as the Lock Screen and the Dynamic Island see it.
/// docs/hypervisors.md.
///
/// COMPILED INTO BOTH THE APP AND THE WIDGET EXTENSION (project.yml lists this
/// file under each), because ActivityKit matches an activity to its view by
/// this type: the app starts one with these attributes and the extension draws
/// whatever arrives for them. Two copies of the type would be two types.
///
/// WHAT IS IN IT, AND WHAT IS NOT. The static half is this phone's own
/// knowledge, set when the person began the job and never pushed: which job,
/// which machine, which address. The moving half is what the coordinator
/// pushes to the activity, and it is numbers and a key, never a sentence or an
/// address, because an activity's content-state crosses APNs in the clear
/// (src/fleet/push.js, ActivityUpdate). The words are made here, from the key.
struct XOSetupAttributes: ActivityAttributes {
    /// Where the job has got to.
    ///
    /// DECODED STRAIGHT FROM THE COORDINATOR'S PUSH. The field names are the
    /// server's `content-state` {"step","of","phase","state"}, written by
    /// #onSetupProgress in src/fleet/coordinator/core.js and pinned by
    /// test/xosetup-in-apps.test.js. Renaming one here would not fail a
    /// build; it would make every pushed update fail to decode, and the Lock
    /// Screen would simply stop moving.
    struct ContentState: Codable, Hashable {
        /// Index of the step now running, or the count when it is over.
        var step: Int
        /// How many steps there are.
        var of: Int
        /// The step's key from XOSETUP_STEPS, or `done`.
        var phase: String
        /// `waiting`, `running`, `done`, `failed` or `cancelled`.
        var state: String
        /// When this phone last heard about the job: set by the app on the
        /// content it writes itself, and nil on content the coordinator
        /// pushed, which does not carry it. The Lock Screen names this time
        /// when the content has gone stale, so "no word" says since when.
        var since: Date? = nil
        /// How far the step now running has got, in thousandths, when the
        /// machine can tell (the edge router's build); pushed by the
        /// coordinator beside the step, and nil when it is not known.
        var fill: Int? = nil
        /// What the step now running is building, from a fixed list: `edge`,
        /// `image` or `holder`; nil when it is not building or the host did
        /// not say. A key, never a name, for the reason above.
        var build: String? = nil
        /// Which part of that build is running, from 1, and of how many; nil
        /// together when the build is not in parts or the host did not say.
        var stage: Int? = nil
        var stages: Int? = nil
    }

    /// The job `begin` answered with. Local; never pushed.
    let job: String
    /// The machine running it. Shown, as a notification about a machine
    /// already shows its name.
    let hostId: String
    /// Where Xen Orchestra answers. Kept for the app; the Lock Screen does not
    /// draw it, for the same reason the push does not carry it.
    let address: String
    /// `policy` for a change to what the fleet may use, whose end is not a
    /// hypervisor added; `deploy` for installing Xen Orchestra first; nil for
    /// adding one. Optional, so an activity a build
    /// before it left on the Lock Screen still decodes, as the adding it was.
    var purpose: String? = nil
}

/// The words for each step, in one place, so the screen in the app and the
/// activity on the Lock Screen say the same thing about the same moment.
///
/// The keys are XOSETUP_STEPS in src/fleet/protocol/intents.js, in its order;
/// test/xosetup-in-apps.test.js fails a step added there without a sentence
/// here. A key this build has never met is still shown as a step with a
/// number, because a newer host must not read as a stuck one (C-5: the phone
/// knows the number, so it says the number).
enum XOSetupWords {
    /// What is happening now, as a short present-tense line.
    static func phrase(phase: String, step: Int, of: Int) -> String {
        switch phase {
        case "connect": return "Reaching Xen Orchestra"
        case "sign-in": return "Signing in"
        case "inventory": return "Reading the pool"
        case "user": return "Making the fleetwright user"
        case "resource-set": return "Setting what it may use"
        case "token": return "Making its token"
        case "updates": return "Turning on updates"
        case "hand-off": return "Handing over"
        // A policy job's own two steps (XOPOLICY_STEPS), in the words the
        // host leaves on the job (STEP_WORDS in xo-setup.js). Its first three
        // are onboarding's, above.
        case "choose": return "Waiting for your choice"
        case "apply": return "Applying what you chose"
        // An install's own steps (XODEPLOY_STEPS), before onboarding's, in
        // the words the host leaves on the job (STEP_WORDS in xo-setup.js).
        case "reach": return "Reaching the pool master"
        case "installer": return "Fetching the installer"
        case "network": return "Setting up its network"
        case "image": return "Getting Debian 13"
        case "vm": return "Making its VM"
        case "boot": return "Booting it"
        case "packages": return "Installing packages"
        case "build": return "Building Xen Orchestra"
        case "admin": return "Replacing the default admin password"
        case "done": return "Hypervisor added"
        default: return "Step \(min(step + 1, max(of, 1))) of \(max(of, 1))"
        }
    }

    /// What a build is making, in a few words, or nil for a key this build
    /// has never met: the part number is still said, without a name made up.
    static func building(_ key: String?) -> String? {
        switch key {
        case "edge": return "building the edge router"
        case "image": return "building the machine image"
        case "holder": return "making the pool’s own machine"
        default: return nil
        }
    }

    /// "Building the machine image, part 2 of 4" while a build in parts is
    /// running, so the Lock Screen says what the minutes are being spent on
    /// and not only a percentage. Nil when nothing is being built in parts.
    static func detail(build: String?, stage: Int?, stages: Int?) -> String? {
        let what = building(build)
        let part: String? = {
            guard let stage, let stages, stages > 0 else { return nil }
            return "part \(stage) of \(stages)"
        }()
        switch (what, part) {
        case let (what?, part?): return "\(what), \(part)"
        case let (what?, nil): return what
        case let (nil, part?): return part
        default: return nil
        }
    }

    static func detail(_ s: XOSetupAttributes.ContentState) -> String? {
        guard s.state == "running" else { return nil }
        return detail(build: s.build, stage: s.stage, stages: s.stages)
    }

    /// The one line for the state, once the state is not "running".
    ///
    /// The coordinator's end notification uses these same three titles, so a
    /// person who reads the banner and then the activity reads one sentence.
    static func headline(_ s: XOSetupAttributes.ContentState, purpose: String? = nil) -> String {
        if purpose == "policy", let end = policyEnd(s.state) { return end }
        if purpose == "deploy", let end = deployEnd(s.state) { return end }
        switch s.state {
        case "done": return "Hypervisor added"
        case "failed": return "Hypervisor setup stopped"
        case "cancelled": return "Hypervisor setup cancelled"
        case "waiting": return "Waiting for the sign-in"
        default: return phrase(phase: s.phase, step: s.step, of: s.of)
        }
    }

    /// How a policy job ended, in the words the coordinator's banner uses
    /// for it (POLICY_TITLES in core.js), or nil while it has not.
    static func policyEnd(_ state: String) -> String? {
        switch state {
        case "done": return "What the fleet may use is changed"
        case "failed": return "The change stopped"
        case "cancelled": return "The change was cancelled"
        default: return nil
        }
    }

    /// How an install ended, in the words the coordinator's banner uses for
    /// it (DEPLOY_TITLES in core.js): it installed Xen Orchestra and then
    /// added the pool, so its end says both. Nil while it has not ended.
    static func deployEnd(_ state: String) -> String? {
        switch state {
        case "done": return "Xen Orchestra installed and added"
        case "failed": return "Installing Xen Orchestra stopped"
        case "cancelled": return "Installing Xen Orchestra cancelled"
        case "waiting": return "Waiting for the passwords"
        default: return nil
        }
    }

    /// "Step 3 of 8", for the line under the headline and the Island's
    /// compact trailing slot, or "42%" while a step that says how far it has
    /// got is running, because that is the number that is moving. Nil once
    /// it is over: a finished job is not on a step.
    static func ordinal(_ s: XOSetupAttributes.ContentState) -> String? {
        guard s.state == "running" || s.state == "waiting" else { return nil }
        if let fill = s.fill { return "\(fill / 10)%" }
        return "Step \(min(s.step + 1, max(s.of, 1))) of \(max(s.of, 1))"
    }

    /// The bar: how far the step has got when that is known, which is what
    /// moves during the edge router's build, otherwise the steps done. As
    /// (value, total) for a ProgressView.
    static func bar(_ s: XOSetupAttributes.ContentState) -> (Double, Double) {
        if let fill = s.fill { return (Double(min(max(fill, 0), 1000)), 1000) }
        return (Double(min(s.step, s.of)), Double(max(s.of, 1)))
    }

    /// Still moving: an activity in this state is updated, not ended.
    static func isLive(_ state: String) -> Bool { state == "running" || state == "waiting" }

    /// What the Lock Screen says once the content has gone stale and the job
    /// was still live when last heard of: not that it stopped, which nobody
    /// knows, only since when nothing has been heard (C-5). The time is
    /// named when the content carries it; content the coordinator pushed
    /// does not, and then the sentence has no time in it rather than one
    /// made up here.
    static func silence(_ s: XOSetupAttributes.ContentState) -> String {
        if let since = s.since {
            return "No word since \(since.formatted(date: .omitted, time: .shortened)). Open Fleetwright to check."
        }
        return "No word for a while. Open Fleetwright to check."
    }
}
