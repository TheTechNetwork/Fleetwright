import LocalAuthentication
import SwiftUI

/// One machine, everything about it, on a page of its own.
///
/// WHY THIS EXISTS. The fleet screen was two lists of the same machines — a
/// "Hosts" section carrying fingerprints and a revoke swipe, and a "Fleet"
/// section carrying health — so every box appeared twice, four hundred points
/// apart, and neither entry was complete. Below them sat four controls per card:
/// Check, Reboot, a full-width channel picker and a sign-in link, on every
/// machine, whether or not anything was wanted.
///
/// Putting the controls behind a tap made it worse rather than better. A row
/// that grows inside a List jumps: the height changes with no transition to
/// carry it, and what appears is the same wall arriving all at once. That was
/// the right instinct applied in the wrong place — the answer to "this card is
/// doing too much" is not "do it on demand", it is that a machine is a SUBJECT
/// and deserves a page.
///
/// So the list says what each machine is, and this says everything you can do
/// about one. A push animates itself, the controls get room instead of a squeeze
/// between two other cards, and the fingerprint finally sits next to the machine
/// it identifies rather than in a second list of names.
///
/// IT OWNS ITS OWN STATE, deliberately. SettingsView holds one busy flag, one
/// result string and one reboot ceremony shared across every host — which is
/// why the answer had to be tagged with a hostId to be rendered in the right
/// row. Here there is one host, so there is one of each, and none of it can be
/// about a different machine.
struct HostView: View {
    let settings: Settings
    let hostId: String
    /// What the fleet last reported when this page opened.
    ///
    /// Passed in rather than fetched: the list already has it, and a page that
    /// starts blank to ask a question it was handed the answer to is the fault
    /// this whole change is about. It seeds the state below and is not read
    /// again.
    let initialHealth: Fleet.HostHealth?
    let initialState: String?
    let initialReason: String?
    /// The membership record: fingerprint and whether it has been revoked.
    let enrolled: Fleet.Host?
    /// Called when this page changes something the list should know about.
    var onChange: () async -> Void = {}

    @Environment(\.dismiss) private var dismiss
    /// WHAT THIS MACHINE IS SAYING NOW, and the reason it is state rather than
    /// a parameter.
    ///
    /// These were `let`s captured when the page was pushed, so nothing on it
    /// could ever change: Check answered, the reply appeared in the box at the
    /// bottom, and the summary above went on saying what it said when the page
    /// opened. "Apply update" could not appear no matter what the check found,
    /// because the value it is gated on was a constant. The page had to be left
    /// and re-entered to show its own answer.
    @State private var health: Fleet.HostHealth?
    @State private var state: String?
    @State private var reason: String?
    @State private var busy = false
    @State private var result = ""
    @State private var channel: String?
    @State private var channelPinned = false
    /// Which image new sessions here run in, and whether that is the box's own
    /// environment talking. State for the same reason the channel is: the
    /// picker has to move when the host confirms, not fifteen seconds later.
    @State private var sandbox: Fleet.HostHealth.Sandbox?
    /// Every label this box carries, and the subset that can be taken off. Two
    /// lists rather than one flag per chip, because that is the shape the host
    /// sends and re-deriving it here is a second place to be wrong.
    @State private var labels: [String] = []
    @State private var setLabels: [String] = []
    /// Which service journals this box can read. Nil until a host says, and
    /// rendered as a sentence then rather than as three guesses.
    @State private var logs: [String]?
    /// The label being typed. Cleared when it lands, whether or not it worked —
    /// a field still holding a name that was refused looks like it can be
    /// pressed again.
    @State private var newLabel = ""
    @State private var rebootPin = ""
    /// Where in the ceremony this page is, so it can show one step rather than
    /// all of them.
    @State private var rebootStage: RebootStage = .idle
    private enum RebootStage { case idle, asking, confirming }
    /// Face ID was unavailable or declined, so the hostname is asked for the
    /// way the chat flow asks for it.
    @State private var needsTypedConfirmation = false
    /// What the machine said a reboot would cost, from its own step one.
    @State private var cost: Fleet.Reply.RebootCost?
    @State private var rebootConfirm = ""
    @State private var confirmingRevoke = false
    @State private var pin = ""

