import SwiftUI
import Foundation
import AppKit
import UserNotifications

@main
struct OpenClawStudioApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = StudioStore()
    @StateObject private var preferences = AppPreferences()
    @StateObject private var communications = RicoCommunicationsStore()
    @StateObject private var badRudy = BadRudyStore()
    @StateObject private var badRudyFeature = BadRudyFeatureRegistry()

    var body: some Scene {
        WindowGroup("OpenClaw Studio", id: "main") {
            ContentView(
                communications: communications,
                badRudy: badRudy,
                badRudyFeature: badRudyFeature
            )
                .environmentObject(store)
                .environmentObject(preferences)
                .frame(minWidth: 1_080, minHeight: 720)
                .preferredColorScheme(preferences.appearance.colorScheme)
                .sheet(isPresented: Binding(get: { !preferences.completedSetup }, set: { _ in })) {
                    SetupWizard(preferences: preferences)
                }
        }
        .windowResizability(.contentSize)
        .commands {
            CommandGroup(replacing: .appInfo) {
                Button("Refresh OpenClaw") { store.refresh() }
                    .keyboardShortcut("r")
            }
        }
        Window("About OpenClaw Studio", id: "about") { AboutView() }
        MenuBarExtra("OpenClaw Studio", systemImage: store.gatewayOnline ? "circle.fill" : "circle") {
            StudioMenuBarContent(
                gatewayOnline: store.gatewayOnline,
                refresh: { store.refresh() }
            )
        }
    }
}

private struct StudioMenuBarContent: View {
    @Environment(\.openWindow) private var openWindow
    let gatewayOnline: Bool
    let refresh: () -> Void

    var body: some View {
        Text(gatewayOnline ? "Gateway connected" : "Gateway unavailable")
        Divider()
        Button("Open OpenClaw Studio") {
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }
        Button("Refresh", action: refresh)
        Divider()
        Button("About OpenClaw Studio") {
            NSApp.sendAction(#selector(NSApplication.orderFrontStandardAboutPanel(_:)), to: nil, from: nil)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        if NotificationController.isPackagedApp { UNUserNotificationCenter.current().delegate = self }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        if let id = response.notification.request.content.userInfo["approvalID"] as? String {
            await MainActor.run {
                NotificationController.pendingApprovalID = id
                NSApp.activate(ignoringOtherApps: true)
            }
        }
    }
}

@MainActor
final class StudioStore: ObservableObject {
    private let gateway = GatewayClient()
    private var pollingTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var subscriptionTask: Task<Void, Never>?
    private var approvalTask: Task<Void, Never>?
    @Published var selectedSection: Section = .overview
    @Published var gatewayOnline = false
    @Published var gatewayVersion = "Checking…"
    @Published var gatewayError: String?
    @Published var lastRefresh = Date()
    @Published var agentRecords: [AgentRecord] = []
    @Published var sessionRecords: [SessionRecord] = []
    @Published var sessionOffset: Int?
    @Published var taskRecords: [TaskRecord] = []
    @Published var approvalRecords: [ApprovalRecord] = []
    @Published var auditEntries: [AuditEntry] = AuditStore.load()
    @Published var cronJobs: [CronJobRecord] = []
    @Published var cronRuns: [CronRunRecord] = []
    @Published var cronStatus: String = "Unknown"
    @Published var cronRunState: String?
    @Published var channelRecords: [ChannelRecord] = []
    @Published var nodeRecords: [NodeRecord] = []
    @Published var deviceRecords: [DeviceRecord] = []
    @Published var modelRecords: [ModelRecord] = []
    @Published var adminErrors: [String: String] = [:]
    @Published var gatewayRepairing = false
    @Published var gatewayRepairMessage: String?

    init() {
        refresh()
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                let configured = UserDefaults.standard.double(forKey: "refreshSeconds")
                let interval = configured >= 5 ? configured : 15
                do { try await Task.sleep(for: .seconds(interval)) }
                catch is CancellationError { return }
                catch { return }
                guard !Task.isCancelled else { return }
                self?.refresh()
            }
        }
        let client = gateway
        subscriptionTask = Task { [weak self] in
            for await _ in client.sessionEvents() {
                await self?.loadDirectories()
            }
        }
        approvalTask = Task { [weak self] in
            for await event in client.approvalEvents() {
                await self?.handleApprovalEvent(event)
            }
        }
        Task { await NotificationController.requestPermission() }
    }

    deinit {
        pollingTask?.cancel()
        refreshTask?.cancel()
        subscriptionTask?.cancel()
        approvalTask?.cancel()
    }

    func refresh() {
        guard refreshTask == nil else { return }
        refreshTask = Task { [weak self] in
            guard let self else { return }
            defer { refreshTask = nil }
            do {
                let health = try await gateway.health()
                gatewayOnline = health.online
                gatewayVersion = health.version ?? "Connected"
                gatewayError = nil
                lastRefresh = Date()
                await loadDirectories()
                await loadOperations()
                await loadAdmin()
            } catch {
                gatewayOnline = false
                gatewayVersion = "Unavailable"
                gatewayError = error.localizedDescription
                lastRefresh = Date()
            }
        }
    }

    /// Explicit operator recovery for an installed-but-unloaded macOS
    /// LaunchAgent. This is invoked only from the reviewed UI action.
    func repairGatewayService() {
        guard !gatewayRepairing else { return }
        gatewayRepairing = true
        gatewayRepairMessage = nil
        Task { [weak self] in
            let repaired = await Task.detached(priority: .userInitiated) {
                GatewayServiceRepair.run(port: 18_789)
            }.value
            guard let self else { return }
            gatewayRepairing = false
            if repaired {
                gatewayRepairMessage = "Gateway service repaired. Reconnecting…"
                try? await Task.sleep(for: .seconds(2))
                refresh()
            } else {
                gatewayRepairMessage = "macOS did not load the Gateway service. OpenClaw left the existing configuration unchanged."
            }
        }
    }

    func loadDirectories() async {
        async let agents = gateway.agents()
        async let sessions = gateway.sessions(limit: 100, offset: nil)
        do { agentRecords = try await agents; adminErrors["agents"] = nil }
        catch { adminErrors["agents"] = error.localizedDescription }
        do { let value = try await sessions; sessionRecords = value.rows; sessionOffset = value.nextOffset; adminErrors["sessions"] = nil }
        catch { adminErrors["sessions"] = error.localizedDescription }
    }

    func loadOperations() async {
        async let tasks = gateway.tasks(limit: 200, cursor: nil)
        async let approvals = gateway.approvals()
        do { taskRecords = try await tasks.rows; adminErrors["tasks"] = nil }
        catch { adminErrors["tasks"] = error.localizedDescription }
        do { approvalRecords = try await approvals; adminErrors["approvals"] = nil }
        catch { adminErrors["approvals"] = error.localizedDescription }
    }

    func loadAdmin() async {
        async let cron = gateway.cronList()
        async let cronState = gateway.cronStatus()
        async let channels = gateway.channels()
        async let nodes = gateway.nodes()
        async let devices = gateway.devices()
        async let models = gateway.models()
        do { cronJobs = try await cron; adminErrors["cron"] = nil } catch { adminErrors["cron"] = error.localizedDescription }
        do { let value = try await cronState; cronStatus = String(describing: value["status"] ?? value["enabled"] ?? "available") } catch { adminErrors["cron"] = error.localizedDescription }
        do { channelRecords = try await channels; adminErrors["channels"] = nil } catch { adminErrors["channels"] = error.localizedDescription }
        do { nodeRecords = try await nodes; adminErrors["nodes"] = nil } catch { adminErrors["nodes"] = error.localizedDescription }
        do { deviceRecords = try await devices; adminErrors["devices"] = nil } catch { adminErrors["devices"] = error.localizedDescription }
        do { modelRecords = try await models; adminErrors["models"] = nil } catch { adminErrors["models"] = error.localizedDescription }
    }

    func report(_ error: Error, area: String) {
        adminErrors[area] = error.localizedDescription
    }

    func runCron(job: CronJobRecord) async throws {
        let runID = try await gateway.cronRun(jobID: job.id)
        cronRunState = "queued"
        for _ in 0..<30 {
            try await Task.sleep(for: .seconds(2))
            let runs = try await gateway.cronRuns(jobID: job.id, runID: runID)
            guard let run = runs.first(where: { $0.id == runID }) else { continue }
            cronRunState = run.state
            if ["completed", "failed", "cancelled", "timed_out"].contains(run.state.lowercased()) { return }
        }
        cronRunState = "still running"
    }

    func setCronEnabled(job: CronJobRecord, enabled: Bool) async throws {
        _ = try await gateway.adminMutation("cron.update", params: [
            "jobId": job.id,
            "patch": ["enabled": enabled]
        ])
        appendAudit(action: enabled ? "cron.enable" : "cron.disable", target: job.id, result: "Gateway confirmed", requestID: nil)
        await loadAdmin()
    }

    func removeCron(job: CronJobRecord) async throws {
        _ = try await gateway.adminMutation("cron.remove", params: ["jobId": job.id])
        appendAudit(action: "cron.remove", target: job.id, result: "Gateway confirmed", requestID: nil)
        await loadAdmin()
    }

    func cancel(task: TaskRecord, reason: String = "Cancelled from OpenClaw Studio") async throws {
        guard !task.isTerminal else { return }
        let result = try await gateway.cancelTask(id: task.id, reason: reason)
        appendAudit(action: "task.cancel", target: task.id, result: result.cancelled ? "confirmed" : "not-cancelled", requestID: result.requestID)
        await loadOperations()
    }

    func resolve(approval: ApprovalRecord, decision: ApprovalDecision) async throws {
        guard approval.isPending else { return }
        let result = try await gateway.resolveApproval(approval, decision: decision)
        appendAudit(action: "approval.\(decision.rawValue)", target: approval.id, result: result, requestID: nil)
        await loadOperations()
    }

    private func handleApprovalEvent(_ event: ApprovalEvent) async {
        await loadOperations()
        if event.isNew {
            NotificationController.postApproval(event.approvalID, title: event.title)
        }
    }

    private func appendAudit(action: String, target: String, result: String, requestID: String?) {
        let entry = AuditEntry(action: action, target: target, result: result, requestID: requestID)
        AuditStore.append(entry)
        auditEntries.insert(entry, at: 0)
    }

    func send(session: SessionRecord, text: String) async throws -> ChatSendReceipt {
        let page = try await gateway.historyPage(sessionKey: session.key, limit: 1)
        var params: [String: Any] = [
            "sessionKey": session.key,
            "message": text,
            "deliver": false,
            "idempotencyKey": UUID().uuidString
        ]
        if let sessionID = page.sessionID { params["sessionId"] = sessionID }
        let payload = try await gateway.call(method: "chat.send", params: params)
        guard let runID = payload["runId"] as? String else { throw GatewayClientError.invalidResponse }
        return ChatSendReceipt(runID: runID, status: payload["status"] as? String ?? "started")
    }

    func waitForRun(_ runID: String, timeoutMilliseconds: Int = 60_000) async throws -> AgentWaitResult {
        try await gateway.waitForRun(runID: runID, timeoutMilliseconds: timeoutMilliseconds)
    }

    func inject(session: SessionRecord, text: String) async throws {
        _ = try await gateway.call(method: "chat.inject", params: [
            "sessionKey": session.key, "message": text
        ])
    }

    func abort(session: SessionRecord) async throws {
        _ = try await gateway.call(method: "sessions.abort", params: ["key": session.key])
    }

    func history(session: SessionRecord) async throws -> [TranscriptItem] {
        try await gateway.history(sessionKey: session.key, limit: 100)
    }

    func fullMessage(session: SessionRecord, messageID: String) async throws -> TranscriptItem? {
        let payload = try await gateway.call(method: "chat.message.get", params: [
            "sessionKey": session.key, "messageId": messageID
        ])
        return TranscriptItem(payload["message"] as? [String: Any] ?? payload)
    }

    func loadMoreSessions() async {
        guard let offset = sessionOffset else { return }
        do {
            let page = try await gateway.sessions(limit: 100, offset: offset)
            sessionRecords.append(contentsOf: page.rows)
            sessionOffset = page.nextOffset
        } catch { adminErrors["sessions"] = error.localizedDescription }
    }

    func deleteAgent(id: String) async throws {
        _ = try await gateway.call(method: "agents.delete", params: GatewayContract.agentDeleteParameters(id: id))
        agentRecords.removeAll { $0.id == id }
    }

    func createAgent(name: String, workspace: String, model: String) async throws {
        _ = try await gateway.call(
            method: "agents.create",
            params: GatewayContract.agentCreateParameters(name: name, workspace: workspace, model: model)
        )
        await loadDirectories()
    }

    func updateAgent(id: String, name: String, workspace: String, model: String) async throws {
        _ = try await gateway.call(method: "agents.update", params: [
            "agentId": id, "name": name, "workspace": workspace, "model": model
        ])
        await loadDirectories()
    }
}

