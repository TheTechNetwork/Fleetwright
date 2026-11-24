import SwiftUI
import UIKit

/// The organization: who the fleet is made of, and who manages whom
/// (docs/members.md).
///
/// A MEMBER IS A PERSON OR AN AGENT with a role, a place in a tree and
/// standing instructions. Everybody in the fleet reads the list, because it is
/// how a person learns who does what. Who may change a member comes from the
/// tree: an admin anybody, a manager their own team, and the fleet says which
/// this person is (`you`), so a control is drawn only for somebody it will
/// answer (C-2).
///
/// TWO LISTS, IN THE ORDER A MANAGER NEEDS THEM. My team first, each member
/// with whether its vault holds a Claude sign-in, because "can it run" is the
/// question a manager opens this for. Then Everyone, as the tree, a report
/// indented under whoever it reports to. An admin manages everybody, so their
/// team is Everyone and is not drawn twice.
///
/// A SIGN-IN'S STATE IS THE VAULT'S ANSWER AND NOTHING ELSE. "Not signed in"
/// is said only when the member's vault answered without a Claude item. A
/// vault that could not be asked is "Not checked", which is a different fact
/// (C-5), and it is what a person member's row says until they let their
/// managers in.
///
/// The same words as Android (OrgScreen.kt), held equal by
/// test/members-in-apps.test.js.
struct OrgView: View {
    let settings: Settings

    private enum Load { case asking, answered, failed(String) }
    @State private var load = Load.asking
    @State private var members: [Fleet.Member] = []
    @State private var you: Fleet.Members.Standing?
    /// What each team member's vault said about a Claude sign-in, by id.
    /// Absent while it is being asked.
    @State private var signIns: [String: MemberSignIn] = [:]
    /// Every member as a file, once an admin asked for them.
    @State private var files: [Fleet.MemberFiles.File] = []
    @State private var importText = ""
    @State private var fileBusy = false
    @State private var fileResult = ""
    @State private var fileFailed = false

    private var isAdmin: Bool { you?.admin == true }
    private var manages: [String] { you?.manages ?? [] }
    /// The members this person manages, in the list's order. Empty for an
    /// admin, whose team is everybody.
    private var team: [Fleet.Member] { isAdmin ? [] : members.filter { manages.contains($0.id) } }
    /// Whether this person has anywhere to add a member: anywhere, for an
    /// admin; under their own member or a member they manage, for a manager.
    private var canAdd: Bool { isAdmin || you?.member != nil || !manages.isEmpty }

