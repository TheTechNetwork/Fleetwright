import XCTest

@testable import Fleetwright

/// A reply made entirely of whitespace is not something to quote.
///
/// WHAT WAS SEEN. The sessions screen showed the reassurance banner and then a
/// dark card the height of the phone with nothing on it. The report was that
/// Output "seems to show this — could be a bad version of an image or
/// something", which is the right reading of a large empty rectangle and the
/// wrong diagnosis.
///
/// It was not an image. `tmux capture-pane` returns every row of the visible
/// region, so a session that has printed nothing answers with forty newlines
/// rather than with nothing at all — and `isEmpty` is false for that string,
/// so the gate on the card let it through and the app drew it faithfully.
///
/// The host no longer sends it. This is here because a phone talks to whatever
/// host that fleet is running, which is not always the newest one.
final class BlankReplyTests: XCTestCase {

    func testEmptyIsBlank() {
        XCTAssertTrue("".isBlank)
    }

    func testWhatTmuxReturnsForAnIdlePaneIsBlank() {
        // Measured, not imagined: `tmux new-session -d -s probe -x 80 -y 40`
        // followed by `capture-pane -p -S -60` returns exactly this — forty
        // newlines, zero other characters.
        let idlePane = String(repeating: "\n", count: 40)

        XCTAssertFalse(idlePane.isEmpty, "the string is not empty, which is the whole bug")
        XCTAssertTrue(idlePane.isBlank, "and it is blank, which is the question the app should be asking")
    }

    func testSpacesAndTabsAndNewlinesTogetherAreBlank() {
        XCTAssertTrue("   \n\t\n  \r\n".isBlank)
    }

    func testOutputIsNotBlank() {
        // The fix must not swallow anything a session actually printed —
        // including a pane whose only content is the box the TUI draws.
        XCTAssertFalse("built in 4.1s".isBlank)
        XCTAssertFalse("\n\n  ─────────────  \n\n".isBlank)
        XCTAssertFalse("0".isBlank)
    }
}
