import SwiftUI
import UIKit

/// How a hypervisor setup, a change to what the fleet may use or an install of
/// Xen Orchestra ended, as the notification that said so carried it.
///
/// WHAT A TAP ON THAT NOTIFICATION OPENS. It used to open the page of the
/// machine that ran the job, which says nothing about the job: an image build
/// that stopped with the end of its install log on the Lock Screen landed on a
/// list of sessions and a health line, and the log was gone. The words are the
/// host's own, carried in the notification's body, so they are here whether or
/// not anything still remembers the job.
struct SetupResult: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let text: String
    let state: String
    let host: String
}

struct SetupResultView: View {
    let result: SetupResult
    /// The machine that ran it, for what to do next there.
    var openHost: (String) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Design.Space.inside) {
                    Text(result.title)
                        .fleetType(.section)
                        .foregroundStyle(result.state == "failed" ? Design.Palette.bad : Design.Palette.ink)
                    if !result.host.isEmpty {
                        Text("Run on \(result.host)")
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                    }
                    // SELECTABLE AND IN MONO from the log on: what follows
                    // "The end of its log:" is a terminal's output, and its
                    // columns are part of what it says.
                    ForEach(parts.indices, id: \.self) { i in
                        if parts[i].log {
                            Text(parts[i].text)
                                .fleetType(.labelMono)
                                .foregroundStyle(Design.Palette.ink)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(Design.Space.inside)
                                .background(Design.Palette.inner, in: RoundedRectangle(cornerRadius: Design.Radius.chip))
                        } else {
                            Text(parts[i].text)
                                .fleetType(.body)
                                .foregroundStyle(Design.Palette.ink)
                                .textSelection(.enabled)
                        }
                    }
                    if !result.host.isEmpty {
                        Button("Open \(result.host)") {
                            dismiss()
                            openHost(result.host)
                        }
                        .frame(minHeight: 44)
                    }
                }
                .padding(Design.Space.page)
            }
            .background(Design.Palette.bg)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(copied ? "Copied" : "Copy") {
                        UIPasteboard.general.string = "\(result.title)\n\(result.text)"
                        copied = true
                    }
                }
            }
        }
    }

    /// The sentence, then the log it quotes when it quotes one, then what was
    /// done with the build VM (vm-image.js puts that after the log, on a line
    /// of its own beginning "Its build VM was kept").
    private var parts: [(text: String, log: Bool)] {
        let marker = "The end of its log:\n"
        guard let at = result.text.range(of: marker) else { return [(result.text, false)] }
        let said = String(result.text[..<at.upperBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        let rest = String(result.text[at.upperBound...])
        guard let kept = rest.range(of: "\nIts build VM was kept") else { return [(said, false), (rest, true)] }
        return [(said, false), (String(rest[..<kept.lowerBound]), true), (String(rest[rest.index(after: kept.lowerBound)...]), false)]
    }
}
