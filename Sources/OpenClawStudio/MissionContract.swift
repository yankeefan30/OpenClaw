import Foundation
import CoreFoundation

// MARK: - Canonical Mission Governor contract

enum MissionOperatingMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case shadow
    case suggest
    case bounded

    var id: String { rawValue }

    var title: String {
        switch self {
        case .shadow: "Shadow"
        case .suggest: "Suggest"
        case .bounded: "Bounded Autopilot"
        }
    }

    var explanation: String {
        switch self {
        case .shadow:
            "Observe, plan, and verify. No tools may change external state."
        case .suggest:
            "Prepare mutations as proposals that require operator approval."
        case .bounded:
            "Run only exact allowlisted tools inside every Gateway-enforced ceiling."
        }
    }
}

enum MissionTriggerKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case manual
    case cron
    case heartbeat
    case webhook
    case event
    case scheduled
    case background

    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

struct MissionSelectors: Codable, Hashable, Sendable {
    var agentIds: [String]
    var sessionKeys: [String]
    var jobIds: [String]
    var triggers: [MissionTriggerKind]
    var governManualRuns: Bool
}

enum MissionToolEffect: String, Codable, CaseIterable, Sendable {
    case read
    case write
    case external

    var title: String { rawValue.capitalized }
}

enum MissionToolDecision: String, Codable, CaseIterable, Sendable {
    case allow
    case deny

    var title: String { rawValue.capitalized }
}

struct MissionToolRule: Codable, Hashable, Sendable, Identifiable {
    var name: String
    var effect: MissionToolEffect
    var decision: MissionToolDecision

    var id: String { name }
}

struct MissionOutboundPolicy: Codable, Hashable, Sendable {
    var channels: [String]
    var targets: [String]
}

struct MissionBudgets: Codable, Hashable, Sendable {
    var runsPerDay: Int
    var toolCallsPerRun: Int
    var toolCallsPerDay: Int
    var writeCallsPerDay: Int
    var outboundPerDay: Int
    var runtimeSecondsPerRun: Int
}

struct MissionCompletion: Codable, Hashable, Sendable {
    var criteria: [String]
    var evidenceRequired: Bool
}

struct MissionEscalation: Codable, Hashable, Sendable {
    var conditions: [String]
}

/// A Gateway-enforced run/tool/outbound window. Start and end must differ;
/// this is an operating boundary, not a descriptive scheduling hint.
struct MissionTimeWindow: Codable, Hashable, Sendable {
    var timezone: String
    var startLocal: String
    var endLocal: String
    var allowedWeekdays: [Int]
}

/// The exact v1 envelope accepted by the Rico Mission Governor. Do not add
/// lifecycle, UI, cron-expression, or review fields to its encoded form.
struct MissionContract: Codable, Hashable, Sendable, Identifiable {
    var schema: String
    var schemaVersion: Int
    var id: String
    var revision: Int
    var title: String
    var objective: String
    var mode: MissionOperatingMode
    var selectors: MissionSelectors
    var tools: [MissionToolRule]
    var outbound: MissionOutboundPolicy?
    var budgets: MissionBudgets?
    var completion: MissionCompletion?
    var escalation: MissionEscalation?
    var timeWindow: MissionTimeWindow?

    static let schemaIdentifier = "rico.autonomy.mission"
    static let currentSchemaVersion = 1

    /// Contracts describe authority but do not activate it. Active state exists
    /// only in the Gateway's lifecycle record after a separate reviewed mutation.
    var isActive: Bool { false }
    var deterministicSessionKey: String? { selectors.sessionKeys.first }

    static func makeID(uuid: UUID = UUID()) -> String {
        "mission-\(uuid.uuidString.lowercased())"
    }

    static func sessionKey(agentID: String, missionID: String) -> String {
        "agent:\(agentID):mission:\(missionID)"
    }

    func gatewayObject() throws -> [String: Any] {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(self)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw MissionProposalError.invalidContract("contract could not be encoded")
        }
        return object
    }
}

// MARK: - Validation

enum MissionValidationSeverity: String, Codable, Sendable {
    case error
    case warning
}

struct MissionValidationIssue: Codable, Hashable, Sendable, Identifiable {
    var severity: MissionValidationSeverity
    var code: String
    var message: String

    var id: String { "\(severity.rawValue):\(code)" }
}

struct MissionValidationReport: Sendable, Equatable {
    var issues: [MissionValidationIssue]

    var errors: [MissionValidationIssue] { issues.filter { $0.severity == .error } }
    var warnings: [MissionValidationIssue] { issues.filter { $0.severity == .warning } }
    var isValid: Bool { errors.isEmpty }
}

