import SwiftUI

/// One session, everything about it, on a page of its own.
///
/// WHY THIS EXISTS. The session row on the fleet screen carries the question
/// and its answers, the actions, and a line of context — and stops there. It
/// could not show the one thing a person opening this app most often wants to
/// see, which is THE PANE: what the session has on its screen right now. iOS
/// had a `peek` verb on the client for months and no screen that called it,
/// while Android had a button that dropped a frozen copy into the status box.
/// docs/plan.md calls this "the one state the product exists for", and this is
/// the screen it asks for.
///
/// THREE THINGS, IN THIS ORDER. The state sentence, in the title size, so the
/// answer to "what is it doing" is the first thing on the page. Then whatever
/// needs a person: the question and its answers when there is one, and
/// Remote Control, front and centre, when there is not — because until there
/// is a published prompt it is the only way to reply to anything, and after
/// there is one it is still the only way to reply to anything the option list
/// cannot express. Then the pane.
///
/// THE PANE IS WATCHED, AND THEN IT STOPS BEING WATCHED. `peek` is pinned: every
/// tick is a routed round trip down one host's single outbound socket and a
/// `tmux capture-pane` fork on the box running the session. So it polls every
/// three seconds for the first half minute — while somebody is deciding — then
/// every ten, and then it STOPS, with a button to look again. A page left open
/// on a desk must not poll a production host forever.
///
/// IT OWNS ITS OWN STATE, like HostView and for the same reason: there is one
/// session here, so one busy flag and one answer, and none of it can be about
/// a different session.
struct SessionView: View {
    let fleet: Fleet
    /// What the list knew when this page opened. It seeds the state below and
    /// is not read again: a page that starts blank to ask a question it was
    /// handed the answer to is the fault HostView's header describes.
    let initial: Fleet.Session
    /// Called when this page changes something the list should know about.
    var onChange: () async -> Void = {}

    @State private var session: Fleet.Session
    /// The pane, as the host last drew it. Nil until the first peek answers;
    /// after that always a string, and a blank one is said in words.
    @State private var pane: String?
    /// When the pane above was read, so "as of 14:02:31" can be true.
    @State private var paneAt: Date?
    /// The watch has run its course. What is on screen is still what the
    /// host said; it is simply no longer being asked.
    @State private var watchEnded = false
    /// Bumped by the look-again button. `.task(id:)` restarts the watch when
    /// it changes and cancels the old one, which is the whole of the
    /// mechanism — no timer to invalidate, no task to keep hold of.
    @State private var watchGeneration = 0
    @State private var busy = false
    @State private var result = ""
    @State private var confirmingForget = false

    /// The schedule, in one place. Ten looks three seconds apart, then nine
    /// ten seconds apart: two minutes of watching, and then a button.
    static let quickLooks = 10
    static let quickInterval: Duration = .seconds(3)
    static let slowLooks = 9
    static let slowInterval: Duration = .seconds(10)

