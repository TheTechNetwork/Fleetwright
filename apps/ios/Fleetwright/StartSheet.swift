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
                    }
                }

                if !error.isEmpty {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
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
                    Button("Start") { Task { await start() } }
                        .disabled(busy || !settings.configured)
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

    private func start() async {
        busy = true
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
                mode: kind?.mode
            )
            onStarted(reply.text ?? "Started a session")
            dismiss()
        } catch {
            // Shown here rather than dismissed into the list: the sheet holds
            // the only copy of what they typed, and closing it to show an error
            // elsewhere throws that away.
            self.error = error.localizedDescription
        }
        busy = false
    }
}