enum GatewayServiceRepair {
    static func arguments(port: Int) -> [String] {
        ["gateway", "install", "--force", "--port", "\(port)", "--json"]
    }

    static func run(port: Int) -> Bool {
        let candidates = ["/opt/homebrew/bin/openclaw", "/usr/local/bin/openclaw"]
        guard let executable = candidates.first(where: FileManager.default.isExecutableFile(atPath:)) else {
            return false
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments(port: port)
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        process.environment = environment
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationReason == .exit && process.terminationStatus == 0
        } catch {
            return false
        }
    }
}

struct GatewayHealth {
    let online: Bool
    let version: String?
}

struct ChatSendReceipt: Sendable, Equatable {
    let runID: String
    let status: String
}

struct AgentWaitResult: Sendable, Equatable {
    let runID: String
    let status: String
    let error: String?

    var completedSuccessfully: Bool { status.lowercased() == "ok" }
    var isTimeout: Bool { status.lowercased() == "timeout" }
}

struct ChatHistoryPage {
    let messages: [TranscriptItem]
    let sessionID: String?
}

struct TaskPage { let rows: [TaskRecord]; let nextCursor: String? }
struct CronJobRecord: Identifiable, Hashable {
    let id: String; let name: String; let schedule: String; let timezone: String; let enabled: Bool; let nextRun: Date?; let lastRun: Date?
    init?(_ raw: [String: Any]) {
        guard let id = raw["id"] as? String ?? raw["jobId"] as? String else { return nil }
        self.id = id; self.name = raw["name"] as? String ?? id
        let scheduleObject = raw["schedule"] as? [String: Any]
        switch scheduleObject?["kind"] as? String {
        case "cron":
            self.schedule = scheduleObject?["expr"] as? String ?? "Cron schedule"
        case "every":
            let milliseconds = (scheduleObject?["everyMs"] as? NSNumber)?.intValue ?? 0
            self.schedule = milliseconds > 0 ? "Every \(Self.intervalLabel(milliseconds))" : "Repeating interval"
        case "at":
            self.schedule = scheduleObject?["at"] as? String ?? "One time"
        default:
            self.schedule = raw["schedule"] as? String ?? raw["expr"] as? String ?? "—"
        }
        self.timezone = scheduleObject?["tz"] as? String ?? raw["timezone"] as? String ?? raw["tz"] as? String ?? "Gateway timezone"
        self.enabled = raw["enabled"] as? Bool ?? true
        let state = raw["state"] as? [String: Any]
        self.nextRun = DateParser.date(raw["nextRunAt"] ?? raw["nextRunAtMs"] ?? state?["nextRunAtMs"])
        self.lastRun = DateParser.date(raw["lastRunAt"] ?? raw["lastRunAtMs"] ?? state?["lastRunAtMs"] ?? state?["lastStartedAtMs"])
    }

    private static func intervalLabel(_ milliseconds: Int) -> String {
        let seconds = max(1, milliseconds / 1_000)
        if seconds % 86_400 == 0 { return "\(seconds / 86_400) day\(seconds == 86_400 ? "" : "s")" }
        if seconds % 3_600 == 0 { return "\(seconds / 3_600) hour\(seconds == 3_600 ? "" : "s")" }
        if seconds % 60 == 0 { return "\(seconds / 60) minute\(seconds == 60 ? "" : "s")" }
        return "\(seconds) seconds"
    }
}
struct CronRunRecord: Identifiable, Hashable {
    let id: String; let jobID: String; let state: String; let started: Date?; let finished: Date?; let error: String
    init?(_ raw: [String: Any]) {
        guard let id = raw["runId"] as? String ?? raw["id"] as? String else { return nil }
        self.id = id; self.jobID = raw["jobId"] as? String ?? "—"; self.state = raw["status"] as? String ?? raw["state"] as? String ?? "queued"
        self.started = DateParser.date(raw["startedAt"] ?? raw["startedAtMs"]); self.finished = DateParser.date(raw["finishedAt"] ?? raw["finishedAtMs"]); self.error = raw["error"] as? String ?? ""
    }
}
struct ChannelRecord: Identifiable, Hashable {
    let id: String; let account: String; let state: String; let connected: Bool; let auth: String
    init?(_ raw: [String: Any]) {
        guard let id = raw["id"] as? String ?? raw["channel"] as? String ?? raw["name"] as? String else { return nil }
        self.id = id; self.account = raw["accountId"] as? String ?? "default"; self.state = raw["status"] as? String ?? raw["state"] as? String ?? "unknown"; self.connected = raw["connected"] as? Bool ?? false; self.auth = raw["auth"] as? String ?? raw["login"] as? String ?? "not exposed"
    }
}
struct NodeRecord: Identifiable, Hashable {
    let id: String; let name: String; let platform: String; let capabilities: String; let lastSeen: Date?; let paired: Bool
    init?(_ raw: [String: Any]) {
        guard let id = raw["id"] as? String ?? raw["nodeId"] as? String else { return nil }
        self.id = id; self.name = raw["name"] as? String ?? raw["displayName"] as? String ?? id; self.platform = raw["platform"] as? String ?? "—"; self.capabilities = Redactor.sanitize(raw["caps"] ?? raw["capabilities"] ?? "—"); self.lastSeen = DateParser.date(raw["lastSeenAt"] ?? raw["lastSeenAtMs"]); self.paired = raw["paired"] as? Bool ?? true
    }
}
struct DeviceRecord: Identifiable, Hashable {
    let id: String; let name: String; let state: String; let roles: String; let lastSeen: Date?
    init?(_ raw: [String: Any]) {
        guard let id = raw["deviceId"] as? String ?? raw["id"] as? String else { return nil }
        self.id = id; self.name = raw["label"] as? String ?? raw["displayName"] as? String ?? id; self.state = raw["status"] as? String ?? raw["state"] as? String ?? "pending"; self.roles = String(describing: raw["roles"] ?? "—"); self.lastSeen = DateParser.date(raw["lastSeenAt"] ?? raw["lastSeenAtMs"])
    }
}
struct ModelRecord: Identifiable, Hashable {
    let id: String; let provider: String; let configured: Bool; let available: Bool; let auth: String; let warning: String
    init?(_ raw: [String: Any]) {
        guard let id = raw["id"] as? String ?? raw["model"] as? String else { return nil }
        self.id = id; self.provider = raw["provider"] as? String ?? id.split(separator: "/").first.map(String.init) ?? "—"; self.configured = raw["configured"] as? Bool ?? false; self.available = raw["available"] as? Bool ?? true; self.auth = raw["authStatus"] as? String ?? raw["auth"] as? String ?? "unknown"; self.warning = raw["warning"] as? String ?? ""
    }
}
struct TaskRecord: Identifiable, Hashable {
    let id: String
    let state: String
    let owner: String
    let session: String
    let created: Date?
    let updated: Date?
    let elapsed: String
    let summary: String
    let error: String
    let progress: String

    var isTerminal: Bool { ["completed", "failed", "cancelled", "timed_out"].contains(state.lowercased()) }
    var group: String {
        switch state.lowercased() {
        case "running": "Running"; case "queued": "Queued"; case "completed": "Completed"
        case "failed", "timed_out": "Failed"; case "cancelled": "Cancelled"; default: "Needs Attention"
        }
    }
    init?(_ raw: [String: Any]) {
        guard let id = raw["id"] as? String ?? raw["taskId"] as? String else { return nil }
        self.id = id; self.state = raw["status"] as? String ?? raw["state"] as? String ?? "unknown"
        self.owner = raw["owner"] as? String ?? raw["agentId"] as? String ?? "—"
        self.session = raw["sessionKey"] as? String ?? "—"
        self.created = DateParser.date(raw["createdAt"] ?? raw["createdAtMs"])
        self.updated = DateParser.date(raw["updatedAt"] ?? raw["updatedAtMs"])
        self.elapsed = raw["elapsed"] as? String ?? "—"
        self.summary = raw["summary"] as? String ?? raw["title"] as? String ?? "No summary"
        self.error = raw["error"] as? String ?? ""
        self.progress = String(describing: raw["progress"] ?? raw["metadata"] ?? "")
    }
}

