package network.thetech.fleetwright

/**
 * The public demo fleet: two invented hosts, three invented sessions.
 *
 * WHY THIS IS A CONSTANT IN THE APK AND NOT A SECRET.
 *
 * The demo answers on its OWN HOSTNAME, and `worker.js` matches that hostname
 * above the host routes — so a request there never reaches enrolment, a
 * websocket, sign-in, or the Durable Object. The demo is not "the real
 * coordinator, answering carefully"; it is a door that opens onto invented
 * data and nothing else. Nobody holding any of this can see or stop real work.
 *
 * So shipping it costs nothing and buys the thing that was missing: a person
 * who wants to see the app work no longer has to find a token in a deployment
 * document and paste it into a field labelled "credential".
 *
 * KEPT IN STEP BY CI, not by memory: `test/demo-button.test.js` reads this
 * file, its iOS twin, and `worker/wrangler.toml`, and fails if they disagree.
 * Changing the host without shipping both apps would otherwise leave every
 * installed build pointed at a domain that no longer serves a demo, and the
 * failure would read as "the app is broken".
 */
object Demo {
    const val COORDINATOR_URL = "https://fleetdemo.thetech.network"

    /**
     * Sent for symmetry with the real fleet, not because it is checked: on the
     * demo host every reply is built from constants and no credential changes
     * the answer. It stays so the app has one code path, and so the token route
     * keeps working for anyone pointed at the main domain.
     */
    const val CREDENTIAL = "demo-3a2ec7773eabcd4e38a9a880296a4e4b"

    /** Shown where an email would be: not "signed in", but "looking at a fleet that isn't real". */
    const val LABEL = "the demo fleet"

    /**
     * Is this device in the demo? Keyed on the HOST, because that is what
     * decides what comes back — the credential is along for the ride.
     */
    fun isActive(url: String): Boolean =
        url.trim().lowercase().startsWith(COORDINATOR_URL)
}

/**
 * Turning what somebody typed into a URL that works.
 *
 * Written after two real ways to end up with a coordinator that silently does
 * nothing, neither of which is the person's fault:
 *
 *  - **No scheme.** `fleet.thetech.network` is what a person says out loud and
 *    what a keyboard offers back, and it is not a URL any HTTP client will
 *    accept — so the request fails with an error about the reply rather than
 *    about the address.
 *  - **A space in it.** Autocorrect will happily put one after a dot. Guessing
 *    here is safe in a way it usually is not: no legal hostname contains a
 *    space, so there is exactly one thing the person could have meant.
 *
 * Deliberately does NOT upgrade a typed `http://` to https. Somebody who wrote
 * it meant it — a coordinator on a laptop over a tailnet is a real thing — and
 * quietly changing a scheme somebody chose is how "it works in the terminal and
 * not in the app" gets born.
 */
object CoordinatorUrl {
    fun normalise(raw: String): String {
        // Every kind of whitespace, anywhere, not only the ends: a URL pasted
        // out of an email can carry a newline in the middle of it.
        val bare = raw.filterNot { it.isWhitespace() }
        if (bare.isEmpty()) return ""
        val lowered = bare.lowercase()
        val withScheme =
            if (lowered.startsWith("https://") || lowered.startsWith("http://")) bare else "https://$bare"
        // One trailing slash is the difference between /api/list and //api/list,
        // and the second is a 404 that reads like the fleet is down.
        return withScheme.trimEnd('/')
    }
}
