import SwiftUI

/// Add a hypervisor: a Xen Orchestra pool, onboarded by one machine already in
/// the fleet. docs/hypervisors.md, "Onboarding: nothing made by hand".
///
/// WHAT A PERSON SUPPLIES is an address and an admin sign-in, once. The
/// machine does the rest: a limited `fleetwright` user, its resource set, a
/// token for it, and the token kept on that machine alone. What this screen
/// is for is getting the sign-in to that machine and nowhere else, which is
/// four steps, each the reason for the next:
///
///   1. `xoprobe`: every permanent machine tries the address, and the person
///      picks one that reached it over HTTPS and sees the certificate it saw,
///      because the sign-in is only ever sent to a server that answers with
///      that one certificate (the pin). A machine that reached it over plain
///      HTTP is offered too, after those: there is nothing to pin, so before
///      anything is typed the person is told that the password and the token
///      would cross that network unencrypted, and Begin waits until they have
///      said to go on anyway.
///   2. `xosetup begin`, on that machine: it makes a key for this job alone
///      and signs it with its enrolment key. THE KEY IS CHECKED BEFORE
///      ANYTHING IS SEALED TO IT (XOSetupKey): a coordinator that wanted the
///      password would put its own key here, and it cannot sign it as the
///      machine. If this phone's vault has approved that machine, the
///      fingerprint is compared to the one it approved and nothing is asked;
///      if not, the person compares it with what `fleetwright-sidecar
///      identity` prints on the box, exactly as they would to approve it.
///   3. `xosetup run`: the sign-in sealed to that key (Seal, the construction
///      the Claude deposit and the GitHub sign-in use), so the coordinator
///      relays ciphertext it cannot read. The password leaves this screen's
///      state the moment it is sealed.
///   4. Progress, polled while this screen is open, and on the Lock Screen
///      and the Dynamic Island when it is not (XOSetupActivities).
///
/// A `Form`, restyled in place like Add a machine (docs/design-system.md §4):
/// it is a run of fields and buttons, and the platform's list is a good list
/// of controls. The one thing on it that moves is the step line, because a
/// step changing is news (MOTION 2); a crossfade, so Reduce Motion is honoured
/// without a second code path. No haptic: the design gives those to Stop,
/// Resume and an answer, and a setup that ends while the phone is in a pocket
/// already arrives as a notification.
///
/// NOTHING HERE IS KEPT. No UserDefaults, no keychain, no outbox: every
/// intent carries an idempotency key so a send that could not reach the fleet
/// is refused rather than held on disk (Fleet.runSetup).
struct AddHypervisorView: View {
    let settings: Settings
    @Environment(\.dismiss) private var dismiss

    @State private var address = ""
    @State private var probing = false
    /// What every machine found, or nil until asked. Nil draws nothing; an
    /// empty answer and a failed one each say what they are.
    @State private var probes: [Fleet.Probe]?
    @State private var probeText = ""
    @State private var chosen: Fleet.Probe?
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var result = ""
    @State private var failed = false
    /// What `begin` handed back, held only until the key has been vouched for.
    @State private var begun: Begun?
    /// The fingerprint the person is being asked to compare, when the vault
    /// has not vouched for it.
    @State private var toCompare: String?
    /// The job that is running or ran, and the machine running it.
    @State private var job: String?
    @State private var hostId = ""
    @State private var progress: Fleet.SetupState?
    /// The person read what is wrong with a certificate that does not check
    /// out, and said they trust it anyway. Reset whenever what it was said
    /// about changes: the address, the machine, or the probe.
    @State private var acknowledged = false
    /// The person read that there is no HTTPS at this address, what that
    /// means for the password and the token, and said to send it anyway.
    /// Reset on the same changes as `acknowledged`, for the same reason.
    @State private var plainAccepted = false
    /// Cancel was pressed and the machine said it would stop after the step
    /// it is on: the button is not offered twice.
    @State private var cancelRequested = false

    private struct Begun {
        let job: String
        let hostId: String
        let address: String
        let key: String
        let fingerprint: String
    }

