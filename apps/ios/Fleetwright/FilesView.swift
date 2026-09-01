import SwiftUI

/// Browsing a session's workspace from a phone.
///
/// The last item on the roadmap, and the one it called "deliberately last —
/// largest new attack surface in the product". Everything that makes it safe is
/// on the host (docs/filesystem.md): the path is confined three times, the
/// container mounts one volume read-only and has no network. **Nothing here is
/// a security control**, and this file should not read as though it is — an app
/// that validated paths would be an app somebody trusted to.
///
/// What this file is responsible for is the other half: not lying to the person
/// holding it. A refusal from the host is shown verbatim, because the host is
/// the only thing that knows why.
struct FilesView: View {
    let session: String
    let host: String?
    let fleet: Fleet

    /// Where we are, relative to the workspace root. "" is the root.
    @State private var path = ""
    @State private var entries: [Fleet.Entry] = []
    @State private var loading = false
    @State private var problem: String?

    /// The file being read, if any. A sheet rather than a push: reading a file
    /// is a detour from browsing, and coming back should not cost the place.
    @State private var reading: (name: String, body: String)?
    @State private var deleting: Fleet.Entry?

    var body: some View {
        List {
            if let problem {
                // VERBATIM, AND NOT REPLACED WITH A FRIENDLIER SENTENCE. The
                // host distinguishes "no such directory" from "that path leaves
                // the workspace" from "this session has no workspace", and each
                // one is a different thing to do next.
                Section {
                    Text(problem).foregroundStyle(.red).font(.callout)
                }
            }

            if !path.isEmpty {
                Button {
                    path = parent(of: path)
                    Task { await load() }
                } label: {
                    Label("Up", systemImage: "arrow.turn.left.up")
                }
            }

            ForEach(entries) { entry in
                row(for: entry)
            }

            if entries.isEmpty && !loading && problem == nil {
                Text("This directory is empty.").foregroundStyle(.secondary)
            }
        }
        .navigationTitle(path.isEmpty ? "Workspace" : path)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .overlay { if loading && entries.isEmpty { ProgressView() } }
        .task { await load() }
        .sheet(item: Binding(get: { reading.map { ReadFile(name: $0.name, body: $0.body) } },
                             set: { if $0 == nil { reading = nil } })) { file in
            FileReader(file: file)
        }
        .confirmationDialog(
            deleting.map { "Delete \($0.name)?" } ?? "",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let target = deleting { Task { await remove(target) } }
            }
            Button("Cancel", role: .cancel) { deleting = nil }
        } message: {
            // NOT RECOVERABLE, and said plainly. `forget` keeps a session for
            // seven days; this keeps nothing, and the difference is the whole
            // reason there is a confirmation here at all.
            Text("This cannot be undone. Forgetting a session keeps it for seven days; deleting a file keeps nothing.")
        }
    }

    @ViewBuilder
    private func row(for entry: Fleet.Entry) -> some View {
        if entry.isDirectory {
            Button {
                path = join(path, entry.name)
                Task { await load() }
            } label: {
                Label(entry.name, systemImage: "folder")
            }
            .swipeActions { deleteButton(entry) }
        } else {
            Button {
                Task { await open(entry) }
            } label: {
                HStack {
                    // A symlink is drawn as what it is. The host may refuse to
                    // follow it out of the workspace, and a person who can see
                    // it is a link is not surprised by that refusal.
                    Label(entry.name, systemImage: entry.kind == "link" ? "link" : "doc.text")
                    Spacer()
                    Text(size(entry.size)).font(.caption).foregroundStyle(.secondary)
                }
            }
            .swipeActions { deleteButton(entry) }
        }
    }

    private func deleteButton(_ entry: Fleet.Entry) -> some View {
        Button(role: .destructive) { deleting = entry } label: { Label("Delete", systemImage: "trash") }
    }

    // MARK: - Talking to the fleet

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let reply = try await fleet.files(session, path: path, host: host)
            if reply.ok == false {
                problem = reply.text ?? "That directory could not be read."
                entries = []
                return
            }
            problem = nil
            // THE FIELD, NEVER THE TEXT. `entries` is data; `text` is a
            // rendering of it for a person. An app that parsed the rendering
            // would break the first time somebody improved the wording.
            entries = reply.entries ?? []
        } catch {
            problem = error.localizedDescription
        }
    }

    private func open(_ entry: Fleet.Entry) async {
        do {
            let reply = try await fleet.readFile(session, path: join(path, entry.name), host: host)
            if reply.ok == false {
                // "not text", "too big", "leaves the workspace" — each is a
                // different fact and the host is the only thing that knows it.
                problem = reply.text ?? "That file could not be read."
                return
            }
            problem = nil
            reading = (entry.name, reply.text ?? "")
        } catch {
            problem = error.localizedDescription
        }
    }

    private func remove(_ entry: Fleet.Entry) async {
        deleting = nil
        do {
            let reply = try await fleet.deleteFile(session, path: join(path, entry.name), host: host)
            if reply.ok == false { problem = reply.text ?? "That could not be deleted." }
        } catch {
            problem = error.localizedDescription
        }
        await load()
    }

    // MARK: - Paths, for display only
    //
    // These build the string sent to the host. They are NOT a security check —
    // the host confines the path three times and is the only thing that can,
    // since a symlink is invisible from here. Writing a `..` guard in this file
    // would be writing something for somebody to rely on later.

    private func join(_ base: String, _ name: String) -> String {
        base.isEmpty ? name : "\(base)/\(name)"
    }

    private func parent(of p: String) -> String {
        guard let slash = p.lastIndex(of: "/") else { return "" }
        return String(p[p.startIndex..<slash])
    }

    private func size(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return "\(bytes / 1024) KB" }
        return String(format: "%.1f MB", Double(bytes) / 1_048_576)
    }
}

/// A file's contents, identified so it can drive a sheet.
private struct ReadFile: Identifiable {
    let name: String
    let body: String
    var id: String { name }
}

private struct FileReader: View {
    let file: ReadFile
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView([.horizontal, .vertical]) {
                Text(file.body)
                    // MONOSPACED AND UNWRAPPED. This is source and output, and
                    // reflowing it moves the columns somebody is reading.
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .navigationTitle(file.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
