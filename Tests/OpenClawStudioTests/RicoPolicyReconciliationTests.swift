import Darwin
import Foundation
import Testing
@testable import OpenClawStudio

@Suite("Rico policy reconciliation stability")
struct RicoPolicyReconciliationTests {
    @MainActor
    @Test("Missing intent starts admission-quarantined without inventing an explicit Pause")
    func missingIntentIsUnreviewedQuarantine() throws {
        let name = "rico-intent-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.removePersistentDomain(forName: name)

        let state = RicoPauseIntentStore.load(from: defaults)
        #expect(state == RicoPauseIntentState(paused: false, reviewed: false))
        #expect(defaults.object(forKey: RicoPauseIntentStore.pausedKey) == nil)
        #expect(RicoProjectionMode.desired(paused: state.paused, reviewed: state.reviewed) == .healthQuarantine)
        #expect(RicoProjectionMode.healthQuarantine.channelEnabled)
        #expect(RicoProjectionMode.healthQuarantine.admissionPaused)
    }

    @MainActor
    @Test("An unreviewed false intent can be reviewed and activated in one action")
    func reviewAndActivateSameValueFalse() throws {
        let name = "rico-intent-review-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.removePersistentDomain(forName: name)
        let initial = RicoPauseIntentStore.load(from: defaults)
        #expect(initial == RicoPauseIntentState(paused: false, reviewed: false))
        #expect(RicoPauseIntentTransition.shouldCommit(
            currentPaused: initial.paused,
            reviewed: initial.reviewed,
            requestedPaused: false
        ))
        RicoPauseIntentStore.recordExplicit(false, in: defaults)
        let reviewed = RicoPauseIntentStore.load(from: defaults)
        #expect(reviewed == RicoPauseIntentState(paused: false, reviewed: true))
        #expect(RicoProjectionMode.desired(paused: reviewed.paused, reviewed: reviewed.reviewed) == .active)
        #expect(!RicoPauseIntentTransition.shouldCommit(
            currentPaused: reviewed.paused,
            reviewed: reviewed.reviewed,
            requestedPaused: false
        ))

        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: repository.appendingPathComponent("Sources/OpenClawStudio/RicoCommunicationsView.swift"),
            encoding: .utf8
        )
        #expect(source.contains("Button(\"Review and activate\") { confirmResume = true }"))
        #expect(source.contains("Button(\"Resume messaging\") { store.setGlobalPaused(false) }"))
    }

    @MainActor
    @Test("Legacy reviewed intent migrates once and runtime health cannot rewrite it")
    func reviewedIntentMigrationAndSeparation() throws {
        let name = "rico-intent-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.removePersistentDomain(forName: name)
        defaults.set(false, forKey: RicoPauseIntentStore.pausedKey)

        let reviewed = RicoPauseIntentStore.load(from: defaults)
        #expect(reviewed == RicoPauseIntentState(paused: false, reviewed: true))
        #expect(defaults.integer(forKey: RicoPauseIntentStore.versionKey) == RicoPauseIntentStore.currentVersion)

        for _ in 0..<4 {
            #expect(RicoProjectionRecoveryPolicy.fallback(for: .active) == .healthQuarantine)
            #expect(defaults.bool(forKey: RicoPauseIntentStore.pausedKey) == false)
        }
        RicoPauseIntentStore.recordExplicit(true, in: defaults)
        #expect(RicoPauseIntentStore.load(from: defaults) == RicoPauseIntentState(paused: true, reviewed: true))
        #expect(RicoProjectionMode.desired(paused: true, reviewed: true) == .explicitPause)
    }

    @MainActor
    @Test("A legacy automatic true value cannot masquerade as an explicit Pause")
    func legacyAutomaticPauseIsUnreviewed() throws {
        let name = "rico-intent-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.removePersistentDomain(forName: name)
        defaults.set(true, forKey: RicoPauseIntentStore.pausedKey)

        let state = RicoPauseIntentStore.load(from: defaults)
        #expect(state == RicoPauseIntentState(paused: false, reviewed: false))
        #expect(defaults.integer(forKey: RicoPauseIntentStore.versionKey) == 0)
        #expect(RicoProjectionMode.desired(paused: state.paused, reviewed: state.reviewed) == .healthQuarantine)
        #expect(RicoProjectionMode.desired(paused: state.paused, reviewed: state.reviewed).channelEnabled)
    }

    @Test("Only explicit Pause disables the physical channel")
    func intentAndHealthModesHaveDistinctChannelSemantics() {
        #expect(RicoProjectionMode.active.channelEnabled)
        #expect(!RicoProjectionMode.active.admissionPaused)
        #expect(!RicoProjectionMode.explicitPause.channelEnabled)
        #expect(RicoProjectionMode.explicitPause.admissionPaused)
        #expect(RicoProjectionMode.healthQuarantine.channelEnabled)
        #expect(RicoProjectionMode.healthQuarantine.admissionPaused)

        let owner = RicoRecipientPolicy(
            id: "owner", contactID: "owner", displayName: "Owner", address: "+15550000001",
            access: .owner, requireMention: true, autoReply: true,
            quietStart: 0, quietEnd: 0, groupChatID: nil
        )
        let quarantined = RicoNativePolicyProjection.plan(
            policies: [owner], paused: true, channelEnabledOverride: true
        )
        #expect(quarantined.channelEnabled)
        #expect(quarantined.dmPolicy == "disabled")
        #expect(quarantined.groupPolicy == "disabled")
        #expect(quarantined.allowFrom.isEmpty)
        #expect(quarantined.ownerAllowFrom.isEmpty)
        #expect(quarantined.sharedBindingTargets.isEmpty)
    }

    @Test("Every transient verification class chooses the same non-persistent quarantine")
    func transientFailuresNeverBecomePauseIntent() {
        let transientFailures = [
            "app launch",
            "Gateway unavailable",
            "LM Studio warm-up",
            "plugin install race",
            "concurrent read-back drift",
        ]
        for _ in transientFailures {
            let fallback = RicoProjectionRecoveryPolicy.fallback(for: .active)
            #expect(fallback == .healthQuarantine)
            #expect(fallback.channelEnabled)
            #expect(fallback.admissionPaused)
        }
        #expect(RicoProjectionRecoveryPolicy.fallback(for: .explicitPause) == .explicitPause)
    }

    @Test("Active recovery is staged paused and a healthy audit cannot repair while admitted")
    func activeAttemptBoundaries() {
        #expect(RicoActiveProjectionAttempt.stagedActivation.initialGuardPaused)
        #expect(RicoActiveProjectionAttempt.stagedActivation.mayRepairNativeConfig)
        #expect(!RicoActiveProjectionAttempt.healthyAudit.initialGuardPaused)
        #expect(!RicoActiveProjectionAttempt.healthyAudit.mayRepairNativeConfig)
    }

    @MainActor
    @Test("An overlapping explicit Pause invalidates every older Resume mutation")
    func resumeThenExplicitPauseInvalidatesOldEpoch() throws {
        let authority = RicoProjectionEpochAuthority()
        let resume = authority.begin(desiredMode: .active)
        var staleMutationCount = 0
        try authority.performIfCurrent(resume, currentMode: .active) {
            staleMutationCount += 1
        }
        #expect(staleMutationCount == 1)

        let pause = authority.begin(desiredMode: .explicitPause)
        #expect(throws: RicoProjectionEpochAuthority.EpochError.self) {
            try authority.performIfCurrent(resume, currentMode: .explicitPause) {
                staleMutationCount += 1
            }
        }
        #expect(staleMutationCount == 1)
        try authority.attest(pause, currentMode: .explicitPause)
    }

    @MainActor
    @Test("A newer policy snapshot invalidates an older epoch even when both intend Resume")
    func resumeThenNewPolicyInvalidatesOldEpoch() throws {
        let authority = RicoProjectionEpochAuthority()
        let oldPolicy = authority.begin(desiredMode: .active)
        let newPolicy = authority.begin(desiredMode: .active)

        #expect(throws: RicoProjectionEpochAuthority.EpochError.self) {
            try authority.attest(oldPolicy, currentMode: .active)
        }
        try authority.attest(newPolicy, currentMode: .active)
        #expect(newPolicy.sequence > oldPolicy.sequence)
    }

    @MainActor
    @Test("A partial two-file stage invalidates old activation and cleanup closes the owner route")
    func partialStagedWriteCannotLeavePriorEpochAuthorized() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("rico-partial-stage-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let policies = stagedWritePolicies()
        try RicoRecipientGuard.writePolicy(policies: policies, paused: false, in: root)
        #expect(RicoRecipientGuard.readPausedState(in: root) == false)
        #expect(try ownerRouteEnabled(in: root))

        let authority = RicoProjectionEpochAuthority()
        let priorActivation = authority.begin(desiredMode: .active)
        authority.invalidate()
        do {
            try RicoRecipientGuard.stagePausedPolicyPair(
                policies: policies,
                in: root,
                fault: { stage in
                    if stage == .afterPolicy { throw ActivationTestError.pausedWriteFailed }
                }
            )
            Issue.record("Injected owner-route failure must abort the staged pair")
        } catch ActivationTestError.pausedWriteFailed {
            // Recipient admission was written paused before the injected
            // owner-route failure; the previous route is cleaned below.
        } catch {
            Issue.record("Expected the injected staged-write failure")
        }

        #expect(RicoRecipientGuard.readPausedState(in: root) == true)
        #expect(!(try ownerRouteEnabled(in: root)))
        #expect(RicoRecipientGuard.pausedPairVerified(in: root))
        #expect(throws: RicoProjectionEpochAuthority.EpochError.self) {
            try authority.attest(priorActivation, currentMode: .active)
        }
    }

    @Test("An exact coherent paused pair is a watchdog no-op, while policy drift rewrites once")
    func pausedPairSemanticNoOp() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("rico-paused-noop-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let policies = stagedWritePolicies()
        try RicoRecipientGuard.stagePausedPolicyPair(policies: policies, in: root)
        let policyURL = root.appendingPathComponent("rico-recipient-guard.json")
        let routeURL = root.appendingPathComponent("rico-owner-command-route.json")
        let beforePolicy = fileIdentity(policyURL)
        let beforeRoute = fileIdentity(routeURL)
        let beforeNotBefore = try ownerRouteNotBefore(in: root)

        try RicoRecipientGuard.stagePausedPolicyPair(policies: policies, in: root)
        #expect(fileIdentity(policyURL) == beforePolicy)
        #expect(fileIdentity(routeURL) == beforeRoute)
        #expect(try ownerRouteNotBefore(in: root) == beforeNotBefore)

        var changed = policies
        changed[0].displayName = "Updated reviewed owner"
        try RicoRecipientGuard.stagePausedPolicyPair(policies: changed, in: root)
        #expect(fileIdentity(policyURL) != beforePolicy)
        #expect(RicoRecipientGuard.pausedPairVerified(policies: changed, in: root))
    }

    @Test("A failure before the first sidecar write rejects the change before state acceptance and starts emergency recovery")
    func prePolicyFailureIsNotAcceptedActive() throws {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: repository.appendingPathComponent("Sources/OpenClawStudio/RicoCommunicationsView.swift"),
            encoding: .utf8
        )
        let start = try #require(source.range(of: "    private func commitPolicySnapshot"))
        let end = try #require(source.range(
            of: "\n    private func scheduleEmergencyRecoveryAfterStageFailure",
            range: start.upperBound..<source.endIndex
        ))
        let commit = String(source[start.lowerBound..<end.lowerBound])
        let stagedPair = try #require(commit.range(of: "try RicoRecipientGuard.stagePausedPolicyPair"))
        let recovery = try #require(commit.range(
            of: "scheduleEmergencyRecoveryAfterStageFailure(",
            range: stagedPair.upperBound..<commit.endIndex
        ))
        let rejection = try #require(commit.range(of: "return false", range: recovery.upperBound..<commit.endIndex))
        let persistedState = try #require(commit.range(
            of: "UserDefaults.standard.set(encoded, forKey: \"rico.policies\")",
            range: rejection.upperBound..<commit.endIndex
        ))
        #expect(stagedPair.lowerBound < recovery.lowerBound)
        #expect(recovery.lowerBound < rejection.lowerBound)
        #expect(rejection.lowerBound < persistedState.lowerBound)

        let recoveryStart = try #require(source.range(of: "    private func scheduleEmergencyRecoveryAfterStageFailure"))
        let recoveryEnd = try #require(source.range(
            of: "\n    private func persistDrafts",
            range: recoveryStart.upperBound..<source.endIndex
        ))
        let recoverySource = String(source[recoveryStart.lowerBound..<recoveryEnd.lowerBound])
        let nativeQuarantine = try #require(recoverySource.range(of: "RicoNativePolicyProjection.emergencyQuarantine("))
        #expect(recoverySource.contains("mode: RicoProjectionRecoveryPolicy.fallback(for: liveMode)"))
        #expect(!recoverySource.contains("mode: .healthQuarantine"))
        let retryPair = try #require(recoverySource.range(
            of: "RicoRecipientGuard.stagePausedPolicyPair(policies: proposedPolicies)",
            range: nativeQuarantine.upperBound..<recoverySource.endIndex
        ))
        let acceptPending = try #require(recoverySource.range(
            of: "UserDefaults.standard.set(encodedPolicies, forKey: \"rico.policies\")",
            range: retryPair.upperBound..<recoverySource.endIndex
        ))
        #expect(nativeQuarantine.lowerBound < retryPair.lowerBound)
        #expect(retryPair.lowerBound < acceptPending.lowerBound)
    }

    @MainActor
    @Test("Cancellation at model, read-back, or final activation makes the old epoch stale")
    func cancellationStagesCannotContinueWriting() throws {
        let authority = RicoProjectionEpochAuthority()
        var attempt = authority.begin(desiredMode: .active)
        for _ in ["model", "read-back", "final-unpause"] {
            let replacement = authority.begin(desiredMode: .active)
            #expect(throws: RicoProjectionEpochAuthority.EpochError.self) {
                try authority.attest(attempt, currentMode: .active)
            }
            try authority.attest(replacement, currentMode: .active)
            attempt = replacement
        }
    }

    @Test("A failed active proof must re-pause, and failed re-pause is a hard boundary error")
    func failedRePauseIsHardFailure() async {
        let admission = ActivationAdmissionHarness(failPausedWrite: true)
        do {
            try await RicoFinalActivationBoundary.activate(
                attestCurrent: {},
                writePaused: { paused in try await admission.write(paused) },
                proveActive: { throw ActivationTestError.proofFailed }
            )
            Issue.record("Activation must not succeed after its active proof fails")
        } catch let error as RicoFinalActivationBoundary.BoundaryError {
            #expect(error == .requarantineFailed)
        } catch {
            Issue.record("Failed re-pause must be promoted to the hard boundary error")
        }
        #expect(await admission.values() == [false])
    }

    @Test("A failed active proof restores pause before returning its proof error")
    func failedProofRestoresPause() async {
        let admission = ActivationAdmissionHarness(failPausedWrite: false)
        do {
            try await RicoFinalActivationBoundary.activate(
                attestCurrent: {},
                writePaused: { paused in try await admission.write(paused) },
                proveActive: { throw ActivationTestError.proofFailed }
            )
            Issue.record("Activation must not succeed after its active proof fails")
        } catch ActivationTestError.proofFailed {
            // Expected only after the successful re-pause.
        } catch {
            Issue.record("The original proof error should escape after re-pause")
        }
        #expect(await admission.values() == [false, true])
    }

    @Test("A partial activation-sidecar write is re-paused before its error escapes")
    func partialActivationWriteRestoresPause() async {
        let admission = ActivationAdmissionHarness(
            failPausedWrite: false,
            failActiveAfterWrite: true
        )
        do {
            try await RicoFinalActivationBoundary.activate(
                attestCurrent: {},
                writePaused: { paused in try await admission.write(paused) },
                proveActive: {}
            )
            Issue.record("A partial active write must not complete activation")
        } catch ActivationTestError.activeWriteFailed {
            // Expected only after pause has been restored.
        } catch {
            Issue.record("The partial active-write error should escape after re-pause")
        }
        #expect(await admission.values() == [false, true])
    }

    @Test("Runtime failure handling cannot persist pause intent or mutate the UI toggle")
    func failureLoopHasNoDurablePauseMutation() throws {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: repository.appendingPathComponent("Sources/OpenClawStudio/RicoCommunicationsView.swift"),
            encoding: .utf8
        )
        let start = try #require(source.range(of: "    private func scheduleNativeProjection"))
        let end = try #require(source.range(
            of: "\n}\n\nenum RicoRecipientGuard",
            range: start.upperBound..<source.endIndex
        ))
        let failureLoop = String(source[start.lowerBound..<end.lowerBound])
        #expect(!failureLoop.contains("UserDefaults"))
        #expect(!failureLoop.contains("RicoPauseIntentStore.recordExplicit"))
        #expect(!failureLoop.contains("globalPaused ="))
        #expect(!failureLoop.contains("channels.imessage.enabled"))
        #expect(source.components(separatedBy: "persistExplicitPauseIntent: true").count - 1 == 1)
        #expect(!source.contains("writePolicy(policies: canonicalPolicies, paused: proposedPause)"))
        #expect(source.contains("stagePausedPolicyPair(policies: canonicalPolicies)"))
        #expect(!failureLoop.contains("writePolicy(policies: snapshot, paused: true)"))

        let commitStart = try #require(source.range(of: "    private func commitPolicySnapshot"))
        let commitEnd = try #require(source.range(
            of: "\n    private func persistDrafts",
            range: commitStart.upperBound..<source.endIndex
        ))
        let commit = String(source[commitStart.lowerBound..<commitEnd.lowerBound])
        let invalidation = try #require(commit.range(of: "projectionEpochAuthority.invalidate()"))
        let stagedWrite = try #require(commit.range(
            of: "try RicoRecipientGuard.stagePausedPolicyPair(policies: canonicalPolicies)",
            range: invalidation.upperBound..<commit.endIndex
        ))
        #expect(invalidation.lowerBound < stagedWrite.lowerBound)

        #expect(!failureLoop.contains("try? RicoRecipientGuard.writePolicy"))
        let pauseBoundary = try #require(failureLoop.range(
            of: "try await writeAdmissionPaused(true)"
        ))
        let quarantineProjection = try #require(failureLoop.range(
            of: "RicoProjectionRecoveryPolicy.fallback(for: desiredMode)",
            range: pauseBoundary.upperBound..<failureLoop.endIndex
        ))
        #expect(pauseBoundary.lowerBound < quarantineProjection.lowerBound)
        let pauseFailureCatch = try #require(failureLoop.range(
            of: "let pairError = error",
            range: pauseBoundary.upperBound..<failureLoop.endIndex
        ))
        let independentEmergency = try #require(failureLoop.range(
            of: "RicoNativePolicyProjection.emergencyQuarantine(",
            range: pauseFailureCatch.upperBound..<failureLoop.endIndex
        ))
        #expect(pauseFailureCatch.lowerBound < independentEmergency.lowerBound)
    }

    @Test("Final activation unpauses only after paused proof and immediately re-proves active")
    func finalActivationOrdering() throws {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: repository.appendingPathComponent("Sources/OpenClawStudio/RicoCommunicationsView.swift"),
            encoding: .utf8
        )
        let finalStage = try #require(source.range(
            of: "// Native config, strict-local routing, hooks, tools, and"
        ))
        let tail = String(source[finalStage.lowerBound...])
        let pausedProof = try #require(tail.range(of: "try await requireStableLiveGuardStatus(paused: true)"))
        let activation = try #require(tail.range(
            of: "try await RicoFinalActivationBoundary.activate(",
            range: pausedProof.upperBound..<tail.endIndex
        ))
        let epochBoundWriter = try #require(tail.range(
            of: "writePaused: writeAdmissionPaused",
            range: activation.upperBound..<tail.endIndex
        ))
        let activeProof = try #require(tail.range(
            of: "try await requireStableLiveGuardStatus(paused: false)",
            range: epochBoundWriter.upperBound..<tail.endIndex
        ))
        #expect(pausedProof.lowerBound < activation.lowerBound)
        #expect(activation.lowerBound < epochBoundWriter.lowerBound)
        #expect(epochBoundWriter.lowerBound < activeProof.lowerBound)
    }

    @Test("Paused and quarantined agents retain a strict local model pin")
    func quarantineRetainsStrictLocalModel() throws {
        let route = RicoNativePolicyProjection.SharedModelRoute(
            primary: RicoNativePolicyProjection.requiredSharedLocalModel,
            fallbacks: []
        )
        let agents = RicoNativePolicyProjection.configuredAgents(
            existing: [],
            mainWorkspace: "/private/main",
            sharedWorkspace: "/private/shared",
            ownerHandles: [],
            modelRoute: route
        )
        let shared = try #require(agents.first { ($0["id"] as? String) == "rico-shared" })
        let model = try #require(shared["model"] as? [String: Any])
        #expect(model["primary"] as? String == RicoNativePolicyProjection.requiredSharedLocalModel)
        #expect(model["fallbacks"] as? [String] == [])
        let tools = try #require(shared["tools"] as? [String: Any])
        #expect(tools["deny"] as? [String] == ["*"])
        #expect((tools["elevated"] as? [String: Any])?["enabled"] as? Bool == false)
    }

    @Test("Exact repeated projections are semantic no-ops and preserve ISTS state")
    func exactProjectionNoOpAndISTSCoexistence() {
        let raw: [String: Any] = [
            "channels": ["imessage": ["enabled": true, "dmPolicy": "allowlist"]],
            "plugins": [
                "allow": ["rico-escalation-handoff", "rico-ists-incident", "rico-recipient-guard"],
                "entries": [
                    "rico-ists-incident": ["enabled": true, "config": ["enabled": false]],
                    "rico-escalation-handoff": ["enabled": true],
                ],
            ],
        ]
        let operations: [[String: Any]] = [
            ["path": "channels.imessage.enabled", "value": true],
            ["path": "channels.imessage.dmPolicy", "value": "allowlist"],
            ["path": "plugins.allow", "value": ["rico-escalation-handoff", "rico-ists-incident", "rico-recipient-guard"]],
            ["path": "plugins.entries.rico-escalation-handoff", "value": ["enabled": true]],
        ]
        #expect(RicoNativePolicyProjection.operationValuesMatchRawConfig(operations, rawConfig: raw))

        var drifted = operations
        drifted[0] = ["path": "channels.imessage.enabled", "value": false]
        #expect(!RicoNativePolicyProjection.operationValuesMatchRawConfig(drifted, rawConfig: raw))
        #expect(((raw["plugins"] as? [String: Any])?["entries"] as? [String: Any])?["rico-ists-incident"] != nil)
    }

    @Test("Writer lease is exclusive, private, recoverable, and rejects link attacks")
    func singleWriterLeaseBoundary() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("rico-writer-lease-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let first = try RicoProjectionWriterLease.acquire(in: root)
        let lock = root.appendingPathComponent("rico-policy-writer.lock")
        #expect(permissions(root) == 0o700)
        #expect(permissions(lock) == 0o600)
        #expect(throws: RicoProjectionWriterLease.LeaseError.self) {
            _ = try RicoProjectionWriterLease.acquire(in: root)
        }
        first.release()
        let replacement = try RicoProjectionWriterLease.acquire(in: root)
        replacement.release()

        try FileManager.default.removeItem(at: lock)
        let outside = root.appendingPathComponent("outside")
        try Data().write(to: outside)
        try FileManager.default.linkItem(at: outside, to: lock)
        #expect(throws: RicoProjectionWriterLease.LeaseError.self) {
            _ = try RicoProjectionWriterLease.acquire(in: root)
        }

        let real = FileManager.default.temporaryDirectory
            .appendingPathComponent("rico-writer-real-\(UUID().uuidString)", isDirectory: true)
        let link = FileManager.default.temporaryDirectory
            .appendingPathComponent("rico-writer-link-\(UUID().uuidString)")
        defer {
            try? FileManager.default.removeItem(at: link)
            try? FileManager.default.removeItem(at: real)
        }
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: false)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        #expect(throws: RicoProjectionWriterLease.LeaseError.self) {
            _ = try RicoProjectionWriterLease.acquire(in: link)
        }
    }

    @Test("Retry cadence debounces startup and converges to a bounded watchdog")
    func retryCadence() {
        #expect(RicoProjectionRetryPolicy.delay(afterFailure: 0) == 750_000_000)
        #expect(RicoProjectionRetryPolicy.delay(afterFailure: 1) == 1_000_000_000)
        #expect(RicoProjectionRetryPolicy.delay(afterFailure: 2) == 2_000_000_000)
        #expect(RicoProjectionRetryPolicy.delay(afterFailure: 3) == 15_000_000_000)
        #expect(RicoProjectionRetryPolicy.delay(afterFailure: 99) == 15_000_000_000)
        #expect(RicoProjectionRetryPolicy.healthyAuditNanoseconds == 30_000_000_000)
    }

    @Test("Pause, health quarantine, and unavailable transport block outbound claims independently")
    func outboundAdmissionUsesOperationalTransport() {
        #expect(!RicoOutboundAdmission.isVerified(
            explicitlyPaused: false,
            healthQuarantined: true,
            enforcementVerified: true,
            outboundTransportOperational: true
        ))
        #expect(!RicoOutboundAdmission.isVerified(
            explicitlyPaused: true,
            healthQuarantined: false,
            enforcementVerified: true,
            outboundTransportOperational: true
        ))
        #expect(!RicoOutboundAdmission.isVerified(
            explicitlyPaused: false,
            healthQuarantined: false,
            enforcementVerified: true,
            outboundTransportOperational: false
        ))
        #expect(!RicoOutboundAdmission.isVerified(
            explicitlyPaused: false,
            healthQuarantined: false,
            enforcementVerified: false,
            outboundTransportOperational: true
        ))
        #expect(RicoOutboundAdmission.isVerified(
            explicitlyPaused: false,
            healthQuarantined: false,
            enforcementVerified: true,
            outboundTransportOperational: true
        ))
        #expect(RicoOutboundAdmission.draftBlockReason(
            explicitlyPaused: false,
            healthQuarantined: false,
            outboundTransportOperational: false
        ) != nil)
        #expect(RicoOutboundAdmission.draftBlockReason(
            explicitlyPaused: false,
            healthQuarantined: false,
            outboundTransportOperational: true
        ) == nil)

        var drafts = [RicoDraft(
            id: UUID(), createdAt: Date(), recipientName: "Reviewed", address: "+15550000003",
            message: "Reviewed fixture", intent: .message, state: .approved, reason: "Approved"
        )]
        let claimed = RicoDraftQueue.claimForSending(
            &drafts,
            id: drafts[0].id,
            paused: true,
            enforcementVerified: true
        )
        #expect(claimed == nil)
        #expect(drafts[0].state == .approved)
    }

    @Test("A follower Studio window can observe degraded delivery but emits no projection work")
    func followerDeliveryObservationIsDisplayOnly() {
        var projectionWrites = 0
        var projectionTasks = 0
        let decision = RicoDeliveryObservationDecision.decide(
            hasWriterLease: false,
            readiness: .deliveryDegraded,
            explicitlyPaused: false,
            pauseIntentReviewed: true,
            healthQuarantined: false
        )
        if decision == .quarantine {
            projectionWrites += 1
            projectionTasks += 1
        }
        #expect(decision == .displayOnly)
        #expect(projectionWrites == 0)
        #expect(projectionTasks == 0)
        #expect(RicoDeliveryObservationDecision.decide(
            hasWriterLease: true,
            readiness: .transportReady,
            explicitlyPaused: false,
            pauseIntentReviewed: true,
            healthQuarantined: true
        ) == .noProjectionChange)
        #expect(RicoDeliveryObservationDecision.decide(
            hasWriterLease: true,
            readiness: .verifiedDelivery,
            explicitlyPaused: false,
            pauseIntentReviewed: true,
            healthQuarantined: false
        ) == .noProjectionChange)
        #expect(RicoDeliveryObservationDecision.decide(
            hasWriterLease: true,
            readiness: .deliveryDegraded,
            explicitlyPaused: false,
            pauseIntentReviewed: true,
            healthQuarantined: false
        ) == .quarantine)
        #expect(RicoDeliveryObservationDecision.decide(
            hasWriterLease: true,
            readiness: .unavailable,
            explicitlyPaused: false,
            pauseIntentReviewed: true,
            healthQuarantined: false
        ) == .quarantine)
    }

    @MainActor
    @Test("Degraded delivery and unavailable transport both invalidate staged activation")
    func failedProbeInvalidatesStagedActivation() throws {
        for readiness: IMessageProbeReadiness in [.deliveryDegraded, .unavailable] {
            let authority = RicoProjectionEpochAuthority()
            let delayedActivation = authority.begin(desiredMode: .active)
            let decision = RicoDeliveryObservationDecision.decide(
                hasWriterLease: true,
                readiness: readiness,
                explicitlyPaused: false,
                pauseIntentReviewed: true,
                healthQuarantined: true
            )
            #expect(decision == .quarantine)
            if decision == .quarantine {
                authority.invalidate()
            }
            #expect(throws: RicoProjectionEpochAuthority.EpochError.self) {
                try authority.attest(delayedActivation, currentMode: .active)
            }
        }
    }

    @Test("Emergency quarantine keeps the channel registered but removes every Rico admission path")
    func emergencyNativeOperationsFailClosed() throws {
        let raw: [String: Any] = [
            "channels": ["imessage": ["enabled": true, "dmPolicy": "allowlist"]],
            "commands": ["ownerAllowFrom": ["imessage:+15550000001", "slack:U123"]],
            "agents": [
                "defaults": ["workspace": "/private/main"],
                "list": [[
                    "id": "rico-shared",
                    "workspace": "/private/shared",
                    "model": ["primary": "anthropic/frontier", "fallbacks": ["openai/frontier"]],
                    "tools": ["allow": ["*"]],
                ]],
            ],
            "bindings": [
                ["agentId": "rico-shared", "match": ["channel": "imessage"]],
                ["agentId": "unrelated", "match": ["channel": "slack"]],
            ],
        ]
        let operations = RicoNativePolicyProjection.emergencyQuarantineOperations(
            rawConfig: raw,
            mode: .healthQuarantine
        )
        func value(_ path: String) -> Any? {
            operations.first { ($0["path"] as? String) == path }?["value"]
        }
        #expect(value("channels.imessage.enabled") as? Bool == true)
        #expect(value("channels.imessage.dmPolicy") as? String == "disabled")
        #expect((value("channels.imessage.allowFrom") as? [String])?.isEmpty == true)
        #expect(value("channels.imessage.groupPolicy") as? String == "disabled")
        #expect((value("channels.imessage.groupAllowFrom") as? [String])?.isEmpty == true)
        #expect(value("commands.ownerAllowFrom") as? [String] == ["slack:U123"])
        let agents = try #require(value("agents.list") as? [[String: Any]])
        let shared = try #require(agents.first { ($0["id"] as? String) == "rico-shared" })
        #expect((shared["model"] as? [String: Any])?["primary"] as? String == RicoNativePolicyProjection.requiredSharedLocalModel)
        #expect((shared["model"] as? [String: Any])?["fallbacks"] as? [String] == [])
        #expect((shared["tools"] as? [String: Any])?["deny"] as? [String] == ["*"])
        let bindings = try #require(value("bindings") as? [[String: Any]])
        #expect(!bindings.contains { ($0["agentId"] as? String) == "rico-shared" })
        #expect(bindings.contains { ($0["agentId"] as? String) == "unrelated" })

        let explicit = RicoNativePolicyProjection.emergencyQuarantineOperations(
            rawConfig: raw,
            mode: .explicitPause
        )
        #expect(explicit.first { ($0["path"] as? String) == "channels.imessage.enabled" }?["value"] as? Bool == false)
    }

    @Test("Operational preflight precedes config mutation and unavailable quarantine is idempotent")
    func operationalPreflightAndUnavailableQuarantine() throws {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: repository.appendingPathComponent("Sources/OpenClawStudio/RicoCommunicationsView.swift"),
            encoding: .utf8
        )
        let applyStart = try #require(source.range(of: "    static func apply(\n"))
        let holdingStart = try #require(source.range(
            of: "\n    private static func applyHoldingLease",
            range: applyStart.upperBound..<source.endIndex
        ))
        let applySource = String(source[applyStart.lowerBound..<holdingStart.lowerBound])
        let preflight = try #require(applySource.range(of: "try await requireOperationalIMessageTransport"))
        let lease = try #require(applySource.range(of: "RicoNativeConfigLease.acquire()"))
        #expect(preflight.lowerBound < lease.lowerBound)
        #expect(!source.contains("publishIMessageReadiness(.verifiedDelivery)"))

        var raw: [String: Any] = [
            "channels": ["imessage": ["enabled": true, "dmPolicy": "allowlist"]],
            "commands": ["ownerAllowFrom": ["imessage:+15550000001", "slack:U123"]],
            "agents": [
                "defaults": ["workspace": "/private/main"],
                "list": [[
                    "id": "rico-shared",
                    "workspace": "/private/shared",
                    "model": ["primary": "anthropic/frontier", "fallbacks": ["openai/frontier"]],
                    "tools": ["allow": ["*"]],
                ]],
            ],
            "bindings": [["agentId": "rico-shared", "match": ["channel": "imessage"]]],
        ]
        var writeCount = 0
        for _ in 0..<6 {
            let operations = RicoNativePolicyProjection.emergencyQuarantineOperations(
                rawConfig: raw,
                mode: .healthQuarantine
            )
            if !RicoNativePolicyProjection.operationValuesMatchRawConfig(operations, rawConfig: raw) {
                raw = applying(operations, to: raw)
                writeCount += 1
            }
        }
        #expect(writeCount == 1)
        #expect(((((raw["channels"] as? [String: Any])?["imessage"] as? [String: Any])?["enabled"]) as? Bool) == true)
        #expect(((raw["agents"] as? [String: Any])?["list"] as? [[String: Any]])?.contains {
            ($0["id"] as? String) == "rico-shared"
        } == true)
        #expect((raw["bindings"] as? [[String: Any]])?.contains { ($0["agentId"] as? String) == "rico-shared" } == false)
    }

    @Test("shared config lease is exclusive, private, cancellation-safe, and rejects link attacks")
    func sharedConfigLeaseBoundary() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("rico-native-config-lease-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let first = try await RicoNativeConfigLease.acquire(in: root)
        let lockDirectory = root.appendingPathComponent(RicoNativeConfigLease.directoryName)
        let owner = lockDirectory.appendingPathComponent(RicoNativeConfigLease.ownerFileName)
        #expect(permissions(lockDirectory) == 0o700)
        #expect(permissions(owner) == 0o600)
        do {
            _ = try await RicoNativeConfigLease.acquire(
                in: root,
                timeoutNanoseconds: 20_000_000,
                pollNanoseconds: 2_000_000
            )
            Issue.record("A second config writer must not acquire the live lease")
        } catch let error as RicoNativeConfigLease.LeaseError {
            #expect(error == .busy)
        }
        #expect(first.release())
        let replacement = try await RicoNativeConfigLease.acquire(in: root)
        #expect(replacement.release())

        let outside = root.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
        try FileManager.default.createSymbolicLink(at: lockDirectory, withDestinationURL: outside)
        do {
            _ = try await RicoNativeConfigLease.acquire(
                in: root,
                timeoutNanoseconds: 5_000_000
            )
            Issue.record("A linked lock directory must fail closed")
        } catch let error as RicoNativeConfigLease.LeaseError {
            #expect(error == .unsafeBoundary)
        }
    }

    @Test("raw config fingerprints detect a concurrent writer before replacement")
    func rawConfigCASFingerprint() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("rico-config-cas-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let config = root.appendingPathComponent("openclaw.json")
        try Data("{\"plugins\":{}}\n".utf8).write(to: config)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: config.path)
        let before = try RicoNativePolicyProjection.rawConfigSnapshot(configURL: config)
        try Data("{\"plugins\":{},\"concurrent\":true}\n".utf8).write(to: config, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: config.path)
        let after = try RicoNativePolicyProjection.rawConfigSnapshot(configURL: config)
        #expect(before.sha256 != after.sha256)
    }

    @Test("exact workspace and owner-route installs are no-op on the second pass")
    func exactInstallersPreserveModificationTime() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("rico-noop-install-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }

        _ = try RicoSharedWorkspace.ensureInstalled(in: root.appendingPathComponent("workspace"))
        let agents = root.appendingPathComponent("workspace/AGENTS.md")
        let workspaceBefore = modificationNanoseconds(agents)
        _ = try RicoSharedWorkspace.ensureInstalled(in: root.appendingPathComponent("workspace"))
        #expect(modificationNanoseconds(agents) == workspaceBefore)

        let source = root.appendingPathComponent("route.mjs")
        try Data("#!/usr/bin/env node\nprocess.exit(0);\n".utf8).write(to: source)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: source.path)
        let destination = root.appendingPathComponent("bin/version/imsg")
        _ = try await RicoOwnerRouteInstaller.ensureInstalled(source: source, destination: destination)
        let routeBefore = modificationNanoseconds(destination)
        _ = try await RicoOwnerRouteInstaller.ensureInstalled(source: source, destination: destination)
        #expect(modificationNanoseconds(destination) == routeBefore)
    }

    private func permissions(_ url: URL) -> Int {
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attributes?[.posixPermissions] as? NSNumber)?.intValue ?? -1
    }

    private func modificationNanoseconds(_ url: URL) -> Int64 {
        var value = stat()
        guard lstat(url.path, &value) == 0 else { return -1 }
        return Int64(value.st_mtimespec.tv_sec) * 1_000_000_000 + Int64(value.st_mtimespec.tv_nsec)
    }

    private func fileIdentity(_ url: URL) -> String {
        var value = stat()
        guard lstat(url.path, &value) == 0 else { return "missing" }
        return "\(value.st_dev):\(value.st_ino):\(value.st_size):\(value.st_mtimespec.tv_sec):\(value.st_mtimespec.tv_nsec)"
    }

    private func stagedWritePolicies() -> [RicoRecipientPolicy] {
        [
            RicoRecipientPolicy(
                id: "owner", contactID: "owner", displayName: "Owner", address: "+15550000001",
                access: .owner, requireMention: true, autoReply: true,
                quietStart: 0, quietEnd: 0, groupChatID: nil
            ),
            RicoRecipientPolicy(
                id: "group:101", contactID: "", displayName: "Test group", address: "chat_id:101",
                access: .approved, requireMention: true, autoReply: true,
                quietStart: 0, quietEnd: 0, groupChatID: "101",
                participantAddresses: ["+15550000001", "+15550000002"]
            ),
        ]
    }

    private func ownerRouteEnabled(in root: URL) throws -> Bool {
        let data = try Data(contentsOf: root.appendingPathComponent("rico-owner-command-route.json"))
        let value = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try #require(value["enabled"] as? Bool)
    }

    private func ownerRouteNotBefore(in root: URL) throws -> Double {
        let data = try Data(contentsOf: root.appendingPathComponent("rico-owner-command-route.json"))
        let value = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try #require((value["notBeforeMs"] as? NSNumber)?.doubleValue)
    }

    private func applying(_ operations: [[String: Any]], to raw: [String: Any]) -> [String: Any] {
        operations.reduce(raw) { result, operation in
            guard let path = operation["path"] as? String,
                  let value = operation["value"] else { return result }
            return setting(value, path: path.split(separator: ".").map(String.init), in: result)
        }
    }

    private func setting(_ value: Any, path: [String], in root: [String: Any]) -> [String: Any] {
        guard let head = path.first else { return root }
        var result = root
        if path.count == 1 {
            result[head] = value
        } else {
            let child = result[head] as? [String: Any] ?? [:]
            result[head] = setting(value, path: Array(path.dropFirst()), in: child)
        }
        return result
    }
}

private enum ActivationTestError: Error {
    case proofFailed
    case pausedWriteFailed
    case activeWriteFailed
}

private actor ActivationAdmissionHarness {
    private let failPausedWrite: Bool
    private let failActiveAfterWrite: Bool
    private var writes: [Bool] = []

    init(failPausedWrite: Bool, failActiveAfterWrite: Bool = false) {
        self.failPausedWrite = failPausedWrite
        self.failActiveAfterWrite = failActiveAfterWrite
    }

    func write(_ paused: Bool) throws {
        if paused && failPausedWrite {
            throw ActivationTestError.pausedWriteFailed
        }
        writes.append(paused)
        if !paused && failActiveAfterWrite {
            throw ActivationTestError.activeWriteFailed
        }
    }

    func values() -> [Bool] {
        writes
    }
}
