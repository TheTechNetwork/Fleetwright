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
/// NOTHING IS HELD FOR A RETRY. No outbox: every intent carries an
/// idempotency key so a send that could not reach the fleet is refused rather
/// than held on disk (Fleet.runSetup).
///
/// WHAT IS KEPT IS WHAT THE PERSON ASKED TO KEEP, and where it worked
/// (XOSaved). The machine that got through is remembered by address, so the
/// next time this screen opens on that pool it starts there instead of asking
/// every machine, and asks them all only when that one does not get through.
/// The sign-in and the person's word for the certificate are kept only when
/// they turn on "Keep on this phone", in a Keychain item that opens to Face
/// ID or Touch ID and nothing else, and only once the machine has signed in
/// with them, so a mistyped password is never the one kept.
///
/// THE SAME SCREEN CHANGES WHAT THE FLEET MAY USE on a pool this phone holds
/// (`policyFor`), because the first three of its four steps are the same
/// steps: which machine, which certificate, whose key. Only the sealed
/// sign-in differs, saying `purpose: policy` and carrying a key that lives in
/// this screen's memory alone, and what follows `run`: the machine reads the
/// pool and hands back an inventory sealed to that key, the person chooses,
/// and the choice goes back sealed to the job's key (XOPolicy). No Live
/// Activity: the machine waits on the person, so the person is on this screen.
struct AddHypervisorView: View {
    let settings: Settings
    /// The pool whose policy this changes, or nil to add one. Its address is
    /// the one this phone holds a record for, so it is not edited here.
    let policyFor: String?
    @Environment(\.dismiss) private var dismiss

    init(settings: Settings, policyFor address: String? = nil) {
        self.settings = settings
        self.policyFor = address
        _address = State(initialValue: address ?? "")
    }

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
    /// Whether the token the machine handed back is in this phone's
    /// Keychain, once the job is done (XOSetupHandoff).
    @State private var handedBack: XOSetupHandoff.Outcome?
    /// What the fleet said when the token was kept there too, or what stood
    /// in the way (XOSetupHandoff.keepInFleet).
    @State private var fleetNote = ""
    @State private var keepingInFleet = false
    /// A policy job, once its sign-in is sent: the job's key to seal the
    /// choice to, and the key the inventory comes back to. In memory and
    /// nowhere else; dropped when the job ends.
    @State private var policyJob: PolicyJob?
    /// What the machine read, opened, while it waits on the person.
    @State private var inventory: XOPolicy.Inventory?
    @State private var choice = XOPolicy.Choice()
    /// What this phone kept for this address, once Face ID has opened it.
    @State private var remembered: XOSaved.Entry?
    /// "Keep on this phone": on when what is on screen came from what was
    /// kept, and turning it off then forgets it at once.
    @State private var keep = false
    @State private var keepLoaded = false
    /// The machine chosen is the one that got through last time, chosen
    /// without asking the others, and nothing has gone wrong with it yet.
    @State private var viaMemory = false
    /// What to keep, held in memory from the send until the machine has
    /// signed in with it (`notePath`), and only when `keep` is on.
    @State private var pendingSave: XOSaved.Entry?
    /// One sentence about what was kept or forgotten, or why the remembered
    /// machine was not enough, under the progress.
    @State private var keepNote = ""
    private let biometry = XOSaved.biometryName()

    private struct Begun {
        let job: String
        let hostId: String
        let address: String
        let key: String
        let fingerprint: String
        /// What else a job on that machine can be (`can` in begin's answer).
        let can: [String]
    }

    private struct PolicyJob {
        let key: String
        let address: String
        let reply: Seal.OneUseKey
        /// The machine said it can build the edge router (`can` holds
        /// "edge"), so the switch is offered; an older one never is (C-2).
        let canEdge: Bool
        /// The machine takes any of the pool's networks as the way out
        /// (`can` holds "egress-any"); an older one only the fleet's.
        let anyWayOut: Bool
        /// The machine puts the router's disk where the person says
        /// (`can` holds "edge-disk"); an older one picks it unasked.
        let edgeDisk: Bool
        /// The machine builds the machine image sessions' machines are
        /// cloned from (`can` holds "image"); an older one cannot.
        var canImage = false
        /// It builds any of its catalogue's images, chosen together
        /// (`can` holds "images"); an older one Debian alone.
        var canImages = false
        /// It makes group networks for machines that work together
        /// (`can` holds "groups"); an older one cannot.
        var canGroups = false
        /// It makes the pool a machine of its own (`can` holds "holder");
        /// an older one cannot.
        var canHolder = false
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
    private var isPolicy: Bool { policyFor != nil }
    /// Still going, so the screen keeps asking and offers Cancel. A policy
    /// job waiting on the person is still going: the machine can still time
    /// out, and Cancel still lets it go.
    private var running: Bool {
        guard job != nil else { return false }
        let state = progress?.state ?? "running"
        return XOSetupWords.isLive(state) || (isPolicy && state == "choosing")
    }
    /// The machine is waiting on the person's choice, and nobody has asked
    /// it to stop: the form is the screen.
    private var choosing: Bool { isPolicy && progress?.state == "choosing" && !cancelRequested }
    private var liveState: XOSetupAttributes.ContentState? { XOSetupActivities.contentState(progress) }

    var body: some View {
        Form {
            if let pool = policyFor, job == nil { fleetSection(pool) }
            whereSection
            if probes != nil { machinesSection }
            if let chosen, job == nil { signInSection(chosen) }
            if let job {
                if choosing, let inventory {
                    policySections(inventory, job: job)
                } else {
                    progressSection(job)
                }
            }
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
        .navigationTitle(isPolicy ? "What the fleet may use" : "Add a hypervisor")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: job) { await follow() }
        // The address is already known, so the first question is asked for
        // the person, starting from the machine that got through last time.
        .task {
            if isPolicy, probes == nil, !probing { await openRemembered() }
        }
    }

    // MARK: In the fleet

