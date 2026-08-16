import SwiftUI
import AppKit

struct WorkflowSummary: Identifiable, Hashable {
    let id: String
    let name: String
    let description: String
    let enabled: Bool
    let trigger: String
    let next: String?
}

@MainActor
final class WorkflowStore: ObservableObject {
    @Published var workflows: [WorkflowSummary] = []
    @Published var selected: WorkflowSummary?
    @Published var yaml = ""
    @Published var validation = ""
    @Published var trace = ""
    @Published var loading = false
    @Published var error: String?

    private let root = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".openclaw/workspace/brain")
    private var scheduledURL: URL { root.appendingPathComponent("workflows/scheduled") }
    private var clawURL: URL { root.appendingPathComponent("tools/console/bin/claw") }

    func refresh() {
        loading = true
        Task { @MainActor in
            defer { loading = false }
            do {
                let output = try run(["workflow", "list", "--json"])
                let data = Data(output.utf8)
                let rows = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] ?? []
                workflows = rows.compactMap { row in
                    guard let name = row["name"] as? String else { return nil }
                    let trigger = (row["trigger"] as? [String: Any]) ?? [:]
                    let triggerText = trigger["type"] as? String == "cron"
                        ? (trigger["cron"] as? String ?? "cron")
                        : ((trigger["type"] as? String) == "manual" ? "Manual · Run now" : "event · \(trigger["channel"] as? String ?? "unknown")")
                    return WorkflowSummary(id: name, name: name, description: row["description"] as? String ?? "",
                                           enabled: row["enabled"] as? Bool ?? false, trigger: triggerText, next: row["next"] as? String)
                }.sorted { ($0.next ?? "9999") < ($1.next ?? "9999") }
                error = nil
            } catch let loadError { error = loadError.localizedDescription }
        }
    }

    func open(_ workflow: WorkflowSummary) {
        selected = workflow
        do { yaml = try run(["workflow", "show", workflow.name]); validation = try run(["workflow", "validate", workflow.name]) }
        catch let openError { error = openError.localizedDescription }
    }

    func compile(description: String) async throws -> String {
        try run(["workflow", "compile", "--from-description", description])
    }

    func validate(name: String, yaml: String) {
        do {
            validation = try validateText(name: name, yaml: yaml)
        } catch { validation = error.localizedDescription }
    }

    func save(name: String, yaml: String, enable: Bool) throws {
        _ = try validateText(name: name, yaml: yaml)
        try atomicWrite(name: name, yaml: yaml, enable: enable)
        self.yaml = yaml
        refresh()
    }

    func test(name: String) {
        do { trace = try run(["workflow", "test", name]) }
        catch { trace = error.localizedDescription }
    }

    func delete(_ workflow: WorkflowSummary) throws {
        _ = try run(["workflow", "delete", workflow.name, "--yes"])
        refresh()
    }

    private func run(_ arguments: [String]) throws -> String {
        let process = Process()
        let output = Pipe()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        // GUI-launched apps do not inherit the shell's Homebrew PATH. The
        // console entrypoint uses `#!/usr/bin/env node`, so provide the
        // common Node locations explicitly when Studio shells out.
        process.arguments = [
            "OPENCLAW_ROOT=\(root.path)",
            "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
            clawURL.path,
        ] + arguments
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        process.waitUntilExit()
        let text = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        if process.terminationStatus != 0 {
            let message = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? text
            throw NSError(domain: "OpenClawStudio.Workflows", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: message])
        }
        return text
    }

    private func atomicWrite(name: String, yaml: String, enable: Bool) throws {
        guard name.range(of: #"^[a-z0-9][a-z0-9-]{1,63}$"#, options: .regularExpression) != nil else {
            throw NSError(domain: "OpenClawStudio.Workflows", code: 1, userInfo: [NSLocalizedDescriptionKey: "Workflow name must be lowercase slug-safe text."])
        }
        let dir = scheduledURL
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let target = dir.appendingPathComponent("\(name).yaml")
        let backups = root.appendingPathComponent("workflows/.backups/scheduled")
        try FileManager.default.createDirectory(at: backups, withIntermediateDirectories: true)
        let backup = backups.appendingPathComponent("\(name).\(Int(Date().timeIntervalSince1970)).bak")
        if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.copyItem(at: target, to: backup) }
        let temp = dir.appendingPathComponent(".\(name).\(UUID().uuidString).tmp")
        var content = yaml
        if enable {
            if content.contains("enabled: false") { content = content.replacingOccurrences(of: "enabled: false", with: "enabled: true") }
            else if !content.contains("enabled: true") { content = "enabled: true\n" + content }
        } else if !content.contains("enabled:") {
            content = "enabled: false\n" + content
        }
        try content.write(to: temp, atomically: true, encoding: .utf8)
        do {
            try FileManager.default.moveItem(at: temp, to: target)
            _ = try run(["workflow", "validate", name])
        } catch {
            try? FileManager.default.removeItem(at: temp)
            if FileManager.default.fileExists(atPath: backup.path) {
                try? FileManager.default.removeItem(at: target)
                try? FileManager.default.copyItem(at: backup, to: target)
            }
            throw error
        }
    }

    private func validateText(name: String, yaml: String) throws -> String {
        let tempName = ".studio-validation-\(UUID().uuidString)"
        let tempURL = scheduledURL.appendingPathComponent("\(tempName).yaml")
        try FileManager.default.createDirectory(at: scheduledURL, withIntermediateDirectories: true)
        try yaml.write(to: tempURL, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: tempURL) }
        return try run(["workflow", "validate", tempName])
    }
}

