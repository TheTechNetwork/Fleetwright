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
 * sandboxed and is named as not having said (C-5); that whichever reason a
 * box gives for not containing a session, and however many, the session's
 * sheet says the same one sentence, who can resume it, because the reason
 * and its way on are the machine page's (docs/reviews/copy-2026-11-06.md,
 * 1); that the card says less still; that a coordinator too old to send
 * `administers` offers Resume as before; and that a refusal which is a
 * setting on the machine is titled as one. Where the line and the button sit
 * is read by test/unsandboxed-resume-android-in-apps.test.js.
 */
class ResumeKeptTest {

    private val without = "deb132 runs sessions without full isolation. Your admin can resume it."
    private val notSaid = "deb132 has not said whether it isolates sessions. Your admin can resume it."

    private fun host(administers: Boolean?, sandboxed: Boolean?, sandboxedWhy: String? = null, sandboxedAlso: List<String> = emptyList()) =
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
            sandboxedWhy = sandboxedWhy,
            sandboxedAlso = sandboxedAlso,
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
    fun aMemberIsToldWhoCanOnAMachineWithoutTheSandbox() {
        assertEquals(without, host(administers = false, sandboxed = false).resumeKept)
    }

    @Test
    fun aMachineThatSaysWhyIsToldTheSameSentence() {
        // Root, docker, an environment variable: each is the machine's
        // business and its admin's, said on the machine's page. A member
        // reading the session is told the same thing whichever it is, and
        // nothing a later box might say changes that.
        for (why in listOf("userns_root", "userns_docker", "userns_host", "unsafe_args", "off", "a_reason_from_later")) {
            assertEquals(why, without, host(administers = false, sandboxed = false, sandboxedWhy = why).resumeKept)
        }
    }

    @Test
    fun aMachineWithMoreThanOneReasonIsToldTheSameSentence() {
        val said = { why: String, also: List<String> ->
            host(administers = false, sandboxed = false, sandboxedWhy = why, sandboxedAlso = also).resumeKept
        }
        assertEquals(without, said("off", listOf("userns_root")))
        assertEquals(without, said("unsafe_args", listOf("userns_host", "userns_root")))
        assertEquals(without, said("userns_root", listOf("a_reason_from_later")))
    }

    @Test
    fun aMachineThatHasNotSaidIsNotTakenForSandboxed() {
        assertEquals(notSaid, host(administers = false, sandboxed = null).resumeKept)
    }

    @Test
    fun theCardSaysOnlyWhoCan() {
        assertEquals("Only an admin can resume this", Fleet.FleetHost.RESUME_KEPT_ROW)
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
