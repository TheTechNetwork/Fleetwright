import Foundation
import UserNotifications

/// Answering a session's question from the notification, and refusing to when
/// the question has probably moved on.
///
/// WHY THE WORDS ARE HERE AND THE NUMBERS ARE NOT. A `UNNotificationAction`'s
/// title is fixed when the app registers its categories, not when a
/// notification arrives, so the buttons cannot say what the CLI's options say
/// and the fleet writes them instead — in `src/fleet/host/prompt.js`, beside
/// the questions it already writes, and copied here because this is where iOS
/// needs them. `test/notification-answers.test.js` fails the day the two
/// disagree, which is the same arrangement `Design.swift` has with the palette
/// and for the same reason: a string written twice drifts.
///
/// The digit each button types is NOT written here. `1. Yes` and `3. No, and
/// tell Claude…` is today's permission dialog; a CLI release that inserts an
/// option renumbers it, and a button holding its own digit would keep its label
/// and change its meaning. The host resolves the digit against the pane it
/// actually drew and sends the pairing in `answers`.
enum NotificationAnswers {
    /// The prefix the coordinator names its categories under, with the kind of
    /// question appended. Declared in `src/fleet/coordinator/core.js`.
    static let categoryPrefix = "fleet.prompt"

    /// The two buttons, in order. The identifiers are what comes back in
    /// `UNNotificationResponse.actionIdentifier`.
    static let slotA = "fleet.answer.a"
    static let slotB = "fleet.answer.b"

    /// How long after it was sent a notification may still be answered.
    ///
    /// ONE HOUR, AND IT IS THE SAME HOUR THE COORDINATOR WOULD HAVE DELIVERED
    /// IT FOR. `PUSH_TTL_S` in `src/fleet/push.js` is the window a provider may
    /// hold a notification before dropping it, chosen as "long enough for a
    /// phone in a pocket on a train, short enough that a question answered from
    /// a lock screen next morning is not one the host asked yesterday". Both
    /// clocks start at the same `sentAt`, so reusing it makes the rule sayable
    /// in one line: a notification is answerable for exactly as long as it was
    /// deliverable.
    static let window: TimeInterval = 3600

    /// The words the fleet put on the buttons, by the kind of question.
    ///
    /// Held equal with `ANSWER_TITLES` in `src/fleet/host/prompt.js` by a test,
    /// because there is no way for a compiler to notice.
    static let titles: [String: (a: String, b: String)] = [
        "resume": (a: "From a summary", b: "In full"),
        "trust": (a: "Trust this folder", b: "Do not trust it"),
        "permission": (a: "Allow this once", b: "Do not allow"),
    ]

    /// Every category the coordinator might name, registered at launch.
    ///
    /// REGISTERED FOR ALL OF THEM AT ONCE, because there is no later. iOS
    /// resolves a payload's category against what the app registered the last
    /// time it ran; a category learned on demand is a category that arrives
    /// after the notification it was for. Three kinds is the whole vocabulary,
    /// and it is small enough to declare rather than negotiate.
    static func categories() -> Set<UNNotificationCategory> {
        Set(titles.map { kind, words in
            UNNotificationCategory(
                identifier: "\(categoryPrefix).\(kind)",
                actions: [action(slotA, words.a), action(slotB, words.b)],
                intentIdentifiers: [],
                options: []
            )
        })
    }

    /// AUTHENTICATION REQUIRED ON BOTH, and it is not a formality.
    ///
    /// One of these buttons lets a tool run on a machine somebody owns, from a
    /// lock screen, which is a thing anybody holding the phone can reach. The
    /// app carries a fleet credential precisely so it does not have to ask for
    /// one each time, and that is the trade this option pays for.
    ///
    /// NEITHER IS `.destructive`, which would paint one of them red. Red on
    /// iOS means irreversible, and here the irreversible half is *allowing*
    /// while the red would land on the cautious answer — a colour saying the
    /// opposite of the word beside it. `docs/psychology.md` §5 asks for colour
    /// that agrees with a word; this is the case where the platform's only
    /// available colour disagrees, so it goes unused.
    private static func action(_ identifier: String, _ title: String) -> UNNotificationAction {
        UNNotificationAction(identifier: identifier, title: title, options: [.authenticationRequired])
    }

