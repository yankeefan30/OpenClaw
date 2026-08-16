import Foundation

enum MissionControlMode: String, CaseIterable, Identifiable, Sendable {
    case shadow
    case suggest
    case bounded
    case unknown

    var id: String { rawValue }

    var label: String {
        switch self {
        case .shadow: "Shadow"
        case .suggest: "Suggest"
        case .bounded: "Bounded autopilot"
        case .unknown: "Unknown"
        }
    }

    init(gatewayValue: String?) {
        switch gatewayValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "shadow", "observe", "observation": self = .shadow
        case "suggest", "proposal": self = .suggest
        case "bounded", "execute_bounded", "bounded_autopilot", "autopilot": self = .bounded
        // Legacy/unbounded modes are intentionally not elevated into Studio.
        // The operator must review and migrate them to bounded authority.
        case "trusted", "execute_trusted", "unbounded": self = .unknown
        default: self = .unknown
        }
    }
}

enum MissionLifecycleState: String, Sendable {
    case draft
    case shadow
    case active
    case paused
    case completed
    case failed
    case blocked
    case unknown

    var label: String { rawValue.capitalized }

    init(gatewayValue: String?) {
        switch gatewayValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "draft": self = .draft
        case "shadow", "evaluating": self = .shadow
        case "active", "running", "activated": self = .active
        case "paused", "suspended": self = .paused
        case "completed", "succeeded", "done": self = .completed
        case "failed", "error": self = .failed
        case "blocked", "exception": self = .blocked
        default: self = .unknown
        }
    }
}

struct MissionBudgetMetric: Identifiable, Hashable, Sendable {
    let id: String
    let label: String
    let used: Double
    let limit: Double?
    let unit: String

    var fraction: Double? {
        guard let limit, limit > 0 else { return nil }
        return min(max(used / limit, 0), 1)
    }

    var exceeded: Bool {
        guard let limit else { return false }
        return used >= limit
    }

    var displayValue: String {
        let formatter = NumberFormatter()
        formatter.numberStyle = unit == "USD" ? .currency : .decimal
        formatter.maximumFractionDigits = unit == "USD" ? 2 : 0
        let renderedUsed = formatter.string(from: NSNumber(value: unit == "USD" ? used / 100 : used)) ?? "\(used)"
        guard let limit else { return "\(renderedUsed) \(unit)".trimmingCharacters(in: .whitespaces) }
        let renderedLimit = formatter.string(from: NSNumber(value: unit == "USD" ? limit / 100 : limit)) ?? "\(limit)"
        return "\(renderedUsed) / \(renderedLimit) \(unit)".trimmingCharacters(in: .whitespaces)
    }
}

struct MissionEvidenceRecord: Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let kind: String
    let status: String
    let source: String?
    let capturedAt: Date?
    let verifier: String?

    var verified: Bool {
        ["verified", "accepted", "passed", "valid"].contains(status.lowercased())
    }

    init?(_ row: [String: Any], index: Int = 0) {
        title = MissionPayload.string(row, keys: ["title", "label", "name", "requirement", "summary"])
            .map(MissionRedactor.redact) ?? "Evidence \(index + 1)"
        id = MissionPayload.string(row, keys: ["id", "evidenceId", "evidenceID"])
            ?? MissionPayload.stableIdentifier(prefix: "evidence", components: [title, "\(index)"])
        kind = MissionPayload.string(row, keys: ["kind", "type"]) ?? "proof"
        status = MissionPayload.string(row, keys: ["status", "state"]) ?? "pending"
        source = MissionPayload.string(row, keys: ["source", "sourceId", "artifact"])
            .map(MissionRedactor.redact)
        capturedAt = MissionPayload.date(row, keys: ["capturedAt", "verifiedAt", "createdAt", "capturedAtMs", "verifiedAtMs"])
        verifier = MissionPayload.string(row, keys: ["verifier", "verifierId", "verifiedBy"])
            .map(MissionRedactor.redact)
    }
}

