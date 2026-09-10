import AppIntents
import AuthenticationServices
import SwiftUI
import UIKit

/// The whole app: what is running, and the three things you would want to do
/// about it from a phone.
///
/// Every action is an intent to the coordinator. The app never talks to a host
/// directly, so it never has to know which box holds which session — that is
/// exactly what the coordinator is for.
/// The app, as three places rather than one screen with a sheet on top.
///
/// It was a session list with everything else behind a Settings button: hosts,
/// pins, fleet health, credentials, people, shortcuts, devices and the server
/// URL, in one scroll five hundred lines long. That is fine while the only
/// person using it built it, and it is the first thing that stops being fine
/// for anybody else — "where do I connect Claude" has no answer that is a
/// place, only a path.
///
/// Three, because there are three questions somebody actually arrives with:
/// what is running, are my machines all right, and how is this set up.
///
/// The tab bar is iOS 26's, which means it floats over the content, adopts the
/// glass material, and MINIMISES ON SCROLL — the list is what somebody came
/// for, so the navigation gets out of the way as soon as they start reading.
struct FleetApp: View {
    let settings: Settings

    /// Which tab is showing. Held here so an unconfigured app can open on
    /// Settings — which used to be a sheet thrown over the session list on
    /// first launch, and is now simply the tab somebody needs to be on. A
    /// modal telling you to go somewhere, in an app that has a place to go, is
    /// the sheet-shaped habit this whole change is undoing.
    @State private var tab: Tabs = .sessions
    private enum Tabs: Hashable { case sessions, fleet, settings }

    /// The tab a screenshot run asked for, if this launch is one.
    ///
    /// Applied in `onAppear` beside the unconfigured-app rule below, so the two
    /// things that can choose a tab are in one place and their order is
    /// visible — a screenshot run has already been pointed at the demo, so it
    /// is configured, and the two never both fire.
    private var screenshotTab: Tabs? {
        switch Screenshots.tab {
        case "sessions": return .sessions
        case "fleet": return .fleet
        case "settings": return .settings
        default: return nil
        }
    }

    var body: some View {
        TabView(selection: $tab) {
            Tab("Sessions", systemImage: "square.stack.3d.up", value: Tabs.sessions) {
                FleetView(settings: settings)
            }
            Tab("Fleet", systemImage: "server.rack", value: Tabs.fleet) {
                NavigationStack { SettingsView(settings: settings, focus: .machines) }
            }
            Tab("Settings", systemImage: "gearshape", value: Tabs.settings) {
                NavigationStack { SettingsView(settings: settings, focus: .you) }
            }
        }
        // A tapped notification lands on the sessions, whatever tab was
        // showing when the phone was put down.
        .onReceive(NotificationCenter.default.publisher(for: .notificationOpened)) { _ in
            tab = .sessions
        }
        // The content is the point; the chrome is not. On the way down the
        // tab bar shrinks to a pill and gives the list its height back.
        .tabBarMinimizeBehavior(.onScrollDown)
        // THE ACCENT, ONCE, AT THE ROOT. Every button, link and selected tab in
        // the app inherits it, which is the difference between an app with a
        // colour and an app wearing whichever blue the system happened to
        // supply. #3866D6 in light, lifted in dark so it clears the ground.
        .tint(Design.Palette.accent)
        // Nowhere to point a coordinator at yet, so start where that is fixed
        // rather than showing an empty session list and a modal about it.
        .onAppear {
            if let t = screenshotTab { tab = t }
            else if !settings.configured { tab = .settings }
        }
    }
}

struct FleetView: View {
    let settings: Settings

    @State private var sessions: [Fleet.Session] = []
    /// Hosts, for the bin — which is fleet-wide and therefore needs them all.
    @State private var fleetHosts: [Fleet.FleetHost] = []
    private var binCount: Int { fleetHosts.reduce(0) { $0 + ($1.health?.bin?.count ?? 0) } }
    /// Machines where THIS PERSON has connected Claude. Nil until asked.
    ///
    /// The count a host reports is a fleet-wide fact — how many people can
    /// start something here — and a guest joining a fleet where somebody else
    /// has connected would read as "set up" while being unable to start
    /// anything. Whose account is missing is a question about the person
    /// asking, so it is asked as them.
    @State private var myClaudeHosts: [String]?

    /// Nowhere to run anything yet.
    ///
    /// Distinguished from "nothing is running" because they are different
    /// situations with different next steps, and merging them is what let
    /// somebody new tap Start and be refused for a reason nothing had
    /// mentioned.
    ///
    /// Both halves have to be KNOWN. An empty fleet list is "we have not heard
    /// yet", and a nil answer here is "we have not asked" — neither is
    /// evidence of anything, and claiming setup is needed on the strength of a
    /// missing answer is the benign-looking lie this project keeps refusing.
    private var needsSetup: Bool {
        guard !fleetHosts.isEmpty, let mine = myClaudeHosts else { return false }
        return mine.isEmpty
    }
    @State private var status = ""
    @State private var busy = false
    @State private var showingStart = false

