import SwiftUI
import Foundation

// MARK: - Gateway cron proposal

/// A deliberately small, typed subset of the installed OpenClaw `cron.add`
/// contract. Rico can propose these values, but only the review screen can
/// cross the separate creation boundary.
struct AutomationProposal: Sendable, Equatable {
    let declarationKey: String
    let name: String
    let description: String
    let agentID: String
    let schedule: AutomationSchedule
    let action: String
    let delivery: AutomationDelivery
    let sessionTarget: String
    let wakeMode: String

    var mayCommunicateExternally: Bool {
        if case .announce = delivery { return true }
        let text = action.lowercased()
        return ["send ", "email ", "message ", "post ", "publish ", "upload ", "text "].contains { text.contains($0) }
    }

    func gatewayJSON(enabled: Bool) -> String {
        guard JSONSerialization.isValidJSONObject(gatewayParameters(enabled: enabled)),
              let data = try? JSONSerialization.data(
                withJSONObject: gatewayParameters(enabled: enabled),
                options: [.prettyPrinted, .sortedKeys]
              )
        else { return "Unable to render Gateway request." }
        return String(decoding: data, as: UTF8.self)
    }

    /// Exact fields accepted by the installed `CronAddParamsSchema`.
    func gatewayParameters(enabled: Bool) -> [String: Any] {
        [
            "name": name,
            "declarationKey": declarationKey,
            "description": description,
            "enabled": enabled,
            "agentId": agentID,
            "schedule": schedule.gatewayObject,
            "sessionTarget": sessionTarget,
            "wakeMode": wakeMode,
            "payload": ["kind": "agentTurn", "message": action],
            "delivery": delivery.gatewayObject,
        ]
    }
}

enum AutomationSchedule: Sendable, Equatable {
    case at(String)
    case every(milliseconds: Int)
    case cron(expression: String, timezone: String?)

    var gatewayObject: [String: Any] {
        switch self {
        case .at(let timestamp):
            ["kind": "at", "at": timestamp]
        case .every(let milliseconds):
            ["kind": "every", "everyMs": milliseconds]
        case .cron(let expression, let timezone):
            if let timezone, !timezone.isEmpty {
                ["kind": "cron", "expr": expression, "tz": timezone]
            } else {
                ["kind": "cron", "expr": expression]
            }
        }
    }

    var kindLabel: String {
        switch self {
        case .at: "One time"
        case .every: "Repeating interval"
        case .cron: "Cron schedule"
        }
    }

    var technicalLabel: String {
        switch self {
        case .at(let timestamp): timestamp
        case .every(let milliseconds): "everyMs: \(milliseconds)"
        case .cron(let expression, _): expression
        }
    }

    var timezoneLabel: String {
        switch self {
        case .cron(_, let timezone): timezone ?? "Gateway host timezone"
        case .at: "Encoded in timestamp"
        case .every: "Not timezone-dependent"
        }
    }

    var naturalLabel: String {
        switch self {
        case .at(let timestamp):
            guard let date = AutomationDateParser.isoDate(timestamp) else { return "Once at \(timestamp)" }
            return "Once · \(date.formatted(date: .abbreviated, time: .shortened))"
        case .every(let milliseconds):
            return "Every \(AutomationDurationFormatter.string(milliseconds: milliseconds))"
        case .cron(let expression, _):
            return AutomationCronPreview.summary(expression: expression)
        }
    }

    func nextRun(after date: Date = Date()) -> Date? {
        switch self {
        case .at(let timestamp):
            guard let run = AutomationDateParser.isoDate(timestamp), run > date else { return nil }
            return run
        case .every(let milliseconds):
            return date.addingTimeInterval(Double(milliseconds) / 1_000)
        case .cron(let expression, let timezone):
            return AutomationCronPreview.nextRun(expression: expression, timezone: timezone, after: date)
        }
    }
}

enum AutomationDelivery: Sendable, Equatable {
    case none
    case announce(channel: String?, target: String?)

    var gatewayObject: [String: Any] {
        switch self {
        case .none:
            return ["mode": "none"]
        case .announce(let channel, let target):
            var value: [String: Any] = ["mode": "announce"]
            if let channel, !channel.isEmpty { value["channel"] = channel }
            if let target, !target.isEmpty { value["to"] = target }
            return value
        }
    }

    var label: String {
        switch self {
        case .none:
            "Keep the final response in OpenClaw"
        case .announce(let channel, let target):
            [channel ?? "last channel", target].compactMap { $0 }.joined(separator: " · ")
        }
    }
}

struct AutomationCreationResult: Sendable, Equatable {
    let jobID: String
    let name: String
    let enabled: Bool
    let nextRun: Date?
}

enum AutomationProposalError: LocalizedError, Equatable {
    case openClawUnavailable
    case commandFailed(String)
    case noAgentReply
    case invalidAgentEnvelope
    case invalidProposal(String)
    case invalidCreationResponse

