package network.thetech.fleetwright

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The two additive facts the host sends about sessions and accounts, read back
 * as the words a person sees. Same words as iOS's `ContextAndUsageTests.swift`,
 * case for case, so "both phones agree" is a thing somebody can check by
 * reading two files side by side.
 *
 * WHAT IS PINNED: that a count is drawn as a count and never as a percentage;
 * that a session not running draws nothing whatever was recorded; and that a
 * row with no answer says why in the host's words rather than reading as 0%.
 */
class ContextAndUsageTest {

    private fun session(status: String, context: Fleet.Session.ContextUsage?) = Fleet.Session(
        name = "job", title = null, status = status, hostId = null, rcUrl = null, resumable = false, context = context,
    )

    @Test
    fun anOlderHostDrawsNothing() {
        assertNull(session("running", null).contextLine)
    }

    @Test
    fun contextIsACountInCoarseUnits() {
        assertEquals("248k in context", session("running", Fleet.Session.ContextUsage(248_717, "claude-fable-5-1")).contextLine)
        assertEquals("412 tokens in context", session("running", Fleet.Session.ContextUsage(412, null)).contextLine)
        assertEquals("1.2M in context", session("running", Fleet.Session.ContextUsage(1_200_000, null)).contextLine)
        // Not running: whatever was recorded, it is not in a window now.
        assertNull(session("stopped", Fleet.Session.ContextUsage(248_717, null)).contextLine)
        // The host said null for the count — cannot tell — and nothing is drawn.
        assertNull(session("running", Fleet.Session.ContextUsage(null, "m")).contextLine)
    }

    private val now = 1_700_000_000_000L

    @Test
    fun usageIsTheEndpointsFiguresWithTheResetOnThePhonesClock() {
        val a = Fleet.AccountUsage(
            account = "a@example.com",
            usage = Fleet.AccountUsage.Windows(
                fiveHour = Fleet.AccountUsage.Window(42.4, now + 7_200_000),
                sevenDay = Fleet.AccountUsage.Window(12.0, null),
                sevenDayOpus = null,
                sevenDaySonnet = null,
            ),
            why = null,
        )
        assertEquals("a@example.com · 5h 42% · resets in 2h · 7d 12%", describeUsage(a, now))
        assertFalse(a.isNearLimit)

        val b = Fleet.AccountUsage("b@example.com", null, "the credential has expired and has not renewed yet")
        assertEquals("b@example.com · usage not reported — the credential has expired and has not renewed yet", describeUsage(b, now))
        assertFalse("no figure is not a spent one", b.isNearLimit)

        val c = Fleet.AccountUsage(
            account = "c@example.com",
            usage = Fleet.AccountUsage.Windows(
                fiveHour = Fleet.AccountUsage.Window(95.0, now + 60_000),
                sevenDay = null,
                sevenDayOpus = Fleet.AccountUsage.Window(50.0, null),
                sevenDaySonnet = null,
            ),
            why = null,
        )
        assertEquals("c@example.com · 5h 95% · resets in 1m · Opus 7d 50%", describeUsage(c, now))
        assertTrue(c.isNearLimit)
    }

    @Test
    fun aWindowWithNoFigureIsNotReported() {
        val row = Fleet.AccountUsage("a@example.com", Fleet.AccountUsage.Windows(Fleet.AccountUsage.Window(null, null), null, null, null), null)
        assertEquals("a@example.com · usage not reported", describeUsage(row, now))
    }

    @Test
    fun untilIsCoarse() {
        val now = 1_000_000L
        assertEquals("now", describeUntil(now - 1, now))
        assertEquals("1m", describeUntil(now + 30_000, now))
        assertEquals("1h", describeUntil(now + 5_400_000, now))
        assertEquals("2d", describeUntil(now + 200_000_000, now))
    }
}
