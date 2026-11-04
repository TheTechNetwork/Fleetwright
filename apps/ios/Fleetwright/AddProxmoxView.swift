import SwiftUI
import UIKit

/// Add a Proxmox VE cluster: run the setup on a node, paste the line it
/// prints. docs/proxmox.md, "By hand".
///
/// ONE SCREEN, TWO STEPS, AND NO PASSWORD. The setup script runs as root on
/// the node itself (Datacenter › the node › Shell, in Proxmox's own web
/// interface), makes a limited user, its token, a firewall group and the
/// machine image, and prints one line. That line is the whole of what this
/// phone needs, and nothing it carries is a password: the token was born
/// limited, and the cluster's CA comes with it so the boxes can hold the
/// cluster to it. This phone keeps it in the vault as `hypervisor:<address>`,
/// as it keeps a Xen Orchestra pool's token, and the boxes this person
/// approved pick it up within ten minutes (src/fleet/host/pve-pools.js).
///
/// NOT THE XEN ORCHESTRA FLOW. No probe of every box, no machine to pick, no
/// key to compare and no admin sign-in, because no admin credential ever
/// crosses the fleet for Proxmox. Running the setup from this phone over
/// SSH, with the steps on the Lock Screen, is next ("From the phone").
struct AddProxmoxView: View {
    let settings: Settings
    @Environment(\.dismiss) private var dismiss

    @State private var line = ""
    @State private var busy = false
    @State private var result = ""
    @State private var failed = false
    @State private var kept = false
    @State private var copied = false

    /// What the pasted line carries, or nil while it is not one.
    private var parsed: ProxmoxLine.Record? { ProxmoxLine.parse(line) }

    var body: some View {
        Form {
            Section {
                Text(ProxmoxLine.setupCommand)
                    .fleetType(.microMono)
                    .textSelection(.enabled)
                Button(copied ? "Copied" : "Copy the command") {
                    UIPasteboard.general.string = ProxmoxLine.setupCommand
                    copied = true
                }
                .frame(minHeight: 44)
            } header: {
                sectionHead("1. On the node, as root")
            } footer: {
                Text("In Proxmox's web interface: Datacenter › the node › Shell. It makes a pool, a user with no password, its token, a firewall group and the machine image, which takes a few minutes, and prints one line. Proxmox VE 9 or newer.")
            }

            Section {
                TextField("fleetwright-pve:1:…", text: $line, axis: .vertical)
                    .fleetType(.microMono)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(busy || kept)
                if let record = parsed {
                    VStack(alignment: .leading, spacing: Design.Space.hair) {
                        Text(record.address).fleetType(.bodyStrong).monospaced()
                        Text("Pool \(record.pool), \(record.trustWords)")
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                    }
                } else if !line.isBlank {
                    // SAID AS SOON AS IT IS NOT ONE, so a half-copied line is
                    // found before Add, not after.
                    Text("That is not the whole line the setup printed. It starts with fleetwright-pve:1: and is one long line.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.bad)
                }
                // DRAWN ONLY WHEN THERE IS A LINE TO KEEP (C-2).
                if parsed != nil && !kept {
                    Button(busy ? "Adding…" : "Add the cluster") { Task { await keep() } }
                        .disabled(busy)
                        .frame(minHeight: 44)
                }
            } header: {
                sectionHead("2. The line it printed")
            } footer: {
                Text("The line is the cluster's token. It is kept in your vault and handed only to the machines you approved, which hold it in memory.")
            }

            if !result.isBlank {
                Section {
                    Text(result)
                        .fleetType(.label)
                        .foregroundStyle(failed ? Design.Palette.bad : Design.Palette.ink)
                        .textSelection(.enabled)
                    if kept { Button("Done") { dismiss() }.frame(minHeight: 44) }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Add Proxmox VE")
    }

    @MainActor
    private func keep() async {
        guard let record = parsed else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await PhoneVault(settings: settings).keepHypervisor(Fleet(settings: settings), address: record.address, record: record.json)
            kept = true
            failed = false
            line = ""
            // WHAT HAPPENS NEXT, AND WHEN: not "added", which would be a claim
            // about the cluster nobody has checked yet (C-5).
            result = "Kept in your vault. Your machines pick it up within ten minutes and check it against the cluster; it then shows under New session › Where, as Proxmox at \(record.address)."
        } catch {
            failed = true
            result = error.localizedDescription
        }
    }

    private func sectionHead(_ text: String) -> some View {
        Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
    }
}

/// The line `fleetwright-pve-setup` prints, read the way the boxes read it
/// (src/fleet/host/pve-pools.js, `parseConnection` and `recordOf`), so a line
/// this phone keeps is one they take. test/pve-pools.test.js holds the
/// prefix, the command and the shapes to the JavaScript.
enum ProxmoxLine {
    static let prefix = "fleetwright-pve:1:"
    static let scriptURL = "https://raw.githubusercontent.com/TheTechNetwork/Fleetwright/main/install/fleetwright-pve-setup"
    static let setupCommand = "curl -fsSLo /root/fleetwright-pve-setup \(scriptURL) && bash /root/fleetwright-pve-setup"

    struct Record {
        let address: String
        let pool: String
        let trust: String
        /// The record as the line carried it, which is what the vault keeps.
        let json: String

        var trustWords: String {
            trust == "public" ? "trusted by its public certificate" : "trusted by its own CA"
        }
    }

    private static let token = try! NSRegularExpression(pattern: "^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9._-]{1,64}![A-Za-z0-9._-]{1,64}=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    private static let pool = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{1,40}$")
    private static let address = try! NSRegularExpression(pattern: "^(?:\\[[0-9A-Fa-f:.]{2,45}\\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252})(?::\\d{1,5})?$")

    private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    static func parse(_ raw: String) -> Record? {
        // A LINE PASTED FROM A TERMINAL may carry spaces or a break where it
        // wrapped; none belongs in it, so none is kept.
        let s = raw.components(separatedBy: .whitespacesAndNewlines).joined()
        guard s.hasPrefix(prefix) else { return nil }
        var b64 = String(s.dropFirst(prefix.count)).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["kind"] as? String == "proxmox",
              let address = object["address"] as? String, matches(Self.address, address),
              let token = object["token"] as? String, matches(Self.token, token),
              let pool = object["pool"] as? String, matches(Self.pool, pool),
              let json = String(data: data, encoding: .utf8)
        else { return nil }
        // HOW TO TRUST THE CLUSTER, or no record: a CA, or a public certificate.
        let ca = (object["ca"] as? String) ?? ""
        let trust: String
        if ca.hasPrefix("-----BEGIN CERTIFICATE-----") { trust = "ca" }
        else if object["trust"] as? String == "public" { trust = "public" }
        else { return nil }
        return Record(address: address, pool: pool, trust: trust, json: json)
    }
}