    var errorDescription: String? {
        switch self {
        case .openClawUnavailable:
            "OpenClaw CLI was not found. Install or repair OpenClaw, then try again."
        case .commandFailed(let message):
            message.isEmpty ? "OpenClaw could not complete the request." : message
        case .noAgentReply:
            "Rico returned no proposal. Nothing was created."
        case .invalidAgentEnvelope:
            "OpenClaw returned an unreadable agent response. Nothing was created."
        case .invalidProposal(let reason):
            "Rico did not return a valid automation proposal: \(reason). Nothing was created."
        case .invalidCreationResponse:
            "The Gateway accepted the command but returned an unreadable job record. Refresh Automations before retrying."
        }
    }
}

// MARK: - Strict proposal parsing

enum AutomationProposalParser {
    private static let permittedKeys: Set<String> = [
        "name", "description", "enabled", "agentId", "schedule",
        "sessionTarget", "wakeMode", "payload", "delivery",
    ]

    static func parseAgentEnvelope(_ data: Data, agentID: String) throws -> AutomationProposal {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw AutomationProposalError.invalidAgentEnvelope
        }
        let modelRunOutputs = root["outputs"] as? [[String: Any]]
        let directPayloads = root["payloads"] as? [[String: Any]]
        let resultPayloads = (root["result"] as? [String: Any])?["payloads"] as? [[String: Any]]
        let texts = (modelRunOutputs ?? directPayloads ?? resultPayloads ?? []).compactMap { $0["text"] as? String }
        guard let text = texts.last(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
            throw AutomationProposalError.noAgentReply
        }
        return try parseProposalText(text, agentID: agentID)
    }

    static func parseProposalText(_ source: String, agentID: String) throws -> AutomationProposal {
        let text = extractJSONObject(from: source)
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw AutomationProposalError.invalidProposal("response was not JSON") }

        let unexpected = Set(object.keys).subtracting(permittedKeys)
        guard unexpected.isEmpty else {
            throw AutomationProposalError.invalidProposal("unsupported fields: \(unexpected.sorted().joined(separator: ", "))")
        }

        let name = try requiredString("name", in: object, maximum: 120)
        let description = try requiredString("description", in: object, maximum: 2_000)
        guard let scheduleObject = object["schedule"] as? [String: Any] else {
            throw AutomationProposalError.invalidProposal("schedule is missing")
        }
        let schedule = try parseSchedule(scheduleObject)

        guard let payload = object["payload"] as? [String: Any],
              payload["kind"] as? String == "agentTurn"
        else { throw AutomationProposalError.invalidProposal("payload.kind must be agentTurn") }
        let action = try requiredString("message", in: payload, maximum: 12_000)

        let sessionTarget = object["sessionTarget"] as? String ?? "isolated"
        guard sessionTarget == "isolated" else {
            throw AutomationProposalError.invalidProposal("sessionTarget must be isolated")
        }
        let wakeMode = object["wakeMode"] as? String ?? "now"
        guard wakeMode == "now" || wakeMode == "next-heartbeat" else {
            throw AutomationProposalError.invalidProposal("wakeMode is unsupported")
        }

        let delivery = try parseDelivery(object["delivery"] as? [String: Any])
        return AutomationProposal(
            declarationKey: "openclaw-studio.\(UUID().uuidString.lowercased())",
            name: name,
            description: description,
            agentID: agentID,
            schedule: schedule,
            action: action,
            delivery: delivery,
            sessionTarget: sessionTarget,
            wakeMode: wakeMode
        )
    }

    private static func parseSchedule(_ value: [String: Any]) throws -> AutomationSchedule {
        guard let kind = value["kind"] as? String else {
            throw AutomationProposalError.invalidProposal("schedule.kind is missing")
        }
        switch kind {
        case "cron":
            let expression = try requiredString("expr", in: value, maximum: 160)
            let fields = expression.split(whereSeparator: \Character.isWhitespace)
            guard fields.count == 5 || fields.count == 6 else {
                throw AutomationProposalError.invalidProposal("cron expression must have five or six fields")
            }
            let timezone = (value["tz"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let timezone, !timezone.isEmpty, TimeZone(identifier: timezone) == nil {
                throw AutomationProposalError.invalidProposal("cron timezone is not a valid IANA identifier")
            }
            return .cron(expression: expression, timezone: timezone?.isEmpty == true ? nil : timezone)
        case "every":
            guard let number = value["everyMs"] as? NSNumber else {
                throw AutomationProposalError.invalidProposal("everyMs is missing")
            }
            let milliseconds = number.intValue
            guard milliseconds > 0 else {
                throw AutomationProposalError.invalidProposal("everyMs must be positive")
            }
            return .every(milliseconds: milliseconds)
        case "at":
            let timestamp = try requiredString("at", in: value, maximum: 160)
            guard AutomationDateParser.isoDate(timestamp) != nil else {
                throw AutomationProposalError.invalidProposal("one-time schedule must be an ISO-8601 timestamp with an offset")
            }
            return .at(timestamp)
        default:
            throw AutomationProposalError.invalidProposal("schedule kind '\(kind)' is unsupported")
        }
    }

    private static func parseDelivery(_ value: [String: Any]?) throws -> AutomationDelivery {
        guard let value else { return .none }
        switch value["mode"] as? String {
        case nil, "none":
            return .none
        case "announce":
            return .announce(
                channel: trimmed(value["channel"] as? String),
                target: trimmed(value["to"] as? String)
            )
        default:
            throw AutomationProposalError.invalidProposal("delivery mode must be none or announce")
        }
    }

    private static func requiredString(
        _ key: String,
        in object: [String: Any],
        maximum: Int
    ) throws -> String {
        guard let value = trimmed(object[key] as? String), !value.isEmpty else {
            throw AutomationProposalError.invalidProposal("\(key) is missing")
        }
        guard value.count <= maximum else {
            throw AutomationProposalError.invalidProposal("\(key) is too long")
        }
        return value
    }

    private static func trimmed(_ value: String?) -> String? {
        value?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func extractJSONObject(from source: String) -> String {
        var text = source.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("```") {
            text = text.replacingOccurrences(
                of: #"^```(?:json)?\s*|\s*```$"#,
                with: "",
                options: .regularExpression
            )
        }
        guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start <= end else {
            return text
        }
        return String(text[start...end])
    }
}

// MARK: - Canonical OpenClaw CLI bridge

actor AutomationOpenClawService {
    func propose(description: String, agentID: String) throws -> AutomationProposal {
        let prompt = Self.plannerPrompt(
            request: description,
            timezone: TimeZone.current.identifier
        )
        let data = try run(Self.plannerArguments(prompt: prompt))
        return try AutomationProposalParser.parseAgentEnvelope(data, agentID: agentID)
    }

    /// OpenClaw documents `infer model run --gateway` as a raw model probe:
    /// it loads no prior transcript, agent workspace, tools, or bundled MCP
    /// servers. Proposal generation is therefore mechanically unable to act.
    static func plannerArguments(prompt: String) -> [String] {
        [
            "infer", "model", "run",
            "--gateway",
            "--thinking", "low",
            "--prompt", prompt,
            "--json",
        ]
    }

    func create(_ proposal: AutomationProposal, enabled: Bool) throws -> AutomationCreationResult {
        let data = try run(Self.creationArguments(for: proposal, enabled: enabled))
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw AutomationProposalError.invalidCreationResponse
        }
        let job = (root["job"] as? [String: Any]) ?? root
        guard let jobID = job["id"] as? String else {
            throw AutomationProposalError.invalidCreationResponse
        }
        let state = job["state"] as? [String: Any]
        let nextMilliseconds = (state?["nextRunAtMs"] as? NSNumber)?.doubleValue
            ?? (job["nextRunAtMs"] as? NSNumber)?.doubleValue
        return AutomationCreationResult(
            jobID: jobID,
            name: job["name"] as? String ?? proposal.name,
            enabled: job["enabled"] as? Bool ?? enabled,
            nextRun: nextMilliseconds.map { Date(timeIntervalSince1970: $0 / 1_000) }
        )
    }

    static func creationArguments(for proposal: AutomationProposal, enabled: Bool) -> [String] {
        var arguments = [
            "cron", "add",
            "--name", proposal.name,
            "--declaration-key", proposal.declarationKey,
            "--description", proposal.description,
            "--agent", proposal.agentID,
            "--session", proposal.sessionTarget,
            "--wake", proposal.wakeMode,
        ]

        switch proposal.schedule {
        case .at(let timestamp):
            arguments += ["--at", timestamp, "--keep-after-run"]
        case .every(let milliseconds):
            arguments += ["--every", "\(milliseconds)ms"]
        case .cron(let expression, let timezone):
            arguments += ["--cron", expression]
            if let timezone, !timezone.isEmpty { arguments += ["--tz", timezone] }
        }

        arguments += ["--message", proposal.action]
        switch proposal.delivery {
        case .none:
            arguments.append("--no-deliver")
        case .announce(let channel, let target):
            arguments.append("--announce")
            if let channel, !channel.isEmpty { arguments += ["--channel", channel] }
            if let target, !target.isEmpty { arguments += ["--to", target] }
        }
        if !enabled { arguments.append("--disabled") }
        arguments += ["--json", "--timeout", "30000"]
        return arguments
    }

    static func plannerPrompt(request: String, timezone: String) -> String {
        """
        You are Rico's OpenClaw automation planner. Propose a schedule only.
        Do not execute the request, call tools, send messages, create jobs, or claim anything was created.

        Return exactly one JSON object and no Markdown. It must use this installed Gateway cron.add shape:
        {
          "name": "concise human-readable name",
          "description": "one-sentence description",
          "enabled": false,
          "agentId": "main",
          "schedule": {"kind":"cron","expr":"five-or-six-field numeric cron","tz":"IANA timezone"},
          "sessionTarget": "isolated",
          "wakeMode": "now",
          "payload": {"kind":"agentTurn","message":"self-contained instructions for the scheduled Rico run"},
          "delivery": {"mode":"none"}
        }

        The schedule may instead be {"kind":"every","everyMs":positive_integer} or
        {"kind":"at","at":"ISO-8601 timestamp with offset"} when that is what the user asked for.
        Use only cron, every, or at. Never propose a command payload, on-exit schedule, trigger script,
        webhook, model override, invented integration, or unsupported field. Use numeric cron fields.
        Default unspecified local times to \(timezone). Keep delivery.mode as none unless the user
        explicitly asks for the final Rico response to be announced; then use mode announce and only
        include a channel or target the user explicitly supplied. Put every requested action in the
        payload message, including recipient or data-source details. Preserve unresolved details as an
        explicit instruction for Rico to stop and ask before acting; never guess credentials or targets.

        User request:
        <automation-request>
        \(request)
        </automation-request>
        """
    }

    private func run(_ arguments: [String]) throws -> Data {
        let executable = try Self.openClawExecutable()
        let temporary = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-studio-automation-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: temporary,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        defer { try? FileManager.default.removeItem(at: temporary) }

        let standardOutputURL = temporary.appendingPathComponent("stdout")
        let standardErrorURL = temporary.appendingPathComponent("stderr")
        FileManager.default.createFile(atPath: standardOutputURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        FileManager.default.createFile(atPath: standardErrorURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let standardOutput = try FileHandle(forWritingTo: standardOutputURL)
        let standardError = try FileHandle(forWritingTo: standardErrorURL)

        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        process.environment = environment
        process.standardOutput = standardOutput
        process.standardError = standardError

        do {
            try process.run()
            process.waitUntilExit()
            try standardOutput.close()
            try standardError.close()
        } catch {
            try? standardOutput.close()
            try? standardError.close()
            throw AutomationProposalError.commandFailed(error.localizedDescription)
        }

        let output = (try? Data(contentsOf: standardOutputURL)) ?? Data()
        guard process.terminationStatus == 0 else {
            let errorData = (try? Data(contentsOf: standardErrorURL)) ?? Data()
            let message = String(decoding: errorData.isEmpty ? output : errorData, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw AutomationProposalError.commandFailed(MCPRedactor.redact(message))
        }
        return output
    }

    private static func openClawExecutable() throws -> URL {
        let candidates = ["/opt/homebrew/bin/openclaw", "/usr/local/bin/openclaw"]
        if let path = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            return URL(fileURLWithPath: path)
        }
        throw AutomationProposalError.openClawUnavailable
    }
}

// MARK: - View model

@MainActor
final class NaturalLanguageAutomationBuilderModel: ObservableObject {
    @Published var request = ""
    @Published var proposal: AutomationProposal?
    @Published var activateAfterCreation = false
    @Published var isProposing = false
    @Published var isCreating = false
    @Published var showingCreationConfirmation = false
    @Published var errorMessage: String?
    @Published var creation: AutomationCreationResult?

    let agentID: String
    private let service: AutomationOpenClawService

    init(agentID: String = "main", service: AutomationOpenClawService = AutomationOpenClawService()) {
        self.agentID = agentID
        self.service = service
    }

    var canPropose: Bool {
        let trimmed = request.trimmingCharacters(in: .whitespacesAndNewlines)
        return !isProposing && !isCreating && !trimmed.isEmpty && trimmed.count <= 12_000
    }

    func propose() {
        guard canPropose else {
            if request.count > 12_000 { errorMessage = "Keep the automation description under 12,000 characters." }
            return
        }
        let description = request.trimmingCharacters(in: .whitespacesAndNewlines)
        errorMessage = nil
        isProposing = true
        Task {
            defer { isProposing = false }
            do {
                proposal = try await service.propose(description: description, agentID: agentID)
                activateAfterCreation = false
            } catch is CancellationError {
                return
            } catch {
                proposal = nil
                errorMessage = error.localizedDescription
            }
        }
    }

    func requestCreation() {
        guard proposal != nil, !isCreating else { return }
        showingCreationConfirmation = true
    }

    /// This is the only UI entry point that mutates Gateway cron state. The
    /// confirmation dialog calls it; proposal generation never does.
    func createAfterExplicitConfirmation() {
        guard let proposal, !isCreating else { return }
        showingCreationConfirmation = false
        errorMessage = nil
        isCreating = true
        Task {
            defer { isCreating = false }
            do {
                creation = try await service.create(proposal, enabled: activateAfterCreation)
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    func returnToDescription() {
        guard !isCreating else { return }
        proposal = nil
        errorMessage = nil
    }
}

// MARK: - Builder experience

struct NaturalLanguageAutomationBuilderView: View {
    @StateObject private var model: NaturalLanguageAutomationBuilderModel
    let onCancel: () -> Void
    let onCreated: (AutomationCreationResult) -> Void

    init(
        agentID: String = "main",
        onCancel: @escaping () -> Void = {},
        onCreated: @escaping (AutomationCreationResult) -> Void = { _ in }
    ) {
        _model = StateObject(wrappedValue: NaturalLanguageAutomationBuilderModel(agentID: agentID))
        self.onCancel = onCancel
        self.onCreated = onCreated
    }

    var body: some View {
        VStack(spacing: 0) {
            AutomationBuilderHeader(
                step: model.creation != nil ? 3 : (model.proposal == nil ? 1 : 2),
                close: onCancel
            )
            Divider()
            Group {
                if let creation = model.creation {
                    AutomationCreatedView(result: creation) {
                        onCreated(creation)
                    }
                } else if let proposal = model.proposal {
                    AutomationReviewView(model: model, proposal: proposal)
                } else {
                    AutomationDescribeView(model: model)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 760, idealWidth: 900, minHeight: 600, idealHeight: 700)
        .background(
            LinearGradient(
                colors: [Color.accentColor.opacity(0.055), Color(nsColor: .windowBackgroundColor)],
                startPoint: .topLeading,
                endPoint: .center
            )
        )
        .confirmationDialog(
            model.activateAfterCreation ? "Create and activate this automation?" : "Create this automation disabled?",
            isPresented: $model.showingCreationConfirmation,
            titleVisibility: .visible
        ) {
            Button(model.activateAfterCreation ? "Create & Activate" : "Create Disabled") {
                model.createAfterExplicitConfirmation()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            if let proposal = model.proposal {
                Text("OpenClaw will add ‘\(proposal.name)’ to the Gateway scheduler. This is the first step that creates anything.")
            }
        }
    }
}

private struct AutomationBuilderHeader: View {
    let step: Int
    let close: () -> Void

    var body: some View {
        HStack(spacing: 18) {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.accentColor.gradient)
                    Image(systemName: "sparkles")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                }
                .frame(width: 36, height: 36)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Build with Rico").font(.headline)
                    Text("Natural language → Gateway automation").font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            HStack(spacing: 8) {
                AutomationStepPill(number: 1, label: "Describe", activeStep: step)
                Rectangle().fill(.quaternary).frame(width: 18, height: 1)
                AutomationStepPill(number: 2, label: "Review", activeStep: step)
                Rectangle().fill(.quaternary).frame(width: 18, height: 1)
                AutomationStepPill(number: 3, label: "Created", activeStep: step)
            }
            Spacer()
            Button(action: close) { Image(systemName: "xmark") }
                .buttonStyle(.borderless)
                .help("Close")
                .accessibilityIdentifier("automation.cancel")
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 16)
    }
}

private struct AutomationStepPill: View {
    let number: Int
    let label: String
    let activeStep: Int

    var body: some View {
        HStack(spacing: 5) {
            ZStack {
                Circle().fill(number <= activeStep ? Color.accentColor : Color.secondary.opacity(0.14))
                if number < activeStep {
                    Image(systemName: "checkmark").font(.caption2.bold()).foregroundStyle(.white)
                } else {
                    Text("\(number)").font(.caption2.bold()).foregroundStyle(number == activeStep ? .white : .secondary)
                }
            }
            .frame(width: 20, height: 20)
            Text(label).font(.caption.weight(number == activeStep ? .semibold : .regular))
                .foregroundStyle(number == activeStep ? .primary : .secondary)
        }
    }
}

private struct AutomationDescribeView: View {
    @ObservedObject var model: NaturalLanguageAutomationBuilderModel
    @FocusState private var focused: Bool

    private let examples = [
        "Every weekday at 8 AM, review my calendar and give me a concise morning brief.",
        "Every Friday at 4 PM, summarize this week's progress and draft next week's priorities.",
        "At 6 PM daily, check tomorrow's weather and flag anything that changes my plans.",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Text("What should Rico handle for you?")
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                Text("Describe the outcome and timing naturally. Rico will propose a real Gateway schedule for you to inspect—nothing is created yet.")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color(nsColor: .textBackgroundColor).opacity(0.72))
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .stroke(focused ? Color.accentColor.opacity(0.8) : Color.secondary.opacity(0.16), lineWidth: focused ? 2 : 1)
                    )
                if model.request.isEmpty {
                    Text("For example: Every weekday morning, review my calendar and inbox, then prepare a five-line brief…")
                        .font(.system(size: 18))
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 19)
                        .padding(.vertical, 18)
                        .allowsHitTesting(false)
                }
                TextEditor(text: $model.request)
                    .font(.system(size: 18))
                    .scrollContentBackground(.hidden)
                    .padding(13)
                    .focused($focused)
                    .accessibilityLabel("Automation description")
                    .accessibilityIdentifier("automation.prompt")
            }
            .frame(minHeight: 190)

            VStack(alignment: .leading, spacing: 10) {
                Text("Try an example").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { exampleButtons }
                    VStack(alignment: .leading, spacing: 8) { exampleButtons }
                }
            }

            if let error = model.errorMessage {
                AutomationInlineMessage(text: error, systemImage: "exclamationmark.triangle.fill", color: .red)
            }

            Spacer(minLength: 0)
            HStack {
                Label("Tool-free proposal. Creation requires your review and confirmation.", systemImage: "checkmark.shield")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if model.isProposing {
                    ProgressView().controlSize(.small)
                    Text("Rico is shaping the plan…").font(.callout).foregroundStyle(.secondary)
                }
                Button("Create a proposal") { model.propose() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(!model.canPropose)
                    .keyboardShortcut(.return, modifiers: [.command])
                    .accessibilityIdentifier("automation.propose")
            }
        }
        .padding(36)
        .onAppear { focused = true }
    }

    @ViewBuilder private var exampleButtons: some View {
        ForEach(examples, id: \.self) { example in
            Button {
                model.request = example
                focused = true
            } label: {
                Text(example).lineLimit(1).font(.caption)
            }
            .buttonStyle(.bordered)
        }
    }
}

private struct AutomationReviewView: View {
    @ObservedObject var model: NaturalLanguageAutomationBuilderModel
    let proposal: AutomationProposal

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Review before Rico schedules it")
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                        Text("This is a parsed proposal, not a created job. Check the schedule, action, delivery, and authority boundary.")
                            .foregroundStyle(.secondary)
                    }

                    HStack(alignment: .top, spacing: 14) {
                        AutomationReviewCard(
                            eyebrow: "SCHEDULE",
                            title: proposal.schedule.naturalLabel,
                            systemImage: "calendar.badge.clock",
                            tint: .indigo
                        ) {
                            ReviewDetail(label: "Expression", value: proposal.schedule.technicalLabel, monospaced: true)
                            ReviewDetail(label: "Timezone", value: proposal.schedule.timezoneLabel)
                            ReviewDetail(
                                label: "Next run",
                                value: proposal.schedule.nextRun()?.formatted(date: .abbreviated, time: .shortened)
                                    ?? "Gateway will calculate after creation"
                            )
                        }
                        AutomationReviewCard(
                            eyebrow: "RUNTIME",
                            title: "Rico · \(proposal.agentID)",
                            systemImage: "sparkles",
                            tint: .purple
                        ) {
                            ReviewDetail(label: "Session", value: "Isolated each run")
                            ReviewDetail(label: "Wake", value: proposal.wakeMode == "now" ? "Immediately when due" : "Next heartbeat")
                            ReviewDetail(label: "Tools", value: "Rico's configured policy")
                        }
                    }

                    AutomationReviewCard(
                        eyebrow: "ACTION",
                        title: proposal.name,
                        systemImage: "text.bubble",
                        tint: .blue
                    ) {
                        Text(proposal.description).font(.callout).foregroundStyle(.secondary)
                        Divider()
                        Text(proposal.action)
                            .font(.system(.body, design: .rounded))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    AutomationReviewCard(
                        eyebrow: "DELIVERY & AUTHORITY",
                        title: proposal.delivery.label,
                        systemImage: proposal.mayCommunicateExternally ? "paperplane.fill" : "lock.shield",
                        tint: proposal.mayCommunicateExternally ? .orange : .green
                    ) {
                        ReviewDetail(label: "Payload", value: "Model-backed agent turn")
                        ReviewDetail(label: "Gateway scope", value: "operator.admin required to create")
                        if proposal.mayCommunicateExternally {
                            AutomationInlineMessage(
                                text: "This action may communicate outside OpenClaw. Verify every recipient and destination in the instructions above.",
                                systemImage: "exclamationmark.triangle.fill",
                                color: .orange
                            )
                        } else {
                            Text("No runner delivery is configured. Rico's normal tool permissions still apply to the scheduled action.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Toggle(isOn: $model.activateAfterCreation) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Activate after creation").font(.headline)
                            Text(model.activateAfterCreation
                                 ? "The Gateway may run this as soon as the schedule is due."
                                 : "Recommended for a first pass: create it disabled, then activate from Automations.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .toggleStyle(.switch)
                    .padding(16)
                    .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .accessibilityIdentifier("automation.activate")

                    DisclosureGroup("Exact Gateway cron.add request") {
                        Text(proposal.gatewayJSON(enabled: model.activateAfterCreation))
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.top, 8)
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("automation.gatewayRequest")

                    if let error = model.errorMessage {
                        AutomationInlineMessage(text: error, systemImage: "exclamationmark.triangle.fill", color: .red)
                    }
                }
                .padding(32)
                .accessibilityIdentifier("automation.review")
            }
            Divider()
            HStack {
                Button("Refine description") { model.returnToDescription() }
                    .buttonStyle(.bordered)
                    .disabled(model.isCreating)
                Spacer()
                if model.isCreating {
                    ProgressView().controlSize(.small)
                    Text("Creating in Gateway…").font(.callout).foregroundStyle(.secondary)
                }
                Button(model.activateAfterCreation ? "Review & activate" : "Review & create disabled") {
                    model.requestCreation()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(model.isCreating)
                .keyboardShortcut(.return, modifiers: [.command])
                .accessibilityIdentifier("automation.create")
            }
            .padding(.horizontal, 32)
            .padding(.vertical, 18)
            .background(.bar)
        }
    }
}

private struct AutomationReviewCard<Content: View>: View {
    let eyebrow: String
    let title: String
    let systemImage: String
    let tint: Color
    @ViewBuilder let content: Content

    init(
        eyebrow: String,
        title: String,
        systemImage: String,
        tint: Color,
        @ViewBuilder content: () -> Content
    ) {
        self.eyebrow = eyebrow
        self.title = title
        self.systemImage = systemImage
        self.tint = tint
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .top, spacing: 11) {
                Image(systemName: systemImage)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(tint)
                    .frame(width: 32, height: 32)
                    .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(eyebrow).font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                    Text(title).font(.headline).fixedSize(horizontal: false, vertical: true)
                }
            }
            content
        }
        .padding(17)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.72), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Color.secondary.opacity(0.12)))
    }
}