    var body: some View {
        NavigationStack {
            List {
                // FIRST, ALWAYS, ABOVE THE LIST. docs/psychology.md names
                // "nothing needs you" as the most important state in the
                // system and neither app said it: a list of rows is not that,
                // because reading five rows and concluding none of them is
                // asking anything is work somebody redoes every time they open
                // the app — which is the loop the anxiety runs in.
                ReassuranceBanner(summary: Reassurance(sessions: sessions, hosts: fleetHosts))
                    .fleetRow()
                if !status.isBlank {
                    // THE COORDINATOR'S OWN WORDS, on an inner surface rather
                    // than a card: this is evidence quoted from somewhere else,
                    // and it should not look like something this screen said.
                    Text(status)
                        .fleetType(.labelMono)
                        .foregroundStyle(Design.Palette.ink)
                        .textSelection(.enabled)
                        .fleetCard(radius: Design.Radius.row, padding: Design.Space.inside,
                                   fill: Design.Palette.inner)
                        .fleetRow()
                }
                // WHAT IS WAITING, because a queue nobody can see is not a
                // queue — it is a surprise arriving later. The count is enough:
                // each command says what it is when it lands, and a list of
                // them here would be a second inbox to read.
                if !outbox.held.isEmpty {
                    Label(
                        outbox.held.count == 1
                            ? "1 command is held on this phone and will be sent when the fleet answers."
                            : "\(outbox.held.count) commands are held on this phone and will be sent when the fleet answers.",
                        systemImage: "tray.full"
                    )
                    .fleetType(.bodySmall)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fleetCard(radius: Design.Radius.row, padding: Design.Space.inside,
                               fill: Design.Palette.inner)
                    .fleetRow()
                }
                Group {
                    if sessions.isEmpty && !busy {
                        // ContentUnavailableView rather than a grey sentence:
                        // it is the system's empty state, so it inherits the
                        // spacing, the type and the behaviour every other app
                        // on the phone uses for the same situation.
                        // TWO DIFFERENT EMPTY SCREENS, and they were one.
                        //
                        // Somebody new signs in, sees "Nothing is running" and
                        // a Start button, taps it, and is refused for want of a
                        // Claude account — having been told nothing about
                        // needing one. That is the whole of onboarding
                        // somebody who is not the person who built this: the
                        // first screen is confident and the second one is a
                        // refusal.
                        //
                        // A person with nowhere to run anything is not looking
                        // at an empty list, they are looking at a setup step.
                        if needsSetup {
                            ContentUnavailableView {
                                Label("Nothing set up yet", systemImage: "person.badge.key")
                            } description: {
                                Text("A session runs on YOUR Claude account, and it has to be connected on each "
                                     + "machine separately. Connect one and you can start work here.")
                            } actions: {
                                NavigationLink("Connect Claude") {
                                    CredentialsView(settings: settings, host: nil)
                                }
                            }
                        } else {
                            ContentUnavailableView {
                                Label("No sessions", systemImage: "moon.zzz")
                            } description: {
                                Text("Nothing is running on any machine in this fleet.")
                            } actions: {
                                Button("Start one") { showingStart = true }
                                    .disabled(!settings.configured)
                            }
                        }
                    }
                }
                .fleetRow()
                ForEach(sessions) { session in
                    SessionRow(session: session, busy: busy, fleet: fleet,
                               stop: { await act { try await fleet.stop(session.name) } },
                               resume: { await act { try await fleet.resume(session.name, choice: "summary") } },
                               forget: { await act { try await fleet.forget(session.name) } },
                               output: {
                                   // THE ONE VERB ON THIS SCREEN THAT EXISTS TO
                                   // RETURN TEXT, so it is the one that has to
                                   // say something when there is none.
                                   await act(nothingSaid: "\(session.label) has printed nothing that this machine could read.") {
                                       try await fleet.logs(host: session.hostId, session: session.name)
                                   }
                               },
                               answer: { option in
                                   await act {
                                       try await fleet.answer(session.name, option: option,
                                                              promptId: session.prompt?.id)
                                   }
                               })
                        .fleetRow()
                }
            }
            // A STACK OF CARDS, NOT A TABLE. `.plain` drops the grouped
            // list's inset panels and grey separators — every one of which
            // draws a box the design says should not be there — and the rows
            // put themselves on cards instead. The ground is ours rather than
            // the system's, so the cards have something to sit above.
            .listStyle(.plain)
            .listRowSpacing(Design.Space.groupTight)
            .scrollContentBackground(.hidden)
            .background(Design.Palette.bg)
            .refreshable { await refresh() }
            // The product is called Fleetwright; this said "agent-fleet",
            // which is the repository. A person who installed one app and is
            // looking at another name has to work out whether they are the
            // same thing, and the answer being yes does not make the question
            // free. Android has always said Fleetwright.
            .navigationTitle("Fleetwright")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    // THE BIN, IN THE TOOLBAR RATHER THAN OVER THE LIST. It was
                    // a glass capsule pinned to the bottom edge — which is
                    // where the tab bar now lives, so two floating controls
                    // fought for one corner and the bin sat on top of the last
                    // session in the list.
                    //
                    // The toolbar is where a secondary action belongs once
                    // there is somewhere for the primary ones to live, and it
                    // takes the place of the Settings button that a Settings
                    // TAB made redundant.
                    NavigationLink {
                        RecycleBinView(settings: settings, hosts: fleetHosts) {
                            Task { await refresh(keepStatus: true) }
                        }
                    } label: {
                        Label(binCount > 0 ? "Bin (\(binCount))" : "Bin", systemImage: "trash")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    // Opens the sheet rather than starting immediately. The
                    // one-tap start is still there — leaving the sheet blank
                    // and pressing Start is the same thing — but a session
                    // nobody described is one nobody recognises in a week.
                    Button("New") { showingStart = true }
                        .disabled(busy || !settings.configured)
                }
            }
            .sheet(isPresented: $showingStart) {
                // The sheet gathers what to start and hands it up. It does not
                // wait for the answer — see startInBackground.
                StartSheet(settings: settings, onStart: startInBackground)
            }
            .task { await refresh() }
            // The list a notification tap lands on should be the list as it is
            // now, not as it was when the phone went in a pocket.
            .onReceive(NotificationCenter.default.publisher(for: .notificationOpened)) { _ in
                Task { await refresh() }
            }
        }
    }

    /// One queue for the screen, not one per computed Fleet — the whole point
    /// is that it outlives the request that failed.
    @State private var outbox = Outbox()
    private var fleet: Fleet { Fleet(settings: settings, outbox: outbox) }

    /// Try everything held, now that the fleet has just answered.
    ///
    /// ON REFRESH, NOT ON A TIMER. A timer retries into an outage; a refresh is
    /// the moment we have just learned the fleet is reachable, and it already
    /// happens when the app opens, is pulled, or comes back to the foreground.
    /// Returns how many were sent, and does NOT refresh.
    ///
    /// The first version called refresh() at the end, and refresh() calls this
    /// — mutual recursion that happened to terminate because the second pass
    /// found an empty queue. "Happens to terminate" is not a property to ship;
    /// the caller re-lists instead.
    @discardableResult
    private func flushOutbox() async -> Int {
        await outbox.flush { entry in
            do {
                let reply = try await fleet.resend(entry)
                // A REFUSAL COUNTS AS DELIVERED. The fleet answered — "that
                // session is gone", "you cannot stop that" — and holding a
                // command it has already judged would retry it forever.
                if reply.ok == false, let text = reply.text { status = text }
                return .success(())
            } catch {
                return .failure(error)
            }
        }
    }

    /// - Parameter keepStatus: keep whatever is already on screen if the list
    ///   call succeeds. Set after an action, whose reply text is the only
    ///   confirmation the coordinator ever gives — a plain refresh would wipe
    ///   "Started cc-brave-otter." a few hundred milliseconds after it appeared.
    /// Start a session without making anybody watch it happen.
    ///
    /// THE SHEET CLOSES IMMEDIATELY. Starting takes the host up to a minute —
    /// a container, a fresh volume, credentials, and the Remote Control check
    /// — and the two previous attempts at this were wrong in the same
    /// direction: first a greyed-out button that looked like a hang, then a
    /// spinner that explained the wait. Explaining a wait is still a wait.
    ///
    /// Nobody needs to be present for it, so the answer arrives as a
    /// notification and the person gets their phone back.
    ///
    /// The task is owned HERE rather than in the sheet, because a task tied to
    /// a dismissed view is one that may not finish — and this is a mutating
    /// request that has already left.
    private func startInBackground(_ request: StartRequest) {
        // SAID DIFFERENTLY WHEN IT HAS NOTHING TO DO, because "ready" reads as
        // "working" and only one of these is. A session with no profile is
        // waiting for a person, and somebody who walks away expecting output
        // comes back to an empty prompt.
        status = request.profile == nil
            ? "Starting a session. It will come up idle, waiting for you."
            : "Starting a session. You will get a notification when it is ready."
        Task {
            do {
                let reply = try await Fleet(settings: settings).start(
                    name: nil,
                    title: request.title,
                    brief: request.brief,
                    mode: request.mode,
                    host: request.host,
                    profile: request.profile
                )
                let text = reply.text ?? "Started."
                await MainActor.run { status = text }
                LocalNotice.post(title: "Session ready", body: text)
            } catch {
                // A TIMEOUT IS NOT A FAILURE: `start` is mutating and carries
                // an idempotency key, so the session may well exist. Saying
                // "failed" would send somebody to start a second one — and the
                // second would be a second session, because a retry mints a
                // new key.
                let timedOut = (error as NSError).code == NSURLErrorTimedOut
                let text = timedOut
                    ? "Still starting, or started — the answer did not come back in time. Pull to refresh to see."
                    : error.localizedDescription
                await MainActor.run { status = text }
                LocalNotice.post(title: timedOut ? "Session may be starting" : "Could not start a session", body: text)
            }
            await refresh(keepStatus: true)
        }
    }

    private func refresh(keepStatus: Bool = false) async {
        guard settings.configured else { return }
        busy = true
        defer { busy = false }
        // THE BIN'S HOSTS DO NOT DEPEND ON THE SESSION LIST, so they are asked
        // for at the same time rather than after it. Started here and awaited
        // below, which is where the answer is used.
        async let reporting = fleet.fleetHosts()
        do {
            let reply = try await fleet.list()
            sessions = reply.sessions ?? []
            // The fleet just answered, so anything held can go now — and if
            // any of it landed, the list we just fetched is already out of
            // date. One extra list, not a second refresh: refresh calls this.
            if reply.ok != false, await flushOutbox() > 0 {
                // `as? [Fleet.Session]` did nothing — the value is already
                // that type, optional — and the compiler said so. Binding it
                // says the same thing and says it once.
                if let fresh = try? await fleet.list().sessions { sessions = fresh }
            }
            // A failure is shown, never swallowed: "nothing here" and "I could
            // not reach the coordinator" look identical otherwise, and they are
            // completely different problems.
            if reply.ok == false {
                status = reply.text ?? ""
            } else if !keepStatus {
                status = ""
            }
        } catch {
            status = error.localizedDescription
        }
        // THE BIN'S CONTENTS, which `list` does not carry: a bin entry is not
        // a session, it is a session that stopped being one. `try?` and a
        // separate statement on purpose — a fleet call that fails must not
        // blank the session list that already arrived, and an empty bin and an
        // unreachable coordinator are allowed to look the same HERE because
        // the sessions above have already said which it was.
        if let got = try? await reporting { fleetHosts = got }

        // ONLY WHEN THERE IS NOTHING TO SHOW. This is a fan-out across the
        // fleet, and asking it on every refresh would spend a round trip per
        // pull to answer a question that only matters on an empty screen — the
        // one case where nothing else is competing for the time.
        if sessions.isEmpty {
            // NOT `?? []`, AND THIS ONE DECIDES WHAT SCREEN SOMEBODY SEES.
            //
            // `myClaudeHosts` is optional precisely so that "we have not asked"
            // and "asked, and nobody" stay different — needsSetup says so in as
            // many words two hundred lines up. Coalescing a FAILED ask to the
            // empty array collapses them, and the app then tells a person whose
            // fleet is perfectly set up that nothing is set up yet, because one
            // request did not come back.
            if let reply = try? await fleet.connections() {
                myClaudeHosts = reply.connections?.linked("claude")?.hosts ?? []
            }
        }
    }

    /// Run one verb and quote what came back.
    ///
    /// `nothingSaid` is for the verbs whose whole job is to bring text back. A
    /// reply of forty blank lines used to be quoted verbatim — see
    /// `String.isBlank` — and trimming it alone would leave the opposite
    /// problem, a button that does nothing visible when it is pressed. Most
    /// verbs do not need it: their answer is the list refreshing underneath.
    private func act(nothingSaid: String? = nil, _ work: () async throws -> Fleet.Reply) async {
        busy = true
        do {
            // TRIMMED, not merely tested. A host that still pads its reply
            // would otherwise draw its card with a screenful of empty rows
            // above and below the one line worth reading.
            let said = (try await work().text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            status = said.isEmpty ? (nothingSaid ?? "") : said
        } catch {
            status = error.localizedDescription
        }
        busy = false
        await refresh(keepStatus: true)
    }
}

private struct SessionRow: View {
    let session: Fleet.Session
    let busy: Bool
    /// The client, for the one action that is a DESTINATION rather than a
    /// closure: browsing pushes a screen, and a screen needs something to call
    /// while it is open.
    let fleet: Fleet
    let stop: () async -> Void
    let resume: () async -> Void
    let forget: () async -> Void
    /// What the session SAID, as against what it looks like now: the
    /// container's output, which outlives the pane. The reason a session
    /// died is here and nowhere else once its window is gone.
    let output: () async -> Void
    let answer: (Int) async -> Void
    @State private var confirmingForget = false

