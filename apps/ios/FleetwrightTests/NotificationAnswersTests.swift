import XCTest
import UserNotifications

@testable import Fleetwright

/// The decision a lock-screen button makes, run rather than read.
///
/// WHY THIS IS AN XCTest AND NOT A NODE GREP. `test/notification-answers.test.js`
/// holds the words on the buttons equal with the fleet's own, which is a
/// question about two files and is answerable by reading them. Whether a tap is
/// turned into the right digit, and whether an hour-old notification is refused,
/// are questions about a function — and the only thing that can answer those is
/// running it. The reassurance table made this argument first and this file is
/// the second instance of it.
final class NotificationAnswersTests: XCTestCase {

    private let sentAt = Date(timeIntervalSince1970: 1_700_000_000)

    private func payload(
        name: String? = "cc-brave-otter",
        promptId: String? = "deadbeef",
        answers: String? = "a:1,b:3",
        sentAt: Any? = "1700000000000"
    ) -> [AnyHashable: Any] {
        var info: [AnyHashable: Any] = [:]
        if let name { info["name"] = name }
        if let promptId { info["promptId"] = promptId }
        if let answers { info["answers"] = answers }
        if let sentAt { info["sentAt"] = sentAt }
        return info
    }

    // MARK: - which digit a button types

    func testEachButtonTypesTheDigitTheHostResolved() {
        // NOT 1 AND 2. The permission dialog's "no" is the third option once
        // "don't ask me again" is dropped, which is exactly why the digit
        // travels with the notification instead of living in this app.
        XCTAssertEqual(
            NotificationAnswers.decide(actionIdentifier: NotificationAnswers.slotA, userInfo: payload(), now: sentAt),
            .answer(name: "cc-brave-otter", option: 1, promptId: "deadbeef")
        )
        XCTAssertEqual(
            NotificationAnswers.decide(actionIdentifier: NotificationAnswers.slotB, userInfo: payload(), now: sentAt),
            .answer(name: "cc-brave-otter", option: 3, promptId: "deadbeef")
        )
    }

    func testARenumberedDialogMovesTheDigitAndNotTheButton() {
        // The same button, a different pane. This app holds the words and
        // nothing else, so a CLI that inserts an option cannot make a button
        // mean something other than what it says.
        let shifted = payload(answers: "a:2,b:3")
        XCTAssertEqual(
            NotificationAnswers.decide(actionIdentifier: NotificationAnswers.slotA, userInfo: shifted, now: sentAt),
            .answer(name: "cc-brave-otter", option: 2, promptId: "deadbeef")
        )
    }

    func testTappingTheNotificationItselfStillJustOpensIt() {
        let decision = NotificationAnswers.decide(
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: payload(),
            now: sentAt
        )
        XCTAssertEqual(decision, .open(name: "cc-brave-otter"))
    }

    // MARK: - the hour

    func testAnAnswerIsOfferedForExactlyAsLongAsItWasDeliverable() {
        let onTheEdge = sentAt.addingTimeInterval(NotificationAnswers.window)
        XCTAssertEqual(
            NotificationAnswers.decide(actionIdentifier: NotificationAnswers.slotA, userInfo: payload(), now: onTheEdge),
            .answer(name: "cc-brave-otter", option: 1, promptId: "deadbeef")
        )

        let pastIt = sentAt.addingTimeInterval(NotificationAnswers.window + 1)
        XCTAssertEqual(
            NotificationAnswers.decide(actionIdentifier: NotificationAnswers.slotA, userInfo: payload(), now: pastIt),
            .stale(name: "cc-brave-otter")
        )
    }

    func testAPayloadWithNoSentAtIsTreatedAsTooOld() {
        // ERRING TOWARDS REFUSING. A missing sentAt means a payload this app
        // does not understand, and the wrong side to be wrong on is the one
        // that types an approval into an unknown question.
        let decision = NotificationAnswers.decide(
            actionIdentifier: NotificationAnswers.slotA,
            userInfo: payload(sentAt: nil),
            now: sentAt
        )
        XCTAssertEqual(decision, .stale(name: "cc-brave-otter"))
    }

    func testSentAtIsReadOnBothTransports() {
        // APNs delivers it as a number and the FCM bridge as a string. A
        // notification answerable on one and permanently stale on the other is
        // the sort of bug that only shows up on one person's phone.
        let asNumber = payload(sentAt: NSNumber(value: 1_700_000_000_000))
        XCTAssertEqual(
            NotificationAnswers.decide(actionIdentifier: NotificationAnswers.slotA, userInfo: asNumber, now: sentAt),
            .answer(name: "cc-brave-otter", option: 1, promptId: "deadbeef")
        )
    }

    // MARK: - a payload this app cannot act on opens rather than guesses

    func testAnythingMissingOpensTheSessionInsteadOfSendingSomething() {
        let cases: [(String, [AnyHashable: Any])] = [
            ("no session name", payload(name: nil)),
            ("no prompt id", payload(promptId: nil)),
            ("no answers", payload(answers: nil)),
            ("an unparseable pairing", payload(answers: "yes please")),
            ("a slot this button is not", payload(answers: "b:3")),
            ("an option the answer verb would refuse", payload(answers: "a:0,b:3")),
            ("an option outside one to nine", payload(answers: "a:42,b:3")),
        ]
        for (what, info) in cases {
            let decision = NotificationAnswers.decide(
                actionIdentifier: NotificationAnswers.slotA,
                userInfo: info,
                now: sentAt
            )
            switch decision {
            case .open:
                continue
            default:
                XCTFail("\(what) produced \(decision) rather than opening the session")
            }
        }
    }

    // MARK: - the buttons exist before the notification does

    func testEveryKindTheFleetCanAskAboutHasACategoryRegistered() {
        // iOS resolves a payload's category against what the app registered the
        // last time it ran, so a category learned on demand arrives after the
        // notification it was for. All three, at launch, or none of them work.
        let registered = NotificationAnswers.categories()
        XCTAssertEqual(registered.count, NotificationAnswers.titles.count)

        for (kind, words) in NotificationAnswers.titles {
            guard let category = registered.first(where: {
                $0.identifier == "\(NotificationAnswers.categoryPrefix).\(kind)"
            }) else {
                XCTFail("no category registered for \(kind)")
                continue
            }
            XCTAssertEqual(category.actions.map(\.identifier), [NotificationAnswers.slotA, NotificationAnswers.slotB])
            XCTAssertEqual(category.actions.map(\.title), [words.a, words.b])
            // Answering from a locked phone lets a tool run on somebody's
            // machine. Both buttons ask for the phone to be unlocked first.
            for action in category.actions {
                XCTAssertTrue(
                    action.options.contains(.authenticationRequired),
                    "\(action.identifier) can be tapped on a locked phone"
                )
            }
        }
    }
}
