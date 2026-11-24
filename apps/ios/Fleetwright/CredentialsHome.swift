import SwiftUI

/// Credentials: everything a session of yours may use, in one place.
///
/// Claude was in six places, GitHub in four, and the vault (the one place each
/// credential is meant to be kept once) was hidden under Add a machine, drawn
/// only after a GitHub sign-in that called itself "for runners". This is the
/// one screen now, VAULT FIRST: keep Claude, GitHub, Cloudflare and named
/// secrets here once, and approve the boxes that may hold them from each
/// box's page. A credential linked on one box the older way is listed below,
/// as a fact with Forget, not as a second Connect button.
///
/// Signing in to Claude on one machine, which needs nothing but the phone,
/// stays on that machine's page.
///
/// YOUR MANAGERS, when the organization gives this person any
/// (docs/members.md, "Custodians of a person member"). A person's vault holds
/// their own sign-ins, so a manager manages it only after the person turns
/// that on here, from their own device, and what a manager then changes is
/// listed under the switch. Drawn from the vault's own answer and from
/// nothing the fleet says: a vault that could not be asked draws no section.
struct CredentialsHome: View {
    let settings: Settings
    /// Who else may manage this vault, as the vault last said. Nil until it
    /// has, and from a vault older than the organization.
    @State private var custody: PhoneVault.Custody?
    @State private var custodyBusy = false
    @State private var custodyResult = ""
    @State private var custodyFailed = false

    var body: some View {
        Form {
            Section {
                if PhoneGitHub(settings: settings).signedIn {
                    YourVault(settings: settings, onListed: { custody = $0.custody })
                    // FOR THE MACHINES ON YOUR HYPERVISOR: kept like any
                    // secret, given its own row because it is pasted, not typed.
                    NavigationLink("SSH keys") { SSHKeysView(settings: settings) }
                } else {
                    // The vault knows a person by this phone's GitHub sign-in,
                    // so the sign-in is offered at the point it is needed.
                    PhoneGitHubSignIn(settings: settings)
                }
            } header: {
                sectionHead("Your vault")
            }

            // ONLY FOR SOMEBODY SOMEBODY ELSE MAY MANAGE: a member of their
            // own in the vault's tree, and whoever added them or a manager
            // above it. Anybody else has nothing here to read or switch (C-2).
            if let custody, custody.member != nil, !(custody.custodians.isEmpty && custody.managers.isEmpty) {
                Section {
                    // WHOEVER ADDED THEM MANAGES WHAT THEY KEEP, with no
                    // switch: said first, where they keep things, so it is
                    // read before anything is kept. Not theirs to end, so no
                    // control is drawn for it (C-2); the sentence says whose it is.
                    ForEach(custody.custodians, id: \.self) { address in
                        Text("\(address) added you, and manages your credentials.")
                            .fleetType(.body)
                            .foregroundStyle(Design.Palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                    if !custody.custodians.isEmpty {
                        Text(addedSentence)
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    // EVERY OTHER MANAGER waits on this switch, which is theirs alone.
                    if !custody.managers.isEmpty {
                        Toggle(custody.custodians.isEmpty ? "Let my managers manage my credentials" : "Let my other managers manage my credentials", isOn: Binding(
                            get: { custody.allow },
                            set: { allow in Task { await setCustody(allow) } }
                        ))
                        .disabled(custodyBusy)
                        .frame(minHeight: 44)
                        Text(custodySentence)
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                            .fixedSize(horizontal: false, vertical: true)
                        ForEach(custody.managers, id: \.self) { address in
                            Text(address)
                                .fleetType(.body)
                                .foregroundStyle(Design.Palette.ink)
                                .textSelection(.enabled)
                        }
                    }
                    // WHAT THEY CHANGED, newest first, by name and never by
                    // value. The vault keeps this beside what it holds, so it
                    // is here whether or not a notification arrived.
                    Text("What they changed")
                        .fleetType(.bodyStrong)
                        .foregroundStyle(Design.Palette.ink)
                    if custody.log.isEmpty {
                        Text("Nothing yet.")
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                    } else {
                        ForEach(custody.log.sorted(by: { $0.at > $1.at }), id: \.self) { change in
                            Text(PhoneVault.custodyLine(change, when: relativeTime(change.at)))
                                .fleetType(.label)
                                .foregroundStyle(Design.Palette.ink)
                        }
                    }
                    if !custodyResult.isBlank {
                        Text(custodyResult)
                            .fleetType(.label)
                            .foregroundStyle(custodyFailed ? Design.Palette.bad : Design.Palette.ink)
                            .textSelection(.enabled)
                    }
                } header: {
                    sectionHead("Your managers")
                }
            }

            Section {
                NavigationLink("Linked on machines") {
                    CredentialsView(settings: settings, host: nil, linkedOnly: true)
                }
            } footer: {
                Text("Everything a session you start uses comes from your vault, on the machines you approve.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Credentials")
    }

    /// Turn it on or off, say what the vault said, then show custody as the
    /// vault now holds it. A refusal is the vault's sentence, in the error
    /// colour, and the switch stays where the vault left it.
    @MainActor
    private func setCustody(_ allow: Bool) async {
        custodyBusy = true
        defer { custodyBusy = false }
        let vault = PhoneVault(settings: settings)
        let fleet = Fleet(settings: settings)
        do {
            custodyResult = try await vault.setCustody(fleet, allow: allow)
            custodyFailed = false
        } catch {
            custodyResult = error.localizedDescription
            custodyFailed = true
        }
        if let now = try? await vault.list(fleet) { custody = now.custody }
    }

    private func sectionHead(_ text: String) -> some View {
        Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
    }
}

/// What turning the switch on gives a manager, said under it. The same
/// sentence on both phones (test/members-in-apps.test.js).
let custodySentence = "They can keep, test and remove what your vault holds, approve machines for it, and start sessions as you. You can turn this off."

/// What whoever added a person may do, and whose it is to end, said under
/// their address. The same sentence on both phones.
let addedSentence = "They can keep, test and remove what your vault holds, approve machines for it, and start sessions as you. They or an org admin can end this, and you can still remove anything your vault keeps."