struct ApprovalRecord: Identifiable, Hashable {
    let id: String
    let kind: String
    let agent: String
    let session: String
    let operation: String
    let arguments: String
    let node: String
    let risk: String
    let expires: Date?
    let state: String
    let destructive: Bool
    var isPending: Bool { state.lowercased() == "pending" || state.isEmpty }
    init?(_ raw: [String: Any], kind: String = "exec") {
        guard let id = raw["id"] as? String ?? raw["approvalId"] as? String else { return nil }
        let request = raw["request"] as? [String: Any] ?? [:]
        let resolvedKind = raw["kind"] as? String ?? kind
        let isPlugin = resolvedKind.lowercased() == "plugin"
        let operation = raw["operation"] as? String
            ?? request[isPlugin ? "title" : "command"] as? String
            ?? request["toolName"] as? String
            ?? raw["command"] as? String
            ?? raw["tool"] as? String
            ?? "Requested operation"
        let arguments = raw["arguments"]
            ?? raw["argv"]
            ?? raw["input"]
            ?? request[isPlugin ? "description" : "argv"]
            ?? request["input"]
            ?? request
        let sanitizedArguments = Redactor.sanitize(arguments)
        self.id = id; self.kind = resolvedKind
        self.agent = raw["agentId"] as? String ?? request["agentId"] as? String ?? raw["requestingAgent"] as? String ?? "—"
        self.session = raw["sessionKey"] as? String ?? request["sessionKey"] as? String ?? "—"
        self.operation = operation
        self.arguments = sanitizedArguments
        self.node = raw["nodeId"] as? String
            ?? request["nodeId"] as? String
            ?? raw["targetNode"] as? String
            ?? request["host"] as? String
            ?? request["pluginId"] as? String
            ?? "Gateway host"
        self.risk = raw["risk"] as? String
            ?? raw["riskExplanation"] as? String
            ?? request["severity"] as? String
            ?? request["security"] as? String
            ?? "Review requested operation carefully."
        self.expires = DateParser.date(raw["expiresAt"] ?? raw["expiresAtMs"])
        self.state = raw["status"] as? String ?? raw["state"] as? String ?? "pending"
        self.destructive = RiskPolicy.requiresExtraConfirmation(operation: operation, arguments: sanitizedArguments)
    }
}

enum ApprovalDecision: String {
    case approve = "allow-once"
    case reject = "deny"
}
enum DateParser {
    static func date(_ value: Any?) -> Date? {
        let number: Double?
        switch value {
        case let value as Double: number = value
        case let value as Int: number = Double(value)
        case let value as NSNumber: number = value.doubleValue
        case let value as String: number = Double(value)
        default: number = nil
        }
        guard let number else { return nil }
        return Date(timeIntervalSince1970: number > 10_000_000_000 ? number / 1000 : number)
    }
}

enum Redactor {
    static func sanitize(_ value: Any) -> String {
        var text: String
        if let dictionary = value as? [String: Any],
           let data = try? JSONSerialization.data(withJSONObject: dictionary, options: [.sortedKeys]) {
            text = String(decoding: data, as: UTF8.self)
        } else { text = String(describing: value) }
        let patterns = ["(?i)(token|password|secret|api[_-]?key|authorization)(\"?\\s*[:=]\\s*\"?)[^,\"}\\s]+", "(?i)bearer\\s+[A-Za-z0-9._-]+"]
        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern) {
                text = regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "$1$2[REDACTED]")
            }
        }
        return text
    }
}

enum RiskPolicy {
    static func requiresExtraConfirmation(operation: String, arguments: String) -> Bool {
        let text = "\(operation) \(arguments)".lowercased()
        return ["rm ", "delete", "credential", "password", "secret", "sudo", "chmod", "chown", "system", "launchctl", "/etc/", "filesystem", "all files", "broad"].contains { text.contains($0) }
    }
}

struct CancelResult { let cancelled: Bool; let requestID: String? }
struct ApprovalEvent { let approvalID: String; let title: String; let isNew: Bool }
struct AuditEntry: Identifiable, Codable {
    let id: UUID; let action: String; let target: String; let result: String; let requestID: String?; let timestamp: Date
    init(action: String, target: String, result: String, requestID: String?) { self.id = UUID(); self.action = action; self.target = target; self.result = result; self.requestID = requestID; self.timestamp = Date() }
}

enum AuditStore {
    static var url: URL { FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("OpenClawStudio/audit.jsonl") }
    static func load() -> [AuditEntry] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return String(decoding: data, as: UTF8.self).split(separator: "\n").compactMap { try? JSONDecoder().decode(AuditEntry.self, from: Data($0.utf8)) }.reversed()
    }
    static func append(_ entry: AuditEntry) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(entry) else { return }
        if let handle = try? FileHandle(forWritingTo: url) { handle.seekToEndOfFile(); handle.write(data); handle.write(Data("\n".utf8)); try? handle.close() }
        else { try? (data + Data("\n".utf8)).write(to: url) }
    }
    static func clear() {
        try? FileManager.default.removeItem(at: url)
    }
}

@MainActor
enum NotificationController {
    static var pendingApprovalID: String?
    static var isPackagedApp: Bool { Bundle.main.bundleURL.pathExtension == "app" }
    static func requestPermission() async {
        guard isPackagedApp else { return }
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
    }
    static func postApproval(_ id: String, title: String) {
        guard isPackagedApp else { return }
        let content = UNMutableNotificationContent(); content.title = "OpenClaw approval needed"; content.body = title; content.sound = .default
        content.userInfo = ["approvalID": id]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }
}

enum GatewayClientError: LocalizedError {
    case missingConfiguration
    case invalidResponse
    case timedOut
    case rejected(String)

    var errorDescription: String? {
        switch self {
        case .missingConfiguration: "OpenClaw gateway configuration was not found."
        case .invalidResponse: "The gateway returned an invalid response."
        case .timedOut: "The OpenClaw Gateway did not respond before the request timed out."
        case .rejected(let message): message
        }
    }
}

enum GatewayContract {
    static let topLevelArrayKey = "_topLevelArray"

    static func normalizedPayload(_ value: Any?) -> [String: Any] {
        if let dictionary = value as? [String: Any] { return dictionary }
        if let array = value as? [Any] { return [topLevelArrayKey: array] }
        return [:]
    }

    static func rows(in payload: [String: Any], preferredKeys: [String]) -> [[String: Any]] {
        for key in preferredKeys {
            if let rows = payload[key] as? [[String: Any]] { return rows }
        }
        return payload[topLevelArrayKey] as? [[String: Any]] ?? []
    }

    static func taskCancelParameters(id: String, reason: String) -> [String: Any] {
        ["taskId": id, "reason": reason]
    }

    static func agentCreateParameters(name: String, workspace: String, model: String) -> [String: Any] {
        ["name": name, "workspace": workspace, "model": model]
    }

    static func agentDeleteParameters(id: String) -> [String: Any] {
        ["agentId": id, "deleteFiles": false]
    }

    static func sessionListParameters(limit: Int, offset: Int?, archived: Bool = false) -> [String: Any] {
        var params: [String: Any] = ["limit": min(max(limit, 1), 200)]
        if let offset { params["offset"] = max(0, offset) }
        if archived { params["archived"] = true }
        return params
    }

    static func sessionNextOffset(_ payload: [String: Any]) -> Int? {
        if payload["hasMore"] as? Bool == false { return nil }
        if let value = payload["nextOffset"] as? Int { return value }
        return (payload["nextOffset"] as? NSNumber)?.intValue
    }

    static func scopes(for method: String) -> [String] {
        if method.hasPrefix("rico.autonomy.") {
            let readMethods: Set<String> = [
                "rico.autonomy.status",
                "rico.autonomy.missions.list",
                "rico.autonomy.missions.get",
                "rico.autonomy.events.list",
                "rico.autonomy.evaluate"
            ]
            return readMethods.contains(method) ? ["operator.read"] : ["operator.admin"]
        }
        if method.hasPrefix("device.pair.") || method.hasPrefix("node.pair.") { return ["operator.read", "operator.pairing"] }
        if method.hasPrefix("exec.approval.") || method.hasPrefix("plugin.approval.") { return ["operator.read", "operator.approvals"] }
        if ["agents.create", "agents.update", "agents.delete"].contains(method) { return ["operator.admin"] }
        if method == "sessions.reset" { return ["operator.admin"] }
        if method == "send" { return ["operator.write"] }
        if method.hasPrefix("cron.") && method != "cron.list" && method != "cron.get" && method != "cron.status" && method != "cron.runs" { return ["operator.admin"] }
        if method.hasSuffix(".logout") || method.hasSuffix(".login") { return ["operator.read", "operator.write"] }
        if method == "agent.wait" || method == "sessions.subscribe" || method.hasPrefix("sessions.messages.subscribe") { return ["operator.read"] }
        return method.hasSuffix(".list") || method.hasSuffix(".get") || method.hasSuffix(".status") || method == "models.list" || method == "channels.status" ? ["operator.read"] : ["operator.read", "operator.write"]
    }
}

/// Minimal, read-only operator client for the local OpenClaw gateway.
/// Credentials are read from the existing config file and never logged.
final class GatewayClient: @unchecked Sendable {
    private let configURL = URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent(".openclaw/openclaw.json")

    func health() async throws -> GatewayHealth {
        try await health(settings: connectionSettings())
    }

    func health(settings: ConnectionSettings) async throws -> GatewayHealth {
        guard let endpoint = URL(string: settings.endpoint) else { throw AppSupportError.invalidEndpoint }
        let socket = URLSession.shared.webSocketTask(with: endpoint)
        socket.resume()
        defer { socket.cancel(with: .goingAway, reason: nil) }

        _ = try await receive(socket, until: { frame in
            guard case .string(let text) = frame,
                  let data = text.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return false }
            return json["event"] as? String == "connect.challenge"
        })

        let connect: [String: Any] = [
            "type": "req", "id": UUID().uuidString, "method": "connect",
            "params": [
                "minProtocol": 4, "maxProtocol": 4,
                "client": ["id": "gateway-client", "version": "1.1.0", "platform": "macos", "mode": "backend"],
                "role": "operator", "scopes": ["operator.read"], "caps": [],
                "commands": [], "permissions": [:],
                "auth": ["token": settings.token as Any],
                "locale": "en-US", "userAgent": "OpenClawStudio/1.1.0"
            ]
        ]
        try await send(connect, through: socket)
        let hello = try await receive(socket, until: { frame in
            guard case .string(let text) = frame,
                  let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
            else { return false }
            return json["type"] as? String == "res"
        })
        if let error = responseError(from: hello) { throw GatewayClientError.rejected(error) }

