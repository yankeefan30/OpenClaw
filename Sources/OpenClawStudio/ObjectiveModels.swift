import Foundation

enum ControlPlaneMode: String, Codable, CaseIterable, Identifiable {
    case observe = "Observe"
    case suggest = "Suggest"
    case bounded = "Execute Bounded"
    // Decode-only compatibility for objectives saved by Studio 1.0. This mode
    // is intentionally excluded from the UI and can never authorize work.
    case trusted = "Execute Trusted"
    static var allCases: [ControlPlaneMode] { [.observe, .suggest, .bounded] }
    var id: String { rawValue }
    var explanation: String {
        switch self {
        case .observe: return "Read-only. No cards or dispatch changes."
        case .suggest: return "Create proposals in triage. Human approval is required."
        case .bounded: return "Dispatch only policy-eligible ready cards."
        case .trusted: return "Legacy mode disabled. Move this objective into a Gateway-governed Mission."
        }
    }
}

struct ObjectiveDefinition: Codable, Identifiable, Hashable {
    let id: UUID
    var title: String
    var desiredOutcome: String
    var successCriteria: [String]
    var scope: String
    var approvedWorkspaces: [String]
    var assignedAgent: String?
    var priority: String
    var operatingMode: ControlPlaneMode
    var allowedActionCategories: [String]
    var prohibitedActionCategories: [String]
    var maximumParallelWorkers: Int
    var retryCeiling: Int
    var workingHours: String
    var quietHours: String
    var deadline: Date?
    var timeCeilingSeconds: Int?
    var costCeilingCents: Int?
    var requiredVerificationEvidence: [String]
    var reportingCadence: String
    var pauseConditions: [String]
    var completionConditions: [String]
    var schemaVersion: Int = 1
    var createdAt: Date = Date()
    var updatedAt: Date = Date()
}

enum PolicyDecision: Equatable {
    case eligible
    case requiresApproval(String)
    case blocked(String)
    case paused(String)
    case budgetExceeded(String)
    case dependencyBlocked(String)
    case verificationRequired(String)
}

struct PolicyContext {
    var now: Date
    var activeWorkers: Int
    var retriesUsed: Int
    var elapsedSeconds: Int
    var spentCents: Int
    var dependenciesReady: Bool
    var evidence: Set<String>
    var actionCategories: Set<String>
    var inQuietHours: Bool
    var paused: Bool
    var requestedMode: ControlPlaneMode
}

enum AutonomyPolicyEvaluator {
    static func evaluate(_ objective: ObjectiveDefinition, context: PolicyContext) -> PolicyDecision {
        if objective.operatingMode == .trusted || context.requestedMode == .trusted {
            return .blocked("Legacy Execute Trusted is disabled. Use a Gateway-governed Mission.")
        }
        if context.paused { return .paused("Objective is paused.") }
        if let deadline = objective.deadline, context.now > deadline { return .budgetExceeded("Deadline has passed.") }
        if !context.dependenciesReady { return .dependencyBlocked("Dependencies are not complete.") }
        if context.inQuietHours { return .paused("Quiet hours are active.") }
        if context.activeWorkers >= objective.maximumParallelWorkers { return .blocked("Concurrency ceiling reached.") }
        if context.retriesUsed >= objective.retryCeiling { return .budgetExceeded("Retry ceiling reached.") }
        if let ceiling = objective.timeCeilingSeconds, context.elapsedSeconds >= ceiling { return .budgetExceeded("Time ceiling reached.") }
        if let ceiling = objective.costCeilingCents, context.spentCents >= ceiling { return .budgetExceeded("Cost ceiling reached.") }
        if !objective.requiredVerificationEvidence.allSatisfy(context.evidence.contains) {
            return .verificationRequired("Required verification evidence is missing.")
        }
        if !objective.allowedActionCategories.isEmpty && !context.actionCategories.isSubset(of: Set(objective.allowedActionCategories)) {
            return .requiresApproval("Action category is outside the objective allowlist.")
        }
        if !Set(objective.prohibitedActionCategories).isDisjoint(with: context.actionCategories) {
            return .blocked("Objective prohibits one or more requested action categories.")
        }
        if objective.operatingMode == .observe || context.requestedMode == .observe {
            return .paused("Observe mode never dispatches work.")
        }
        if objective.operatingMode == .suggest || context.requestedMode == .suggest {
            return .requiresApproval("Suggest mode requires human approval.")
        }
        if context.requestedMode == .bounded && context.actionCategories.contains("external_communication") {
            return .requiresApproval("External communication requires approval in Execute Bounded.")
        }
        return .eligible
    }
}

@MainActor
final class ObjectiveStore: ObservableObject {
    @Published private(set) var objectives: [ObjectiveDefinition] = []
    @Published var defaultMode: ControlPlaneMode = .observe {
        didSet { save() }
    }
    private let url = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".openclaw/workspace/objectives.json")

    init() { load() }
    func add(_ objective: ObjectiveDefinition) { objectives.append(objective); save() }
    func update(_ objective: ObjectiveDefinition) {
        guard let index = objectives.firstIndex(where: { $0.id == objective.id }) else { return }
        objectives[index] = objective; save()
    }
    private func load() {
        do {
            let data = try Data(contentsOf: url)
            let envelope = try JSONDecoder().decode(Envelope.self, from: data)
            objectives = envelope.objectives
            defaultMode = envelope.defaultMode
        } catch { objectives = [] }
    }
    private func save() {
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(Envelope(objectives: objectives, defaultMode: defaultMode))
            try data.write(to: url, options: .atomic)
        } catch { /* surfaced by the next refresh/diagnostic pass */ }
    }
    private struct Envelope: Codable {
        var schemaVersion = 1
        var objectives: [ObjectiveDefinition]
        var defaultMode: ControlPlaneMode
    }
}
