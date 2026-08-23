import SwiftUI
import UserNotifications

@main
struct FleetwrightApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var settings = Settings()

    var body: some Scene {
        WindowGroup {
            FleetView(settings: settings)
                // Keyed on the credential, not run once. Permission is asked
                // for after there is something to notify about, which now means
                // after signing in — and a `.task` that fires only on first
                // appearance would leave a phone that signed in on its first
                // launch unregistered until its second.
                .task(id: settings.credential) { await delegate.registerForPush(settings: settings) }
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
        UNUserNotificationCenter.current().delegate = self
        return true
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
