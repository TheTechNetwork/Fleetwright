package network.thetech.fleetwright

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The decision a lock-screen button makes, run rather than read.
 *
 * WHY THIS IS A JUNIT TEST AND NOT A NODE GREP. `test/notification-answers.test.js`
 * holds the words on the buttons equal with the fleet's own, which is a question
 * about two files and is answerable by reading them. Whether a press becomes the
 * right digit, and whether an hour-old notification is refused, are questions
 * about a function — and the only thing that answers those is running it. The
 * reassurance table made this argument first and this file is the second
 * instance of it, matching `NotificationAnswersTests.swift` case for case so
 * "both phones agree" is a thing somebody can check by reading two files
 * side by side.
 *
 * A PLAIN JVM TEST, no Robolectric: everything below is Kotlin and a map. The
 * parts that need Android — building the notification, the PendingIntent flags,
 * the receiver — are not here, and pretending a unit test covers them would be
 * worse than saying so.
 */
class NotificationAnswersTest {

    private val sentAt = 1_700_000_000_000L

    private fun payload(
        name: String? = "cc-brave-otter",
        promptId: String? = "deadbeef",
        answers: String? = "a:1,b:3",
        sentAt: String? = "1700000000000",
    ): Map<String, String> = buildMap {
        name?.let { put("name", it) }
        promptId?.let { put("promptId", it) }
        answers?.let { put("answers", it) }
        sentAt?.let { put("sentAt", it) }
    }

    // --- which digit a button types -----------------------------------------

    @Test
    fun `each button types the digit the host resolved`() {
        // NOT 1 AND 2. The permission dialog's "no" is the third option once
        // "don't ask me again" is dropped, which is exactly why the digit
        // travels with the notification instead of living in this app.
        assertEquals(
            NotificationAnswers.Decision.Answer("cc-brave-otter", 1, "deadbeef"),
            NotificationAnswers.decide(NotificationAnswers.slotA, payload(), sentAt),
        )
        assertEquals(
            NotificationAnswers.Decision.Answer("cc-brave-otter", 3, "deadbeef"),
            NotificationAnswers.decide(NotificationAnswers.slotB, payload(), sentAt),
        )
    }

    @Test
    fun `a renumbered dialog moves the digit and not the button`() {
        assertEquals(
            NotificationAnswers.Decision.Answer("cc-brave-otter", 2, "deadbeef"),
            NotificationAnswers.decide(NotificationAnswers.slotA, payload(answers = "a:2,b:3"), sentAt),
        )
    }

    @Test
    fun `tapping the notification itself still just opens it`() {
        assertEquals(
            NotificationAnswers.Decision.Open("cc-brave-otter"),
            NotificationAnswers.decide(null, payload(), sentAt),
        )
    }

    // --- the hour ------------------------------------------------------------

    @Test
    fun `an answer is offered for exactly as long as it was deliverable`() {
        val onTheEdge = sentAt + NotificationAnswers.windowSeconds * 1000L
        assertEquals(
            NotificationAnswers.Decision.Answer("cc-brave-otter", 1, "deadbeef"),
            NotificationAnswers.decide(NotificationAnswers.slotA, payload(), onTheEdge),
        )
        assertEquals(
            NotificationAnswers.Decision.Stale("cc-brave-otter"),
            NotificationAnswers.decide(NotificationAnswers.slotA, payload(), onTheEdge + 1),
        )
    }

    @Test
    fun `a payload with no sentAt is treated as too old`() {
        // ERRING TOWARDS REFUSING. A missing sentAt means a payload this app
        // does not understand, and the wrong side to be wrong on is the one
        // that types an approval into an unknown question.
        assertEquals(
            NotificationAnswers.Decision.Stale("cc-brave-otter"),
            NotificationAnswers.decide(NotificationAnswers.slotA, payload(sentAt = null), sentAt),
        )
    }

    // --- a payload this app cannot act on opens rather than guessing ---------

    @Test
    fun `anything missing opens the session instead of sending something`() {
        val cases = mapOf(
            "no session name" to payload(name = null),
            "no prompt id" to payload(promptId = null),
            "no answers" to payload(answers = null),
            "an unparseable pairing" to payload(answers = "yes please"),
            "a slot this button is not" to payload(answers = "b:3"),
            "an option the answer verb would refuse" to payload(answers = "a:0,b:3"),
            "an option outside one to nine" to payload(answers = "a:42,b:3"),
        )
        for ((what, data) in cases) {
            val decision = NotificationAnswers.decide(NotificationAnswers.slotA, data, sentAt)
            assertTrue("$what produced $decision rather than opening the session",
                decision is NotificationAnswers.Decision.Open)
        }
    }

    // --- which two words a notification's buttons say ------------------------

    @Test
    fun `the category names the kind, and an unknown one offers nothing`() {
        assertEquals(
            NotificationAnswers.Answers("Allow this once", "Do not allow"),
            NotificationAnswers.titlesFor("${NotificationAnswers.categoryPrefix}.permission"),
        )
        assertEquals(
            NotificationAnswers.Answers("From a summary", "In full"),
            NotificationAnswers.titlesFor("${NotificationAnswers.categoryPrefix}.resume"),
        )
        // A kind from a fleet newer than this app builds no buttons rather than
        // guessing at words for it, and a notification with no category at all
        // is every notification that came before this feature.
        assertNull(NotificationAnswers.titlesFor("${NotificationAnswers.categoryPrefix}.something-new"))
        assertNull(NotificationAnswers.titlesFor("some.other.category"))
        assertNull(NotificationAnswers.titlesFor(null))
    }

    @Test
    fun `the receiver reads exactly the fields a button needs`() {
        // The extras are built from a push this app does not control, so they
        // are named rather than copied wholesale — and the list the notification
        // fills in has to be the list `decide` reads, or a button ends up
        // depending on a field nobody put in the intent.
        assertEquals(listOf("name", "promptId", "answers", "sentAt"), AnswerReceiver.KEYS)
    }
}
