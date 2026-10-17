package network.thetech.fleetwright

/**
 * The one hidden thing in the app.
 *
 * Tap the build line at the foot of You seven times, the way this phone
 * unlocks its own developer options, and one line appears under it. That is
 * all it does. It changes no setting and reports no state: a joke that said
 * the fleet was fine would be a claim with nothing behind it, in an app whose
 * whole job is claims with something behind them.
 *
 * The count and the words are in test/fixtures/parity/eggs.json, and
 * EggsTest.kt and iOS's EggsTests.swift both run its cases, so the two phones
 * cannot drift apart on a joke either.
 */
object Eggs {
    const val TAPS = 7
    const val LINE = "Seven taps unlocks developer options on a phone. This app has no hidden settings, only this line."

    /** The line to show after this many taps, or null while it is still hidden. */
    fun buildLine(taps: Int): String? = if (taps >= TAPS) LINE else null
}