struct MissionExceptionRecord: Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let detail: String
    let severity: String
    let occurredAt: Date?
    let requiresApproval: Bool
    let resolved: Bool

    init?(_ row: [String: Any], index: Int = 0) {
        title = MissionPayload.string(row, keys: ["title", "summary", "code", "kind"])
            .map(MissionRedactor.redact) ?? "Mission exception"
        detail = MissionPayload.string(row, keys: ["detail", "message", "reason", "description"])
            .map(MissionRedactor.redact) ?? "No additional detail was provided."
        id = MissionPayload.string(row, keys: ["id", "exceptionId", "eventId"])
            ?? MissionPayload.stableIdentifier(prefix: "exception", components: [title, detail, "\(index)"])
        severity = MissionPayload.string(row, keys: ["severity", "level", "risk"]) ?? "warning"
        occurredAt = MissionPayload.date(row, keys: ["occurredAt", "createdAt", "timestamp", "occurredAtMs", "createdAtMs"])
        requiresApproval = MissionPayload.bool(row, keys: ["requiresApproval", "approvalRequired", "needsReview"]) ?? false
        resolved = MissionPayload.bool(row, keys: ["resolved", "closed"]) ?? false
    }
}

struct MissionSummary: Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let outcome: String
    let state: MissionLifecycleState
    let mode: MissionControlMode
    let revision: Int?
    let updatedAt: Date?
    let nextRunAt: Date?
    let exceptionCount: Int
    let evidenceCount: Int
    let budgets: [MissionBudgetMetric]

    init?(_ row: [String: Any]) {
        let contract = MissionPayload.dictionary(row["contract"]) ?? row
        let runtime = MissionPayload.dictionary(row["runtime"])
            ?? MissionPayload.dictionary(row["lifecycle"])
            ?? [:]
        guard let resolvedID = MissionPayload.string(row, keys: ["id", "missionId", "missionID"])
                ?? MissionPayload.string(contract, keys: ["id", "missionId", "missionID"]),
              !resolvedID.isEmpty else {
            return nil
        }
        id = resolvedID
        title = MissionPayload.string(contract, keys: ["title", "name", "displayName"])
            .map(MissionRedactor.redact) ?? "Untitled mission"
        outcome = MissionPayload.string(contract, keys: ["outcome", "desiredOutcome", "objective", "description"])
            .map(MissionRedactor.redact) ?? "No outcome defined."
        state = MissionLifecycleState(gatewayValue: MissionPayload.string(row, keys: ["state", "status"])
            ?? MissionPayload.string(runtime, keys: ["state", "status"]))
        mode = MissionControlMode(gatewayValue: MissionPayload.string(contract, keys: ["mode", "operatingMode", "autonomyMode"]))
        revision = MissionPayload.int(row, keys: ["revision", "version"])
            ?? MissionPayload.int(contract, keys: ["revision", "version"])
        updatedAt = MissionPayload.date(row, keys: ["updatedAt", "updatedAtMs", "modifiedAt"])
            ?? MissionPayload.date(runtime, keys: ["updatedAt", "updatedAtMs", "modifiedAt"])
        nextRunAt = MissionPayload.date(row, keys: ["nextRunAt", "nextRunAtMs", "nextWakeAt", "nextWakeAtMs"])
            ?? MissionPayload.date(runtime, keys: ["nextRunAt", "nextRunAtMs", "nextWakeAt", "nextWakeAtMs"])
        exceptionCount = MissionPayload.int(row, keys: ["exceptionCount", "openExceptionCount", "exceptionsPending"])
            ?? MissionPayload.int(runtime, keys: ["exceptionCount", "openExceptionCount", "exceptionsPending"])
            ?? MissionPayload.rows(row["exceptions"] ?? runtime["exceptions"]).filter { MissionPayload.bool($0, keys: ["resolved", "closed"]) != true }.count
        evidenceCount = MissionPayload.int(row, keys: ["evidenceCount", "verifiedEvidenceCount"])
            ?? MissionPayload.int(runtime, keys: ["evidenceCount", "verifiedEvidenceCount"])
            ?? MissionPayload.rows(row["evidence"] ?? runtime["evidence"]).count
        var budgetSource = contract
        if let usage = MissionPayload.dictionary(row["usage"] ?? runtime["usage"]) {
            budgetSource["usage"] = usage
        }
        budgets = MissionBudgetMetric.decode(from: budgetSource)
    }
}

