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
}

struct StartSheet: View {
    let settings: Settings
    let onStart: (StartRequest) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var brief = ""
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
    @State private var suggesting = false
    @State private var error = ""

    private var kinds: [SessionKind] { SessionKinds.all() }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What is this about?", text: $brief, axis: .vertical)
                        .lineLimit(2...5)
                        .onChange(of: brief) { _, _ in scheduleSuggestion() }
                } header: {
                    Text("About")
                } footer: {
                    // Said plainly, because "we will generate a name" reads as
                    // "we will send this somewhere" unless it does not.
                    Text(Naming.canSuggest
                         ? "A title is suggested on this device. Nothing here is sent anywhere to name it."
                         : "Optional. Helps you recognise this session later.")
                }

                Section("Title") {
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
                    if Naming.canSuggest, !brief.isEmpty {
                        // Explicitly asking overrides the "they edited it"
                        // guard: they know they edited it, they are asking anyway.
                        Button("Suggest again") { Task { titleIsUntouched = true; await suggest() } }
                            .disabled(suggesting)
                    }
                }

                // WHAT IT WILL DO, and it is above Kind and Where because it
                // is the question that decides whether starting is worth doing
                // at all. A session with no profile comes up idle: correct,
                // sometimes wanted, and never what somebody expects from a
                // button labelled Start.
                //
                // Only shown once the fleet has ANSWERED. Rendering an empty
                // picker while the request is in flight offers "Nothing yet" as
                // if it were the fleet's answer, and somebody taps Start.
                if profilesAnswered, !profiles.isEmpty {
                    Section {
                        Picker("Task", selection: $profile) {
                            Text("Nothing — I will drive it").tag("")
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
                    } header: {
                        Text("Task")
                    } footer: {
                        Text(profile.isEmpty
                             ? "It will start idle, waiting for you. Nothing is asked of it until you open it."
                             : "It starts with this as its first message. The task lives on the host — this app never sends the words.")
                    }
                }

                if !kinds.isEmpty {
                    Section("Kind") {
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
                            if let kindProfile = now?.profile, profiles.contains(where: { $0.name == kindProfile }) {
                                profile = kindProfile
                            }
                        }
                    }
                }

                // Only shown when there is a choice to make. One host is not a
                // decision, and a picker with one entry is furniture.
                if hosts.count > 1 {
                    Section("Where") {
                        Picker("Host", selection: $host) {
                            Text("Wherever fits").tag("")
                            ForEach(hosts, id: \.self) { h in Text(h).tag(h) }
                        }
                    }
                }

                if !error.isEmpty {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
            }
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

    private func suggest() async {
        let source = brief
        guard !source.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        suggesting = true
        let suggested = await Naming.suggest(for: source)
        suggesting = false
        // The brief may have moved on while the model was thinking. Applying a
        // title for text that is no longer there is worse than applying none.
        guard source == brief, titleIsUntouched else { return }
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
        onStart(StartRequest(
            title: finalTitle.isEmpty ? nil : finalTitle,
            brief: trimmedBrief.isEmpty ? nil : trimmedBrief,
            mode: kind?.mode,
            host: host.isEmpty ? nil : host,
            profile: profile.isEmpty ? nil : profile
        ))
        dismiss()
    }
}
