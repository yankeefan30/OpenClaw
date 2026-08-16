import Foundation
import Testing
@testable import OpenClawStudio

@Suite("Rico communication policy")
struct RicoCommunicationsTests {
    @Test func contactResolverFindsUniqueName() {
        let contacts = [
            LocalContact(id: "1", name: "Ana García", phones: ["(312) 555-0100"], emails: []),
            LocalContact(id: "2", name: "Janet Smith", phones: ["404-555-0101"], emails: [])
        ]
        guard case .unique(let contact) = ContactResolver.resolve("ana garcia", in: contacts) else { assertionFailure(); return }
        assert(contact.id == "1")
        assert(ContactResolver.normalizedPhone(contact.phones[0]) == "+13125550100")
    }

    @Test func contactResolverNeverGuessesAmbiguousNames() {
        let contacts = [
            LocalContact(id: "1", name: "Alex Rivera", phones: ["2125550100"], emails: []),
            LocalContact(id: "2", name: "Alex Smith", phones: ["2125550101"], emails: [])
        ]
        guard case .ambiguous(let matches) = ContactResolver.resolve("Alex", in: contacts) else { assertionFailure(); return }
        assert(matches.count == 2)
    }

    @Test func policyBlocksBlockedRecipient() {
        let recipient = RicoRecipientPolicy(id: "1", contactID: "1", displayName: "Blocked", address: "+12125550100", access: .blocked, requireMention: true, autoReply: true, quietStart: 0, quietEnd: 0)
        assert(RicoMessagePolicy.evaluate(recipient: recipient, initiatesConversation: false, message: "Hello") == .block("This contact is blocked."))
    }

    @Test func proactiveMessageAlwaysRequiresReview() {
        let recipient = RicoRecipientPolicy(id: "1", contactID: "1", displayName: "Ana", address: "+13125550100", access: .approved, requireMention: true, autoReply: true, quietStart: 0, quietEnd: 0)
        assert(RicoMessagePolicy.evaluate(recipient: recipient, initiatesConversation: true, message: "Hello") == .hold("First or proactive outbound messages require your approval."))
    }

    @Test func safeApprovedReplyCanPass() {
        let recipient = RicoRecipientPolicy(id: "1", contactID: "1", displayName: "Ana", address: "+13125550100", access: .approved, requireMention: true, autoReply: true, quietStart: 0, quietEnd: 0)
        assert(RicoMessagePolicy.evaluate(recipient: recipient, initiatesConversation: false, message: "Thanks for checking in") == .allow)
    }

    @Test("A queued message can be claimed for sending only once")
    func sendClaimIsSingleUse() {
        let id = UUID()
        let draft = RicoDraft(
            id: id,
            createdAt: Date(timeIntervalSince1970: 1),
            recipientName: "Person",
            address: "+15550000001",
            message: "Hello",
            state: .approved,
            reason: "Reviewed"
        )
        var queue = [draft]

        let first = RicoDraftQueue.claimForSending(&queue, id: id, paused: false, enforcementVerified: true)
        let second = RicoDraftQueue.claimForSending(&queue, id: id, paused: false, enforcementVerified: true)

        #expect(first?.state == .sending)
        #expect(second == nil)
        #expect(queue.first?.state == .sending)
    }

