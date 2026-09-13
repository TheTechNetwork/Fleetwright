import SwiftUI
import UserNotifications
import Sentry

extension Notification.Name {
    /// A provider flow finished somewhere outside the app. Whoever is showing
    /// credentials reloads; nobody trusts the payload, because a custom scheme
    /// can be claimed by anything.
    static let credentialsChanged = Notification.Name("network.thetech.fleetwright.credentialsChanged")
    /// Somebody tapped a notification. `userInfo["name"]` is the session it
    /// was about, when the payload said.
    static let notificationOpened = Notification.Name("network.thetech.fleetwright.notificationOpened")
}

@main
struct FleetwrightApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var settings = Settings()

    init() {
        // A SCREENSHOT RUN STARTS ON THE DEMO, so the pictures show a fleet
        // rather than an empty state with a Connect button. It writes exactly
        // what the Demo button in Settings writes — see Screenshots.swift for
        // why that is the only thing it can write.
        if Screenshots.wantsDemo {
            let s = Settings()
            s.coordinatorURL = Demo.coordinatorURL
            s.signedInAs = Demo.label
            s.credential = Demo.credential
        }
    }

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
        // AT LAUNCH, BECAUSE THERE IS NO LATER. iOS resolves a notification's
        // category against what the app registered the last time it ran, so a
        // category learned when the notification arrives is a category that
        // arrives after it. This is also cheap and unconditional: it registers
        // words, not permission, and asking for permission is still a separate
        // thing that happens once the app is configured.
        UNUserNotificationCenter.current().setNotificationCategories(NotificationAnswers.categories())
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
    ///   coordinator, and every one carries the fleet credential. This app
    ///   sends it as a header, never in the URL; the coordinator also accepts
    ///   `?token=` so a Shortcut's "Get Contents of URL" can reach it, which is
    ///   why `beforeSend` below strips query strings anyway — the backstop is
    ///   for a URL this app did not build.
    /// - `sendDefaultPii` stays OFF, so no IP address and no identifiers.
    /// - Tracing is off entirely: the spans would be those same requests.
    /// - Session replay is ON, and is the one thing here that is not a refusal.
    ///   It records only when something broke — `sessionSampleRate` is 0, not
    ///   the quickstart's 0.1 — and every text run and image in the frame is a
    ///   rectangle before it is encoded. What it sends is the order the screens
    ///   came in, which is the part the stack trace is missing. The paragraph
    ///   at the call site is the long version, including why this and
    ///   `attachScreenshot` come out differently.
    ///
    /// And `beforeSend` is the backstop rather than the plan. Every switch
    /// above can be undone by a careless edit or a new SDK default; a token
    /// that reaches this closure is still removed.
    ///
    /// It is not a backstop for the replay, and nothing is — a frame never
    /// passes through it. The masking switches are load-bearing on their own,
    /// which is why they are written out rather than inherited from the SDK.
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
            // SESSION REPLAY, WHICH IS A RECORDING OF THIS APP'S SCREENS
            // AND THEREFORE NEEDS A PARAGRAPH RATHER THAN A LINE.
            //
            // The switches above refuse a still of the screen; this asks for
            // the sequence of them. Worth stating, because somebody reading
            // `attachScreenshot = false` a few lines up will reasonably wonder.
            //
            // A REPLAY FRAME IS COMPOSITED, NOT CAPTURED. Every text run and
            // every image is a rectangle before the frame is encoded, so what
            // leaves the phone is the shape of the app — which screen, which
            // sheet, in which order — and none of the words on it. That order
            // is the part a stack trace does not have. A single masked still is
            // not, which is why the trade comes out differently for the two and
            // `attachScreenshot` stays off rather than being reconsidered.
            //
            // THE MASKING IS WRITTEN OUT THOUGH BOTH ARE ALREADY THE DEFAULT.
            // A default is something an SDK may change in a minor version and a
            // line is not, and these two are the entire reason the feature is
            // defensible in an app holding a fleet credential, a coordinator
            // address and a signed-in email. Nothing downstream catches them if
            // they go — a frame never passes through `beforeSend`. Turning
            // either off is not a tuning change; it is the credentials sheet,
            // legible, on somebody else's server.
            options.sessionReplay.maskAllText = true
            options.sessionReplay.maskAllImages = true
            // Every session that goes wrong, which is the whole point: the
            // seconds before the crash, attached to the crash, without anybody
            // having to reproduce it.
            options.sessionReplay.onErrorSampleRate = 1.0
            // AND NO AMBIENT RECORDING. The quickstart says 0.1 and that is the
            // one number here it does not get: one session in ten would be a
            // recording of somebody's fleet made with no incident behind it and
            // nothing waiting to read it, which is collection this file has
            // spent every other line declining. Same argument that put the
            // Worker's `tracesSampleRate` at 0.05 rather than 1.0.
            //
            // It costs nothing diagnostic — the line above already covers every
            // session that breaks, and a session that did not is not one anybody
            // opens. Raising it is this one line, and it is the line to raise
            // while testing the feature, since until somebody does a replay only
            // ever appears attached to an error.
            options.sessionReplay.sessionSampleRate = 0.0
            // NETWORK DETAIL IS LEFT UNSET, and that is the configuration
            // rather than an omission. `networkDetailAllowUrls`,
            // `networkRequestHeaders` and `networkResponseHeaders` would attach
            // request and response detail to the replay, and every request this
            // app makes carries the fleet credential in a header — the same
            // refusal `enableNetworkBreadcrumbs` above makes by another route.
            // Named so that adding one later is a decision somebody takes
            // rather than a blank they fill in.
            //
            // No `if #available(iOS 16.0, *)`: replay needs 16 and the
            // deployment target is 26, so the guard would be unreachable.
            // docs/error-reporting.md carries the rest of the argument.
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

    /// Somebody tapped one. Until this existed a tap opened the app to
    /// whichever tab was last showing — Settings, as often as not — and the
    /// session that had just asked for them was two taps further on. The
    /// notification exists so a decision can be made from a lock screen; the
    /// least it can do is land on the list that decision is on.
    ///
    /// It can now do more than the least: a session asking something the fleet
    /// has words for arrives with those two words on it, and this is where one
    /// of them becomes an answer. What is NOT trusted is unchanged — the
    /// payload is read for a name, an id and a digit, and every one of those is
    /// checked by `NotificationAnswers.decide` before anything is sent. The
    /// session list is still refreshed from the coordinator, and a name that is
    /// no longer there is still simply not there.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo

        switch NotificationAnswers.decide(actionIdentifier: response.actionIdentifier, userInfo: info) {
        case let .answer(name, option, promptId):
            await send(answer: option, to: name, promptId: promptId)
        case let .stale(name):
            // SAID, NOT SWALLOWED. A button that quietly does nothing is worse
            // than no button: somebody taps it, the phone locks, and they
            // believe they have answered. docs/psychology.md §6 — the message
            // says what is wrong AND what to do, and the app opens the session
            // so the second half is one tap away rather than a search.
            await MainActor.run {
                LocalNotice.post(
                    title: name,
                    body: "That question is more than an hour old, so it was not answered from here. Open the session to see what it is asking now."
                )
                open(name)
            }
        case let .open(name):
            await MainActor.run { open(name) }
        }
    }

    /// Send it, and say so either way.
    ///
    /// NOT THROUGH THE OUTBOX, which is the one place this path deliberately
    /// differs from the same answer given inside the app. `Outbox` holds a
    /// command for twelve hours so a lift or a tunnel does not lose it — right
    /// for `start` and `stop`, wrong for this: an answer queued from a lock
    /// screen and delivered hours later is the exact thing the hour above
    /// exists to prevent, and it would arrive with nobody watching.
    ///
    /// So it is sent now or not at all, and a failure is a sentence rather than
    /// a queue entry. The session opens either way, because whatever happened
    /// the next thing anybody wants is to see the question.
    @MainActor
    private func send(answer option: Int, to name: String, promptId: String) async {
        // `self.settings` is set when the UI registers for push, and a lock
        // screen can reach this before any UI has run — a cold launch straight
        // into an action. Settings reads from UserDefaults, so building one
        // here is the same object rather than a second source of truth, and
        // without this the button silently did nothing on exactly the launch it
        // was designed for.
        let settings = self.settings ?? Settings()
        guard settings.configured else { return open(name) }
        do {
            let reply = try await Fleet(settings: settings).answer(name, option: option, promptId: promptId)
            // THE HOST GETS THE LAST WORD. `promptId` is checked against the
            // live pane there, so a refusal here is a question that moved on in
            // the seconds this took — which is exactly the case the id exists
            // for, and exactly the case somebody must be told about rather than
            // left to assume.
            if reply.ok == false {
                LocalNotice.post(title: name, body: reply.text ?? "That answer was not accepted.")
                open(name)
            }
        } catch {
            LocalNotice.post(
                title: name,
                body: "The fleet could not be reached, so that answer was not sent. Open the session to try again."
            )
            open(name)
        }
    }

    @MainActor
    private func open(_ name: String?) {
        NotificationCenter.default.post(
            name: .notificationOpened,
            object: nil,
            userInfo: name.map { ["name": $0] } ?? [:]
        )
    }
}
