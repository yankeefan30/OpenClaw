import Foundation
import Testing
@testable import OpenClawStudio

@Suite("Autonomy policy")
struct AutonomyPolicyTests {
    private func objective(mode: ControlPlaneMode = .bounded) -> ObjectiveDefinition {
        ObjectiveDefinition(
            id: UUID(), title: "Test", desiredOutcome: "Done", successCriteria: ["proof"],
            scope: "workspace", approvedWorkspaces: ["/tmp"], assignedAgent: "main",
            priority: "normal", operatingMode: mode, allowedActionCategories: ["local_edit"],
            prohibitedActionCategories: ["spending"], maximumParallelWorkers: 1,
            retryCeiling: 2, workingHours: "09:00-18:00", quietHours: "18:00-09:00",
            deadline: nil, timeCeilingSeconds: 600, costCeilingCents: 100,
            requiredVerificationEvidence: ["test"], reportingCadence: "daily",
            pauseConditions: [], completionConditions: ["test_passed"]
        )
    }
    private func context(_ categories: Set<String> = ["local_edit"]) -> PolicyContext {
        PolicyContext(now: Date(), activeWorkers: 0, retriesUsed: 0, elapsedSeconds: 0,
                      spentCents: 0, dependenciesReady: true, evidence: ["test"],
                      actionCategories: categories, inQuietHours: false, paused: false,
                      requestedMode: .bounded)
    }

    @Test func testEligibleBoundedWork() {
        assert(AutonomyPolicyEvaluator.evaluate(objective(), context: context()) == .eligible)
    }
    @Test func testExternalCommunicationRequiresApprovalInBounded() {
        let result = AutonomyPolicyEvaluator.evaluate(objective(), context: context(["external_communication"]))
        assert(result == .requiresApproval("Action category is outside the objective allowlist."))
    }
    @Test func testQuietHoursPause() {
        var value = context(); value.inQuietHours = true
        assert(AutonomyPolicyEvaluator.evaluate(objective(), context: value) == .paused("Quiet hours are active."))
    }
    @Test func testMissingEvidenceRequiresVerification() {
        var value = context(); value.evidence = []
        assert(AutonomyPolicyEvaluator.evaluate(objective(), context: value) == .verificationRequired("Required verification evidence is missing."))
    }
    @Test func testConcurrencyAndRetryBudgetsBlock() {
        var value = context(); value.activeWorkers = 1
        assert(AutonomyPolicyEvaluator.evaluate(objective(), context: value) == .blocked("Concurrency ceiling reached."))
        value.activeWorkers = 0; value.retriesUsed = 2
        assert(AutonomyPolicyEvaluator.evaluate(objective(), context: value) == .budgetExceeded("Retry ceiling reached."))
    }

    @Test func legacyTrustedModeCannotAuthorizeWork() {
        var value = context()
        value.requestedMode = .trusted
        assert(AutonomyPolicyEvaluator.evaluate(objective(mode: .trusted), context: value) ==
               .blocked("Legacy Execute Trusted is disabled. Use a Gateway-governed Mission."))
        assert(!ControlPlaneMode.allCases.contains(.trusted))
    }
}
