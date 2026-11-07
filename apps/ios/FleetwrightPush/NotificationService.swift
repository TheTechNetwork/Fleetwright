import UserNotifications

/// Opens a notification before iOS draws it.
///
/// `mutable-content` is what runs this, and it is set only when the payload is
/// sealed (`apnsPusher` in `src/fleet/push.js`). Without this extension the
/// alert stays the fallback sentence and the ciphertext is never opened —
/// delivery reports success and the person sees "Something needs you" forever.
///
/// ON FAILURE THE FALLBACK STAYS, and the category is cleared. The buttons
/// were drawn from a category whose answers are inside the envelope, so a
/// button on a notification we could not open would answer a question we had
/// not read. Clearing the category leaves the sentence and no buttons. The
/// sentence itself is the one the coordinator already put on the alert; this
/// does not have a copy of it. Running out of time is the same failure, and
/// clears it the same way.
///
/// ON SUCCESS THE SEALED CATEGORY DECIDES the buttons, and a clear one that
/// disagrees with it leaves none (`PushCrypto.category`).
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        original = request.content
        let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        if let envelope = request.content.userInfo["e"] as? String, let opened = PushKey.open(envelope) {
            content.title = opened.title
            content.body = opened.body
            content.userInfo = PushCrypto.merged(userInfo: request.content.userInfo, opened: opened)
            // A HYPERVISOR SETUP'S END IS WORDED HERE, from the job's state,
            // phase and purpose, as Android words its own (XoSetupNotice.kt).
            // The coordinator's body is the machine's last sentence, which is
            // the setup page's to show: it rides along as `text`, and a tap
            // opens the page with it (FleetwrightApp, SetupResultView).
            if opened.data["kind"] == "xosetup" {
                let state = opened.data["state"] ?? ""
                content.title = SetupNoticeWords.title(purpose: opened.data["purpose"], state: state)
                content.body = SetupNoticeWords.body(
                    purpose: opened.data["purpose"], state: state,
                    hostId: opened.data["hostId"] ?? "",
                    step: Int(opened.data["step"] ?? "") ?? 0,
                    of: Int(opened.data["of"] ?? "") ?? 0
                )
                content.userInfo["text"] = opened.body
            }
            content.categoryIdentifier = PushCrypto.category(
                sealed: opened.data["category"],
                clear: request.content.categoryIdentifier
            )
        } else {
            content.categoryIdentifier = PushCrypto.categoryUnopened(
                userInfo: request.content.userInfo,
                clear: request.content.categoryIdentifier
            )
            // A seal that did not open loses its buttons for the same reason
            // the timed-out case below does, and says so for the same reason.
            if content.categoryIdentifier.isEmpty, request.content.userInfo["e"] != nil {
                content.body = PushCrypto.openToAnswer(after: content.body)
            }
        }
        finish(content)
    }

    /// Out of time: the notification as it arrived, without its buttons when
    /// it was sealed.
    ///
    /// As it arrived it is the fallback sentence with the clear category, and
    /// the buttons that category draws would do nothing. The prompt id and
    /// the digits are still sealed, so `NotificationAnswers.decide` has
    /// nothing to answer, and the answer actions do not bring the app
    /// forward, so a press would leave the person where they were with the
    /// question still waiting. The same rule as a seal that did not open
    /// (`PushCrypto.categoryUnopened`). A copy of the original, rather than
    /// the one `didReceive` is still writing to.
    override func serviceExtensionTimeWillExpire() {
        guard let original else { return }
        let content = (original.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        content.categoryIdentifier = PushCrypto.categoryUnopened(
            userInfo: original.userInfo,
            clear: original.categoryIdentifier
        )
        // SAID, NOT SILENTLY DOWNGRADED. A sealed question that lost its
        // buttons arrived looking like any other alert, and the person
        // learned the buttons were missing by looking for them. The body
        // now says the question is still waiting in the app, which is the
        // one thing a tap on this notification can still do.
        if content.categoryIdentifier.isEmpty, original.userInfo["e"] != nil {
            content.body = PushCrypto.openToAnswer(after: content.body)
        }
        finish(content)
    }

    private func finish(_ content: UNNotificationContent) {
        contentHandler?(content)
        contentHandler = nil
    }
}
