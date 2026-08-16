import Foundation

enum MissionGovernorRPC {
    static let status = "rico.autonomy.status"
    static let listMissions = "rico.autonomy.missions.list"
    static let getMission = "rico.autonomy.missions.get"
    static let listEvents = "rico.autonomy.events.list"
    static let evaluate = "rico.autonomy.evaluate"
    static let upsert = "rico.autonomy.missions.upsert"
    static let activate = "rico.autonomy.missions.activate"
    static let pause = "rico.autonomy.missions.pause"
    static let resume = "rico.autonomy.missions.resume"
    static let advance = "rico.autonomy.missions.advance"
    static let globalPause = "rico.autonomy.global.pause"
    static let globalResume = "rico.autonomy.global.resume"

    static let readMethods: Set<String> = [status, listMissions, getMission, listEvents, evaluate]
    static let mutationMethods: Set<String> = [upsert, activate, pause, resume, advance, globalPause, globalResume]

    static func scopes(for method: String) -> [String] {
        mutationMethods.contains(method) ? ["operator.admin"] : ["operator.read"]
    }

    static func missionReference(id: String, expectedRevision: Int?, idempotencyKey: String) -> [String: Any] {
        var params: [String: Any] = ["id": id, "idempotencyKey": idempotencyKey]
        if let expectedRevision { params["expectedRevision"] = expectedRevision }
        return params
    }

    static func eventListParameters(missionID: String?, limit: Int, cursor: String?) -> [String: Any] {
        var params: [String: Any] = ["limit": min(max(limit, 1), 500)]
        if let missionID, !missionID.isEmpty { params["missionId"] = missionID }
        if let cursor, !cursor.isEmpty { params["cursor"] = cursor }
        return params
    }

    static func evaluationParameters(missionID: String, action: MissionMutationAction) -> [String: Any] {
        [
            "missionId": missionID,
            "action": [
                "kind": "lifecycle",
                "transition": action.rawValue
            ]
        ]
    }

    static func upsertParameters(
        mission: [String: Any],
        expectedRevision: Int?,
        idempotencyKey: String
    ) -> [String: Any] {
        var params: [String: Any] = ["mission": mission, "idempotencyKey": idempotencyKey]
        if let expectedRevision { params["expectedRevision"] = expectedRevision }
        return params
    }

    static func advanceParameters(
        id: String,
        phase: String,
        evidence: [[String: Any]]?,
        runID: String?,
        expectedRevision: Int?,
        idempotencyKey: String
    ) -> [String: Any] {
        var params = missionReference(id: id, expectedRevision: expectedRevision, idempotencyKey: idempotencyKey)
        params["phase"] = phase
        if let evidence { params["evidence"] = evidence }
        if let runID, !runID.isEmpty { params["runId"] = runID }
        return params
    }
}

enum MissionGovernorClientError: LocalizedError {
    case invalidResponse(String)
    case enforcementUnverified([String])
    case incompleteReview(String)
    case mismatchedReview
    case mutationNotConfirmed(String)
    case invalidContract([String])

    var errorDescription: String? {
        switch self {
        case .invalidResponse(let surface):
            "The Gateway returned an invalid \(surface) response."
        case .enforcementUnverified(let reasons):
            reasons.isEmpty
                ? "Gateway autonomy enforcement is not verified. Mission changes are locked."
                : "Gateway autonomy enforcement is not verified: \(reasons.joined(separator: "; "))"
        case .incompleteReview(let phrase):
            "Review every guardrail and type “\(phrase)” exactly before continuing."
        case .mismatchedReview:
            "The reviewed mission does not match the requested Gateway change."
        case .mutationNotConfirmed(let message):
            "The Gateway did not confirm the reviewed change: \(MissionRedactor.redact(message))"
        case .invalidContract(let reasons):
            "The reviewed Mission contract is invalid: \(reasons.joined(separator: "; "))"
        }
    }
}