    private var fleet: Fleet { Fleet(settings: settings) }
    private var trimmedAddress: String { address.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// The machines setup could run from with a certificate pinned: reached
    /// it, over HTTPS, and saw one.
    private var reached: [Fleet.Probe] { (probes ?? []).filter { $0.reachable == true && $0.tls == true && $0.cert != nil } }
    /// The machines that reached it over plain HTTP. Offered after the ones
    /// above, because the order is the recommendation: a certificate when
    /// there is one, and the warning card otherwise.
    private var plainReached: [Fleet.Probe] { (probes ?? []).filter { $0.plainHTTP } }
    private var offered: [Fleet.Probe] { reached + plainReached }
    /// Still going, so the screen keeps asking and offers Cancel.
    private var running: Bool { job != nil && XOSetupWords.isLive(progress?.state ?? "running") }
    private var liveState: XOSetupAttributes.ContentState? { XOSetupActivities.contentState(progress) }

    var body: some View {
        Form {
            whereSection
            if probes != nil { machinesSection }
            if let chosen, job == nil { signInSection(chosen) }
            if let job { progressSection(job) }
            if !result.isBlank {
                Section {
                    Text(result)
                        .fleetType(.label)
                        .foregroundStyle(failed ? Design.Palette.bad : Design.Palette.ink)
                        .textSelection(.enabled)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Add a hypervisor")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: job) { await follow() }
    }

    // MARK: Where

    private var whereSection: some View {
        Section {
            TextField("Address of Xen Orchestra", text: $address)
                .textContentType(.URL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .disabled(job != nil || busy)
                // WHAT WAS FOUND WAS FOUND FOR AN ADDRESS. Edited, the old
                // machines, certificate and acknowledgement would stand on
                // screen for a different one, and `begin` would pair the new
                // address with the old pin.
                .onChange(of: address) { _, _ in
                    guard job == nil else { return }
                    probes = nil
                    chosen = nil
                    probeText = ""
                    acknowledged = false
                    plainAccepted = false
                    toCompare = nil
                }
            Button(probing ? "Asking your machines…" : "Find a machine that can reach it") { Task { await probe() } }
                .disabled(probing || busy || job != nil || !XOSetupKey.isAddress(trimmedAddress))
            if !probeText.isBlank {
                Text(probeText)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
        } header: {
            sectionHead("Where")
        } footer: {
            Text("A host name or address, with a port if it is not 443, and no https:// in front. "
                 + "The setup runs from one of your permanent machines, so one of them has to be on a network that reaches it.")
        }
    }

    // MARK: Which machine

    private var machinesSection: some View {
        Section {
            if offered.isEmpty {
                // SAID PLAINLY, WITH WHAT TO CHECK. An empty list under a
                // heading is a screen that has stopped talking.
                Text(nobodyReached)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
            } else {
                ForEach(offered) { probe in
                    Button { choose(probe) } label: { probeRow(probe) }
                        .disabled(job != nil)
                }
            }
        } header: {
            sectionHead("Which machine runs it")
        }
    }

    private func probeRow(_ probe: Fleet.Probe) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Design.Space.insideTight) {
            VStack(alignment: .leading, spacing: Design.Space.hair) {
                Text(probe.hostId)
                    .fleetType(.bodyStrong)
                    .foregroundStyle(Design.Palette.ink)
                Text(describe(probe))
                    .fleetType(.label)
                    .foregroundStyle(probe.xo == false ? Design.Palette.attention : Design.Palette.inkDim)
            }
            Spacer(minLength: 0)
            if chosen?.hostId == probe.hostId {
                Image(systemName: "checkmark")
                    .foregroundStyle(Design.Palette.accent)
                    .accessibilityLabel("Chosen")
            }
        }
        .contentShape(Rectangle())
        .frame(minHeight: 44)
    }

    /// What this machine found, in its own three answers, over HTTPS or over
    /// plain HTTP. `xo` nil is cannot tell and is said as that, never rounded
    /// to yes or no (C-5). The same words as Android (XoSetup.describe).
    private func describe(_ probe: Fleet.Probe) -> String {
        if probe.plainHTTP {
            if probe.xo == true { return "Reached Xen Orchestra over plain HTTP" }
            if probe.xo == false { return "Reached something over plain HTTP, and it does not look like Xen Orchestra" }
            return "Reached something over plain HTTP; cannot tell whether it is Xen Orchestra"
        }
        if probe.xo == true { return "Reached Xen Orchestra" + (probe.version.map { " \($0)" } ?? "") }
        if probe.xo == false { return "Reached something there over HTTPS, and it does not look like Xen Orchestra" }
        return "Reached something there over HTTPS; cannot tell whether it is Xen Orchestra"
    }

    /// Nothing is offered. Plain HTTP is offered now, so the only machine
    /// that reached the address and is not listed is one whose answer said
    /// neither HTTPS nor plain, which is said as that and not as "nobody".
    private var nobodyReached: String {
        let all = probes ?? []
        if all.isEmpty {
            return "No permanent machine is connected, so nothing could try \(trimmedAddress). A machine has to be in the fleet to run the setup."
        }
        if let odd = all.first(where: { $0.reachable == true }) {
            return "\(odd.hostId) reached \(trimmedAddress), but did not say whether it was over HTTPS or show a certificate, "
                + "so setup cannot run from it. Update that machine, then ask again."
        }
        return "No machine reached \(trimmedAddress). Check the address and the port, that Xen Orchestra is up, and that one "
            + "of these is on a network that can reach it: \(all.map(\.hostId).sorted().joined(separator: ", "))."
    }

    // MARK: Sign in

    private func signInSection(_ chosen: Fleet.Probe) -> some View {
        Section {
            if let cert = chosen.cert {
                if chosen.certificateTrusted {
                    certificateChecksOut(chosen)
                } else {
                    certificateQuestion(chosen)
                }
                Text("SHA-256, as \(chosen.hostId) saw it. The sign-in goes only to a server that answers with this certificate.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                Text(XOSetupKey.grouped(cert))
                    .fleetType(.labelMono)
                    .foregroundStyle(Design.Palette.ink)
                    .textSelection(.enabled)
                if !chosen.certificateTrusted {
                    Toggle(isOn: $acknowledged) {
                        Text("I checked this certificate and trust it")
                            .fleetType(.bodyStrong)
                            .foregroundStyle(Design.Palette.ink)
                    }
                    .tint(Design.Palette.accent)
                    .frame(minHeight: 44)
                    .disabled(busy || toCompare != nil)
                }
            } else if chosen.plainHTTP {
                plainQuestion(chosen)
                Toggle(isOn: $plainAccepted) {
                    Text("Send it without HTTPS anyway")
                        .fleetType(.bodyStrong)
                        .foregroundStyle(Design.Palette.ink)
                }
                .tint(Design.Palette.accent)
                .frame(minHeight: 44)
                .disabled(busy || toCompare != nil)
            }
            TextField("Xen Orchestra admin email", text: $email)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .disabled(busy || toCompare != nil)
            SecureField("Its password", text: $password)
                .textContentType(.password)
                .disabled(busy || toCompare != nil)
            if let toCompare {
                compareRows(toCompare)
            } else {
                Button(busy ? "Beginning…" : "Begin on \(chosen.hostId)") { Task { await begin(chosen) } }
                    .disabled(busy || email.isBlank || password.isEmpty || !accepted(chosen))
            }
        } header: {
            sectionHead("Sign in to Xen Orchestra")
        } footer: {
            Text("Used once, by \(chosen.hostId), to make a limited fleetwright user and its token. It is sealed on this phone to a "
                 + "key only that machine holds, so the fleet relays it and cannot read it, and neither this phone nor the fleet keeps it.")
        }
    }

    /// One calm line: the machine checked the certificate and found nothing
    /// wrong, so nothing is asked.
    private func certificateChecksOut(_ probe: Fleet.Probe) -> some View {
        let c = probe.certificate
        var line = "Its certificate checks out"
        if let subject = c?.subject, !subject.isBlank { line += ": issued to \(subject)" }
        if let issuer = c?.issuer, !issuer.isBlank { line += " by \(issuer)" }
        if let until = CertificateWords.date(c?.notAfter) { line += ", valid until \(until)" }
        return Text(line + ".")
            .fleetType(.label)
            .foregroundStyle(Design.Palette.ink)
    }

    /// THE QUESTION THIS SCREEN ASKS. A certificate nothing vouches for is
    /// what every Xen Orchestra built from sources serves, so this is the
    /// common case and not an alarm; but the person is the only one who can
    /// say it is theirs, so they are shown everything wrong with it and what
    /// it says about itself before they are asked. The one card on the
    /// screen that spends emphasis, because it is the one asking.
    @ViewBuilder private func certificateQuestion(_ probe: Fleet.Probe) -> some View {
        VStack(alignment: .leading, spacing: Design.Space.insideTight) {
            Text("This certificate does not check out")
                .fleetType(.bodyStrong)
                .foregroundStyle(Design.Palette.attention)
            ForEach(CertificateWords.problems(probe.certificate, address: trimmedAddress), id: \.self) { line in
                Text(line)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
            }
            if let c = probe.certificate {
                detail("Issued to", c.subject)
                detail("Issued by", c.issuer)
                detail("Valid", CertificateWords.validity(c))
                detail("Names", (c.names ?? []).isEmpty ? nil : (c.names ?? []).joined(separator: ", "))
            }
        }
        .padding(.vertical, Design.Space.hair)
    }

    /// THE OTHER QUESTION, for an address with no HTTPS at all. The same
    /// emphasis as the certificate question and never both at once, since a
    /// machine either saw a certificate or did not. Said in the concrete: the
    /// two things that would travel in the clear, between which two machines,
    /// and the lines of xo-install.cfg that would make it HTTPS instead, so
    /// the person is choosing between two things they can picture. The same
    /// words as Android.
    @ViewBuilder private func plainQuestion(_ probe: Fleet.Probe) -> some View {
        VStack(alignment: .leading, spacing: Design.Space.insideTight) {
            Text("This Xen Orchestra answers without HTTPS")
                .fleetType(.bodyStrong)
                .foregroundStyle(Design.Palette.attention)
            Text("The admin password you type, and the token the fleet keeps afterwards, would cross the network between "
                 + "\(probe.hostId) and \(trimmedAddress) unencrypted. Anything on that network could read them.")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.ink)
            Text("To give it HTTPS instead: in the installer's xo-install.cfg, set PORT=\"443\", PATH_TO_HTTPS_CERT, "
                 + "PATH_TO_HTTPS_KEY and AUTOCERT=\"true\", then run it again.")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.ink)
        }
        .padding(.vertical, Design.Space.hair)
    }

    /// Whatever this machine's probe asks has been answered: nothing, for a
    /// certificate that checks out; the person's word for one that does not;
    /// and their word again for no certificate at all. False for a probe
    /// that is neither, which is never offered and so never asked.
    private func accepted(_ probe: Fleet.Probe) -> Bool {
        if probe.cert != nil { return probe.certificateTrusted || acknowledged }
        return probe.plainHTTP && plainAccepted
    }

    @ViewBuilder private func detail(_ label: String, _ value: String?) -> some View {
        if let value, !value.isBlank {
            VStack(alignment: .leading, spacing: Design.Space.hair) {
                Text(label)
                    .fleetType(.micro)
                    .foregroundStyle(Design.Palette.inkDim)
                Text(value)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
                    .textSelection(.enabled)
            }
        }
    }

    /// The person vouches for the key, the way they would approve the box
    /// for their vault: by comparing the fingerprint with the one the box
    /// prints. "They match" is the claim being made, in those words.
    @ViewBuilder private func compareRows(_ fingerprint: String) -> some View {
        Text("This phone has not approved \(begun?.hostId ?? "that machine") before. On it, fleetwright-sidecar identity "
             + "prints its fingerprint; send the sign-in only if it is this one.")
            .fleetType(.label)
            .foregroundStyle(Design.Palette.ink)
        Text(fingerprint)
            .fleetType(.labelMono)
            .foregroundStyle(Design.Palette.ink)
            .textSelection(.enabled)
        Button(busy ? "Sending…" : "They match") { Task { await send() } }
            .disabled(busy)
        Button("Cancel", role: .cancel) { Task { await abandon() } }
            .disabled(busy)
    }

    // MARK: Progress

    private func progressSection(_ job: String) -> some View {
        Section {
            VStack(alignment: .leading, spacing: Design.Space.insideTight) {
                Text(liveState.map(XOSetupWords.headline) ?? "Starting on \(hostId)")
                    .fleetType(.bodyStrong)
                    .foregroundStyle(tone(progress?.state))
                    .contentTransition(.opacity)
                if let state = liveState, let ordinal = XOSetupWords.ordinal(state) {
                    ProgressView(value: Double(min(state.step, state.of)), total: Double(state.of))
                        .tint(Design.Palette.active)
                    Text(ordinal)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                        .contentTransition(.opacity)
                }
                // THE MACHINE'S OWN SENTENCE about the step, which may name
                // the address: fine on a screen that is unlocked and open,
                // and the reason it is not in the Live Activity.
                if let text = progress?.text, !text.isBlank {
                    Text(text)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }
            }
            .animation(Design.Motion.change, value: progress?.phase)
            .animation(Design.Motion.change, value: progress?.state)
            .padding(.vertical, Design.Space.hair)
            if running, !cancelRequested {
                Button("Cancel", role: .destructive) { Task { await cancel(job) } }
                    .disabled(busy)
            } else if running {
                // Asked for, and the machine stops between steps; its own
                // sentence above says so. Not offered a second time (C-2).
                EmptyView()
            } else if progress?.state == "done" {
                Button("Done") { dismiss() }
            } else {
                // Stopped or cancelled. A new begin, because the key was for
                // the job that ended; the machine picks up where it got to.
                Button("Try again") { reset() }
            }
        } header: {
            sectionHead("On \(hostId)")
        }
    }

    /// The tone agrees with the headline it is on: finished, stopped,
    /// stopped by you, or still going.
    private func tone(_ state: String?) -> Color {
        switch state ?? "" {
        case "done": return Design.Palette.ok
        case "failed": return Design.Palette.bad
        case "cancelled": return Design.Palette.inkDim
        default: return Design.Palette.ink
        }
    }

    // MARK: Actions

    @MainActor
    private func probe() async {
        probing = true
        defer { probing = false }
        probes = nil
        chosen = nil
        probeText = ""
        acknowledged = false
        plainAccepted = false
        result = ""
        failed = false
        do {
            let reply = try await fleet.xoprobe(address: trimmedAddress)
            guard reply.ok != false else {
                probeText = reply.text ?? "The fleet did not try that address."
                return
            }
            guard let found = reply.probes else {
                probeText = "This fleet did not say which machines tried. Update it, then try again."
                return
            }
            probes = found
            // One machine that can is not a choice, so it is chosen. Over
            // plain HTTP too: choosing shows the warning, and sends nothing.
            if offered.count == 1 { chosen = offered.first }
        } catch {
            probeText = error.localizedDescription
        }
    }

    private func choose(_ probe: Fleet.Probe) {
        if chosen?.hostId != probe.hostId {
            acknowledged = false
            plainAccepted = false
        }
        chosen = probe
        toCompare = nil
        begun = nil
        result = ""
        failed = false
    }

    @MainActor
    private func begin(_ probe: Fleet.Probe) async {
        // WHAT GOES WITH BEGIN is exactly what the person was asked. A
        // trusted certificate is never asked about, so nothing is said for
        // it; one that does not check out goes only with the person's word;
        // and no certificate goes with no pin and the person's word for that,
        // `plain`. Anything else is not sent.
        let pin: String?
        let trust: String?
        let plain: Bool
        if let cert = probe.cert {
            pin = cert
            plain = false
            if probe.certificateTrusted {
                trust = nil
            } else if acknowledged {
                trust = "accepted"
            } else {
                return
            }
        } else if probe.plainHTTP, plainAccepted {
            pin = nil
            trust = nil
            plain = true
        } else {
            return
        }
        busy = true
        defer { busy = false }
        result = ""
        failed = false
        let target = trimmedAddress
        // AN EARLIER BEGIN THAT NEVER RAN: its machine is still holding the
        // job open, and three of those fill its slots. Let it go first.
        if let stale = begun {
            _ = try? await fleet.cancelSetup(job: stale.job)
            begun = nil
        }
        do {
            let reply = try await fleet.beginSetup(address: target, pin: pin, host: probe.hostId, trust: trust, plain: plain)
            guard reply.ok != false, let setup = reply.xosetup, let begunJob = setup.job,
                  let key = setup.key, let keySig = setup.keySig, let hostKey = setup.hostKey
            else {
                refuse(reply.text ?? "\(probe.hostId) did not begin the setup.")
                return
            }
            let machine = reply.hostId ?? probe.hostId
            // THE KEY IS CHECKED BEFORE ANYTHING IS SEALED TO IT. A bad
            // signature is a hard stop, said in one sentence: whatever
            // answered, it was not that machine signing for this key. Over
            // plain HTTP the machine signed over an empty pin, and that is
            // what is checked: `"pin":""` in the bytes, not a missing key.
            guard XOSetupKey.isSigned(key: key, keySig: keySig, hostKey: hostKey, address: target, job: begunJob, pin: pin ?? "") else {
                _ = try? await fleet.cancelSetup(job: begunJob)
                refuse("The key \(machine) answered with did not come from that machine, so the sign-in was not sent.")
                return
            }
            // The fingerprint is worked out here from the key, never read off
            // the reply: it is what the person compares, and what the vault
            // approved.
            let fingerprint = PhoneVault.fingerprint(hostKey)
            begun = Begun(job: begunJob, hostId: machine, address: target, key: key, fingerprint: fingerprint)
            let approved = await approvedFingerprint(of: machine)
            if approved == fingerprint {
                await send()
            } else if approved != nil {
                // Approved under another key: a machine that was re-keyed
                // would have been re-approved. Hard stop.
                _ = try? await fleet.cancelSetup(job: begunJob)
                begun = nil
                refuse("The key \(machine) answered with did not come from that machine: it is not the key this phone approved for it. The sign-in was not sent.")
            } else {
                toCompare = fingerprint
            }
        } catch {
            refuse(error.localizedDescription)
        }
    }

    /// The fingerprint this phone's vault approved for that machine, or nil
    /// when it approved none, or cannot ask: no GitHub sign-in on this phone,
    /// or a vault that did not answer. Nil asks the person; it never passes.
    private func approvedFingerprint(of hostId: String) async -> String? {
        guard PhoneGitHub(settings: settings).signedIn,
              let contents = try? await PhoneVault(settings: settings).list(fleet)
        else { return nil }
        return contents.grants.first { $0.label == hostId }?.fingerprint
    }

    /// Seal the sign-in to the job's key and send it. The password is cleared
    /// from this screen the moment it is sealed, before the send, so a failed
    /// send does not leave it on a screen somebody walks away from.
    @MainActor
    private func send() async {
        guard let begun else { return }
        busy = true
        defer { busy = false }
        let sealed: [String: String]
        do {
            sealed = try Seal.seal(
                to: begun.key,
                aad: Seal.xosetupAAD(job: begun.job, address: begun.address),
                payload: ["v": 1, "xo": ["email": email.trimmingCharacters(in: .whitespacesAndNewlines), "password": password]]
            )
        } catch {
            refuse(error.localizedDescription)
            return
        }
        password = ""
        toCompare = nil
        let joined = "\(sealed["epk"] ?? "").\(sealed["iv"] ?? "").\(sealed["ct"] ?? "")"
        do {
            let reply = try await fleet.runSetup(job: begun.job, sealed: joined)
            guard reply.ok != false else {
                refuse(reply.text ?? "\(begun.hostId) did not take the sign-in.")
                return
            }
            hostId = begun.hostId
            progress = reply.xosetup
            job = begun.job
            self.begun = nil
            XOSetupActivities.start(fleet: fleet, job: begun.job, hostId: begun.hostId, address: begun.address, progress: reply.xosetup)
        } catch {
            refuse(error.localizedDescription)
        }
    }

    /// The person did not vouch for the key. The machine is told to forget
    /// the job, and the password goes with it.
    @MainActor
    private func abandon() async {
        password = ""
        toCompare = nil
        if let begun { _ = try? await fleet.cancelSetup(job: begun.job) }
        begun = nil
        result = "Nothing was sent."
        failed = false
    }

    @MainActor
    private func cancel(_ job: String) async {
        busy = true
        defer { busy = false }
        do {
            let reply = try await fleet.cancelSetup(job: job)
            if let state = reply.xosetup { await apply(state) }
            if reply.ok == false {
                refuse(reply.text ?? "It could not be stopped.")
            } else {
                cancelRequested = true
            }
        } catch {
            refuse(error.localizedDescription)
        }
    }

    /// Ask where the job is every few seconds while this screen is open and
    /// the job is live. `.task(id: job)` cancels this when the screen goes or
    /// the job changes, and Task.sleep throws on cancellation, so the loop
    /// ends by itself, the way SessionView's does.
    @MainActor
    private func follow() async {
        guard let job else { return }
        while !Task.isCancelled, running {
            guard (try? await Task.sleep(for: .seconds(3))) != nil else { return }
            guard let reply = try? await fleet.setupStatus(job: job) else { continue }
            if let state = reply.xosetup {
                await apply(state)
            } else if reply.ok == false {
                // The coordinator no longer knows the job: it restarted, or a
                // day passed. Said as what it is, and the asking stops.
                let text = reply.text ?? "The fleet no longer knows this job."
                await apply(Fleet.SetupState(job: job, state: "failed", text: text))
            }
        }
    }

    /// What the fleet said, applied to the screen and to the Lock Screen
    /// alike, so the two never disagree.
    @MainActor
    private func apply(_ state: Fleet.SetupState) async {
        progress = state
        if let job { await XOSetupActivities.apply(job: job, progress: state) }
    }

    private func reset() {
        job = nil
        progress = nil
        begun = nil
        cancelRequested = false
        toCompare = nil
        password = ""
        result = ""
        failed = false
    }

    private func refuse(_ text: String) {
        result = text
        failed = true
    }

    private func sectionHead(_ text: String) -> some View {
        Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
    }
}

/// What a certificate's problems and dates read as, in the same words on
/// Android (CertificateWords in HypervisorSheet.kt): the problems from
/// `narrowCertificate` in src/fleet/coordinator/core.js, one sentence each.
enum CertificateWords {
    static func problems(_ c: Fleet.Probe.Certificate?, address: String) -> [String] {
        guard let c else { return ["This machine could not read the certificate’s details."] }
        let lines = (c.problems ?? []).compactMap { key -> String? in
            switch key {
            case "self-signed": return "Self-signed: nothing but the server itself vouches for it."
            case "untrusted-issuer": return "Signed by an authority this machine does not trust."
            case "expired": return "Expired on \(date(c.notAfter) ?? "a date this machine did not say")."
            case "not-yet-valid": return "Not valid until \(date(c.notBefore) ?? "a date this machine did not say")."
            case "name-mismatch": return "Issued for a different name than \(address)."
            default: return nil
            }
        }
        // Not trusted and nothing named: the machine could not say why.
        return lines.isEmpty ? ["Not trusted by that machine, which did not say why."] : lines
    }

    static func validity(_ c: Fleet.Probe.Certificate) -> String? {
        switch (date(c.notBefore), date(c.notAfter)) {
        case let (from?, until?): return "\(from) to \(until)"
        case (nil, let until?): return "until \(until)"
        case (let from?, nil): return "from \(from)"
        default: return nil
        }
    }

    /// A medium date, from the ISO 8601 the coordinator writes (with
    /// milliseconds, which the plain formatter refuses), or nil.
    static func date(_ iso: String?) -> String? {
        guard let iso else { return nil }
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let when = precise.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return nil }
        return when.formatted(date: .abbreviated, time: .omitted)
    }
}
