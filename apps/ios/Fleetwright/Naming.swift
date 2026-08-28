import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

/// Turning "what is this about?" into a title.
///
/// THE POINT, because it is easy to mistake this for a gimmick: the blank name
/// field asks for the HARDEST form of the information — a compressed label —
/// as the FIRST input, about work that has not happened yet. That is where
/// people stall, and stalling at a text field is where they close the app. So
/// the description is what gets typed and the name is a suggestion. Generation
/// is not decoration here; it is what makes the field answerable.
///
/// ON DEVICE, for three reasons in this order:
///
///  1. The brief is about work in progress. Sending it away to get three words
///     back is a trade nobody consciously agreed to.
///  2. It works on a plane, on hotel wifi, and with the coordinator down.
///  3. It is instant. A suggestion that arrives after a beat is one you have
///     already typed past.
///
/// AND IT IS NEVER ON THE CRITICAL PATH. Apple Intelligence is not on every
/// device, and a feature that only works on recent hardware cannot be the only
/// way to name a session. When there is no model, `fallback` runs — the first
/// few words of the brief, which is what a person would have typed anyway.
enum Naming {
    /// Longest title we will suggest. Matches TITLE_MAX in src/core/text.js;
    /// the coordinator refuses anything longer, and a suggestion the server
    /// then rejects is worse than no suggestion.
    static let maxTitle = 60

    /// True when the on-device model can actually run right now.
    ///
    /// Three distinct states, not two: unsupported hardware, supported but the
    /// user has Apple Intelligence off, and supported but the model is still
    /// downloading. The UI does not need to tell them apart — it needs to know
    /// whether to offer the button at all — but they are why this is a runtime
    /// check and not a device-model check.
    static var canSuggest: Bool {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            return SystemLanguageModel.default.availability == .available
        }
        #endif
        return false
    }

    /// A title for this brief. Never throws: the fallback is always available,
    /// and a naming feature that can fail is a naming feature that blocks a
    /// session from starting.
    static func suggest(for brief: String) async -> String {
        let trimmed = brief.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }

        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *), SystemLanguageModel.default.availability == .available {
            let instructions = """
            You name programming work sessions. Given a description, reply with a \
            short label of two to five words, lower case, no punctuation, no \
            quotes, and no trailing full stop. Name the work, not the person. \
            Reply with the label and nothing else.
            """
            do {
                let session = LanguageModelSession(instructions: instructions)
                let response = try await session.respond(to: trimmed)
                let cleaned = clean(response.content)
                // An empty or absurd answer falls back rather than being shown.
                // A model that returns a paragraph should not produce a title
                // that the coordinator will then refuse.
                if !cleaned.isEmpty { return cleaned }
            } catch {
                // Deliberately silent. The user asked for a name, not for a
                // report on model availability, and there is a good answer
                // available without one.
            }
        }
        #endif

        return fallback(for: trimmed)
    }

    /// The first few words, which is what somebody would have typed themselves.
    ///
    /// Not a placeholder to be embarrassed about: for "split the token check
    /// out of the middleware" it gives "split the token check out", which is
    /// recognisable in a list a week later — the only job a title has.
    static func fallback(for brief: String) -> String {
        let words = brief
            .replacingOccurrences(of: "\n", with: " ")
            .split(separator: " ", omittingEmptySubsequences: true)
            .prefix(6)
        return clean(words.joined(separator: " "))
    }

    /// Shared by both paths, so a model answer and a fallback are subject to
    /// the same rules and one cannot be acceptable where the other is not.
    private static func clean(_ raw: String) -> String {
        var s = raw
            .replacingOccurrences(of: "\"", with: "")
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix(".") { s.removeLast() }
        // Collapse runs of whitespace, matching cleanText() on the server so a
        // title is not silently rewritten between the phone and the record.
        s = s.split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
        // Truncated on a WORD boundary. Cutting at exactly 60 characters ends
        // titles mid-word, which reads as a bug rather than as a limit.
        if s.count > maxTitle {
            var out = ""
            for word in s.split(separator: " ") {
                if out.count + word.count + 1 > maxTitle { break }
                out += out.isEmpty ? String(word) : " " + word
            }
            s = out.isEmpty ? String(s.prefix(maxTitle)) : out
        }
        return s
    }
}
