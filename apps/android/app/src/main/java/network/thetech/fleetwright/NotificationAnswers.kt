package network.thetech.fleetwright

/**
 * Answering a session's question from the notification, and refusing to when
 * the question has probably moved on.
 *
 * THE WORDS ARE THE FLEET'S AND THE DIGITS ARE THE PANE'S, which is the same
 * split iOS makes and for a reason that starts there: a `UNNotificationAction`
 * title is fixed when the app registers its categories, so the buttons cannot
 * say what the CLI's options say. Android could do better — it builds its
 * actions per notification and could put any label on them — and deliberately
 * does not, because two phones offering different words for the same question
 * is the drift `docs/app-parity.md` exists to prevent, and because the labels
 * are exactly what `AGENT_FLEET_PROMPT_TEXT` may refuse to send.
 *
 * So the words are copied from `ANSWER_TITLES` in `src/fleet/host/prompt.js`,
 * `test/notification-answers.test.js` fails the day they disagree, and the
 * digit each button types arrives in `answers` because the host resolved it
 * against the pane it actually drew.
 */
object NotificationAnswers {
    /**
     * The prefix the coordinator names its categories under, with the kind of
     * question appended. Declared in `src/fleet/coordinator/core.js`.
     *
     * Android has no notion of a notification category the way iOS does; this
     * app reads the field to learn WHICH question it is being asked, which is
     * what decides the two words. Same string, two uses, one source.
     */
    const val categoryPrefix = "fleet.prompt"

    /** The two buttons, in order. These come back as the action intent's own action. */
    const val slotA = "fleet.answer.a"
    const val slotB = "fleet.answer.b"

    /**
     * How long after it was sent a notification may still be answered.
     *
     * ONE HOUR, AND IT IS THE SAME HOUR THE COORDINATOR WOULD HAVE DELIVERED IT
     * FOR. `PUSH_TTL_S` in `src/fleet/push.js` is how long a provider may hold
     * a notification before dropping it, chosen as "long enough for a phone in
     * a pocket on a train, short enough that a question answered from a lock
     * screen next morning is not one the host asked yesterday". Both clocks
     * start at the same `sentAt`, so reusing it makes the rule sayable in one
     * line: a notification is answerable for exactly as long as it was
     * deliverable.
     */
    const val windowSeconds = 3600

    /** The words the fleet put on the buttons, by the kind of question. */
    data class Answers(val a: String, val b: String)

    val titles = mapOf(
        "resume" to Answers("From a summary", "In full"),
        "trust" to Answers("Trust this folder", "Do not trust it"),
        "permission" to Answers("Allow this once", "Do not allow"),
    )

    /** The two words for a payload's category, or null if there is nothing to offer. */
    fun titlesFor(category: String?): Answers? {
        val kind = category?.removePrefix("$categoryPrefix.")?.takeIf { it != category } ?: return null
        return titles[kind]
    }

    /** What a tap means, once the clock has been consulted. */
    sealed interface Decision {
        /** Send it: the question is still young enough to be the one on screen. */
        data class Answer(val name: String, val option: Int, val promptId: String) : Decision

        /**
         * A button was tapped on a notification too old to answer. Open the
         * session so the decision is made against what is there now.
         */
        data class Stale(val name: String) : Decision

        /** Not one of our buttons, or a payload this app cannot act on. */
        data class Open(val name: String?) : Decision
    }

    /**
     * Read a tap.
     *
     * `sentAt` HAS BEEN IN EVERY ENVELOPE SINCE #351 AND NOTHING HAS EVER READ
     * IT. That was harmless while a tap only navigated: the session list is
     * refreshed from the coordinator, so arriving late landed on current
     * information. A button is not harmless — a notification answered an hour
     * after it was sent answers whatever the pane says now.
     *
     * The host's `promptId` is still the real guard and is still checked there.
     * This is the half that can be done before the network, so somebody gets a
     * sentence instead of a silent refusal.
     *
     * A MISSING `sentAt` IS TREATED AS TOO OLD rather than as fresh. It means a
     * payload this app does not understand, and the wrong side to be wrong on
     * is the one that types an approval into an unknown question.
     */
    fun decide(
        action: String?,
        data: Map<String, String>,
        nowMillis: Long = System.currentTimeMillis(),
    ): Decision {
        val name = data["name"]?.takeIf { it.isNotBlank() }

        if (action != slotA && action != slotB) return Decision.Open(name)

        val promptId = data["promptId"]?.takeIf { it.isNotBlank() }
        val option = optionFor(action, data["answers"])
        // A button with nothing behind it opens rather than guessing. It should
        // not happen — the coordinator sends a category only when it sends the
        // answers — but a notification is the one surface whose payload was
        // written by a version of the fleet this app has never met.
        if (name == null || promptId == null || option == null) return Decision.Open(name)

        val sentAt = data["sentAt"]?.toLongOrNull()?.takeIf { it > 0 }
        if (sentAt == null || nowMillis - sentAt > windowSeconds * 1000L) return Decision.Stale(name)
        return Decision.Answer(name, option, promptId)
    }

    /**
     * `a:1,b:3` — which digit this button types.
     *
     * Parsed rather than trusted: this string crossed a provider to get here,
     * and the `answer` verb takes a single digit (see
     * `src/fleet/protocol/intents.js`). Anything else is not an option, and an
     * unparseable pairing opens the session instead of sending a number the
     * fleet would refuse.
     */
    fun optionFor(action: String?, answers: String?): Int? {
        if (answers == null) return null
        val slot = if (action == slotA) "a" else "b"
        for (pair in answers.split(",")) {
            val parts = pair.split(":")
            if (parts.size != 2 || parts[0] != slot) continue
            val option = parts[1].toIntOrNull() ?: return null
            return if (option in 1..9) option else null
        }
        return null
    }
}
