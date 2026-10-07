import SwiftUI

/// Linked repositories: three roles, one place (#346).
///
/// ONE LIST WITH A ROLE ON EACH LINK, because the three want different things
/// and a single "linked repo" field meaning all of them is how somebody
/// bootstraps a private thing onto a public repository because "scratch"
/// sounded temporary:
///
///   Archive     PRIVATE. Where each session you start is pushed, on a branch
///               of its own, before it stops and every ten minutes while it
///               runs. A public one is refused, not warned about.
///   Runners     PUBLIC. Where your temporary machines start: free Actions
///               minutes are a public repository's. World-readable, logs
///               included, so it is a launcher and nothing else. The same
///               setting as Temporary machines, reached from here as well.
///   Templates   EITHER. Skills, presets, configs and workflows a session
///               can read when asked. Nothing in it runs by itself.
///
/// What each role means is said where it is linked, before the button, which
/// is the point the issue asks for the warning to be at. Linked only once the
/// fleet's check for that role passes, and the check's answers are shown
/// either way. Unlink is drawn only for a role that has a link (C-2).
struct LinkedReposView: View {
    let settings: Settings

    private enum Load { case asking, answered, failed(String) }
    @State private var load = Load.asking
    @State private var links: [String: String] = [:]
    @State private var fleetRunners: String?
    @State private var drafts: [String: String] = [:]
    @State private var busy: String?
    @State private var messages: [String: String] = [:]
    @State private var checks: [String: Fleet.LinkedRepoCheck] = [:]