    var body: some View {
        Form {
            switch load {
            case .asking:
                Section {
                    Text("Loading…")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }
            case .failed(let why):
                // The result, then the reason smaller under it, as Linked
                // repositories says it: the reason is there to be copied.
                Section {
                    Text("Could not load the organization.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.bad)
                    Text(why)
                        .fleetType(.micro)
                        .foregroundStyle(Design.Palette.inkDim)
                        .textSelection(.enabled)
                    Button("Try again") { Task { await reload() } }
                }
            case .answered:
                if !team.isEmpty { teamSection }
                everyoneSection
                if isAdmin { filesSection }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Organization")
        .task { await reload() }
        .refreshable { await reload() }
    }

    @ViewBuilder private var teamSection: some View {
        Section {
            ForEach(team) { member in
                NavigationLink {
                    page(member)
                } label: {
                    HStack(spacing: Design.Space.insideTight) {
                        nameAndRole(member)
                        Spacer(minLength: 0)
                        Text(memberSignInWord(signIns[member.id]))
                            .fleetType(.label)
                            .foregroundStyle(signIns[member.id] == .signedIn ? Design.Palette.ink : Design.Palette.inkDim)
                    }
                    .frame(minHeight: 44)
                }
            }
        } header: {
            orgSectionHead("My team")
        }
    }

    @ViewBuilder private var everyoneSection: some View {
        Section {
            if members.isEmpty {
                Text(isAdmin ? "No members yet. Add the first one." : "No members yet. An admin adds the first one.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
            // THE TREE, a report indented under whoever it reports to, and
            // every row the same shape. Person or Agent is a word on the row,
            // never a colour.
            ForEach(orgRows(members)) { row in
                NavigationLink {
                    page(row.member)
                } label: {
                    HStack(spacing: Design.Space.insideTight) {
                        nameAndRole(row.member)
                        Spacer(minLength: 0)
                        Text(memberKindWord(row.member.kind))
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                    }
                    .padding(.leading, CGFloat(min(row.depth, 4)) * Design.Space.groupTight)
                    .frame(minHeight: 44)
                }
            }
            if canAdd {
                NavigationLink("Add a member") {
                    MemberForm(settings: settings, existing: nil, roster: members, you: you) { _ in
                        Task { await reload() }
                    }
                }
            }
        } header: {
            orgSectionHead("Everyone")
        }
    }

    /// Every member as a markdown file, for an admin: read them out, or paste
    /// one back in. A file is the record and the instructions, so a member
    /// can be written in an editor and reviewed like anything else.
    @ViewBuilder private var filesSection: some View {
        Section {
            Button(fileBusy ? "Loading…" : "Export as files") { Task { await export() } }
                .disabled(fileBusy)
            ForEach(files, id: \.name) { file in
                HStack {
                    Text(file.name)
                        .fleetType(.labelMono)
                        .foregroundStyle(Design.Palette.ink)
                    Spacer(minLength: Design.Space.insideTight)
                    Button("Copy") {
                        UIPasteboard.general.string = file.text
                        fileResult = "Copied \(file.name)."
                        fileFailed = false
                    }
                    .frame(minHeight: 44)
                    .accessibilityLabel("Copy \(file.name)")
                }
                .buttonStyle(.borderless)
            }
            TextField("Paste a member file", text: $importText, axis: .vertical)
                .lineLimit(3...8)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .fleetType(.labelMono)
            Button("Import a file") { Task { await importFile() } }
                .disabled(fileBusy || importText.isBlank)
            if !fileResult.isBlank {
                Text(fileResult)
                    .fleetType(.label)
                    .foregroundStyle(fileFailed ? Design.Palette.bad : Design.Palette.ink)
                    .textSelection(.enabled)
            }
        } header: {
            orgSectionHead("Files")
        } footer: {
            Text("Each member is one markdown file: the record, then the instructions. No credential is in one.")
        }
    }

    private func nameAndRole(_ member: Fleet.Member) -> some View {
        VStack(alignment: .leading, spacing: Design.Space.hair) {
            Text(member.name)
                .fleetType(.body)
                .foregroundStyle(Design.Palette.ink)
            Text(member.role)
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
        }
    }

    private func page(_ member: Fleet.Member) -> MemberView {
        MemberView(settings: settings, member: member, roster: members, you: you) {
            Task { await reload() }
        }
    }

    @MainActor
    private func reload() async {
        do {
            let got = try await Fleet(settings: settings).members()
            // Only an answer that carries the list is one: a fleet older
            // than members answers without it, and that is not "nobody".
            guard got.ok != false, let list = got.members else {
                load = .failed(got.text ?? "Your fleet did not send its members. It may need an update.")
                return
            }
            members = list
            you = got.you
            load = .answered
        } catch {
            load = .failed(error.localizedDescription)
            return
        }
        await checkTeam()
    }

    /// Ask each team member's vault whether it holds a Claude sign-in. One
    /// at a time, because each is a request this phone seals and the vault
    /// answers under one lock. A vault that refuses, or cannot be asked
    /// without this phone's GitHub sign-in, is Not checked and never Not
    /// signed in (C-5).
    @MainActor
    private func checkTeam() async {
        guard !team.isEmpty else { return }
        guard PhoneGitHub(settings: settings).signedIn else {
            for member in team { signIns[member.id] = .notChecked }
            return
        }
        let vault = PhoneVault(settings: settings)
        let fleet = Fleet(settings: settings)
        for member in team {
            if let contents = try? await vault.list(fleet, for: member.id) {
                signIns[member.id] = contents.items.contains { $0.name == "claude" } ? .signedIn : .notSignedIn
            } else {
                signIns[member.id] = .notChecked
            }
        }
    }

    @MainActor
    private func export() async {
        fileBusy = true
        defer { fileBusy = false }
        do {
            let got = try await Fleet(settings: settings).exportMembers()
            files = got.files ?? []
            fileResult = files.isEmpty ? "No members to export." : ""
            fileFailed = false
        } catch {
            fileResult = error.localizedDescription
            fileFailed = true
        }
    }

    @MainActor
    private func importFile() async {
        fileBusy = true
        defer { fileBusy = false }
        do {
            let reply = try await Fleet(settings: settings).importMember(text: importText)
            fileFailed = reply.ok != true
            fileResult = reply.text ?? (reply.ok == true ? "Imported." : "Your fleet refused that file.")
            if reply.ok == true {
                importText = ""
                await reload()
            }
        } catch {
            fileResult = error.localizedDescription
            fileFailed = true
        }
    }
}

/// One member: what it is, and what this person may do with it.
///
/// THE RECORD IS THE FLEET'S AND CUSTODY IS THE VAULT'S, and this page keeps
/// them apart (docs/members.md, "A member's vault"). The facts at the top are
/// the fleet's record. The Custody section is the vault's own answer, asked
/// once when the page opens: who may act for this member's vault, by the tree
/// the vault holds. Where the two differ, the page says custody has not been
/// filed for that change and offers to file it. It never draws the fleet's
/// tree as the vault's, and when the vault could not be asked it says so and
/// offers nothing that depends on the answer.
struct MemberView: View {
    let settings: Settings
    let member: Fleet.Member
    /// Everybody, for the name of whoever this member reports to.
    let roster: [Fleet.Member]
    let you: Fleet.Members.Standing?
    /// Told when the record changed or went, so the list behind this page asks again.
    var onChanged: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    /// The record as it was last saved from here, until the list behind this page has it.
    @State private var saved: Fleet.Member?
    private enum VaultLoad { case asking, answered(PhoneVault.Org), failed(String) }
    @State private var vaultOrg = VaultLoad.asking
    @State private var busy = false
    @State private var result = ""
    @State private var failed = false
    @State private var newCustodian = ""
    /// Remove is waiting on its dialog.
    @State private var removing = false
    @State private var removeResult = ""
    @State private var starting = false
    @State private var startResult = ""

    private var shown: Fleet.Member { saved ?? member }
    private var vault: PhoneVault { PhoneVault(settings: settings) }
    private var fleet: Fleet { Fleet(settings: settings) }
    private var isAdmin: Bool { you?.admin == true }
    private var mayEdit: Bool { isAdmin || (you?.manages ?? []).contains(member.id) }
    private var mayStart: Bool { (you?.startAs ?? []).contains(member.id) }
    /// This person's fleet address, as the vault lists people.
    private var me: String { settings.signedInAs.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    /// This member as the vault holds it, once the vault has answered.
    private var node: PhoneVault.OrgMember? {
        if case .answered(let org) = vaultOrg { return org.member(member.id) }
        return nil
    }

    /// Whether this person may open this member's vault: the vault lists
    /// them for it, and it is not their own person member, whose vault is
    /// already You, Credentials.
    private var mayOpenCredentials: Bool {
        guard let node, node.may.contains(me) else { return false }
        return !(shown.kind == "person" && (shown.email ?? "").lowercased() == me)
    }

    private var reportsToName: String {
        guard let id = shown.reportsTo, !id.isEmpty else { return "Nobody" }
        return roster.first { $0.id == id }?.name ?? id
    }

    var body: some View {
        Form {
            factsSection
            if let instructions = shown.instructions, !instructions.isEmpty {
                instructionsSection(instructions)
            }
            if mayEdit || mayStart || mayOpenCredentials { actionsSection }
            custodySection
            if mayEdit { removeSection }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle(shown.name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await askVault() }
        .sheet(isPresented: $starting) {
            StartSheet(settings: settings, onStart: startSession, asMember: shown)
        }
        // REMOVE ASKS FIRST, and says what it costs before it is done.
        .confirmationDialog("Remove \(shown.name)?", isPresented: $removing, titleVisibility: .visible) {
            Button("Remove member", role: .destructive) { Task { await remove() } }
        } message: {
            Text("Removes \(shown.name) from the organization. Its vault is not deleted; a custodian forgets what it keeps.")
        }
    }

    @ViewBuilder private var factsSection: some View {
        Section {
            LabeledContent("Role") { Text(shown.role).fleetType(.label) }
            if let title = shown.title, !title.isEmpty {
                LabeledContent("Title") { Text(title).fleetType(.label) }
            }
            LabeledContent("Kind") { Text(memberKindWord(shown.kind)).fleetType(.label) }
            LabeledContent("Reports to") { Text(reportsToName).fleetType(.label) }
            if let email = shown.email, !email.isEmpty {
                LabeledContent("Address") { Text(email).fleetType(.label).textSelection(.enabled) }
            }
            if let about = shown.description, !about.isEmpty {
                Text(about)
                    .fleetType(.body)
                    .foregroundStyle(Design.Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let types = shown.workTypes, !types.isEmpty {
                LabeledContent("Work types") { Text(types.joined(separator: ", ")).fleetType(.label) }
            }
            // WHAT RUNS IT, in the order to try: "Claude Code, then Codex
            // (gpt-5.1-codex)". Stacked, because three engines with their
            // models do not fit beside a label. Nothing is drawn for a
            // record with no engines, from a fleet older than them.
            if !shown.engineChoices.isEmpty {
                VStack(alignment: .leading, spacing: Design.Space.hair) {
                    Text("Engines")
                        .fleetType(.body)
                        .foregroundStyle(Design.Palette.ink)
                    Text(engineListWords(shown.engineChoices))
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
            if let tag = shown.hosts?.tag, !tag.isEmpty {
                LabeledContent("Machine tag") { Text(tag).fleetType(.label) }
            }
        }
    }

    /// What its sessions open with. Read here and changed under Edit; in a
    /// frame of its own that scrolls, because four kilobytes of instructions
    /// would otherwise push everything a person came to do off the screen.
    private func instructionsSection(_ text: String) -> some View {
        Section {
            ScrollView {
                Text(text)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .frame(maxHeight: 240)
        } header: {
            orgSectionHead("Instructions")
        } footer: {
            Text("Its sessions open with these.")
        }
    }

    @ViewBuilder private var actionsSection: some View {
        Section {
            if mayEdit {
                NavigationLink("Edit") {
                    MemberForm(settings: settings, existing: shown, roster: roster, you: you) { now in
                        saved = now
                        onChanged()
                        Task { await askVault() }
                    }
                }
            }
            // THE CREDENTIALS SCREEN, POINTED AT THIS MEMBER'S VAULT. Offered
            // only to somebody the vault itself lists for it.
            if mayOpenCredentials {
                NavigationLink("Credentials") {
                    MemberCredentialsView(settings: settings, member: shown)
                }
            }
            if mayStart {
                Button("Start a session as \(shown.name)") { starting = true }
                    .frame(minHeight: 44)
                if !startResult.isBlank {
                    Text(startResult)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                        .textSelection(.enabled)
                }
            }
        }
    }

    @ViewBuilder private var custodySection: some View {
        Section {
            switch vaultOrg {
            case .asking:
                Text("Checking…")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            case .failed(let why):
                // CANNOT TELL, said as that (C-5). Nothing below it depends
                // on an answer that did not come.
                Text("The vault could not be asked.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
                Text(why)
                    .fleetType(.micro)
                    .foregroundStyle(Design.Palette.inkDim)
                    .textSelection(.enabled)
                Button("Try again") { Task { await askVault() } }
            case .answered(let org):
                custodyRows(org)
            }
            if !result.isBlank {
                Text(result)
                    .fleetType(.label)
                    .foregroundStyle(failed ? Design.Palette.bad : Design.Palette.ink)
                    .textSelection(.enabled)
            }
        } header: {
            orgSectionHead("Custody")
        }
    }

    @ViewBuilder private func custodyRows(_ org: PhoneVault.Org) -> some View {
        let filed = org.member(member.id)
        if org.admins.isEmpty {
            // FIRST USE. Nothing can be filed until somebody administers the
            // organization in the vault, and the first is a fleet admin
            // filing themselves.
            Text("Nobody administers the organization in your vault yet.")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.ink)
            if isAdmin {
                Button("Become its first admin") {
                    act { try await vault.fileOrgAdmin(fleet, address: me) }
                }
                .disabled(busy)
            }
        } else if filed.map({ custodyDiffers($0, shown) }) ?? true {
            // THE FLEET'S RECORD AND THE VAULT'S TREE DISAGREE about this
            // member, or the vault has never heard of it. Custody follows
            // the vault's, so this says so and offers to file the change.
            Text("Custody is not filed for this change yet.")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.ink)
            if mayEdit {
                Button("File it") {
                    act {
                        try await vault.fileOrgMember(fleet, id: shown.id, kind: shown.kind, address: shown.email,
                                                      reportsTo: shown.reportsTo, managers: shown.managers ?? [])
                    }
                }
                .disabled(busy)
            }
        }
        if let filed {
            if filed.kind == "agent" {
                agentCustodians(filed)
            } else {
                // A PERSON'S VAULT IS THEIRS. Whether their managers may
                // manage it is their own switch, under You, Credentials, and
                // this only reports where the vault says it stands.
                Text(personCustodyLine(filed.custody))
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Who may act for an agent member's vault, as the vault lists them: its
    /// own custodians, and its managers for as long as the tree says so.
    /// Remove is on its own custodians only, since a manager's custody ends
    /// with the tree and not with a button, and adding or removing is offered
    /// only to somebody already on the list (C-2). The last custodian stays,
    /// and the vault's sentence says so.
    @ViewBuilder private func agentCustodians(_ filed: PhoneVault.OrgMember) -> some View {
        Text("Custodians")
            .fleetType(.bodyStrong)
            .foregroundStyle(Design.Palette.ink)
        if filed.may.isEmpty {
            Text("None yet.")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
        }
        ForEach(filed.may, id: \.self) { address in
            HStack(spacing: Design.Space.insideTight) {
                Text(address)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
                Spacer(minLength: 0)
                if !filed.custodians.contains(address) {
                    Text("Manager")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                } else if filed.may.contains(me) {
                    Button("Remove", role: .destructive) {
                        act { try await vault.setCustodian(fleet, member: filed.id, address: address, remove: true) }
                    }
                    .accessibilityLabel("Remove \(address)")
                    .disabled(busy)
                }
            }
            .frame(minHeight: 44)
            .buttonStyle(.borderless)
        }
        if filed.may.contains(me) {
            LabeledContent("Fleet address") {
                TextField("name@example.com", text: $newCustodian)
                    .multilineTextAlignment(.trailing)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.emailAddress)
            }
            Button("Add custodian") {
                let address = newCustodian.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                act {
                    let said = try await vault.setCustodian(fleet, member: filed.id, address: address)
                    newCustodian = ""
                    return said
                }
            }
            .disabled(busy || !newCustodian.contains("@"))
        }
    }

    @ViewBuilder private var removeSection: some View {
        Section {
            Button("Remove member", role: .destructive) { removing = true }
                .disabled(busy)
            if !removeResult.isBlank {
                Text(removeResult)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.bad)
                    .textSelection(.enabled)
            }
        }
    }

    @MainActor
    private func askVault() async {
        do {
            vaultOrg = .answered(try await vault.org(fleet))
        } catch {
            vaultOrg = .failed(error.localizedDescription)
        }
    }

    /// Run one change in the vault, say what it said, then show the vault as it is now.
    private func act(_ block: @escaping @MainActor () async throws -> String) {
        Task { @MainActor in
            busy = true
            result = ""
            defer { busy = false }
            do {
                result = try await block()
                failed = false
            } catch {
                failed = true
                result = error.localizedDescription
            }
            await askVault()
        }
    }

    @MainActor
    private func remove() async {
        busy = true
        defer { busy = false }
        do {
            let reply = try await fleet.removeMember(id: member.id)
            if reply.ok == true {
                onChanged()
                dismiss()
            } else {
                removeResult = reply.text ?? "Your fleet refused that."
            }
        } catch {
            removeResult = error.localizedDescription
        }
    }

    /// Send the start New session described, as this member. The sheet has
    /// closed by now and nobody waits: the answer is a line on this page and
    /// a notification, as it is from Sessions.
    private func startSession(_ request: StartRequest) {
        startResult = "Starting a session as \(shown.name). You will get a notification when it is ready."
        Task {
            do {
                let reply = try await Fleet(settings: settings).start(
                    name: nil,
                    title: request.title,
                    brief: request.brief,
                    mode: request.mode,
                    host: request.host,
                    profile: request.profile,
                    secret: request.secret,
                    task: request.task,
                    member: request.member
                )
                let text = reply.text ?? "Started."
                await MainActor.run { startResult = text }
                LocalNotice.post(title: reply.ok == false ? reply.refusedStartTitle : "Session ready", body: text)
            } catch {
                // A timeout is not a failure: the start carries an id the
                // fleet honours, so the session may well exist.
                let timedOut = (error as NSError).code == NSURLErrorTimedOut
                let text = timedOut ? "Not sure it started. Look under Sessions." : error.localizedDescription
                await MainActor.run { startResult = text }
                LocalNotice.post(title: timedOut ? "Session may be starting" : "Could not start a session", body: text)
            }
        }
    }
}

/// Make a member, or change one: the record's fields, each with its name
/// beside it, because a form of twelve filled fields with only placeholders
/// cannot be read back.
///
/// WHAT IS OFFERED IS WHAT THE FLEET WILL TAKE from this person (C-2). Kind is
/// chosen once, when the member is made, since its vault is kept under what it
/// is. Whose address a person member is, and the extra managers beside the
/// tree, are an admin's. A manager chooses Reports to from their own member
/// and the members they manage, which is the team they may place somebody in.
/// A refusal is the fleet's own sentence, shown under Save.
struct MemberForm: View {
    let settings: Settings
    let existing: Fleet.Member?
    let roster: [Fleet.Member]
    let you: Fleet.Members.Standing?
    let onSaved: (Fleet.Member) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var role: String
    @State private var title: String
    @State private var kind: String
    @State private var email: String
    @State private var reportsTo: String
    @State private var about: String
    @State private var workTypes: String
    @State private var instructions: String
    /// What runs it, in the order to try (docs/engines.md). Never empty:
    /// a new member starts on Claude Code, as one that names none does.
    @State private var engines: [EngineChoice]
    @State private var tag: String
    @State private var budget: String
    @State private var managers: String
    @State private var busy = false
    @State private var result = ""

    init(settings: Settings, existing: Fleet.Member?, roster: [Fleet.Member], you: Fleet.Members.Standing?,
         onSaved: @escaping (Fleet.Member) -> Void) {
        self.settings = settings
        self.existing = existing
        self.roster = roster
        self.you = you
        self.onSaved = onSaved
        // A manager's new member starts under their own member, which is
        // where they may put one. An admin's starts at the top.
        let startUnder = you?.admin == true ? "" : (you?.member ?? you?.manages?.first ?? "")
        _name = State(initialValue: existing?.name ?? "")
        _role = State(initialValue: existing?.role ?? "")
        _title = State(initialValue: existing?.title ?? "")
        _kind = State(initialValue: existing?.kind ?? "agent")
        _email = State(initialValue: existing?.email ?? "")
        _reportsTo = State(initialValue: existing == nil ? startUnder : (existing?.reportsTo ?? ""))
        _about = State(initialValue: existing?.description ?? "")
        _workTypes = State(initialValue: (existing?.workTypes ?? []).joined(separator: ", "))
        _instructions = State(initialValue: existing?.instructions ?? "")
        let named = existing?.engineChoices ?? []
        _engines = State(initialValue: named.isEmpty ? [EngineChoice(engine: engineDefault, model: nil)] : named)
        _tag = State(initialValue: existing?.hosts?.tag ?? "")
        _budget = State(initialValue: (existing?.budgetUsdMonth).map { memberBudgetText($0) } ?? "")
        _managers = State(initialValue: (existing?.managers ?? []).joined(separator: ", "))
    }

    private var isAdmin: Bool { you?.admin == true }
    private var creating: Bool { existing == nil }

    /// Whom this member may be placed under by this person: anybody else,
    /// for an admin; their own member and their team, for a manager.
    private var reportsToChoices: [Fleet.Member] {
        if isAdmin { return roster.filter { $0.id != existing?.id } }
        var allowed = Set(you?.manages ?? [])
        if let own = you?.member { allowed.insert(own) }
        return roster.filter { allowed.contains($0.id) && $0.id != existing?.id }
    }

    var body: some View {
        Form {
            Section {
                field("Name", text: $name)
                if creating {
                    // The id is the member's name in every command and file,
                    // made from the name once and kept.
                    Text("Id: \(memberSlug(name).isEmpty ? "from the name" : memberSlug(name))")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }
                field("Role", text: $role, prompt: "software engineer")
                field("Title", text: $title, prompt: "Optional")
                if creating {
                    Picker("Kind", selection: $kind) {
                        Text("Agent").tag("agent")
                        Text("Person").tag("person")
                    }
                    .pickerStyle(.segmented)
                }
                // A new person member needs an address from whoever makes
                // it. Changing whose address it is afterwards is an admin's.
                if kind == "person", isAdmin || creating {
                    field("Address", text: $email, prompt: "name@example.com")
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.emailAddress)
                }
                Picker("Reports to", selection: $reportsTo) {
                    if isAdmin { Text("Nobody").tag("") }
                    ForEach(reportsToChoices) { member in
                        Text(member.name).tag(member.id)
                    }
                }
            }

            Section {
                TextField("What this member is for", text: $about, axis: .vertical)
                    .lineLimit(2...5)
                field("Work types", text: $workTypes, prompt: "backend, review")
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                orgSectionHead("Description")
            }

            Section {
                TextField("What its sessions open with", text: $instructions, axis: .vertical)
                    .lineLimit(4...12)
            } header: {
                orgSectionHead("Instructions")
            } footer: {
                Text("Its sessions open with these, before the task.")
            }

            // WHAT RUNS IT, as an ordered list (MemberEnginesEditor): the
            // one model field this had could name Claude Code's model and
            // nothing else.
            Section {
                MemberEnginesEditor(engines: $engines)
            } header: {
                orgSectionHead("Engines")
            } footer: {
                Text("A session starts on the first of these its machine runs, and moves to the next when one stops at its limit.")
            }

            Section {
                field("Machine tag", text: $tag, prompt: "Optional")
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                orgSectionHead("Where it runs")
            }

            Section {
                field("Monthly budget (USD)", text: $budget, prompt: "Optional")
                    .keyboardType(.decimalPad)
            } footer: {
                Text("Stored. Nothing enforces it yet.")
            }

            if isAdmin {
                Section {
                    field("Extra managers", text: $managers, prompt: "a@example.com, b@example.com")
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.emailAddress)
                } footer: {
                    Text("Fleet addresses that manage this member beside the tree, separated by commas. At most 4.")
                }
            }

            Section {
                // Not sent with no engine, or with an OpenCode that names
                // no model: the row under Engines says what is missing.
                Button(busy ? "Saving…" : "Save") { Task { await save() } }
                    .disabled(busy || name.isBlank || role.isBlank || memberEnginesToSend(engines).list == nil)
                if !result.isBlank {
                    Text(result)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.bad)
                        .textSelection(.enabled)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle(existing.map { "Edit \($0.name)" } ?? "Add a member")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// One field with its name beside it, so a filled form can be read back.
    private func field(_ label: String, text: Binding<String>, prompt: String = "") -> some View {
        LabeledContent(label) {
            TextField(prompt.isEmpty ? label : prompt, text: text)
                .multilineTextAlignment(.trailing)
        }
    }

    @MainActor
    private func save() async {
        busy = true
        defer { busy = false }
        result = ""
        let id = existing?.id ?? memberSlug(name)
        guard !id.isEmpty else {
            result = "Give the member a name with a letter or a digit in it."
            return
        }
        // A new member whose id is taken would overwrite that member, since
        // saving one is how it is changed. Refused here, by name.
        if creating, roster.contains(where: { $0.id == id }) {
            result = "\(id) is already a member. Choose another name."
            return
        }
        var fields: [String: Any] = [
            "name": name.trimmingCharacters(in: .whitespacesAndNewlines),
            "kind": kind,
            "role": role.trimmingCharacters(in: .whitespacesAndNewlines),
            "title": title.trimmingCharacters(in: .whitespacesAndNewlines),
            "description": about.trimmingCharacters(in: .whitespacesAndNewlines),
            "workTypes": memberList(workTypes),
            "instructions": instructions,
            // Extra managers are an admin's; a manager sends back what was there.
            "managers": isAdmin ? memberList(managers) : (existing?.managers ?? []),
        ]
        if !reportsTo.isEmpty { fields["reportsTo"] = reportsTo }
        if kind == "person" {
            fields["email"] = isAdmin || creating
                ? email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                : (existing?.email ?? "")
        }
        // THE LIST, IN ITS ORDER, and never an empty one or an OpenCode
        // with no model, whatever pressed Save. The rest of the rules are
        // your fleet's, and its refusal is the sentence under the button.
        let sending = memberEnginesToSend(engines)
        guard let list = sending.list else {
            result = sending.problem ?? "A member has at least one engine."
            return
        }
        fields["engines"] = list
        var placement: [String: String] = [:]
        let tagName = tag.trimmingCharacters(in: .whitespacesAndNewlines)
        if !tagName.isEmpty { placement["tag"] = tagName }
        fields["hosts"] = placement
        let budgetText = budget.trimmingCharacters(in: .whitespacesAndNewlines)
        if !budgetText.isEmpty {
            guard let amount = Double(budgetText), amount >= 0 else {
                result = "The monthly budget is a number of dollars, or empty."
                return
            }
            fields["budgetUsdMonth"] = amount
        }
        do {
            let reply = try await Fleet(settings: settings).saveMember(id: id, fields: fields)
            if reply.ok == true, let member = reply.member {
                onSaved(member)
                dismiss()
            } else {
                result = reply.text ?? "Your fleet refused that."
            }
        } catch {
            result = error.localizedDescription
        }
    }
}

/// A member's credentials: the Credentials screen's vault, pointed at this
/// member's vault for one of its custodians. Every request it makes names the
/// member, and the vault decides whether this person may make it.
struct MemberCredentialsView: View {
    let settings: Settings
    let member: Fleet.Member

    var body: some View {
        Form {
            Section {
                YourVault(settings: settings, member: member)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("\(member.name)'s credentials")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private func orgSectionHead(_ text: String) -> some View {
    Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
}

/// What a team member's vault said about a Claude sign-in.
enum MemberSignIn: Equatable {
    /// The vault answered, and it holds a Claude item.
    case signedIn
    /// The vault answered, and it holds none.
    case notSignedIn
    /// The vault could not be asked, or refused: cannot tell (C-5).
    case notChecked
}

/// The row's words for a sign-in's state. Nil is still being asked. The same
/// words on both phones (test/members-in-apps.test.js).
func memberSignInWord(_ state: MemberSignIn?) -> String {
    switch state {
    case .some(.signedIn): return "Signed in to Claude"
    case .some(.notSignedIn): return "Not signed in"
    case .some(.notChecked): return "Not checked"
    case .none: return "Checking…"
    }
}

/// Person or Agent, as a word on the row.
func memberKindWord(_ kind: String) -> String {
    kind == "agent" ? "Agent" : "Person"
}

/// Whether a person lets their managers manage their credentials, as the
/// vault says it. Anything else is an answer this build has not met, and is
/// said as unknown and never as off (C-5). The same sentences as Android.
func personCustodyLine(_ custody: String?) -> String {
    switch custody ?? "" {
    case "allowed": return "Lets their managers manage their credentials."
    case "off": return "Has not let their managers manage their credentials."
    case "no_vault": return "Has not signed in on a phone yet, so there is no vault to manage."
    default: return "Unknown."
    }
}

/// The row under You: how many members the organization has.
func describeOrganization(_ count: Int) -> String {
    count == 0 ? "no members yet" : count == 1 ? "1 member" : "\(count) members"
}

/// One row of the tree: a member, and how far under the top it sits.
struct OrgRow: Identifiable, Hashable {
    let member: Fleet.Member
    let depth: Int
    var id: String { member.id }
}

/// The members as a tree, flattened for a list: each member that reports to
/// nobody in the list, in the list's order, followed by its reports, and
/// theirs. A member caught in a loop, which the fleet refuses to save, is
/// still drawn, at the top, so nobody is ever missing from Everyone.
func orgRows(_ members: [Fleet.Member]) -> [OrgRow] {
    let ids = Set(members.map(\.id))
    var out: [OrgRow] = []
    var placed = Set<String>()
    func place(_ member: Fleet.Member, _ depth: Int) {
        guard !placed.contains(member.id) else { return }
        placed.insert(member.id)
        out.append(OrgRow(member: member, depth: depth))
        for report in members where report.reportsTo == member.id { place(report, depth + 1) }
    }
    for member in members where !ids.contains(member.reportsTo ?? "") { place(member, 0) }
    for member in members where !placed.contains(member.id) { place(member, 0) }
    return out
}

/// Whether the vault's place for a member differs from the fleet's record
/// in anything custody follows: what it is, whose address, whom it reports
/// to, and the managers named beside the tree.
func custodyDiffers(_ filed: PhoneVault.OrgMember, _ member: Fleet.Member) -> Bool {
    let managers = Set((member.managers ?? []).map { $0.lowercased() })
    return filed.kind != member.kind
        || (filed.reportsTo ?? "") != (member.reportsTo ?? "")
        || Set(filed.managers.map { $0.lowercased() }) != managers
        || (filed.email ?? "").lowercased() != (member.email ?? "").lowercased()
}

/// A member's id from its name: lowercase letters, digits and single
/// hyphens, at most 40, as the fleet takes one.
func memberSlug(_ name: String) -> String {
    var out = ""
    for ch in name.lowercased() {
        if ch.isASCII, ch.isLetter || ch.isNumber {
            out.append(ch)
        } else if !out.isEmpty, !out.hasSuffix("-") {
            out.append("-")
        }
    }
    var slug = String(out.prefix(40))
    while slug.hasSuffix("-") { slug.removeLast() }
    return slug
}

/// A comma-separated field as a list: trimmed, lowercased, empties dropped.
func memberList(_ text: String) -> [String] {
    text.split(separator: ",")
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        .filter { !$0.isEmpty }
}

/// A budget as the field shows it: whole dollars without a decimal point.
func memberBudgetText(_ amount: Double) -> String {
    amount == amount.rounded() ? String(Int(amount)) : String(amount)
}