struct MissionDetail: Sendable {
    let summary: MissionSummary
    let successCriteria: [String]
    let allowedActions: [String]
    let prohibitedActions: [String]
    let evidence: [MissionEvidenceRecord]
    let exceptions: [MissionExceptionRecord]
    let triggerSummary: String

    init?(_ row: [String: Any]) {
        guard let summary = MissionSummary(row) else { return nil }
        let contract = MissionPayload.dictionary(row["contract"]) ?? row
        let runtime = MissionPayload.dictionary(row["runtime"])
            ?? MissionPayload.dictionary(row["lifecycle"])
            ?? [:]
        self.summary = summary
        let completion = MissionPayload.dictionary(contract["completion"]) ?? [:]
        successCriteria = (MissionPayload.stringList(contract, keys: ["successCriteria", "completionConditions"]).isEmpty
            ? MissionPayload.stringList(completion, keys: ["criteria"])
            : MissionPayload.stringList(contract, keys: ["successCriteria", "completionConditions"]))
            .map(MissionRedactor.redact)
        let toolRules = MissionPayload.rows(contract["tools"])
        let explicitAllowed = MissionPayload.stringList(contract, keys: ["allowedActions", "allowedActionCategories", "allow"])
        let explicitDenied = MissionPayload.stringList(contract, keys: ["prohibitedActions", "prohibitedActionCategories", "deny"])
        allowedActions = (explicitAllowed.isEmpty
            ? toolRules.filter { MissionPayload.string($0, keys: ["decision"])?.lowercased() == "allow" }
                .compactMap { MissionPayload.string($0, keys: ["name"]) }
            : explicitAllowed).map(MissionRedactor.redact)
        prohibitedActions = (explicitDenied.isEmpty
            ? toolRules.filter { MissionPayload.string($0, keys: ["decision"])?.lowercased() == "deny" }
                .compactMap { MissionPayload.string($0, keys: ["name"]) }
            : explicitDenied).map(MissionRedactor.redact)

        let verification = MissionPayload.dictionary(row["verification"] ?? runtime["verification"])
        let evidenceRows = MissionPayload.rows(row["evidence"] ?? runtime["evidence"] ?? verification?["evidence"])
        evidence = evidenceRows.enumerated().compactMap { MissionEvidenceRecord($0.element, index: $0.offset) }
        exceptions = MissionPayload.rows(row["exceptions"] ?? runtime["exceptions"]).enumerated()
            .compactMap { MissionExceptionRecord($0.element, index: $0.offset) }
        let selectors = MissionPayload.dictionary(contract["selectors"]) ?? [:]
        let triggers = MissionPayload.stringList(selectors, keys: ["triggers"])
        triggerSummary = MissionPayload.string(row, keys: ["triggerSummary", "schedule", "trigger"])
            .map(MissionRedactor.redact)
            ?? (triggers.isEmpty ? "Manual" : triggers.map { $0.capitalized }.joined(separator: ", "))
    }
}

struct MissionEvent: Identifiable, Hashable, Sendable {
    let id: String
    let occurredAt: Date?
    let kind: String
    let status: String
    let title: String
    let detail: String?
    let evidenceCount: Int
    let isException: Bool

    init?(_ row: [String: Any], index: Int = 0) {
        kind = MissionPayload.string(row, keys: ["kind", "type", "action"]) ?? "event"
        status = MissionPayload.string(row, keys: ["status", "state", "result"]) ?? "unknown"
        title = MissionPayload.string(row, keys: ["title", "summary", "action", "kind"])
            .map(MissionRedactor.redact) ?? "Mission event"
        detail = MissionPayload.string(row, keys: ["detail", "message", "reason", "description"])
            .map(MissionRedactor.redact)
        occurredAt = MissionPayload.date(row, keys: ["occurredAt", "timestamp", "createdAt", "occurredAtMs", "timestampMs"])
        id = MissionPayload.string(row, keys: ["id", "eventId", "sequence"])
            ?? MissionPayload.stableIdentifier(prefix: "event", components: [title, "\(occurredAt?.timeIntervalSince1970 ?? 0)", "\(index)"])
        evidenceCount = MissionPayload.int(row, keys: ["evidenceCount", "proofCount"])
            ?? MissionPayload.rows(row["evidence"]).count
        isException = MissionPayload.bool(row, keys: ["isException", "exception"]) == true
            || ["failed", "blocked", "denied", "timed_out", "exception"].contains(status.lowercased())
    }
}

