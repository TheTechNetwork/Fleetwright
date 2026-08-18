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
            return .result(dialog: "Set the coordinator URL in Fleetwright first.")
        }
        // "summary" rather than asking: nobody is going to answer a
        // resume-dialog question through Siri, and it is the cheaper option.
        let reply = try await Fleet(settings: settings).resume(session.name, choice: "summary")
        return .result(dialog: IntentDialog(stringLiteral: reply.text ?? "Resumed \(session.label)"))
    }
}

struct StartSessionIntent: AppIntent {
    static var title: LocalizedStringResource = "Start a session"
    static var description = IntentDescription("Start a new Claude Code session on the fleet.")
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let settings = Settings()
        guard settings.configured else {
            return .result(dialog: "Set the coordinator URL in Fleetwright first.")
        }
        let reply = try await Fleet(settings: settings).start(name: nil)
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
