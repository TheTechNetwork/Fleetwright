import SwiftUI

/// Starting a session, without asking anybody to name a thing they have not
/// done yet.
///
/// THE SHAPE, and it is the opposite of the obvious one:
///
///   ordinary form:  [ Name ________ ]  [ Start ]     <- stalls here
///   this one:       [ What is this about? ______ ]
///                   [ Title: suggested, editable ]
///                   [ Start ]
///
/// The brief is first because it is RECALL — you already know what you are
/// about to do. The title is composition, which is harder, so it is offered
/// rather than demanded. And Start is enabled from the first moment: leaving
/// everything blank is a perfectly good answer that gets you what the app did
/// before any of this existed.
///
/// docs/naming.md has the reasoning. The short version is that the blank name
/// field was the abandonment point, and every choice here is aimed at it.
/// What the sheet collected. Handed up rather than sent from here, so the
/// request outlives the sheet that described it.
struct StartRequest {
    let title: String?
    let brief: String?
    let mode: String?
    let host: String?
    /// WHAT IT WILL DO, by name. nil means the session comes up idle at an
    /// empty prompt and somebody has to drive it — which is what every session
    /// did before protocol v3, and what nothing said out loud.
    let profile: String?
    /// OR WHAT IT WILL DO, in words (protocol v7): its first message. Either
    /// this or `profile`, never both.
    var task: String? = nil
    /// WHAT IT MAY REACH, by name. nil grants nothing. The value never travels
    /// with this — the host resolves the name and the session fetches the value
    /// at runtime. See docs/trust.md.
    let secret: String?
    /// A NEW TEMPORARY MACHINE to start it on, by operating system, or nil for
    /// a machine the fleet already has. When set, `host`, `profile` and
    /// `secret` are nil: the machine does not exist yet, and a runner holds no
    /// task profiles or secrets of its own. `task` travels: it is how a
    /// machine minutes old is given its job.
    var platform: String? = nil
    /// How long that machine stays, in minutes. Only with `platform`.
    var minutes: Int? = nil
    /// For platform "vm": the machine image on your hypervisor it is cloned
    /// from, and what to call it in a sentence.
    var template: String? = nil
    var imageLabel: String? = nil
}

/// The machines the New session sheet can ask for, by the operating system a
/// runner repository has a workflow for. The same four words and order as the
/// temporary-machine control in settings, and on Android.
struct NewMachineChoice: Hashable {
    let platform: String
    let label: String
}

let newMachineChoices: [NewMachineChoice] = [
    NewMachineChoice(platform: "linux", label: "New Linux machine"),
    NewMachineChoice(platform: "macos", label: "New macOS machine"),
    NewMachineChoice(platform: "windows", label: "New Windows machine"),
    NewMachineChoice(platform: "android", label: "New Android emulator"),
]

/// The picker's tag for a new machine. A prefix no host id can carry, since a
/// host id never contains a colon.
private let newMachineTag = "new:"
/// And for a new machine from one of your machine images, by its id.
private let vmImageTag = "vm:"

struct StartSheet: View {
    let settings: Settings
    let onStart: (StartRequest) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var brief = ""
    @State private var task = ""
    @State private var title = ""
    @State private var kind: SessionKind?
    @State private var host = ""
    @State private var hosts: [String] = []
    @State private var profiles: [Fleet.Profile] = []
    /// Distinct from `profiles.isEmpty`. A fleet with no profiles has ANSWERED;
    /// a fleet whose hosts are too old to know the verb has not, and the two
    /// deserve different screens — null is cannot-tell, empty is nothing.
    @State private var profilesAnswered = false
    @State private var profile = ""
    @State private var secrets: [Fleet.Secret] = []
    /// The same cannot-tell/nothing distinction as `profilesAnswered`: a fleet
    /// that holds no secrets has answered, a fleet too old to know the verb has
    /// not, and only the first should show a picker.
    @State private var secretsAnswered = false
    @State private var secret = ""
    @State private var suggesting = false
    @State private var error = ""
    /// Whether this fleet can start a machine for this person at all, from the
    /// snapshot. The new-machine choices are drawn from this and only this, so
    /// a fleet with no runner repository offers none (C-2).
    @State private var canStartMachine = false
    /// Whether this person has a Claude login kept for runners. A new machine
    /// started without one, and with no API key in the runner repository,
    /// refuses the session it was started for, so New session says so here.
    @State private var claude: ClaudeKept?
    @State private var machineMinutes = 60
    /// The machine images on your own pools a new machine can come from, from
    /// the snapshot. Drawn from this and only this (C-2).
    @State private var images: [Fleet.VMImage] = []