    /// What a tap on one of these means, once the clock has been consulted.
    enum Decision: Equatable {
        /// Send it: the question is still young enough to be the one on screen.
        case answer(name: String, option: Int, promptId: String)
        /// A button was tapped on a notification too old to answer. Open the
        /// session so the decision is made against what is there now.
        case stale(name: String)
        /// Not one of our buttons — the notification itself was tapped, which
        /// is what every notification has always done.
        case open(name: String?)
    }

    /// Read a tap.
    ///
    /// `sentAt` HAS BEEN IN EVERY ENVELOPE SINCE #351 AND NOTHING HAS EVER READ
    /// IT. That was harmless while a tap only navigated: the session list is
    /// refreshed from the coordinator, so arriving late landed on current
    /// information. A button is not harmless — a notification answered an hour
    /// after it was sent answers whatever the pane says now.
    ///
    /// The host's `promptId` is still the real guard and still checked there;
    /// this is the half that can be done before the network, so somebody gets a
    /// sentence instead of a silent refusal.
    ///
    /// A MISSING `sentAt` IS TREATED AS TOO OLD rather than as fresh. It means
    /// a payload this app does not understand, and the wrong side to err on is
    /// the one that types an approval into an unknown question.
    static func decide(
        actionIdentifier: String,
        userInfo: [AnyHashable: Any],
        now: Date = Date()
    ) -> Decision {
        let name = (userInfo["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }

        guard actionIdentifier == slotA || actionIdentifier == slotB else { return .open(name: name) }
        guard
            let name,
            let promptId = userInfo["promptId"] as? String, !promptId.isEmpty,
            let option = option(for: actionIdentifier, in: userInfo["answers"] as? String)
        else {
            // A button with nothing behind it opens rather than guessing. It
            // should not happen — the coordinator sends a category only when it
            // sends the answers — but a notification is the one surface where
            // the payload was written by a version of the fleet this app has
            // never met.
            return .open(name: name)
        }

        guard let sentAt = sentAt(userInfo), now.timeIntervalSince(sentAt) <= window else {
            return .stale(name: name)
        }
        return .answer(name: name, option: option, promptId: promptId)
    }

    /// `a:1,b:3` — which digit this button types.
    ///
    /// Parsed rather than trusted: this string crossed two providers to get
    /// here, and the `answer` verb takes a single digit (see
    /// `src/fleet/protocol/intents.js`). Anything else is not an option, and an
    /// unparseable pairing opens the session instead of sending a number the
    /// fleet would refuse.
    static func option(for actionIdentifier: String, in answers: String?) -> Int? {
        guard let answers else { return nil }
        let slot = actionIdentifier == slotA ? "a" : "b"
        for pair in answers.split(separator: ",") {
            let parts = pair.split(separator: ":")
            guard parts.count == 2, parts[0] == slot, let option = Int(parts[1]) else { continue }
            return (1...9).contains(option) ? option : nil
        }
        return nil
    }

    /// When the coordinator sealed this, as a date.
    ///
    /// Milliseconds since the epoch, and a string because FCM data values are.
    /// It arrives as an `NSNumber` through APNs and as a `String` through the
    /// FCM bridge, so both are read — a notification that is answerable on one
    /// transport and permanently stale on the other would be the sort of bug
    /// that only shows up on one person's phone.
    static func sentAt(_ userInfo: [AnyHashable: Any]) -> Date? {
        let millis: Double?
        if let number = userInfo["sentAt"] as? NSNumber {
            millis = number.doubleValue
        } else if let text = userInfo["sentAt"] as? String {
            millis = Double(text)
        } else {
            millis = nil
        }
        guard let millis, millis > 0 else { return nil }
        return Date(timeIntervalSince1970: millis / 1000)
    }
}