        let requestID = UUID().uuidString
        try await send(["type": "req", "id": requestID, "method": "health", "params": [:]], through: socket)
        let response = try await receive(socket, timeoutSeconds: 15, until: { frame in
            guard case .string(let text) = frame,
                  let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
            else { return false }
            return json["id"] as? String == requestID
        })
        if let error = responseError(from: response) { throw GatewayClientError.rejected(error) }
        guard case .string(let text) = response,
              let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let payload = json["payload"] as? [String: Any]
        else { throw GatewayClientError.invalidResponse }
        var version: String?
        if let server = payload["server"] as? [String: Any] {
            version = server["version"] as? String
        }
        return GatewayHealth(online: true, version: version)
    }

    func agents() async throws -> [AgentRecord] {
        let payload = try await call(method: "agents.list", params: [:])
        let rows = (payload["agents"] as? [[String: Any]]) ?? (payload["rows"] as? [[String: Any]]) ?? []
        return rows.compactMap(AgentRecord.init)
    }

    func sessions(limit: Int, offset: Int?, archived: Bool = false) async throws -> SessionPage {
        let payload = try await call(
            method: "sessions.list",
            params: GatewayContract.sessionListParameters(limit: limit, offset: offset, archived: archived)
        )
        let rows = (payload["sessions"] as? [[String: Any]]) ?? (payload["rows"] as? [[String: Any]]) ?? []
        return SessionPage(rows: rows.compactMap(SessionRecord.init), nextOffset: GatewayContract.sessionNextOffset(payload))
    }

    func history(sessionKey: String, limit: Int) async throws -> [TranscriptItem] {
        try await historyPage(sessionKey: sessionKey, limit: limit).messages
    }

    func historyPage(sessionKey: String, limit: Int) async throws -> ChatHistoryPage {
        let payload = try await call(method: "chat.history", params: ["sessionKey": sessionKey, "limit": min(max(limit, 1), 200)])
        let rows = (payload["messages"] as? [[String: Any]]) ?? (payload["items"] as? [[String: Any]]) ?? []
        return ChatHistoryPage(
            messages: rows.compactMap(TranscriptItem.init),
            sessionID: payload["sessionId"] as? String
        )
    }

    func waitForRun(runID: String, timeoutMilliseconds: Int) async throws -> AgentWaitResult {
        let payload = try await call(method: "agent.wait", params: [
            "runId": runID,
            "timeoutMs": min(max(timeoutMilliseconds, 0), 120_000)
        ])
        return AgentWaitResult(
            runID: payload["runId"] as? String ?? runID,
            status: payload["status"] as? String ?? "unknown",
            error: payload["error"] as? String
        )
    }

    func tasks(limit: Int, cursor: String?) async throws -> TaskPage {
        var params: [String: Any] = ["limit": min(max(limit, 1), 500)]
        if let cursor { params["cursor"] = cursor }
        let payload = try await call(method: "tasks.list", params: params)
        let rows = (payload["tasks"] as? [[String: Any]]) ?? []
        return TaskPage(rows: rows.compactMap(TaskRecord.init), nextCursor: payload["nextCursor"] as? String)
    }

    func cancelTask(id: String, reason: String) async throws -> CancelResult {
        let payload = try await call(method: "tasks.cancel", params: GatewayContract.taskCancelParameters(id: id, reason: reason))
        return CancelResult(cancelled: payload["cancelled"] as? Bool == true, requestID: payload["requestId"] as? String)
    }

    func approvals() async throws -> [ApprovalRecord] {
        var result: [ApprovalRecord] = []
        var failures: [String] = []
        do {
            let exec = try await call(method: "exec.approval.list", params: [:])
            result += GatewayContract.rows(in: exec, preferredKeys: ["approvals"]).compactMap { ApprovalRecord($0, kind: "exec") }
        } catch { failures.append(error.localizedDescription) }
        do {
            let plugin = try await call(method: "plugin.approval.list", params: [:])
            result += GatewayContract.rows(in: plugin, preferredKeys: ["approvals"]).compactMap { ApprovalRecord($0, kind: "plugin") }
        } catch { failures.append(error.localizedDescription) }
        if result.isEmpty && failures.count == 2 { throw GatewayClientError.rejected(failures.joined(separator: " · ")) }
        return result
    }

    func cronList() async throws -> [CronJobRecord] {
        let payload = try await call(method: "cron.list", params: ["includeDisabled": true, "limit": 200])
        return (payload["jobs"] as? [[String: Any]] ?? []).compactMap(CronJobRecord.init)
    }
    func workboardCards() async throws -> [[String: Any]] {
        let payload = try await call(method: "workboard.cards.list", params: [:])
        return payload["cards"] as? [[String: Any]] ?? []
    }
    func cronStatus() async throws -> [String: Any] {
        try await call(method: "cron.status", params: [:])
    }
    func cronRuns(jobID: String, runID: String? = nil) async throws -> [CronRunRecord] {
        var params: [String: Any] = ["jobId": jobID]
        if let runID { params["runId"] = runID }
        let payload = try await call(method: "cron.runs", params: params)
        return GatewayContract.rows(in: payload, preferredKeys: ["entries", "runs"]).compactMap(CronRunRecord.init)
    }
    func cronRun(jobID: String) async throws -> String {
        let payload = try await call(method: "cron.run", params: ["jobId": jobID])
        guard let runID = payload["runId"] as? String else { throw GatewayClientError.invalidResponse }
        return runID
    }
    func channels() async throws -> [ChannelRecord] {
        let payload = try await call(method: "channels.status", params: [:])
        return (payload["channels"] as? [[String: Any]] ?? payload["accounts"] as? [[String: Any]] ?? []).compactMap(ChannelRecord.init)
    }
    func nodes() async throws -> [NodeRecord] {
        let payload = try await call(method: "node.list", params: [:])
        return (payload["nodes"] as? [[String: Any]] ?? []).compactMap(NodeRecord.init)
    }
    func devices() async throws -> [DeviceRecord] {
        let payload = try await call(method: "device.pair.list", params: [:])
        return (payload["devices"] as? [[String: Any]] ?? payload["pending"] as? [[String: Any]] ?? []).compactMap(DeviceRecord.init)
    }
    func models() async throws -> [ModelRecord] {
        let payload = try await call(method: "models.list", params: ["view": "configured"])
        return (payload["models"] as? [[String: Any]] ?? []).compactMap(ModelRecord.init)
    }
    func adminMutation(_ method: String, params: [String: Any]) async throws -> [String: Any] {
        try await call(method: method, params: params)
    }

    func resolveApproval(_ approval: ApprovalRecord, decision: ApprovalDecision) async throws -> String {
        let method = approval.kind.lowercased() == "plugin" ? "plugin.approval.resolve" : "exec.approval.resolve"
        let payload = try await call(method: method, params: [
            "id": approval.id, "decision": decision.rawValue
        ])
        return String(describing: payload["result"] ?? payload["status"] ?? "Gateway responded")
    }

    func call(method: String, params: [String: Any]) async throws -> [String: Any] {
        let socket = try await connectedSocket(scopes: GatewayContract.scopes(for: method))
        defer { socket.cancel(with: .goingAway, reason: nil) }
        let requestID = UUID().uuidString
        try await send(["type": "req", "id": requestID, "method": method, "params": params], through: socket)
        let timeoutSeconds: Double = method == "agent.wait" ? 125 : (method == "send" ? 45 : 15)
        let response = try await receive(socket, timeoutSeconds: timeoutSeconds, until: { frame in
            guard case .string(let text) = frame,
                  let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
            else { return false }
            return json["id"] as? String == requestID
        })
        if let error = responseError(from: response) { throw GatewayClientError.rejected(error) }
        guard case .string(let text) = response,
              let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
        else { throw GatewayClientError.invalidResponse }
        return GatewayContract.normalizedPayload(json["payload"])
    }

    func sessionEvents() -> AsyncStream<Void> {
        AsyncStream { continuation in
            let task = Task {
                var retrySeconds = 1.0
                while !Task.isCancelled {
                    do {
                        let socket = try await connectedSocket()
                        defer { socket.cancel(with: .goingAway, reason: nil) }
                        try await send(["type": "req", "id": UUID().uuidString, "method": "sessions.subscribe", "params": [:]], through: socket)
                        retrySeconds = 1
                        while !Task.isCancelled {
                            let frame = try await socket.receive()
                            guard case .string(let text) = frame,
                                  let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
                            else { continue }
                            if (json["type"] as? String) == "event",
                               (json["event"] as? String)?.hasPrefix("sessions.") == true {
                                continuation.yield(())
                            }
                        }
                    } catch is CancellationError {
                        break
                    } catch {
                        try? await Task.sleep(for: .seconds(retrySeconds))
                        retrySeconds = min(retrySeconds * 2, 30)
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func approvalEvents() -> AsyncStream<ApprovalEvent> {
        AsyncStream { continuation in
            let task = Task {
                var retrySeconds = 1.0
                while !Task.isCancelled {
                    do {
                        let socket = try await connectedSocket(scopes: ["operator.read", "operator.approvals"])
                        defer { socket.cancel(with: .goingAway, reason: nil) }
                        retrySeconds = 1
                        while !Task.isCancelled {
                            let frame = try await socket.receive()
                            guard case .string(let text) = frame,
                                  let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                                  json["type"] as? String == "event",
                                  let event = json["event"] as? String,
                                  event == "exec.approval.requested" || event == "plugin.approval.requested" else { continue }
                            let payload = json["payload"] as? [String: Any] ?? [:]
                            let id = payload["approvalId"] as? String ?? payload["id"] as? String ?? UUID().uuidString
                            continuation.yield(ApprovalEvent(approvalID: id, title: payload["operation"] as? String ?? "Review a new approval", isNew: true))
                        }
                    } catch is CancellationError {
                        break
                    } catch {
                        try? await Task.sleep(for: .seconds(retrySeconds))
                        retrySeconds = min(retrySeconds * 2, 30)
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func connectedSocket(scopes requestedScopes: [String] = ["operator.read"]) async throws -> URLSessionWebSocketTask {
        let settings = connectionSettings()
        guard let endpoint = URL(string: settings.endpoint) else { throw AppSupportError.invalidEndpoint }
        let socket = URLSession.shared.webSocketTask(with: endpoint)
        socket.resume()
        _ = try await receive(socket, until: { frame in
            guard case .string(let text) = frame,
                  let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
            else { return false }
            return json["event"] as? String == "connect.challenge"
        })
        try await send([
            "type": "req", "id": UUID().uuidString, "method": "connect",
            "params": [
                "minProtocol": 4, "maxProtocol": 4,
                "client": ["id": "gateway-client", "version": "1.1.0", "platform": "macos", "mode": "backend"],
                "role": "operator", "scopes": requestedScopes, "caps": ["agent-kind"],
                "commands": [], "permissions": [:], "auth": ["token": settings.token as Any],
                "locale": "en-US", "userAgent": "OpenClawStudio/1.1.0"
            ]
        ], through: socket)
        let hello = try await receive(socket, until: { frame in
            guard case .string(let text) = frame,
                  let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
            else { return false }
            return json["type"] as? String == "res"
        })
        if let error = responseError(from: hello) {
            socket.cancel(with: .goingAway, reason: nil)
            throw GatewayClientError.rejected(error)
        }
        return socket
    }

    private func loadConfiguration() throws -> [String: Any] {
        guard let data = try? Data(contentsOf: configURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw GatewayClientError.missingConfiguration }
        return object
    }

    private func connectionSettings() -> ConnectionSettings {
        let defaults = UserDefaults.standard
        let endpoint = defaults.string(forKey: "endpoint") ?? LocalGatewayDetector.detect() ?? "ws://127.0.0.1:18789"
        let token = KeychainStore.readToken() ?? (try? loadConfiguration()).flatMap {
            ((($0["gateway"] as? [String: Any])?["auth"] as? [String: Any])?["token"] as? String)
        }
        return ConnectionSettings(endpoint: endpoint, token: token)
    }

    private func send(_ object: [String: Any], through socket: URLSessionWebSocketTask) async throws {
        let data = try JSONSerialization.data(withJSONObject: object)
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
    }

    private func receive(
        _ socket: URLSessionWebSocketTask,
        timeoutSeconds: Double = 15,
        until predicate: (URLSessionWebSocketTask.Message) -> Bool
    ) async throws -> URLSessionWebSocketTask.Message {
        while true {
            let frame = try await receiveFrame(socket, timeoutSeconds: timeoutSeconds)
            if predicate(frame) { return frame }
        }
    }

    private func receiveFrame(
        _ socket: URLSessionWebSocketTask,
        timeoutSeconds: Double
    ) async throws -> URLSessionWebSocketTask.Message {
        try await withThrowingTaskGroup(of: URLSessionWebSocketTask.Message.self) { group in
            group.addTask { try await socket.receive() }
            group.addTask {
                try await Task.sleep(for: .seconds(timeoutSeconds))
                throw GatewayClientError.timedOut
            }
            guard let first = try await group.next() else { throw GatewayClientError.invalidResponse }
            group.cancelAll()
            return first
        }
    }

    private func responseError(from frame: URLSessionWebSocketTask.Message) -> String? {
        guard case .string(let text) = frame,
              let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              json["ok"] as? Bool == false
        else { return nil }
        return ((json["error"] as? [String: Any])?["message"] as? String) ?? "Gateway request was rejected."
    }
}

enum Section: String, CaseIterable, Identifiable {
    case overview = "Overview"
    case missions = "Missions"
    case agents = "Agents"
    case sessions = "Sessions"
    case tasks = "Tasks"
    case approvals = "Approvals"
    case channels = "Channels"
    case communications = "Rico Communications"
    case skills = "Skills"
    case badRudy = "Bad Rudy"
    case integrations = "MCP"
    case contacts = "Contacts"
    case nodes = "Nodes & Devices"
    case models = "Models"
    case workflows = "Automations"
    case workboard = "Workboard"

    var id: String { rawValue }
    var symbol: String {
        switch self {
        case .overview: "rectangle.3.group"
        case .missions: "scope"
        case .agents: "person.2"
        case .sessions: "bubble.left.and.bubble.right"
        case .tasks: "checklist"
        case .approvals: "checkmark.shield"
        case .channels: "antenna.radiowaves.left.and.right"
        case .communications: "message.badge.waveform"
        case .skills: "brain.head.profile"
        case .badRudy: "film.stack"
        case .integrations: "network"
        case .contacts: "person.3"
        case .nodes: "laptopcomputer.and.iphone"
        case .models: "cube"
        case .workflows: "calendar.badge.clock"
        case .workboard: "square.3.layers.3d"
        }
    }
}

struct Agent: Identifiable {
    let id = UUID()
    let name: String
    let role: String
    let model: String
    let status: Status
    let progress: Double
}

enum Status {
    case working, idle
    var label: String { self == .working ? "Working" : "Ready" }
    var color: Color { self == .working ? .orange : .green }
}

struct AgentRecord: Identifiable, Hashable {
    let id: String
    let name: String
    let identity: String
    let workspace: String
    let model: String
    let bindings: String
    let runtime: String
    let status: String

    init?(_ raw: [String: Any]) {
        guard let id = raw["id"] as? String ?? raw["agentId"] as? String else { return nil }
        self.id = id
        self.name = raw["name"] as? String ?? id
        self.identity = raw["identity"] as? String ?? (raw["identityName"] as? String ?? "—")
        self.workspace = raw["workspace"] as? String ?? "—"
        self.model = raw["model"] as? String ?? (raw["modelRef"] as? String ?? "—")
        self.bindings = String(describing: raw["bindings"] ?? "—")
        self.runtime = String(describing: raw["agentRuntime"] ?? raw["runtime"] ?? "default")
        self.status = raw["status"] as? String ?? "Ready"
    }
}

struct SessionRecord: Identifiable, Hashable {
    let id: String
    let key: String
    let agent: String
    let source: String
    let status: String
    let updated: Date?
    let runtime: String
    let placement: String
    let attention: Bool

    init?(_ raw: [String: Any]) {
        guard let key = raw["key"] as? String ?? raw["sessionKey"] as? String else { return nil }
        self.id = key
        self.key = key
        self.agent = raw["agentId"] as? String ?? "default"
        self.source = raw["channel"] as? String ?? raw["source"] as? String ?? "local"
        self.status = raw["status"] as? String ?? "idle"
        let timestamp = raw["updatedAt"] as? Double ?? raw["updatedAtMs"] as? Double
        self.updated = timestamp.map { Date(timeIntervalSince1970: $0 > 10_000_000_000 ? $0 / 1000 : $0) }
        self.runtime = String(describing: raw["agentRuntime"] ?? "default")
        self.placement = raw["placement"] as? String ?? "local"
        self.attention = raw["attention"] as? Bool ?? false
    }
}

struct SessionPage {
    let rows: [SessionRecord]
    let nextOffset: Int?
}

struct TranscriptItem: Identifiable, Hashable {
    let id: String
    let role: String
    let text: String
    let timestamp: Date?
    let kind: String

    init?(_ raw: [String: Any]) {
        let role = raw["role"] as? String ?? "assistant"
        let kind = raw["type"] as? String ?? "message"
        let text: String
        if let content = raw["content"] as? String {
            text = content
        } else if let blocks = raw["content"] as? [[String: Any]] {
            text = blocks.compactMap { $0["text"] as? String }.joined(separator: "\n")
        } else {
            text = raw["text"] as? String ?? ""
        }
        let rawTimestamp = raw["timestamp"] ?? raw["createdAt"] ?? raw["createdAtMs"]
        self.role = role
        self.kind = kind
        self.text = text
        self.timestamp = DateParser.date(rawTimestamp)
        self.id = raw["id"] as? String
            ?? raw["messageId"] as? String
            ?? StableMessageIdentity.make(role: role, kind: kind, text: text, timestamp: rawTimestamp)
    }
}

enum StableMessageIdentity {
    static func make(role: String, kind: String, text: String, timestamp: Any?) -> String {
        let source = "\(role)|\(kind)|\(String(describing: timestamp ?? ""))|\(text)"
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in source.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return "derived-\(String(hash, radix: 16))"
    }
}

struct ContentView: View {
    @EnvironmentObject private var store: StudioStore
    @ObservedObject var communications: RicoCommunicationsStore
    @ObservedObject var badRudy: BadRudyStore
    @ObservedObject var badRudyFeature: BadRudyFeatureRegistry
    @State private var showingSettings = false

    var body: some View {
        NavigationSplitView {
            Sidebar(
                showingSettings: $showingSettings,
                badRudyInstalled: badRudyFeature.isInstalled
            )
        } detail: {
            destination
                .background(StudioBackdrop())
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $showingSettings) { PreferencesView() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            badRudyFeature.refresh()
        }
        .onChange(of: badRudyFeature.isInstalled) { _, installed in
            if !installed, store.selectedSection == .badRudy {
                store.selectedSection = .overview
            }
        }
    }

    @ViewBuilder
    private var destination: some View {
        switch store.selectedSection {
        case .overview:
            RicoCLIView()
        case .missions:
            MissionControlView()
        case .agents:
            page { AgentsView() }
        case .sessions:
            page { SessionsView() }
        case .tasks:
            page { TasksView() }
        case .approvals:
            page { ApprovalsView() }
        case .channels:
            page { ChannelsView() }
        case .communications:
            page { RicoCommunicationsView(store: communications) }
        case .skills:
            page { RicoSkillsView() }
        case .badRudy:
            page {
                BadRudyView(
                    store: badRudy,
                    allowlistedRecipients: communications.policies
                        // Bad Rudy's reviewed attachment contract currently
                        // accepts exact phone/email principals only. Group
                        // destinations remain governed by Rico Communications
                        // and are not offered until that contract explicitly
                        // supports an exact reviewed chat target.
                        .filter { $0.access != .blocked && $0.groupChatID == nil }
                        .map {
                            BadRudyRecipient(
                                id: $0.id,
                                displayName: $0.displayName,
                                handle: $0.address
                            )
                        }
                )
            }
        case .integrations:
            page { MCPIntegrationsView() }
        case .contacts:
            page { ContactsView() }
        case .nodes:
            page { NodesDevicesView() }
        case .workflows:
            page { AutomationHubView() }
        case .workboard:
            page { WorkboardView() }
        case .models:
            page { ModelsView() }
        }
    }

    private func page<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        ScrollView {
            content()
                .frame(maxWidth: 1_240, alignment: .leading)
                .padding(32)
                .frame(maxWidth: .infinity, alignment: .top)
        }
    }
}

struct AutomationsView: View {
    @EnvironmentObject private var store: StudioStore
    @State private var selected: CronJobRecord?
    @State private var runID: String?
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { VStack(alignment: .leading) { Text("Automations").font(.largeTitle.bold()); Text("\(store.cronJobs.count) scheduled jobs · scheduler: \(store.cronStatus) · timezone is shown per job").foregroundStyle(.secondary) }; Spacer(); Button { store.refresh() } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.bordered) }
            if let error { Text(error).foregroundStyle(.red) }
            ForEach(store.cronJobs) { job in
                HStack { Image(systemName: job.enabled ? "calendar.badge.clock" : "pause.circle").foregroundStyle(job.enabled ? .green : .secondary); VStack(alignment: .leading) { Text(job.name).font(.headline); Text("\(job.schedule) · \(job.timezone)").font(.caption).foregroundStyle(.secondary); Text("Next: \(job.nextRun?.formatted() ?? "—") · Last: \(job.lastRun?.formatted() ?? "—")").font(.caption2).foregroundStyle(.secondary) }; Spacer(); Button("Run now") { Task { do { try await store.runCron(job: job); runID = "Tracked: \(store.cronRunState ?? "unknown")" } catch { self.error = error.localizedDescription } } }.buttonStyle(.bordered); Button("Details") { selected = job }.buttonStyle(.bordered) }.padding(14).background(.background).clipShape(RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).stroke(.quaternary))
            }
            if let runID { Text("Manual run \(runID) was enqueued. The Gateway run history is being tracked; enqueue is not completion.").font(.callout).foregroundStyle(.orange) }
            Text("Add/update/remove are intentionally deferred until the installed Gateway schema is queried and a validated editor is available.").font(.caption).foregroundStyle(.secondary)
        }.sheet(item: $selected) { job in VStack(alignment: .leading, spacing: 12) { Text(job.name).font(.title2.bold()); Text("Schedule: \(job.schedule)\nTimezone: \(job.timezone)\nEnabled: \(job.enabled ? "Yes" : "No")\nNext run: \(job.nextRun?.formatted() ?? "—")\nLast run: \(job.lastRun?.formatted() ?? "—")").textSelection(.enabled); Button("Close") { selected = nil }.buttonStyle(.borderedProminent) }.padding(28).frame(width: 520, height: 300) }
    }
}

struct ChannelsView: View {
    @EnvironmentObject private var store: StudioStore
    var body: some View { VStack(alignment: .leading, spacing: 18) { Text("Channels").font(.largeTitle.bold()); Text("Live connection and authentication state, with credentials always hidden.").foregroundStyle(.secondary); ForEach(store.channelRecords) { channel in HStack { Image(systemName: channel.connected ? "checkmark.circle.fill" : "circle").foregroundStyle(channel.connected ? .green : .secondary); VStack(alignment: .leading) { Text("\(channel.id) · \(channel.account)").font(.headline); Text("State: \(channel.state) · Auth: \(channel.auth)").font(.caption).foregroundStyle(.secondary) }; Spacer(); Text(channel.connected ? "Connected" : "Not connected").font(.caption.weight(.semibold)).foregroundStyle(channel.connected ? .green : .secondary) } .padding(14).background(.background).clipShape(RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).stroke(.quaternary)) }; if store.channelRecords.isEmpty { ContentUnavailableView("No channels reported", systemImage: "point.3.connected.trianglepath.dotted", description: Text("OpenClaw has not reported a configured channel yet.")) } }.padding(.vertical) }
}

struct NodesDevicesView: View {
    @EnvironmentObject private var store: StudioStore
    var body: some View { VStack(alignment: .leading, spacing: 18) { Text("Nodes & Devices").font(.largeTitle.bold()); Text("Capabilities and last-seen state. Arbitrary node invocation is not enabled.").foregroundStyle(.secondary); Text("Nodes").font(.headline); ForEach(store.nodeRecords) { node in HStack { Image(systemName: "laptopcomputer").foregroundStyle(.blue); VStack(alignment: .leading) { Text(node.name).font(.headline); Text("\(node.id) · \(node.platform) · \(node.capabilities)").font(.caption).foregroundStyle(.secondary) }; Spacer(); Text(node.lastSeen?.formatted() ?? "Never seen").font(.caption).foregroundStyle(.secondary) }.padding(12) }; Divider(); Text("Devices / pairing").font(.headline); ForEach(store.deviceRecords) { device in HStack { VStack(alignment: .leading) { Text(device.name).font(.headline); Text("\(device.id) · \(device.roles) · \(device.state)").font(.caption).foregroundStyle(.secondary) }; Spacer(); Text(device.lastSeen?.formatted() ?? "Pending").font(.caption) }.padding(12) } }.padding(.vertical) }
}

struct ModelsView: View {
    @EnvironmentObject private var store: StudioStore
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Models").font(.largeTitle.bold())
            Text("Configured catalog and authentication status. Read-only in this release.")
                .foregroundStyle(.secondary)
            ForEach(store.modelRecords) { model in
                ModelRow(model: model)
            }
        }
        .padding(.vertical)
    }
}

struct ModelRow: View {
    let model: ModelRecord
    var body: some View {
        let icon = model.available ? "cube.fill" : "exclamationmark.triangle"
        let color: Color = model.available ? .green : .orange
        let label = model.warning.isEmpty ? (model.configured ? "Configured" : "Available") : model.warning
        let labelColor: Color = model.warning.isEmpty ? .secondary : .orange
        return HStack {
            Image(systemName: icon).foregroundStyle(color)
            VStack(alignment: .leading) {
                Text(model.id).font(.headline)
                Text("Provider: \(model.provider) · Auth: \(model.auth)")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text(label).font(.caption).foregroundStyle(labelColor)
        }
        .padding(14)
        .background(.background)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.quaternary))
    }
}

