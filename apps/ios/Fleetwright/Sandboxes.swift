import SwiftUI

/// Machines rented from a sandbox provider (docs/api-engines.md, "A machine
/// from a sandbox provider"): the provider's key and templates in your own
/// vault, and the words every screen says about a machine made there.
///
/// A THIRD KIND OF PLACE A MACHINE CAN BE MADE, beside the two hypervisors.
/// To the fleet it is one more source of machine images, so making one,
/// ending one and giving one more time are the screens that already exist:
/// New session offers its templates, Hypervisors lists it, and a machine made
/// there has a page. What is new is here: how its key is kept, and the
/// sentences that say a rented machine is not one of yours.
///
/// NOTHING KEPT IS READ BACK. A vault answers with names and never with
/// values, so there is no editing a kept provider: replacing it is the form
/// again, empty, and the form says so.
///
/// AND A FOURTH, WHICH IS NOT RENTED AT ALL (docs/api-engines.md, "A machine
/// on a box of your own"): one of your own machines making a machine out of
/// a container of its own. It comes through the same seam, as the same kind
/// of place, image and machine, marked `own`, so the same screens draw it.
/// No key is kept for it and nothing here adds one: its operator turns it on
/// on that machine. Every sentence above that says rented, a cloud or who
/// can read it is false of it, so it has its own, at the foot of
/// `SandboxWords`.
///
/// The same words as Android (Sandboxes.kt) and the signing page, held equal
/// by test/api-engines-in-apps.test.js.

/// A provider machines can be rented from, as the fleet's own table has it
/// (`SANDBOX_PROVIDER_NAMES` in src/fleet/protocol/sandboxes.js).
struct SandboxProvider: Hashable {
    let id: String
    let says: String
}

/// The providers there are. One, so the form says it as text and offers no
/// picker of one.
let sandboxProviders = [SandboxProvider(id: "e2b", says: "E2B")]

/// How many templates one provider's record offers, and how long a
/// template's name may be, as the vault keeps them.
let sandboxTemplateLimit = 12
let sandboxTemplateNameLimit = 60

/// What a template's id may be, as the vault reads one. CHECKED HERE AS WELL,
/// because the vault drops a template whose id it cannot read and keeps the
/// rest without a word: a person would see "Kept" over a list one short.
let sandboxTemplateIdPattern = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"

/// One template to offer: the provider's own id for it, and what New session
/// calls it.
struct SandboxTemplate: Hashable, Identifiable {
    let id: String
    let name: String
}

/// Whether this is an id the vault will keep.
func isSandboxTemplateId(_ id: String) -> Bool {
    id.range(of: sandboxTemplateIdPattern, options: .regularExpression) != nil
}

/// The provider a vault item is the record of, by name ("E2B"), or nil for
/// any other item and for a provider this build has never met.
func sandboxProviderName(item: String) -> String? {
    guard item.hasPrefix("sandbox:") else { return nil }
    let id = String(item.dropFirst("sandbox:".count))
    return sandboxProviders.first { $0.id == id }?.says
}

/// A provider's record as the vault keeps it: JSON text holding the key and
/// the templates, each an id and a name. Nil with no key or no template,
/// which is never sent: a machine is made from a template, so a record with
/// none could make nothing.
func sandboxRecordText(key: String, templates: [SandboxTemplate]) -> String? {
    let secret = key.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !secret.isEmpty, !templates.isEmpty else { return nil }
    let record: [String: Any] = ["key": secret, "templates": templates.map { ["id": $0.id, "name": $0.name] }]
    guard let data = try? JSONSerialization.data(withJSONObject: record) else { return nil }
    return String(data: data, encoding: .utf8)
}

/// The words, in one place because five screens say them.
enum SandboxWords {
    /// What a row on Hypervisors calls it, where a hypervisor says its kind.
    static let kind = "Sandbox provider"
    /// The heading over rented machines in the list of machines.
    static let rentedHeader = "At a sandbox provider"
    static let needsGitHub = "Sign in to GitHub under You › Account first. That is how your saved credentials are reached."
    static let needsTemplate = "Add at least one template. A machine is made from one."
    static let needsKey = "Enter the API key."
    static let replaceLine = "Nothing kept is shown. Enter the key and every template again."
    static let badTemplateId = "A template id is letters, digits, dots, dashes and underscores, starting with a letter or a digit, up to 64."
    static let templateTwice = "That template is already in the list."