    var body: some View {
        Form {
            switch load {
            case .asking:
                Section {
                    Text("Asking the fleet…")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }
            case .failed(let why):
                Section {
                    Text("The fleet did not say what you have linked: \(why)")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.bad)
                        .textSelection(.enabled)
                    Button("Ask again") { Task { await reload() } }
                }
            case .answered:
                ForEach(linkedRoles, id: \.self) { role in
                    roleSection(role)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Linked repositories")
        .task { await reload() }
        .refreshable { await reload() }
    }

    @ViewBuilder private func roleSection(_ role: String) -> some View {
        Section {
            Text(linkedRoleSentence(role))
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
                .fixedSize(horizontal: false, vertical: true)
            TextField(linkedRoleField(role), text: draftBinding(role))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textContentType(.URL)
            Button(busy == role ? "Checking…" : "Check and link") { Task { await link(role) } }
                .disabled(busy != nil || (drafts[role] ?? "").trimmingCharacters(in: .whitespaces).isEmpty)
            if links[role] != nil {
                Button("Unlink", role: .destructive) { Task { await unlink(role) } }
                    .disabled(busy != nil)
            }
            Text(describeLinkedRole(role, linked: links[role], fleetRunners: fleetRunners))
                .fleetType(.label)
                .foregroundStyle(Design.Palette.ink)
            if let check = checks[role] {
                Text(describeLinkedCheck(check))
                    .fleetType(.labelMono)
                    .foregroundStyle(check.ok ? Design.Palette.ink : Design.Palette.bad)
            }
            if let message = messages[role], !message.isBlank {
                Text(message)
                    .fleetType(.label)
                    .foregroundStyle(checks[role]?.ok == false ? Design.Palette.bad : Design.Palette.ink)
                    .textSelection(.enabled)
            }
        } header: {
            Text(linkedRoleTitle(role)).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
        }
    }

    private func draftBinding(_ role: String) -> Binding<String> {
        Binding(get: { drafts[role] ?? "" }, set: { drafts[role] = $0 })
    }

    @MainActor
    private func reload() async {
        do {
            let got = try await Fleet(settings: settings).linkedRepos()
            var found: [String: String] = [:]
            for link in got.links ?? [] { found[link.role] = link.repo }
            links = found
            fleetRunners = got.fleet?.runners
            for role in linkedRoles where (drafts[role] ?? "").isEmpty { drafts[role] = found[role] ?? "" }
            load = .answered
        } catch {
            load = .failed(error.localizedDescription)
        }
    }

    @MainActor
    private func link(_ role: String) async {
        busy = role
        defer { busy = nil }
        messages[role] = ""
        do {
            let r = try await Fleet(settings: settings).linkRepo(role: role, repo: (drafts[role] ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
            checks[role] = r.linkedRepo
            messages[role] = r.text ?? ""
            if r.ok == true, let repo = r.repo {
                links[role] = repo
                drafts[role] = repo
            }
        } catch {
            messages[role] = error.localizedDescription
        }
    }

    @MainActor
    private func unlink(_ role: String) async {
        busy = role
        defer { busy = nil }
        do {
            let r = try await Fleet(settings: settings).unlinkRepo(role: role)
            messages[role] = r.text ?? ""
            links[role] = nil
            checks[role] = nil
            drafts[role] = ""
        } catch {
            messages[role] = error.localizedDescription
        }
    }
}

/// The roles, in the order the screen draws them. Append only, like the
/// protocol's: a role this app has never heard of is not drawn.
let linkedRoles = ["archive", "runners", "templates"]

/// The section heading for a role.
func linkedRoleTitle(_ role: String) -> String {
    switch role {
    case "archive": return "Archive"
    case "runners": return "Runners"
    case "templates": return "Templates"
    default: return role
    }
}

/// What a role is for, and what linking it means, said before the button.
/// The same words on both phones; test/linked-repos-in-apps.test.js holds them.
func linkedRoleSentence(_ role: String) -> String {
    switch role {
    case "archive":
        return "Private. Each session you start is pushed here, on a branch of its own, before it stops and every ten minutes while it runs. A public repository is refused: this is your work, and possibly a client's."
    case "runners":
        return "Public, because Actions minutes are free only there. Your temporary machines start here. Anyone can read it, logs included, so it is a launcher and nothing else: no session writes into it."
    case "templates":
        return "Public or private. Skills, presets, configs and workflows a session can read when you ask it to. Nothing in it runs by itself."
    default:
        return ""
    }
}

/// The field's placeholder for a role.
func linkedRoleField(_ role: String) -> String {
    "Your \(role == "runners" ? "runner" : role == "templates" ? "templates" : "archive") repository (owner/repo)"
}

/// What is linked for a role now, in one sentence. For runners, the fleet's
/// repository is what applies with none of your own, as Temporary machines says.
func describeLinkedRole(_ role: String, linked: String?, fleetRunners: String?) -> String {
    if role == "runners" { return describeRunnerRepoSetting(saved: linked, fleet: fleetRunners) }
    if let linked { return "Linked: \(linked)." }
    return role == "archive"
        ? "Nothing linked. Sessions you start are not pushed anywhere when they stop."
        : "Nothing linked."
}

/// What a check found, one answer per fact, "can't tell" kept apart from "no".
func describeLinkedCheck(_ check: Fleet.LinkedRepoCheck) -> String {
    if check.role == "runners", let runner = check.runnerRepo { return describeRunnerCheck(runner) }
    func word(_ value: Bool?) -> String { value.map { $0 ? "yes" : "no" } ?? "can't tell" }
    let visibility = check.role == "archive"
        ? "Private: \(word(check.isPublic.map { !$0 }))"
        : "Public: \(word(check.isPublic))"
    var parts = [visibility, "GitHub app: \(word(check.installed))"]
    if check.role == "archive" {
        parts.append("Can write: \(word(check.contents.map { $0 == "write" }))")
        parts.append("You can push: \(word(check.push))")
    } else {
        parts.append("Can read: \(word(check.contents.map { $0 != "none" }))")
        if let carries = check.carries { parts.append("Carries: \(carries.isEmpty ? "none of the known shapes" : carries.joined(separator: ", "))") }
    }
    return parts.joined(separator: " · ")
}

/// The row under You: how many roles are linked, or that none are.
func describeLinkedRepos(_ count: Int) -> String {
    count == 0 ? "none linked" : "\(count) of \(linkedRoles.count) linked"
}