    /// A session that is asking something wears the attention ring, and it is
    /// the only card on the screen that ever wears anything but the hairline.
    private var ring: Color {
        session.prompt != nil ? Design.Palette.attention.opacity(0.55) : Design.Palette.ring
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Design.Space.hair) {
            HStack(alignment: .firstTextBaseline, spacing: Design.Space.insideTight) {
                Text(session.label)
                    .fleetType(.bodyStrong)
                    .foregroundStyle(Design.Palette.ink)
                Spacer(minLength: 0)
                StatusBadge(status: session.status)
            }
            // Both are shown when they differ: the title is what a person
            // recognises, the name is what everything else keys on.
            if session.label != session.name {
                Text(session.name).fleetType(.microMono).foregroundStyle(Design.Palette.inkDim)
            }
            // Where, how long, and whose account — the three questions about a
            // session somebody started yesterday. One line, secondary, because
            // they are context rather than the point.
            HStack(spacing: Design.Space.hair) {
                if let host = session.hostId { Text("on \(host)") }
                if let workspace = session.workspace { Text("· \(workspace)") }
                if let age = session.age { Text("· \(age)") }
                if let account = session.account, account != "shared" {
                    // Only when it is NOT the shared account: on a fleet where
                    // nobody has linked one, this line would say the same
                    // thing on every row and mean nothing.
                    Text("· \(account)")
                }
            }
            .fleetType(.micro)
            .foregroundStyle(Design.Palette.inkDim)
            // HOW LONG IT HAS BEEN QUIET. "Running" was doing two jobs: a
            // session mid-build and one that has not moved since Tuesday
            // looked identical, and the difference is the whole question
            // somebody opens this app to ask. Nil under five minutes, so a
            // working session never wears it.
            if let quiet = session.quietFor {
                Label(quiet, systemImage: "pause.circle")
                    .fleetType(.micro)
                    .foregroundStyle(Design.Palette.inkDim)
            }
            // WHAT IT IS ASKING, and the answer as a row of buttons.
            //
            // This is the whole point of a notification that carries the
            // question: reading it on a phone and being unable to answer is
            // the shape of the problem, not a smaller version of it. The
            // options are the ones the HOST published — an ordinal is sent,
            // never text.
            if let prompt = session.prompt, let options = prompt.options, !options.isEmpty {
                VStack(alignment: .leading, spacing: Design.Space.insideTight) {
                    if let question = prompt.question, !question.isEmpty {
                        // THE QUESTION IS THE TITLE HERE. It is why the
                        // notification arrived and why this row is at the top
                        // of the list; setting it in the same size as the row's
                        // own metadata was the app burying its own headline.
                        Text(question)
                            .fleetType(.title)
                            .foregroundStyle(Design.Palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    ForEach(options) { option in
                        Button {
                            Task { await answer(option.index) }
                        } label: {
                            HStack(spacing: Design.Space.insideTight) {
                                // The ordinal, because an ordinal is what is
                                // sent — the label never leaves the box.
                                Text("\(option.index)")
                                    .fleetType(.labelMono)
                                    .foregroundStyle(Design.Palette.inkDim)
                                    .padding(.horizontal, Design.Space.insideTight)
                                    .padding(.vertical, Design.Space.hair)
                                    .background(
                                        Design.Palette.track,
                                        in: RoundedRectangle(cornerRadius: Design.Radius.chip,
                                                             style: .continuous)
                                    )
                                Text(option.label)
                                    .fleetType(.bodySmall)
                                    .foregroundStyle(Design.Palette.ink)
                                    .multilineTextAlignment(.leading)
                                Spacer(minLength: 0)
                            }
                            // 44pt, whatever the label's length: this is the
                            // control the whole notification exists to offer.
                            .frame(minHeight: 44)
                            .padding(.horizontal, Design.Space.inside)
                            .background(
                                Design.Palette.inner,
                                in: RoundedRectangle(cornerRadius: Design.Radius.row,
                                                     style: .continuous)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: Design.Radius.row, style: .continuous)
                                    .strokeBorder(Design.Palette.ring, lineWidth: 1)
                            )
                        }
                        .disabled(busy)
                        .buttonStyle(.plain)
                    }
                }
                .padding(.top, Design.Space.insideTight)
            } else if session.prompt != nil {
                // A permission dialog names a command, so without the fleet
                // switch its labels do not leave the box. Saying so beats
                // showing nothing.
                Text("Waiting for an answer. The options are not shown because this fleet does not send prompt text off the box.")
                    .fleetType(.bodySmall)
                    .foregroundStyle(Design.Palette.inkDim)
            }

            HStack(spacing: Design.Space.groupTight) {
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
                // THE WORKSPACE, on running and stopped sessions alike. The
                // volume survives a stop — that is what makes a session
                // resumable — so "collect what it produced" is a thing to do
                // AFTER the work has finished, which is most of the time.
                NavigationLink("Files") {
                    FilesView(session: session.name, host: session.hostId, fleet: fleet)
                }
                .disabled(busy)
                // ITS OUTPUT, on running and stopped sessions alike, and for
                // the same reason as Files: the container's stderr outlives
                // the pane, and "why did it stop" is a question asked after
                // it has. The answer goes in the box at the top of the list,
                // where every other reply on this screen lands.
                Button("Output") { Task { await output() } }.disabled(busy)

                if !session.isRunning {
                    // Forget deletes the conversation and the workspace, which
                    // is why it is confirmed and stop is not: stop is
                    // reversible by resume, forget is reversible by nothing.
                    Button("Forget", role: .destructive) { confirmingForget = true }
                        .disabled(busy)
                }
            }
            .confirmationDialog(
                "Forget \(session.label)?",
                isPresented: $confirmingForget,
                titleVisibility: .visible
            ) {
                Button("Forget — delete its conversation and workspace", role: .destructive) {
                    Task { await forget() }
                }
            } message: {
                Text("This cannot be undone. Stop keeps everything and can be resumed; forget keeps nothing.")
            }
            .fleetType(.bodySmall)
            .buttonStyle(.borderless)
            .padding(.top, Design.Space.hair)
        }
        .fleetCard(radius: Design.Radius.cardSmall, ring: ring)
    }
}

private struct SettingsView: View {
    /// Which half of this screen to show.
    ///
    /// The alternative was moving sections into two files, and the state here
    /// — hosts, pins, the busy flag, the reboot ceremony's three fields — is
    /// shared across the split in both directions. Two renderings of one view
    /// keeps that state in one place; two views would have meant threading it
    /// through bindings for no gain a person can see.
    enum Focus { case machines, you, all }

    /// Whether this half belongs on the screen being shown.
    ///
    /// The gated bodies are deliberately NOT re-indented. Swift does not care,
    /// and adding four spaces to five hundred lines would have turned a change
    /// a reviewer can read in a minute into a diff nobody can — which is the
    /// wrong trade in a repository where the comments are the documentation.
    private func shows(_ half: Focus) -> Bool {
        focus == .all || focus == half
    }

