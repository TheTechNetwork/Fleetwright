import AppIntents
import AuthenticationServices
import SwiftUI
import UIKit

/// The You tab: who you are on this fleet, what your sessions may use, how the
/// app reaches you, and the setup that is done once.
///
/// FIRST RUN IS ONE BLOCK, IN ORDER. The coordinator URL was on the Fleet tab
/// and the sign-in on Settings, which said "Add a coordinator URL above first"
/// about a field that was not above it, on a tab a fresh install opened on.
/// Signed out, this screen is the fleet's address, the sign-in under it, and
/// the demo. Signed in, the address is a fact with "Sign out to change it":
/// editing it by accident is how every request starts going somewhere else.
///
/// Each finished piece of setup is one row: Credentials, Temporary machines,
/// Linked repositories, Devices, Siri and Shortcuts. What only an admin can do (People) is drawn
/// for an admin and nobody else.
struct YouView: View {
    let settings: Settings

    @State private var signInResult = ""
    @State private var signingIn = false
    @State private var pushResult = ""
    /// The temporary machines row's summary, once the fleet has said.
    @State private var runnersAnswered = false
    @State private var runnersSaved: String?
    @State private var runnersFleet: String?
    /// How many roles this person has linked a repository for, once the
    /// fleet has said; nil until then, and the row is not drawn.
    @State private var linkedCount: Int?

    private var signedIn: Bool { !settings.credential.isEmpty }
    private var inDemo: Bool { Demo.isActive(settings.coordinatorURL) }

