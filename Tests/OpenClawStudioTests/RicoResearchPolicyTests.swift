import Foundation
import Testing
@testable import OpenClawStudio

@Suite("Rico research and citation governance")
struct RicoResearchPolicyTests {
    @Test("only verified unique capabilities can be used")
    func capabilityGate() {
        let ready = RicoResearchCapability(
            source: .outlook,
            state: .healthy,
            capabilityReference: "mcp:outlook.read",
            verifiedAt: Date()
        )
        #expect(RicoResearchPolicy.authorize(requestedSources: [.outlook], capabilities: [ready]) == .allow)

        let unavailable = RicoResearchCapability(source: .slack, state: .configured, capabilityReference: "mcp:slack.read", verifiedAt: nil)
        guard case .deny(let failures) = RicoResearchPolicy.authorize(requestedSources: [.slack], capabilities: [unavailable]) else {
            Issue.record("Configured but unverified source must fail closed")
            return
        }
        #expect(failures == ["Slack is not backed by one verified capability."])

        #expect(RicoResearchPolicy.authorize(requestedSources: [.outlook], capabilities: [ready, ready]) != .allow)
    }

    @Test("secret-like capability references are rejected")
    func referenceRedaction() {
        #expect(RicoResearchCapability.safeReference("mcp:google-drive.read"))
        #expect(!RicoResearchCapability.safeReference("token=abc123"))
        #expect(!RicoResearchCapability.safeReference("Bearer hidden"))
    }

    @Test("private repositories and models cannot become citations")
    func citationClasses() {
        for source in RicoResearchSource.allCases {
            let expected = [RicoResearchSource.publicWeb, .legalCases, .magazines, .newspapers, .books].contains(source)
            #expect(source.mayBeCited == expected)
        }
    }

    @Test("outbound citation must match citable evidence exactly")
    func exactEvidence() {
        let evidenceID = UUID()
        let link = URL(string: "https://example.org/case")!
        let evidence = RicoResearchEvidence(
            id: evidenceID,
            source: .legalCases,
            use: .citableAuthority,
            title: "Example v. Example",
            publicURL: link,
            locatorDigest: String(repeating: "a", count: 64),
            collectedAt: Date()
        )
        let citation = RicoAnswerCitation(id: UUID(), evidenceID: evidenceID, label: "Example v. Example", hyperlink: link)
        #expect(RicoResearchPolicy.validateOutboundCitations([citation], evidence: [evidence]) == .allow)
    }

    @Test("a private source is blocked even when given a public-looking URL")
    func privateCitationBlocked() {
        let evidenceID = UUID()
        let link = URL(string: "https://mail.example.com/message/1")!
        let evidence = RicoResearchEvidence(
            id: evidenceID,
            source: .outlook,
            use: .citableAuthority,
            title: "Private email",
            publicURL: link,
            locatorDigest: String(repeating: "b", count: 64),
            collectedAt: Date()
        )
        let citation = RicoAnswerCitation(id: UUID(), evidenceID: evidenceID, label: "Private email", hyperlink: link)
        guard case .deny = RicoResearchPolicy.validateOutboundCitations([citation], evidence: [evidence]) else {
            Issue.record("Private evidence must never be citable")
            return
        }
    }

    @Test("web citation requires credential-free HTTPS")
    func safeLinks() {
        let evidence = RicoResearchEvidence(
            id: UUID(),
            source: .publicWeb,
            use: .citableAuthority,
            title: "Unsafe",
            publicURL: URL(string: "https://user:secret@example.org/story")!,
            locatorDigest: String(repeating: "c", count: 64),
            collectedAt: Date()
        )
        #expect(!evidence.validationErrors.isEmpty)
    }

    @Test("private conversation and recording provenance is never disclosable")
    func privateProvenance() {
        for text in [
            "I found that in Limitless.",
            "According to your PLAUD recording, the deadline is Friday.",
            "Based on our previous conversation, you prefer Tuesday.",
            "You mentioned earlier that this was confidential.",
            "I reviewed your meeting transcript.",
            "In our chat last month, you preferred Tuesday.",
            "As we discussed, the deadline is Friday.",
            "When we last spoke, you preferred Tuesday.",
            "Our earlier conversation was useful.",
            "We talked about the deadline.",
            "You told me the deadline was Friday.",
            "Earlier, you said the deadline was Friday.",
            "I remember that you wanted a concise answer.",
            "I have access to your call recordings.",
            "I reviewed our previous conversation.",
            "Notes from our meeting identify the owner.",
            "Your Slack messages show that the deadline changed.",
            "I checked Outlook before answering.",
            "I searched your email for the date.",
            "I found this in Alan's Outlook mailbox.",
            "I found this in L\u{200B}imitless.",
            "P L A U D supplied the detail."
        ] {
            #expect(RicoPrivateProvenanceGuard.disclosureReason(in: text) != nil)
        }
    }

    @Test("ordinary meeting and verified public-source language remains allowed")
    func privateProvenanceNearMisses() {
        for text in [
            "The public court opinion sets out the governing standard.",
            "The published court transcript explains the judge's ruling.",
            "Please ask Janet to arrange a meeting for Tuesday.",
            "A conversation is sometimes the fastest way to resolve a misunderstanding.",
            "We should talk about the public ruling.",
            "Your exchange rate calculation is correct.",
            "Your discussion question is well framed.",
            "Apple Mail is a registered trademark.",
            "The New York Times article supports this conclusion: https://www.nytimes.com/example"
        ] {
            #expect(RicoPrivateProvenanceGuard.disclosureReason(in: text) == nil)
        }
    }
}
