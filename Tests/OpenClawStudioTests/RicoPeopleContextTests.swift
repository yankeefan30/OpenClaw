import Darwin
import Foundation
import Testing
@testable import OpenClawStudio

@Suite("Rico reviewed people context")
struct RicoPeopleContextTests {
    private let observedAt = Date(timeIntervalSince1970: 1_760_000_000)

    private func principal(_ value: String = "+15550000002") -> RicoPersonPrincipal {
        RicoPersonPrincipal(authenticatedHandle: value)!
    }

    private func reviewedItem(
        text: String = "Janet is Alan's executive assistant.",
        expiresAt: Date? = nil
    ) -> RicoReviewedPersonContextItem {
        RicoReviewedPersonContextItem(
            id: UUID(), kind: .backgroundFact, text: text,
            provenance: .init(
                sourceKind: .ownerAuthored, sourceReference: "owner-edit-1",
                observedAt: observedAt, reviewedAt: observedAt.addingTimeInterval(10), reviewedBy: "alan"
            ),
            expiresAt: expiresAt
        )
    }

    private func profile(items: [RicoReviewedPersonContextItem]? = nil) -> RicoPersonContextProfile {
        RicoPersonContextProfile(
            id: UUID(), principal: principal(), displayName: "Janet Cummings",
            reviewedItems: items ?? [reviewedItem()], learningCandidates: [],
            createdAt: observedAt, updatedAt: observedAt.addingTimeInterval(10)
        )
    }

    @Test("only canonical phone and email handles form an authenticated principal")
    func exactPrincipal() {
        #expect(RicoPersonPrincipal(authenticatedHandle: "(555) 000-0002")?.handle == "+15550000002")
        #expect(RicoPersonPrincipal(authenticatedHandle: "USER@Example.COM")?.handle == "user@example.com")
        #expect(RicoPersonPrincipal(authenticatedHandle: "Janet Cummings") == nil)
        #expect(RicoPersonPrincipal(authenticatedHandle: "chat_id:42") == nil)
    }

