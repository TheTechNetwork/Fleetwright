import AppIntents

/// Siri and Shortcuts.
///
/// design.md §7 puts this first, above the app itself: "Hey Siri, resume
/// bigjob" must work from cellular, on a cold radio, in under a second. That
/// requirement is what chose the transport in §4 — a tailnet name would need
/// the VPN up and connected at exactly the moment Siri fires, which is right
/// after unlock.
///
/// The session name is a RESOLVED ENTITY rather than a free-text parameter, so
/// Siri disambiguates against the sessions that actually exist instead of
/// mishearing "bigjob" as "big job" and failing. This is also why generated
/// names became words: "resume brave otter" is a thing a person can say, and
/// "resume cc-1a2b3c" is not.

struct SessionEntity: AppEntity, Identifiable {
    let id: String
    let name: String
    let title: String?
    let status: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Session" }
    static var defaultQuery = SessionQuery()

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(title?.isEmpty == false ? title! : name)",
            subtitle: "\(status)"
        )
    }
}

struct SessionQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [SessionEntity] {
        try await suggestedEntities().filter { identifiers.contains($0.id) }
    }

    /// What Siri offers, and what it matches a spoken name against.
    func suggestedEntities() async throws -> [SessionEntity] {
        let settings = Settings()
        guard settings.configured else { return [] }
        let reply = try await Fleet(settings: settings).list()
        return (reply.sessions ?? []).map {
            SessionEntity(id: $0.name, name: $0.name, title: $0.title, status: $0.status)
        }
    }
}

struct ResumeSessionIntent: AppIntent {
    static var title: LocalizedStringResource = "Resume a session"
    static var description = IntentDescription("Bring a stopped Claude Code session back, with its conversation intact.")
    /// No confirmation dialog and no app launch: the entire point is that it
    /// happens while the phone is still in your pocket.
    static var openAppWhenRun = false

    @Parameter(title: "Session")
    var session: SessionEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Resume \(\.$session)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let settings = Settings()
        guard settings.configured else {
            return .result(dialog: "Open Fleetwright and sign in first.")
        }
        // "summary" rather than asking: nobody is going to answer a
        // resume-dialog question through Siri, and it is the cheaper option.
        let reply = try await Fleet(settings: settings).resume(session.name, choice: "summary")
        return .result(dialog: IntentDialog(stringLiteral: reply.text ?? "Resumed \(session.label)"))
    }
}

/// A kind, as something Siri can say.
///
/// This entity is what makes user-defined phrases possible at all. An app
/// cannot register arbitrary Siri phrases — `AppShortcut` phrases are compiled
/// in and must contain the app name. But a PARAMETERISED phrase expands across
/// an entity's `suggestedEntities()`, so every kind somebody creates becomes a
/// spoken phrase without any of them being known at build time.
struct SessionKindEntity: AppEntity, Identifiable {
    let id: String
    let word: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Session kind" }
    static var defaultQuery = SessionKindQuery()

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(word)") }
}

struct SessionKindQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [SessionKindEntity] {
        SessionKinds.all().filter { identifiers.contains($0.id) }.map { SessionKindEntity(id: $0.id, word: $0.word) }
    }

    /// What Siri offers, and what it matches a spoken word against. Reads from
    /// UserDefaults rather than the fleet: this must answer instantly and it
    /// must answer with the radio off, because it is consulted while somebody
    /// is mid-sentence.
    func suggestedEntities() async throws -> [SessionKindEntity] {
        SessionKinds.all().map { SessionKindEntity(id: $0.id, word: $0.word) }
    }
}

struct StartSessionIntent: AppIntent {
    static var title: LocalizedStringResource = "Start a session"
    static var description = IntentDescription("Start a new Claude Code session on the fleet.")

    /// COMPUTED, not a constant, which is the whole feature.
    ///
    /// An intent fired from a Shortcut, an automation or the Action button very
    /// often runs when nobody is looking at the phone, and launching an app
    /// then is an interruption nobody asked for. So this is a setting, and only
    /// the person who set it knows whether they meant "start this and get out
    /// of my way" or "start this and take me there".
    static var openAppWhenRun: Bool { Settings().autoOpenAfterStart }