/// Narrow adapter over the Gateway-authoritative Mission Governor RPC surface.
///
/// Installed OpenClaw runtime surfaces remain intentionally separate:
/// `tasks.list` is a durable background-work ledger, `audit.list` is metadata-only,
/// `usage.cost` is provider accounting, `cron.*` schedules wakes, `last-heartbeat`
/// reports a heartbeat event, and `workboard.*` owns cards. None of those contracts
/// grants Mission authority. Only the verified `rico.autonomy.*` adapter may mutate
/// Mission state.
final class MissionGovernorClient: @unchecked Sendable {
    private let gateway: GatewayClient

    init(gateway: GatewayClient = GatewayClient()) {
        self.gateway = gateway
    }

    func status() async throws -> MissionGovernorStatus {
        let payload = try await protectedCall(method: MissionGovernorRPC.status, params: [:])
        guard !payload.isEmpty else { throw MissionGovernorClientError.invalidResponse("governor status") }
        return MissionGovernorStatus(payload)
    }

    func missions() async throws -> [MissionSummary] {
        let payload = try await protectedCall(method: MissionGovernorRPC.listMissions, params: [:])
        return GatewayContract.rows(in: payload, preferredKeys: ["missions", "items", "rows"])
            .compactMap(MissionSummary.init)
    }

    func mission(id: String) async throws -> MissionDetail {
        let payload = try await protectedCall(method: MissionGovernorRPC.getMission, params: ["id": id])
        let row = MissionPayload.dictionary(payload["mission"]) ?? payload
        guard let detail = MissionDetail(row) else { throw MissionGovernorClientError.invalidResponse("mission detail") }
        return detail
    }

    func events(missionID: String? = nil, limit: Int = 200, cursor: String? = nil) async throws -> MissionEventPage {
        let payload = try await protectedCall(
            method: MissionGovernorRPC.listEvents,
            params: MissionGovernorRPC.eventListParameters(missionID: missionID, limit: limit, cursor: cursor)
        )
        let rows = GatewayContract.rows(in: payload, preferredKeys: ["events", "items", "rows"])
        return MissionEventPage(
            events: rows.enumerated().compactMap { MissionEvent($0.element, index: $0.offset) },
            nextCursor: MissionPayload.string(payload, keys: ["nextCursor", "cursor"])
        )
    }

    func evaluate(missionID: String, action: MissionMutationAction) async throws -> MissionEvaluation {
        let payload = try await protectedCall(
            method: MissionGovernorRPC.evaluate,
            params: MissionGovernorRPC.evaluationParameters(missionID: missionID, action: action)
        )
        let row = MissionPayload.dictionary(payload["evaluation"]) ?? payload
        return MissionEvaluation(row)
    }

