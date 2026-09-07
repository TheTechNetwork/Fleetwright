import Foundation

/// Launching the app in a known state, so store screenshots can be taken by a
/// script instead of a person.
///
/// WHY THIS EXISTS. Screenshots were the last stage of the release that needed
/// somebody at a laptop with a file picker: the pipeline builds, signs,
/// uploads, distributes to testers, writes the listing and submits for review,
/// and stopped at the pictures. They are also the worst stage to leave manual —
/// per device size AND per locale, refused all at once by App Review, and
/// silently stale the moment the UI changes.
///
/// WHAT IT CAN AND CANNOT SET, because a launch argument that could configure
/// anything would be a way to point somebody's app somewhere without them
/// noticing:
///
///   IT SETS THE PUBLIC DEMO AND NOTHING ELSE. The values are `Demo`'s
///     compiled-in constants — the same ones the Demo button in Settings uses,
///     against a coordinator that `worker.js` answers from constants without
///     ever reaching a Durable Object. There is no argument here that takes a
///     URL, a token, or an email; the only choice is "the demo, or not".
///
///   IT SELECTS A TAB. A name from a fixed set, matched exhaustively, so an
///     unknown value opens the app normally rather than doing something
///     inventive.
///
/// That is what makes `simctl` enough. The alternative was a UI test target
/// that taps its way to each screen, which is a second app to maintain and a
/// navigation change away from breaking — and the screenshots would then be
/// wrong rather than missing, which is worse.
enum Screenshots {
    /// Point this launch at the public demo fleet.
    ///
    /// NOT PERSISTED AS A DECISION SOMEBODY MADE. It writes the same settings
    /// the Demo button writes, which the app already knows how to leave.
    static var wantsDemo: Bool {
        ProcessInfo.processInfo.arguments.contains("-fleetwright-demo")
    }

    /// Which tab to open on, when a screenshot wants a particular screen.
    ///
    /// Returns nil for absent AND for anything unrecognised — an argument this
    /// does not know is not a reason to guess.
    static var tab: String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-fleetwright-tab"), i + 1 < args.count else { return nil }
        let name = args[i + 1]
        return ["sessions", "fleet", "settings"].contains(name) ? name : nil
    }

    /// True when this launch is being photographed, which is the one thing the
    /// UI may legitimately change for: transient chrome that happens to be on
    /// screen when the shutter falls is noise on a store page.
    static var active: Bool { wantsDemo || tab != nil }
}
