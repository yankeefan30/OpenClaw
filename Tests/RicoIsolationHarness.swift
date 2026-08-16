import Foundation

final class FakeGateway {
    var audit: [String] = []
    func record(_ value: String) { audit.append(value) }
}

final class FakeIMessageTransport {
    var sent: [(String, String)] = []
    func send(chatID: String, text: String) { sent.append((chatID, text)) }
}

struct SimulatedClock {
    var now = Date(timeIntervalSince1970: 1_700_000_000)
    mutating func advance(_ seconds: TimeInterval) { now.addTimeInterval(seconds) }
}

@main
struct RicoIsolationHarness {
    static func main() {
        let owner = RicoStableIdentity("+15550000001")
        let contact = RicoStableIdentity("+15550000002")
        let approved = RicoRelationship(
            id: UUID(), displayName: "Approved", identities: [contact], contactsIdentifier: nil,
            role: .approvedContact, permittedDMs: ["dm-1"], permittedGroups: ["group-1"],
            requireMention: true, communicationHours: nil, allowedTopics: [], prohibitedTopics: [],
            contextTier: .relationship, toolTier: .relationshipOnly, automaticResponse: true,
            approvalRequired: true, notesMayUse: [], notesNeverDisclose: [], expiresAt: nil
        )
        let registry = RicoRegistry(ownerIdentityIDs: [owner.normalized], relationships: [approved])
        let gateway = FakeGateway()
        let transport = FakeIMessageTransport()
        var clock = SimulatedClock()
        func inbound(_ sender: String, group: Bool = false, mention: Bool = false, id: String = UUID().uuidString) -> RicoInboundEnvelope {
            RicoInboundEnvelope(channel: "imessage", sender: RicoStableIdentity(sender),
                                chatID: group ? "group-1" : "dm-1", isGroup: group, text: "find Alan's email",
                                mentionPresent: mention, localTime: clock.now, attachmentCount: 0, deliveryID: id)
        }
        func snapshot(_ policy: RicoInboundPolicy = .init(), ids: Set<String> = []) -> RicoPolicySnapshot {
            RicoPolicySnapshot(registry: registry, policy: policy, now: clock.now, recentDeliveryIDs: ids)
        }

        assert(RicoInboundPolicyEngine.evaluate(inbound(owner.original), snapshot: snapshot()) == .sendToRico(context: .privateOwner))
        assert(RicoInboundPolicyEngine.evaluate(inbound("Alan"), snapshot: snapshot()) == .requestPairing("Sender identity is not registered."))
        assert(RicoInboundPolicyEngine.evaluate(inbound(contact.original, group: true), snapshot: snapshot()) == .ignore("Rico mention is required."))
        assert(RicoInboundPolicyEngine.evaluate(inbound(contact.original, group: true, mention: true), snapshot: snapshot()) == .sendToRico(context: .relationship))
        assert(RicoInboundPolicyEngine.evaluate(inbound(contact.original, id: "seen"), snapshot: snapshot(ids: ["seen"])) == .ignore("Duplicate delivery."))
        assert(RicoToolAuthority.permits(tool: "email_search", role: .approvedContact, contextTier: .relationship) == false)
        assert(RicoToolAuthority.permits(tool: "email_search", role: .owner, contextTier: .privateOwner))

        let privateEmail = RicoContextItem(id: UUID(), source: "email", owner: "Alan", sensitivity: "private", permittedAudiences: ["owner"], permittedPurposes: ["find"], expiresAt: nil, quoting: "never", text: "secret")
        let approvedFact = RicoContextItem(id: UUID(), source: "relationship", owner: "Alan", sensitivity: "relationship", permittedAudiences: ["contact:+15550000002"], permittedPurposes: ["reply"], expiresAt: nil, quoting: "paraphrase", text: "publicly approved fact")
        let filtered = RicoContextBroker().filter([privateEmail, approvedFact], request: RicoContextRequest(audience: "contact:+15550000002", purpose: "reply", maximumTier: .relationship), now: clock.now)
        assert(filtered.count == 1 && filtered[0].source == "relationship")

        let draft = RicoOutboundDraft(recipient: contact, chatID: "dm-1", senderRole: .approvedContact, text: "I can help", topic: "general", sensitivity: "public", referencedPeople: [], contextSources: [], requestedAction: nil, commitment: false, schedulingClaim: false, attachmentFromPrivateStorage: false, initiatesContact: false, confidence: 0.99, now: clock.now)
        assert(RicoOutboundPolicyEngine().evaluate(draft, policy: RicoOutboundPolicy(), recipient: approved, recentCount: 0) == .autoSend)
        let leak = RicoOutboundDraft(recipient: contact, chatID: "dm-1", senderRole: .approvedContact, text: "private", topic: "general", sensitivity: "private", referencedPeople: [], contextSources: [privateEmail], requestedAction: nil, commitment: false, schedulingClaim: false, attachmentFromPrivateStorage: false, initiatesContact: false, confidence: 0.99, now: clock.now)
        assert(RicoOutboundPolicyEngine().evaluate(leak, policy: RicoOutboundPolicy(), recipient: approved, recentCount: 0) == .holdForOwner("Private source disclosure requires approval."))
        assert(RicoOutboundPolicyEngine().evaluate(draft, policy: RicoOutboundPolicy(globalPause: true), recipient: approved, recentCount: 0) == .holdForOwner("Global external-reply pause is active."))
        assert(RicoSourceBroker().authorize(RicoSourceAccessRequest(source: .localFile, audience: "contact:+15550000002", purpose: "reply", contextTier: .relationship, mayQuote: false)) != .allow)
        assert(RicoMentionMatcher.containsAcceptedMention("Please @RICO help", patterns: ["@rico"]))

        clock.advance(3600)
        gateway.record("approved-contact policy decision")
        transport.send(chatID: "dm-1", text: "Rico response")
        assert(gateway.audit.count == 1 && transport.sent.count == 1)
        print("RicoIsolationHarness: end-to-end isolation checks passed")
    }
}