    /// Persists the builder's reviewed canonical contract as an inactive Mission.
    /// This method never invokes activate, resume, advance, cron, tasks, or tools.
    func upsertReviewed(
        contract: MissionContract,
        expectedRevision: Int? = nil,
        idempotencyKey: String = UUID().uuidString
    ) async throws -> MissionMutationResult {
        let validation = MissionContractValidator.validate(contract)
        guard validation.isValid else {
            throw MissionGovernorClientError.invalidContract(
                validation.errors.map { MissionRedactor.redact($0.message) }
            )
        }
        guard !idempotencyKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw MissionGovernorClientError.invalidContract(["A one-time idempotency key is required."])
        }
        try await requireVerifiedEnforcement()
        let mission = try contract.gatewayObject()
        let params = MissionGovernorRPC.upsertParameters(
            mission: mission,
            expectedRevision: expectedRevision,
            idempotencyKey: idempotencyKey
        )
        return try await confirmedMutation(method: MissionGovernorRPC.upsert, params: params)
    }

    func mutateMission(_ review: MissionMutationReview) async throws -> MissionMutationResult {
        guard [.activate, .pause, .resume].contains(review.action), let id = review.missionID else {
            throw MissionGovernorClientError.mismatchedReview
        }
        try validateReview(review)
        // A reviewed pause is a restrictive emergency action and remains available
        // even when the verification badge is degraded. Activation and resume always
        // require a healthy, explicitly verified Gateway enforcement contract.
        if review.action != .pause { try await requireVerifiedEnforcement() }
        let method: String
        switch review.action {
        case .activate: method = MissionGovernorRPC.activate
        case .pause: method = MissionGovernorRPC.pause
        case .resume: method = MissionGovernorRPC.resume
        default: throw MissionGovernorClientError.mismatchedReview
        }
        let params = MissionGovernorRPC.missionReference(
            id: id,
            expectedRevision: review.expectedRevision,
            idempotencyKey: review.idempotencyKey
        )
        return try await confirmedMutation(method: method, params: params)
    }

    func setGlobalPause(_ review: MissionMutationReview) async throws -> MissionMutationResult {
        guard review.action == .globalPause || review.action == .globalResume else {
            throw MissionGovernorClientError.mismatchedReview
        }
        try validateReview(review)
        if review.action == .globalResume { try await requireVerifiedEnforcement() }
        let method = review.action == .globalPause ? MissionGovernorRPC.globalPause : MissionGovernorRPC.globalResume
        let payload = try await protectedCall(method: method, params: [
            "reason": review.reason ?? "Reviewed in OpenClaw Studio",
            "idempotencyKey": review.idempotencyKey
        ])
        let globalPaused = MissionPayload.bool(payload, keys: ["globalPaused"])
        let expectedPaused = review.action == .globalPause
        guard globalPaused == expectedPaused else {
            throw MissionGovernorClientError.mutationNotConfirmed("global pause state was not confirmed")
        }
        return MissionMutationResult([
            "accepted": true,
            "message": expectedPaused ? "All missions are paused at the Gateway." : "Gateway mission processing resumed."
        ])
    }

    /// Reserved for the supervisor/executor. The Studio UI does not call this automatically.
    /// Advancing a phase uses the same explicit operator review barrier as activation.
    func advance(
        missionID: String,
        phase: String,
        evidence: [[String: Any]]? = nil,
        runID: String? = nil,
        review: MissionMutationReview
    ) async throws -> MissionMutationResult {
        guard review.missionID == missionID, review.action == .advance else {
            throw MissionGovernorClientError.mismatchedReview
        }
        try validateReview(review)
        try await requireVerifiedEnforcement()
        let params = MissionGovernorRPC.advanceParameters(
            id: missionID,
            phase: phase,
            evidence: evidence,
            runID: runID,
            expectedRevision: review.expectedRevision,
            idempotencyKey: review.idempotencyKey
        )
        return try await confirmedMutation(method: MissionGovernorRPC.advance, params: params)
    }

    private func confirmedMutation(method: String, params: [String: Any]) async throws -> MissionMutationResult {
        let payload = try await protectedCall(method: method, params: params)
        let result = MissionMutationResult(payload)
        // Mutation envelopes may return only the updated mission. That object is the
        // authoritative confirmation; absent both an explicit acceptance and mission,
        // fail closed rather than assuming success from an empty RPC response.
        guard result.accepted || result.mission != nil else {
            throw MissionGovernorClientError.mutationNotConfirmed(result.message)
        }
        return result
    }

    private func validateReview(_ review: MissionMutationReview) throws {
        guard review.isComplete else {
            throw MissionGovernorClientError.incompleteReview(review.requiredConfirmation)
        }
    }

    private func requireVerifiedEnforcement() async throws {
        let current = try await status()
        guard current.enforcementVerified else {
            throw MissionGovernorClientError.enforcementUnverified(current.safetyFailures)
        }
    }

    private func protectedCall(method: String, params: [String: Any]) async throws -> [String: Any] {
        do {
            return try await gateway.call(method: method, params: params)
        } catch {
            let message = MissionRedactor.redact(error.localizedDescription)
            throw GatewayClientError.rejected(message)
        }
    }
}