struct MissionEventPage: Sendable {
    let events: [MissionEvent]
    let nextCursor: String?
}

struct MissionEvaluation: Hashable, Sendable {
    let eligible: Bool
    let decision: String
    let reason: String
    let policyVersion: String?
    let requiredApprovals: [String]

    init(_ row: [String: Any]) {
        let nested = MissionPayload.dictionary(row["decision"])
        let source = nested ?? row
        let decisionText = MissionPayload.string(source, keys: ["decision", "status", "result", "kind", "outcome"])
            ?? MissionPayload.string(row, keys: ["decision", "status", "result"])
        eligible = MissionPayload.bool(source, keys: ["eligible", "allowed", "approved", "permitted"])
            ?? decisionText.map { ["eligible", "allow", "allowed", "approved", "pass", "passed"].contains($0.lowercased()) }
            ?? false
        decision = decisionText.map(MissionRedactor.redact) ?? (eligible ? "eligible" : "blocked")
        reason = MissionPayload.string(source, keys: ["reason", "message", "explanation", "detail"])
            .map(MissionRedactor.redact) ?? "The Gateway did not provide an evaluation reason."
        policyVersion = MissionPayload.string(source, keys: ["policyVersion", "policyHash", "contractVersion", "schemaVersion"])
            ?? MissionPayload.string(row, keys: ["policyVersion", "policyHash", "contractVersion", "schemaVersion"])
        requiredApprovals = MissionPayload.stringList(source, keys: ["requiredApprovals", "approvalGates", "approvals"])
            .map(MissionRedactor.redact)
    }
}

struct MissionGovernorStatus: Sendable {
    let available: Bool
    let authority: String?
    let contractVersion: String?
    let enforcementClaimed: Bool
    let globalPaused: Bool
    let globalPauseReported: Bool
    let defaultMode: MissionControlMode
    let lastHeartbeatAt: Date?
    let missionCount: Int
    let activeMissionCount: Int
    let exceptionCount: Int
    let safetyFailures: [String]

    var enforcementVerified: Bool {
        available
            && enforcementClaimed
            && authority?.lowercased() == "gateway"
            && contractVersion?.isEmpty == false
            && safetyFailures.isEmpty
    }

