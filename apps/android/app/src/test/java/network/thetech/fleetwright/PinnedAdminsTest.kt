package network.thetech.fleetwright

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Whether a machine that pins its own admins takes update, upgrade, reboot and
 * a restore from this person. Same cases as iOS's `HostPinnedAdminsTests.swift`.
 *
 * WHAT IS PINNED: that a machine which cannot pin, or pins nobody, leaves the
 * buttons as they were; that one which pins somebody else takes those verbs
 * from them alone, and a person's own restore from that person; and that a
 * record the machine cannot read takes them from nobody (C-5). Which controls
 * sit behind it is read by test/pinned-admins-in-apps.test.js.
 */
class PinnedAdminsTest {

    private val mine = Fleet.Binned(name = "mine", title = null, expiresAt = 0L, createdBy = "fleet:bea@example.com")
    private val theirs = Fleet.Binned(name = "theirs", title = null, expiresAt = 0L, createdBy = "fleet:ada@example.com")

    private fun host(admins: Fleet.PinnedAdmins?) =
        Fleet.FleetHost(
            hostId = "deb132",
            state = "healthy",
            reason = null,
            loggedIn = null,
            accountEmail = null,
            accountPlan = null,
            accountOrg = null,
            version = null,
            behind = null,
            systemUpdates = null,
            rebootRequired = false,
            bin = listOf(mine, theirs),
            admins = admins,
        )

    private fun admins(count: Int?, you: Boolean?) =
        Fleet.PinnedAdmins(count = count, you = you, pinned = null, left = null, problem = null)

    @Test
    fun aMachineThatCannotPinOrPinsNobodyIsAsBefore() {
        for (h in listOf(host(null), host(admins(0, false)))) {
            assertTrue(h.boxWideAllowed)
            assertTrue(h.mayRestore(theirs, "bea@example.com"))
        }
    }

    @Test
    fun aPinnedAdminMayAndSomebodyElseMayOnlyRestoreTheirOwn() {
        assertTrue(host(admins(1, true)).boxWideAllowed)
        val other = host(admins(1, false))
        assertFalse(other.boxWideAllowed)
        assertTrue(other.mayRestore(mine, "Bea@Example.com"))
        assertFalse(other.mayRestore(theirs, "bea@example.com"))
    }

    @Test
    fun aRecordTheMachineCannotReadTakesNothing() {
        val h = host(admins(null, null))
        assertFalse(h.boxWideAllowed)
        assertFalse(h.mayRestore(mine, "bea@example.com"))
    }
}