    /// OPTIONAL, and this is the one thing here I could not verify without
    /// Xcode. It has to be optional for the bare "start a session" phrase to
    /// work for somebody who has defined no kinds — which is everybody on day
    /// one. If the compiler refuses an optional entity inside a parameterised
    /// phrase, the fix is a second intent with a non-optional parameter rather
    /// than making day one worse.
    @Parameter(title: "Kind")
    var kind: SessionKindEntity?

    /// Optional, and it must stay optional: a spoken start cannot open a text
    /// field, so there has to be a good answer when nobody supplies one. That
    /// is the same conclusion docs/naming.md reaches from the psychology, by a
    /// different route.
    @Parameter(title: "Title")
    var titleText: String?

    @Parameter(title: "About")
    var brief: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Start a \(\.$kind) session") {
            \.$titleText
            \.$brief
        }
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let settings = Settings()
        guard settings.configured else {
            return .result(dialog: "Open Fleetwright and sign in first.")
        }

        let chosen = kind.flatMap { SessionKinds.find(word: $0.word) }
        let about = brief?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        // A title is not asked for out loud. If one was typed in a Shortcut it
        // is used; otherwise a brief becomes one on this device; otherwise the
        // host names it as it always has.
        var title = titleText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if title.isEmpty, !about.isEmpty { title = await Naming.suggest(for: about) }
        if !title.isEmpty, let prefix = chosen?.titlePrefix, !prefix.isEmpty {
            title = "\(prefix): \(title)"
        }

        let reply = try await Fleet(settings: settings).start(
            name: nil,
            title: title.isEmpty ? nil : title,
            brief: about.isEmpty ? nil : about,
            mode: chosen?.mode
        )
        // The spoken reply the host wrote, not a sentence invented here. A UI
        // can ignore prose; an assistant cannot invent it.
        return .result(dialog: IntentDialog(stringLiteral: reply.text ?? "Started a session"))
    }
}

struct StopSessionIntent: AppIntent {
    static var title: LocalizedStringResource = "Stop a session"
    static var description = IntentDescription("Stop a running session. Its conversation is kept, so it can be resumed.")
    static var openAppWhenRun = false

    @Parameter(title: "Session")
    var session: SessionEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Stop \(\.$session)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let settings = Settings()
        let reply = try await Fleet(settings: settings).stop(session.name)
        return .result(dialog: IntentDialog(stringLiteral: reply.text ?? "Stopped \(session.label)"))
    }
}

/// The phrases Siri learns without anybody opening the Shortcuts app.
struct FleetwrightShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: ResumeSessionIntent(),
            phrases: [
                "Resume \(\.$session) in \(.applicationName)",
                "\(.applicationName) resume \(\.$session)",
            ],
            shortTitle: "Resume",
            systemImageName: "play.circle"
        )
        // Two entries for one intent on purpose. The parameterised one expands
        // across every kind the user has defined — "start a dev session in
        // Fleetwright" — and the bare one keeps working for somebody who has
        // defined none, which is everybody on the first day.
        AppShortcut(
            intent: StartSessionIntent(),
            phrases: [
                "Start a \(\.$kind) session in \(.applicationName)",
                "New \(\.$kind) session in \(.applicationName)",
            ],
            shortTitle: "Start a kind",
            systemImageName: "plus.circle"
        )
        AppShortcut(
            intent: StartSessionIntent(),
            phrases: ["Start a session in \(.applicationName)", "New \(.applicationName) session"],
            shortTitle: "Start",
            systemImageName: "plus.circle"
        )
        AppShortcut(
            intent: StopSessionIntent(),
            phrases: ["Stop \(\.$session) in \(.applicationName)"],
            shortTitle: "Stop",
            systemImageName: "stop.circle"
        )
    }
}

private extension SessionEntity {
    var label: String { title?.isEmpty == false ? title! : name }
}
