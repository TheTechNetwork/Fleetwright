import Foundation

/// A word the user picks, so "start a dev session" means something.
///
/// A kind is NOT an alias for a phrase. It carries the defaults that would
/// otherwise have to be spoken — which host, safe or dangerous, what to call
/// the session — so one short sentence is a whole configuration. That is the
/// difference between a shortcut and a macro, and it is the reason this is
/// worth storing rather than just accepting free text after "start a".
///
/// Why a stored list rather than free-form speech: Siri cannot register
/// arbitrary phrases for an app, but it CAN expand a parameterised phrase
/// across an AppEntity's suggested values. So a kind the user creates becomes
/// genuinely speakable, within Apple's rules. See docs/naming.md.
struct SessionKind: Codable, Identifiable, Hashable {
    /// Stable across renames, so a Shortcut somebody built keeps working when
    /// they change the word. The word is a label; this is the identity — the
    /// same separation `name` and `title` have on a session.
    var id: String = UUID().uuidString

    /// What you say, and what you see. "dev", "orgi", "triage".
    var word: String

    /// Where it lands. STORED BUT NOT YET SENT: the coordinator's dispatch()
    /// has no placement preference to give it to, so wiring it now would mean a
    /// field that is accepted, ignored, and looks like it worked. Kept in the
    /// model so the editor and the migration exist when the scheduler does, and
    /// deliberately not shown in the UI until then.
    var host: String = ""

    /// nil leaves the fleet default alone. Stored as a string because that is
    /// what the intent carries and there are exactly two valid values.
    var mode: String?

    /// Prefixed onto a generated title, so a list groups by eye without
    /// anybody sorting it. "dev" gives "dev: refactor auth".
    var titlePrefix: String = ""

    var displayName: String { word.isEmpty ? "session" : word }
}

/// Stored in UserDefaults, not the keychain: these are preferences, not
/// credentials. Losing them costs a retype; leaking them costs nothing.
enum SessionKinds {
    private static let key = "sessionKinds"

    static func all() -> [SessionKind] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let kinds = try? JSONDecoder().decode([SessionKind].self, from: data)
        else { return [] }
        return kinds
    }

    static func save(_ kinds: [SessionKind]) {
        // Encoding failure is not silently swallowed into an empty list: that
        // would delete every kind the user has, and the symptom — Siri quietly
        // forgetting a phrase — is one nobody would connect to a save.
        guard let data = try? JSONEncoder().encode(kinds) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    static func upsert(_ kind: SessionKind) {
        var kinds = all()
        if let i = kinds.firstIndex(where: { $0.id == kind.id }) { kinds[i] = kind } else { kinds.append(kind) }
        save(kinds)
    }

    static func remove(id: String) {
        save(all().filter { $0.id != id })
    }

    static func find(word: String) -> SessionKind? {
        let wanted = word.lowercased().trimmingCharacters(in: .whitespaces)
        return all().first { $0.word.lowercased() == wanted }
    }
}
