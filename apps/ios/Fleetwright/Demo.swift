import Foundation

/// The public demo fleet: two invented hosts, three invented sessions.
///
/// WHY THIS IS A CONSTANT IN THE BINARY AND NOT A SECRET.
///
/// `AGENT_FLEET_DEMO_TOKEN` is a `[vars]` entry in `worker/wrangler.toml`, not
/// a secret, deliberately — it guards nothing worth guarding. `worker.js`
/// matches it BEFORE `env.FLEET` is touched, so there is no code path from a
/// request carrying it to a Durable Object, a host socket, or a real session.
/// Not "we check first": the object is never reached. Somebody holding this
/// cannot see or stop anybody's work.
///
/// So compiling it in costs nothing and buys the thing that was missing — a
/// person who wants to see the app work no longer has to find a token in a
/// deployment document and paste it into a field labelled "credential".
///
/// It is prefixed `demo-` so a request carrying it is obvious in a log at a
/// glance rather than being one opaque hex string among three.
///
/// KEPT IN STEP BY CI, not by memory: `test/demo-button.test.js` reads this
/// file and `worker/wrangler.toml` and fails if they disagree. Rotating the
/// token without shipping both apps would otherwise leave every installed
/// build with a credential the coordinator no longer accepts, and the failure
/// would look like "the demo is broken" rather than "somebody rotated a var".
enum Demo {
    /// ITS OWN HOSTNAME, which is what makes this safe to put behind a button.
    ///
    /// `worker.js` matches this host ABOVE the host routes, so a request here
    /// never reaches enrolment, a websocket, sign-in or the Durable Object.
    /// The demo is not "the real coordinator, answering carefully" — it is a
    /// door that opens onto three invented sessions and nothing else.
    static let coordinatorURL = "https://fleetdemo.thetech.network"

    /// Sent for symmetry with the real fleet, not because it is checked: on
    /// the demo host every reply is built from constants and no credential
    /// changes the answer. It stays so the app has one code path, and so the
    /// token route keeps working for anyone pointing at the main domain.
    static let credential = "demo-3a2ec7773eabcd4e38a9a880296a4e4b"

    /// Shown where an email would be, so the state is legible at a glance:
    /// this is not "signed in", it is "looking at a fleet that isn't real".
    static let label = "the demo fleet"

    /// Is this device in the demo? Keyed on the HOST, because that is what
    /// decides what comes back — the credential is along for the ride.
    static func isActive(_ url: String) -> Bool {
        url.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix(Self.coordinatorURL)
    }
}


/// Turning what somebody typed into a URL that works.
///
/// Written after two real ways to end up with a coordinator that silently does
/// nothing, neither of which is the person's fault:
///
///  - **No scheme.** `fleet.thetech.network` is what a person says out loud
///    and what a phone keyboard offers back, and `URL(string:)` accepts it as
///    a RELATIVE path, so the request goes nowhere and the error is about the
///    reply rather than the address.
///  - **A space in it.** iOS autocorrect will happily put one after a dot, and
///    a URL with a space in it fails to parse at all. Guessing here is safe in
///    a way it usually is not: no legal hostname contains a space, so there is
///    exactly one thing the person could have meant.
///
/// Deliberately does NOT upgrade a typed `http://` to https, and does not
/// refuse it here either. Quietly changing a scheme somebody chose is how "it
/// works in the terminal and not in the app" gets born, and a normaliser is the
/// wrong place to enforce a security rule: it runs while somebody is still
/// TYPING, so refusing here would reject `http` on the way to typing something
/// legitimate.
///
/// The rule lives at the point of transmission instead — see `isLocal` in
/// Fleet.swift. What was wrong before was not the permissiveness; it was that
/// the comment here claimed plain http over a tailnet worked, and it never did:
/// App Transport Security has been refusing it all along, with an opaque
/// networking error rather than a sentence about cleartext.
enum CoordinatorURL {
    static func normalise(_ raw: String) -> String {
        // Every kind of whitespace, anywhere, not just the ends. A pasted URL
        // that wrapped in an email carries a newline in the middle.
        let bare = raw.components(separatedBy: .whitespacesAndNewlines).joined()
        guard !bare.isEmpty else { return "" }

        // A scheme, or the assumption of one. Matched case-insensitively
        // because `HTTPS://` is what a capitalising keyboard produces.
        let lowered = bare.lowercased()
        let withScheme = lowered.hasPrefix("https://") || lowered.hasPrefix("http://")
            ? bare
            : "https://\(bare)"

        // One trailing slash is the difference between /api/list and //api/list,
        // and the second is a 404 that reads like the fleet is down.
        return String(withScheme.reversed().drop { $0 == "/" }.reversed())
    }
}