    init(_ payload: [String: Any]) {
        let status = MissionPayload.dictionary(payload["status"]) ?? payload
        let enforcement = MissionPayload.dictionary(status["enforcement"])
            ?? MissionPayload.dictionary(payload["enforcement"])
            ?? [:]
        let healthy = MissionPayload.bool(status, keys: ["healthy"]) ?? false
        let hooksRegistered = MissionPayload.truthy(status["hooksRegistered"])
        let permissions = MissionPayload.dictionary(status["permissions"]) ?? [:]
        let requiredPermissionKeys = ["directory", "state", "ledger"]
        let insecurePermissions = requiredPermissionKeys.compactMap { key in
            MissionPayload.securePermission(permissions[key], kind: key) ? nil : "\(key) permission is not secure"
        }
        let conversationAccess = MissionPayload.dictionary(status["conversationAccess"]) ?? [:]
        let conversationStatusReported = !conversationAccess.isEmpty
        let conversationRequired = MissionPayload.bool(conversationAccess, keys: ["required"]) ?? false
        let conversationConfigured = MissionPayload.bool(conversationAccess, keys: ["configured"]) ?? false
        available = MissionPayload.bool(status, keys: ["available", "loaded", "enabled"]) ?? !payload.isEmpty
        authority = MissionPayload.string(enforcement, keys: ["authority", "source"])
            ?? MissionPayload.string(status, keys: ["authority", "enforcementAuthority"])
        contractVersion = MissionPayload.string(enforcement, keys: ["contractVersion", "policyVersion", "schemaVersion", "version"])
            ?? MissionPayload.string(status, keys: ["contractVersion", "policyVersion", "schemaVersion", "version"])
        enforcementClaimed = MissionPayload.bool(enforcement, keys: ["verified", "gatewayEnforced", "active"])
            ?? MissionPayload.bool(status, keys: ["enforcementVerified", "gatewayEnforced"])
            ?? false
        let reportedPause = MissionPayload.bool(status, keys: ["globalPaused", "paused", "killSwitchActive"])
        globalPaused = reportedPause ?? true
        globalPauseReported = reportedPause != nil
        defaultMode = MissionControlMode(gatewayValue: MissionPayload.string(status, keys: ["defaultMode", "mode"]))
        lastHeartbeatAt = MissionPayload.date(status, keys: ["lastHeartbeatAt", "lastHeartbeatAtMs", "heartbeatAt"])
        missionCount = MissionPayload.int(status, keys: ["missionCount", "missions"]) ?? 0
        activeMissionCount = MissionPayload.int(status, keys: ["activeMissionCount", "activeCount", "runningMissions"]) ?? 0
        exceptionCount = MissionPayload.int(status, keys: ["exceptionCount", "openExceptionCount", "exceptions"]) ?? 0
        var failures = MissionPayload.stringList(status, keys: ["safetyFailures", "failures", "enforcementFailures", "healthReasons"])
            .map(MissionRedactor.redact)
        if !healthy { failures.append("Governor health is not confirmed") }
        if !hooksRegistered { failures.append("Gateway enforcement hooks are not registered") }
        failures.append(contentsOf: insecurePermissions)
        if !conversationStatusReported { failures.append("Conversation access status was not reported") }
        if conversationRequired && !conversationConfigured {
            failures.append("Required conversation access is not configured")
        }
        safetyFailures = Array(Set(failures)).sorted()
    }

    static let unavailable = MissionGovernorStatus([:])
}

enum MissionMutationAction: String, Sendable {
    case upsert
    case activate
    case advance
    case pause
    case resume
    case globalPause
    case globalResume

    var verb: String {
        switch self {
        case .upsert: "Save"
        case .activate: "Activate"
        case .advance: "Advance phase"
        case .pause: "Pause"
        case .resume: "Resume"
        case .globalPause: "Pause all missions"
        case .globalResume: "Resume mission processing"
        }
    }
}

struct MissionMutationReview: Hashable, Sendable {
    let action: MissionMutationAction
    let missionID: String?
    let missionTitle: String
    let expectedRevision: Int?
    let confirmation: String
    let acknowledgedScope: Bool
    let acknowledgedBudget: Bool
    let acknowledgedExternalEffects: Bool
    let reason: String?
    let idempotencyKey: String

    var requiredConfirmation: String {
        switch action {
        case .globalPause: "PAUSE ALL"
        case .globalResume: "RESUME ALL"
        default: "\(action.rawValue.uppercased()) \(missionTitle)"
        }
    }

    var isComplete: Bool {
        confirmation == requiredConfirmation
            && acknowledgedScope
            && acknowledgedBudget
            && acknowledgedExternalEffects
            && !idempotencyKey.isEmpty
    }
}

struct MissionMutationResult: Sendable {
    let accepted: Bool
    let message: String
    let mission: MissionSummary?

    init(_ payload: [String: Any]) {
        let result = MissionPayload.dictionary(payload["result"]) ?? payload
        let missionRow = MissionPayload.dictionary(payload["mission"])
            ?? MissionPayload.dictionary(result["mission"])
        let decodedMission = missionRow.flatMap(MissionSummary.init)
        accepted = MissionPayload.bool(result, keys: ["accepted", "ok", "updated", "activated", "paused", "resumed"])
            ?? MissionPayload.string(result, keys: ["status"]).map { ["accepted", "ok", "updated", "active", "paused", "resumed"].contains($0.lowercased()) }
            ?? (decodedMission != nil)
        message = MissionPayload.string(result, keys: ["message", "status", "result"])
            .map(MissionRedactor.redact) ?? (accepted ? "Gateway accepted the reviewed change." : "Gateway did not confirm the change.")
        mission = decodedMission
    }
}

