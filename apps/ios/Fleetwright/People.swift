import SwiftUI

/// Who is allowed into this fleet, and the screen that lets somebody in.
///
/// Adding a person used to mean editing `AGENT_FLEET_AUTH_ALLOW` in
/// `wrangler.toml`, committing, and waiting for a deploy — a CODE CHANGE PER
/// PERSON, performed by the one person who could already do everything. For a
/// product whose premise is "nothing to run, and nothing to ssh into", it was
/// the last thing you had to be at a keyboard for.
///
/// WHAT AN INVITATION IS, said on the screen because it is the thing people get
/// wrong about invitations: it is permission to attempt a sign-in, not a
/// credential. There is no link to send and nothing to leak — the person signs
/// in with Apple or Google as themselves, and the coordinator checks the
/// verified address against this list. So "invite" here means "add an address",
/// and the only thing to send them is the app.
///
/// ADMIN ONLY, in every direction including reading: a list of who has been
/// invited is a list of colleagues. The screen does not check that itself — it
/// asks, and shows the refusal, which is the same pattern the host list uses
/// and the one that keeps the app from having a second opinion about who is
/// allowed to do what.
struct PeopleView: View {
    let settings: Settings

    @State private var invites: [Fleet.Invite] = []
    @State private var email = ""
    @State private var note = ""
    @State private var result = ""
    @State private var busy = false
    @State private var loaded = false

    var body: some View {
        List {
            Section {
                TextField("their@email.com", text: $email)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.emailAddress)
                // Optional, and worth having: six months later "who is
                // e6591050@gmail.com" is a real question, and the answer is
                // cheapest to record now.
                TextField("what they are here for (optional)", text: $note)
                    .textInputAutocapitalization(.sentences)
                Button("Invite") { Task { await add() } }
                    .disabled(busy || !email.contains("@"))
            } header: {
                Text("Invite somebody")
            } footer: {
                Text("They sign in as themselves with Apple or Google — there is no link to send and nothing "
                     + "to leak. Send them the app. They will bring their own Claude, GitHub and Cloudflare "
                     + "accounts, and see only the sessions they start.")
            }

            Section {
                if invites.isEmpty && loaded {
                    Text("Nobody invited yet. The people in this deployment's own allow list are not shown here — "
                         + "they were set when it was deployed.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(invites) { invite in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(invite.email)
                        if let note = invite.note, !note.isEmpty {
                            Text(note).font(.caption).foregroundStyle(.secondary)
                        }
                        Text(describeInvite(invite)).font(.caption2).foregroundStyle(.secondary)
                        Button("Withdraw", role: .destructive) { Task { await withdraw(invite) } }
                            .font(.caption)
                            .buttonStyle(.borderless)
                            .disabled(busy)
                    }
                    .padding(.vertical, 2)
                }
            } header: {
                Text("Invited")
            } footer: {
                // SAID BEFORE IT MATTERS. Withdrawing stops a future sign-in
                // and does nothing to a phone already signed in — which is a
                // smaller action than the word suggests, and the gap is exactly
                // where somebody would assume otherwise.
                Text("Withdrawing stops them signing in again. A phone they have already signed in on keeps "
                     + "working until you revoke it under Devices.")
            }

            if !result.isEmpty {
                Section { Text(result).font(.callout) }
            }
        }
        .navigationTitle("People")
        .task { await load() }
    }

    @MainActor
    private func load() async {
        busy = true
        defer { busy = false; loaded = true }
        do {
            invites = try await Fleet(settings: settings).invites()
        } catch {
            // The refusal reaches the screen rather than an empty list. A
            // member asking this gets "needs an admin credential", which is an
            // answer; an empty list is a lie.
            result = error.localizedDescription
        }
    }

    @MainActor
    private func add() async {
        busy = true
        defer { busy = false }
        do {
            let reply = try await Fleet(settings: settings).invite(email.trimmingCharacters(in: .whitespaces), note: note)
            result = reply.text ?? ""
            if reply.ok != false { email = ""; note = "" }
        } catch {
            result = error.localizedDescription
        }
        await load()
    }

    @MainActor
    private func withdraw(_ invite: Fleet.Invite) async {
        busy = true
        defer { busy = false }
        do {
            result = try await Fleet(settings: settings).uninvite(invite.email).text ?? ""
        } catch {
            result = error.localizedDescription
        }
        await load()
    }
}

/// "invited by you, in March" — who and roughly when, which is what somebody
/// scanning this list is actually asking.
private func describeInvite(_ invite: Fleet.Invite) -> String {
    var parts: [String] = []
    if let by = invite.invitedBy, !by.isEmpty { parts.append("invited by \(by)") }
    if let at = invite.at, at > 0 {
        parts.append(Date(timeIntervalSince1970: at / 1000).formatted(date: .abbreviated, time: .omitted))
    }
    return parts.joined(separator: " · ")
}