    /// What to know before the key is kept, one line each: what the key is,
    /// where a machine made with it runs and who can read it, that it ends,
    /// what a template has to do, and whose switch it waits on.
    static func before(_ provider: String) -> [String] {
        [
            "The key is your whole \(provider) account.",
            "A machine made there is on \(provider)’s cloud, and \(provider) can read what runs on it.",
            "It ends on a timer.",
            "A template has to be built to join your fleet. One that is not stays up, unused, until its time runs out.",
            "One of your machines makes these, and only after its operator turned \(provider) on there.",
        ]
    }

    static func templatesFooter(_ provider: String) -> String {
        "The id is the template’s own, from \(provider). The name is what New session calls it. At most \(sandboxTemplateLimit)."
    }

    /// Under New session › Where, for a template: what kind of machine it
    /// is and how it ends.
    static func rented(_ provider: String) -> String {
        "A rented machine on \(provider)’s cloud. It ends when its time runs out, with everything on it."
    }

    /// On a rented machine's own page, under what it is.
    static func machineFooter(_ provider: String) -> String {
        "Rented from \(provider), on its cloud. \(provider) can read what runs on it."
    }

    /// Under More time: the provider counts from now, so a time shorter
    /// than what is left ends it sooner, and the page says which it is.
    static func timeFooter(_ provider: String) -> String {
        "The time is counted from now, as \(provider) counts it."
    }

    /// The row on a machine's own page that opens its page at the provider.
    static func hostLink(_ provider: String) -> String {
        "At \(provider): more time and end"
    }

    /// How many templates a provider offers, for its page.
    static func templates(_ count: Int) -> String {
        count == 1 ? "1 template" : "\(count) templates"
    }

    // A BOX OF YOUR OWN (docs/api-engines.md, part three). The place, its
    // image and a machine made there are marked `own` by the fleet, and then
    // `provider` is that machine's name and not a company's. Nothing here
    // says rented, a cloud, a template or who can read it: none is true of a
    // container on a machine you enrolled.

    /// What a row on Hypervisors calls it, where a provider says its kind.
    static let ownKind = "One of your machines"
    /// The heading over machines made on one, in the list of machines.
    static let ownHeader = "On one of your machines"
    /// Where the machine's name would go, when the fleet sent none.
    static let ownUnnamed = "one of your machines"
    /// On a machine's page there: what a container has not got, said once
    /// where the controls for them would be on a hypervisor's machine.
    static let ownNeedsHypervisor = "A network, a lab, a restart, a resize and a console need a hypervisor."
    /// Under More time: the box adds the minutes to the end it already had,
    /// where a provider counts from now.
    static let ownTimeFooter = "The time is added to when it would have ended."

    /// Under New session › Where, for an image there: what kind of machine
    /// it is and how it ends.
    static func ownMachine(_ box: String) -> String {
        "A container on \(box), one of your own machines. It ends when its time runs out, with everything on it."
    }

    /// On a machine's own page there, under what it is.
    static func ownMachineFooter(_ box: String) -> String {
        "A container on \(box), one of your own machines."
    }

    /// The row on a machine's own page that opens its page on the box.
    static func ownHostLink(_ box: String) -> String {
        "On \(box): more time and end"
    }

    /// On the place's page: whose switch it is, because no screen here
    /// turns it on or off. With no name sent, the sentence has no owner to
    /// put an apostrophe on, so it starts another way.
    static func ownSwitch(_ box: String?) -> String {
        guard let box else { return "Its operator turned this on, on that machine, and turns it off there." }
        return "\(box)’s operator turned this on, on that machine, and turns it off there."
    }
}

/// Add a sandbox provider, or replace or forget the one kept: its API key
/// and the templates to offer, in your own vault as `sandbox:<provider>`.
/// Reached from Hypervisors, which is where the places a machine can be made
/// are listed.
///
/// A SHORT FORM, AND WHAT IT COSTS BEFORE THE BUTTON. The key is the whole
/// account at the provider, and a machine made with it is on somebody else's
/// cloud, so the five things to know are said above Keep and not in a
/// footer under it.
///
/// THE KEY IS TYPED INTO A FIELD THAT HIDES IT, emptied when the vault took
/// it and when this screen is left. The templates are not secret and stay
/// until it is kept, so a refusal can be read against them.
///
/// FIVE STATES: this phone has no GitHub sign-in to reach the vault with,
/// the vault has not answered yet, it did not answer, it keeps none (the
/// form), and it keeps one (its row, with Replace and Forget).
struct SandboxProviderView: View {
    let settings: Settings

