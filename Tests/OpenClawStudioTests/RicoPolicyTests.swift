import Foundation
import Testing
@testable import OpenClawStudio

protocol FakeRicoGateway {
    func record(_ event: RicoAuditEvent)
    func auditEvents() -> [RicoAuditEvent]
}

final class InMemoryRicoGateway: FakeRicoGateway {
    private var events: [RicoAuditEvent] = []
    func record(_ event: RicoAuditEvent) { events.append(event) }
    func auditEvents() -> [RicoAuditEvent] { events }
}

final class FakeIMessageTransport {
    var delivered: [(chatID: String, text: String)] = []
    func send(chatID: String, text: String) { delivered.append((chatID, text)) }
}

final class FakeContextBroker {
    let broker = RicoContextBroker()
    func retrieve(_ items: [RicoContextItem], audience: String, purpose: String, tier: RicoContextTier, now: Date) -> [RicoContextItem] {
        broker.filter(items, request: RicoContextRequest(audience: audience, purpose: purpose, maximumTier: tier), now: now)
    }
}

struct SimulatedRicoClock {
    var now: Date
    mutating func advance(_ seconds: TimeInterval) { now.addTimeInterval(seconds) }
}

@Suite("Rico isolation policy")
struct RicoPolicyTests {
    private func registry() -> RicoRegistry {
        RicoRegistry(ownerIdentityIDs: [RicoStableIdentity("+15550000001").normalized], relationships: [
            RicoRelationship(id: UUID(), displayName: "Approved", identities: [RicoStableIdentity("+15550000002")],
                             contactsIdentifier: nil, role: .approvedContact, permittedDMs: ["dm-1"],
                             permittedGroups: ["group-1"], requireMention: true, communicationHours: nil,
                             allowedTopics: [], prohibitedTopics: [], contextTier: .relationship,
                             toolTier: .relationshipOnly, automaticResponse: true, approvalRequired: true,
                             notesMayUse: ["coffee"], notesNeverDisclose: ["private"], expiresAt: nil),
            RicoRelationship(id: UUID(), displayName: "Blocked", identities: [RicoStableIdentity("+15550000003")],
                             contactsIdentifier: nil, role: .blocked, permittedDMs: [], permittedGroups: [],
                             requireMention: false, communicationHours: nil, allowedTopics: [], prohibitedTopics: [],
                             contextTier: .none, toolTier: .none, automaticResponse: false, approvalRequired: true,
                             notesMayUse: [], notesNeverDisclose: [], expiresAt: nil)
        ])
    }
    private func envelope(sender: String, group: Bool = false, mention: Bool = false, id: String = UUID().uuidString) -> RicoInboundEnvelope {
        RicoInboundEnvelope(channel: "imessage", sender: RicoStableIdentity(sender), chatID: group ? "group-1" : "dm-1",
                            isGroup: group, text: "hello", mentionPresent: mention, localTime: Date(),
                            attachmentCount: 0, deliveryID: id)
    }

    @Test func ownerAndContactIsolation() {
        let snapshot = RicoPolicySnapshot(registry: registry(), policy: .init(), now: Date())
        assert(RicoInboundPolicyEngine.evaluate(envelope(sender: "+15550000001"), snapshot: snapshot) == .sendToRico(context: .privateOwner))
        assert(RicoInboundPolicyEngine.evaluate(envelope(sender: "+15550000002", group: true, mention: true), snapshot: snapshot) == .sendToRico(context: .relationship))
    }
    @Test func spoofedNameAndUnknownAreNotOwner() {
        let snapshot = RicoPolicySnapshot(registry: registry(), policy: .init(), now: Date())
        assert(RicoInboundPolicyEngine.evaluate(envelope(sender: "Alan"), snapshot: snapshot) == .requestPairing("Sender identity is not registered."))
    }
    @Test func groupMentionAndBlockedSender() {
        let snapshot = RicoPolicySnapshot(registry: registry(), policy: .init(), now: Date())
        assert(RicoInboundPolicyEngine.evaluate(envelope(sender: "+15550000002", group: true), snapshot: snapshot) == .ignore("Rico mention is required."))
        assert(RicoInboundPolicyEngine.evaluate(envelope(sender: "+15550000003"), snapshot: snapshot) == .block("Sender is blocked."))
    }
    @Test func privateContextNeverCrossesAudience() {
        let items = [
            RicoContextItem(id: UUID(), source: "email", owner: "Alan", sensitivity: "private", permittedAudiences: ["owner"], permittedPurposes: ["find"], expiresAt: nil, quoting: "never", text: "secret"),
            RicoContextItem(id: UUID(), source: "approved", owner: "Alan", sensitivity: "relationship", permittedAudiences: ["contact:+15550000002"], permittedPurposes: ["reply"], expiresAt: nil, quoting: "paraphrase", text: "coffee")
        ]
        let broker = FakeContextBroker()
        assert(broker.retrieve(items, audience: "contact:+15550000002", purpose: "reply", tier: .relationship, now: Date()).count == 1)
    }
}