    let settings: Settings
    var focus: Focus = .all
    /// Called when a SHEET presentation is finished with. Nil in a tab, where
    /// there is nothing to dismiss and a "Done" button is an instruction to
    /// leave a place you live in.
    var onDone: (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    @State private var pushResult = ""
    @State private var signInResult = ""
    @State private var signingIn = false
    @State private var pin = ""
    /// WHICH HOST THE PIN IN HAND IS FOR, or nil for an unbound one. A bound
    /// pin only works on the machine it names, so a screen showing six digits
    /// and not saying which box they belong to is a screen somebody types the
    /// wrong pin from.
    @State private var pinBoundTo: String?
    @State private var ephemeralPin = false
    @State private var hosts: [Fleet.Host] = []
    @State private var fleetHosts: [Fleet.FleetHost] = []
    /// Where a temporary machine would come from, or nil when this fleet
    /// cannot start one. The control below is drawn from this and only this.
    @State private var runnerRepo: String?
    @State private var runnerPlatform = "linux"
    @State private var runnerMinutes = 60
    @State private var runnerResult = ""
    // REVOKING A MACHINE AND EMPTYING THE BIN WERE HERE, and both moved: a
    // host's revocation is on that host's page and the bin is its own screen,
    // for the reason the comment on the "Add a machine" section gives — two
    // lists of one thing is the fault.
    //
    // What stayed behind was five `@State` properties, a `binAction`, a
    // confirmation footer and an alert, none of which anything could reach:
    // nothing assigned `purgeTarget` or `confirmingRevoke`, so neither control
    // could appear, and `hostActionResult` was written by both and rendered by
    // nothing. The comment on one of them described showing a reply beside the
    // row it is about — behaviour this screen had already stopped having.
    //
    // Deleted rather than rewired. The live copies work and are tested; a
    // second set nobody could open was somewhere for the next person to hook a
    // button up to and lose the answer again.
    // `expandedHost` went the same way and for the same reason: it named the
    // one host whose controls were showing, on a screen that no longer shows
    // any. A machine's page is a page now.
    /// HAS THE FIRST ANSWER ARRIVED? Distinct from "the answer was nothing",
    /// which is the same distinction this project argues for everywhere else
    /// and did not make on its own opening screen.
    ///
    /// Every list here starts empty, so for the second or so before the fleet
    /// replies the app said "No hosts reporting yet", "No devices reported" and
    /// "Nothing recorded yet" — three confident statements about a question
    /// nobody had asked. On a cold start that is the whole first impression:
    /// an app that looks broken and then silently fills in.
    ///
    /// A splash screen would hide it. This says it instead, which is cheaper
    /// and true.
    @State private var loaded = false
    /// The devices holding a credential for this fleet, and what happened
    /// lately. Both were in openapi.json and served by both coordinators
    /// before either app asked for them.
    @State private var clients: [Fleet.Client] = []
    @State private var events: [Fleet.Event] = []
    @State private var confirmingClientRevoke: Fleet.Client?
    @State private var clientResult = ""

    // `maintain` AND ITS Maintenance ENUM WERE HERE. Every one of their cases
    // — check, apply, upgrade, reboot, channel — is HostView's now, asked on
    // the page for the machine it is about, with one busy flag and one answer
    // that cannot be about a different box.
    //
    // The shared versions were the reason an answer had to be TAGGED with a
    // hostId before it could be rendered in the right row. There is nothing
    // left to tag.

    /// What this box says about itself, as lines.
    ///
    /// EXTRACTED FOR THE TYPE CHECKER, not for tidiness, and the failure is
    /// worth naming because it does not point at itself: this row's body grew
    /// past what Swift will spend solving one expression, and the compiler
    /// blamed a nested ternary that had not been touched in months — "unable to
    /// type-check this expression in reasonable time", on somebody else's line.
    /// It only happens on CI, because only CI builds for a device.
    ///
    /// A method rather than a separate View: it reads this screen's own state,
    /// and threading that through a struct's initialiser would be paying in
    /// bindings for something the type checker wanted in expressions.
    ///
    /// It named `busyHost` and `maintain` until both were deleted with the
    /// per-host controls, which is how a comment outlives what it describes.
    @ViewBuilder
    private func healthLines(for host: Fleet.FleetHost) -> some View {
            // WHO CAN START A SESSION HERE, and as whom. These were two lines
            // saying overlapping things — "signed in as eli@x.com · max ·
            // eli@x.com's Organization" above "2 people can start sessions
            // here" — where the org half repeated the address and the count
            // repeated the point. One line, and the org is dropped when it is
            // just the address again wearing a suffix.
            //
            // Zero is the real fault and the only thing worth colouring: a
            // machine has no Claude account of its own, so nil means an older
            // host and says nothing at all.
            if let accounts = host.health?.claudeAccounts {
                Text(describeWhoCanStart(accounts, account: host.health?.account))
                    .fleetType(.micro)
                    .foregroundStyle(accounts == 0 ? Design.Palette.attention : Design.Palette.inkDim)
            }
            // THE SECOND WAY TO BE SIGNED OUT, and the one that was invisible.
            // The line above reports on who has linked an account; this reports
            // on the credential file a session is actually handed. They came
            // apart in production — a box saying "signed in" while every
            // session started on it came up logged out.
            //
            // Shown only when it is DEAD. An expired token that can renew
            // itself is the ordinary state of a box nobody has touched for an
            // hour, and a warning that fires on the ordinary case is one people
            // stop reading.
            if let credential = host.health?.credential, credential.isDead {
                Text(credential.summary ?? "Sessions started here will come up signed out.")
                    .fleetType(.micro).foregroundStyle(Design.Palette.bad)
            }
            // WHAT IT IS RUNNING, AND WHAT IS WAITING, on one line — including
            // the channel, which had a line of its own on every row saying the
            // same eleven words. Version, then what it is behind, then which
            // releases it takes: one sentence, read left to right, in the order
            // somebody asks the questions.
            Text(describeRunning(host))
                .fleetType(.micro)
                .foregroundStyle(host.updatePending ? Design.Palette.attention : Design.Palette.inkDim)
            // WHAT THE OS HAS WAITING, kept separate because it is a different
            // subject with a different button — the whole reason `updates`
            // exists as a verb is that these two were being read as one.
            if let system = host.health?.updates?.system, !system.isEmpty {
                Text("OS: \(system)").fleetType(.micro).foregroundStyle(Design.Palette.attention)
            }
            if host.health?.updates?.rebootRequired == true {
                Text("reboot required").fleetType(.micro).foregroundStyle(Design.Palette.attention)
            }
    }

    /// A machine that wants something wears the attention ring.
    ///
    /// THE SAME RULE THE SESSION LIST FOLLOWS, and the same sentence: calm
    /// recedes, trouble comes forward. A session asking a question is the only
    /// card on that screen wearing anything but the hairline; here it is a
    /// machine that is not healthy, has an update waiting, or cannot start a
    /// session because nobody has connected Claude to it.
    ///
    /// THREE THINGS, NOT ONE, because "healthy" is the box's opinion of itself
    /// and says nothing about whether it can do the job. A host reporting
    /// normally that nobody can start work on is exactly the row that used to
    /// disappear into nine identical grey lines.
    private func hostRing(_ host: Fleet.FleetHost) -> Color {
        let unwell = (host.state ?? "unknown") != "healthy"
        let waiting = host.updatePending
        let unusable = (host.health?.claudeAccounts ?? 1) == 0
        return unwell || waiting || unusable ? Design.Palette.attention.opacity(0.55) : Design.Palette.ring
    }

    // `maintenanceRow` AND `channelControl` WERE HERE AND ARE GONE. Both were
    // defined and neither was called: HostView carries the whole of what a
    // machine can be asked to do now, and a view that is written and never
    // called renders exactly like one that was never written — which is a
    // sentence this file already had to write once, about this same function.
    //
    // The reboot ceremony went with them, and its state with that.

    // `applyWaiting` AND `applyChannel` WERE HERE. They existed to patch a
    // host's health back into the list after an action, because the card WAS
    // the control panel and had nowhere else to put the answer. HostView keeps
    // its own health and re-reads itself, so there is nothing to patch.

    // `binAction` WAS HERE, and the bin it acted on is RecycleBinView. Nothing
    // could call this one: the only caller was a confirmation footer that no
    // code path ever made appear. See the note where its state used to be.

    /// A MACHINE THAT DOES NOT EXIST YET, beside the pin for one that does.
    ///
    /// `provision` has been on both phones since runner central shipped and
    /// nothing offered it, because nothing could tell whether the button would
    /// do anything: the coordinator refuses a fleet with no runner repository
    /// with a sentence naming an environment variable, which is right for an
    /// agent that asked and a dead control on every fleet that has not set
    /// one. The snapshot says now, and this is drawn from that and only that.
    ///
    /// Split out of the section above because that body is already at the
    /// size where the Swift type checker gives up on a line nobody edited.
    @ViewBuilder private var temporaryMachine: some View {
        if let repo = runnerRepo {
            Picker("Temporary machine", selection: $runnerPlatform) {
                Text("Linux").tag("linux")
                Text("macOS").tag("macos")
                Text("Windows").tag("windows")
                Text("Android emulator").tag("android")
            }
            // FIVE-MINUTE STEPS between the protocol's own bounds. A free
            // field would need the refusal for 4 and for 351 written twice,
            // once here and once on the host; a stepper cannot ask for either.
            Stepper("For \(runnerMinutes) minutes", value: $runnerMinutes, in: 5...350, step: 5)
            Button("Ask for a temporary machine") { Task { await provision() } }
            // IT DOES NOT RETURN A HOST, and the reply says so too, because a
            // person who reads "started" as "ready" goes looking for a
            // machine that is still being built.
            Text("From \(repo). It takes a few minutes to boot and then appears in the fleet as a host of yours, "
                 + "for the time you asked. Sessions on it are lost when it goes, and it spends Actions minutes.")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
            if !runnerResult.isBlank {
                Text(runnerResult)
                    .fleetType(.labelMono)
                    .foregroundStyle(Design.Palette.ink)
                    .textSelection(.enabled)
            }
        }
    }

    @MainActor
    private func provision() async {
        runnerResult = ""
        do {
            runnerResult = try await Fleet(settings: settings)
                .provision(platform: runnerPlatform, minutes: runnerMinutes).text ?? ""
        } catch {
            runnerResult = error.localizedDescription
        }
    }

    @MainActor
    private func loadHosts() async {
        guard !settings.credential.isEmpty else { return }

        // FOUR ANSWERS, ONE WAIT. These were four sequential awaits: the screen
        // sat blank for four round trips, one after another, before it drew
        // anything — and every button on it calls this again when it finishes.
        // On a phone on mobile data that is most of a second of nothing,
        // repeated after every tap, which is the whole of "it feels slow".
        //
        // They do not depend on each other. `async let` starts all four and
        // waits once, so the cost is the slowest of them rather than the sum.
        let fleet = Fleet(settings: settings)
        async let reporting = fleet.fleetHosts()
        async let enrolled = fleet.enrolledHosts()
        async let devices = fleet.clients()
        async let happened = fleet.events()
        async let runners = fleet.runners()

        // AND A FAILED REQUEST IS NOT AN EMPTY FLEET.
        //
        // Every one of these was `(try? await …) ?? []`, which turns "the
        // network blinked" into "you have no machines" — the screen goes blank,
        // and then fills in again a moment later. It is the null-is-not-empty
        // rule, written down in this project more than once, broken in the app
        // that displays the answer.
        //
        // Keeping what we had is what somebody would expect: a list that was
        // right ten seconds ago is a better answer than nothing, and the next
        // refresh corrects it.
        //
        // Both lists: enrolled is the membership (fingerprints, revocation),
        // fleet is what they are saying right now. Different questions.
        if let got = try? await reporting { fleetHosts = got }
        if let got = try? await enrolled { hosts = got }
        // WHO CAN REACH THIS FLEET, AND WHAT HAPPENED. Both routes have been in
        // openapi.json and served by both coordinators since before either app
        // existed in its current shape, and neither app ever asked.
        //
        // `try?` like the two above: a coordinator too old to serve these
        // answers 404, and an empty section is the right way to say "this fleet
        // does not offer that" — not a failed screen.
        if let got = try? await devices { clients = got }
        if let got = try? await happened { events = got }
        // A NIL INSIDE A SUCCESS IS THE ANSWER "no runner repository"; a failed
        // request keeps what was there, like the four above.
        if let got = try? await runners { runnerRepo = got }
        // AFTER the four, not before: "loaded" means an answer arrived, and
        // setting it first would put the empty states back one line earlier.
        loaded = true
    }

    /// "elibrody2@gmail.com · last used 2 hours ago", or as much as is known.
    ///
    /// NEVER USED AND USED LONG AGO MUST LOOK DIFFERENT. `lastSeenAt` is null for a
    /// credential that has never been spent, and rendering that as an epoch date —
    /// or worse, as "now" — is the difference between spotting a credential
    /// somebody minted and never collected and scrolling past it.
    /// Devices that have actually been used, newest first.
    private var clientsInUse: [Fleet.Client] {
        clients.filter { $0.lastSeenAt != nil }.sorted { ($0.lastSeenAt ?? 0) > ($1.lastSeenAt ?? 0) }
    }

    /// Minted and never spent — an abandoned sign-in.
    private var clientsNeverUsed: [Fleet.Client] {
        clients.filter { $0.lastSeenAt == nil }
    }

    @ViewBuilder private func clientRow(_ c: Fleet.Client) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(c.name ?? "unnamed device").fleetType(.body)
            Text(describeClient(c)).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
        }
        .swipeActions {
            Button("Revoke", role: .destructive) { confirmingClientRevoke = c }
        }
    }

    private func describeClient(_ c: Fleet.Client) -> String {
        // THE ADDRESS IS IN THE TITLE ALREADY. Every row read
        //
        //   iPhone (elibrody2@gmail.com)
        //   elibrody2@gmail.com · never used
        //
        // which is the same fault this screen was just cleaned up for, shipped
        // one section down by the same hand. Eleven rows, most of them
        // identical, and the only thing that told them apart was printed twice.
        //
        // So this says the one thing that DIFFERS between two devices with the
        // same name — when it was last used — and the address only when it is
        // somebody else's, which is the case where it is news.
        var parts: [String] = []
        if let email = c.email, !email.isEmpty, email != settings.signedInAs { parts.append(email) }
        if let seen = c.lastSeenAt {
            parts.append("last used \(relative(seen))")
        } else {
            // NOT "never used" AS A FOOTNOTE. A credential minted and never
            // spent is an abandoned sign-in, and on this screen there were
            // seven of them — it is the reason somebody is here, not a detail.
            parts.append("never used — safe to revoke")
        }
        return parts.joined(separator: " · ")
    }

    /// Consecutive identical events, collapsed to one row and a count.
    ///
    /// The coordinator's ring is a LOG: every intent, in order, which is the
    /// right thing for it to keep. A screen headed "what happened while you
    /// were away" is a different question, and answering it with nine
    /// consecutive lines reading "asked for connect" is answering it with the
    /// log — which is how a summary becomes something nobody reads.
    ///
    /// CONSECUTIVE ONLY, not grouped across the list. Two bursts of the same
    /// verb an hour apart are two things that happened, and merging them would
    /// lose the second one's time.
    private var runs: [EventRun] {
        var out: [EventRun] = []
        for e in events.reversed() {
            if let last = out.last, last.event.event == e.event, last.event.name == e.name,
               last.event.hostId == e.hostId, last.event.actor == e.actor {
                out[out.count - 1].count += 1
            } else {
                out.append(EventRun(event: e, count: 1))
            }
        }
        return out
    }

    private struct EventRun: Identifiable {
        let event: Fleet.Event
        var count: Int
        var id: String { event.id }
    }

    /// The sentence for one event, with its subject named.
    ///
    /// The fleet records `text` for the events that have something to say and not
    /// for the rest, so this falls back to the event's own name rather than to an
    /// empty row — a blank line in a list of things that happened is worse than a
    /// terse one.
    private func describeEvent(_ e: Fleet.Event) -> String {
        if let t = e.text, !t.isEmpty { return t }
        if let n = e.name, !n.isEmpty { return "\(e.event) — \(n)" }
        return e.event
    }

    /// "on deb132 · 20 minutes ago", and who asked when it was not you.
    private func describeEventWho(_ e: Fleet.Event) -> String {
        var parts: [String] = []
        // "on coordinator" IS NOT A PLACE. It is where everything happens, so
        // it distinguished nothing and appeared on nearly every line.
        if let h = e.hostId, !h.isEmpty, h != "coordinator" { parts.append("on \(h)") }
        // NULL ACTOR IS NOT AN UNKNOWN PERSON — it is the fleet acting on its
        // own, which is a different kind of news and says so.
        //
        // AND YOUR OWN NAME IS NOT NEWS EITHER. Every line read
        // "elibrody2@gmail.com asked for connect" over
        // "on coordinator · elibrody2@gmail.com · 1 hour ago" — the address
        // twice, in a list where every entry was the same person.
        if let a = e.actor, !a.isEmpty {
            if a != settings.signedInAs { parts.append(a) }
        } else {
            parts.append("the fleet")
        }
        parts.append(relative(e.at))
        return parts.joined(separator: " · ")
    }

    /// Milliseconds since the epoch, as words.
    private func relative(_ at: Double) -> String {
        let date = Date(timeIntervalSince1970: at / 1000)
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        return f.localizedString(for: date, relativeTo: Date())
    }

    /// 123 456 — read down a phone, typed into a terminal.
    /// A pin that only works on one machine.
    ///
    /// Readmitting a revoked host and re-keying an existing one are the two
    /// things an unbound pin is deliberately refused for — a pin handed out to
    /// ADD a box must not be spendable on taking over one that is already
    /// there, and undoing a revocation should be a decision rather than a side
    /// effect. Both refusals name that remedy; neither could be acted on from
    /// this app until now.
    @MainActor
    private func mintBoundPin(for hostId: String, readmit: Bool) async {
        pin = ""
        pinBoundTo = nil
        do {
            pin = try await Fleet(settings: settings).mintHostPin(hostId: hostId, readmit: readmit)
            // Set only on success, so a failed mint cannot leave the previous
            // pin on screen wearing a new host's name.
            pinBoundTo = hostId
        } catch {
            signInResult = error.localizedDescription
        }
    }

    private var formattedPin: String {
        pin.count == 6 ? "\(pin.prefix(3)) \(pin.suffix(3))" : pin
    }

    /// Deliberately NOT `@MainActor` on the function itself.
    ///
    /// It is handed to `SignInWithAppleButton` as a plain closure, and a
    /// global-actor-isolated function converted to a non-isolated one loses its
    /// isolation — a warning today and an error under Swift 6. `Task { @MainActor in }`
    /// says the same thing where it is actually needed, which is every line
    /// below: the state, the settings object and `UIDevice` are all main-actor.
    private func signIn(_ result: Result<ASAuthorization, Error>) {
        Task { @MainActor in
            signingIn = true
            signInResult = "signing in…"
            defer { signingIn = false }
            do {
                let idToken = try SignIn.identityToken(from: result)
                let issued = try await Fleet(settings: settings).signIn(
                    idToken: idToken,
                    // Names the credential in the fleet's device list, and it is
                    // the difference between "revoke the right phone" and
                    // "revoke one of three called iPhone".
                    deviceName: UIDevice.current.name
                )
                settings.credential = issued.token
                settings.signedInAs = issued.email
                signInResult = ""
                await loadHosts()
                onDone?()
            } catch SignIn.Failure.cancelled {
                signInResult = ""
            } catch {
                signInResult = error.localizedDescription
            }
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                // header:/footer: closures rather than Section("title") { } —
                // there is no initialiser taking a String title AND a footer,
                // which the first real compile caught.
                if shows(.machines) {
                Section {
                    TextField("https://fleet.thetech.network", text: Bindable(settings).coordinatorURL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                } header: {
                    Text("Coordinator")
                        .fleetType(.section)
                        .foregroundStyle(Design.Palette.ink)
                        .textCase(nil)
                } footer: {
                    // WHICH BUILD THIS IS. The marketing version is the same
                    // across every TestFlight build of a release, so it cannot
                    // tell two of them apart — and "it is still broken" and
                    // "you do not have the fix yet" are the same sentence when
                    // nobody can name the build they are on.
                    Text("The one origin this app will talk to.\n\nFleetwright \(Bundle.main.shortVersion) (build \(Bundle.main.buildNumber))")
                }
                }

                if shows(.you) {
                Section {
                    if settings.credential.isEmpty {
                        SignInWithAppleButton(.signIn, onRequest: SignIn.configure, onCompletion: signIn)
                            .signInWithAppleButtonStyle(.black)
                            .frame(height: 44)
                            .disabled(settings.coordinatorURL.isEmpty || signingIn)
                        // WHY IT IS GREY, SAID OUT LOUD. Sign-in posts an ID
                        // token to a coordinator, so without a URL there is
                        // nowhere to post it. That was true and invisible, and
                        // a disabled control with no reason beside it reads as
                        // a broken app — the next move is to tap it again
                        // rather than to fill in the field above.
                        //
                        // Only for the reason that is a person's to fix.
                        // "Signing in" needs no explanation; the button is
                        // already saying it.
                        if settings.coordinatorURL.isEmpty {
                            Text("Add a coordinator URL above first — signing in means signing in to a fleet.")
                                .fleetType(.label)
                                .foregroundStyle(Design.Palette.inkDim)
                        }
                        // ONE TAP INTO A FLEET THAT ISN'T REAL.
                        //
                        // The demo credential has existed since App Review
                        // needed one, and reaching it meant finding a token in
                        // a deployment document and pasting it into a
                        // collapsed field labelled "credential" — which is a
                        // fair description of "no demo at all" for anybody who
                        // is not already reading the repo.
                        //
                        // It fills an EMPTY coordinator field rather than
                        // overwriting one: somebody who has already pointed
                        // this app at their own fleet and taps the wrong row
                        // must not lose it.
                        Button("Look around the demo fleet") {
                            // The real coordinator is REMEMBERED, not
                            // discarded. Somebody who has already pointed this
                            // app at their own fleet and taps out of curiosity
                            // must get it back when they leave — losing it
                            // would mean re-typing a URL to undo a tap.
                            if !settings.coordinatorURL.isEmpty
                                && !Demo.isActive(settings.coordinatorURL) {
                                settings.urlBeforeDemo = settings.coordinatorURL
                            }
                            settings.coordinatorURL = Demo.coordinatorURL
                            settings.signedInAs = Demo.label
                            settings.credential = Demo.credential
                            onDone?()
                        }
                    } else if Demo.isActive(settings.coordinatorURL) {
                        // Said plainly, and never as "signed in". Every reply
                        // from this fleet carries `demo: true`, and a person
                        // wondering why their machines are missing deserves the
                        // answer on the screen rather than in a support thread.
                        LabeledContent("Demo") { Text("invented hosts and sessions") }
                        Button("Leave the demo") {
                            settings.signOut()
                            settings.coordinatorURL = settings.urlBeforeDemo
                            settings.urlBeforeDemo = ""
                        }
                    } else {
                        LabeledContent("Signed in") {
                            Text(settings.signedInAs.isEmpty ? "this device" : settings.signedInAs)
                        }
                        Button("Sign out", role: .destructive) { settings.signOut() }
                    }
                    if !signInResult.isEmpty {
                        Text(signInResult).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                    }
                } header: {
                    Text("You")
                        .fleetType(.section)
                        .foregroundStyle(Design.Palette.ink)
                        .textCase(nil)
                } footer: {
                    // Two things worth saying before somebody hits the button
                    // and gets a refusal they cannot interpret: the fleet is a
                    // list of allowed addresses, and Hide My Email can never be
                    // on it.
                    Text("This device gets a credential of its own, kept in the keychain and revocable on its own. "
                         + "Choose \"Share My Email\" — a fleet allows people by address, and a hidden one matches nothing. "
                         + "No account? The demo is two invented machines and needs nothing.")
                }
                }

                // Adding a machine. Deliberately here rather than buried: it is
                // the second thing anybody does after signing in, and the pin
                // is the whole of how a host joins now.
                if !settings.credential.isEmpty {
                    if shows(.machines) {
                    Section {
                        // TEMPORARY IS A PROPERTY OF THE PIN, not of the box.
                        // The coordinator has been able to admit a host that is
                        // expected to vanish since the framework was built, and
                        // nothing could ask it to — so every CI runner enrolled
                        // as permanent and left its entry behind when the job
                        // ended. One corpse per build.
                        Toggle("Temporary host (CI runner)", isOn: $ephemeralPin)
                        if ephemeralPin {
                            Text("Retired the moment it disconnects, and its key revoked. Never chosen automatically for work — it has the most free capacity in the fleet precisely because it is about to disappear.")
                                .fleetType(.label)
                                .foregroundStyle(Design.Palette.inkDim)
                        }
                        Button("Mint a pin for a new host") {
                            Task {
                                pin = ""
                                pinBoundTo = nil
                                do {
                                    pin = try await Fleet(settings: settings).mintHostPin(ephemeral: ephemeralPin)
                                } catch {
                                    signInResult = error.localizedDescription
                                }
                            }
                        }
                        if !pin.isEmpty {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(formattedPin).font(.system(.title, design: .monospaced))
                                    .textSelection(.enabled)
                                if let bound = pinBoundTo {
                                    // NAMED, because a bound pin is refused
                                    // anywhere else and the refusal arrives on
                                    // the box rather than here.
                                    Text("for \(bound) only")
                                        .fleetType(.micro)
                                        .foregroundStyle(Design.Palette.attention)
                                }
                                Text("On that box: agent-fleet-sidecar enrol \(pin)")
                                    .fleetType(.microMono)
                                    .foregroundStyle(Design.Palette.inkDim)
                            }
                        }
                        temporaryMachine
                        // AND THE THIRD WAY A MACHINE ARRIVES: a repository's
                        // own workflow, started by hand, joining a runner as
                        // you. Minted with curl since it shipped; a screen now.
                        NavigationLink("Runner tokens") {
                            RunnerTokensView(settings: settings)
                        }
                        // THE PER-HOST ROWS ARE GONE, and the width was how
                        // it showed. This section is a Form section at the
                        // system's inset; the fleet cards below sit at the
                        // design's page margin — 26 — so the two lists of the
                        // same three machines did not even line up with each
                        // other.
                        //
                        // Two lists of one thing is the fault; the ragged edge
                        // was the symptom. A machine's fingerprint, its
                        // revocation and its replacement key are on that
                        // machine's page now, beside everything else it says,
                        // and this section is what it was always for: adding a
                        // machine that is not here yet.
                    } header: {
                        Text("Add a machine")
                            .fleetType(.section)
                            .foregroundStyle(Design.Palette.ink)
                            .textCase(nil)
                    } footer: {
                        // The delete-for-good confirmation that stood above
                        // this line could not appear: nothing set the state it
                        // was drawn from. Deleting for good is on the bin's own
                        // screen, which asks the same question and can be
                        // reached.
                        Text("A pin is good for ten minutes, once. Revoking a host disconnects it as well.")
                    }
                    }
                }

                // "Use a credential instead" WAS HERE, and is gone.
                //
                // It existed for two things. The first was App Review, which
                // needed a way in that no allowlist could grant — now a button
                // in the section above, because asking a reviewer to find a
                // token in a deployment document and paste it into a field
                // labelled "credential" is a fair description of no demo at
                // all.
                //
                // The second was getting back in when sign-in itself is
                // broken. That is a real need and it is now served by curl with
                // the API token rather than by a field in everybody's settings.
                // A box that asks for a token, in front of every user, is how
                // the shared-secret habit comes back — and a recovery path only
                // the operator needs does not belong on the operator's users'
                // screens.

                // Push is the one feature that fails silently. A registration
                // that never arrived and a coordinator with no sender
                // configured look identical from a phone, which is to say they
                // look like nothing at all. This asks for one now and reports
                // what happened, so the answer arrives before the notification
                // that matters does.
                // WHAT EACH BOX SAYS ABOUT ITSELF. Asked for directly — "we
                // need the sign-in status and logs available on the app" —
                // and this is the first half: the answer to "is that box
                // logged in, on what plan, running what code" without SSH.
                if shows(.machines) {
                Section {
                    if fleetHosts.isEmpty {
                        Text(loaded ? "No hosts reporting yet." : "Asking the fleet…")
                            .fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                    }
                    ForEach(fleetHosts) { host in
                        // A CARD, LIKE A SESSION IS. This was a Form row: nine
                        // lines of .micro grey stacked at 3pt, where the
                        // hostname, "23 commits behind" and "1 person" were all
                        // the same size and the same weight. A screen somebody
                        // opens because something is wrong should not need
                        // reading start to finish to find out which machine.
                        //
                        // The design system already answered this for sessions
                        // and the fleet did not get it — #423 rebuilt the
                        // session list around cards and restyled this list in
                        // place, which left it looking like the thing it used
                        // to be.
                        VStack(alignment: .leading, spacing: Design.Space.hair) {
                            HStack(alignment: .firstTextBaseline, spacing: Design.Space.insideTight) {
                                // THE CARD'S HEADLINE, at the weight a headline
                                // gets. Monospace stays — a hostname is a name
                                // you compare character by character against a
                                // terminal — but micro was making the one thing
                                // you are looking for the smallest text on the
                                // row.
                                Text(host.hostId)
                                    .fleetType(.bodyStrong)
                                    .foregroundStyle(Design.Palette.ink)
                                Spacer(minLength: 0)
                                Text(host.state ?? "unknown")
                                    .fleetType(.label)
                                    // Colour reinforces the word; it never
                                    // carries the meaning alone.
                                    //
                                    // FROM THE PALETTE. This was `.green` and
                                    // `.orange` — SwiftUI's own, which are not
                                    // the two this product uses and do not move
                                    // between themes with the rest of the
                                    // screen. The palette has had `ok` and
                                    // `attention` since the design system
                                    // landed; four call sites never took them.
                                    .foregroundStyle(host.state == "healthy"
                                                     ? Design.Palette.ok
                                                     : Design.Palette.attention)
                            }
                            // The registry works to make "we don't know"
                            // unrepresentable as a benign value. Rendering the
                            // reason verbatim is what makes that work visible.
                            //
                            // ONLY WHEN IT IS NEWS. "reporting normally" under a
                            // badge reading "healthy" is the same fact twice,
                            // and a card that says everything twice is a card
                            // nobody finishes reading. The reason is here for
                            // the state that is NOT normal, which is the state
                            // it was written for.
                            if let reason = host.reason, !reason.isEmpty, (host.state ?? "") != "healthy" {
                                Text(reason).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                            }
                            // THE ACCOUNT LINE IS GONE, because it was printed
                            // twice. describeWhoCanStart already carries the
                            // address, the plan and the org — it was changed to
                            // carry them when those two lines were merged — and
                            // this one was left above it, so every card read
                            //
                            //   signed in as eli@x.com · max · eli@x.com's Organization
                            //   1 person · eli@x.com · max
                            //
                            // The merge happened inside the function and not at
                            // the call site, which is how a fix leaves the thing
                            // it fixed still on screen.
                            // THREE CALLS RATHER THAN THREE BLOCKS, and it is
                            // the Swift type checker asking, not a style rule.
                            // This row's body grew past what the compiler will
                            // spend on one expression and it failed on CI —
                            // blaming a nested ternary nobody had touched,
                            // because that was the sub-expression it happened
                            // to run out of time on. The line an error like
                            // that names is not the line that caused it.
                            healthLines(for: host)

                            // EVERYTHING ELSE IS BEHIND A TAP, and this is the
                            // difference between a card and a control panel.
                            //
                            // At rest every host showed Check, Reboot, a
                            // full-width channel picker and a sign-in link —
                            // four controls, on every machine, all the time,
                            // for a fleet where the ordinary answer is "nothing
                            // needs you". Three hosts came to about a thousand
                            // points of chrome under six lines of fact, and the
                            // eye had nothing to land on because every card was
                            // identical and every card was loud.
                            //
                            // Reboot is the sharpest case: a destructive action
                            // one tap away on a machine nobody asked about.
                            //
                            // So the card is what a machine IS, and tapping it
                            // is asking to do something. Calm recedes.
                            // EVERYTHING YOU CAN DO ABOUT A MACHINE IS ON THE
                            // MACHINE'S OWN PAGE. This was four controls under
                            // every card, then — worse — the same four behind a
                            // tap that expanded the row in place. A row that
                            // grows inside a List jumps: the height changes with
                            // no transition to carry it, and what arrives is the
                            // same wall all at once.
                            //
                            // The instinct was right and the place was wrong.
                            // "This card is doing too much" is not answered by
                            // doing it on demand; a machine is a subject and
                            // deserves a page. A push animates itself.
                        }
                        .fleetCard(radius: Design.Radius.cardSmall, ring: hostRing(host))
                        .fleetRow()
                        // A LINK, NOT A TAP GESTURE. The push transition, the
                        // back button and the accessibility affordance all come
                        // with it; a gesture on a card gets none of those and
                        // has to invent each one badly.
                        .background(
                            NavigationLink("") {
                                HostView(
                                    settings: settings,
                                    hostId: host.hostId,
                                    initialHealth: host.health,
                                    initialState: host.state,
                                    initialReason: host.reason,
                                    enrolled: hosts.first { $0.hostId == host.hostId },
                                    onChange: { await loadHosts() },
                                )
                            }
                            .opacity(0)
                        )
                    }
                } header: {
                    Text("Fleet")
                        .fleetType(.section)
                        .foregroundStyle(Design.Palette.ink)
                        .textCase(nil)
                } footer: {
                    Text("What each machine reports about itself: whether it is signed in, which plan, "
                         + "and whether its code is behind.")
                }
                }

                // YOUR credentials, not a machine's. Top level, because a
                // token is the person's and reaches every host — which is what
                // the screen said while living under one particular box.
                if !settings.credential.isEmpty {
                    if shows(.you) {
                    Section {
                        NavigationLink("Your credentials") {
                            CredentialsView(settings: settings, host: nil)
                        }
                        // WHO ELSE IS ALLOWED IN. Adding a person used to be a
                        // commit and a deploy; it is a screen now, which is the
                        // last thing about running this fleet that needed a
                        // keyboard.
                        NavigationLink("People") {
                            PeopleView(settings: settings)
                        }
                    } footer: {
                        // "Signing in to Claude is per machine and lives with
                        // the machine" described the box account that no longer
                        // exists.
                        Text("GitHub and Cloudflare go to every machine in the fleet. Claude is per person: a "
                             + "session runs on the account of whoever started it, and it has to be connected "
                             + "on each machine separately.")
                    }
                    }
                }

                // Kinds, and the toggle that decides what a spoken start does
                // to your screen.
                if shows(.you) {
                Section {
                    NavigationLink("Session kinds") { SessionKindsView(settings: settings) }
                    // Two taps to a phrase with no app name in it at all.
                    //
                    // Apple requires the app name in the phrases WE ship, which
                    // means the built-in ones make somebody say a brand to reach
                    // their own work. A shortcut they make themselves has no
                    // such rule: they can call it "Debbie", or "another remote
                    // session", or whatever they already call this in their
                    // head — and that is the name that will still be there in a
                    // month, because it was theirs before we arrived.
                    NavigationLink("Say it your way") { ShortcutSetupView(settings: settings) }
                    ShortcutsLink()
                } header: {
                    Text("Siri and Shortcuts")
                        .fleetType(.section)
                        .foregroundStyle(Design.Palette.ink)
                        .textCase(nil)
                } footer: {
                    // A multi-line literal, not a chain of `+`. Five string
                    // literals joined with + is enough to make Swift's type
                    // checker give up — "unable to type-check this expression
                    // in reasonable time" — because each + is an overloaded
                    // operator it has to resolve against every candidate. This
                    // is one literal and one expression.
                    Text("""
                    Say "start a dev session on my fleet". "my fleet", "my agents" and \
                    "remote sessions" all work, so there is no product name to remember.

                    For a phrase of your own — "Debbie", or anything else you call this — \
                    tap "Say it your way" above.

                    Saying "and open it" brings the app forward; plain "start a session" does \
                    not. Two phrases rather than a setting, because an intent from an \
                    automation often runs when nobody is looking at the phone — and which of \
                    those you meant is clearer as you say it.
                    """)
                }
                }

                if shows(.you) {
                Section {
                    if clients.isEmpty {
                        Text(loaded ? "No devices reported." : "Asking the fleet…")
                            .fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                    }
                    // IN USE FIRST, ABANDONED LAST. The coordinator sorts by
                    // when a credential was MINTED, which on a real account put
                    // seven never-used sign-ins above the phone in your hand.
                    // The question this screen answers is "which of these is
                    // still live", so that is the order.
                    ForEach(clientsInUse) { c in
                        clientRow(c)
                    }
                    // AND THE ABANDONED ONES FOLD AWAY. A credential minted and
                    // never spent is the ordinary residue of signing in twice;
                    // eleven rows of it buried the two that matter. They are
                    // still here, still revocable, and no longer the first
                    // thing on the screen.
                    if !clientsNeverUsed.isEmpty {
                        DisclosureGroup("\(clientsNeverUsed.count) never used") {
                            ForEach(clientsNeverUsed) { c in
                                clientRow(c)
                            }
                        }
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                    }
                    if !clientResult.isBlank {
                        Text(clientResult).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                    }
                } header: {
                    Text("Devices")
                        .fleetType(.section)
                        .foregroundStyle(Design.Palette.ink)
                        .textCase(nil)
                } footer: {
                    // WHY THIS SCREEN EXISTS. Signing in mints one credential
                    // per device precisely so that revoking one leaves every
                    // other alone — and that property was worth nothing while
                    // nobody could see the list. A lost phone could be revoked
                    // only from a terminal, which is the one thing this product
                    // exists not to require.
                    Text("Each sign-in mints a credential for that device alone, so revoking one "
                         + "leaves the others working. Swipe to revoke a device you no longer have.")
                }
                }

                if shows(.you) {
                Section {
                    if events.isEmpty {
                        Text(loaded ? "Nothing recorded yet." : "Asking the fleet…")
                            .fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                    }
                    // NEWEST FIRST HERE, oldest-first on the wire. The
                    // coordinator returns them in the order they happened,
                    // which is right for a log and wrong for a screen somebody
                    // opens to find out what they missed.
                    ForEach(runs) { run in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(describeEvent(run.event)).fleetType(.body)
                                if run.count > 1 {
                                    // NINE LINES SAYING "asked for connect" IS
                                    // ONE FACT. A log repeats because a person
                                    // tapped a button nine times; a screen
                                    // reporting what happened should say that
                                    // once and say how many.
                                    Text("×\(run.count)")
                                        .fleetType(.label)
                                        .foregroundStyle(Design.Palette.inkDim)
                                }
                                Spacer(minLength: 0)
                            }
                            Text(describeEventWho(run.event))
                                .fleetType(.label)
                                .foregroundStyle(Design.Palette.inkDim)
                        }
                    }
                } header: {
                    Text("Recent activity")
                        .fleetType(.section)
                        .foregroundStyle(Design.Palette.ink)
                        .textCase(nil)
                } footer: {
                    // THE OTHER HALF OF PUSH. A notification wakes the phone;
                    // this is what it was about. Only one of those shipped, so
                    // an app that had been closed since yesterday had no way to
                    // find out anything beyond the sentence on the lock screen.
                    Text("What happened while the app was closed. A notification wakes this phone; "
                         + "this is the rest of it.")
                }
                }

                if shows(.you) {
                Section {
                    Button("Send a test notification") {
                        Task {
                            pushResult = "sending…"
                            do {
                                pushResult = try await Fleet(settings: settings).testPush(token: nil).text ?? "Sent."
                            } catch {
                                pushResult = error.localizedDescription
                            }
                        }
                    }
                    .disabled(!settings.configured)
                    if !pushResult.isBlank {
                        Text(pushResult).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                    }
                } header: {
                    Text("Notifications")
                        .fleetType(.section)
                        .foregroundStyle(Design.Palette.ink)
                        .textCase(nil)
                }
                }
            }
            // The design's ground, and the rows on the card colour. A grouped
            // Form's default is the system's grey, which is a different app's
            // grey — the list behind this sheet stopped using it two screens
            // ago and this one saying otherwise is the seam.
            .scrollContentBackground(.hidden)
            .background(Design.Palette.bg)
            .listRowBackground(Design.Palette.card)
            // THE TAB'S OWN NAME. Both tabs rendered this view and both said
            // "Settings", so the Fleet tab was titled after the sheet it used
            // to be part of — a screen announcing itself as somewhere else.
            .navigationTitle(focus == .machines ? "Fleet" : "Settings")
            .task { await loadHosts() }
            .alert(
                "Revoke \(confirmingClientRevoke?.name ?? "this device")?",
                isPresented: Binding(
                    get: { confirmingClientRevoke != nil },
                    set: { if !$0 { confirmingClientRevoke = nil } }
                )
            ) {
                Button("Cancel", role: .cancel) { confirmingClientRevoke = nil }
                Button("Revoke", role: .destructive) {
                    guard let c = confirmingClientRevoke else { return }
                    confirmingClientRevoke = nil
                    Task {
                        // The refusal reaches the screen, for the reason the
                        // host revocation learned the hard way: a discarded
                        // error reads as "it came back". That one lives in
                        // HostView.swift now, and this stays where it is
                        // because a device is not a machine.
                        do {
                            clientResult = try await Fleet(settings: settings).revokeClient(c.id).text ?? ""
                        } catch {
                            clientResult = error.localizedDescription
                        }
                        await loadHosts()
                    }
                }
            } message: {
                Text("That device stops being able to reach this fleet, and its push notifications "
                     + "stop. Every other device keeps working. Signing in again on it mints a new one.")
            }
            // A SECOND "Revoke <host>?" ALERT WAS HERE, unreachable — nothing
            // ever set the state it was presented from. It carried the lesson
            // that a refusal the user never sees costs a night, and the lesson
            // was worth more than the code: the live revoke, on the host's own
            // page, was setting its answer and then dismissing the page it had
            // just set it on. That is fixed in HostView.swift, where the whole
            // story is now written down beside the code it is about.
            .toolbar {
                // ONLY AS A SHEET. In a tab there is nothing to dismiss, and
                // Done sat in the corner of a screen nobody had opened.
                if let onDone {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { onDone(); dismiss() }
                    }
                }
            }
        }
    }
}

