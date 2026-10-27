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
/// does not have a copy of it.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        bestAttempt = content
        if request.content.userInfo["e"] != nil {
            if let envelope = request.content.userInfo["e"] as? String, let opened = PushKey.open(envelope) {
                content.title = opened.title
                content.body = opened.body
                content.userInfo = PushCrypto.merged(userInfo: request.content.userInfo, opened: opened)
            } else {
                content.categoryIdentifier = ""
            }
        }
        finish(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let bestAttempt {
            finish(bestAttempt)
        }
    }

    private func finish(_ content: UNNotificationContent) {
        contentHandler?(content)
        contentHandler = nil
    }
}