    var body: some View {
        Form {
            if !signedIn {
                firstRun
            } else if inDemo {
                demoSection
            } else {
                accountSection
                Section {
                    NavigationLink("Credentials") { CredentialsHome(settings: settings) }
                    NavigationLink {
                        TemporaryMachinesView(settings: settings)
                    } label: {
                        LabeledContent("Temporary machines") {
                            if runnersAnswered {
                                Text(describeTemporaryMachines(saved: runnersSaved, fleet: runnersFleet))
                                    .fleetType(.label)
                            }
                        }
                    }
                    // THE THREE ROLES A REPOSITORY CAN BE LINKED FOR, in one
                    // place (#346). Drawn only once the fleet has answered for
                    // this person: an older coordinator, or a credential that
                    // is not a person's, has nothing it could link.
                    if let linkedCount {
                        NavigationLink {
                            LinkedReposView(settings: settings)
                        } label: {
                            LabeledContent("Linked repositories") {
                                Text(describeLinkedRepos(linkedCount)).fleetType(.label)
                            }
                        }
                    }
                }
            }

            if signedIn {
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
                    sectionHead("Notifications")
                }
            }

            Section {
                NavigationLink("Siri and Shortcuts") { VoiceView(settings: settings) }
            }

            if signedIn {
                fleetSection
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("You")
        .task(id: settings.credential) { await loadRunners() }
    }

    // MARK: - the parts

    @ViewBuilder private var firstRun: some View {
        Section {
            TextField("https://fleet.thetech.network", text: Bindable(settings).coordinatorURL)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .keyboardType(.URL)
                .textContentType(.URL)
            SignInWithAppleButton(.signIn, onRequest: SignIn.configure, onCompletion: signIn)
                .signInWithAppleButtonStyle(.black)
                .frame(height: 44)
                .disabled(settings.coordinatorURL.isEmpty || signingIn)
            // WHY IT IS GREY, SAID OUT LOUD, about the field that really is
            // just above it now. A disabled control with no reason beside it
            // reads as a broken app.
            if settings.coordinatorURL.isEmpty {
                Text("Enter your fleet's address first — signing in means signing in to a fleet.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
            if !signInResult.isEmpty {
                Text(signInResult).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
            }
            // ONE TAP INTO A FLEET THAT ISN'T REAL. The real coordinator is
            // REMEMBERED, not discarded: somebody who has already pointed this
            // app at their own fleet and taps out of curiosity gets it back
            // when they leave.
            Button("Look around the demo fleet") {
                if !settings.coordinatorURL.isEmpty && !Demo.isActive(settings.coordinatorURL) {
                    settings.urlBeforeDemo = settings.coordinatorURL
                }
                settings.coordinatorURL = Demo.coordinatorURL
                settings.signedInAs = Demo.label
                settings.credential = Demo.credential
            }
        } header: {
            sectionHead("Your fleet")
        } footer: {
            // Said before somebody hits the button and gets a refusal they
            // cannot interpret: a fleet is a list of allowed addresses, and
            // Hide My Email can never be on it.
            Text("Choose \"Share My Email\" — a fleet allows people by address, and a hidden one matches nothing. "
                 + "This device gets a credential of its own, revocable on its own.")
        }
    }

    @ViewBuilder private var demoSection: some View {
        Section {
            // Said plainly, and never as "signed in". A person wondering why
            // their machines are missing deserves the answer on the screen.
            LabeledContent("Demo") { Text("invented hosts and sessions") }
            Button("Leave the demo") {
                settings.signOut()
                settings.coordinatorURL = settings.urlBeforeDemo
                settings.urlBeforeDemo = ""
            }
        } header: {
            sectionHead("You")
        }
    }

    @ViewBuilder private var accountSection: some View {
        Section {
            LabeledContent("Signed in") {
                Text(settings.signedInAs.isEmpty ? "this device" : settings.signedInAs)
            }
            NavigationLink("Devices") { DevicesView(settings: settings) }
            Button("Sign out", role: .destructive) { settings.signOut() }
        } header: {
            sectionHead("Account")
        }
        // THE OTHER ACCOUNT THIS PHONE HOLDS. It was under Add a machine as
        // "Runners from this phone"; it starts your temporary machines and it
        // is how your vault knows you.
        Section {
            PhoneGitHubSignIn(settings: settings)
        } header: {
            sectionHead("GitHub on this phone")
        }
    }

    @ViewBuilder private var fleetSection: some View {
        Section {
            LabeledContent("Coordinator") {
                Text(settings.coordinatorURL)
                    .fleetType(.label)
                    .textSelection(.enabled)
            }
            // WHO ELSE IS ALLOWED IN, for the one person who can say. A member
            // was shown this and refused after the tap.
            if settings.showsAdmin && !inDemo {
                NavigationLink("People") { PeopleView(settings: settings) }
            }
            // WHAT THE PEOPLE YOU INVITE SEE, for the one person who can ask.
            // The coordinator answers as it would a member, so this is their
            // view rather than this one with rows hidden.
            if settings.admin == true && !inDemo {
                Toggle("View as a member", isOn: Bindable(settings).viewAsMember)
                if settings.viewAsMember {
                    Text("Every screen shows what a member of this fleet sees: their own sessions, no People, no revoking. Your credential is still an admin's.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }
            }
        } header: {
            sectionHead("This fleet")
        } footer: {
            // WHICH BUILD THIS IS. The marketing version is the same across
            // every TestFlight build of a release, so "it is still broken" and
            // "you do not have the fix yet" are the same sentence when nobody
            // can name the build they are on.
            Text("Sign out to point this app at a different fleet.\n\nFleetwright \(Bundle.main.shortVersion) (build \(Bundle.main.buildNumber))")
        }
    }

    // MARK: - actions

    @MainActor
    private func loadRunners() async {
        guard settings.configured else {
            runnersAnswered = false
            return
        }
        if let got = try? await Fleet(settings: settings).runnerRepoSetting(), got.ok != false {
            runnersAnswered = true
            runnersSaved = got.repo
            runnersFleet = got.fleet
        }
        if let linked = try? await Fleet(settings: settings).linkedRepos(), linked.ok != false {
            linkedCount = linked.links?.count ?? 0
        }
    }

    /// Deliberately NOT `@MainActor` on the function itself: it is handed to
    /// `SignInWithAppleButton` as a plain closure, and a global-actor-isolated
    /// function converted to a non-isolated one loses its isolation.
    /// `Task { @MainActor in }` says it where it is needed.
    private func signIn(_ result: Result<ASAuthorization, Error>) {
        Task { @MainActor in
            signingIn = true
            signInResult = "signing in…"
            defer { signingIn = false }
            do {
                let idToken = try SignIn.identityToken(from: result)
                let issued = try await Fleet(settings: settings).signIn(
                    idToken: idToken,
                    // Names the credential in the fleet's device list: the
                    // difference between "revoke the right phone" and "revoke
                    // one of three called iPhone".
                    deviceName: UIDevice.current.name
                )
                settings.credential = issued.token
                settings.signedInAs = issued.email
                signInResult = ""
            } catch SignIn.Failure.cancelled {
                signInResult = ""
            } catch {
                signInResult = error.localizedDescription
            }
        }
    }

    private func sectionHead(_ text: String) -> some View {
        Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
    }
}

/// Siri and Shortcuts, on a screen of its own: the words Siri hears, a phrase
/// of your own, and the system's Shortcuts.
struct VoiceView: View {
    let settings: Settings

    var body: some View {
        Form {
            Section {
                NavigationLink("Session kinds") { SessionKindsView(settings: settings) }
                // A phrase with no app name in it at all. Apple requires the
                // app name in the phrases WE ship; a shortcut somebody makes
                // themselves has no such rule.
                NavigationLink("Add a Siri phrase") { ShortcutSetupView(settings: settings) }
                ShortcutsLink()
            } footer: {
                Text("Say \"start a dev session on my fleet\". Saying \"and open it\" brings the app forward.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Siri and Shortcuts")
    }
}