    @Test("Outbound drafts are globally single-flight through receipt revalidation")
    func outboundClaimsAreGloballySingleFlight() {
        let firstID = UUID()
        let secondID = UUID()
        var queue = [
            RicoDraft(
                id: firstID,
                createdAt: Date(timeIntervalSince1970: 1),
                recipientName: "First",
                address: "+15550000001",
                message: "First message",
                state: .approved,
                reason: "Reviewed"
            ),
            RicoDraft(
                id: secondID,
                createdAt: Date(timeIntervalSince1970: 2),
                recipientName: "Second",
                address: "+15550000002",
                message: "Second message",
                state: .approved,
                reason: "Reviewed"
            ),
        ]

        #expect(RicoDraftQueue.claimForSending(
            &queue,
            id: firstID,
            paused: false,
            enforcementVerified: true
        )?.id == firstID)
        #expect(RicoDraftQueue.claimForSending(
            &queue,
            id: secondID,
            paused: false,
            enforcementVerified: true
        ) == nil)
        #expect(queue[1].state == .approved)

        // A failure or cancellation publishes degraded health before the
        // first draft is released. Once released, the failed health gate—not
        // the absence of `.sending`—keeps the second draft inert.
        queue[0].state = .approved
        #expect(RicoDraftQueue.claimForSending(
            &queue,
            id: secondID,
            paused: true,
            enforcementVerified: false
        ) == nil)
        #expect(queue[1].state == .approved)

        // Only a completed first operation followed by a fresh verified
        // durable receipt may let the next explicit Send claim proceed.
        queue[0].state = .sent
        #expect(RicoDraftQueue.claimForSending(
            &queue,
            id: secondID,
            paused: false,
            enforcementVerified: true
        )?.id == secondID)
    }

    @Test("The Store-owned operation lease survives mutable queue actions")
    func outboundOperationLeaseProtectsMidAwaitDraft() {
        let firstID = UUID()
        let secondID = UUID()
        var lease = RicoOutboundOperationLease()
        var queue = [
            RicoDraft(
                id: firstID,
                createdAt: Date(timeIntervalSince1970: 1),
                recipientName: "First",
                address: "+15550000001",
                message: "First message",
                state: .approved,
                reason: "Reviewed"
            ),
            RicoDraft(
                id: secondID,
                createdAt: Date(timeIntervalSince1970: 2),
                recipientName: "Second",
                address: "+15550000002",
                message: "Second message",
                state: .approved,
                reason: "Reviewed"
            ),
        ]

        let firstLeaseClaim = lease.claim(firstID)
        let overlappingLeaseClaim = lease.claim(secondID)
        #expect(firstLeaseClaim)
        #expect(!overlappingLeaseClaim)
        #expect(RicoDraftQueue.claimForSending(
            &queue,
            id: firstID,
            paused: false,
            enforcementVerified: true
        ) != nil)
        #expect(!RicoDraftQueue.discard(&queue, id: firstID, protectedBy: lease))
        #expect(queue.contains(where: { $0.id == firstID && $0.state == .sending }))
        #expect(RicoDraftQueue.claimForSending(
            &queue,
            id: secondID,
            paused: false,
            enforcementVerified: true
        ) == nil)

        lease.release(secondID)
        #expect(lease.protects(firstID))
        lease.release(firstID)
        #expect(!lease.isHeld)
    }

    @Test("Interrupted persisted sends recover terminally under an unverified gate")
    func interruptedSendRecoveryIsFailClosed() {
        let interruptedID = UUID()
        let waitingID = UUID()
        var queue = [
            RicoDraft(
                id: interruptedID,
                createdAt: Date(timeIntervalSince1970: 1),
                recipientName: "Interrupted",
                address: "+15550000001",
                message: "Possibly sent",
                state: .sending,
                reason: "Sending"
            ),
            RicoDraft(
                id: waitingID,
                createdAt: Date(timeIntervalSince1970: 2),
                recipientName: "Waiting",
                address: "+15550000002",
                message: "Waiting",
                state: .approved,
                reason: "Reviewed"
            ),
        ]

        #expect(RicoDraftQueue.recoverInterruptedSends(&queue) == 1)
        #expect(queue[0].state == .blocked)
        #expect(queue[0].reason.contains("outcome is unknown"))
        #expect(RicoDraftQueue.claimForSending(
            &queue,
            id: waitingID,
            paused: true,
            enforcementVerified: false
        ) == nil)
        #expect(queue[1].state == .approved)
    }

    @Test("Paused messaging cannot claim an approved draft")
    func pausePreventsSendClaim() {
        let draft = RicoDraft(
            id: UUID(),
            createdAt: Date(timeIntervalSince1970: 1),
            recipientName: "Person",
            address: "+15550000001",
            message: "Hello",
            state: .approved,
            reason: "Reviewed"
        )
        var queue = [draft]
        #expect(RicoDraftQueue.claimForSending(&queue, id: draft.id, paused: true, enforcementVerified: true) == nil)
        #expect(RicoDraftQueue.claimForSending(&queue, id: draft.id, paused: false, enforcementVerified: false) == nil)
        #expect(queue.first?.state == .approved)
    }

    @Test("An opening message enters the queue only once after confirmation")
    func openingMessageConfirmationIsSingleUse() {
        let draft = RicoDraft(
            id: UUID(),
            createdAt: Date(timeIntervalSince1970: 1),
            recipientName: "Project group",
            address: "chat_id:42",
            message: "Good morning — here is the question I wanted to open with.",
            intent: .opening,
            state: .pending,
            reason: "Awaiting explicit review"
        )
        let review = RicoDraftReview(
            draft: draft,
            destination: "Project group",
            destinationDetail: "iMessage · chat_id:42",
            audience: .group(participantCount: 3)
        )
        var queue: [RicoDraft] = []

        // Staging and previewing are inert.
        #expect(queue.isEmpty)
        #expect(review.audienceSummary == "Group iMessage · 3 current participants · visible to everyone in the chat")

        #expect(RicoDraftQueue.confirm(review.draft, into: &queue))
        #expect(!RicoDraftQueue.confirm(review.draft, into: &queue))
        #expect(queue.count == 1)
        #expect(queue.first?.state == .approved)
        #expect(queue.first?.resolvedIntent == .opening)
    }

    @Test("Blocked drafts cannot be confirmed into the outbound queue")
    func blockedOpeningMessageCannotBeQueued() {
        let draft = RicoDraft(
            id: UUID(),
            createdAt: Date(timeIntervalSince1970: 1),
            recipientName: "Blocked destination",
            address: "+15550000002",
            message: "Hello",
            intent: .opening,
            state: .blocked,
            reason: "Blocked"
        )
        var queue: [RicoDraft] = []

        #expect(!RicoDraftQueue.confirm(draft, into: &queue))
        #expect(queue.isEmpty)
    }

    @Test("Legacy saved drafts decode as ordinary messages")
    func legacyDraftIntentIsBackwardCompatible() throws {
        let id = UUID()
        let json = """
        {
          "id": "\(id.uuidString)",
          "createdAt": 0,
          "recipientName": "Legacy recipient",
          "address": "+15550000003",
          "message": "Legacy message",
          "state": "approved",
          "reason": "Reviewed"
        }
        """

        let decoded = try JSONDecoder().decode(RicoDraft.self, from: Data(json.utf8))
        #expect(decoded.intent == nil)
        #expect(decoded.resolvedIntent == .message)
    }

    @Test("Direct-message review names the exact audience")
    func directMessageReviewAudience() {
        let draft = RicoDraft(
            id: UUID(),
            createdAt: Date(timeIntervalSince1970: 1),
            recipientName: "Janet",
            address: "+15550000004",
            message: "Hi Janet",
            intent: .opening,
            state: .pending,
            reason: "Awaiting explicit review"
        )
        let review = RicoDraftReview(
            draft: draft,
            destination: "Janet",
            destinationDetail: "+15550000004",
            audience: .person
        )

        #expect(review.audienceSummary == "Direct iMessage to this exact destination")
    }

    @Test("Status tone never marks errors or in-progress verification as success")
    func statusToneIsFailSafe() {
        #expect(RicoStatusTone.classify("Permission denied") == .warning)
        #expect(RicoStatusTone.classify("Gateway iMessage not ready") == .warning)
        #expect(RicoStatusTone.classify("Gateway iMessage delivery degraded") == .warning)
        #expect(RicoStatusTone.classify("Saved in guard; verifying OpenClaw policy…") == .working)
        #expect(RicoStatusTone.classify("Recipient policy applied and verified") == .success)
        #expect(RicoStatusTone.classify("Informational note") == .neutral)
    }

    @Test("Structured probe separates transport operability from delivery confirmation")
    func iMessageProbeReadiness() throws {
        #expect(IMessageCommand.probeArguments == [
            "channels", "status", "--probe", "--channel", "imessage",
            "--json", "--timeout", "20000",
        ])
        let verified = try imessageProbeJSON(
            deliveryState: "verified",
            reason: "successful_send_receipt",
            observedAt: 1_786_846_000_000
        )
        #expect(IMessageCommand.probeReportsReady(verified))
        let verifiedReadiness = IMessageCommand.probeReadiness(verified)
        #expect(verifiedReadiness == .verifiedDelivery)
        #expect(verifiedReadiness.transportOperational)
        #expect(verifiedReadiness.deliveryVerified)
        let verifiedWithEmptyDiagnostics = try imessageProbeJSON(
            deliveryState: "verified",
            reason: "successful_send_receipt",
            observedAt: 1_786_846_000_000,
            lastError: "",
            healthState: "   "
        )
        #expect(IMessageCommand.probeReadiness(verifiedWithEmptyDiagnostics) == .verifiedDelivery)

        let degraded = try imessageProbeJSON(
            deliveryState: "degraded",
            reason: "applescript_send_not_started_retry_exhausted",
            observedAt: 1_786_846_000_001,
            includeChats: true
        )
        let degradedReadiness = IMessageCommand.probeReadiness(degraded)
        #expect(!IMessageCommand.probeReportsReady(degraded))
        #expect(degradedReadiness == .deliveryDegraded)
        #expect(!degradedReadiness.transportOperational)
        #expect(!degradedReadiness.deliveryVerified)

        // A configured, running account with a successful native probe can
        // attempt its first governed send even though no historical receipt
        // exists yet. This breaks the otherwise circular first-send gate.
        let unverified = try imessageProbeJSON(
            deliveryState: "degraded",
            reason: "successful_send_receipt_not_observed",
            observedAt: 0,
            includeChats: true
        )
        let unverifiedReadiness = IMessageCommand.probeReadiness(unverified)
        #expect(unverifiedReadiness == .transportReady)
        #expect(unverifiedReadiness.transportOperational)
        #expect(!unverifiedReadiness.deliveryVerified)
        #expect(IMessageCommand.probeReportsReady(unverified))

        // A nonzero no-receipt marker may represent an interrupted in-flight
        // attempt. It cannot be silently reclassified as a known failed send;
        // the explicit degraded reasons below are the retry-safe states.
        let pendingAttempt = try imessageProbeJSON(
            deliveryState: "degraded",
            reason: "successful_send_receipt_not_observed",
            observedAt: 1,
            includeChats: true
        )
        #expect(IMessageCommand.probeReadiness(pendingAttempt) == .unavailable)
        #expect(!IMessageCommand.probeReadiness(pendingAttempt).transportOperational)

        let missingReceipt = try imessageProbeJSON(
            deliveryState: nil,
            reason: nil,
            observedAt: nil,
            includeChats: true
        )
        let missingReadiness = IMessageCommand.probeReadiness(missingReceipt)
        #expect(missingReadiness == .unavailable)
        #expect(!missingReadiness.transportOperational)
        #expect(!missingReadiness.deliveryVerified)

        let zeroTimestamp = try imessageProbeJSON(
            deliveryState: "verified",
            reason: "successful_send_receipt",
            observedAt: 0
        )
        #expect(IMessageCommand.probeReadiness(zeroTimestamp) == .unavailable)
        let booleanVersion = try imessageProbeJSON(
            deliveryState: "verified",
            reason: "successful_send_receipt",
            observedAt: 1_786_846_000_002,
            healthVersion: true
        )
        #expect(IMessageCommand.probeReadiness(booleanVersion) == .unavailable)
        let ambiguous = try imessageProbeJSON(
            deliveryState: "verified",
            reason: "successful_send_receipt",
            observedAt: 1_786_846_000_003,
            duplicateDefaultAccount: true
        )
        #expect(IMessageCommand.probeReadiness(ambiguous) == .unavailable)
        let malformedPartial = try imessageProbeJSON(
            deliveryState: "verified",
            reason: "successful_send_receipt",
            observedAt: 1_786_846_000_004,
            partial: "false"
        )
        #expect(IMessageCommand.probeReadiness(malformedPartial) == .unavailable)
        for malformedPartialValue: Any in [0, 1, ["partial": false], [false]] {
            let malformedNumericOrContainerPartial = try imessageProbeJSON(
                deliveryState: "verified",
                reason: "successful_send_receipt",
                observedAt: 1_786_846_000_005,
                partial: malformedPartialValue
            )
            #expect(IMessageCommand.probeReadiness(malformedNumericOrContainerPartial) == .unavailable)
        }

        for malformedFlag: Any in [1, 0, "true", ["value": true], [true]] {
            let malformedEnabled = try imessageProbeJSON(
                deliveryState: "verified",
                reason: "successful_send_receipt",
                observedAt: 1_786_846_000_006,
                enabled: malformedFlag
            )
            #expect(IMessageCommand.probeReadiness(malformedEnabled) == .unavailable)
            let malformedConfigured = try imessageProbeJSON(
                deliveryState: "verified",
                reason: "successful_send_receipt",
                observedAt: 1_786_846_000_007,
                configured: malformedFlag
            )
            #expect(IMessageCommand.probeReadiness(malformedConfigured) == .unavailable)
            let malformedRunning = try imessageProbeJSON(
                deliveryState: "verified",
                reason: "successful_send_receipt",
                observedAt: 1_786_846_000_008,
                running: malformedFlag
            )
            #expect(IMessageCommand.probeReadiness(malformedRunning) == .unavailable)
            let malformedProbe = try imessageProbeJSON(
                deliveryState: "verified",
                reason: "successful_send_receipt",
                observedAt: 1_786_846_000_009,
                probeOK: malformedFlag
            )
            #expect(IMessageCommand.probeReadiness(malformedProbe) == .unavailable)
        }

        for malformedDiagnostic: Any in [1, ["error": "none"], ["none"]] {
            let malformedLastError = try imessageProbeJSON(
                deliveryState: "verified",
                reason: "successful_send_receipt",
                observedAt: 1_786_846_000_010,
                lastError: malformedDiagnostic
            )
            #expect(IMessageCommand.probeReadiness(malformedLastError) == .unavailable)
            let malformedHealthState = try imessageProbeJSON(
                deliveryState: "verified",
                reason: "successful_send_receipt",
                observedAt: 1_786_846_000_011,
                healthState: malformedDiagnostic
            )
            #expect(IMessageCommand.probeReadiness(malformedHealthState) == .unavailable)
        }

        // Human-readable status and legacy success phrases are not an
        // attested API and therefore fail closed.
        #expect(!IMessageCommand.probeReportsReady("""
        Gateway reachable.
        - iMessage default: enabled, configured, running, works
        """))
        #expect(!IMessageCommand.probeReportsReady("Gateway not reachable: unknown channel: imessage"))
        #expect(!IMessageCommand.probeReportsReady("unknown channel: imessage"))
        #expect(!IMessageCommand.probeReportsReady("iMessage default: not configured"))
    }

    @Test("Send success refreshes delivery telemetry and failure quarantines while preserving review")
    func sendResultUpdatesDeliveryGateImmediately() throws {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: repository.appendingPathComponent("Sources/OpenClawStudio/RicoCommunicationsView.swift"),
            encoding: .utf8
        )
        let sendStart = try #require(source.range(of: "    func send(_ draft: RicoDraft) async"))
        let sendEnd = try #require(source.range(
            of: "\n    var outboundAdmissionVerified",
            range: sendStart.upperBound..<source.endIndex
        ))
        let send = String(source[sendStart.lowerBound..<sendEnd.lowerBound])
        let gatewaySend = try #require(send.range(of: "try await IMessageCommand.send("))
        let postSendProbe = try #require(send.range(
            of: "postSendReadiness = IMessageCommand.probeReadiness(try await IMessageCommand.probe())",
            range: gatewaySend.upperBound..<send.endIndex
        ))
        let publishSuccess = try #require(send.range(
            of: "_ = observeIMessageProbe(postSendReadiness, generation: postSendGeneration)",
            range: postSendProbe.upperBound..<send.endIndex
        ))
        let releaseSuccess = try #require(send.range(
            of: "drafts[index].state = .sent",
            range: publishSuccess.upperBound..<send.endIndex
        ))
        let failureCatch = try #require(send.range(of: "} catch {", range: releaseSuccess.upperBound..<send.endIndex))
        let publishFailure = try #require(send.range(
            of: "observeIMessageProbe(.deliveryDegraded)",
            range: failureCatch.upperBound..<send.endIndex
        ))
        let retryDraft = try #require(send.range(
            of: "drafts[index].state = .approved",
            range: publishFailure.upperBound..<send.endIndex
        ))
        #expect(gatewaySend.lowerBound < postSendProbe.lowerBound)
        #expect(postSendProbe.lowerBound < publishSuccess.lowerBound)
        #expect(publishSuccess.lowerBound < releaseSuccess.lowerBound)
        #expect(failureCatch.lowerBound < publishFailure.lowerBound)
        #expect(publishFailure.lowerBound < retryDraft.lowerBound)

        let singleFlightClaim = try #require(source.range(of: "!drafts.contains(where: { $0.state == .sending })"))
        let sendButtonGate = try #require(source.range(of: ".disabled(!store.outboundAdmissionVerified || store.outboundSendInFlight)"))
        #expect(singleFlightClaim.lowerBound < sendButtonGate.lowerBound)
        let operationLease = try #require(send.range(of: "outboundOperationLease.claim(draft.id)"))
        #expect(operationLease.lowerBound < gatewaySend.lowerBound)
        #expect(send.contains("outboundOperationLease.release(draft.id)"))
        #expect(source.contains(".disabled(store.draftIsInFlight(draft.id))"))
        #expect(source.contains("RicoDraftQueue.recoverInterruptedSends(&drafts)"))
        #expect(source.contains("outboundTransportOperational"))
        #expect(!send.contains("!outboundDeliveryVerified"))
    }

    private func imessageProbeJSON(
        deliveryState: String?,
        reason: String?,
        observedAt: NSNumber?,
        includeChats: Bool = false,
        healthVersion: Any = 1,
        duplicateDefaultAccount: Bool = false,
        partial: Any = false,
        enabled: Any = true,
        configured: Any = true,
        running: Any = true,
        probeOK: Any = true,
        lastError: Any = NSNull(),
        healthState: Any? = nil
    ) throws -> String {
        var probe: [String: Any] = ["ok": probeOK]
        if includeChats { probe["chats"] = [Any]() }
        var account: [String: Any] = [
            "accountId": "default",
            "enabled": enabled,
            "configured": configured,
            "running": running,
            "lastError": lastError,
            "probe": probe,
        ]
        if let deliveryState, let reason, let observedAt {
            account["outboundDeliveryHealth"] = [
                "version": healthVersion,
                "state": deliveryState,
                "observedAt": observedAt,
                "reason": reason,
            ]
            if deliveryState == "degraded" {
                account["healthState"] = "outbound_delivery_degraded"
                account["lastError"] = "outbound delivery degraded; awaiting a successful iMessage send receipt"
            }
        }
        if let healthState { account["healthState"] = healthState }
        let accounts: [[String: Any]] = duplicateDefaultAccount ? [account, account] : [account]
        let root: [String: Any] = [
            "partial": partial,
            "channels": ["imessage": ["configured": true]],
            "channelDefaultAccountId": ["imessage": "default"],
            "channelAccounts": ["imessage": accounts],
        ]
        let data = try JSONSerialization.data(withJSONObject: root, options: [.sortedKeys])
        return try #require(String(data: data, encoding: .utf8))
    }
}