enum MissionPayload {
    static func dictionary(_ value: Any?) -> [String: Any]? {
        value as? [String: Any]
    }

    static func rows(_ value: Any?) -> [[String: Any]] {
        if let rows = value as? [[String: Any]] { return rows }
        if let envelope = value as? [String: Any] {
            for key in ["items", "rows", "events", "missions", "evidence", "exceptions", GatewayContract.topLevelArrayKey] {
                if let rows = envelope[key] as? [[String: Any]] { return rows }
            }
        }
        return []
    }

    static func string(_ dictionary: [String: Any], keys: [String]) -> String? {
        for key in keys {
            if let value = dictionary[key] as? String, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return value
            }
            if let value = dictionary[key] as? NSNumber { return value.stringValue }
        }
        return nil
    }

    static func bool(_ dictionary: [String: Any], keys: [String]) -> Bool? {
        for key in keys {
            if let value = dictionary[key] as? Bool { return value }
            if let value = dictionary[key] as? NSNumber { return value.boolValue }
            if let value = dictionary[key] as? String {
                switch value.lowercased() {
                case "true", "yes", "enabled", "active", "verified": return true
                case "false", "no", "disabled", "inactive", "unverified": return false
                default: continue
                }
            }
        }
        return nil
    }

    static func truthy(_ value: Any?) -> Bool {
        if let value = value as? Bool { return value }
        if let value = value as? NSNumber { return value.doubleValue > 0 }
        if let value = value as? [Any] { return !value.isEmpty }
        if let value = value as? [String: Any] { return !value.isEmpty }
        if let value = value as? String {
            return ["true", "yes", "enabled", "active", "verified", "secure", "ok", "healthy", "registered"]
                .contains(value.lowercased())
        }
        return false
    }

    static func verifiedFlag(_ value: Any?) -> Bool {
        if let dictionary = value as? [String: Any] {
            return bool(dictionary, keys: ["ok", "secure", "verified", "configured", "available"]) == true
        }
        return truthy(value)
    }

    static func securePermission(_ value: Any?, kind: String) -> Bool {
        if let dictionary = value as? [String: Any] {
            if let verified = bool(dictionary, keys: ["ok", "secure", "verified"]) { return verified }
            return securePermission(dictionary["mode"] ?? dictionary["permissions"], kind: kind)
        }
        if let value = value as? Bool { return value }
        let isDirectory = kind.lowercased() == "directory"
        if let value = value as? NSNumber {
            return isDirectory ? [448, 700].contains(value.intValue) : [384, 600].contains(value.intValue)
        }
        guard let mode = (value as? String)?.lowercased() else { return false }
        return isDirectory
            ? ["0700", "700", "0o700", "drwx------"].contains(mode)
            : ["0600", "600", "0o600", "-rw-------"].contains(mode)
    }

    static func int(_ dictionary: [String: Any], keys: [String]) -> Int? {
        for key in keys {
            if let value = dictionary[key] as? Int { return value }
            if let value = dictionary[key] as? NSNumber { return value.intValue }
            if let value = dictionary[key] as? String, let parsed = Int(value) { return parsed }
        }
        return nil
    }

    static func double(_ dictionary: [String: Any], keys: [String]) -> Double? {
        for key in keys {
            if let value = dictionary[key] as? Double { return value }
            if let value = dictionary[key] as? Int { return Double(value) }
            if let value = dictionary[key] as? NSNumber { return value.doubleValue }
            if let value = dictionary[key] as? String, let parsed = Double(value) { return parsed }
        }
        return nil
    }

    static func stringList(_ dictionary: [String: Any], keys: [String]) -> [String] {
        for key in keys {
            if let values = dictionary[key] as? [String] { return values }
            if let values = dictionary[key] as? [Any] {
                return values.compactMap { $0 as? String }
            }
            if let value = dictionary[key] as? String, !value.isEmpty { return [value] }
        }
        return []
    }

    static func date(_ dictionary: [String: Any], keys: [String]) -> Date? {
        for key in keys {
            guard let value = dictionary[key] else { continue }
            if let date = value as? Date { return date }
            if let number = value as? NSNumber {
                let raw = number.doubleValue
                return Date(timeIntervalSince1970: raw > 10_000_000_000 ? raw / 1_000 : raw)
            }
            if let text = value as? String {
                if let raw = Double(text) {
                    return Date(timeIntervalSince1970: raw > 10_000_000_000 ? raw / 1_000 : raw)
                }
                if let parsed = ISO8601DateFormatter().date(from: text) { return parsed }
            }
        }
        return nil
    }

    static func stableIdentifier(prefix: String, components: [String]) -> String {
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in components.joined(separator: "\u{1F}").utf8 {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return "\(prefix)-\(String(hash, radix: 16))"
    }
}