    private var fleet: Fleet { Fleet(settings: settings) }

    var body: some View {
        List {
            Section {
                summary
            }
            .listRowBackground(Design.Palette.card)

            Section {
                Button("Check for updates") { run { try await fleet.updates(host: hostId) } }
                if health?.updates?.appUpdatePending == true {
                    Button("Apply update") { run { try await fleet.update(host: hostId, restart: true) } }
                }
                if health?.updates?.systemPending == true {
                    Button("Apply system upgrade") { run { try await fleet.upgrade(host: hostId, apply: true) } }
                }
            } header: {
                sectionHead("Software")
            }
            .listRowBackground(Design.Palette.card)

            channelSection

            sandboxSection

            labelsSection

            Section {
                NavigationLink("Sign in to Claude") {
                    CredentialsView(settings: settings, host: hostId, onlyClaude: true)
                }
                if let fingerprint = enrolled?.fingerprint, !fingerprint.isEmpty {
                    // NEXT TO THE MACHINE IT IDENTIFIES. It lived in a separate
                    // list of names, which is the one place it cannot do its
                    // job: two machines claiming one name is exactly when you
                    // need to see which key is which, beside everything else
                    // that machine is saying.
                    LabeledContent("Key") {
                        Text(fingerprint)
                            .fleetType(.labelMono)
                            .foregroundStyle(Design.Palette.inkDim)
                            .textSelection(.enabled)
                    }
                }
            } header: {
                sectionHead("Identity")
            }
            .listRowBackground(Design.Palette.card)

            logsSection

            dangerSection

            if !result.isBlank {
                Section {
                    // THE BOX'S OWN WORDS, on an inner surface: this is quoted
                    // from somewhere else and should not look like something
                    // this screen said.
                    //
                    // `isBlank`, not `isEmpty`: a journal that answers with
                    // whitespace is a box saying nothing, and a card drawn
                    // around nothing is the empty rectangle this app shipped
                    // once already. See String.isBlank.
                    Text(result)
                        .fleetType(.labelMono)
                        .foregroundStyle(Design.Palette.ink)
                        .textSelection(.enabled)
                }
                .listRowBackground(Design.Palette.inner)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .navigationTitle(hostId)
        .navigationBarTitleDisplayMode(.inline)
        .disabled(busy)
        .task {
            health = initialHealth
            state = initialState
            reason = initialReason
            channel = initialHealth?.channel
            channelPinned = initialHealth?.channelPinned ?? false
            sandbox = initialHealth?.sandbox
            labels = initialHealth?.labels ?? []
            setLabels = initialHealth?.setLabels ?? []
            logs = initialHealth?.logs
        }
    }

    // MARK: - the parts
    //
    // Split up because this screen's body grew past what the Swift type checker
    // will spend on one expression — the failure names a line nobody edited, and
    // it only happens on CI, which is the only machine that builds for a device.

    @ViewBuilder private var summary: some View {
        VStack(alignment: .leading, spacing: Design.Space.hair) {
            HStack(alignment: .firstTextBaseline) {
                Text(state ?? "unknown")
                    .fleetType(.bodyStrong)
                    .foregroundStyle(state == "healthy" ? Design.Palette.ok : Design.Palette.attention)
                Spacer(minLength: 0)
            }
            // Only when it is news. "reporting normally" under the word
            // "healthy" is the same fact twice.
            if let reason, !reason.isEmpty, state != "healthy" {
                Text(reason).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
            }
            if let accounts = health?.claudeAccounts {
                Text(describeWhoCanStart(accounts, account: health?.account))
                    .fleetType(.label)
                    .foregroundStyle(accounts == 0 ? Design.Palette.attention : Design.Palette.inkDim)
            }
            if let version = health?.version?.head, !version.isEmpty {
                Text(version).fleetType(.labelMono).foregroundStyle(Design.Palette.inkDim)
            }
        }
        .padding(.vertical, Design.Space.hair)
    }

    @ViewBuilder private var channelSection: some View {
        Section {
            if channelPinned {
                // Said as an answer rather than offered as a choice, because
                // the box's environment is forcing it and a picker that refuses
                // is worse than a sentence.
                LabeledContent("Channel") {
                    Text("\(channel ?? "stable"), set on the box").fleetType(.label)
                }
            } else if let now = channel {
                Picker("Channel", selection: Binding(
                    get: { now },
                    set: { pick in run { try await fleet.channel(host: hostId, to: pick) } }
                )) {
                    Text("Stable").tag("stable")
                    Text("Rolling").tag("rolling")
                }
                .pickerStyle(.segmented)
            }
        } header: {
            sectionHead("Releases")
        } footer: {
            Text("Stable takes published releases. Rolling takes the newest build of main, on every merge.")
        }
        .listRowBackground(Design.Palette.card)
    }

    /// WHICH IMAGE A SESSION HERE GETS. Two states, so a segmented control —
    /// the same shape as the channel above it, because it is the same kind of
    /// question and answering it differently would make two identical decisions
    /// look like different ones.
    @ViewBuilder private var sandboxSection: some View {
        Section {
            if let now = sandbox {
                if now.pinned == true || (now.variant != "minimal" && now.variant != "browser") {
                    // AN ANSWER, NOT A CHOICE. Either the box's environment
                    // names the image, or it is on one that is neither variant —
                    // and in both cases a picker would have to show a third
                    // segment for a state it cannot switch to, or silently
                    // round the box to one of the two it is not on.
                    LabeledContent("Image") {
                        Text(now.pinned == true ? "set on the box" : "not one of ours")
                            .fleetType(.label)
                    }
                    if let image = now.image, !image.isEmpty {
                        Text(image)
                            .fleetType(.labelMono)
                            .foregroundStyle(Design.Palette.inkDim)
                            .textSelection(.enabled)
                    }
                } else {
                    Picker("Image", selection: Binding(
                        get: { now.variant ?? "minimal" },
                        set: { pick in run { try await fleet.sandbox(host: hostId, to: pick) } }
                    )) {
                        Text("No browser").tag("minimal")
                        Text("Browser").tag("browser")
                    }
                    .pickerStyle(.segmented)
                }
            } else {
                // NIL IS CANNOT TELL. A host older than this verb sends nothing,
                // and a control defaulted to "No browser" would tell somebody
                // their box has no Chromium when it might.
                Text("This host has not said which image it runs sessions in.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
        } header: {
            sectionHead("Sessions")
        } footer: {
            Text("The browser image is the same one with Chromium in it, for a session that has to look at a page it built. Running sessions keep the image they started in.")
        }
        .listRowBackground(Design.Palette.card)
    }

    /// WHAT WORK AIMED AT PART OF THE FLEET WILL FIND HERE.
    ///
    /// Remove appears on exactly the labels it works for. `arm64` and `gpu`
    /// look identical in the list the host sends, and the host refuses to drop
    /// one of them — so a swipe on every row would be a control that does
    /// nothing on half of them, discoverable only by trying it.
    @ViewBuilder private var labelsSection: some View {
        Section {
            if labels.isEmpty {
                Text("No labels, so only work that names this host can land here.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
            ForEach(labels, id: \.self) { label in
                HStack {
                    Text(label).fleetType(.label).foregroundStyle(Design.Palette.ink)
                    Spacer(minLength: 0)
                    if !setLabels.contains(label) {
                        // WHY IT CANNOT COME OFF, next to it. Without this the
                        // only difference between the two kinds is a missing
                        // swipe, which reads as a bug.
                        Text("from the machine")
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                    }
                }
                .swipeActions(edge: .trailing) {
                    if setLabels.contains(label) {
                        Button("Remove", role: .destructive) {
                            run { try await fleet.labels(host: hostId, remove: label) }
                        }
                    }
                }
            }
            HStack {
                TextField("Add a label", text: $newLabel)
                    // A LABEL IS COMPARED FOR EQUALITY by the scheduler, so iOS
                    // capitalising it would store one that can never be matched
                    // — which looks exactly like tags being broken.
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .fleetType(.label)
                    .onSubmit(addLabel)
                Button("Add", action: addLabel)
                    .disabled(newLabel.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        } header: {
            sectionHead("Labels")
        } footer: {
            Text("Labels are how work is aimed: a session asked for with a tag lands on a host carrying it. The ones the machine works out about itself cannot be removed.")
        }
        .listRowBackground(Design.Palette.card)
    }

    /// THE JOURNAL, FROM THE PHONE. This is the half of "sign-in status and
    /// logs on the app" that stayed unbuilt for a week while the roadmap said
    /// done: the client call existed on both phones and no screen made it.
    ///
    /// One button per journal THIS box can read, which the host says in its
    /// health frame. A box that is a host and not a coordinator gets two
    /// buttons, not three with one that answers "no log entries" — that
    /// answer reads as a broken service rather than an absent one, and the
    /// chat surface has filtered the same way since the verb shipped.
    ///
    /// The answer lands in the box at the bottom like every other reply here:
    /// it is the host's own words, and forty lines of journal is what a
    /// person reads on a phone at night to find out why something stopped.
    @ViewBuilder private var logsSection: some View {
        Section {
            if let logs {
                if logs.isEmpty {
                    Text("None of the services this app knows are installed here.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }
                ForEach(logs, id: \.self) { source in
                    Button(logName(source)) { run { try await fleet.logs(host: hostId, service: source) } }
                }
            } else {
                // NIL IS CANNOT TELL. A host older than this field still
                // answers the verb, but this screen has not been told which of
                // the three journals exist here, and three buttons where one
                // is dead is the thing the field was added to prevent.
                Text("This host has not said which logs it can read.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
        } header: {
            sectionHead("Logs")
        } footer: {
            Text("The last forty lines of a service's journal. A session's own output is under the session, as Output.")
        }
        .listRowBackground(Design.Palette.card)
    }

    /// What a journal is called on a button. The host's own words for each,
    /// from LOG_SOURCES in logs.js, so a person who has read the CLI's answer
    /// recognises the same service here.
    private func logName(_ source: String) -> String {
        switch source {
        case "hub": return "The session manager"
        case "coordinator": return "The fleet coordinator"
        case "sidecar": return "This box as a fleet host"
        default: return source
        }
    }

    private func addLabel() {
        let wanted = newLabel.trimmingCharacters(in: .whitespaces)
        guard !wanted.isEmpty else { return }
        // CLEARED THE MOMENT IT LEAVES, whether or not it works. A field still
        // holding a name that was refused looks like it can be pressed again,
        // and the reason it was refused is in the box at the bottom.
        newLabel = ""
        run { try await fleet.labels(host: hostId, add: wanted) }
    }

    @ViewBuilder private var dangerSection: some View {
        Section {
            // ONE STEP AT A TIME, AND ONLY THE ONE YOU ARE ON.
            //
            // This showed all three at once — a Reboot button, a PIN field, a
            // "type the hostname" field and a second Reboot button, every one of
            // them visible and most of them inert — while the box's own reply at
            // the bottom of the page said "Step 2 of 3". Four controls for a
            // sequence, with nothing saying which one was live.
            //
            // The ceremony itself is right and stays: three confirmations that
            // are different IN KIND, because tapping yes three times is one
            // decision made three times. What changes is that the screen shows
            // one of them at a time, and that the third is asked in the way a
            // phone can ask it.
            switch rebootStage {
            case .idle:
                Button("Reboot", role: .destructive) {
                    rebootStage = .asking
                    Task { await askToReboot() }
                }
            case .asking:
                Text("Asking \(hostId) for a PIN…")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            case .confirming:
                // WHAT IT WILL COST, said before it is asked for. The count is
                // the reason there is a pin at all, so it goes above the field
                // rather than in a paragraph at the bottom of the page.
                Text(cost?.sessions == 1
                     ? "1 session is running on \(hostId). It will not survive."
                     : "\(cost?.sessions ?? 0) sessions are running on \(hostId). They will not survive.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.attention)
                // THE PIN COMES FROM THE BOX, and that is what it is for: it
                // proves this confirmation followed a question THAT machine
                // answered, within two minutes, and it cannot be typed in
                // advance or replayed.
                TextField("PIN from \(hostId)", text: $rebootPin)
                    .fleetType(.labelMono)
                    .keyboardType(.numberPad)
                if needsTypedConfirmation {
                    TextField("Type \(hostId) to confirm", text: $rebootConfirm)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    Button("Reboot \(hostId)", role: .destructive) {
                        Task { await sendReboot(confirm: rebootConfirm) }
                    }
                    .disabled(rebootConfirm != hostId || rebootPin.isEmpty)
                } else {
                    Button("Confirm reboot", role: .destructive) {
                        Task { await confirmReboot() }
                    }
                    .disabled(rebootPin.isEmpty)
                }
                Button("Cancel") {
                    rebootStage = .idle
                    rebootPin = ""
                }
            }
            if enrolled?.isRevoked == false {
                Button("Revoke this host", role: .destructive) { confirmingRevoke = true }
            }
            if !pin.isEmpty {
                LabeledContent("Pin") { Text(pin).fleetType(.labelMono).textSelection(.enabled) }
            }
            Button(enrolled?.isRevoked == true ? "Readmit" : "Replace key") {
                Task {
                    busy = true
                    defer { busy = false }
                    do { pin = try await fleet.mintHostPin(hostId: hostId, readmit: enrolled?.isRevoked == true) }
                    catch { result = error.localizedDescription }
                }
            }
        } header: {
            sectionHead("This machine")
        }
        .listRowBackground(Design.Palette.card)
        .alert("Revoke \(hostId)?", isPresented: $confirmingRevoke) {
            Button("Cancel", role: .cancel) {}
            Button("Revoke", role: .destructive) {
                Task {
                    busy = true
                    defer { busy = false }
                    // The refusal reaches the screen. Discarding it is how a 403
                    // reads as "the host came back".
                    do { result = try await fleet.revokeHost(hostId).text ?? "" }
                    catch { result = error.localizedDescription }
                    await onChange()
                    dismiss()
                }
            }
        } message: {
            Text("It is disconnected immediately, and its sessions keep running without it. "
                 + "Getting it back means a new pin, typed on that box.")
        }
    }

    /// Step one: ask the machine what a reboot would cost.
    ///
    /// AN EMPTY HOST GOES STRAIGHT TO THE FINGERPRINT. Nothing is lost — the
    /// box goes away and comes back — so the host issues no pin, and the one
    /// question left is whether the person holding the phone meant it. Three
    /// confirmations for that is a ritual people learn to rush, and rushing is
    /// the habit they bring to the reboot that DOES cost something.
    private func askToReboot() async {
        busy = true
        do {
            let reply = try await fleet.reboot(host: hostId)
            result = reply.text ?? ""
            cost = reply.reboot
            busy = false
            // THE HOST DECIDES, not the app. It knows what is running; the app
            // asks for as much as the host says the loss is worth.
            if reply.reboot?.pinRequired == false {
                await confirmReboot()
            } else {
                rebootStage = .confirming
            }
        } catch {
            result = error.localizedDescription
            busy = false
            rebootStage = .idle
        }
    }

    /// Step three, asked in the way a phone can ask it.
    ///
    /// THE CHAT CEREMONY TYPES THE HOSTNAME, and reboot.js says exactly why:
    /// it is "the step that makes wrong box impossible, which is the mistake
    /// actually worth preventing". That reasoning is about a command line,
    /// where `/reboot` could mean any machine in the fleet.
    ///
    /// ON THIS SCREEN THE WRONG BOX IS ALREADY IMPOSSIBLE. You navigated to
    /// this machine, its name is in the title bar, the PIN came from it, and
    /// the confirmation names it. What retyping a name visible one line above
    /// proves is that somebody can copy — not that they meant it.
    ///
    /// So the question the phone should ask is the one it is uniquely good at:
    /// is the person holding it the person who owns it. Face ID answers that,
    /// instantly, and cannot be produced by a pocket.
    ///
    /// THE PIN IS UNTOUCHED. It is the half that carries the security property
    /// — the box issued it, a coordinator cannot mint it, it expires and cannot
    /// be replayed — and no amount of biometrics replaces it.
    ///
    /// AND IT FALLS BACK RATHER THAN LOCKING SOMEBODY OUT. A device with no
    /// biometrics, a failed scan, a person wearing a mask: the hostname field
    /// comes back, because "we could not identify you" must not mean "you
    /// cannot reboot your own machine".
    private func confirmReboot() async {
        let context = LAContext()
        context.localizedFallbackTitle = "Type the hostname instead"
        var problem: NSError?
        let canAsk = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &problem)
        if canAsk {
            do {
                let ok = try await context.evaluatePolicy(
                    .deviceOwnerAuthentication,
                    localizedReason: "Reboot \(hostId). Every session running on it will end.",
                )
                if !ok { return }
            } catch {
                // Cancelled, or no match. Not an error worth a red box: the
                // person declined, and declining is a valid answer to
                // "did you mean this".
                needsTypedConfirmation = true
                return
            }
        } else {
            needsTypedConfirmation = true
            return
        }
        await sendReboot(confirm: hostId)
    }

    /// The reboot itself, once something has vouched for the person.
    private func sendReboot(confirm: String) async {
        busy = true
        defer { busy = false }
        do {
            result = try await fleet.reboot(host: hostId, pin: rebootPin, confirm: confirm).text ?? ""
        } catch {
            result = error.localizedDescription
        }
        rebootStage = .idle
        rebootPin = ""
        rebootConfirm = ""
        needsTypedConfirmation = false
        await reload()
        await onChange()
    }

    /// Re-read this host from the fleet snapshot.
    ///
    /// One request, and it keeps what it had if the request fails: a page that
    /// blanks because the network blinked is the fault the list was just fixed
    /// for.
    private func reload() async {
        guard let hosts = try? await fleet.fleetHosts() else { return }
        guard let mine = hosts.first(where: { $0.hostId == hostId }) else { return }
        health = mine.health
        state = mine.state
        reason = mine.reason
        if let now = mine.health?.channel { channel = now }
        channelPinned = mine.health?.channelPinned ?? channelPinned
        // KEPT IF THE SNAPSHOT DOES NOT CARRY IT, rather than cleared. A host
        // that has not sent a frame since this page opened, or one older than
        // these verbs, would otherwise blank a picker and a list the person is
        // looking at — the same fault the guards above exist for.
        if let now = mine.health?.sandbox { sandbox = now }
        if let now = mine.health?.labels { labels = now }
        if let now = mine.health?.setLabels { setLabels = now }
        if let now = mine.health?.logs { logs = now }
    }

    private func sectionHead(_ text: String) -> some View {
        Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
    }

    /// One action, one place the busy flag and the answer are set.
    private func run(_ work: @escaping () async throws -> Fleet.Reply) {
        Task {
            busy = true
            defer { busy = false }
            do {
                let reply = try await work()
                result = reply.text ?? ""
                // BELIEVE THE REPLY. The host pushes a health frame after a
                // mutating verb, but the list's own refresh races it, and losing
                // that race shows the value somebody just changed away from.
                if let now = reply.channel { channel = now; channelPinned = reply.channelPinned ?? false }
                // AND THE ANSWER LANDS ON THE PAGE THAT ASKED FOR IT. A check
                // that reports an update in a text box while the summary above
                // it still says "update status unknown" is a screen arguing
                // with itself — and the button that would act on it is gated on
                // the half that did not move.
                if let w = reply.waiting { health = health?.withUpdates(w) }
                if let now = reply.sandbox { sandbox = now; health = health?.withSandbox(now) }
                // BOTH LISTS MOVE TOGETHER. The reply says which labels are SET
                // here; the full list is that plus everything the machine
                // derives, which is what this page already has minus the ones
                // it knows are removable. Recomputing it keeps a chip from
                // lingering after a Remove, or from missing after an Add, for
                // the fifteen seconds until the next health frame.
                if let set = reply.setLabels {
                    let derived = labels.filter { !setLabels.contains($0) }
                    labels = Array(Set(derived).union(set)).sorted()
                    setLabels = set.sorted()
                    health = health?.withLabels(all: labels, set: setLabels)
                }
            } catch {
                result = error.localizedDescription
            }
            // EVERYTHING ELSE THIS MACHINE SAYS, once the action has landed.
            // The reply is authoritative about updates and silent about the
            // rest — accounts, credential, version, whether it is still
            // healthy — so the page re-reads itself rather than waiting to be
            // left and re-entered.
            await reload()
            await onChange()
        }
    }
}
