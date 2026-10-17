import Foundation

/// The one hidden thing in the app.
///
/// Tap the build line at the foot of You seven times, the way a phone unlocks
/// its developer options, and one line appears under it. That is all it does.
/// It changes no setting and reports no state: a joke that said the fleet was
/// fine would be a claim with nothing behind it, in an app whose whole job is
/// claims with something behind them.
///
/// The count and the words are in `test/fixtures/parity/eggs.json`, and
/// `EggsTests.swift` and Android's `EggsTest.kt` both run its cases, so the two
/// phones cannot drift apart on a joke either.
enum Eggs {
    static let taps = 7
    static let line = "Seven taps unlocks developer options on a phone. This app has no hidden settings, only this line."

    /// The line to show after this many taps, or nil while it is still hidden.
    static func buildLine(taps count: Int) -> String? {
        count >= taps ? line : nil
    }
}
