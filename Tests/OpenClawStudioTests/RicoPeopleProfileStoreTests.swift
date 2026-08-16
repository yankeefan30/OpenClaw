import Foundation
import Testing
@testable import OpenClawStudio

@Suite("Rico people profile editor")
@MainActor
struct RicoPeopleProfileStoreTests {
    @Test("editor parser distinguishes background instructions and preferences")
    func parserScopes() {
        let values = RicoPeopleContextParser.parse("""
        background: Janet is Alan's executive assistant.
        instruction: Be direct about deadlines.
        preference: Use plain text.
        """)
        #expect(values.map(\.kind) == [.backgroundFact, .customInstruction, .communicationPreference])
        #expect(values.map(\.text) == [
            "Janet is Alan's executive assistant.",
            "Be direct about deadlines.",
            "Use plain text."
        ])
    }

    @Test("learning candidates cannot be reviewed under another principal")
    func exactReviewPrincipal() {
        let first = RicoPersonPrincipal(authenticatedHandle: "+15550000001")!
        let other = RicoPersonPrincipal(authenticatedHandle: "+15550000002")!
        let now = Date()
        let candidate = RicoPeopleContextEditor.proposeLearning(
            principal: first,
            kind: .backgroundFact,
            text: "Prefers concise updates.",
            conversationReference: "conversation-1",
            deliveryReference: "delivery-1",
            observedAt: now,
            proposedAt: now,
            confidence: 0.9
        )!
        var profile = RicoPersonContextProfile(
            id: UUID(), principal: other, displayName: "Other Person",
            reviewedItems: [], learningCandidates: [candidate],
            createdAt: now, updatedAt: now
        )
        #expect(RicoPeopleContextEditor.review(
            candidateID: candidate.id,
            approve: true,
            in: &profile,
            reviewedAt: now
        ) == nil)
        #expect(profile.reviewedItems.isEmpty)
    }

    @Test("owner editor never duplicates an approved conversation-derived note")
    func editorSeparatesLearnedNotes() {
        let now = Date()
        func item(_ text: String, source: RicoPersonContextSourceKind) -> RicoReviewedPersonContextItem {
            .init(
                id: UUID(),
                kind: .backgroundFact,
                text: text,
                provenance: .init(
                    sourceKind: source,
                    sourceReference: "reviewed-\(UUID().uuidString.lowercased())",
                    observedAt: now,
                    reviewedAt: now,
                    reviewedBy: "alan"
                ),
                expiresAt: nil
            )
        }
        let profile = RicoPersonContextProfile(
            id: UUID(),
            principal: RicoPersonPrincipal(authenticatedHandle: "+15550000001")!,
            displayName: "Example Person",
            reviewedItems: [
                item("Works in health care.", source: .ownerAuthored),
                item("Prefers Tuesday calls.", source: .ownerReviewedConversation),
            ],
            learningCandidates: [],
            createdAt: now,
            updatedAt: now
        )
        let text = RicoPeopleProfilePresentation.ownerEditorText(profile, at: now)
        #expect(text == "background: Works in health care.")
        #expect(!text.contains("Tuesday"))
    }
}