/// A session's state, as a symbol AND a word.
///
/// Never colour alone. The symbol is a shape and the word is a word; the tint
/// only reinforces what both already say. That is what "differentiate without
/// colour" asks for, and it is also the difference between a glanceable list
/// and a pretty one — colour vision deficiency affects around one man in
/// twelve, and everybody loses colour in bright sun.
private struct StatusBadge: View {
    let status: String

    private var symbol: String {
        switch status {
        case "running": return "play.circle.fill"
        case "awaiting-input": return "exclamationmark.bubble.fill"
        case "stopped": return "pause.circle"
        case "ended": return "checkmark.circle"
        default: return "questionmark.circle"
        }
    }

    /// The tone, which only ever agrees with the word beside it.
    ///
    /// `running` is the design system's `active` — a sky blue — rather than the
    /// app's accent. The accent means "you can tap this"; a status is not an
    /// action, and a badge that borrows the accent teaches the accent to mean
    /// two things.
    private var tint: Color {
        switch status {
        case "running": return Design.Palette.active
        case "awaiting-input": return Design.Palette.attention
        case "ended": return Design.Palette.ok
        default: return Design.Palette.idle
        }
    }

    var body: some View {
        HStack(spacing: Design.Space.hair) {
            // Decorative: the word beside it is the label, and VoiceOver
            // announcing "play circle fill, running" is worse than "running".
            Image(systemName: symbol)
                .accessibilityHidden(true)
            Text(status)
        }
        .fleetType(.label)
        .foregroundStyle(tint)
        .padding(.horizontal, Design.Space.insideTight)
        .padding(.vertical, Design.Space.hair)
        .background(
            Design.Palette.inner,
            in: RoundedRectangle(cornerRadius: Design.Radius.chip, style: .continuous)
        )
    }
}


