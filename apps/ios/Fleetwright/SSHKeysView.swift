import SwiftUI

/// Your SSH public keys, kept in your vault, for the machines made on your
/// hypervisor. docs/hypervisors.md, "Working a machine".
///
/// Asked for: "ssh". Kept as the secret SSH_AUTHORIZED_KEYS, one key a line,
/// which the boxes you approved are handed with the rest of your vault. A
/// machine made on your pool after that takes them on its `fleetwright`
/// account, with sudo (src/fleet/host/xo-pools.js, `machineCloudConfig`).
///
/// PUBLIC KEYS ONLY, checked here line by line before anything is sent, and
/// again on the box: a private key pasted by mistake never leaves the phone.
struct SSHKeysView: View {
    let settings: Settings

    @State private var draft = ""
    /// When they were kept, or nil for none; `answered` is whether the vault
    /// has said, since nil before it has is cannot tell.
    @State private var keptAt: Double?
    @State private var answered = false
    @State private var busy = false
    @State private var message = ""
    @State private var failed = false

    static let secretName = "SSH_AUTHORIZED_KEYS"

    private var vault: PhoneVault { PhoneVault(settings: settings) }
    private var fleet: Fleet { Fleet(settings: settings) }

    /// The lines that are something, each checked to be a public key.
    private var lines: [String] {
        draft.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private var notKeys: [String] { lines.filter { !Self.isPublicKey($0) } }

    static func isPublicKey(_ line: String) -> Bool {
        let kinds = ["ssh-ed25519 ", "ssh-rsa ", "ecdsa-sha2-nistp256 ", "ecdsa-sha2-nistp384 ", "ecdsa-sha2-nistp521 ",
                     "sk-ssh-ed25519@openssh.com ", "sk-ecdsa-sha2-nistp256@openssh.com "]
        return kinds.contains { line.hasPrefix($0) } && !line.contains("PRIVATE KEY")
    }

    var body: some View {
        Form {
            Section {
                if !answered {
                    Text("Asking your vault…").fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                } else if let keptAt {
                    Text("Kept in your vault \(relativeTime(keptAt)). Paste them again to replace them.")
                        .fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                } else {
                    Text("None kept yet.").fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                }
                TextEditor(text: $draft)
                    .fleetType(.labelMono)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .frame(minHeight: 120)
                    .accessibilityLabel("Your SSH public keys, one a line")
                if !notKeys.isEmpty {
                    Text("Only public keys, one a line, starting ssh-ed25519, ssh-rsa or ecdsa-sha2. This line is not one: \(notKeys[0].prefix(40))")
                        .fleetType(.label).foregroundStyle(Design.Palette.bad)
                }
                Button(busy ? "Keeping…" : "Keep in your vault") { Task { await keep() } }
                    .disabled(busy || lines.isEmpty || !notKeys.isEmpty)
                    .frame(minHeight: 44)
                if keptAt != nil {
                    Button("Forget them", role: .destructive) { Task { await forget() } }
                        .disabled(busy)
                        .frame(minHeight: 44)
                }
                if !message.isBlank {
                    Text(message).fleetType(.label).foregroundStyle(failed ? Design.Palette.bad : Design.Palette.ink)
                }
            } header: {
                Text("SSH keys").fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
            } footer: {
                Text("A machine made on your hypervisor after you keep them lets you in as fleetwright, with sudo: "
                     + "ssh fleetwright@ and its address, on its page under Machines. Machines already running keep what they were made with.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("SSH keys")
        .task { await load() }
    }

    @MainActor
    private func load() async {
        // A refusal is cannot tell, and leaves the line saying so.
        guard let contents = try? await vault.list(fleet) else { return }
        keptAt = contents.items.first { $0.name == "secret:\(Self.secretName)" }?.at
        answered = true
    }

    @MainActor
    private func keep() async {
        busy = true
        defer { busy = false }
        do {
            message = try await vault.keepSecret(fleet, name: Self.secretName, value: lines.joined(separator: "\n"))
            failed = false
            draft = ""
        } catch {
            message = error.localizedDescription
            failed = true
        }
        await load()
    }

    @MainActor
    private func forget() async {
        busy = true
        defer { busy = false }
        do {
            message = try await vault.forget(fleet, name: "secret:\(Self.secretName)")
            failed = false
        } catch {
            message = error.localizedDescription
            failed = true
        }
        await load()
    }
}