    /// The one provider there is. Computed, so it is no part of how this
    /// view is made by the page that opens it.
    private var provider: SandboxProvider { sandboxProviders[0] }

    /// When one was kept, or nil for none; `answered` is whether the vault
    /// has said, since nil before it has is unknown.
    @State private var keptAt: Double?
    @State private var isKept = false
    @State private var answered = false
    @State private var loadFailed: String?
    /// Replace was pressed, so the form is drawn under the kept row.
    @State private var replacing = false
    @State private var key = ""
    @State private var templates: [SandboxTemplate] = []
    @State private var newId = ""
    @State private var newName = ""
    @State private var templateProblem = ""
    @State private var busy = false
    @State private var message = ""
    @State private var failed = false
    @State private var forgetting = false

    private var vault: PhoneVault { PhoneVault(settings: settings) }
    private var fleet: Fleet { Fleet(settings: settings) }
    private var itemName: String { "sandbox:\(provider.id)" }
    private var title: String { PhoneVault.label(itemName) }

    var body: some View {
        Form {
            if !PhoneGitHub(settings: settings).signedIn {
                Section {
                    Text(SandboxWords.needsGitHub)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else if let why = loadFailed {
                Section {
                    Text("Could not load your saved credentials.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.bad)
                    Text(why)
                        .fleetType(.micro)
                        .foregroundStyle(Design.Palette.inkDim)
                        .textSelection(.enabled)
                    Button("Try again") { Task { await load() } }
                        .frame(minHeight: 44)
                }
            } else if !answered {
                Section {
                    Text("Asking your vault…")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }
            } else {
                if isKept { keptSection }
                if !isKept || replacing {
                    keySection
                    templatesSection
                    keepSection
                }
            }
            if !message.isBlank {
                Section {
                    Text(message)
                        .fleetType(.label)
                        .foregroundStyle(failed ? Design.Palette.bad : Design.Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle(SandboxWords.kind)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        // LEAVING THE SCREEN EMPTIES THE FIELD, so a key typed and not kept
        // is not waiting there for the next person to open this page.
        .onDisappear { key = "" }
        .confirmationDialog("Forget \(title)?", isPresented: $forgetting, titleVisibility: .visible) {
            Button("Forget", role: .destructive) { Task { await forget() } }
        } message: {
            Text(PhoneVault.forgetting(itemName))
        }
    }

    /// The kept one, in the shape every kept item has: its name, that it is
    /// kept and since when, and what can be done about it.
    @ViewBuilder private var keptSection: some View {
        Section {
            HStack(spacing: Design.Space.insideTight) {
                Text(title)
                    .fleetType(.body)
                    .foregroundStyle(Design.Palette.ink)
                Spacer()
                Text("Kept")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                Button("Replace") {
                    withAnimation(Design.Motion.change) { replacing.toggle() }
                }
                .accessibilityLabel("Replace \(title)")
                .disabled(busy)
                Button("Forget", role: .destructive) { forgetting = true }
                    .accessibilityLabel("Forget \(title)")
                    .disabled(busy)
            }
            .frame(minHeight: 44)
            .buttonStyle(.borderless)
            if let since = taskTime(keptAt) {
                Text("Since \(since)")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
            }
        }
    }

    /// Which provider, as text because there is one, and its key.
    @ViewBuilder private var keySection: some View {
        Section {
            LabeledContent("Provider") {
                Text(provider.says)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
            }
            SecureField("\(provider.says) API key", text: $key)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .frame(minHeight: 44)
            if isKept {
                Text(SandboxWords.replaceLine)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } header: {
            sectionHead(isKept ? "Replace it" : "Add a sandbox provider")
        }
    }

    /// The templates to offer, every one a row of the same shape, and the
    /// two fields that add one. Not offered past the twelve the vault keeps.
    @ViewBuilder private var templatesSection: some View {
        Section {
            if templates.isEmpty {
                Text("No templates yet.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
            ForEach(templates) { template in
                HStack(spacing: Design.Space.insideTight) {
                    VStack(alignment: .leading, spacing: Design.Space.hair) {
                        Text(template.name)
                            .fleetType(.body)
                            .foregroundStyle(Design.Palette.ink)
                        if template.name != template.id {
                            Text(template.id)
                                .fleetType(.labelMono)
                                .foregroundStyle(Design.Palette.inkDim)
                        }
                    }
                    Spacer(minLength: 0)
                    Button("Remove", role: .destructive) { remove(template) }
                        .accessibilityLabel("Remove \(template.name)")
                        .disabled(busy)
                        .frame(minHeight: 44)
                }
                .buttonStyle(.borderless)
                .frame(minHeight: 44)
            }
            if templates.count < sandboxTemplateLimit {
                LabeledContent("Template id") {
                    TextField("As \(provider.says) names it", text: $newId)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                LabeledContent("Name") {
                    TextField("Optional", text: $newName)
                        .multilineTextAlignment(.trailing)
                        .autocorrectionDisabled()
                        .accessibilityLabel("Name for the template")
                }
                if !templateProblem.isEmpty {
                    Text(templateProblem)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.bad)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Button("Add the template") { add() }
                    .disabled(busy || newId.isBlank)
                    .frame(minHeight: 44)
            } else {
                Text("That is all \(sandboxTemplateLimit). Remove one to add another.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } header: {
            sectionHead("Templates")
        } footer: {
            Text(SandboxWords.templatesFooter(provider.says))
        }
    }

    /// What it costs, then the button. Keep is not offered without a key or
    /// without a template, and the line under it says which is missing.
    @ViewBuilder private var keepSection: some View {
        Section {
            ForEach(SandboxWords.before(provider.says), id: \.self) { line in
                Text(line)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button(busy ? "Keeping…" : "Keep in your vault") { Task { await keep() } }
                .disabled(busy || key.isBlank || templates.isEmpty)
                .frame(minHeight: 44)
            if templates.isEmpty {
                Text(SandboxWords.needsTemplate)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } header: {
            sectionHead("Before you keep it")
        }
    }

    private func sectionHead(_ text: String) -> some View {
        Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
    }

    /// Put the template on the list, once. An id the vault would drop is
    /// refused here, in a sentence, and the fields are left as typed.
    private func add() {
        let id = newId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard templates.count < sandboxTemplateLimit else { return }
        guard isSandboxTemplateId(id) else {
            templateProblem = SandboxWords.badTemplateId
            return
        }
        guard !templates.contains(where: { $0.id == id }) else {
            templateProblem = SandboxWords.templateTwice
            return
        }
        // A name the vault would cut is cut here, where it can be seen.
        let named = String(newName.trimmingCharacters(in: .whitespacesAndNewlines).prefix(sandboxTemplateNameLimit))
        withAnimation(Design.Motion.change) {
            templates.append(SandboxTemplate(id: id, name: named.isEmpty ? id : named))
        }
        newId = ""
        newName = ""
        templateProblem = ""
        message = ""
    }

    private func remove(_ template: SandboxTemplate) {
        withAnimation(Design.Motion.change) { templates.removeAll { $0.id == template.id } }
        message = ""
    }

    @MainActor
    private func load() async {
        guard PhoneGitHub(settings: settings).signedIn else { return }
        do {
            let contents = try await vault.list(fleet)
            let kept = contents.items.first { $0.name == itemName }
            isKept = kept != nil
            keptAt = kept?.at
            loadFailed = nil
            answered = true
        } catch {
            // A VAULT THAT DID NOT ANSWER IS NOT ONE THAT KEEPS NONE: the
            // form is not drawn over a provider that may be kept.
            loadFailed = error.localizedDescription
        }
    }

    /// Keep the key and every template, say what the vault said, and show
    /// the vault as it is now. The key is emptied only once it was taken.
    @MainActor
    private func keep() async {
        busy = true
        defer { busy = false }
        message = ""
        do {
            message = try await vault.keepSandbox(fleet, provider: provider.id, key: key, templates: templates)
            failed = false
            key = ""
            templates = []
            replacing = false
        } catch {
            message = error.localizedDescription
            failed = true
            return
        }
        await load()
    }

    @MainActor
    private func forget() async {
        busy = true
        defer { busy = false }
        message = ""
        do {
            message = try await vault.forget(fleet, name: itemName)
            failed = false
            replacing = false
        } catch {
            message = error.localizedDescription
            failed = true
        }
        await load()
    }
}
