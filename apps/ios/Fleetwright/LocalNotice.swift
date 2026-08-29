import UserNotifications

/// A notification this device raises itself, for work it started.
///
/// NOT a replacement for push. Push is how the FLEET tells you something —
/// a session is waiting for an answer, on a box you were not looking at. This
/// is how the APP finishes a sentence it began: you asked for a session, the
/// answer took a minute, and by then you had put the phone down.
///
/// Local because it needs no server, no token and no round trip, and because
/// the thing being reported is already known here. A push for it would mean
/// the coordinator learning to care about a request the phone made.
enum LocalNotice {
    /// Post immediately. Silent if permission was never granted, which is the
    /// right failure: somebody who declined notifications is not asking to be
    /// interrupted by this either.
    static func post(title: String, body: String, id: String = UUID().uuidString) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        // nil trigger means "now". A time-interval trigger of zero is invalid,
        // which is the kind of thing that fails silently at runtime.
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