    /// Machines from this pool: its token kept in the fleet, so the boxes
    /// this person approved can make them. Kept on every setup from now on;
    /// this is for a pool set up before that, and for keeping it again.
    private func fleetSection(_ pool: String) -> some View {
        Section {
            Button(keepingInFleet ? "Keeping…" : "Keep its token in the fleet") {
                Task {
                    keepingInFleet = true
                    fleetNote = await XOSetupHandoff.keepInFleet(settings: settings, address: pool)
                    keepingInFleet = false
                }
            }
            .disabled(keepingInFleet)
            .frame(minHeight: 44)
            if !fleetNote.isBlank {
                Text(fleetNote)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
        } header: {
            sectionHead("Machines from this pool")
        } footer: {
            Text("The boxes you approved can then make machines on it for your sessions. They hold its token in memory only, "
                 + "and stop being given it when you remove them from your vault.")
        }
    }

    // MARK: Where

    private var whereSection: some View {
        Section {
            TextField("Address of Xen Orchestra", text: $address)
                .textContentType(.URL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .disabled(job != nil || busy || isPolicy)
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
            if isPolicy {
                Text("The pool this phone holds a token for. The change runs from one of your permanent machines, "
                     + "so one of them has to be on a network that reaches it.")
            } else {
                Text("A host name or address, with a port if it is not 443, and no https:// in front. "
                     + "The setup runs from one of your permanent machines, so one of them has to be on a network that reaches it.")
            }
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
        // NOT ASKED THIS TIME, so nothing it found is claimed: only that it
        // got through last time, which is why it is tried first.
        if viaMemory, chosen?.hostId == probe.hostId {
            return "Got through last time, so it is tried first"
        }
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
                } else if chosen.certificate != nil || !rememberedAccepts(chosen) {
                    // The details, whenever a machine read them. A path
                    // taken from memory has none, and is shown only for a
                    // certificate the person already accepted (directPath).
                    certificateQuestion(chosen)
                }
                Text(viaMemory
                     ? "SHA-256, as it was last time. The sign-in goes only to a server that answers with this certificate."
                     : "SHA-256, as \(chosen.hostId) saw it. The sign-in goes only to a server that answers with this certificate.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                Text(XOSetupKey.grouped(cert))
                    .fleetType(.labelMono)
                    .foregroundStyle(Design.Palette.ink)
                    .textSelection(.enabled)
                if !chosen.certificateTrusted, rememberedAccepts(chosen) {
                    rememberedLine("You accepted this certificate before, and this phone kept that behind \(biometry ?? "Face ID").")
                } else if !chosen.certificateTrusted {
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
                if rememberedAccepts(chosen) {
                    rememberedLine("You chose to send it without HTTPS before, and this phone kept that behind \(biometry ?? "Face ID").")
                } else {
                    Toggle(isOn: $plainAccepted) {
                        Text("Send it without HTTPS anyway")
                            .fleetType(.bodyStrong)
                            .foregroundStyle(Design.Palette.ink)
                    }
                    .tint(Design.Palette.accent)
                    .frame(minHeight: 44)
                    .disabled(busy || toCompare != nil)
                }
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
            // OFFERED ONLY WHERE IT CAN BE KEPT: a phone with no Face ID or
            // Touch ID enrolled could not make the item (C-2).
            if let biometry {
                Toggle(isOn: $keep) {
                    Text("Keep on this phone, behind \(biometry)")
                        .fleetType(.bodyStrong)
                        .foregroundStyle(Design.Palette.ink)
                }
                .tint(Design.Palette.accent)
                .frame(minHeight: 44)
                .disabled(busy || toCompare != nil)
                // Turned off over what was kept: forgotten now, not at the
                // next send, so the switch says what the phone holds.
                .onChange(of: keep) { _, on in
                    guard !on, keepLoaded else { return }
                    XOSaved.forget(trimmedAddress)
                    remembered = nil
                    keepLoaded = false
                }
            }
            if let toCompare {
                compareRows(toCompare)
            } else {
                Button(busy ? "Beginning…" : "Begin on \(chosen.hostId)") { Task { await begin(chosen) } }
                    .disabled(busy || email.isBlank || password.isEmpty || !accepted(chosen))
            }
        } header: {
            sectionHead("Sign in to Xen Orchestra")
        } footer: {
            Text(signInFooter(chosen))
        }
    }

    /// What happens to the sign-in, in the words that are true for the
    /// switch as it stands: kept behind Face ID on this phone, or by nobody.
    /// The fleet never keeps it either way. The same words as Android.
    private func signInFooter(_ chosen: Fleet.Probe) -> String {
        let use = isPolicy ? "to read the pool and apply what you choose" : "to make a limited fleetwright user and its token"
        let sealed = "It is sealed on this phone to a key only that machine holds, so the fleet relays it and cannot read it"
        if keep, let biometry {
            let word = chosen.certificateTrusted ? "" : ", and your word for the certificate,"
            return "Used by \(chosen.hostId) \(use). \(sealed). This phone keeps it\(word) in its "
                + "Keychain behind \(biometry), once \(chosen.hostId) has signed in with it; the fleet never keeps it."
        }
        return "Used once, by \(chosen.hostId), \(use), and not kept. \(sealed), and neither this phone nor the fleet keeps it."
    }

    /// The person's earlier word, said in place of the question it answers.
    private func rememberedLine(_ text: String) -> some View {
        Text(text)
            .fleetType(.label)
            .foregroundStyle(Design.Palette.inkDim)
            .frame(minHeight: 44, alignment: .leading)
    }

    /// One calm line: the machine checked the certificate and found nothing
    /// wrong, so nothing is asked.
    private func certificateChecksOut(_ probe: Fleet.Probe) -> some View {
        // FROM MEMORY, said as when it was checked: nothing was asked this
        // time, and the machine checks it again before it signs in.
        if viaMemory {
            return Text("Its certificate checked out when this pool was set up, and \(probe.hostId) checks it again before signing in.")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.ink)
        }
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
            if isPolicy {
                // No token is made by a policy change; what crosses is the
                // password and what the pool is made of.
                Text("The admin password you type, and the pool's storage and networks, would cross the network between "
                     + "\(probe.hostId) and \(trimmedAddress) unencrypted. Anything on that network could read them.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
            } else {
                Text("The admin password you type, and the token the fleet keeps afterwards, would cross the network between "
                     + "\(probe.hostId) and \(trimmedAddress) unencrypted. Anything on that network could read them.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
            }
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
        if probe.cert != nil { return probe.certificateTrusted || acknowledged || rememberedAccepts(probe) }
        return probe.plainHTTP && (plainAccepted || rememberedAccepts(probe))
    }

    /// The person's word for what this machine found, kept on this phone
    /// behind Face ID and opened: the same fingerprint they accepted, or
    /// plain HTTP again. A different certificate is asked about in full.
    private func rememberedAccepts(_ probe: Fleet.Probe) -> Bool {
        remembered?.accepts(probe) == true
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

    /// "Step 5 of 5", and while the edge router is building, which stage of
    /// it and how far: "Step 5 of 5 · building the edge router, part 2 of 3 · 42%".
    private func stepLine(_ state: XOSetupAttributes.ContentState) -> String {
        let step = "Step \(min(state.step + 1, max(state.of, 1))) of \(max(state.of, 1))"
        guard let part = progress?.part, state.state == "running" else { return step }
        return "\(step) · building the edge router, part \(part.stage) of \(part.stages) · \(part.fill / 10)%"
    }

    private func progressSection(_ job: String) -> some View {
        Section {
            VStack(alignment: .leading, spacing: Design.Space.insideTight) {
                Text(liveState.map { headline($0) } ?? "Starting on \(hostId)")
                    .fleetType(.bodyStrong)
                    .foregroundStyle(tone(progress?.state))
                    .contentTransition(.opacity)
                if let state = liveState, XOSetupWords.ordinal(state) != nil {
                    // THE BUILD'S OWN BAR while the machine says how far it
                    // has got. Asked for: "this needs proper progress"; the
                    // step alone held the bar at four fifths for minutes.
                    let (value, total) = XOSetupWords.bar(state)
                    ProgressView(value: value, total: total)
                        .tint(Design.Palette.active)
                        .animation(Design.Motion.change, value: value)
                    Text(stepLine(state))
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
                // WHERE THE TOKEN IS, said only once this phone knows: the
                // machine says it kept none, and this says whether it is here.
                switch handedBack {
                case .kept:
                    Text("The token is in this phone’s Keychain now. No machine in the fleet keeps it on disk.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                case .failed(let why):
                    Text(why)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.bad)
                case nil:
                    EmptyView()
                }
                if !keepNote.isBlank {
                    Text(keepNote)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }
                if !fleetNote.isBlank {
                    Text(fleetNote)
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
                // A remembered machine that did not get through is not tried
                // twice: every machine is asked.
                Button("Try again") {
                    let askAll = viaMemory && progress?.phase == "connect"
                    reset()
                    if askAll { Task { await probe() } }
                }
            }
        } header: {
            sectionHead("On \(hostId)")
        }
    }

    /// Onboarding's words, or a policy change's: the steps are shared, the
    /// ends are not.
    private func headline(_ state: XOSetupAttributes.ContentState) -> String {
        isPolicy ? XOPolicy.statusLine(state) : XOSetupWords.headline(state)
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

    // MARK: What the fleet may use

    /// The form a policy job waits on: storage, networks, the way out and the
    /// limits, each starting where the pool is now (XOPolicy.Choice.initial),
    /// then the one line about time and the two ways out of it. Every row is
    /// a platform control on the card colour, the same shape as the sign-in
    /// rows above it (RHYTHM 1); the one thing that spends emphasis is the
    /// reason Apply is not offered yet, because it is the screen asking.
    @ViewBuilder private func policySections(_ inv: XOPolicy.Inventory, job: String) -> some View {
        storageSection(inv)
        networksSection(inv)
        wayOutSection(inv)
        if choice.groupsChoice, choice.egress != nil { groupsSection(inv) }
        limitsSection(inv)
        applySection(inv, job: job)
    }

    private func storageSection(_ inv: XOPolicy.Inventory) -> some View {
        Section {
            if inv.srs.isEmpty {
                // Said, because nothing can be applied without one and an
                // empty section would leave Apply greyed out for no reason.
                Text("This pool listed no storage a VM’s disk can go on, so there is nothing to choose here.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
            } else {
                ForEach(inv.srs) { sr in
                    Toggle(isOn: storageBinding(sr.id, inv)) {
                        policyRow(XOPolicy.title(sr.name, id: sr.id), storageLine(sr, inv))
                    }
                    .tint(Design.Palette.accent)
                    .frame(minHeight: 44)
                    .disabled(busy)
                }
            }
        } header: {
            sectionHead("Storage")
        } footer: {
            Text("Where the fleet’s VMs may put their disks.")
        }
    }

    private func networksSection(_ inv: XOPolicy.Inventory) -> some View {
        Section {
            if inv.choosable.isEmpty {
                Text("This pool listed no networks to choose from.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
            } else {
                ForEach(inv.choosable) { network in
                    Toggle(isOn: networkBinding(network.id)) {
                        policyRow(XOPolicy.title(network.name, id: network.id), networkLine(network, inv))
                    }
                    .tint(Design.Palette.accent)
                    .frame(minHeight: 44)
                    .disabled(busy)
                }
            }
        } header: {
            sectionHead("Networks")
        } footer: {
            Text("The networks the fleet’s VMs may be attached to.")
        }
    }

    /// THE WAY OUT: any of the pool's networks, on a machine that takes
    /// that (`egress-any`), and on an older one only the networks chosen
    /// above, which is all it takes (checkPolicy), so the picker never offers
    /// one it would refuse. Asked for: the first version offered only the
    /// fleet's networks, and the WAN usually belongs on one that is not.
    /// Then the edge router on it, offered only by a machine that can build
    /// one: built when the pool has none, kept on the way out when it has.
    /// What building costs is said before it is asked for, because it
    /// downloads and makes a VM.
    private func wayOutSection(_ inv: XOPolicy.Inventory) -> some View {
        let canEdge = policyJob?.canEdge == true
        let anyWayOut = choice.anyWayOut
        let there = inv.edge(on: choice.egress)
        return Section {
            Picker(selection: $choice.egress) {
                Text("None yet").tag(String?.none)
                ForEach(inv.choosable.filter { anyWayOut || choice.networks.contains($0.id) }) { network in
                    Text(XOPolicy.title(network.name, id: network.id)).tag(String?.some(network.id))
                }
            } label: {
                Text("Network")
                    .fleetType(.bodyStrong)
                    .foregroundStyle(Design.Palette.ink)
            }
            .tint(Design.Palette.accent)
            .frame(minHeight: 44)
            .disabled(busy)
            // No way out, no router and no image: the switches go off with it.
            .onChange(of: choice.egress) { _, way in
                if way == nil { choice.edge = false; choice.image = false; choice.images = []; choice.holder = false }
                // Another pool has its own group networks to start from.
                choice.groups = XOPolicy.clamp(inv.groupCount(on: way), choice.groupRange(in: inv))
            }
            if canEdge, choice.egress != nil {
                Toggle(isOn: $choice.edge) {
                    policyRow(there == nil ? "Build the edge router on it" : "Keep the edge router on it", edgeLine(there))
                }
                .tint(Design.Palette.accent)
                .frame(minHeight: 44)
                .disabled(busy)
                // The image is built behind the router: no router, no image.
                .onChange(of: choice.edge) { _, on in
                    if !on, there == nil { choice.image = false; choice.images = [] }
                }
            }
            // THE MACHINE IMAGE sessions' machines are cloned from, offered
            // only by a machine that builds one, and only where there is none.
            // Asked for: "Still can't run sessions on it".
            if policyJob?.canImage == true, choice.egress != nil, choice.imagesChoice, let kinds = inv.imageKinds {
                imageRows(kinds, inv: inv, router: there)
            } else if policyJob?.canImage == true, choice.egress != nil {
                if let image = inv.image(on: choice.egress) {
                    policyRow("Machine image", "\(image.name) is there. New session › Where offers machines from it.")
                } else {
                    Toggle(isOn: $choice.image) {
                        policyRow("Make the machine image for sessions", imageLine)
                    }
                    .tint(Design.Palette.accent)
                    .frame(minHeight: 44)
                    .disabled(busy)
                    // Built behind the router, so asking for it asks for that too.
                    .onChange(of: choice.image) { _, on in
                        if on, there == nil { choice.edge = true }
                    }
                }
            }
            // THE POOL'S OWN MACHINE, offered only by a machine that makes one:
            // said as there when the pool has it, a switch when it has not.
            // Asked for: "dedicated hypervisor VM on the pool".
            if choice.holderChoice, choice.egress != nil {
                if let mine = inv.holder(on: choice.egress) {
                    policyRow("The pool’s own machine", holderThereLine(mine))
                } else {
                    Toggle(isOn: $choice.holder) {
                        policyRow("Make the pool a machine of its own", holderLine)
                    }
                    .tint(Design.Palette.accent)
                    .frame(minHeight: 44)
                    .disabled(busy)
                    // Made from the image: asking for it asks for Debian's, and
                    // the router that is built behind, when the pool has neither.
                    .onChange(of: choice.holder) { _, on in
                        guard on, inv.image(on: choice.egress) == nil, !(choice.imageChoice && choice.wantsImage) else { return }
                        if choice.imagesChoice { choice.images.insert(XOPolicy.debianKey) } else { choice.image = true }
                        if there == nil { choice.edge = true }
                    }
                }
            }
            // WHERE THE DISKS GO, asked before anything is built and said
            // while it is: any storage in the way out's pool with room, the
            // fleet's own first. Asked for: "which disk did it put it on?"
            if choice.edgeDiskChoice, choice.building(in: inv).edge || choice.building(in: inv).image {
                edgeDiskRow(inv)
            }
        } header: {
            sectionHead("Way out")
        } footer: {
            Text(wayOutFooter(canEdge: canEdge, anyWayOut: anyWayOut))
        }
    }

    /// What the switch does, in the concrete: what it costs when there is no
    /// router, and what Apply does to the one that is there. The same words
    /// as Android (PolicyForm.kt).
    private func edgeLine(_ there: XOPolicy.Inventory.Edge?) -> String {
        guard let there else {
            return "An OPNsense VM with 2 vCPUs, 2 GiB of memory and a 3 GiB disk on the storage chosen. "
                + "\(hostId) downloads OPNsense once, about 470 MB, and builds it while you wait."
        }
        let state = there.running
            ? "It is there and running. Apply keeps its WAN on this network."
            : "It is there and stopped. Apply keeps its WAN on this network and starts it."
        return there.sr.map { "\(state) Its disk is on \($0)." } ?? state
    }

    /// ONE ROW PER OPERATING SYSTEM the machine can make an image of: said
    /// as there when the pool has it, a switch when it does not. Asked for:
    /// "os selection not just Debian". A method rather than more of the
    /// section's body, for the reason healthLines gives in MachinesView.
    @ViewBuilder
    private func imageRows(_ kinds: [XOPolicy.Inventory.ImageKind], inv: XOPolicy.Inventory,
                           router there: XOPolicy.Inventory.Edge?) -> some View {
        let present = inv.imageKeys(on: choice.egress)
        ForEach(kinds) { kind in
            if present.contains(kind.key) {
                policyRow("\(kind.os) machine image", "It is there. New session › Where offers machines from it.")
            } else {
                Toggle(isOn: Binding(
                    get: { choice.images.contains(kind.key) },
                    set: { on in
                        if on { choice.images.insert(kind.key) } else { choice.images.remove(kind.key) }
                        // Built behind the router, so asking for it asks for that too.
                        if on, there == nil { choice.edge = true }
                    })) {
                    policyRow("Make the \(kind.os) machine image", imageLine(kind))
                }
                .tint(Design.Palette.accent)
                .frame(minHeight: 44)
                .disabled(busy)
            }
        }
    }

    /// What making one of the images costs. The same words as Android
    /// (PolicyForm.kt).
    private func imageLine(_ kind: XOPolicy.Inventory.ImageKind) -> String {
        if kind.key == XOPolicy.debianKey { return imageLine }
        return "\(kind.os) with Fleetwright installed, on a 20 GiB disk on the storage chosen. \(hostId) downloads its cloud "
            + "image once, converts it to a disk, and installs Fleetwright on it, which takes about ten minutes. Sessions can "
            + "then start on a new machine from it."
    }

    /// What the pool's own machine is, before it is asked for. The same words
    /// as Android (PolicyForm.kt).
    private var holderLine: String {
        "A Fleetwright machine that stays up on this network, made from the pool’s machine image and kept outside what the "
            + "fleet may use, so the pool does not need \(hostId) to be awake. Once it joins, approve it under Machines and it "
            + "holds the pool."
    }

    /// The one there, and what Apply does to it. The same words as Android.
    private func holderThereLine(_ mine: XOPolicy.Inventory.Holder) -> String {
        mine.running
            ? "\(mine.name) is there and running. It holds the pool once you have approved it under Machines."
            : "\(mine.name) is there and stopped. Apply starts it."
    }

    /// What making the image costs, before it is asked for. The same words as
    /// Android (PolicyForm.kt).
    private var imageLine: String {
        "Debian 13 with Fleetwright installed, on a 20 GiB disk on the storage chosen. \(hostId) downloads Debian once, "
            + "about 220 MB, and installs Fleetwright on it, which takes about ten minutes. Sessions can then start on a new "
            + "machine from it."
    }

    /// The storage the disks being built go on, with the room each has.
    /// Nothing to pick from is said, and Apply waits (XOPolicy.Choice.problem).
    @ViewBuilder
    private func edgeDiskRow(_ inv: XOPolicy.Inventory) -> some View {
        let build = choice.building(in: inv)
        let fits = inv.edgeDisks(for: choice.egress, need: choice.diskNeed(in: inv))
        if fits.isEmpty {
            Text(build.image
                 ? "Nothing in the way out’s pool has 20 GiB free for the machine image’s disk."
                 : "Nothing in the way out’s pool has 3 GiB free for its disk.")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.bad)
        } else {
            Picker(selection: Binding(get: { choice.edgeDisk(in: inv) }, set: { choice.edgeSr = $0 })) {
                ForEach(fits) { sr in
                    Text("\(XOPolicy.title(sr.name, id: sr.id)), \(XOPolicy.gibText(sr.free)) free").tag(String?.some(sr.id))
                }
            } label: {
                Text(build.edge && build.image ? "Their disks go on" : build.image ? "The image’s disk goes on" : "Its disk goes on")
                    .fleetType(.bodyStrong)
                    .foregroundStyle(Design.Palette.ink)
            }
            .tint(Design.Palette.accent)
            .frame(minHeight: 44)
            .disabled(busy)
        }
    }

    private func wayOutFooter(canEdge: Bool, anyWayOut: Bool) -> String {
        let what = "The network the edge router, an OPNsense VM, will put its WAN on, so labs reach the internet through it and not "
            + "your LAN. It is recorded in Xen Orchestra as the fleetwright-egress tag on that network. "
            + (anyWayOut
                ? "Any of the pool’s networks can be it. One the fleet’s VMs may not use is the better, so no lab can skip the router."
                : "Only a network chosen above can be the way out.")
        return canEdge ? what : what + " \(hostId) is too old to build the router; update it to have it built from here."
    }

    /// GROUP NETWORKS, in the way out's pool: how many to have, from the
    /// ones there (never fewer) to four. Asked for: "the 3 VMs need to reach
    /// each other". What a machine is fenced from by default is said here,
    /// because this is the one place it can be let through.
    private func groupsSection(_ inv: XOPolicy.Inventory) -> some View {
        let there = inv.groupCount(on: choice.egress)
        return Section {
            Stepper(value: $choice.groups, in: choice.groupRange(in: inv)) {
                policyRow("Groups", groupsLine(there))
            }
            .frame(minHeight: 44)
            .disabled(busy)
        } header: {
            sectionHead("Machines that work together")
        } footer: {
            Text("Every machine the fleet starts here reaches the internet and nothing else: not your network, and not the other machines. "
                 + "A group is for machines that need to talk to each other, like the nodes of a cluster you are testing. "
                 + "Machines in the same group share a private network and keep their way to the internet. "
                 + "You choose the group when you start a session, under Where. A group stays once it is made, because a machine may be on it.")
        }
    }

    /// The same words as Android (XoPolicy.groupsLine). Asked for, of the
    /// first version's "1: 1 made when you apply": "What does this even
    /// mean". A count, said as a count, and what Apply will make.
    private func groupsLine(_ there: Int) -> String {
        let count = choice.groups == 1 ? "1 group" : "\(choice.groups) groups"
        let more = choice.groups - there
        if choice.groups == 0 { return "None, so every machine is on its own" }
        if more <= 0 { return count }
        return there == 0 ? "\(count), made when you apply" : "\(count): \(there) there now, \(more) made when you apply"
    }

    private func limitsSection(_ inv: XOPolicy.Inventory) -> some View {
        let disk = inv.diskRange(for: choice.srs)
        return Section {
            Stepper(value: $choice.cpus, in: inv.cpuRange) {
                policyRow("vCPUs", "\(choice.cpus)" + (inv.capacity.cpus > 0 ? " of \(inv.capacity.cpus) in the pool" : ""))
            }
            .frame(minHeight: 44)
            .disabled(busy)
            Stepper(value: $choice.memoryGiB, in: inv.memoryRange) {
                policyRow("Memory", "\(choice.memoryGiB) GiB"
                          + (inv.capacity.memory > 0 ? " of \(XOPolicy.gibText(inv.capacity.memory)) in the pool" : ""))
            }
            .frame(minHeight: 44)
            .disabled(busy)
            // Ten at a time: the range is the size of the storage chosen,
            // and a pool's storage is counted in hundreds of GiB.
            Stepper(value: $choice.diskGiB, in: disk, step: 10) {
                policyRow("Disk", "\(choice.diskGiB) GiB of \(disk.upperBound.formatted()) GiB on the storage chosen")
            }
            .frame(minHeight: 44)
            .disabled(busy)
        } header: {
            sectionHead("Limits")
        } footer: {
            Text("The most the fleet’s VMs may use between them. Xen Orchestra holds them to it.")
        }
    }

    /// Apply is offered only for a choice the machine will take, and when it
    /// is not, the reason is the line above it rather than a button that
    /// does nothing (C-2). Cancel lets the machine go now rather than at the
    /// end of the ten minutes.
    private func applySection(_ inv: XOPolicy.Inventory, job: String) -> some View {
        let problem = choice.problem(in: inv)
        return Section {
            Text("\(hostId) waits ten minutes for this from when it read the pool, then lets go of the sign-in without changing anything.")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
            if let problem {
                Text(problem)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.attention)
            }
            Button(busy ? "Applying…" : "Apply") { Task { await applyPolicy(inv, job: job) } }
                .disabled(busy || problem != nil)
            Button("Cancel", role: .destructive) { Task { await cancel(job) } }
                .disabled(busy)
        } header: {
            sectionHead("On \(hostId)")
        }
    }

    private func policyRow(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: Design.Space.hair) {
            Text(title)
                .fleetType(.bodyStrong)
                .foregroundStyle(Design.Palette.ink)
            Text(detail)
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
        }
    }

    /// "412 GiB free of 931 GiB, shared", and the pool it is in when the
    /// inventory has more than one.
    private func storageLine(_ sr: XOPolicy.Inventory.Storage, _ inv: XOPolicy.Inventory) -> String {
        var line = "\(XOPolicy.room(sr)), \(sr.shared ? "shared" : "local")"
        if let pool = inv.poolName(sr.pool) { line += ", in \(pool)" }
        return line
    }

    private func networkLine(_ network: XOPolicy.Inventory.Network, _ inv: XOPolicy.Inventory) -> String {
        var line = XOPolicy.vlan(network)
        if let pool = inv.poolName(network.pool) { line += ", in \(pool)" }
        return line
    }

    private func storageBinding(_ id: String, _ inv: XOPolicy.Inventory) -> Binding<Bool> {
        Binding(get: { choice.srs.contains(id) }, set: { on in choice.setStorage(id, on: on, in: inv) })
    }

    private func networkBinding(_ id: String) -> Binding<Bool> {
        Binding(get: { choice.networks.contains(id) }, set: { on in choice.setNetwork(id, on: on) })
    }

    // MARK: Actions

    @MainActor
    private func probe() async {
        probing = true
        defer { probing = false }
        viaMemory = false
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
            // Among several, the one that got through last time is chosen,
            // and the others stay a tap away.
            if offered.count == 1 {
                chosen = offered.first
            } else if let via = XOSaved.machine(for: trimmedAddress) {
                chosen = offered.first { $0.hostId == via }
            }
            // An address typed on Add a hypervisor that this phone kept a
            // sign-in for: opened now, once there is something to send it to.
            if remembered == nil, XOSaved.has(trimmedAddress) { await unlockRemembered() }
        } catch {
            probeText = error.localizedDescription
        }
    }

    /// FIRST, WHERE IT WORKED LAST TIME. What was kept is opened (Face ID),
    /// and when the machine that got through last time is known and the
    /// certificate needs nobody's word or has the person's kept word, that
    /// machine is chosen and nothing else is asked: `begin` goes to it, and
    /// it holds the sign-in to the pinned certificate as it always does, so
    /// a server that changed fails at `connect` with nothing sent to it.
    /// Anything less asks every machine, as before, and chooses that one
    /// from the answers when it is among them.
    @MainActor
    private func openRemembered() async {
        await unlockRemembered()
        if let via = XOSaved.machine(for: trimmedAddress), let path = directPath(via) {
            probes = [path]
            chosen = path
            viaMemory = true
            return
        }
        await probe()
    }

    @MainActor
    private func unlockRemembered() async {
        guard XOSaved.has(trimmedAddress),
              let entry = await XOSaved.unlock(trimmedAddress, reason: "Sign in to Xen Orchestra at \(trimmedAddress)")
        else { return }
        remembered = entry
        if let login = entry.login {
            email = login.email
            password = login.password
        }
        keep = true
        keepLoaded = true
    }

    /// The remembered machine as a probe nobody ran: over plain HTTP if the
    /// person accepted that, with the fingerprint they accepted, or with the
    /// one pinned at setup when it checked out then. Nil when none of those
    /// is known, and every machine is asked.
    private func directPath(_ via: String) -> Fleet.Probe? {
        if let accepted = remembered?.accepted {
            if accepted.plain {
                return Fleet.Probe(hostId: via, reachable: true, xo: nil, tls: false, cert: nil, certificate: nil, version: nil)
            }
            if let pin = accepted.pin {
                return Fleet.Probe(hostId: via, reachable: true, xo: nil, tls: true, cert: pin, certificate: nil, version: nil)
            }
        }
        if let pinned = XOSetupHandoff.pinnedCertificate(trimmedAddress), pinned.trusted {
            let checked = Fleet.Probe.Certificate(trusted: true, problems: nil, subject: nil, issuer: nil, notBefore: nil, notAfter: nil, names: nil)
            return Fleet.Probe(hostId: via, reachable: true, xo: nil, tls: true, cert: pinned.pin, certificate: checked, version: nil)
        }
        return nil
    }

    /// What to keep once the machine has signed in with it: the sign-in, and
    /// the person's word for what this machine found when it was asked for
    /// (a certificate that checks out needs none). Nil when the switch is off.
    private func entryToKeep(_ probe: Fleet.Probe) -> XOSaved.Entry? {
        guard keep, biometry != nil else { return nil }
        var accepted: XOSaved.Entry.Accepted?
        if let cert = probe.cert, !probe.certificateTrusted {
            accepted = .init(pin: cert, plain: false)
        } else if probe.cert == nil, probe.plainHTTP {
            accepted = .init(pin: nil, plain: true)
        }
        return XOSaved.Entry(login: .init(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password),
                             accepted: accepted, savedAt: Date())
    }

    /// WHERE IT GOT TO decides what is kept. Past `sign-in`, the machine got
    /// through and signed in: that machine is remembered for this address,
    /// and what the person asked to keep is written, once. Stopped at
    /// `connect` on a machine chosen from memory: said, and Try again asks
    /// every machine. Stopped at `sign-in` with a kept password: that
    /// password is wrong now, and is forgotten rather than offered again.
    @MainActor
    private func notePath(_ state: Fleet.SetupState) {
        let now = state.state ?? ""
        let phase = state.phase ?? ""
        let past = now == "done" || now == "choosing" || (XOSetupWords.isLive(now) && !phase.isEmpty && phase != "connect" && phase != "sign-in")
        if past {
            if !hostId.isEmpty { XOSaved.rememberMachine(hostId, for: trimmedAddress) }
            if let entry = pendingSave {
                pendingSave = nil
                if XOSaved.save(entry, for: trimmedAddress) {
                    remembered = entry
                    keepLoaded = true
                    keepNote = "The sign-in is kept on this phone behind \(biometry ?? "Face ID") now."
                } else {
                    keepNote = "This phone could not keep the sign-in, so it will be asked for next time."
                }
            }
            return
        }
        guard now == "failed" else { return }
        pendingSave = nil
        if phase == "connect", viaMemory {
            keepNote = "\(hostId) got through last time and did not this time. Try again asks all your machines and shows the certificate in full."
        } else if phase == "sign-in", keepLoaded {
            XOSaved.forget(trimmedAddress)
            remembered = nil
            keepLoaded = false
            keep = false
            keepNote = "The kept sign-in did not work, so this phone no longer keeps it."
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
            } else if acknowledged || rememberedAccepts(probe) {
                trust = "accepted"
            } else {
                return
            }
        } else if probe.plainHTTP, plainAccepted || rememberedAccepts(probe) {
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
                let why = reply.text ?? "\(probe.hostId) did not begin the setup."
                // THE REMEMBERED MACHINE IS A FIRST TRY, NOT THE ONLY ONE:
                // switched off, or no longer in the fleet, and every machine
                // is asked instead, with the reason kept on screen.
                if viaMemory {
                    await self.probe()
                    refuse("\(why) Your other machines were asked instead.")
                    return
                }
                refuse(why)
                return
            }
            let machine = reply.hostId ?? probe.hostId
            let can = setup.can ?? []
            // A POLICY CHANGE GOES ONLY TO A MACHINE THAT SAYS IT CAN TAKE
            // ONE, asked before anything is sealed: an older machine would
            // open the sign-in, ignore `purpose`, and run onboarding with it,
            // making a token nobody asked for.
            if isPolicy, !can.contains("policy") {
                _ = try? await fleet.cancelSetup(job: begunJob)
                refuse("\(machine) is older than changing what the fleet may use, so the sign-in was not sent. Update that machine, then try again.")
                return
            }
            // AND A SETUP GOES ONLY TO A MACHINE NEW ENOUGH TO HAND THE TOKEN
            // BACK. An older one keeps the pool's token in a file of its own,
            // which is exactly what this app tells the person does not happen,
            // and it resets what the fleet may use to its defaults on the way.
            // Seen: a machine that had the release on disk but a sidecar still
            // running the one before. `can` came in the release after the
            // hand-off, so a machine that sends none is older than both.
            if !isPolicy, can.isEmpty {
                _ = try? await fleet.cancelSetup(job: begunJob)
                refuse("\(machine) is running a Fleetwright older than this app, and an older machine keeps the pool’s token itself instead of handing it to this phone. Nothing was sent. Update that machine (Update, then Restart to apply), then try again.")
                return
            }
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
            begun = Begun(job: begunJob, hostId: machine, address: target, key: key, fingerprint: fingerprint, can: can)
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
        if isPolicy {
            await sendForPolicy(begun)
            return
        }
        busy = true
        defer { busy = false }
        let sealed: [String: String]
        // WHERE THE TOKEN COMES BACK TO, inside the same seal as the sign-in,
        // so the coordinator cannot swap in a key of its own (XOSetupHandoff).
        let reply = XOSetupHandoff.newKey(job: begun.job, address: begun.address)
        do {
            sealed = try Seal.seal(
                to: begun.key,
                aad: Seal.xosetupAAD(job: begun.job, address: begun.address),
                payload: [
                    "v": 1,
                    "xo": ["email": email.trimmingCharacters(in: .whitespacesAndNewlines), "password": password],
                    "reply": reply.publicKey,
                ]
            )
        } catch {
            XOSetupHandoff.forget(job: begun.job)
            refuse(error.localizedDescription)
            return
        }
        pendingSave = chosen.flatMap { entryToKeep($0) }
        password = ""
        toCompare = nil
        let joined = "\(sealed["epk"] ?? "").\(sealed["iv"] ?? "").\(sealed["ct"] ?? "")"
        do {
            let answer = try await fleet.runSetup(job: begun.job, sealed: joined)
            guard answer.ok != false else {
                XOSetupHandoff.forget(job: begun.job)
                refuse(answer.text ?? "\(begun.hostId) did not take the sign-in.")
                return
            }
            hostId = begun.hostId
            progress = answer.xosetup
            job = begun.job
            self.begun = nil
            XOSetupActivities.start(fleet: fleet, job: begun.job, hostId: begun.hostId, address: begun.address, progress: answer.xosetup)
        } catch {
            // NOT FORGOTTEN: the send may have arrived and the job be running,
            // and the key is what its token comes back to. The next launch
            // asks, and drops it if the fleet never heard of the job.
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

    /// The sign-in for a policy job: the same seal to the same job key under
    /// the same binding as onboarding's, saying `purpose: policy` inside it,
    /// where the coordinator cannot change it.
    ///
    /// WHERE THE POOL COMES BACK TO is a key made here and held in this
    /// screen's memory and nowhere else: not XOSetupHandoff's, which waits in
    /// the Keychain for a token, because nothing comes back to a policy job
    /// once this screen is gone. The machine waits ten minutes for a choice
    /// and then lets go, so a key kept past the screen would open nothing.
    @MainActor
    private func sendForPolicy(_ begun: Begun) async {
        // Asked again here, where the seal is, so no path reaches it without.
        guard begun.can.contains("policy") else {
            _ = try? await fleet.cancelSetup(job: begun.job)
            self.begun = nil
            refuse("\(begun.hostId) is older than changing what the fleet may use, so the sign-in was not sent. Update that machine, then try again.")
            return
        }
        busy = true
        defer { busy = false }
        let reply = Seal.newKey()
        let sealed: [String: String]
        do {
            sealed = try Seal.seal(
                to: begun.key,
                aad: Seal.xosetupAAD(job: begun.job, address: begun.address),
                payload: [
                    "v": 1,
                    "xo": ["email": email.trimmingCharacters(in: .whitespacesAndNewlines), "password": password],
                    "reply": reply.publicKey,
                    "purpose": "policy",
                ]
            )
        } catch {
            refuse(error.localizedDescription)
            return
        }
        pendingSave = chosen.flatMap { entryToKeep($0) }
        password = ""
        toCompare = nil
        let joined = "\(sealed["epk"] ?? "").\(sealed["iv"] ?? "").\(sealed["ct"] ?? "")"
        do {
            let answer = try await fleet.runSetup(job: begun.job, sealed: joined)
            guard answer.ok != false else {
                refuse(answer.text ?? "\(begun.hostId) did not take the sign-in.")
                return
            }
            policyJob = PolicyJob(key: begun.key, address: begun.address, reply: reply, canEdge: begun.can.contains("edge"),
                                  anyWayOut: begun.can.contains("egress-any"), edgeDisk: begun.can.contains("edge-disk"),
                                  canImage: begun.can.contains("image"), canImages: begun.can.contains("images"),
                                  canGroups: begun.can.contains("groups"),
                                  canHolder: begun.can.contains("holder"))
            hostId = begun.hostId
            progress = answer.xosetup
            job = begun.job
            self.begun = nil
        } catch {
            // The send may have arrived. Then the machine reads the pool and
            // waits for a choice nobody can make, and lets go after ten
            // minutes having changed nothing; a new Begin cancels it sooner.
            refuse(error.localizedDescription)
        }
    }

    /// What the fleet said about a policy job. The inventory is opened the
    /// first time it is seen and never again, so a poll does not put back a
    /// choice the person is halfway through; and the keys go the moment the
    /// job is over, whichever way it ended.
    @MainActor
    private func applyPolicyState(_ state: Fleet.SetupState, job: String) async {
        if state.state == "choosing", inventory == nil, let sealed = state.inventory, let policyJob {
            if let opened = XOPolicy.open(sealed, job: job, address: policyJob.address, key: policyJob.reply) {
                withAnimation(Design.Motion.change) {
                    inventory = opened
                    choice = XOPolicy.Choice.initial(for: opened, anyWayOut: policyJob.anyWayOut)
                    choice.edgeDiskChoice = policyJob.edgeDisk
                    choice.imageChoice = policyJob.canImage
                    choice.imagesChoice = policyJob.canImages && opened.imageKinds != nil
                    choice.groupsChoice = policyJob.canGroups && opened.groups != nil
                    choice.holderChoice = policyJob.canHolder && opened.holders != nil
                }
            } else {
                // NOT SHOWN, AND LET GO: a pool this phone cannot read is not
                // one it can choose for, and the machine is holding a signed-in
                // session open waiting.
                refuse("What \(hostId) read did not open with this phone’s key, so it is not shown and nothing was changed. "
                       + "It has been asked to stop; try again.")
                _ = try? await fleet.cancelSetup(job: job)
                cancelRequested = true
            }
        }
        if let now = state.state, !XOSetupWords.isLive(now), now != "choosing" {
            policyJob = nil
            inventory = nil
        }
    }

    /// The person's choice, sealed to the job's key under the policy binding
    /// and sent. A choice the machine refuses leaves the job waiting, and its
    /// sentence is shown under the form, which stays.
    @MainActor
    private func applyPolicy(_ inv: XOPolicy.Inventory, job: String) async {
        guard let policyJob, choice.problem(in: inv) == nil else { return }
        busy = true
        defer { busy = false }
        result = ""
        failed = false
        let sealed: [String: String]
        do {
            sealed = try Seal.seal(
                to: policyJob.key,
                aad: Seal.xosetupPolicyAAD(job: job, address: policyJob.address),
                payload: choice.payload(in: inv)
            )
        } catch {
            refuse(error.localizedDescription)
            return
        }
        let joined = "\(sealed["epk"] ?? "").\(sealed["iv"] ?? "").\(sealed["ct"] ?? "")"
        do {
            let answer = try await fleet.setupPolicy(job: job, sealed: joined)
            if answer.ok != false {
                // ON THE LOCK SCREEN FROM HERE, while it applies and builds,
                // at the step it is on: the last, `apply`, of however many
                // the machine said there are.
                let of = answer.xosetup?.of ?? progress?.of ?? 0
                let applying = XOSetupAttributes.ContentState(step: max(of - 1, 0), of: of, phase: "apply", state: "running", since: Date())
                XOSetupActivities.start(fleet: fleet, job: job, hostId: hostId, address: policyJob.address,
                                        progress: answer.xosetup, purpose: "policy", otherwise: applying)
            }
            if let state = answer.xosetup { await apply(state) }
            if answer.ok == false { refuse(answer.text ?? "\(hostId) did not take that choice.") }
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
        guard let job else { return }
        notePath(state)
        if isPolicy {
            await applyPolicyState(state, job: job)
            // The Lock Screen hears it too once there is an activity, which
            // is from Apply on. Not while choosing: a poll that left before
            // Apply and lands after it would end the activity as not live.
            if state.state != "choosing" { await XOSetupActivities.apply(job: job, progress: state) }
            return
        }
        let (outcome, inFleet) = await XOSetupHandoff.collectAndKeep(job: job, state: state, settings: settings)
        if let outcome { handedBack = outcome }
        if let inFleet { fleetNote = inFleet }
        if state.state == "failed" || state.state == "cancelled" { XOSetupHandoff.forget(job: job) }
        await XOSetupActivities.apply(job: job, progress: state)
    }

    private func reset() {
        job = nil
        progress = nil
        begun = nil
        cancelRequested = false
        handedBack = nil
        policyJob = nil
        inventory = nil
        choice = XOPolicy.Choice()
        toCompare = nil
        // A kept password comes back for the next try; a typed one does not.
        password = remembered?.login?.password ?? ""
        pendingSave = nil
        keepNote = ""
        result = ""
        failed = false
    }

    private func refuse(_ text: String) {
        // Nothing waits to be kept for a send that did not go.
        pendingSave = nil
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