    /// The operating system when a new machine is chosen, else nil: "vm" for
    /// one from your hypervisor.
    private var chosenPlatform: String? {
        if host.hasPrefix(vmImageTag) { return "vm" }
        return host.hasPrefix(newMachineTag) ? String(host.dropFirst(newMachineTag.count)) : nil
    }

    /// The machine image chosen, when it is one from your hypervisor.
    private var chosenImage: Fleet.VMImage? {
        guard host.hasPrefix(vmImageTag) else { return nil }
        let id = String(host.dropFirst(vmImageTag.count))
        return images.first { $0.template == id }
    }

    private var kinds: [SessionKind] { SessionKinds.all() }

    private var taskIsEmpty: Bool { task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What is this about?", text: $brief, axis: .vertical)
                        .lineLimit(2...5)
                        .onChange(of: brief) { _, _ in scheduleSuggestion() }
                } header: {
                    Text("About").fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
                } footer: {
                    // Said plainly, because "we will generate a name" reads as
                    // "we will send this somewhere" unless it does not.
                    Text(Naming.canSuggest
                         ? "A title is suggested on this device. Nothing here is sent anywhere to name it."
                         : "Optional. Helps you recognise this session later.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }

                Section {
                    HStack {
                        TextField("Optional", text: $title)
                            // A title the person has touched is theirs. Compared
                            // against the last suggestion rather than using a
                            // plain "did it change" flag, because setting the
                            // field programmatically also changes it — and that
                            // would mark their own suggestion as edited and stop
                            // every later one.
                            .onChange(of: title) { _, now in
                                if now != lastSuggested { titleIsUntouched = false }
                            }
                        if suggesting { ProgressView().controlSize(.small) }
                    }
                    // Only offered when there is something to work from and a
                    // model to do it. A button that explains why it is disabled
                    // is better than one that is simply absent, but a button
                    // that cannot work at all is worse than either.
                    if Naming.canSuggest, !suggestionSource.isEmpty {
                        // Explicitly asking overrides the "they edited it"
                        // guard: they know they edited it, they are asking anyway.
                        Button("Suggest again") { Task { titleIsUntouched = true; await suggest() } }
                            .disabled(suggesting)
                    }
                } header: {
                    Text("Title").fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
                }

                // WHAT IT WILL DO, and it is above Kind and Where because it
                // is the question that decides whether starting is worth doing
                // at all. A session with nothing to do comes up idle: correct,
                // sometimes wanted, and never what somebody expects from a
                // button labelled Start.
                //
                // THE WORDS FIRST, always offered: since protocol v7 a session
                // can be handed its job in words, and a new machine can be
                // handed it in no other way. A profile a host has written
                // down is the alternative, offered only once the fleet has
                // ANSWERED that it has some — an empty picker while the
                // request is in flight offers "Nothing yet" as the fleet's
                // answer.
                Section {
                    TextField("What should it do?", text: $task, axis: .vertical)
                        .lineLimit(3...8)
                        // Two first messages is one too many, and the host
                        // refuses the pair, so writing one clears the other.
                        .onChange(of: task) { _, now in
                            if !now.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { profile = "" }
                            scheduleSuggestion()
                        }
                    if profilesAnswered, !profiles.isEmpty, chosenPlatform == nil, taskIsEmpty {
                        Picker("Or one written on a host", selection: $profile) {
                            Text("None").tag("")
                            ForEach(profiles) { p in
                                // The summary, not the name, because the name is
                                // a filename and the summary is the sentence
                                // somebody wrote to be recognised by.
                                Text(p.summary.isEmpty ? p.name : p.summary).tag(p.name)
                            }
                        }
                        // Where it can run is decided by where the file IS. A
                        // profile picked on a fleet where only one box has it
                        // pins the host, because `start` elsewhere is refused —
                        // and a refusal a person cannot act on is worse than a
                        // picker that moved on its own and says so.
                        .onChange(of: profile) { _, now in
                            let owners = Set(profiles.filter { $0.name == now }.compactMap(\.hostId))
                            if owners.count == 1, let only = owners.first { host = only }
                        }
                    }
                } header: {
                    Text("Task").fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
                } footer: {
                    Text(!taskIsEmpty
                         ? "It starts with these words and gets to work. Say what to do, where, and what to report back: nothing can be added once it is going."
                         : profile.isEmpty
                            ? "Leave it empty and it starts idle, waiting for you."
                            : "It starts with this as its first message. The words are kept on the host.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }

                // WHAT IT MAY REACH, and optional. Shown only once the fleet has
                // answered and only when a box actually holds a secret — an empty
                // picker would offer a control for a capability nobody set up.
                // Names only: the value stays on the host, and this app never
                // sees it.
                if secretsAnswered, !secrets.isEmpty, chosenPlatform == nil {
                    Section {
                        Picker("Secret", selection: $secret) {
                            Text("None").tag("")
                            ForEach(secrets) { s in
                                Text(s.name).tag(s.name)
                            }
                        }
                        // Pins the host the same way a profile does: a secret
                        // lives on one box, and `start --secret` elsewhere is
                        // refused, so a single-owner name fixes where it runs.
                        .onChange(of: secret) { _, now in
                            let owners = Set(secrets.filter { $0.name == now }.compactMap(\.hostId))
                            if owners.count == 1, let only = owners.first { host = only }
                        }
                    } header: {
                        Text("Secret").fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
                    } footer: {
                        Text(secret.isEmpty
                             ? "Optional. Grant a named secret and the session can fetch its value at runtime."
                             : "It may fetch this secret's value while it runs. The value stays on the host — this app never sees it.")
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                    }
                }

                if !kinds.isEmpty {
                    Section {
                        Picker("Kind", selection: $kind) {
                            Text("None").tag(SessionKind?.none)
                            ForEach(kinds) { k in Text(k.displayName).tag(SessionKind?.some(k)) }
                        }
                        // A kind that names a host fills the picker below, and
                        // the picker stays editable: the kind is a default, not
                        // a decision made last month that cannot be revisited.
                        .onChange(of: kind) { _, now in
                            if let kindHost = now?.host, !kindHost.isEmpty { host = kindHost }
                            // And a kind that names a task fills that too, on
                            // the same terms — but only if the fleet still has
                            // it. A kind naming a profile somebody deleted would
                            // otherwise pre-fill a start that is refused.
                            if taskIsEmpty, let kindProfile = now?.profile, profiles.contains(where: { $0.name == kindProfile }) {
                                profile = kindProfile
                            }
                        }
                    } header: {
                        Text("Kind").fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
                    }
                }

                // Only shown when there is a choice to make. One host is not a
                // decision, and a picker with one entry is furniture. A fleet
                // that can start a machine always has a choice: here, or a new
                // one.
                if hosts.count > 1 || canStartMachine || !images.isEmpty {
                    Section {
                        Picker("Host", selection: $host) {
                            Text("Wherever fits").tag("")
                            ForEach(hosts, id: \.self) { h in Text(h).tag(h) }
                            // FROM YOUR OWN HYPERVISOR, first among the new
                            // machines: up in a minute or two, and billed to
                            // nobody. Asked for: "Still can't run sessions on it".
                            ForEach(images) { image in
                                Text(image.label).tag(vmImageTag + image.template)
                            }
                            if canStartMachine {
                                ForEach(newMachineChoices, id: \.platform) { choice in
                                    Text(choice.label).tag(newMachineTag + choice.platform)
                                }
                            }
                        }
                        // A machine that does not exist yet has nothing to do
                        // a profile or a secret with, so choosing one clears
                        // both rather than leaving a start that is refused.
                        .onChange(of: host) { _, now in
                            if now.hasPrefix(newMachineTag) || now.hasPrefix(vmImageTag) { profile = ""; secret = "" }
                        }
                        if chosenPlatform != nil {
                            // Five-minute steps between the protocol's bounds.
                            // The one minutes control in the app, now that the
                            // standalone request under settings is gone.
                            Stepper("For \(machineMinutes) minutes", value: $machineMinutes, in: 5...350, step: 5)
                        }
                    } header: {
                        Text("Where").fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
                    } footer: {
                        if chosenPlatform == "vm" {
                            Text("It is cloned from your machine image and joins in a minute or two. The session starts on it then"
                                 + (taskIsEmpty
                                    ? ", idle, with nothing to do. Give it a task above to put it to work."
                                    : " and works on your task. You get a notification when it is back at its prompt.")
                                 + " It powers off when the time runs out and is removed, with everything on it.")
                                .fleetType(.label)
                                .foregroundStyle(Design.Palette.inkDim)
                        } else if chosenPlatform != nil {
                            // NO LINK PROMISED. A runner's credential cannot open
                            // Remote Control, so the notification that matters is
                            // the one when its task is done.
                            Text("It takes a few minutes to boot. The session starts on it when it joins"
                                 + (taskIsEmpty
                                    ? ", idle, with nothing to do. Give it a task above to put it to work."
                                    : " and works on your task. You get a notification when it is back at its prompt.")
                                 + " Everything on it is gone when the time runs out.")
                                .fleetType(.label)
                                .foregroundStyle(Design.Palette.inkDim)
                            // SAID OUT LOUD, as docs/runner-central.md says it:
                            // the Windows runner is written and not yet proven,
                            // and offering it without that is a claim.
                            if chosenPlatform == "windows" {
                                Text("Windows runners are written and not yet proven.")
                                    .fleetType(.label)
                                    .foregroundStyle(Design.Palette.attention)
                            }
                        }
                    }
                }

                // ASKED WHERE IT MATTERS. A runner fetches its owner's Claude
                // login when it joins; with none kept it falls back to the
                // runner repository's API key, and with neither it refuses the
                // session. Nothing said so until after the machine had booted.
                if chosenPlatform != nil, claude == .missing || claude == .needsGitHub {
                    Section {
                        Text(chosenPlatform == "vm"
                             ? "No Claude login is kept in your vault, so a machine from your hypervisor has nothing to run "
                               + "its session on. Keep one here first."
                             : "No Claude login is kept for your runners, so this one runs on the runner repository's "
                               + "API key if it has one, and cannot start the session if it does not.")
                            .fleetType(.bodySmall)
                            .foregroundStyle(Design.Palette.attention)
                        ClaudeSetup(settings: settings) { claude = .kept }
                    } header: {
                        Text("Claude").fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
                    }
                }

                if !error.isEmpty {
                    Section {
                        Text(error).foregroundStyle(Design.Palette.bad).fleetType(.bodySmall)
                    }
                }
            }
            // The form's own ground rather than the system's grouped grey, and
            // its rows on the card colour: the sheet is part of the same app as
            // the list behind it, which is not what two different greys say.
            .scrollContentBackground(.hidden)
            .background(Design.Palette.bg)
            .listRowBackground(Design.Palette.card)
            .task {
                // The enrolled list, which the settings screen already uses.
                // Loaded here rather than passed in so the sheet works from
                // every place that presents it, App Intents included.
                let fleet = Fleet(settings: settings)
                hosts = (try? await fleet.enrolledHosts().map(\.hostId)) ?? []
                // A THROW IS NOT AN EMPTY FLEET. Hosts too old to know the verb
                // refuse it by name, and so does a coordinator that has not been
                // updated — treating either as "no profiles" would quietly hide
                // a picker that should exist. Unanswered means no section at all.
                if let found = try? await fleet.profiles() {
                    profiles = found
                    profilesAnswered = true
                }
                // Same rule as profiles: a throw is "cannot tell", not "none",
                // so an old fleet shows no secret picker rather than a wrong one.
                if let found = try? await fleet.secrets() {
                    secrets = found
                    secretsAnswered = true
                }
                // Whether a new machine can be offered: the snapshot names a
                // runner repository for this person. A failure offers none,
                // which is the safe way round for a control that spends money.
                canStartMachine = (try? await fleet.runners()) != nil
                images = (try? await fleet.vmImages()) ?? []
                if canStartMachine || !images.isEmpty { claude = await claudeKept(settings) }
            }
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    // Never disabled on account of an empty title or brief.
                    // Both are optional and the whole point is that this is
                    // answerable without them.
                    //
                    // No busy state, because there is nothing to be busy for:
                    // this closes on tap and the work happens behind it.
                    Button("Start") { start() }
                    // THE ONE PRIMARY ACTION IN THE APP, and the only place a
                    // prominent glass button earns its weight. Used sparingly
                    // on purpose: a screen where everything is prominent has
                    // nothing that is.
                    .buttonStyle(.glassProminent)
                        .disabled(!settings.configured)
                }
            }
        }
    }

    /// Suggest once the typing stops, not on every keystroke.
    ///
    /// A suggestion that changes under the cursor while somebody is still
    /// writing is worse than none: they stop to read it, lose the sentence, and
    /// the feature has cost them the thing it was meant to save.
    @State private var suggestTask: Task<Void, Never>?
    private func scheduleSuggestion() {
        guard Naming.canSuggest, titleIsUntouched else { return }
        suggestTask?.cancel()
        suggestTask = Task {
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            await suggest()
        }
    }

    /// A title the person has edited is never overwritten. Tracked rather than
    /// compared, because "equal to the last suggestion" is false the moment
    /// they change one character back.
    @State private var titleIsUntouched = true
    @State private var lastSuggested = ""

    /// What a title is suggested from: the brief when there is one, else the
    /// task, which says what the session is about just as well.
    private var suggestionSource: String { brief.trimmingCharacters(in: .whitespaces).isEmpty ? task : brief }

    private func suggest() async {
        let source = suggestionSource
        guard !source.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        suggesting = true
        let suggested = await Naming.suggest(for: source)
        suggesting = false
        // The text may have moved on while the model was thinking. Applying a
        // title for text that is no longer there is worse than applying none.
        guard source == suggestionSource, titleIsUntouched else { return }
        lastSuggested = suggested
        title = suggested
    }


    /// Hand it up and close. Nobody waits.
    ///
    /// This used to await the whole start — a container, a fresh volume,
    /// credentials and the Remote Control check, up to a minute — with the
    /// sheet open the entire time. Two attempts at fixing that were wrong in
    /// the same direction: a greyed-out button that read as a hang, then a
    /// spinner that explained the wait. EXPLAINING A WAIT IS STILL A WAIT.
    ///
    /// Nobody needs to be present for it, so the request goes up to the view
    /// that outlives this sheet, and the answer comes back as a notification.
    private func start() {
        var finalTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if let prefix = kind?.titlePrefix, !prefix.isEmpty, !finalTitle.isEmpty {
            finalTitle = "\(prefix): \(finalTitle)"
        }
        let trimmedBrief = brief.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedTask = task.trimmingCharacters(in: .whitespacesAndNewlines)
        let platform = chosenPlatform
        onStart(StartRequest(
            title: finalTitle.isEmpty ? nil : finalTitle,
            brief: trimmedBrief.isEmpty ? nil : trimmedBrief,
            mode: kind?.mode,
            host: host.isEmpty || platform != nil ? nil : host,
            profile: profile.isEmpty || platform != nil || !trimmedTask.isEmpty ? nil : profile,
            task: trimmedTask.isEmpty ? nil : trimmedTask,
            secret: secret.isEmpty || platform != nil ? nil : secret,
            platform: platform,
            minutes: platform == nil ? nil : machineMinutes,
            template: chosenImage?.template,
            imageLabel: chosenImage?.label
        ))
        dismiss()
    }
}
