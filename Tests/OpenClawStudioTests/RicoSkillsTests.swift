import Foundation
import Testing
@testable import OpenClawStudio

@Suite("Rico reviewed skills")
struct RicoSkillsTests {
    @Test("Imported skills are structurally non-authorizing")
    func securityBoundary() {
        #expect(RicoSkillSecurityBoundary.isNonAuthorizing(
            effectivePermissions: [],
            denied: RicoSkillSecurityBoundary.deniedAuthorities
        ))
        #expect(!RicoSkillSecurityBoundary.isNonAuthorizing(
            effectivePermissions: ["email"],
            denied: RicoSkillSecurityBoundary.deniedAuthorities
        ))
        #expect(!RicoSkillSecurityBoundary.isNonAuthorizing(
            effectivePermissions: [],
            denied: RicoSkillSecurityBoundary.deniedAuthorities.filter { $0 != "owner_status" }
        ))
    }

    @Test("Picker accepts only folders, text/Markdown, and ZIP")
    func importSelection() {
        #expect(RicoSkillImportSelection.accepts(url: URL(fileURLWithPath: "/tmp/export.md"), isDirectory: false))
        #expect(RicoSkillImportSelection.accepts(url: URL(fileURLWithPath: "/tmp/export.zip"), isDirectory: false))
        #expect(RicoSkillImportSelection.accepts(url: URL(fileURLWithPath: "/tmp/export.json"), isDirectory: false))
        #expect(RicoSkillImportSelection.accepts(url: URL(fileURLWithPath: "/tmp/bot-export"), isDirectory: true))
        #expect(!RicoSkillImportSelection.accepts(url: URL(fileURLWithPath: "/tmp/run.sh"), isDirectory: false))
        #expect(!RicoSkillImportSelection.accepts(url: URL(fileURLWithPath: "/tmp/tool.app"), isDirectory: false))
    }

    @Test("Install decision needs both explicit acknowledgements and a bound review token")
    func reviewDecision() {
        let stage = Self.stage(reviewToken: "review-token")
        var decision = RicoSkillReviewDecision()
        #expect(!decision.permitsInstall(stage))
        decision.reviewedCanonicalDiff = true
        #expect(!decision.permitsInstall(stage))
        decision.acceptsNonAuthorizingBoundary = true
        #expect(decision.permitsInstall(stage))
        #expect(!decision.permitsInstall(Self.stage(reviewToken: nil)))
    }

    @Test("Store never invokes install without review")
    @MainActor
    func installFailsClosedBeforeRuntime() async {
        let executor = RicoSkillFakeExecutor()
        let store = RicoSkillsStore(executor: executor)
        await store.install(Self.stage(reviewToken: "review-token"), decision: RicoSkillReviewDecision())
        #expect(await executor.commands.isEmpty)
        #expect(store.error?.contains("Review") == true)
    }

    @Test("Reviewed install remains disabled and refreshes inventory")
    @MainActor
    func reviewedInstall() async throws {
        let installed = Self.installed(enabled: false)
        let inventory = RicoSkillInventory(schema: "openclaw.rico-skill-library/v1", installed: [installed], staged: [])
        let executor = RicoSkillFakeExecutor(responses: [
            "install": try Self.response(installed),
            "inventory": try Self.response(inventory)
        ])
        let store = RicoSkillsStore(executor: executor)
        var decision = RicoSkillReviewDecision()
        decision.reviewedCanonicalDiff = true
        decision.acceptsNonAuthorizingBoundary = true
        await store.install(Self.stage(reviewToken: "review-token"), decision: decision)

        #expect(store.installed == [installed])
        #expect(store.installed.first?.enabled == false)
        #expect(store.notice?.contains("installed disabled") == true)
        #expect(await executor.commands == ["install", "inventory"])
    }

    @Test("Enable is never invoked without a separate approval")
    @MainActor
    func enableNeedsSeparateApproval() async {
        let executor = RicoSkillFakeExecutor()
        let store = RicoSkillsStore(executor: executor)
        await store.setEnabled(Self.installed(enabled: false), enabled: true, approved: false)
        #expect(await executor.commands.isEmpty)
        #expect(store.error != nil)
    }

    @Test("Signed-app command seam stages only a synthetic export in a temporary library")
    func runtimeCommandSeam() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("rico-skills-swift-\(UUID().uuidString)", isDirectory: true)
        let source = root.appendingPathComponent("source.md")
        let library = root.appendingPathComponent("library", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("# Synthetic Glossary\nExplain synthetic terms clearly.".utf8).write(to: source, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: source.path)

        let client = RicoSkillsCommandClient(libraryRoot: library)
        let data = try await client.execute(command: "stage", options: ["source": source.path])
        let envelope = try JSONDecoder().decode(RicoSkillCLIEnvelope<RicoStagedSkill>.self, from: data)
        #expect(envelope.ok)
        #expect(envelope.result?.review.name == "Synthetic Glossary")
        #expect(envelope.result?.status == "awaiting_review")
        #expect(envelope.result?.review.effectivePermissions == [])
    }

    private static func stage(reviewToken: String?) -> RicoStagedSkill {
        RicoStagedSkill(
            schema: "openclaw.rico-skill-stage/v1",
            schemaVersion: 1,
            stageID: "stage-id",
            reviewToken: reviewToken,
            stagedAt: "2026-08-15T12:00:00Z",
            status: "awaiting_review",
            review: RicoSkillReview(
                id: "incident-helper",
                name: "Incident Helper",
                description: "Explain reviewed incident terminology.",
                version: "1.0.0+aaaaaaaaaaaa",
                contentHash: String(repeating: "a", count: 64),
                sourceName: "export.md",
                sourceKind: "file",
                audienceScope: "owner_private",
                triggers: ["Use for incident terminology"],
                requestedPermissions: ["email"],
                effectivePermissions: [],
                toolNeeds: ["email"],
                resources: [],
                blockedLines: [],
                canonicalPreview: "---\nname: incident-helper\n---",
                changes: RicoSkillReviewChanges(
                    renamedToSkillMarkdown: true,
                    removedReadmes: 0,
                    blockedDirectiveCount: 1,
                    sourceFileCount: 1,
                    installedFileCount: 2
                )
            ),
            stagePath: "/private/tmp/library/quarantine/stage-id"
        )
    }

    private static func installed(enabled: Bool) -> RicoInstalledSkill {
        RicoInstalledSkill(
            id: "incident-helper",
            name: "Incident Helper",
            description: "Explain reviewed incident terminology.",
            version: "1.0.0+aaaaaaaaaaaa",
            versionID: "1.0.0+aaaaaaaaaaaa-aaaaaaaaaaaa",
            contentHash: String(repeating: "a", count: 64),
            enabled: enabled,
            audienceScope: "owner_private",
            triggers: ["Use for incident terminology"],
            requestedPermissions: ["email"],
            effectivePermissions: [],
            toolNeeds: ["email"],
            resources: [],
            provenance: RicoSkillProvenance(
                sourceKind: "file",
                sourceName: "export.md",
                sourceHash: String(repeating: "b", count: 64),
                importedAt: "2026-08-15T12:00:00Z",
                transformed: true
            ),
            history: ["1.0.0+aaaaaaaaaaaa-aaaaaaaaaaaa"],
            versions: [RicoSkillVersionRecord(
                versionID: "1.0.0+aaaaaaaaaaaa-aaaaaaaaaaaa",
                version: "1.0.0+aaaaaaaaaaaa",
                contentHash: String(repeating: "a", count: 64),
                importedAt: "2026-08-15T12:00:00Z",
                active: true
            )],
            installedAt: "2026-08-15T12:00:00Z",
            updatedAt: "2026-08-15T12:00:00Z"
        )
    }

    private static func response<Value: Encodable>(_ value: Value) throws -> Data {
        try JSONEncoder().encode(RicoSkillTestResponse(ok: true, result: value))
    }
}

private struct RicoSkillTestResponse<Value: Encodable>: Encodable {
    let ok: Bool
    let result: Value
}

private actor RicoSkillFakeExecutor: RicoSkillsCommandExecuting {
    private(set) var commands: [String] = []
    private let responses: [String: Data]

    init(responses: [String: Data] = [:]) {
        self.responses = responses
    }

    func execute(command: String, options: [String: String]) async throws -> Data {
        commands.append(command)
        guard let response = responses[command] else {
            return Data(#"{"ok":false,"error":{"code":"unexpected","message":"Unexpected test command."}}"#.utf8)
        }
        return response
    }
}