enum MissionContractValidator {
    private static let highImpactToolTerms = [
        "credential", "secret", "password", "token", "apikey", "api_key",
        "purchase", "payment", "checkout", "billing", "delete", "remove",
        "destroy", "permission", "policy", "config", "auth", "account",
        "plugin", "extension", "mcp.add", "mcp.install", "mcp.configure",
        "message.send", "chat.send", "imessage", "email.send", "publish", "post",
    ]

    static func validate(_ contract: MissionContract) -> MissionValidationReport {
        var issues: [MissionValidationIssue] = []
        func error(_ code: String, _ message: String) {
            issues.append(.init(severity: .error, code: code, message: message))
        }
        func warning(_ code: String, _ message: String) {
            issues.append(.init(severity: .warning, code: code, message: message))
        }

        if contract.schema != MissionContract.schemaIdentifier {
            error("schema.identifier", "Schema must be \(MissionContract.schemaIdentifier).")
        }
        if contract.schemaVersion != MissionContract.currentSchemaVersion {
            error("schema.version", "Schema version must be 1.")
        }
        if !contract.id.matches(#"^[a-z][a-z0-9-]{0,79}$"#) {
            error("id.invalid", "Mission ID must be lowercase, start with a letter, and contain only letters, numbers, or hyphens.")
        }
        if contract.revision < 1 {
            error("revision.invalid", "Revision must be a positive integer.")
        }
        validateText(contract.title, label: "Title", code: "title", limit: 120, error: error)
        validateText(contract.objective, label: "Objective", code: "objective", limit: 4_000, error: error)

        validateUniqueExact(contract.selectors.agentIds, label: "agent ID", code: "selectors.agentIds", error: error)
        validateUniqueExact(contract.selectors.sessionKeys, label: "session key", code: "selectors.sessionKeys", error: error)
        validateUniqueExact(contract.selectors.jobIds, label: "job ID", code: "selectors.jobIds", error: error)
        validateUnique(contract.selectors.triggers, label: "trigger", code: "selectors.triggers", error: error)
        if contract.selectors.agentIds.isEmpty && contract.selectors.sessionKeys.isEmpty &&
            contract.selectors.jobIds.isEmpty && contract.selectors.triggers.isEmpty {
            error("selectors.empty", "At least one exact selector is required.")
        }
        let expectedKeys = contract.selectors.agentIds.map {
            MissionContract.sessionKey(agentID: $0, missionID: contract.id)
        }
        if expectedKeys.isEmpty || !expectedKeys.contains(where: contract.selectors.sessionKeys.contains) {
            error("selectors.session.deterministic", "Include the deterministic mission session key for an exact selected agent.")
        }

        validateUniqueExact(contract.tools.map(\.name), label: "tool name", code: "tools", error: error)
        for (index, tool) in contract.tools.enumerated() {
            if !tool.name.matches(#"^[A-Za-z0-9_.:-]+$"#) || tool.name.contains("*") {
                error("tools.\(index).name", "Tool names must be exact and cannot contain wildcards.")
            }
            if tool.effect == .external && tool.decision == .allow {
                error("tools.\(index).external", "External-effect tools cannot be pre-authorized by a generated mission.")
            }
            if tool.decision == .allow && isHighImpactTool(tool.name) {
                error("tools.\(index).highImpact", "Credential, purchase, policy, deletion, communication, and new integration tools must remain denied.")
            }
        }
        if contract.tools.isEmpty {
            warning("tools.empty", "No tools are selected; the mission can plan but cannot take tool actions.")
        }

        if let outbound = contract.outbound {
            validateUniqueExact(outbound.channels, label: "outbound channel", code: "outbound.channels", error: error)
            validateUniqueExact(outbound.targets, label: "outbound target", code: "outbound.targets", error: error)
            if outbound.channels.isEmpty || outbound.targets.isEmpty {
                error("outbound.incomplete", "Outbound authority requires at least one exact channel and exact target.")
            }
            let externalRules = contract.tools.filter { $0.effect == .external }
            if externalRules.isEmpty || externalRules.contains(where: { $0.decision != .deny }) {
                error("outbound.toolGuard", "Generated outbound missions require an explicit denied external tool rule until separately approved.")
            }
        }

        if let budgets = contract.budgets {
            validateBudget(budgets.runsPerDay, max: 1_440, label: "Runs per day", code: "budgets.runsPerDay", error: error)
            validateBudget(budgets.toolCallsPerRun, max: 1_000, label: "Tool calls per run", code: "budgets.toolCallsPerRun", error: error)
            validateBudget(budgets.toolCallsPerDay, max: 10_000, label: "Tool calls per day", code: "budgets.toolCallsPerDay", error: error)
            validateBudget(budgets.writeCallsPerDay, max: 1_000, label: "Write calls per day", code: "budgets.writeCallsPerDay", error: error)
            validateBudget(budgets.outboundPerDay, max: 100, label: "Outbound actions per day", code: "budgets.outboundPerDay", error: error)
            validateBudget(budgets.runtimeSecondsPerRun, max: 86_400, label: "Runtime per run", code: "budgets.runtimeSecondsPerRun", error: error)
            if budgets.toolCallsPerDay < budgets.toolCallsPerRun {
                error("budgets.toolCalls.order", "Daily tool-call ceiling cannot be lower than the per-run ceiling.")
            }
        } else {
            error("budgets.missing", "Every reviewed mission requires explicit bounded budgets.")
        }

        if let completion = contract.completion {
            if completion.criteria.isEmpty {
                error("completion.criteria.empty", "Add at least one measurable completion criterion.")
            }
            for (index, criterion) in completion.criteria.enumerated() {
                validateText(criterion, label: "Completion criterion", code: "completion.criteria.\(index)", limit: 1_000, error: error)
            }
            if !completion.evidenceRequired {
                error("completion.evidence", "Completion evidence must be required.")
            }
        } else {
            error("completion.missing", "Completion criteria and required evidence are mandatory.")
        }

        if let escalation = contract.escalation {
            if escalation.conditions.isEmpty {
                error("escalation.conditions.empty", "Add at least one fail-closed escalation condition.")
            }
            for (index, condition) in escalation.conditions.enumerated() {
                validateText(condition, label: "Escalation condition", code: "escalation.conditions.\(index)", limit: 1_000, error: error)
            }
        } else {
            error("escalation.missing", "Escalation conditions are mandatory.")
        }

        if let timeWindow = contract.timeWindow {
            if TimeZone(identifier: timeWindow.timezone) == nil {
                error("timeWindow.timezone", "Time window requires a valid IANA timezone.")
            }
            let start = parseClock(timeWindow.startLocal)
            let end = parseClock(timeWindow.endLocal)
            if start == nil || end == nil {
                error("timeWindow.clock", "Time-window values must use 24-hour HH:mm format.")
            } else if start == end {
                error("timeWindow.equal", "Time-window start and end must differ.")
            }
            if timeWindow.allowedWeekdays.isEmpty ||
                timeWindow.allowedWeekdays.contains(where: { !(1...7).contains($0) }) {
                error("timeWindow.weekdays", "Allowed weekdays must contain ISO day numbers 1 through 7.")
            }
            if Set(timeWindow.allowedWeekdays).count != timeWindow.allowedWeekdays.count {
                error("timeWindow.weekdays.duplicate", "Allowed weekdays must be unique.")
            }
        } else if contract.mode == .bounded {
            error("timeWindow.missing", "Bounded Autopilot requires an enforced time window.")
        }

        return MissionValidationReport(issues: issues)
    }

