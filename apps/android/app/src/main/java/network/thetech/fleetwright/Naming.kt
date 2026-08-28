package network.thetech.fleetwright

/**
 * Turning "what is this about?" into a title.
 *
 * The blank name field asks for the hardest form of the information — a
 * compressed label — as the first input, about work that has not happened yet.
 * That is where people stall, and stalling at a text field is where they close
 * the app. So the description is what gets typed and the title is a suggestion.
 * See docs/naming.md.
 *
 * ON THE ON-DEVICE MODEL, and this is a deliberate omission rather than an
 * oversight:
 *
 * Gemini Nano through ML Kit GenAI is the right home for this, and it is not
 * wired up here. Adding `com.google.mlkit:genai-*` is a dependency I cannot
 * resolve or compile from this environment, and the one pipeline it would break
 * is the Android build that has to publish before anybody can sign in on their
 * phone. Shipping an unverifiable dependency into the release path to save a
 * round trip is a bad trade with somebody else's week.
 *
 * So the deterministic path is here and works today, and the model slots in
 * behind the same `suggest()` signature once one build has proved the base
 * compiles. What the caller sees does not change either way — which is the
 * property that made it safe to defer.
 *
 * AND IT IS NEVER ON THE CRITICAL PATH REGARDLESS. Gemini Nano is not on every
 * device. A feature that only works on a Pixel cannot be the only way to name a
 * session, so there has to be a good answer without it — and that answer is
 * this one.
 */
object Naming {
    /** Matches TITLE_MAX in src/core/text.js. A suggestion the server then refuses is worse than none. */
    const val MAX_TITLE = 60

    /** True when a model could be used. False today; see the note above. */
    val canSuggest: Boolean get() = false

    /**
     * A title for this brief. Never throws and never blocks: a naming feature
     * that can fail is a naming feature that stops a session starting.
     */
    suspend fun suggest(brief: String): String = fallback(brief)

    /**
     * The first few words, which is what somebody would have typed themselves.
     *
     * Not a placeholder to apologise for: "split the token check out of the
     * middleware" gives "split the token check out", which is recognisable in a
     * list a week later — the only job a title has.
     */
    fun fallback(brief: String): String =
        clean(brief.replace("\n", " ").split(" ").filter { it.isNotBlank() }.take(6).joinToString(" "))

    /**
     * Shared by every path, so a model answer and a fallback are subject to the
     * same rules and one cannot be acceptable where the other is not.
     *
     * Whitespace collapsing matches cleanText() on the server, so a title is not
     * silently rewritten between the phone and the record.
     */
    private fun clean(raw: String): String {
        var s = raw.replace("\"", "").replace("\n", " ").trim().trimEnd('.')
        s = s.split(" ").filter { it.isNotBlank() }.joinToString(" ")
        if (s.length > MAX_TITLE) {
            // Truncated on a WORD boundary. Cutting at exactly 60 characters
            // ends titles mid-word, which reads as a bug rather than a limit.
            val out = StringBuilder()
            for (word in s.split(" ")) {
                if (out.length + word.length + 1 > MAX_TITLE) break
                if (out.isNotEmpty()) out.append(' ')
                out.append(word)
            }
            s = if (out.isEmpty()) s.take(MAX_TITLE) else out.toString()
        }
        return s
    }
}
