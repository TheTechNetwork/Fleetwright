package network.thetech.fleetwright

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Whether a stopped session is offered Resume, and how a refused start is
 * titled. Same cases and words as iOS's `ResumeKeptTests.swift`.
 *
 * WHAT IS PINNED: the coordinator's rule (hosts.js runsSessionsFor), that a
 * resume runs only where sessions are sandboxed or for someone who
 * administers the machine; that a box which has not said is not taken for
 * sandboxed and is named as not having said (C-5); that a coordinator too old
 * to send `administers` offers Resume as before; and that a refusal which is a
 * setting on the machine is titled as one. Where the line and the button sit
 * is read by test/unsandboxed-resume-android-in-apps.test.js.
 */
class ResumeKeptTest {

    private fun host(administers: Boolean?, sandboxed: Boolean?) =
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
            sandboxed = sandboxed,
            administers = administers,
        )

    private fun refused(code: String?) = Fleet.Reply(ok = false, text = "", sessions = emptyList(), code = code)

    @Test
    fun anAdminKeepsResumeOnAMachineWithoutTheSandbox() {
        assertNull(host(administers = true, sandboxed = false).resumeKept)
    }

    @Test
    fun aSandboxedMachineResumesForAMember() {
        assertNull(host(administers = false, sandboxed = true).resumeKept)
    }

    @Test
    fun aMemberIsToldWhyOnAMachineWithoutTheSandbox() {
        assertEquals(
            "deb132 runs sessions without the sandbox, so only this fleet’s admin, or the one person it works for, can resume one there.",
            host(administers = false, sandboxed = false).resumeKept,
        )
    }

    @Test
    fun aMachineThatHasNotSaidIsNotTakenForSandboxed() {
        assertEquals(
            "deb132 has not said whether its sessions are sandboxed, so only this fleet’s admin, or the one person it works for, can resume one there until it is updated.",
            host(administers = false, sandboxed = null).resumeKept,
        )
    }

    @Test
    fun anOlderCoordinatorOffersResumeAsBefore() {
        assertNull(host(administers = null, sandboxed = false).resumeKept)
    }

    @Test
    fun aRefusalThatIsAMachineSettingIsTitledAsOne() {
        assertEquals("Not started: only admins run sessions there", refused("unsandboxed").refusedStartTitle)
        assertEquals("Not started: the machine needs an update", refused("host_outdated").refusedStartTitle)
        assertEquals("Could not start a session", refused("no_hosts").refusedStartTitle)
        assertEquals("Could not start a session", refused(null).refusedStartTitle)
    }
}
