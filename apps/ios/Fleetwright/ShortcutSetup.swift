import AppIntents
import SwiftUI
import UIKit

/// Making a phrase of your own, from inside the app.
///
/// WHAT IS AND IS NOT POSSIBLE HERE, because the honest version of this screen
/// is better than a pretend one.
///
/// An app CANNOT register a Siri phrase programmatically. `AppShortcut` phrases
/// are compiled in and must contain the app name; the old
/// `INUIAddVoiceShortcutViewController`, which did let an app add a phrase
/// in-place, belongs to the SiriKit intents that App Intents replaced. There is
/// no supported call that ends with "and now Siri knows 'Debbie'".
///
/// So this screen does everything up to that last tap, rather than claiming the
/// last tap. It takes the phrase, keeps it, puts it on the clipboard, and opens
/// Shortcuts at the right place — leaving one paste and one Done. That is three
/// seconds of work instead of a paragraph of instructions, and it is the
/// difference between a feature and a support article.
///
/// ANDROID DOES NOT HAVE THIS PROBLEM. A dynamic shortcut's `shortLabel` IS the
/// phrase, so there the same screen finishes the job with no handoff. Same
/// design, one platform needing a step the other does not — worth knowing
/// before wondering why the two look different.
struct ShortcutSetupView: View {
    let settings: Settings

    @Environment(\.dismiss) private var dismiss
    @State private var phrase = ""
    @State private var copied = false

    /// Suggestions, because a blank field asking somebody to invent a wake word
    /// is the same abandonment point as a blank name field — and for the same
    /// reason. These are examples of the SHAPE, not names we are proposing.
    private let examples = ["Debbie", "another remote session", "spin one up", "new work session"]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What do you want to say?", text: $phrase)
                        .autocorrectionDisabled()
                } header: {
                    Text("Your phrase")
                } footer: {
                    Text("""
                    Anything you like. It does not have to mention this app — that rule only \
                    applies to the phrases we ship, not to a shortcut you make.
                    """)
                }

                if phrase.isEmpty {
                    Section("Examples") {
                        ForEach(examples, id: \.self) { example in
                            Button(example) { phrase = example }
                                .foregroundStyle(.primary)
                        }
                    }
                }

                Section {
                    Button {
                        UIPasteboard.general.string = phrase
                        copied = true
                        // Stored before leaving, so coming back shows what they
                        // chose rather than an empty field that looks like the
                        // app forgot.
                        settings.customPhrase = phrase
                        openShortcuts()
                    } label: {
                        Label("Copy and open Shortcuts", systemImage: "arrow.up.forward.app")
                    }
                    .disabled(phrase.trimmingCharacters(in: .whitespaces).isEmpty)
                } footer: {
                    // Numbered, short, and written for somebody holding a phone
                    // in one hand. The steps are Apple's, not ours, and they
                    // change — so this says what to look for rather than
                    // claiming exact button positions.
                    Text("""
                    Then, in Shortcuts:

                    1. Tap + and choose Fleetwright
                    2. Pick "Start a session"
                    3. Rename it — paste your phrase
                    4. Done

                    The name of a shortcut is what Siri listens for.
                    """)
                }

                if !settings.customPhrase.isEmpty {
                    Section("Saved") {
                        Text("\"Hey Siri, \(settings.customPhrase)\"")
                            .font(.system(.body, design: .rounded))
                        // Not a claim that it works — we cannot know whether
                        // they finished. Saying "set up" for something we did
                        // not observe is the kind of confident lie this project
                        // keeps finding in its own output.
                        Text("Saved here. It works once you have finished the steps above in Shortcuts.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Say it your way")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    /// Opens Shortcuts if it is installed, and does nothing loud if it is not.
    ///
    /// Shortcuts can be deleted. A button that silently fails is bad; a crash
    /// is worse; and an alert saying "install Shortcuts" for something they
    /// chose to remove is a lecture. The copied phrase is still on the
    /// clipboard either way, which is the part that mattered.
    private func openShortcuts() {
        guard let url = URL(string: "shortcuts://") else { return }
        UIApplication.shared.open(url)
    }
}
