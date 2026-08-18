import SwiftUI

/// The whole app: what is running, and the three things you would want to do
/// about it from a phone.
///
/// Every action is an intent to the coordinator. The app never talks to a host
/// directly, so it never has to know which box holds which session — that is
/// exactly what the coordinator is for.
struct FleetView: View {
    let settings: Settings

    @State private var sessions: [Fleet.Session] = []
    @State private var status = ""
    @State private var busy = false
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            List {
                if !status.isEmpty {
                    Section { Text(status).font(.system(.footnote, design: .monospaced)) }
                }
                Section {
                    if sessions.isEmpty && !busy {
                        Text("No sessions. Pull to refresh, or start one.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(sessions) { session in
                        SessionRow(session: session, busy: busy, stop: { await act { try await fleet.stop(session.name) } },
                                   resume: { await act { try await fleet.resume(session.name, choice: "summary") } })
                    }
                }
            }
            .refreshable { await refresh() }
            .navigationTitle("agent-fleet")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Settings") { showingSettings = true }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New") { Task { await act { try await fleet.start(name: nil) } } }
                        .disabled(busy || !settings.configured)
                }
            }
            .sheet(isPresented: $showingSettings) {
                SettingsView(settings: settings) { Task { await refresh() } }
            }
            .task { await refresh() }
            .onAppear { if !settings.configured { showingSettings = true } }
        }
    }

    private var fleet: Fleet { Fleet(settings: settings) }

    private func refresh() async {
        guard settings.configured else { return }
        busy = true
        defer { busy = false }
        do {
            let reply = try await fleet.list()
            sessions = reply.sessions ?? []
            // A failure is shown, never swallowed: "nothing here" and "I could
            // not reach the coordinator" look identical otherwise, and they are
            // completely different problems.
            status = (reply.ok == false) ? (reply.text ?? "") : ""
        } catch {
            status = error.localizedDescription
        }
    }

    private func act(_ work: () async throws -> Fleet.Reply) async {
        busy = true
        do {
            status = try await work().text ?? ""
        } catch {
            status = error.localizedDescription
        }
        busy = false
        await refresh()
    }
}

private struct SessionRow: View {
    let session: Fleet.Session
    let busy: Bool
    let stop: () async -> Void
    let resume: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(session.label).font(.headline)
                Spacer()
                Text(session.status).font(.caption).foregroundStyle(.secondary)
            }
            // Both are shown when they differ: the title is what a person
            // recognises, the name is what everything else keys on.
            if session.label != session.name {
                Text(session.name).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
            }
            if let host = session.hostId {
                Text("on \(host)").font(.caption2).foregroundStyle(.secondary)
            }
            HStack(spacing: 16) {
                if session.isRunning {
                    Button("Stop") { Task { await stop() } }.disabled(busy)
                    if let url = session.rcUrl, let link = URL(string: url) {
                        // The button that turns a notification into actually
                        // driving the session.
                        Link("Open", destination: link)
                    }
                } else if session.isResumable {
                    Button("Resume") { Task { await resume() } }.disabled(busy)
                }
            }
            .font(.callout)
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 2)
    }
}

private struct SettingsView: View {
    let settings: Settings
    let onDone: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Coordinator") {
                    TextField("https://…workers.dev", text: Bindable(settings).coordinatorURL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    SecureField("API token", text: Bindable(settings).apiToken)
                } footer: {
                    Text("From /etc/agent-fleet-coordinator.env. Nothing is baked into the app — "
                         + "a credential in an IPA is public the moment somebody unzips it.")
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { onDone(); dismiss() }
                }
            }
        }
    }
}