    init(fleet: Fleet, initial: Fleet.Session, onChange: @escaping () async -> Void = {}) {
        self.fleet = fleet
        self.initial = initial
        self.onChange = onChange
        _session = State(initialValue: initial)
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: Design.Space.hair) {
                    Text(session.stateSentence)
                        .fleetType(.title)
                        .foregroundStyle(session.prompt != nil ? Design.Palette.attention : Design.Palette.ink)
                    if session.label != session.name {
                        Text(session.name).fleetType(.microMono).foregroundStyle(Design.Palette.inkDim)
                    }
                    HStack(spacing: Design.Space.hair) {
                        if let host = session.hostId { Text("on \(host)") }
                        if let workspace = session.workspace { Text("· \(workspace)") }
                        if let age = session.age { Text("· \(age)") }
                        if let account = session.account, account != "shared" { Text("· \(account)") }
                    }
                    .fleetType(.micro)
                    .foregroundStyle(Design.Palette.inkDim)
                }
                .padding(.vertical, Design.Space.hair)
            }
            .listRowBackground(Design.Palette.card)

            if let prompt = session.prompt, let options = prompt.options, !options.isEmpty {
                Section {
                    if let question = prompt.question, !question.isEmpty {
                        Text(question)
                            .fleetType(.bodyStrong)
                            .foregroundStyle(Design.Palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    ForEach(options) { option in
                        Button {
                            act { try await fleet.answer(session.name, option: option.index, promptId: prompt.id) }
                        } label: {
                            HStack(spacing: Design.Space.insideTight) {
                                // The ordinal, because an ordinal is what is
                                // sent — the label never leaves the box.
                                Text("\(option.index)")
                                    .fleetType(.labelMono)
                                    .foregroundStyle(Design.Palette.inkDim)
                                Text(option.label)
                                    .fleetType(.bodySmall)
                                    .foregroundStyle(Design.Palette.ink)
                                    .multilineTextAlignment(.leading)
                                Spacer(minLength: 0)
                            }
                            .frame(minHeight: 44)
                        }
                        .disabled(busy)
                    }
                } header: {
                    sectionHead("It is asking")
                }
                .listRowBackground(Design.Palette.card)
            } else if session.prompt != nil {
                Section {
                    Text("Waiting for an answer. The options are not shown because this fleet does not send prompt text off the box.")
                        .fleetType(.bodySmall)
                        .foregroundStyle(Design.Palette.inkDim)
                } header: {
                    sectionHead("It is asking")
                }
                .listRowBackground(Design.Palette.card)
            } else if session.isRunning, let url = session.rcUrl, let link = URL(string: url) {
                // FRONT AND CENTRE WHEN THERE IS NO PROMPT. Demoting this to a
                // footer would be wrong: it is the only way to say anything to
                // a session the option list cannot express, which is every
                // session that is not currently asking a yes-or-no question.
                Section {
                    Link(destination: link) {
                        Label("Continue in Remote Control", systemImage: "arrow.up.forward.app")
                            .frame(minHeight: 44)
                    }
                } footer: {
                    Text("Your shell on this session, in the browser. Anything typed there goes to the session as if you were at the box.")
                }
                .listRowBackground(Design.Palette.card)
            }

            Section {
                if let pane {
                    if pane.isBlank {
                        Text("Nothing is on \(session.label)'s screen right now.")
                            .fleetType(.bodySmall)
                            .foregroundStyle(Design.Palette.inkDim)
                    } else {
                        // MONOSPACED, UNWRAPPED, SCROLLED SIDEWAYS. A pane is
                        // drawn for a terminal of 70 to 100 columns and its
                        // box-drawing borders must never reflow: a wrapped
                        // pane is not a smaller picture of the same thing, it
                        // is a different picture.
                        ScrollView(.horizontal, showsIndicators: true) {
                            Text(pane)
                                .fleetType(.labelMono)
                                .foregroundStyle(Design.Palette.ink)
                                .fixedSize(horizontal: true, vertical: false)
                                .textSelection(.enabled)
                        }
                    }
                } else if session.isRunning {
                    Text("Reading the screen…")
                        .fleetType(.bodySmall)
                        .foregroundStyle(Design.Palette.inkDim)
                } else {
                    Text("Not running, so there is no screen to read. Output has what it printed; Resume brings the conversation back.")
                        .fleetType(.bodySmall)
                        .foregroundStyle(Design.Palette.inkDim)
                }
            } header: {
                sectionHead("On its screen")
            } footer: {
                if let paneAt {
                    HStack {
                        Text(watchEnded
                             ? "As of \(paneAt.formatted(date: .omitted, time: .standard)). No longer watching."
                             : "As of \(paneAt.formatted(date: .omitted, time: .standard)). Watching.")
                        Spacer()
                        if watchEnded {
                            Button("Look again") { watchGeneration += 1 }
                        }
                    }
                }
            }
            .listRowBackground(Design.Palette.card)

            Section {
                if session.isRunning {
                    Button("Stop") { act { try await fleet.stop(session.name) } }.disabled(busy)
                } else if session.isResumable {
                    Button("Resume") { act { try await fleet.resume(session.name, choice: "summary") } }.disabled(busy)
                }
                NavigationLink("Files") {
                    FilesView(session: session.name, host: session.hostId, fleet: fleet)
                }
                .disabled(busy)
                // What it SAID, as against what it looks like: the container's
                // output outlives the pane, and "why did it stop" is a question
                // asked after it has.
                Button("Output") {
                    act(nothingSaid: "\(session.label) has printed nothing that this machine could read.") {
                        try await fleet.logs(host: session.hostId, session: session.name)
                    }
                }
                .disabled(busy)
                if !session.isRunning {
                    Button("Forget", role: .destructive) { confirmingForget = true }.disabled(busy)
                }
            } header: {
                sectionHead("Actions")
            }
            .listRowBackground(Design.Palette.card)
            .confirmationDialog("Forget \(session.label)?", isPresented: $confirmingForget, titleVisibility: .visible) {
                Button("Forget — delete its conversation and workspace", role: .destructive) {
                    act { try await fleet.forget(session.name) }
                }
            } message: {
                Text("This cannot be undone. Stop keeps everything and can be resumed; forget keeps nothing.")
            }

            if !result.isBlank {
                Section {
                    Text(result)
                        .fleetType(.labelMono)
                        .foregroundStyle(Design.Palette.ink)
                        .textSelection(.enabled)
                } header: {
                    sectionHead("Reply")
                }
                .listRowBackground(Design.Palette.inner)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .navigationTitle(session.label)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .task(id: watchGeneration) { await watch() }
    }

    private func sectionHead(_ text: String) -> some View {
        Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
    }

    /// The schedule, run to its end or until the page goes away. `.task`
    /// cancels this when the view disappears, and `Task.sleep` throws on
    /// cancellation, so leaving the page is enough to stop asking the host.
    private func watch() async {
        watchEnded = false
        guard session.isRunning else { return }
        for _ in 0..<Self.quickLooks {
            await peek()
            guard (try? await Task.sleep(for: Self.quickInterval)) != nil else { return }
        }
        for _ in 0..<Self.slowLooks {
            await peek()
            guard (try? await Task.sleep(for: Self.slowInterval)) != nil else { return }
        }
        watchEnded = true
    }

    /// One look at the pane. A failure keeps the last picture and says so in
    /// the reply box rather than blanking a screen somebody is reading.
    private func peek() async {
        do {
            let reply = try await fleet.peek(session.name)
            pane = reply.text ?? ""
            paneAt = Date()
        } catch {
            result = error.localizedDescription
        }
    }

    /// The session as the fleet sees it now, so a Stop or an answer moves the
    /// sentence at the top of the page and not only the list behind it.
    private func reload() async {
        if let now = try? await fleet.status(session.name).sessions?.first(where: { $0.name == session.name }) {
            session = now
        }
    }

    /// One action, one place the busy flag and the answer are set. A verb
    /// whose whole answer is text says something when there is none.
    private func act(nothingSaid: String? = nil, _ work: @escaping () async throws -> Fleet.Reply) {
        Task {
            busy = true
            defer { busy = false }
            do {
                let reply = try await work()
                let said = (reply.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                result = said.isEmpty ? (nothingSaid ?? "") : said
            } catch {
                result = error.localizedDescription
            }
            await reload()
            await onChange()
        }
    }
}