/// Editing the words Siri will recognise.
///
/// Deliberately plain. This is a list somebody visits twice — once to add
/// "dev", once more a month later — and anything cleverer than a list and a
/// text field is design nobody asked for on a screen nobody looks at.
struct SessionKindsView: View {
    /// Passed in only so the task picker can ask the fleet what profiles exist.
    /// A TEXT FIELD WOULD HAVE BEEN SMALLER AND WRONG: a mistyped profile name
    /// saves fine, pre-fills nothing, and the kind quietly starts idle sessions
    /// forever — a setting that looks applied and is not, which is the exact
    /// shape this app keeps paying for.
    let settings: Settings

    @State private var kinds: [SessionKind] = SessionKinds.all()
    @State private var newWord = ""
    @State private var profiles: [Fleet.Profile] = []

    var body: some View {
        Form {
            Section {
                ForEach($kinds) { $kind in
                    VStack(alignment: .leading, spacing: 6) {
                        TextField("Word", text: $kind.word)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                        TextField("Title prefix (optional)", text: $kind.titlePrefix)
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                        // Only when the fleet has answered with something. A
                        // picker whose only entry is "Nothing" is furniture,
                        // and on a fleet with no profiles it would be furniture
                        // that implies a feature is broken.
                        if !profiles.isEmpty {
                            Picker("Task", selection: $kind.profile) {
                                Text("Nothing — I will drive it").tag("")
                                ForEach(uniqueProfiles, id: \.self) { name in Text(name).tag(name) }
                            }
                            .fleetType(.label)
                        }
                    }
                }
                .onDelete { idx in
                    idx.map { kinds[$0].id }.forEach(SessionKinds.remove)
                    kinds.remove(atOffsets: idx)
                }
                HStack {
                    TextField("Add a word", text: $newWord)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    Button("Add") {
                        let word = newWord.trimmingCharacters(in: .whitespaces)
                        guard !word.isEmpty else { return }
                        kinds.append(SessionKind(word: word))
                        newWord = ""
                        SessionKinds.save(kinds)
                    }
                    .disabled(newWord.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            } header: {
                Text("Words")
                    .fleetType(.section)
                    .foregroundStyle(Design.Palette.ink)
                    .textCase(nil)
            } footer: {
                // Said, because otherwise the first thing anybody does is add a
                // word and then wonder why Siri has not heard of it.
                Text("""
                Say "start a dev session on my fleet". A new word can take a moment before \
                Siri recognises it. A prefix groups sessions in the list: "dev: refactor auth". \
                A task makes the word do something: spoken, that is the only way a session gets \
                one, because there is no screen to drive it from afterwards.
                """)
            }
        }
        // The design's ground, and the rows on the card colour, so this screen
        // belongs to the same app as the one that pushed it.
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Session kinds")
        .task { profiles = (try? await Fleet(settings: settings).profiles()) ?? [] }
        // Saved on the way out rather than on every keystroke: this writes the
        // whole list, and doing that per character would rewrite it a hundred
        // times while somebody types one word.
        .onDisappear { SessionKinds.save(kinds) }
    }

    /// By NAME, deduplicated across hosts.
    ///
    /// A kind is a word somebody says, not a placement: two boxes may both have
    /// a profile called "reviewer", and a kind that pinned one of them would
    /// send "start a reviewer session" at a machine that happens to be busy.
    /// The start sheet resolves the host from where the file actually is.
    private var uniqueProfiles: [String] {
        Array(Set(profiles.map(\.name))).sorted()
    }
}


/// "signed in as a@b.com · max · Example Org", built a piece at a time.
///
/// A plain function rather than an expression in the view: a chain of `+`
/// with optional maps inside it is what made the Swift type checker give up
/// in #125, and that failure only appears on CI.
private func describeAccount(_ account: Fleet.HostHealth.Account) -> String {
    var parts: [String] = ["signed in as \(account.email ?? "unknown")"]
    if let plan = account.plan, !plan.isEmpty { parts.append(plan) }
    if let org = account.org, !org.isEmpty { parts.append(org) }
    return parts.joined(separator: " · ")
}

/// "forgotten · 3 days left", built a piece at a time rather than inline: a
/// chain of `+` over optionals is what made the Swift type checker give up in
/// #125, and that failure only shows up on CI.
private func describeBinned(_ item: Fleet.Binned) -> String {
    var parts: [String] = ["forgotten"]
    if item.title != nil { parts.append(item.name) }
    if let remaining = item.remaining { parts.append(remaining) }
    return parts.joined(separator: " · ")
}

/// "2 people · eli@example.com · max", or the fault when it is one.
///
/// ONE LINE OUT OF TWO THAT OVERLAPPED. The row used to print "signed in as
/// eli@example.com · max · eli@example.com's Organization" and, below it, "2
/// people can start sessions here" — the org repeating the address with a
/// suffix, and the count repeating the point in a full sentence.
///
/// The org is dropped when it is only the address again. Google and Anthropic
/// both name a personal organisation that way, so on a single-person account it
/// is guaranteed noise.
// NOT file-private: HostView renders the same sentence, and a second copy of
// it is how two screens start describing one fact differently.
func describeWhoCanStart(_ accounts: Int, account: Fleet.HostHealth.Account?) -> String {
    // THE ZERO CASE KEEPS ITS WORDS. It is the only real fault here, and
    // "Nobody" alone says what is wrong without saying what to do about it —
    // naming the Claude account is what makes it actionable. The other cases
    // are not faults and do not need a sentence.
    if accounts == 0 { return "Nobody has connected a Claude account here — sessions will not start" }
    var parts: [String] = ["\(accounts) \(accounts == 1 ? "person" : "people")"]
    if let email = account?.email, !email.isEmpty { parts.append(email) }
    if let plan = account?.plan, !plan.isEmpty { parts.append(plan) }
    if let org = account?.org, !org.isEmpty, !org.hasPrefix(account?.email ?? "\u{0}") {
        parts.append(org)
    }
    return parts.joined(separator: " · ")
}

/// "0223f94 · 1 commit behind · rolling", or as much of it as is known.
///
/// THREE LINES COLLAPSED INTO ONE, in the order somebody asks the questions:
/// what is it running, is that current, and what will it take next. The channel
/// had a line of its own on every row — eleven words repeated per machine,
/// saying the same thing on all of them.
private func describeRunning(_ host: Fleet.FleetHost) -> String {
    var parts: [String] = []
    if let head = host.health?.version?.head, !head.isEmpty { parts.append(head) }
    let behind = host.health?.updates?.appBehind ?? 0
    if behind > 0 {
        parts.append("\(behind) commit\(behind == 1 ? "" : "s") behind")
    } else if let waiting = host.health?.updates?.release?.available {
        parts.append("\(waiting) waiting")
    } else if host.health?.updates?.appUpdatePending == true {
        // A migratable checkout is offered a move onto packaged releases. It
        // counts no commits and names no release version, so both branches
        // above are silent on it and it read as current with an Apply button —
        // a row contradicting its own button.
        parts.append("update waiting")
    } else if host.health?.updates?.appStatusKnown == false {
        // "UP TO DATE" IS A CLAIM AND THIS IS WHERE IT WAS BEING INVENTED.
        // Every packaged box reports `appBehind: nil`, and a box that has never
        // reached GitHub reports `release.available: nil` — so the else below
        // fired on both, and a host nobody had successfully checked rendered as
        // current. Not knowing is its own state and it gets its own words.
        parts.append("update status unknown")
    } else if host.health?.version?.head != nil {
        parts.append("up to date")
    }
    if let channel = host.health?.channel, !channel.isEmpty {
        // Pinned is worth a word, because it is why the picker is missing.
        parts.append(host.health?.channelPinned == true ? "\(channel), set on the box" : channel)
    }
    return parts.isEmpty ? "version not reported" : parts.joined(separator: " · ")
}

/// "Nobody has connected a Claude account here", or how many people have.
///
/// A function rather than a nested ternary inside the view, and NOT a style
/// preference: the host row's body grew past what the Swift type checker will
/// spend on one expression, and it failed here — on code that had not changed
/// — because this was the expression it happened to run out of time on. The
/// error names a line nobody edited, which is the whole difficulty with it.
private func describeAccounts(_ accounts: Int) -> String {
    if accounts == 0 { return "Nobody has connected a Claude account here — sessions will not start" }
    if accounts == 1 { return "1 person can start sessions here" }
    return "\(accounts) people can start sessions here"
}

/// "running abc1234 · 3 commits behind", or "· up to date".
private func describeVersion(_ head: String, behind: Int) -> String {
    if behind <= 0 { return "running \(head) · up to date" }
    let plural = behind == 1 ? "commit" : "commits"
    return "running \(head) · \(behind) \(plural) behind"
}
