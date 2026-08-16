import Foundation
import Testing
@testable import OpenClawStudio

@Suite("OpenClaw Studio regression suite")
struct RegressionTests {
    @Test("Contact names resolve without guessing")
    func contactResolution() {
        let rows = [
            LocalContact(id: "1", name: "Ana García", phones: ["(312) 555-0100"], emails: []),
            LocalContact(id: "2", name: "Ana Grant", phones: ["3125550101"], emails: [])
        ]
        #expect(ContactResolver.normalizedPhone(rows[0].phones[0]) == "+13125550100")
        guard case .unique(let contact) = ContactResolver.resolve("ana garcia", in: rows) else {
            Issue.record("Expected a unique diacritic-insensitive match")
            return
        }
        #expect(contact.id == "1")
        guard case .ambiguous = ContactResolver.resolve("ana", in: rows) else {
            Issue.record("Prefix collisions must remain ambiguous")
            return
        }
    }

    @Test("Contacts repair remains app-scoped and uses the macOS service token")
    func contactsRepairArguments() {
        #expect(ContactsPermissionRepair.arguments(bundleIdentifier: "ai.openclaw.studio") == [
            "reset", "AddressBook", "ai.openclaw.studio"
        ])
        #expect(ContactsAuthorizationPolicy.canRead(.authorized))
        #expect(!ContactsAuthorizationPolicy.canRead(.denied))
        #expect(!ContactsAuthorizationPolicy.canRead(.restricted))
    }

    @Test("Unknown and blocked recipients fail closed")
    func recipientPolicyFailsClosed() {
        #expect(RicoMessagePolicy.evaluate(recipient: nil, initiatesConversation: false, message: "hello") == .hold("Add this person to Rico's approved contacts first."))
        let blocked = RicoRecipientPolicy(id: "b", contactID: "b", displayName: "Blocked", address: "+12125550100", access: .blocked, requireMention: true, autoReply: false, quietStart: 0, quietEnd: 0)
        #expect(RicoMessagePolicy.evaluate(recipient: blocked, initiatesConversation: false, message: "hello") == .block("This contact is blocked."))
    }

    @Test("Group directory rows preserve stable chat targets")
    func groupTargets() {
        let row: [String: Any] = ["chat_id": 42, "display_name": "Family", "is_group": true]
        let group = IMessageChat(directory: row)
        #expect(group?.id == "42")
        #expect(group?.target == "chat_id:42")
        #expect(group?.displayName == "Family")
    }

    @Test("Unnamed groups are labeled with Contacts names, never chat IDs")
    func friendlyGroupNames() throws {
        let row: [String: Any] = [
            "chat_id": 42,
            "participants": ["+12125550101", "+12125550102"],
            "is_group": true,
        ]
        let group = try #require(IMessageChat(directory: row))
        let contacts = [
            LocalContact(id: "1", name: "Ana", phones: ["2125550101"], emails: []),
            LocalContact(id: "2", name: "Janet", phones: ["2125550102"], emails: []),
        ]
        let name = RicoGroupDirectoryNaming.friendlyName(for: group, contacts: contacts)
        #expect(name == "Ana & Janet")
        #expect(!name.contains("42"))
        #expect(RicoGroupDirectoryNaming.participantPreview(for: group, contacts: contacts) == "Ana, Janet")
    }

    @Test("Transcript parser handles text blocks")
    func transcriptBlocks() {
        let message = TranscriptItem([
            "id": "m1", "role": "assistant",
            "content": [["type": "text", "text": "First"], ["type": "text", "text": "Second"]]
        ])
        #expect(message?.id == "m1")
        #expect(message?.text == "First\nSecond")
    }

    @Test("Rico mention matching is case insensitive")
    func mentionMatching() {
        #expect(RicoMentionMatcher.containsAcceptedMention("Hey @RiCo, can you help?", patterns: ["@rico"]))
        #expect(!RicoMentionMatcher.containsAcceptedMention("Hey there", patterns: ["@rico"]))
    }
}