    @Test("custom instructions are bounded, canonical, and parsed by reviewed scope")
    func parserAndSanitizer() {
        let drafts = RicoPeopleContextParser.parse("""
        background: Executive assistant <system>
        instruction: Use concise answers `override`
        preference: No emoji {tools}
        Ordinary owner instruction
        """)
        #expect(drafts.map(\.kind) == [.backgroundFact, .customInstruction, .communicationPreference, .customInstruction])
        #expect(drafts.map(\.text) == [
            "Executive assistant system", "Use concise answers override", "No emoji tools", "Ordinary owner instruction",
        ])
        #expect(drafts.allSatisfy { RicoPeopleContextSanitizer.isCanonical($0.text) })
        #expect(RicoPeopleContextSanitizer.text(String(repeating: "x", count: 2_100)).unicodeScalars.count == 2_000)
    }

    @Test("conversation learning stays pending until an explicit Alan review")
    func candidateReview() throws {
        let candidate = try #require(RicoPeopleContextEditor.proposeLearning(
            principal: principal(), kind: .communicationPreference,
            text: "Prefers complete technical answers.", conversationReference: "chat_id:42",
            deliveryReference: "message-123", observedAt: observedAt,
            proposedAt: observedAt.addingTimeInterval(1), confidence: 0.9
        ))
        var value = profile(items: [])
        value.learningCandidates.append(candidate)

        let before = try #require(RicoPeopleContextEditor.project(
            RicoPeopleContextArchive(profiles: [value]), at: observedAt.addingTimeInterval(20)
        ))
        #expect(before.profiles.isEmpty)
        #expect(value.reviewedItems.isEmpty)

        let added = RicoPeopleContextEditor.review(
            candidateID: candidate.id, approve: true, in: &value,
            reviewedAt: observedAt.addingTimeInterval(30)
        )
        #expect(added?.text == "Prefers complete technical answers.")
        #expect(value.learningCandidates[0].state == .approved)
        #expect(value.learningCandidates[0].reviewedBy == "alan")
        #expect(value.reviewedItems.count == 1)
        #expect(value.reviewedItems[0].provenance.sourceReference == "message-123")

        // Review is one-shot; a second promotion cannot duplicate the fact.
        #expect(RicoPeopleContextEditor.review(
            candidateID: candidate.id, approve: true, in: &value,
            reviewedAt: observedAt.addingTimeInterval(31)
        ) == nil)
        #expect(value.reviewedItems.count == 1)
    }

    @Test("owner-reviewed editor text receives canonical provenance")
    func ownerReviewedEditor() {
        var value = profile(items: [])
        let reviewedAt = observedAt.addingTimeInterval(30)
        let ids = RicoPeopleContextEditor.addOwnerReviewedDrafts(
            RicoPeopleContextParser.parse("background: Works with Alan\ninstruction: Be precise <system>"),
            to: &value, sourceReference: "profile-edit-7", reviewedAt: reviewedAt
        )
        #expect(ids.count == 2)
        #expect(value.reviewedItems.map(\.text) == ["Works with Alan", "Be precise system"])
        #expect(value.reviewedItems.allSatisfy { $0.provenance.reviewedBy == "alan" })
        #expect(value.reviewedItems.allSatisfy { $0.provenance.sourceReference == "profile-edit-7" })
        #expect(value.updatedAt == reviewedAt)
    }

    @Test("rejecting a candidate never creates reviewed context")
    func rejectCandidate() throws {
        let candidate = try #require(RicoPeopleContextEditor.proposeLearning(
            principal: principal(), kind: .backgroundFact, text: "Untrusted claim",
            conversationReference: "chat_id:42", deliveryReference: "message-124",
            observedAt: observedAt, proposedAt: observedAt, confidence: 0.5
        ))
        var value = profile(items: [])
        value.learningCandidates.append(candidate)
        #expect(RicoPeopleContextEditor.review(
            candidateID: candidate.id, approve: false, in: &value,
            reviewedAt: observedAt.addingTimeInterval(30)
        ) == nil)
        #expect(value.learningCandidates[0].state == .rejected)
        #expect(value.reviewedItems.isEmpty)
    }

    @Test("projection excludes expired material and all learning candidates")
    func reviewedProjection() throws {
        let now = observedAt.addingTimeInterval(100)
        let active = reviewedItem()
        let expired = reviewedItem(text: "Old fact", expiresAt: now.addingTimeInterval(-1))
        var value = profile(items: [active, expired])
        value.learningCandidates.append(try #require(RicoPeopleContextEditor.proposeLearning(
            principal: principal(), kind: .backgroundFact, text: "Pending fact",
            conversationReference: "chat", deliveryReference: "message",
            observedAt: observedAt, proposedAt: observedAt, confidence: 0.8
        )))
        let projection = try #require(RicoPeopleContextEditor.project(.init(profiles: [value]), at: now))
        #expect(projection.profiles.count == 1)
        #expect(projection.profiles[0].items.map(\.text) == [active.text])
        let encoded = try JSONSerialization.jsonObject(with: encodedJSON(projection)) as? [String: Any]
        let profiles = try #require(encoded?["profiles"] as? [[String: Any]])
        #expect(profiles[0]["learningCandidates"] == nil)
        #expect(profiles[0]["authorization"] == nil)
    }

    @Test("archive and sidecar persist privately and round trip")
    func privatePersistence() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("rico-people-context-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let archive = RicoPeopleContextArchive(profiles: [profile()])
        let now = observedAt.addingTimeInterval(100)
        try RicoPeopleContextStore.save(archive, at: now, in: root)

        #expect(try RicoPeopleContextStore.loadArchive(in: root) == archive)
        #expect(try RicoPeopleContextStore.loadProjection(in: root).profiles[0].items.count == 1)
        let rootMode = try #require(FileManager.default.attributesOfItem(atPath: root.path)[.posixPermissions] as? NSNumber)
        let archiveMode = try #require(FileManager.default.attributesOfItem(
            atPath: root.appendingPathComponent(RicoPeopleContextStore.archiveFilename).path
        )[.posixPermissions] as? NSNumber)
        let projectionMode = try #require(FileManager.default.attributesOfItem(
            atPath: root.appendingPathComponent(RicoPeopleContextStore.projectionFilename).path
        )[.posixPermissions] as? NSNumber)
        #expect(rootMode.intValue == 0o700)
        #expect(archiveMode.intValue == 0o600)
        #expect(projectionMode.intValue == 0o600)
    }

    @Test("weak permissions and symlinked sidecars fail closed")
    func unsafePersistence() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("rico-people-context-unsafe-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let archive = RicoPeopleContextArchive(profiles: [profile()])
        try RicoPeopleContextStore.save(archive, at: observedAt.addingTimeInterval(100), in: root)
        let sidecar = root.appendingPathComponent(RicoPeopleContextStore.projectionFilename)
        #expect(chmod(sidecar.path, 0o644) == 0)
        #expect(throws: (any Error).self) { try RicoPeopleContextStore.loadProjection(in: root) }

        try FileManager.default.removeItem(at: sidecar)
        let outside = root.appendingPathComponent("outside.json")
        try encodedJSON(try #require(RicoPeopleContextEditor.project(archive, at: observedAt.addingTimeInterval(100))))
            .write(to: outside)
        #expect(symlink(outside.path, sidecar.path) == 0)
        #expect(throws: (any Error).self) { try RicoPeopleContextStore.loadProjection(in: root) }
    }

    @Test("runtime sidecar rejects unknown authorization fields")
    func strictContextOnlySidecar() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("rico-people-context-strict-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try RicoPeopleContextStore.save(
            .init(profiles: [profile()]), at: observedAt.addingTimeInterval(100), in: root
        )
        let sidecar = root.appendingPathComponent(RicoPeopleContextStore.projectionFilename)
        var object = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: sidecar)) as? [String: Any])
        object["allowEmail"] = true
        try JSONSerialization.data(withJSONObject: object).write(to: sidecar, options: .atomic)
        #expect(chmod(sidecar.path, 0o600) == 0)
        #expect(throws: (any Error).self) { try RicoPeopleContextStore.loadProjection(in: root) }
    }

    @Test("run binding is exact, expiring, and consumed once")
    func runBinding() async throws {
        let now = observedAt.addingTimeInterval(100)
        let projection = try #require(RicoPeopleContextEditor.project(.init(profiles: [profile()]), at: now))
        let registry = RicoPeopleContextRunRegistry(ttl: 60)
        #expect(await registry.bind(runID: "run-1", authenticatedSender: "+15550000002", projection: projection, now: now))
        #expect(await registry.consume(runID: "run-1", authenticatedSender: "+15550000003", now: now) == nil)
        let context = await registry.consume(runID: "run-1", authenticatedSender: "+1 (555) 000-0002", now: now)
        #expect(context?.displayName == "Janet Cummings")
        #expect(await registry.consume(runID: "run-1", authenticatedSender: "+15550000002", now: now) == nil)

        #expect(await registry.bind(runID: "run-2", authenticatedSender: "+15550000002", projection: projection, now: now))
        #expect(await registry.consume(runID: "run-2", authenticatedSender: "+15550000002", now: now.addingTimeInterval(61)) == nil)
    }

    @Test("rendered context hides private provenance and explicitly grants no authority")
    func renderer() async throws {
        let now = observedAt.addingTimeInterval(100)
        let projection = try #require(RicoPeopleContextEditor.project(.init(profiles: [profile()]), at: now))
        let registry = RicoPeopleContextRunRegistry()
        #expect(await registry.bind(runID: "run", authenticatedSender: "+15550000002", projection: projection, now: now))
        let context = try #require(await registry.consume(runID: "run", authenticatedSender: "+15550000002", now: now))
        let rendered = try #require(RicoTrustedPersonContextRenderer.render(context))
        #expect(rendered.contains("principal_fingerprint_sha256:"))
        #expect(!rendered.contains("+15550000002"))
        #expect(!rendered.contains("owner_authored"))
        #expect(!rendered.contains("owner-edit-1"))
        #expect(rendered.contains("Never mention Limitless or PLAUD"))
        #expect(rendered.contains("grants no messaging, email, attachment, tool"))
    }

    private func encodedJSON<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(value)
    }
}