    static func isHighImpactTool(_ name: String) -> Bool {
        let normalized = name.lowercased()
        return highImpactToolTerms.contains { normalized.contains($0) }
    }

    static func parseClock(_ value: String) -> Int? {
        let fields = value.split(separator: ":", omittingEmptySubsequences: false)
        guard fields.count == 2, fields[0].count == 2, fields[1].count == 2,
              let hour = Int(fields[0]), let minute = Int(fields[1]),
              (0...23).contains(hour), (0...59).contains(minute) else { return nil }
        return hour * 60 + minute
    }

    private static func validateText(
        _ value: String,
        label: String,
        code: String,
        limit: Int,
        error: (String, String) -> Void
    ) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            error("\(code).empty", "\(label) cannot be empty.")
        } else if value.count > limit {
            error("\(code).long", "\(label) must be \(limit) characters or fewer.")
        }
    }

    private static func validateUniqueExact(
        _ values: [String],
        label: String,
        code: String,
        error: (String, String) -> Void
    ) {
        for (index, value) in values.enumerated() {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || trimmed != value || value.count > 512 || value.rangeOfCharacter(from: .newlines) != nil {
                error("\(code).\(index).invalid", "Each \(label) must be a non-empty exact identifier without surrounding whitespace.")
            }
        }
        if Set(values).count != values.count {
            error("\(code).duplicate", "Each \(label) must be unique.")
        }
    }

    private static func validateUnique<T: Hashable>(
        _ values: [T],
        label: String,
        code: String,
        error: (String, String) -> Void
    ) {
        if Set(values).count != values.count {
            error("\(code).duplicate", "Each \(label) must be unique.")
        }
    }

    private static func validateBudget(
        _ value: Int,
        max: Int,
        label: String,
        code: String,
        error: (String, String) -> Void
    ) {
        if !(1...max).contains(value) {
            error("\(code).range", "\(label) must be between 1 and \(max).")
        }
    }
}

private extension String {
    func matches(_ pattern: String) -> Bool {
        range(of: pattern, options: .regularExpression) != nil
    }
}