struct AgentsView: View {
    @EnvironmentObject private var store: StudioStore
    @State private var query = ""
    @State private var sortAscending = true
    @State private var selected: AgentRecord?
    @State private var showEditor = false
    @State private var showDeleteConfirmation = false
    @State private var error: String?

    private var rows: [AgentRecord] {
        let filtered = store.agentRecords.filter {
            query.isEmpty || [$0.id, $0.name, $0.model, $0.workspace].joined(separator: " ").localizedCaseInsensitiveContains(query)
        }
        return filtered.sorted { sortAscending ? $0.name < $1.name : $0.name > $1.name }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Agents").font(.largeTitle.weight(.bold))
                    Text("\(rows.count) visible · sourced from agents.list").foregroundStyle(.secondary)
                }
                Spacer()
                Button { selected = nil; showEditor = true } label: { Label("New Agent", systemImage: "plus") }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut("n", modifiers: [.command])
            }
            HStack {
                TextField("Search agents", text: $query).textFieldStyle(.roundedBorder)
                Menu("Sort") {
                    Button("Name A–Z") { sortAscending = true }
                    Button("Name Z–A") { sortAscending = false }
                }
                Button { store.refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.bordered)
            }
            if let error { Text(error).foregroundStyle(.red).font(.callout) }
            Panel(title: "Agent directory", subtitle: "Identity, workspace, model, bindings, and runtime metadata") {
                if rows.isEmpty {
                    ContentUnavailableView("No agents found", systemImage: "person.2.slash", description: Text("Try a different search or refresh the gateway."))
                } else {
                    ForEach(rows) { agent in
                        AgentRow(agent: agent)
                            .contentShape(Rectangle())
                            .contextMenu {
                                Button("Copy Identifier") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(agent.id, forType: .string) }
                                Button("Edit") { selected = agent; showEditor = true }
                                Divider()
                                Button("Delete", role: .destructive) { selected = agent; showDeleteConfirmation = true }
                            }
                            .onTapGesture { selected = agent }
                        if agent.id != rows.last?.id { Divider() }
                    }
                }
            }
        }
        .sheet(isPresented: $showEditor) {
            AgentEditor(agent: selected) { id, name, workspace, model in
                do {
                    if selected == nil { try await store.createAgent(name: name, workspace: workspace, model: model) }
                    else { try await store.updateAgent(id: id, name: name, workspace: workspace, model: model) }
                } catch let failure { error = failure.localizedDescription }
            }
        }
        .confirmationDialog("Delete \(selected?.name ?? "agent")?", isPresented: $showDeleteConfirmation, titleVisibility: .visible) {
            Button("Delete Agent", role: .destructive) {
                guard let id = selected?.id else { return }
                Task { do { try await store.deleteAgent(id: id) } catch let failure { error = failure.localizedDescription } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("OpenClaw removes this agent from its configuration and clears its bindings. The agent workspace, agent data, and session files are preserved on disk.")
        }
    }
}

