import Foundation
import Testing
@testable import OpenClawStudio

@Suite("Mission Control Gateway boundary")
struct MissionControlTests {
    @Test("Unavailable status never claims the emergency pause is confirmed")
    func unavailablePauseStateIsUnknown() {
        #expect(!MissionGovernorStatus.unavailable.globalPauseReported)
        #expect(MissionGovernorStatus.unavailable.globalPaused)
        #expect(!MissionGovernorStatus.unavailable.enforcementVerified)
    }

    @Test("Governor enforcement badge requires healthy Gateway hooks and secure state")
    func verifiedStatusRequiresCompleteAttestation() {
        let verified = MissionGovernorStatus([
            "contractVersion": "1.0",
            "healthy": true,
            "globalPaused": false,
            "hooksRegistered": 4,
            "conversationAccess": ["required": true, "configured": true],
            "permissions": ["directory": true, "state": true, "ledger": true],
            "enforcement": [
                "verified": true,
                "authority": "gateway",
                "contractVersion": "1.0"
            ]
        ])
        #expect(verified.enforcementVerified)
        #expect(verified.safetyFailures.isEmpty)

        let missingHooks = MissionGovernorStatus([
            "contractVersion": "1.0",
            "healthy": true,
            "hooksRegistered": 0,
            "conversationAccess": ["required": false, "configured": false],
            "permissions": ["directory": true, "state": true, "ledger": true],
            "enforcement": [
                "verified": true,
                "authority": "gateway",
                "contractVersion": "1.0"
            ]
        ])
        #expect(!missingHooks.enforcementVerified)
        #expect(missingHooks.safetyFailures.contains("Gateway enforcement hooks are not registered"))
    }

    @Test("Status decoder uses health reasons and conversation access fail closed")
    func unhealthyStatusReasons() {
        let status = MissionGovernorStatus([
            "healthy": false,
            "healthReasons": ["ledger unavailable"],
            "hooksRegistered": true,
            "conversationAccess": ["required": true, "configured": false],
            "permissions": ["directory": true, "state": true, "ledger": false],
            "enforcement": [
                "verified": true,
                "authority": "gateway",
                "contractVersion": "1"
            ]
        ])
        #expect(!status.enforcementVerified)
        #expect(status.safetyFailures.contains("ledger unavailable"))
        #expect(status.safetyFailures.contains("ledger permission is not secure"))
        #expect(status.safetyFailures.contains("Required conversation access is not configured"))
    }

    @Test("POSIX permission attestations accept only private governor modes")
    func posixPermissionAttestation() {
        let status = MissionGovernorStatus([
            "healthy": true,
            "hooksRegistered": true,
            "conversationAccess": ["required": false, "configured": false],
            "permissions": ["directory": "0700", "state": "0600", "ledger": "0600"],
            "enforcement": [
                "verified": true,
                "authority": "gateway",
                "contractVersion": "1"
            ]
        ])
        #expect(status.enforcementVerified)

        let loose = MissionGovernorStatus([
            "healthy": true,
            "hooksRegistered": true,
            "conversationAccess": ["required": false, "configured": false],
            "permissions": ["directory": "0755", "state": "0644", "ledger": "0600"],
            "enforcement": [
                "verified": true,
                "authority": "gateway",
                "contractVersion": "1"
            ]
        ])
        #expect(!loose.enforcementVerified)
        #expect(loose.safetyFailures.contains("directory permission is not secure"))
        #expect(loose.safetyFailures.contains("state permission is not secure"))
    }

