import SwiftUI

/// Setting up temporary machines, once: where they come from, and who starts
/// them.
///
/// Every piece of this used to be drawn inline under "Add a machine", as tall
/// finished as unfinished, every time the machine list was opened. It is a
/// screen now, behind one row under You that says how it is set up.
///
/// WHERE YOUR MACHINES COME FROM. A public repository of your own, with the
/// Fleetwright GitHub App installed, made from the runner template, is what
/// makes Actions minutes free for you. Saved only after it has been checked:
/// by the fleet's minting Worker as the GitHub App, or by a permanent box with
/// your GitHub connection where there is no minter. The check's answers are
/// shown either way, so a refusal says which one.
///
/// WHO STARTS THEM is this phone, when it is signed in to GitHub (under You ›
/// Account); otherwise a permanent box with your GitHub connection does.
struct TemporaryMachinesView: View {
    let settings: Settings

    /// False until the coordinator has said, and stays false for a credential
    /// that is not a person's, which cannot have one: the section is drawn
    /// only when setting it can work.
    @State private var runnerRepoAnswered = false
    @State private var saved: String?
    @State private var fleetRepo: String?
    @State private var draft = ""
    @State private var busy = false
    @State private var message = ""
    @State private var check: Fleet.RunnerRepoCheck?

    private var phone: PhoneGitHub { PhoneGitHub(settings: settings) }

    private var whoStarts: String {
        if phone.signedIn { return "This phone starts them itself, as \(phone.signIn?.login ?? "you") on GitHub." }
        return "A permanent box with your GitHub connection starts them. Sign in to GitHub on this phone under You, and the phone starts them itself."
    }

    var body: some View {
        Form {
            Section {
                if runnerRepoAnswered {
                    TextField("Your runner repository (owner/repo)", text: $draft)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.URL)
                    Button(busy ? "Checking…" : "Check and save") { Task { await save() } }
                        .disabled(busy || draft.trimmingCharacters(in: .whitespaces).isEmpty)
                    if saved != nil {
                        // Says what clearing leads to: the fleet's repository
                        // when there is one, and nothing at all when not.
                        Button(fleetRepo == nil ? "Remove your runner repository" : "Use the fleet's repository instead",
                               role: .destructive) { Task { await clear() } }
                            .disabled(busy)
                    }
                    Text(describeRunnerRepoSetting(saved: saved, fleet: fleetRepo))
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                    if let check {
                        Text(describeRunnerCheck(check))
                            .fleetType(.labelMono)
                            .foregroundStyle(check.ok ? Design.Palette.ink : Design.Palette.bad)
                    }
                    if !message.isBlank {
                        Text(message)
                            .fleetType(.label)
                            .foregroundStyle(check?.ok == false ? Design.Palette.bad : Design.Palette.ink)
                            .textSelection(.enabled)
                    }
                } else {
                    Text("Asking the fleet…")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }
            } header: {
                sectionHead("Where they come from")
            }

            Section {
                Text(whoStarts)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            } header: {
                sectionHead("Who starts them")
            } footer: {
                Text("Ask for one under New session, in Where. Sessions on it are lost when it goes, and it spends Actions minutes. Windows runners are written and not yet proven.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Temporary machines")
        .task { await load() }
    }

    @MainActor
    private func load() async {
        // A refusal (the admin token, an older coordinator) leaves the field
        // undrawn: there is nothing it could set.
        if let got = try? await Fleet(settings: settings).runnerRepoSetting(), got.ok != false {
            runnerRepoAnswered = true
            saved = got.repo
            fleetRepo = got.fleet
            if draft.isEmpty { draft = got.repo ?? "" }
        }
    }

    @MainActor
    private func save() async {
        busy = true
        defer { busy = false }
        message = ""
        do {
            let r = try await Fleet(settings: settings).setRunnerRepo(draft.trimmingCharacters(in: .whitespacesAndNewlines))
            check = r.runnerRepo
            message = r.text ?? ""
            if r.ok == true, let repo = r.repo {
                saved = repo
                draft = repo
            }
        } catch {
            message = error.localizedDescription
        }
    }

    @MainActor
    private func clear() async {
        busy = true
        defer { busy = false }
        do {
            let r = try await Fleet(settings: settings).clearRunnerRepo()
            message = r.text ?? ""
            saved = nil
            check = nil
            draft = ""
        } catch {
            message = error.localizedDescription
        }
    }

    private func sectionHead(_ text: String) -> some View {
        Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
    }
}

/// "From owner/repo", or how it is not set up, for the row under You.
func describeTemporaryMachines(saved: String?, fleet: String?) -> String {
    if let saved { return "from \(saved)" }
    if let fleet { return "from \(fleet)" }
    return "not set up"
}
