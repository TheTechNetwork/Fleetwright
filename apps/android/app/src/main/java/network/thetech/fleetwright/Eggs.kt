package network.thetech.fleetwright

/**
 * The hidden things in the app. Two of them.
 *
 * Tap the build line at the foot of You seven times, the way this phone
 * unlocks its own developer options, and one line appears under it. That is
 * all it does. It changes no setting and reports no state: a joke that said
 * the fleet was fine would be a claim with nothing behind it, in an app whose
 * whole job is claims with something behind them.
 *
 * Pull the session list to refresh four times inside a minute, and one line
 * says the hosts report on their own. docs/psychology.md is about the anxiety
 * this product exists to bound, and pulling a list over and over is what that
 * anxiety looks like in a hand; the line is for that hand.
 *
 * The counts and the words are in test/fixtures/parity/eggs.json, and
 * EggsTest.kt and iOS's EggsTests.swift both run its cases, so the two phones
 * cannot drift apart on a joke either.
 */
object Eggs {
    const val TAPS = 7
    const val LINE = "Seven taps unlocks developer options on a phone. This app has no hidden settings, only this line."

    /** The line to show after this many taps, or null while it is still hidden. */
    fun buildLine(taps: Int): String? = if (taps >= TAPS) LINE else null

    const val PULL_COUNT = 4
    const val PULL_WINDOW_SECONDS = 60L
    const val PULLING_LINE = "Pulling again does not make a host report sooner. Each one reports on its own, whether or not anybody is pulling."

    /**
     * The line to show after these pulls, or null. [pulls] are seconds, oldest
     * first; the newest is "now", so a pull after a quiet minute clears it.
     */
    fun pullLine(pulls: List<Long>): String? {
        val last = pulls.lastOrNull() ?: return null
        return if (pulls.count { last - it <= PULL_WINDOW_SECONDS } >= PULL_COUNT) PULLING_LINE else null
    }
}
