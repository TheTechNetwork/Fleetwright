import SwiftUI
import UserNotifications
import Sentry

extension Notification.Name {
    /// A provider flow finished somewhere outside the app. Whoever is showing
    /// credentials reloads; nobody trusts the payload, because a custom scheme
    /// can be claimed by anything.
    static let credentialsChanged = Notification.Name("network.thetech.fleetwright.credentialsChanged")
}

@main
struct FleetwrightApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var settings = Settings()

    var body: some Scene {
        WindowGroup {
            FleetApp(settings: settings)
                // Keyed on the credential, not run once. Permission is asked
                // for after there is something to notify about, which now means
                // after signing in — and a `.task` that fires only on first
                // appearance would leave a phone that signed in on its first
                // launch unregistered until its second.
                .task(id: settings.credential) { await delegate.registerForPush(settings: settings) }
                // COMING BACK FROM A PROVIDER. The coordinator's OAuth callback
                // redirects to fleetwright://connected when it has stored the
                // token, so the browser hands control back instead of leaving
                // somebody on a page telling them to close a tab.
                //
                // Carries only `provider` and `ok`. A custom scheme is
                // unverified — any app may claim it — so nothing here is
                // trusted with anything: it is a nudge to refresh, and the
                // truth is whatever the host reports next.
                .onOpenURL { url in
                    guard url.scheme == "fleetwright", url.host == "connected" else { return }
                    NotificationCenter.default.post(name: .credentialsChanged, object: nil)
                }
        }
    }
}

/// APNs needs an app delegate; SwiftUI has no equivalent hook for the device
/// token callback.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    private var settings: Settings?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        startErrorReporting()
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    /// Crash reporting, and the long list of things it must not send.
    ///
    /// A DSN is not a secret — it identifies a project and grants only the
    /// ability to post events to it. The refusals below are the part that
    /// matters, because this app holds a fleet credential, a coordinator
    /// address and the signed-in email:
    ///
    /// - `attachScreenshot` and `attachViewHierarchy` stay OFF. The session
    ///   list, the pane and the credentials sheet are all on screen, and a
    ///   screenshot of any of them is exactly what this app is careful about.
    /// - Network breadcrumbs stay OFF. This app's requests are intents to the
    ///   coordinator, and a credential may travel in the query string —
    ///   deliberately, because a Shortcut cannot set headers.
    /// - `sendDefaultPii` stays OFF, so no IP address and no identifiers.
    /// - Tracing is off entirely: the spans would be those same requests.
    ///
    /// And `beforeSend` is the backstop rather than the plan. Every switch
    /// above can be undone by a careless edit or a new SDK default; a token
    /// that reaches this closure is still removed.
    private func startErrorReporting() {
        // Absent means no reporting, which is what a fork or a fresh clone
        // gets. One code path rather than an `if` somebody can get wrong.
        let dsn = Bundle.main.object(forInfoDictionaryKey: "SentryDSN") as? String ?? ""
        guard !dsn.isEmpty else { return }

        SentrySDK.start { options in
            options.dsn = dsn
            options.sendDefaultPii = false
            options.attachScreenshot = false
            options.attachViewHierarchy = false
            options.enableNetworkBreadcrumbs = false
            options.enableNetworkTracking = false
            options.enableCaptureFailedRequests = false
            options.enableUserInteractionTracing = false
            options.tracesSampleRate = 0.0
            options.beforeSend = { event in
                event.user = nil
                event.request?.headers = nil
                event.request?.cookies = nil
                if let url = event.request?.url {
                    event.request?.url = Self.scrubbed(url)
                }
                event.breadcrumbs = event.breadcrumbs?.map { crumb in
                    // setData(value:key:) rather than assigning through the
                    // `data` subscript. The SDK deprecated that setter and
                    // names this as its replacement, and "will become
                    // read-only in a future release" means the warning is a
                    // deadline rather than an opinion.
                    if let url = crumb.data?["url"] as? String {
                        crumb.setData(value: Self.scrubbed(url), key: "url")
                    }
                    // REMOVED, not replaced with a marker. The first version
                    // wrote "[redacted]" and justified it as "removal would
                    // need a second API to guess at" — which was an excuse for
                    // not looking. The same call removes: setDataValue:forKey:
                    // takes a `nullable id`, and its implementation says so —
                    // "setValue:forKey: removes the key when value is nil".
                    //
                    // Worth the difference. A marker is data this app INVENTED
                    // and sent to a third party, and the next person reading a
                    // breadcrumb has to work out whether Sentry captured a
                    // header called "[redacted]" or whether we put it there.
                    // Absent is unambiguous.
                    crumb.setData(value: nil, key: "headers")
                    return crumb
                }
                return event
            }
        }
    }

    /// A URL with nothing secret left in it.
    ///
    /// The whole query is dropped rather than named parameters removed. A
    /// denylist is a list somebody forgets to update the next time a token
    /// learns a new spelling, and the path alone is the diagnostic value.
    static func scrubbed(_ raw: String) -> String {
        guard var parts = URLComponents(string: raw) else { return "[unparseable url]" }
        parts.query = nil
        parts.fragment = nil
        return parts.string ?? "[unparseable url]"
    }

    @MainActor
    func registerForPush(settings: Settings) async {
        self.settings = settings
        // Asking before there is anything to notify about is how permission
        // gets denied. This runs once the app is on screen and configured.
        guard settings.configured else { return }
        let granted = (try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        guard granted else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        guard let settings else { return }
        Task {
            // A failure here is not fatal: the app still works, it just will not
            // wake you. Worth a log rather than an alert.
            try? await Fleet(settings: settings).registerDevice(token: deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        print("push registration failed: \(error.localizedDescription)")
    }

    /// Show the notification even with the app open — a session that has hit a
    /// prompt is worth interrupting for whatever you were doing in the app.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