struct WorkflowsView: View {
    @StateObject private var store = WorkflowStore()
    @State private var editing = false
    @State private var creating = false
    @State private var showingTrace = false
    @State private var filter = ""

    private var filtered: [WorkflowSummary] {
        guard !filter.isEmpty else { return store.workflows }
        return store.workflows.filter { $0.name.localizedCaseInsensitiveContains(filter) || $0.description.localizedCaseInsensitiveContains(filter) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Workflows").font(.largeTitle.bold())
                    Text("Review and manage scheduled workflows without changing the engine.")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Refresh") { store.refresh() }.buttonStyle(.bordered)
                Button("New Workflow") { store.selected = nil; store.yaml = ""; creating = true; editing = true }.buttonStyle(.borderedProminent)
            }
            TextField("Filter workflows", text: $filter).textFieldStyle(.roundedBorder)
            if filtered.isEmpty {
                ContentUnavailableView("No workflows", systemImage: "arrow.triangle.branch", description: Text("Create your first workflow with the natural-language builder."))
            } else {
                Table(filtered) {
                    TableColumn("Name") { workflow in Text(workflow.name).font(.headline) }
                    TableColumn("Trigger") { workflow in Text(workflow.trigger).foregroundStyle(.secondary) }
                    TableColumn("Next Run") { workflow in Text(workflow.next ?? "—").font(.caption) }
                    TableColumn("Status") { workflow in Text(workflow.enabled ? "Enabled" : "Disabled").foregroundStyle(workflow.enabled ? .green : .secondary) }
                    TableColumn("Actions") { workflow in
                        HStack {
                            Button("Open") { store.open(workflow); creating = false; editing = true }
                            Button("Run now") { store.test(name: workflow.name); showingTrace = true }
                            Button("Delete", role: .destructive) {
                                do { try store.delete(workflow) }
                                catch { store.error = error.localizedDescription }
                            }
                        }
                    }
                }
                .frame(minHeight: 260)
            }
            if let error = store.error { Text(error).foregroundStyle(.red) }
        }
        .onAppear { store.refresh() }
        .sheet(isPresented: $editing) {
            if creating {
                WorkflowPrompt(store: store) {
                    creating = false
                } close: {
                    editing = false
                }
            } else {
                WorkflowEditor(store: store, workflow: store.selected) { editing = false }
            }
        }
        .sheet(isPresented: $showingTrace) {
            TraceView(text: store.trace)
        }
    }
}

struct WorkflowPrompt: View {
    @ObservedObject var store: WorkflowStore
    let compiled: () -> Void
    let close: () -> Void
    @State private var prompt = ""
    @State private var busy = false
    @State private var message = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("New Workflow").font(.largeTitle.bold())
                    Text("Describe what you want OpenClaw to do. Claude will turn it into a disabled, reviewable workflow.")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Cancel") { close() }
            }
            TextEditor(text: $prompt)
                .font(.system(size: 18))
                .frame(minHeight: 220)
                .padding(10)
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary))
            Text("Example: At 6am every day, check the weather for Ana in Chicago and Janet in Atlanta, review my calendar, then send a good-morning iMessage to their group.")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                Button("Compile Workflow") {
                    busy = true
                    Task {
                        do {
                            store.yaml = try await store.compile(description: prompt)
                            busy = false
                            compiled()
                        } catch {
                            busy = false
                            message = error.localizedDescription
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
                if busy { ProgressView("Researching and compiling…") }
            }
            if !message.isEmpty { Text(message).foregroundStyle(.red) }
            Spacer()
        }
        .padding(32)
        .frame(width: 760, height: 540)
    }
}

