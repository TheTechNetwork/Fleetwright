package network.thetech.fleetwright

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A reply made entirely of whitespace is not something to quote.
 *
 * WHAT WAS SEEN, on the other phone. The sessions screen showed the
 * reassurance banner and then a dark card the height of the screen with
 * nothing on it. The report was that Output "seems to show this — could be a
 * bad version of an image or something", which is the right reading of a large
 * empty rectangle and the wrong diagnosis.
 *
 * It was not an image. `tmux capture-pane` returns every row of the visible
 * region, so a session that has printed nothing answers with forty newlines
 * rather than with nothing at all. iOS gated its card on `isEmpty` and drew
 * that faithfully. This app gates on `isNotBlank()` and drew nothing — which
 * is better and still not right: a button that reports nothing when it is
 * pressed is a button somebody presses again.
 *
 * Matches `BlankReplyTests.swift` case for case, so "both phones agree" is a
 * thing somebody can check by reading two files side by side.
 */
class BlankReplyTest {

    @Test
    fun `an empty reply falls through to the sentence`() {
        assertEquals("nothing yet", "".said("nothing yet"))
    }

    @Test
    fun `what tmux returns for an idle pane falls through too`() {
        // Measured, not imagined: `tmux new-session -d -s probe -x 80 -y 40`
        // followed by `capture-pane -p -S -60` returns exactly this — forty
        // newlines, zero other characters.
        val idlePane = "\n".repeat(40)

        assertTrue("the string is not empty, which is the whole bug", idlePane.isNotEmpty())
        assertEquals("nothing yet", idlePane.said("nothing yet"))
    }

    @Test
    fun `spaces and tabs and newlines together are nothing`() {
        assertEquals("nothing yet", "   \n\t\n  \r\n".said("nothing yet"))
    }

    @Test
    fun `with no sentence offered, nothing is the empty string`() {
        // Which is what every gate in this app already tests for. The default
        // is for the verbs whose answer is the list refreshing underneath.
        assertEquals("", "\n\n\n".said())
    }

    @Test
    fun `output is kept, with the padding off`() {
        assertEquals("built in 4.1s", "\n\nbuilt in 4.1s\n\n\n".said("nothing yet"))
        assertEquals("0", "0".said("nothing yet"))
    }

    @Test
    fun `a pane whose only content is a drawn box is content`() {
        // The fix must not swallow a TUI that has drawn its frame and nothing
        // else. There is something on that screen.
        assertEquals("─────────────", "\n\n  ─────────────  \n\n".said("nothing yet"))
    }

    @Test
    fun `the spacing inside output is left alone`() {
        // Interior blank lines are how output is spaced. Closing them up would
        // rewrite what the session printed.
        assertEquals("one\n\ntwo", "\none\n\ntwo\n".said("nothing yet"))
    }
}
