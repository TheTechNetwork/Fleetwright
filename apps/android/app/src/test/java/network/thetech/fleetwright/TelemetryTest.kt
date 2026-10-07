package network.thetech.fleetwright

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What a session cost, how its run spent its time, and how long it has been
 * waiting on a person, read back as the words a person sees. Same words as
 * iOS's `TelemetryTests.swift`, case for case, so "both phones agree" is a
 * thing somebody can check by reading two files side by side.
 *
 * WHAT IS PINNED: that an older host draws nothing; that the open stretch is
 * added on the phone's clock; that the cost is Claude Code's figure said as
 * one ("at API prices", "at least" when it was not sure); and that nothing is
 * drawn as zero when it is really unknown.
 */
class TelemetryTest {

    private val now = 1_700_000_000_000L
    private val min = 60_000L

    private fun session(
        status: String = "running",
        startedAt: Long? = null,
        awaitingSince: Long? = null,
        phases: Fleet.Session.Phases? = null,
        spent: Fleet.Session.Spent? = null,
    ) = Fleet.Session(
        name = "j", title = null, status = status, hostId = null, rcUrl = null, resumable = false,
        startedAt = startedAt, awaitingSince = awaitingSince, phases = phases, spent = spent,
    )

    private fun phases(since: Long, current: String, currentSince: Long, working: Long, awaiting: Long, ready: Long) =
        Fleet.Session.Phases(since, current, currentSince, working, awaiting, ready)

    @Test
    fun anOlderHostDrawsNothing() {
        val s = session()
        assertNull(s.timeLine(now))
        assertNull(s.spentLine(now))
        assertNull(s.waitedFor(now))
        assertEquals("Working", s.stateSentence)
    }

    @Test
    fun waitingOnYouSaysForHowLongOnceItIsAMinute() {
        val long = session(awaitingSince = now - 12 * min)
        assertTrue("the host said so, even with no question it could read", long.isWaitingOnYou)
        assertEquals("12m", long.waitedFor(now))
        assertNull("under a minute is just waiting", session(awaitingSince = now - 20_000).waitedFor(now))
    }

    @Test
    fun theRunIsCountedApartWithTheOpenStretchOnThePhonesClock() {
        // Closed: 42m working, 3m on a dialog. Open: 70m at its prompt.
        val s = session(startedAt = now - 115 * min, phases = phases(now - 115 * min, "ready", now - 70 * min, 42 * min, 3 * min, 0))
        assertEquals("Worked 42m · waited on you 3m · at its prompt 1h 10m", s.timeLine(now))

        assertEquals("Worked under 1m", session(phases = phases(now - 20_000, "working", now - 20_000, 0, 0, 0)).timeLine(now))

        // A hub restart lost the first three hours, and the line says so.
        val late = session(startedAt = now - 300 * min, phases = phases(now - 120 * min, "working", now - 120 * min, 0, 0, 0))
        assertEquals("Worked 2h · counted for the last 2h", late.timeLine(now))

        assertNull(session(status = "stopped", phases = phases(1, "ready", 1, 1, 0, 0)).timeLine(now))
    }

    @Test
    fun theCostIsClaudeCodesFigureSaidAsOne() {
        assertEquals(
            "$12.40 at API prices · 48k tokens out",
            session(spent = Fleet.Session.Spent(12.4, true, 48_211, now - 60_000)).spentLine(now),
        )
        assertEquals(
            "at least $0.47 at API prices · 84 tokens out",
            session(status = "stopped", spent = Fleet.Session.Spent(0.4653, false, 84, 1)).spentLine(now),
        )
        // Mid-turn, the figure is from its last pause, and the line says when.
        assertEquals(
            "$835.96 at API prices · 4.6M tokens out · as of 12m ago",
            session(spent = Fleet.Session.Spent(835.96, true, 4_558_295, now - 12 * min)).spentLine(now),
        )
        assertNull("nothing known is not $0.00", session(spent = Fleet.Session.Spent(null, false, null, null)).spentLine(now))
    }
}