struct WorkflowEditor: View {
    @ObservedObject var store: WorkflowStore
    let workflow: WorkflowSummary?
    let close: () -> Void
    @State private var name = ""
    @State private var title = ""
    @State private var description = ""
    @State private var cron = "0 8 * * 1-5"
    @State private var timezone = "America/New_York"
    @State private var nl = ""
    @State private var showingEnable = false
    @State private var message = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Back") { close() }
                Spacer()
                Button("Run now") { if !name.isEmpty { store.test(name: name) } }
            Button("Save") { save(enable: workflow == nil ? true : false) }.buttonStyle(.bordered)
                Button("Save & Enable") { showingEnable = true }.buttonStyle(.borderedProminent)
            }.padding()
            Divider()
            HSplitView {
                Form {
                    SwiftUI.Section("Metadata") {
                        TextField("Name", text: $name)
                        TextField("Human title", text: $title)
                        TextEditor(text: $description).frame(minHeight: 80)
                    }
                    SwiftUI.Section("Trigger") {
                        TextField("Cron", text: $cron)
                        TextField("Timezone", text: $timezone)
                        Text("Manual workflows run only when you choose Test now. Cron workflows run through the scheduler.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    SwiftUI.Section("Actions") {
                        WorkflowCanvas(yaml: $store.yaml)
                        Text("The canvas is the visual view. Use Show YAML for advanced parameter editing.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    SwiftUI.Section("Validation") {
                        Text(store.validation.isEmpty ? "Not validated yet" : store.validation).foregroundStyle(store.validation.hasPrefix("VALID") ? .green : .red)
                    }
                }.frame(minWidth: 520)
                VStack(alignment: .leading, spacing: 12) {
                    Text("Natural-language helper").font(.headline)
                    TextEditor(text: $nl).frame(minHeight: 100).border(.quaternary)
                    HStack {
                        Button("Compile from description") {
                            Task {
                                do {
                                    let output = try await store.compile(description: nl)
                                    store.yaml = output
                                    extractFields(output)
                                    message = "Compiled. Review before saving."
                                } catch { message = error.localizedDescription }
                            }
                        }
                        Button("Update description from form") { message = "Use `claw workflow describe` from the CLI for the canonical decompiler." }
                    }
                    Text("YAML preview").font(.headline)
                    ScrollView { Text(store.yaml.isEmpty ? "Compile a description or open a workflow." : store.yaml).font(.system(.body, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.padding(10).background(.quaternary.opacity(0.25))
                    if !message.isEmpty { Text(message).font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                }.padding(24).frame(minWidth: 360)
            }
        }
        .frame(width: 1050, height: 700)
        .onAppear {
            if let workflow { name = workflow.name; description = workflow.description; store.open(workflow) }
            else if store.yaml.isEmpty { store.yaml = baseYaml }
            else { extractFields(store.yaml) }
        }
        .confirmationDialog("Enable workflow?", isPresented: $showingEnable) {
            Button("Enable", role: .destructive) { save(enable: true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This enables \(name) after validation. All actions remain subject to dry-run and kill-switch safety.")
        }
    }

    private var baseYaml: String {
        """
        name: new-workflow
        description: ""
        version: 1
        enabled: true
        trigger:
          type: manual
        conditions: []
        actions: []
        audit:
          channel_tag: workflow-scheduled
          redact_pii: true
        """
    }

    private func extractFields(_ yaml: String) {
        if let match = yaml.range(of: #"(?m)^name:\s*"?([^"\n]+)"?"#, options: .regularExpression) { name = String(yaml[match]).replacingOccurrences(of: "name:", with: "").trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\"", with: "") }
        if let match = yaml.range(of: #"(?m)^description:\s*"?([^"\n]*)"?"#, options: .regularExpression) { description = String(yaml[match]).replacingOccurrences(of: "description:", with: "").trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\"", with: "") }
    }

    private func save(enable: Bool) {
        do {
            guard !name.isEmpty else { throw NSError(domain: "OpenClawStudio", code: 1, userInfo: [NSLocalizedDescriptionKey: "Name is required."]) }
            store.validate(name: name, yaml: store.yaml)
            try store.save(name: name, yaml: store.yaml, enable: enable)
            message = enable ? "Saved and enabled." : "Saved disabled workflow."
        } catch { message = error.localizedDescription }
    }
}

struct TraceView: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Run timeline").font(.title2.bold())
            if text.isEmpty {
                ContentUnavailableView("No run yet", systemImage: "play.circle", description: Text("Run the workflow to see step-by-step status."))
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(text.split(separator: "\n").enumerated()), id: \.offset) { _, line in
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: line.contains("would write") ? "pause.circle" : "checkmark.circle")
                                    .foregroundStyle(line.contains("would write") ? .orange : .green)
                                Text(String(line)).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            Button("Close") { NSApp.keyWindow?.close() }.buttonStyle(.borderedProminent)
        }.padding(24).frame(width: 700, height: 500)
    }
}