extension MissionBudgetMetric {
    static func decode(from row: [String: Any]) -> [MissionBudgetMetric] {
        if let raw = row["budgets"] as? [[String: Any]] ?? row["budget"] as? [[String: Any]] {
            return raw.enumerated().compactMap { index, metric in
                guard let used = MissionPayload.double(metric, keys: ["used", "spent", "current", "value"]) else { return nil }
                let kind = MissionPayload.string(metric, keys: ["kind", "id", "name"]) ?? "metric-\(index)"
                return MissionBudgetMetric(
                    id: kind,
                    label: MissionPayload.string(metric, keys: ["label", "name", "kind"]) ?? kind.capitalized,
                    used: used,
                    limit: MissionPayload.double(metric, keys: ["limit", "ceiling", "maximum", "max"]),
                    unit: MissionPayload.string(metric, keys: ["unit"]) ?? ""
                )
            }
        }

        let budget = MissionPayload.dictionary(row["budget"]) ?? MissionPayload.dictionary(row["budgets"]) ?? row
        let usage = MissionPayload.dictionary(row["usage"]) ?? MissionPayload.dictionary(budget["usage"]) ?? row
        let definitions: [(String, String, [String], [String], String)] = [
            ("runs-day", "Runs today", ["runs", "runsToday"], ["runsPerDay"], "runs/day"),
            ("tools-run", "Tool calls this run", ["currentRunToolCalls", "toolCallsThisRun"], ["toolCallsPerRun"], "calls/run"),
            ("tools-day", "Tool calls today", ["toolCalls", "toolCallsToday"], ["toolCallsPerDay"], "calls/day"),
            ("writes-day", "Write calls today", ["writeCalls", "writeCallsToday"], ["writeCallsPerDay"], "writes/day"),
            ("outbound-day", "Outbound calls today", ["outbound", "outboundToday"], ["outboundPerDay"], "outbound/day"),
            ("runtime-run", "Runtime this run", ["runtimeSeconds", "currentRunRuntimeSeconds"], ["runtimeSecondsPerRun"], "sec/run")
        ]
        return definitions.compactMap { id, label, usedKeys, limitKeys, unit in
            let used = MissionPayload.double(usage, keys: usedKeys) ?? 0
            let limit = MissionPayload.double(budget, keys: limitKeys)
            guard used > 0 || limit != nil else { return nil }
            return MissionBudgetMetric(id: id, label: label, used: used, limit: limit, unit: unit)
        }
    }
}

enum MissionRedactor {
    private static let patterns: [(String, String)] = [
        (#"(?i)\b(bearer\s+)[A-Za-z0-9._~+/=-]+"#, "$1[REDACTED]"),
        (#"(?i)\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+"#, "$1=[REDACTED]"),
        (#"(?i)(https?://[^\s/?#]+/[^\s?#]*)\?[^\s]+"#, "$1?[REDACTED]")
    ]

    static func redact(_ input: String) -> String {
        var output = input
        for (pattern, replacement) in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            let range = NSRange(output.startIndex..<output.endIndex, in: output)
            output = regex.stringByReplacingMatches(in: output, range: range, withTemplate: replacement)
        }
        return output
    }
}
