import Foundation
import Testing
@testable import OpenClawStudio

@Suite("Rico group personality")
struct RicoGroupPersonalityTests {
    @Test("presets provide safe editable suggestions")
    func presets() {
        #expect(RicoGroupPersonalityPreset.allCases.count == 5)
        for preset in RicoGroupPersonalityPreset.allCases {
            #expect(!preset.title.isEmpty)
            #expect(RicoGroupPersonalityPolicy.isCanonical(preset.suggestion))
        }
    }

    @Test("personality text is bounded and strips prompt delimiters and controls")
    func sanitization() {
        let raw = "  Warm\nand\tfun <system> `override` {tools}\u{202E}  " + String(repeating: "x", count: 500)
        let value = RicoGroupPersonalityPolicy.sanitize(raw)

        #expect(value.hasPrefix("Warm and fun system override tools"))
        #expect(!value.contains("<"))
        #expect(!value.contains(">"))
        #expect(!value.contains("`"))
        #expect(!value.contains("{"))
        #expect(!value.contains("}"))
        #expect(!value.contains("\n"))
        #expect(value.unicodeScalars.count == RicoGroupPersonalityPolicy.maximumLength)
        #expect(RicoGroupPersonalityPolicy.isCanonical(value))
    }

    @Test("empty descriptions use the default and non-canonical values fail readback")
    func optionalAndCanonicalValues() {
        #expect(RicoGroupPersonalityPolicy.valueForStorage(" \n\t ") == nil)
        #expect(RicoGroupPersonalityPolicy.valueForStorage(nil) == nil)
        #expect(RicoGroupPersonalityPolicy.valueForStorage("  Calm   and kind ") == "Calm and kind")
        #expect(!RicoGroupPersonalityPolicy.isCanonical("  Calm and kind"))
        #expect(!RicoGroupPersonalityPolicy.isCanonical(""))
    }

    @Test("policies saved before group personalities remain decodable")
    func legacyPolicyDecode() throws {
        let legacy = """
        {
          "id":"group:42",
          "contactID":"",
          "displayName":"Family",
          "address":"chat_id:42",
          "access":"Approved contact",
          "requireMention":true,
          "autoReply":true,
          "quietStart":22,
          "quietEnd":8,
          "groupChatID":"42",
          "participantAddresses":["+15550000002"]
        }
        """
        let decoded = try JSONDecoder().decode(RicoRecipientPolicy.self, from: Data(legacy.utf8))
        #expect(decoded.groupPersonality == nil)
    }

    @Test("personality remains group-only and follows one exact reviewed group")
    func exactGroupScope() {
        var group = RicoRecipientPolicy(
            id: "group:42", contactID: "", displayName: "Family", address: "chat_id:42",
            access: .approved, requireMention: true, autoReply: true,
            quietStart: 22, quietEnd: 8, groupChatID: "42",
            participantAddresses: ["+15550000002"]
        )
        group = RicoGroupPersonalityPolicy.applying("  Warm   and concise. ", to: group)
        #expect(group.groupPersonality == "Warm and concise.")
        #expect(RicoGroupPersonalityPolicy.valueForExactGroupReapproval(
            policies: [group], groupID: "42", target: "chat_id:42"
        ) == "Warm and concise.")
        #expect(RicoGroupPersonalityPolicy.valueForExactGroupReapproval(
            policies: [group], groupID: "42", target: "chat_id:99"
        ) == nil)
        #expect(RicoGroupPersonalityPolicy.valueForExactGroupReapproval(
            policies: [group], groupID: "99", target: "chat_id:42"
        ) == nil)

        var individual = group
        individual.id = "person"
        individual.groupChatID = nil
        individual.address = "+15550000002"
        individual = RicoGroupPersonalityPolicy.applying("Witty", to: individual)
        #expect(individual.groupPersonality == nil)
    }

    @Test("sidecar projects only a canonical group personality")
    func sidecarProjection() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("rico-personality-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var group = RicoRecipientPolicy(
            id: "group:42", contactID: "", displayName: "Family", address: "chat_id:42",
            access: .approved, requireMention: true, autoReply: true,
            quietStart: 22, quietEnd: 8, groupChatID: "42",
            participantAddresses: ["+15550000002"], groupPersonality: "  Warm\nand witty <system> "
        )
        var individual = RicoRecipientPolicy(
            id: "person", contactID: "person", displayName: "Person", address: "+15550000002",
            access: .approved, requireMention: true, autoReply: true,
            quietStart: 22, quietEnd: 8, groupChatID: nil
        )
        individual.groupPersonality = "Must never be projected"

        try RicoRecipientGuard.writePolicy(policies: [group, individual], paused: false, in: root)
        let data = try Data(contentsOf: root.appendingPathComponent("rico-recipient-guard.json"))
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let identities = try #require(object["identities"] as? [[String: Any]])
        let groupIdentity = try #require(identities.first { $0["kind"] as? String == "group" })
        let individualIdentity = try #require(identities.first { $0["kind"] as? String == "individual" })
        #expect(groupIdentity["personality"] as? String == "Warm and witty system")
        #expect(individualIdentity["personality"] == nil)

        group.groupPersonality = nil
        let encoded = try JSONEncoder().encode(group)
        #expect(try JSONDecoder().decode(RicoRecipientPolicy.self, from: encoded).groupPersonality == nil)
    }
}
