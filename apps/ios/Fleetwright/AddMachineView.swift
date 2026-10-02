import SwiftUI

/// Adding a machine, by the three routes there are.
///
/// It was one section holding five controls (the pin, the runner repository,
/// this phone's GitHub sign-in with the vault inside it, a standalone
/// temporary machine, runner tokens), drawn above the machine list on the
/// screen people open when something is wrong. A route is a short block here,
/// and the setup a route depends on lives under You, once.
///
///   A box you have           a pin, and the one line that installs and joins it
///   A machine for a while    started from New session, with work already on it
///   A repository's workflow  a runner token, for a workflow started by hand
///
/// THE STANDALONE TEMPORARY MACHINE IS GONE. It started a machine with nothing
/// on it, which spent Actions minutes until the person came back to start a
/// session, and it explained itself in different words from New session's,
/// which does the same thing with the work already attached.
struct AddMachineView: View {
    let settings: Settings

    @State private var pin = ""
    /// THE ONE LINE THAT INSTALLS A BOX AND JOINS IT with the pin in hand, or
    /// nil when this coordinator publishes no installer. The pin rides in the
    /// command as an environment variable, never in the URL.
    @State private var pinInstall: String?
    @State private var ephemeralPin = false
    @State private var result = ""
    /// Where a temporary machine would come from, or nil when this fleet
    /// cannot start one. Nil until asked as well, which draws neither answer.
    @State private var runnerRepo: String?
    @State private var runnersAnswered = false

    private var formattedPin: String {
        pin.count == 6 ? "\(pin.prefix(3)) \(pin.suffix(3))" : pin
    }

    var body: some View {
        Form {
            Section {
                // TEMPORARY IS A PROPERTY OF THE PIN, not of the box. Without it
                // every CI runner enrolled as permanent and left its entry
                // behind when the job ended.
                Toggle("Temporary host (CI runner)", isOn: $ephemeralPin)
                if ephemeralPin {
                    Text("Retired the moment it disconnects, and its key revoked. Never chosen automatically for work — it has the most free capacity in the fleet precisely because it is about to disappear.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }
                Button("Mint a pin for a new host") { Task { await mint() } }
                if !pin.isEmpty {
                    VStack(alignment: .leading, spacing: Design.Space.hair) {
                        Text(formattedPin)
                            .fleetType(.title)
                            .monospaced()
                            .textSelection(.enabled)
                        if let install = pinInstall {
                            // THE LINE IS THE PRODUCT. On a fresh box this is
                            // the whole join.
                            Text("On a fresh box, as root — installs it and joins it:")
                                .fleetType(.label)
                                .foregroundStyle(Design.Palette.inkDim)
                            Text(install)
                                .fleetType(.microMono)
                                .textSelection(.enabled)
                            Text("Already installed: fleetwright-sidecar enrol \(pin)")
                                .fleetType(.microMono)
                                .foregroundStyle(Design.Palette.inkDim)
                        } else {
                            Text("On that box: fleetwright-sidecar enrol \(pin)")
                                .fleetType(.microMono)
                                .foregroundStyle(Design.Palette.inkDim)
                        }
                    }
                }
                if !result.isBlank {
                    Text(result).fleetType(.label).foregroundStyle(Design.Palette.bad)
                }
            } header: {
                sectionHead("A box you have")
            } footer: {
                Text("A pin is good for ten minutes, once. It needs a shell on the box to type it.")
            }

            if runnersAnswered {
                Section {
                    if let repo = runnerRepo {
                        // SAID ONCE, IN THE WORDS NEW SESSION USES. The start
                        // sheet is where a temporary machine is asked for,
                        // because it arrives with the work already on it.
                        Text("Under New session, pick a new machine in Where. It comes from \(repo), boots in a few minutes, and the session starts on it when it joins.")
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.ink)
                    } else {
                        Text("This fleet cannot start one yet. Set up temporary machines under You first.")
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                    }
                    NavigationLink("Temporary machines") { TemporaryMachinesView(settings: settings) }
                } header: {
                    sectionHead("A machine for a while")
                }
            }

            Section {
                // A repository's own workflow, started by hand, joining a
                // runner as you.
                NavigationLink("Runner tokens") { RunnerTokensView(settings: settings) }
            } header: {
                sectionHead("A repository's workflow")
            } footer: {
                Text("A machine started from New session needs no token. A workflow you start yourself needs one, minted here for its repository.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Add a machine")
        .task {
            // NIL INSIDE A SUCCESS IS THE ANSWER "no runner repository"; a
            // failed request leaves the section undrawn rather than claiming
            // either.
            if let got = try? await Fleet(settings: settings).runners() {
                runnerRepo = got
                runnersAnswered = true
            }
        }
    }

    @MainActor
    private func mint() async {
        pin = ""
        pinInstall = nil
        result = ""
        do {
            let minted = try await Fleet(settings: settings).mintHostPin(ephemeral: ephemeralPin)
            pin = minted.code
            pinInstall = minted.install
        } catch {
            result = error.localizedDescription
        }
    }

    private func sectionHead(_ text: String) -> some View {
        Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
    }
}
