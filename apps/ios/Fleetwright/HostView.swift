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

    /// We asked it to reboot, and it has not said anything since.
    ///
    /// TIME-BOUNDED, because "rebooting" is a claim with a shelf life: a box
    /// that has not come back in five minutes is not still rebooting, it is a
    /// box that did not come back — and saying otherwise is the reassuring kind
    /// of wrong this project spends its time removing.
    private var rebooting: Bool {
        guard let at = rebootedAt else { return false }
        if Date().timeIntervalSince(at) > 300 { return false }
        return state != "healthy"
    }

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

            dangerSection

            // THE BOX'S OWN WORDS, WHEN THEY ADD SOMETHING. The reboot reply is
            // already said at the top, in the summary, in a sentence written
            // for a person — repeating it in a monospace transcript at the
            // bottom of the page is the same fact twice, and the copy at the
            // bottom is the one nobody scrolls to.
            if !result.isEmpty && !rebooting {
                Section {
                    // THE BOX'S OWN WORDS, on an inner surface: this is quoted
                    // from somewhere else and should not look like something
                    // this screen said.
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
                Text(rebooting ? "rebooting" : (state ?? "unknown"))
                    .fleetType(.bodyStrong)
                    .foregroundStyle(rebooting ? Design.Palette.active
                                     : state == "healthy" ? Design.Palette.ok : Design.Palette.attention)
                Spacer(minLength: 0)
            }
            if rebooting {
                // THE SENTENCE THE HOST SENT, where a person will read it. It
                // was in a monospace box at the bottom of a long page, under
                // the fold, next to a card that said the machine was offline.
                Text("Asked to reboot. It will go quiet for a minute or two, then dial back in.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
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

    /// This machine is on its way down because we asked it to.
    ///
    /// A HOST YOU JUST REBOOTED IS NOT A HOST THAT WENT OFFLINE. The page said
    ///
    ///   offline
    ///   socket closed: 1000 shutting down
    ///
    /// in the attention colour, seconds after somebody pressed Reboot — every
    /// word true, the whole of it reading as a fault, on a screen where the
    /// person had caused it deliberately. The coordinator's half of that is
    /// fixed in describeClose; this is the half only the app can know, because
    /// only the app knows the reboot was asked for FROM HERE.
    ///
    /// It clears when the machine says something again — reload() overwrites
    /// the state, and a box that has dialled back in is no longer rebooting.
    @State private var rebootedAt: Date?

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
        // ONLY IF IT WORKED. A refused reboot is not a rebooting machine, and
        // saying so would hide the refusal behind a reassuring sentence.
        if result.localizedCaseInsensitiveContains("rebooting") { rebootedAt = Date() }
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
