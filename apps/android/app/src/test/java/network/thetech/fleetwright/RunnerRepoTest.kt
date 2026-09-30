package network.thetech.fleetwright

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A runner repository check, read back as the words a person sees. Same words
 * as iOS's `RunnerRepoTests.swift`, case for case.
 *
 * WHAT IS PINNED: that an answer nobody could give reads "can't tell" and
 * never "no", and that the sentence under the field says which repository is
 * in effect.
 */
class RunnerRepoTest {

    private fun check(isPublic: Boolean?, installed: Boolean?, actionsWrite: Boolean?, platforms: List<String>) =
        Fleet.RunnerRepoCheck(
            repo = "Eli/Runners",
            isPublic = isPublic,
            installed = installed,
            actionsWrite = actionsWrite,
            platforms = platforms,
            missing = emptyList(),
            ok = isPublic == true,
            message = "",
        )

    @Test
    fun everyAnswerIsNamed() {
        assertEquals(
            "Public: yes · GitHub app: yes · Actions write: yes · Machines: linux, macos",
            describeRunnerCheck(check(true, true, true, listOf("linux", "macos"))),
        )
    }

    @Test
    fun cannotTellIsNotNo() {
        // A personal token cannot see installations. That is not "not installed".
        assertEquals(
            "Public: no · GitHub app: can't tell · Actions write: can't tell · Machines: none",
            describeRunnerCheck(check(false, null, null, emptyList())),
        )
    }

    @Test
    fun theSentenceSaysWhichRepositoryIsInEffect() {
        assertEquals("Your machines come from Eli/Runners.", describeRunnerRepoSetting("Eli/Runners", "fleet/runners"))
        assertEquals(
            "Your machines come from the fleet's repository, fleet/runners. Set your own to use your free Actions minutes.",
            describeRunnerRepoSetting(null, "fleet/runners"),
        )
        assertTrue(describeRunnerRepoSetting(null, null).startsWith("Set a public repository"))
    }
}