struct TasksView: View {
    @EnvironmentObject private var store: StudioStore
    @State private var query = ""
    @State private var selected: TaskRecord?
    @State private var cancelTarget: TaskRecord?
    @State private var showCancel = false
    private let groups = ["Needs Attention", "Running", "Queued", "Completed", "Failed", "Cancelled"]

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { VStack(alignment: .leading) { Text("Tasks").font(.largeTitle.bold()); Text("Gateway task ledger · \(store.taskRecords.count) loaded").foregroundStyle(.secondary) }; Spacer(); Button { store.refresh() } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.bordered) }
            TextField("Filter tasks by id, owner, session, or summary", text: $query).textFieldStyle(.roundedBorder)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(groups, id: \.self) { group in
                        let rows = store.taskRecords.filter { $0.group == group && (query.isEmpty || "\($0.id) \($0.owner) \($0.session) \($0.summary)".localizedCaseInsensitiveContains(query)) }
                        if !rows.isEmpty {
                            Text(group.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            ForEach(rows) { task in
                                TaskRow(task: task, inspect: { selected = task }, cancel: { cancelTarget = task; showCancel = true })
                            }
                        }
                    }
                }
            }
        }
        .sheet(item: $selected) { task in TaskDetailView(task: task) }
        .confirmationDialog("Cancel task?", isPresented: $showCancel, titleVisibility: .visible) {
            Button("Cancel \(cancelTarget?.id ?? "task")", role: .destructive) {
                if let task = cancelTarget { Task { do { try await store.cancel(task: task) } catch { store.report(error, area: "tasks") } } }
            }
            Button("Keep Running", role: .cancel) {}
        } message: {
            Text("Exact target: \(cancelTarget?.id ?? "—")\nOwner: \(cancelTarget?.owner ?? "—")\nSession: \(cancelTarget?.session ?? "—")\nOpenClaw must confirm cancellation before the task is shown as cancelled.")
        }
    }
}

struct TaskRow: View {
    let task: TaskRecord; let inspect: () -> Void; let cancel: () -> Void
    var body: some View {
        HStack {
            Image(systemName: task.isTerminal ? "checkmark.circle" : "arrow.triangle.2.circlepath").foregroundStyle(task.state == "failed" ? .red : .orange)
            VStack(alignment: .leading, spacing: 4) { Text(task.summary).font(.headline); Text("\(task.id) · \(task.owner) · \(task.session)").font(.caption).foregroundStyle(.secondary) }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) { Text(task.state.capitalized).font(.caption.weight(.medium)); Text(task.progress).font(.caption2).foregroundStyle(.secondary) }
            if !task.isTerminal { Button("Cancel", role: .destructive, action: cancel).buttonStyle(.bordered) }
        }
        .padding(14).background(.background).clipShape(RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).stroke(.quaternary))
        .onTapGesture(perform: inspect)
        .contextMenu { Button("Copy Task ID") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(task.id, forType: .string) }; Button("Inspect", action: inspect) }
    }
}

