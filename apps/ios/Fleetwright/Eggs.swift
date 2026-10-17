import Foundation

/// The hidden things in the app. Two of them.
///
/// Tap the build line at the foot of You seven times, the way a phone unlocks
/// its developer options, and one line appears under it. That is all it does.
/// It changes no setting and reports no state: a joke that said the fleet was
/// fine would be a claim with nothing behind it, in an app whose whole job is
/// claims with something behind them.
///
/// Pull the session list to refresh four times inside a minute, and one line
/// says the hosts report on their own. docs/psychology.md is about the
/// anxiety this product exists to bound, and pulling a list over and over is
/// what that anxiety looks like in a hand; the line is for that hand.
///
/// The counts and the words are in `test/fixtures/parity/eggs.json`, and
/// `EggsTests.swift` and Android's `EggsTest.kt` both run its cases, so the two
/// phones cannot drift apart on a joke either.
enum Eggs {
    static let taps = 7
    static let line = "Seven taps unlocks developer options on a phone. This app has no hidden settings, only this line."

    /// The line to show after this many taps, or nil while it is still hidden.
    static func buildLine(taps count: Int) -> String? {
        count >= taps ? line : nil
    }

    static let pullCount = 4
    static let pullWindow: TimeInterval = 60
    static let pullingLine = "Pulling again does not make a host report sooner. Each one reports on its own, whether or not anybody is pulling."

    /// The line to show after these pulls, or nil. `pulls` are seconds, oldest
    /// first; the newest is "now", so a pull after a quiet minute clears it.
    static func pullLine(_ pulls: [TimeInterval]) -> String? {
        guard let last = pulls.last else { return nil }
        return pulls.filter { last - $0 <= pullWindow }.count >= pullCount ? pullingLine : nil
    }
}