private struct ReviewDetail: View {
    let label: String
    let value: String
    var monospaced = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label).font(.caption).foregroundStyle(.secondary).frame(width: 74, alignment: .leading)
            Text(value)
                .font(monospaced ? .system(.caption, design: .monospaced) : .caption)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct AutomationInlineMessage: View {
    let text: String
    let systemImage: String
    let color: Color

    var body: some View {
        Label(text, systemImage: systemImage)
            .font(.caption)
            .foregroundStyle(color)
            .padding(11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(color.opacity(0.09), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

private struct AutomationCreatedView: View {
    let result: AutomationCreationResult
    let done: () -> Void

    var body: some View {
        VStack(spacing: 22) {
            Spacer()
            ZStack {
                Circle().fill(Color.green.opacity(0.13))
                Image(systemName: "checkmark")
                    .font(.system(size: 34, weight: .bold))
                    .foregroundStyle(.green)
            }
            .frame(width: 84, height: 84)
            Text(result.enabled ? "Automation is live" : "Automation created disabled")
                .font(.system(size: 30, weight: .bold, design: .rounded))
            Text(result.name).font(.title3.weight(.semibold))
            VStack(spacing: 7) {
                Text("Gateway job \(result.jobID)")
                Text(result.nextRun.map { "Next run · \($0.formatted(date: .abbreviated, time: .shortened))" }
                     ?? (result.enabled ? "The Gateway is calculating its next run." : "Activate it from Automations when you're ready."))
            }
            .font(.callout)
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
            Button("Done") { done() }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .keyboardShortcut(.defaultAction)
            Spacer()
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("automation.success")
    }
}

// MARK: - Schedule display helpers

private enum AutomationDateParser {
    static func isoDate(_ text: String) -> Date? {
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let value = withFractional.date(from: text) { return value }
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: text)
    }
}

private enum AutomationDurationFormatter {
    static func string(milliseconds: Int) -> String {
        let seconds = milliseconds / 1_000
        if seconds % 86_400 == 0 { return unit(seconds / 86_400, "day") }
        if seconds % 3_600 == 0 { return unit(seconds / 3_600, "hour") }
        if seconds % 60 == 0 { return unit(seconds / 60, "minute") }
        if seconds > 0 { return unit(seconds, "second") }
        return "\(milliseconds) milliseconds"
    }

    private static func unit(_ value: Int, _ name: String) -> String {
        "\(value) \(name)\(value == 1 ? "" : "s")"
    }
}

enum AutomationCronPreview {
    static func summary(expression: String) -> String {
        let fields = expression.split(whereSeparator: \Character.isWhitespace).map(String.init)
        let values = fields.count == 6 ? Array(fields.dropFirst()) : fields
        guard values.count == 5 else { return "Cron · \(expression)" }
        let minute = values[0], hour = values[1], day = values[2], month = values[3], weekday = values[4]
        if minute.hasPrefix("*/"), hour == "*", day == "*", month == "*", weekday == "*" {
            return "Every \(minute.dropFirst(2)) minutes"
        }
        if let minuteValue = Int(minute), let hourValue = Int(hour), day == "*", month == "*" {
            let time = formattedTime(hour: hourValue, minute: minuteValue)
            if weekday == "*" { return "Every day at \(time)" }
            if weekday == "1-5" { return "Weekdays at \(time)" }
            if weekday == "0" || weekday == "7" { return "Sundays at \(time)" }
            return "Scheduled days at \(time)"
        }
        return "Cron · \(expression)"
    }

    static func nextRun(expression: String, timezone: String?, after date: Date) -> Date? {
        let parts = expression.split(whereSeparator: \Character.isWhitespace).map(String.init)
        guard parts.count == 5 || parts.count == 6 else { return nil }
        let hasSeconds = parts.count == 6
        let secondToken = hasSeconds ? parts[0] : "0"
        let offset = hasSeconds ? 1 : 0
        guard let seconds = CronField(secondToken, range: 0...59),
              let minutes = CronField(parts[offset], range: 0...59),
              let hours = CronField(parts[offset + 1], range: 0...23),
              let days = CronField(parts[offset + 2], range: 1...31),
              let months = CronField(parts[offset + 3], range: 1...12),
              let weekdays = CronField(parts[offset + 4], range: 0...7, normalizeSevenToZero: true)
        else { return nil }

        var calendar = Calendar(identifier: .gregorian)
        if let timezone, let zone = TimeZone(identifier: timezone) { calendar.timeZone = zone }
        let interval: TimeInterval = hasSeconds ? 1 : 60
        var timestamp = floor(date.timeIntervalSince1970 / interval) * interval + interval
        let maximumIterations = hasSeconds ? 700_000 : 540_000

        for _ in 0..<maximumIterations {
            let candidate = Date(timeIntervalSince1970: timestamp)
            let values = calendar.dateComponents([.month, .day, .hour, .minute, .second, .weekday], from: candidate)
            guard let month = values.month, let day = values.day, let hour = values.hour,
                  let minute = values.minute, let second = values.second, let calendarWeekday = values.weekday
            else { return nil }
            let weekday = calendarWeekday == 1 ? 0 : calendarWeekday - 1
            let dayMatches: Bool
            if !days.isWildcard && !weekdays.isWildcard {
                dayMatches = days.matches(day) || weekdays.matches(weekday)
            } else {
                dayMatches = days.matches(day) && weekdays.matches(weekday)
            }
            if months.matches(month), dayMatches, hours.matches(hour), minutes.matches(minute), seconds.matches(second) {
                return candidate
            }
            timestamp += interval
        }
        return nil
    }

    private static func formattedTime(hour: Int, minute: Int) -> String {
        var components = DateComponents()
        components.hour = hour
        components.minute = minute
        let calendar = Calendar(identifier: .gregorian)
        let date = calendar.date(from: components) ?? Date()
        return date.formatted(date: .omitted, time: .shortened)
    }

    private struct CronField {
        let values: Set<Int>
        let isWildcard: Bool

        init?(_ token: String, range: ClosedRange<Int>, normalizeSevenToZero: Bool = false) {
            isWildcard = token == "*" || token == "?"
            if isWildcard {
                values = Set(range.map { normalizeSevenToZero && $0 == 7 ? 0 : $0 })
                return
            }
            var parsed = Set<Int>()
            for section in token.split(separator: ",") {
                let pair = section.split(separator: "/", omittingEmptySubsequences: false)
                guard pair.count <= 2 else { return nil }
                let step = pair.count == 2 ? Int(pair[1]) : 1
                guard let step, step > 0 else { return nil }
                let base = String(pair[0])
                let bounds: ClosedRange<Int>
                if base == "*" {
                    bounds = range
                } else if base.contains("-") {
                    let endpoints = base.split(separator: "-", omittingEmptySubsequences: false)
                    guard endpoints.count == 2, let lower = Int(endpoints[0]), let upper = Int(endpoints[1]),
                          range.contains(lower), range.contains(upper), lower <= upper else { return nil }
                    bounds = lower...upper
                } else {
                    guard let number = Int(base), range.contains(number) else { return nil }
                    bounds = number...number
                }
                for number in stride(from: bounds.lowerBound, through: bounds.upperBound, by: step) {
                    parsed.insert(normalizeSevenToZero && number == 7 ? 0 : number)
                }
            }
            guard !parsed.isEmpty else { return nil }
            values = parsed
        }

        func matches(_ value: Int) -> Bool { values.contains(value) }
    }
}