struct TaskDetailView: View {
    @Environment(\.dismiss) private var dismiss
    let task: TaskRecord
    var body: some View {
        VStack(alignment: .leading, spacing: 14) { Text("Task detail").font(.title2.bold()); Text("ID: \(task.id)\nState: \(task.state)\nOwner: \(task.owner)\nSession: \(task.session)\nCreated: \(task.created?.formatted() ?? "—")\nUpdated: \(task.updated?.formatted() ?? "—")\nElapsed: \(task.elapsed)\nProgress: \(task.progress)\n\n\(task.error)").textSelection(.enabled); Spacer(); Button("Close") { dismiss() }.buttonStyle(.borderedProminent) }.padding(28).frame(width: 560, height: 420)
    }
}

struct ApprovalsView: View {
    @EnvironmentObject private var store: StudioStore
    @State private var selected: ApprovalRecord?
    @State private var confirmTarget: ApprovalRecord?
    @State private var decision: ApprovalDecision?
    @State private var showConfirmation = false
    @State private var query = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { VStack(alignment: .leading) { Text("Approvals").font(.largeTitle.bold()); Text("Approve once only · \(store.approvalRecords.filter(\.isPending).count) pending").foregroundStyle(.secondary) }; Spacer(); Button { store.refresh() } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.bordered) }
            TextField("Filter approvals", text: $query).textFieldStyle(.roundedBorder)
            if store.approvalRecords.filter({ $0.isPending && (query.isEmpty || "\($0.id) \($0.operation) \($0.agent) \($0.session)".localizedCaseInsensitiveContains(query)) }).isEmpty {
                ContentUnavailableView("No pending approvals", systemImage: "checkmark.shield", description: Text("New requests will appear here and trigger a macOS notification."))
            } else {
                ScrollView { LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(store.approvalRecords.filter { $0.isPending && (query.isEmpty || "\($0.id) \($0.operation) \($0.agent) \($0.session)".localizedCaseInsensitiveContains(query)) }) { approval in ApprovalRow(approval: approval, select: { selected = approval }, decide: { value in confirmTarget = approval; decision = value; showConfirmation = true }) }
                } }
            }
            Divider()
            Text("Local decision log").font(.headline)
            ForEach(store.auditEntries.prefix(8)) { entry in Text("\(entry.timestamp.formatted(date: .abbreviated, time: .standard)) · \(entry.action) · \(entry.target) · \(entry.result)").font(.caption).foregroundStyle(.secondary) }
        }
        .sheet(item: $selected) { approval in ApprovalDetailView(approval: approval) }
        .onAppear {
            if let id = NotificationController.pendingApprovalID,
               let approval = store.approvalRecords.first(where: { $0.id == id }) {
                selected = approval
                NotificationController.pendingApprovalID = nil
            }
        }
        .confirmationDialog("Confirm approval decision", isPresented: $showConfirmation, titleVisibility: .visible) {
            if decision == .approve { Button(confirmTarget?.destructive == true ? "Approve Once (extra confirmation)" : "Approve Once") { if let approval = confirmTarget { Task { do { try await store.resolve(approval: approval, decision: .approve) } catch { store.report(error, area: "approvals") } } } }.keyboardShortcut(.defaultAction) }
            if decision == .reject { Button("Reject Request", role: .destructive) { if let approval = confirmTarget { Task { do { try await store.resolve(approval: approval, decision: .reject) } catch { store.report(error, area: "approvals") } } } } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(confirmTarget?.operation ?? "—")\nAgent: \(confirmTarget?.agent ?? "—")\nSession: \(confirmTarget?.session ?? "—")\nTarget: \(confirmTarget?.node ?? "—")\nRisk: \(confirmTarget?.risk ?? "—")\n\nArguments:\n\(confirmTarget?.arguments ?? "—")")
        }
    }
}

struct ApprovalRow: View {
    let approval: ApprovalRecord; let select: () -> Void; let decide: (ApprovalDecision) -> Void
    var body: some View {
        HStack(alignment: .top) { Image(systemName: approval.destructive ? "exclamationmark.triangle.fill" : "checkmark.shield.fill").foregroundStyle(approval.destructive ? .red : .orange)
            VStack(alignment: .leading, spacing: 5) { Text(approval.operation).font(.headline); Text("\(approval.agent) · \(approval.session) · \(approval.node)").font(.caption).foregroundStyle(.secondary); Text(approval.risk).font(.callout) }
            Spacer(); Button("Details", action: select).buttonStyle(.bordered); Button("Reject") { decide(.reject) }.buttonStyle(.bordered); Button("Approve Once") { decide(.approve) }.buttonStyle(.borderedProminent)
        }.padding(15).background(.background).clipShape(RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).stroke(approval.destructive ? AnyShapeStyle(.red.opacity(0.5)) : AnyShapeStyle(.quaternary)))
    }
}

struct ApprovalDetailView: View {
    @Environment(\.dismiss) private var dismiss
    let approval: ApprovalRecord
    var body: some View { VStack(alignment: .leading, spacing: 12) { Text("Approval detail").font(.title2.bold()); Text("ID: \(approval.id)\nKind: \(approval.kind)\nAgent: \(approval.agent)\nSession: \(approval.session)\nOperation: \(approval.operation)\nTarget: \(approval.node)\nExpires: \(approval.expires?.formatted() ?? "—")\nRisk: \(approval.risk)\n\nArguments:\n\(approval.arguments)").textSelection(.enabled); Spacer(); Button("Close") { dismiss() }.buttonStyle(.borderedProminent) }.padding(28).frame(width: 620, height: 500) }
}

struct AgentRow: View {
    let agent: AgentRecord
    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "sparkles").frame(width: 36, height: 36).background(.orange.opacity(0.15)).clipShape(Circle()).foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 4) {
                Text(agent.name).font(.headline)
                Text(agent.identity == "—" ? agent.id : agent.identity).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text(agent.model).font(.subheadline)
                Text("\(agent.workspace) · \(agent.runtime)").font(.caption).foregroundStyle(.secondary)
            }
            Text(agent.status).font(.caption.weight(.medium)).foregroundStyle(.green).frame(width: 70, alignment: .trailing)
        }
        .padding(.vertical, 6)
    }
}

struct AgentEditor: View {
    @Environment(\.dismiss) private var dismiss
    let agent: AgentRecord?
    let onSave: (String, String, String, String) async -> Void
    @State private var id = ""
    @State private var name = ""
    @State private var workspace = ""
    @State private var model = ""
    @State private var review = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(agent == nil ? "New Agent" : "Edit Agent").font(.title2.bold())
            Text("Only fields supported by the agents RPC are sent. Changes are reviewed before applying.")
                .font(.callout).foregroundStyle(.secondary)
            if agent != nil {
                TextField("Agent ID", text: $id).disabled(true)
            } else {
                Text("OpenClaw generates the agent ID from the display name.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            TextField("Display name", text: $name)
            TextField("Workspace", text: $workspace)
            TextField("Model", text: $model)
            HStack { Spacer(); Button("Cancel") { dismiss() }; Button("Review Changes") { review = true }.buttonStyle(.borderedProminent).disabled((agent != nil && id.isEmpty) || name.isEmpty || workspace.isEmpty || model.isEmpty) }
        }
        .padding(28).frame(width: 480)
        .onAppear { id = agent?.id ?? ""; name = agent?.name ?? ""; workspace = agent?.workspace == "—" ? "" : agent?.workspace ?? ""; model = agent?.model == "—" ? "" : agent?.model ?? "" }
        .sheet(isPresented: $review) {
            VStack(alignment: .leading, spacing: 14) {
                Text("Review agent change").font(.title2.bold())
                Text("ID: \(agent == nil ? "Generated from name by OpenClaw" : id)\nName: \(name)\nWorkspace: \(workspace)\nModel: \(model)").font(.body)
                HStack { Spacer(); Button("Back") { review = false }; Button("Apply") { Task { await onSave(id, name, workspace, model); dismiss() } }.buttonStyle(.borderedProminent) }
            }.padding(28).frame(width: 480)
        }
    }
}

struct SessionsView: View {
    @EnvironmentObject private var store: StudioStore
    @State private var query = ""
    @State private var selected: SessionRecord?
    @State private var sortNewest = true

    private var rows: [SessionRecord] {
        let filtered = store.sessionRecords.filter {
            query.isEmpty || [$0.key, $0.agent, $0.source, $0.status].joined(separator: " ").localizedCaseInsensitiveContains(query)
        }
        return filtered.sorted { a, b in sortNewest ? (a.updated ?? .distantPast) > (b.updated ?? .distantPast) : a.key < b.key }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 20) {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) { Text("Sessions").font(.largeTitle.weight(.bold)); Text("\(rows.count) loaded · paginated").foregroundStyle(.secondary) }
                    Spacer()
                    Button { store.refresh() } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.bordered)
                }
                HStack {
                    TextField("Search sessions", text: $query).textFieldStyle(.roundedBorder)
                    Menu("Sort") { Button("Newest") { sortNewest = true }; Button("Identifier") { sortNewest = false } }
                }
                List(selection: $selected) {
                    ForEach(rows) { session in
                        SessionRow(session: session).tag(session)
                    }
                    if store.sessionOffset != nil {
                        Button("Load more") { Task { await store.loadMoreSessions() } }
                    }
                }
                .listStyle(.inset)
            }
            .frame(minWidth: 440, idealWidth: 500)
            if let selected {
                TranscriptView(session: selected)
            } else {
                ContentUnavailableView("Select a session", systemImage: "bubble.left.and.bubble.right", description: Text("Session transcripts are loaded only when selected."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

struct SessionRow: View {
    let session: SessionRecord
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: session.attention ? "exclamationmark.circle.fill" : "bubble.left.fill")
                .foregroundStyle(session.attention ? .orange : .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(session.key).lineLimit(1)
                Text("\(session.agent) · \(session.source) · \(session.placement)").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                Text(session.status).font(.caption.weight(.medium))
                if let updated = session.updated { Text(updated, style: .relative).font(.caption2).foregroundStyle(.secondary) }
            }
        }
        .contextMenu {
            Button("Copy Session Identifier") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(session.key, forType: .string) }
        }
        .padding(.vertical, 4)
    }
}