    @Test("Legacy trusted mode is displayed as unknown and cannot be promoted")
    func legacyTrustedModeIsUnknown() throws {
        let mission = try #require(MissionSummary([
            "id": "mission-1",
            "title": "Legacy authority",
            "outcome": "Do everything",
            "state": "paused",
            "mode": "trusted"
        ]))
        #expect(mission.mode == .unknown)
    }

    @Test("Mission decoder accepts canonical budgets, evidence, and exceptions")
    func missionDetailDecoding() throws {
        let detail = try #require(MissionDetail([
            "id": "mission-2",
            "title": "Morning brief",
            "outcome": "Prepare a verified brief",
            "state": "shadow",
            "mode": "shadow",
            "budget": [
                "runsPerDay": 5,
                "toolCallsPerRun": 20,
                "toolCallsPerDay": 50,
                "writeCallsPerDay": 10,
                "outboundPerDay": 2,
                "runtimeSecondsPerRun": 600
            ],
            "usage": [
                "runs": 2,
                "currentRunToolCalls": 8,
                "toolCalls": 18,
                "writeCalls": 4,
                "outbound": 1,
                "runtimeSeconds": 90
            ],
            "successCriteria": ["Every claim has a source"],
            "allowedActions": ["calendar.read"],
            "prohibitedActions": ["message.send"],
            "evidence": [[
                "id": "proof-1",
                "title": "Source audit",
                "status": "verified"
            ]],
            "exceptions": [[
                "id": "exception-1",
                "title": "Calendar offline",
                "message": "Retry ceiling reached",
                "resolved": false,
                "requiresApproval": true
            ]]
        ]))

        #expect(detail.summary.budgets.count == 6)
        #expect(detail.summary.budgets.first { $0.id == "outbound-day" }?.limit == 2)
        #expect(detail.evidence.first?.verified == true)
        #expect(detail.exceptions.first?.requiresApproval == true)
        #expect(detail.prohibitedActions == ["message.send"])
    }

    @Test("Timeline decoder redacts secrets and preserves stable identity")
    func timelineRedaction() throws {
        let row: [String: Any] = [
            "occurredAt": "2026-08-14T12:00:00Z",
            "kind": "tool_action",
            "status": "blocked",
            "summary": "Provider denied request",
            "message": "token=abc123 Bearer secret-value"
        ]
        let first = try #require(MissionEvent(row))
        let second = try #require(MissionEvent(row))
        #expect(first.id == second.id)
        #expect(first.isException)
        #expect(first.detail?.contains("abc123") == false)
        #expect(first.detail?.contains("secret-value") == false)
    }

    @Test("RPC adapter keeps read and admin surfaces distinct")
    func rpcScopesAndParameters() {
        #expect(MissionGovernorRPC.scopes(for: MissionGovernorRPC.status) == ["operator.read"])
        #expect(MissionGovernorRPC.scopes(for: MissionGovernorRPC.listEvents) == ["operator.read"])
        #expect(MissionGovernorRPC.scopes(for: MissionGovernorRPC.activate) == ["operator.admin"])
        #expect(MissionGovernorRPC.scopes(for: MissionGovernorRPC.globalPause) == ["operator.admin"])

        let events = MissionGovernorRPC.eventListParameters(missionID: "mission-1", limit: 999, cursor: "40")
        #expect(events["missionId"] as? String == "mission-1")
        #expect(events["limit"] as? Int == 500)
        #expect(events["cursor"] as? String == "40")

        let mutation = MissionGovernorRPC.missionReference(
            id: "mission-1",
            expectedRevision: 7,
            idempotencyKey: "once-1"
        )
        #expect(mutation["id"] as? String == "mission-1")
        #expect(mutation["expectedRevision"] as? Int == 7)
        #expect(mutation["idempotencyKey"] as? String == "once-1")
    }

    @Test("Lifecycle evaluation uses the governor action object contract")
    func lifecycleEvaluationContract() throws {
        let params = MissionGovernorRPC.evaluationParameters(missionID: "mission-1", action: .activate)
        let action = try #require(params["action"] as? [String: Any])
        #expect(params["missionId"] as? String == "mission-1")
        #expect(action["kind"] as? String == "lifecycle")
        #expect(action["transition"] as? String == "activate")
    }

    @Test("Reviewed upsert envelope cannot smuggle lifecycle activation")
    func reviewedUpsertEnvelope() throws {
        let mission: [String: Any] = [
            "schema": MissionContract.schemaIdentifier,
            "schemaVersion": MissionContract.currentSchemaVersion,
            "id": "mission-safe",
            "revision": 1,
            "mode": "shadow"
        ]
        let params = MissionGovernorRPC.upsertParameters(
            mission: mission,
            expectedRevision: nil,
            idempotencyKey: "upsert-once"
        )
        #expect(Set(params.keys) == ["mission", "idempotencyKey"])
        let encoded = try #require(params["mission"] as? [String: Any])
        #expect(encoded["active"] == nil)
        #expect(encoded["enabled"] == nil)
        #expect(encoded["lifecycle"] == nil)
        #expect(encoded["mode"] as? String == "shadow")
    }

    @Test("Evaluation decoder accepts nested policy decision envelopes")
    func nestedEvaluation() {
        let evaluation = MissionEvaluation([
            "missionId": "mission-2",
            "policyHash": "sha256:policy",
            "decision": [
                "allowed": true,
                "status": "allowed",
                "reason": "All bounded checks passed",
                "requiredApprovals": ["external communication"]
            ]
        ])
        #expect(evaluation.eligible)
        #expect(evaluation.decision == "allowed")
        #expect(evaluation.reason == "All bounded checks passed")
        #expect(evaluation.policyVersion == "sha256:policy")
        #expect(evaluation.requiredApprovals == ["external communication"])
    }

    @Test("Advance payload carries exact reviewed phase evidence contract")
    func advancePayload() {
        let params = MissionGovernorRPC.advanceParameters(
            id: "mission-3",
            phase: "verify",
            evidence: [["id": "proof-1", "digest": "sha256:abc"]],
            runID: "run-1",
            expectedRevision: 2,
            idempotencyKey: "advance-once"
        )
        #expect(params["id"] as? String == "mission-3")
        #expect(params["phase"] as? String == "verify")
        #expect(params["runId"] as? String == "run-1")
        #expect((params["evidence"] as? [[String: Any]])?.count == 1)
    }

    @Test("Phase advancement has its own explicit review phrase")
    func advanceReviewPhrase() {
        let review = MissionMutationReview(
            action: .advance,
            missionID: "mission-3",
            missionTitle: "Daily Brief",
            expectedRevision: 2,
            confirmation: "ADVANCE Daily Brief",
            acknowledgedScope: true,
            acknowledgedBudget: true,
            acknowledgedExternalEffects: true,
            reason: nil,
            idempotencyKey: "advance-review"
        )
        #expect(review.isComplete)
    }

    @Test("Every mission mutation requires all review acknowledgements and exact phrase")
    func explicitReviewBarrier() {
        let incomplete = MissionMutationReview(
            action: .activate,
            missionID: "mission-4",
            missionTitle: "Daily Brief",
            expectedRevision: 1,
            confirmation: "ACTIVATE Daily Brief",
            acknowledgedScope: true,
            acknowledgedBudget: true,
            acknowledgedExternalEffects: false,
            reason: nil,
            idempotencyKey: "review-1"
        )
        #expect(!incomplete.isComplete)

        let complete = MissionMutationReview(
            action: .activate,
            missionID: "mission-4",
            missionTitle: "Daily Brief",
            expectedRevision: 1,
            confirmation: "ACTIVATE Daily Brief",
            acknowledgedScope: true,
            acknowledgedBudget: true,
            acknowledgedExternalEffects: true,
            reason: nil,
            idempotencyKey: "review-1"
        )
        #expect(complete.isComplete)
    }

    @Test("Mutation response requires explicit acceptance or an updated mission")
    func mutationConfirmation() {
        #expect(!MissionMutationResult([:]).accepted)
        #expect(MissionMutationResult(["accepted": true]).accepted)
        #expect(MissionMutationResult([
            "mission": [
                "id": "mission-5",
                "title": "Verified",
                "state": "active",
                "mode": "bounded"
            ]
        ]).mission?.id == "mission-5")
    }
}
