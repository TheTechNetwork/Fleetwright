import Foundation
import LocalAuthentication
import Security

/// What this phone remembers about reaching a Xen Orchestra pool, so the next
/// change starts where the last one worked instead of from nothing.
///
/// TWO THINGS, KEPT APART BECAUSE ONLY ONE IS A SECRET.
///
/// The machine that last got through, by address, in UserDefaults. It is a
/// host name the Machines tab already shows, and it is what is asked first:
/// the screen opens on that machine instead of on "Asking your machines…",
/// and asks every machine only when it cannot get through (docs/hypervisors.md,
/// "The path it used last").
///
/// The admin sign-in and the person's acceptance of the certificate, only
/// when they turned on "Keep on this phone", in one Keychain item per address
/// that opens only to Face ID or Touch ID: `.biometryCurrentSet`, so adding a
/// face or a finger to the phone retires it, and `WhenPasscodeSetThisDeviceOnly`,
/// so it never leaves this phone in a backup and goes if the passcode does.
/// The acceptance is kept as the fingerprint that was accepted (or "plain
/// HTTP" for an address with no certificate), so it stands for that
/// certificate and no other: a server that answers with a different one is
/// asked about again, in full.
///
/// THE FLEET NEVER SEES ANY OF IT. What leaves the phone is what always left
/// it: the sign-in sealed to one job's key on one machine (AddHypervisorView).
/// Keeping it here moves the moment of typing it, not where it goes.
///
/// WHICH ADDRESSES HAVE ONE is a list beside it in UserDefaults, because
/// asking the Keychain whether an item exists would put Face ID up. A list
/// entry whose item is gone (a restore to another phone, a new face) is
/// dropped the first time opening it finds nothing.
enum XOSaved {
    private static let viaKey = "hypervisors.via"
    private static let savedKey = "hypervisors.saved"
    private static let service = "network.thetech.fleetwright.xo-saved"

    /// What a person chose to keep for one address.
    struct Entry: Codable, Equatable {
        struct Login: Codable, Equatable {
            let email: String
            let password: String
        }

        /// The certificate the person accepted, by fingerprint, or `plain`
        /// for an address they accepted had no HTTPS at all.
        struct Accepted: Codable, Equatable {
            let pin: String?
            let plain: Bool
        }

        var login: Login?
        var accepted: Accepted?
        var savedAt: Date

        var isEmpty: Bool { login == nil && accepted == nil }

        /// Whether this acceptance is for what that machine found: the same
        /// fingerprint, or plain HTTP both times. Anything else is a
        /// different server as far as the person's word goes.
        func accepts(_ probe: Fleet.Probe) -> Bool {
            guard let accepted else { return false }
            if let cert = probe.cert { return accepted.pin == cert }
            return probe.plainHTTP && accepted.plain
        }
    }

    // MARK: The machine that got through

    static func machine(for address: String) -> String? {
        (UserDefaults.standard.dictionary(forKey: viaKey) as? [String: String])?[address]
    }

    static func rememberMachine(_ hostId: String, for address: String) {
        var all = (UserDefaults.standard.dictionary(forKey: viaKey) as? [String: String]) ?? [:]
        all[address] = hostId
        UserDefaults.standard.set(all, forKey: viaKey)
    }

    // MARK: The sign-in, behind Face ID

    /// "Face ID", "Touch ID" or "Optic ID" when this phone can keep something
    /// behind one, or nil: no biometrics enrolled, or none on the device.
    /// Nil means the screen does not offer to keep anything (C-2), because
    /// the item could not be made.
    static func biometryName() -> String? {
        let context = LAContext()
        var problem: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &problem) else { return nil }
        switch context.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return nil
        }
    }

    /// An item is kept for this address, by the list beside the Keychain.
    static func has(_ address: String) -> Bool {
        (UserDefaults.standard.stringArray(forKey: savedKey) ?? []).contains(address)
    }

    private static func query(_ address: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: address,
        ]
    }

    /// Keep it, replacing whatever was kept. Writing needs no Face ID; only
    /// reading does. False when the Keychain refused, which the screen says.
    @discardableResult
    static func save(_ entry: Entry, for address: String) -> Bool {
        SecItemDelete(query(address) as CFDictionary)
        guard !entry.isEmpty else {
            list(address, kept: false)
            return true
        }
        guard let data = try? JSONEncoder().encode(entry),
              let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, nil)
        else { return false }
        var item = query(address)
        item[kSecValueData as String] = data
        item[kSecAttrAccessControl as String] = access
        let ok = SecItemAdd(item as CFDictionary, nil) == errSecSuccess
        list(address, kept: ok)
        return ok
    }

    /// Open it, which puts Face ID up with `reason` under it. Nil when the
    /// person cancels, the face does not match, or nothing is kept; the last
    /// one also takes the address off the list, so it is not asked again.
    static func unlock(_ address: String, reason: String) async -> Entry? {
        guard has(address) else { return nil }
        let context = LAContext()
        context.localizedReason = reason
        var item = query(address)
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        item[kSecUseAuthenticationContext as String] = context
        let asked = item as CFDictionary
        // SecItemCopyMatching waits for the face, so not on the main actor.
        let (status, data): (OSStatus, Data?) = await Task.detached {
            var out: CFTypeRef?
            let status = SecItemCopyMatching(asked, &out)
            return (status, out as? Data)
        }.value
        if status == errSecItemNotFound {
            list(address, kept: false)
            return nil
        }
        guard status == errSecSuccess, let data else { return nil }
        return try? JSONDecoder().decode(Entry.self, from: data)
    }

    /// Nothing kept for this address any more.
    static func forget(_ address: String) {
        SecItemDelete(query(address) as CFDictionary)
        list(address, kept: false)
    }

    private static func list(_ address: String, kept: Bool) {
        var all = (UserDefaults.standard.stringArray(forKey: savedKey) ?? []).filter { $0 != address }
        if kept { all.append(address) }
        UserDefaults.standard.set(all, forKey: savedKey)
    }
}