struct TranscriptView: View {
    @EnvironmentObject private var store: StudioStore
    let session: SessionRecord
    @State private var messages: [TranscriptItem] = []
    @State private var draft = ""
    @State private var loading = true
    @State private var sending = false
    @State private var error: String?
    @State private var sendMode: SendMode = .send
    @State private var confirmStop = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) { Text(session.key).font(.headline); Text("\(session.agent) · \(session.runtime) · \(session.placement)").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Button("Copy ID") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(session.key, forType: .string) }.buttonStyle(.bordered)
                if session.status == "active" || session.status == "working" {
                    Button("Stop", role: .destructive) { confirmStop = true }.buttonStyle(.bordered)
                }
            }.padding(18)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if loading { ProgressView().frame(maxWidth: .infinity).padding(40) }
                        ForEach(messages) { message in TranscriptBubble(message: message).id(message.id) }
                        if let error { Text(error).foregroundStyle(.red).font(.callout) }
                    }.padding(20)
                }
                .onChange(of: messages) { _, value in if let last = value.last { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
            Divider()
            HStack(alignment: .bottom) {
                Picker("", selection: $sendMode) {
                    ForEach(SendMode.allCases) { Text($0.label).tag($0) }
                }.pickerStyle(.menu).labelsHidden()
                TextField("Message this session", text: $draft, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...5)
                Button { submit() } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                    .buttonStyle(.plain).disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
            }.padding(16)
        }
        .background(.background)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .task(id: session.key) {
            loading = true; error = nil
            do { messages = try await store.history(session: session) }
            catch let failure { error = failure.localizedDescription }
            loading = false
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(3))
                    guard !sending else { continue }
                    messages = try await store.history(session: session)
                } catch is CancellationError {
                    return
                } catch {
                    self.error = error.localizedDescription
                }
            }
        }
        .confirmationDialog("Stop this session?", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("Stop Active Work", role: .destructive) {
                Task { do { try await store.abort(session: session) } catch let failure { error = failure.localizedDescription } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("OpenClaw will abort active work for this session. This cannot be undone.")
        }
    }

    private func submit() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let optimistic = TranscriptItem(id: UUID().uuidString, role: "user", text: text, timestamp: Date(), kind: "message")
        messages.append(optimistic); draft = ""; sending = true; error = nil
        Task {
            do {
                if sendMode == .send {
                    let receipt = try await store.send(session: session, text: text)
                    let result = try await store.waitForRun(receipt.runID)
                    guard result.completedSuccessfully else {
                        throw GatewayClientError.rejected(result.error ?? "Run ended with status: \(result.status).")
                    }
                } else {
                    try await store.inject(session: session, text: text)
                }
                messages = try await store.history(session: session)
            }
            catch let failure {
                messages.removeAll { $0.id == optimistic.id }
                error = failure.localizedDescription
            }
            sending = false
        }
    }
}

enum SendMode: String, CaseIterable, Identifiable {
    case send, inject
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

extension TranscriptItem {
    init(id: String, role: String, text: String, timestamp: Date?, kind: String) {
        self.id = id; self.role = role; self.text = text; self.timestamp = timestamp; self.kind = kind
    }
}

struct TranscriptBubble: View {
    let message: TranscriptItem
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: message.role == "user" ? "person.fill" : message.kind == "tool" ? "wrench.and.screwdriver.fill" : "sparkles")
                .foregroundStyle(message.role == "user" ? .blue : .orange).frame(width: 22)
            VStack(alignment: .leading, spacing: 5) {
                HStack { Text(message.role.capitalized).font(.caption.weight(.semibold)); if let time = message.timestamp { Text(time, style: .time).font(.caption2).foregroundStyle(.secondary) } }
                if message.kind == "attachment" {
                    Label("Attachment", systemImage: "paperclip").foregroundStyle(.secondary)
                } else if let markdown = try? AttributedString(markdown: message.text, options: .init(interpretedSyntax: .full)) {
                    Text(markdown)
                } else {
                    Text(message.text)
                }
            }
            Spacer()
        }
        .padding(12)
        .background(message.role == "user" ? Color.blue.opacity(0.08) : Color.orange.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .textSelection(.enabled)
    }
}

struct Sidebar: View {
    @EnvironmentObject private var store: StudioStore
    @Binding var showingSettings: Bool
    let badRudyInstalled: Bool

    private let primary: [Section] = [.overview, .missions, .workflows]
    private let operations: [Section] = [.tasks, .approvals, .workboard, .sessions]
    private let system: [Section] = [.agents, .nodes, .models]

    private var connections: [Section] {
        badRudyInstalled
            ? [.communications, .skills, .badRudy, .integrations, .channels, .contacts]
            : [.communications, .skills, .integrations, .channels, .contacts]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 11) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(LinearGradient(colors: [StudioDesign.accent, StudioDesign.violet], startPoint: .topLeading, endPoint: .bottomTrailing))
                    Text("R").font(.headline.bold()).foregroundStyle(.white)
                }.frame(width: 34, height: 34)
                VStack(alignment: .leading) {
                    Text("Rico").font(.headline)
                    Text("OpenClaw Studio").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 12)
            Divider().opacity(0.55)
            sectionGroup("CORE", sections: primary)
            sectionGroup("CONTROL CENTER", sections: operations)
            sectionGroup("CONNECTIONS", sections: connections)
            DisclosureGroup {
                VStack(spacing: 3) { ForEach(system) { navigationRow($0) } }
            } label: {
                Text("SYSTEM").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
            }.padding(.horizontal, 8)
            Spacer()
            VStack(alignment: .leading, spacing: 10) {
                StudioStatusPill(label: store.gatewayOnline ? "Gateway online" : "Gateway offline", color: store.gatewayOnline ? .green : .orange)
                Button { showingSettings = true } label: {
                    Label("Settings", systemImage: "gearshape")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .padding(.vertical, 7)
            }
            .padding(.horizontal, 8)
        }
        .padding(16)
        .navigationSplitViewColumnWidth(min: 208, ideal: 228)
        .background(.ultraThinMaterial)
    }

    private func sectionGroup(_ title: String, sections: [Section]) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption2.weight(.bold)).foregroundStyle(.secondary).padding(.horizontal, 12).padding(.bottom, 4)
            ForEach(sections) { navigationRow($0) }
        }
    }

    private func navigationRow(_ section: Section) -> some View {
        Button {
            withAnimation(.easeOut(duration: 0.16)) { store.selectedSection = section }
        } label: {
            Label(section == .overview ? "Command" : section.rawValue, systemImage: section.symbol)
                .font(.subheadline.weight(store.selectedSection == section ? .semibold : .regular))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .padding(.vertical, 8).padding(.horizontal, 11)
        .foregroundStyle(store.selectedSection == section ? .primary : .secondary)
        .background(store.selectedSection == section ? StudioDesign.accent.opacity(0.13) : .clear)
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
}

struct Header: View {
    @EnvironmentObject private var store: StudioStore
    @Binding var showingSettings: Bool
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(store.selectedSection.rawValue)
                    .font(.title2.weight(.semibold))
                Text("Your local OpenClaw command center")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button { store.refresh() } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            Button("Settings") { showingSettings = true }
                .buttonStyle(.bordered)
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 15)
        .background(.ultraThinMaterial)
    }
}

struct Dashboard: View {
    @EnvironmentObject private var store: StudioStore
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(spacing: 16) {
                MetricCard(title: "Gateway", value: store.gatewayOnline ? "Online" : "Offline", detail: store.gatewayVersion, color: store.gatewayOnline ? .green : .red, icon: "bolt.fill")
                MetricCard(title: "Agents", value: "\(store.agentRecords.count)", detail: "from agents.list", color: .orange, icon: "person.2.fill")
                MetricCard(title: "Active tasks", value: "\(store.taskRecords.filter { $0.state == "running" }.count)", detail: "from tasks.list", color: .blue, icon: "checklist")
                MetricCard(title: "Approvals", value: "\(store.approvalRecords.count)", detail: "from approval RPCs", color: .purple, icon: "checkmark.shield")
            }
            HStack(alignment: .top, spacing: 20) {
                Panel(title: "Activity", subtitle: "Canonical activity surfaces are available in Sessions, Tasks, Approvals, and Workboard.") {
                    Text("No synthetic activity is displayed. Open the relevant control-plane surface for live Gateway data.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Panel(title: "System health", subtitle: store.gatewayError ?? (store.gatewayOnline ? "Gateway reachable" : "Gateway unavailable")) {
                    VStack(alignment: .leading, spacing: 14) {
                        HealthRow(label: "Gateway", value: store.gatewayOnline ? "Connected" : "Unavailable", color: store.gatewayOnline ? .green : .red)
                        HealthRow(label: "Agents RPC", value: store.adminErrors["agents"] == nil ? "Available" : "Unavailable", color: store.adminErrors["agents"] == nil ? .green : .red)
                        HealthRow(label: "Tasks RPC", value: store.adminErrors["tasks"] == nil ? "Available" : "Unavailable", color: store.adminErrors["tasks"] == nil ? .green : .red)
                        Divider()
                        Text("Last checked \(store.lastRefresh.formatted(date: .omitted, time: .shortened))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: 310)
            }
            Panel(title: "Agents", subtitle: "Live records from the Gateway agents.list RPC") {
                ForEach(store.agentRecords) { agent in
                    HStack {
                        Image(systemName: "person.circle").foregroundStyle(.orange)
                        VStack(alignment: .leading) {
                            Text(agent.name).font(.headline)
                            Text("\(agent.model) · \(agent.status)").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(agent.id).font(.caption2).foregroundStyle(.secondary)
                    }.padding(.vertical, 5)
                }
                if store.agentRecords.isEmpty { Text("No agent records returned.").font(.caption).foregroundStyle(.secondary) }
            }
        }
    }
}

struct MetricCard: View {
    let title: String; let value: String; let detail: String; let color: Color; let icon: String
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Image(systemName: icon).foregroundStyle(color); Spacer(); Image(systemName: "ellipsis").foregroundStyle(.secondary) }
            Text(value).font(.title.weight(.bold))
            Text(title).font(.headline)
            Text(detail).font(.caption).foregroundStyle(.secondary)
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
        .background(.background).clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(.quaternary))
    }
}

struct Panel<Content: View>: View {
    let title: String; let subtitle: String; @ViewBuilder let content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 3) { Text(title).font(.headline); Text(subtitle).font(.caption).foregroundStyle(.secondary) }
            content()
        }
        .padding(22).frame(maxWidth: .infinity, alignment: .leading)
        .background(.background).clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(.quaternary))
    }
}

struct ActivityRow: View {
    let icon: String; let title: String; let detail: String; let progress: Double?; let color: Color
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).foregroundStyle(color).frame(width: 20)
            VStack(alignment: .leading, spacing: 7) { Text(title).font(.subheadline.weight(.medium)); Text(detail).font(.caption).foregroundStyle(.secondary); if let progress { ProgressView(value: progress) } }
        }
    }
}

struct HealthRow: View {
    let label: String; let value: String; let color: Color
    var body: some View { HStack { Circle().fill(color).frame(width: 8, height: 8); Text(label); Spacer(); Text(value).foregroundStyle(.secondary) }.font(.subheadline) }
}
