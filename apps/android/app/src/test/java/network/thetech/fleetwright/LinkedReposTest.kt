package network.thetech.fleetwright

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A linked-repository check and a session's archive, read back as the words a
 * person sees (#346). Same words as iOS's `LinkedReposTests.swift`, case for
 * case.
 *
 * WHAT IS PINNED: that an archive reads its visibility as "Private" and the
 * others as "Public", that an answer nobody could give reads "can't tell" and
 * never "no", and that a session with an archive and no push yet says nothing
 * has been pushed rather than implying it was.
 */
class LinkedReposTest {

    private fun check(role: String, isPublic: Boolean?, installed: Boolean?, contents: String?, push: Boolean?, carries: List<String>?) =
        Fleet.LinkedRepoCheck(
            role = role,
            repo = "Eli/Work",
            isPublic = isPublic,
            installed = installed,
            contents = contents,
            push = push,
            carries = carries,
            ok = true,
            message = "fine",
            runnerRepo = null,
        )

    @Test
    fun anArchiveSaysPrivateAndWhoCanPush() {
        assertEquals(
            "Private: yes · GitHub app: yes · Can write: yes · You can push: can't tell",
            describeLinkedCheck(check("archive", false, true, "write", null, null)),
        )
    }

    @Test
    fun templatesSayWhatTheyCarry() {
        assertEquals(
            "Public: yes · GitHub app: can't tell · Can read: yes · Carries: .claude, default.json",
            describeLinkedCheck(check("templates", true, null, "read", null, listOf(".claude", "default.json"))),
        )
    }

    @Test
    fun nothingLinkedIsSaidPerRole() {
        assertEquals("Nothing linked. Session work is not saved. Start a private one from github.com/TheTechNetwork/Fleetwright-Archive.", describeLinkedRole("archive", null, null))
        assertEquals("Linked: eli/presets.", describeLinkedRole("templates", "eli/presets", null))
        assertEquals("Nothing linked. Start one from github.com/TheTechNetwork/Fleetwright-Templates.", describeLinkedRole("templates", null, null))
        assertEquals(
            "Using the fleet's: fleet/runners",
            describeLinkedRole("runners", null, "fleet/runners"),
        )
        assertEquals("none linked", describeLinkedRepos(0))
        assertEquals("2 of 3 linked", describeLinkedRepos(2))
    }

    @Test
    fun aSessionSaysWhetherItsArchiveLanded() {
        fun session(archive: String?, at: Long? = null, ok: Boolean? = null, text: String? = null) =
            Fleet.Session(
                name = "job", title = null, status = "running", hostId = null, rcUrl = null, resumable = false,
                archive = archive, archiveAt = at, archiveOk = ok, archiveText = text,
            )
        assertNull(session(null).archiveLine)
        assertEquals("Saves to Eli/Work when it stops. Not saved yet.", session("Eli/Work").archiveLine)
        assertEquals(
            "Archived to Eli/Work on fleetwright/deb14/job-x.",
            session("Eli/Work", 1, true, "Archived to Eli/Work on fleetwright/deb14/job-x.").archiveLine,
        )
    }
}
