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
struct StartSheet: View {
    let settings: Settings
    let onStarted: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var brief = ""
    @State private var title = ""
    @State private var kind: SessionKind?
    @State private var host = ""
    @State private var hosts: [String] = []
    @State private var busy = false
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

                // WHAT IS HAPPENING, while it happens. A spinner says "wait";
                // this says what for, which is the difference between waiting
                // and wondering whether it is broken.
                if busy {
                    Section {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text(waited > 12
                                 ? "Still starting — the box is bringing up the sandbox and waiting for Remote Control. This can take a minute."
                                 : "Starting…")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
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
                hosts = (try? await Fleet(settings: settings).enrolledHosts().map(\.hostId)) ?? []
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
                    // WHEN BUSY, A SPINNER — not a greyed-out button. Starting
                    // a session takes the host up to a minute: it brings up a
                    // container, seeds credentials into a fresh volume, and
                    // waits out the Remote Control check. Disabling the button
                    // and changing nothing else is indistinguishable from a
                    // hang, and was reported as one.
                    if busy {
                        ProgressView()
                    } else {
                        Button("Start") { Task { await start() } }
                            .disabled(!settings.configured)
                    }
                }
            }
        }
    }

    /// A URLSession timeout, as opposed to a refusal from the fleet.
    ///
    /// The distinction matters because the remedies are opposite: a refusal is
    /// final and worth reading, a timeout means the answer is still in flight
    /// and the list is the place to look.
    private func isTimeout(_ error: Error) -> Bool {
        (error as NSError).code == NSURLErrorTimedOut || "\(error)".localizedCaseInsensitiveContains("time")
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

    /// Seconds spent waiting, so the message can grow more informative rather
    /// than the screen growing more silent.
    @State private var waited = 0
    @State private var tick: Task<Void, Never>?

    private func start() async {
        busy = true
        waited = 0
        tick = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                await MainActor.run { waited += 1 }
            }
        }
        defer { tick?.cancel() }
        error = ""
        var finalTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if let prefix = kind?.titlePrefix, !prefix.isEmpty, !finalTitle.isEmpty {
            finalTitle = "\(prefix): \(finalTitle)"
        }
        do {
            let reply = try await Fleet(settings: settings).start(
                name: nil,
                title: finalTitle.isEmpty ? nil : finalTitle,
                brief: brief.trimmingCharacters(in: .whitespacesAndNewlines),
                mode: kind?.mode,
                host: host.isEmpty ? nil : host
            )
            onStarted(reply.text ?? "Started a session")
            dismiss()
        } catch {
            // Shown here rather than dismissed into the list: the sheet holds
            // the only copy of what they typed, and closing it to show an error
            // elsewhere throws that away.
            //
            // AND A TIMEOUT IS NOT A FAILURE. `start` is mutating and carries
            // an idempotency key, so a request that gave up may well have
            // started a session anyway — saying "failed" would send somebody
            // to start a second one. The honest answer names both
            // possibilities and points at the list.
            self.error = isTimeout(error)
                ? "Still starting, or started — the answer did not come back in time. Close this and pull to refresh; "
                  + "if it is there, it worked. Starting again is safe: the same request is not run twice."
                : error.localizedDescription
        }
        busy = false
    }
}
