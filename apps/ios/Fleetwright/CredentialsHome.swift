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
struct CredentialsHome: View {
    let settings: Settings

    var body: some View {
        Form {
            Section {
                if PhoneGitHub(settings: settings).signedIn {
                    YourVault(settings: settings)
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

            Section {
                NavigationLink("Linked on machines") {
                    CredentialsView(settings: settings, host: nil, linkedOnly: true)
                }
            } footer: {
                Text("A token goes to every machine in the fleet, because it is yours rather than any one box's. Claude is per person too: a session runs on the account of whoever started it.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Credentials")
    }

    private func sectionHead(_ text: String) -> some View {
        Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
    }
}
