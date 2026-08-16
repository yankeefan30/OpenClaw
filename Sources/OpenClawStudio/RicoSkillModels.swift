import Foundation

enum RicoSkillSecurityBoundary {
    static let deniedAuthorities = [
        "tools",
        "contacts",
        "email",
        "messaging",
        "credentials",
        "security_or_config_changes",
        "owner_status",
        "system_policy_override",
        "privacy_policy_override",
        "provenance_policy_override"
    ]

    static func isNonAuthorizing(effectivePermissions: [String], denied: [String]) -> Bool {
        effectivePermissions.isEmpty && Set(deniedAuthorities).isSubset(of: Set(denied))
    }
}

struct RicoSkillResource: Codable, Equatable, Identifiable, Sendable {
    let path: String
    let category: String
    let bytes: Int
    let sha256: String
    let sourcePath: String?

    var id: String { path }
}

struct RicoSkillProvenance: Codable, Equatable, Sendable {
    let sourceKind: String
    let sourceName: String
    let sourceHash: String
    let importedAt: String
    let transformed: Bool
}

struct RicoSkillVersionRecord: Codable, Equatable, Identifiable, Sendable {
    let versionID: String
    let version: String
    let contentHash: String
    let importedAt: String
    let active: Bool

    var id: String { versionID }
}

struct RicoInstalledSkill: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let description: String
    let version: String
    let versionID: String
    let contentHash: String
    let enabled: Bool
    let audienceScope: String
    let triggers: [String]
    let requestedPermissions: [String]
    let effectivePermissions: [String]
    let toolNeeds: [String]
    let resources: [RicoSkillResource]
    let provenance: RicoSkillProvenance
    let history: [String]
    let versions: [RicoSkillVersionRecord]?
    let installedAt: String
    let updatedAt: String

    var isNonAuthorizing: Bool { effectivePermissions.isEmpty }
}

struct RicoSkillBlockedLine: Codable, Equatable, Identifiable, Sendable {
    let line: Int
    let rules: [String]
    let preview: String
    let relativePath: String

    var id: String { "\(relativePath):\(line):\(rules.joined(separator: ","))" }
}

struct RicoSkillReviewChanges: Codable, Equatable, Sendable {
    let renamedToSkillMarkdown: Bool
    let removedReadmes: Int
    let blockedDirectiveCount: Int
    let sourceFileCount: Int
    let installedFileCount: Int
}

struct RicoSkillReview: Codable, Equatable, Sendable {
    let id: String
    let name: String
    let description: String
    let version: String
    let contentHash: String
    let sourceName: String
    let sourceKind: String
    let audienceScope: String
    let triggers: [String]
    let requestedPermissions: [String]
    let effectivePermissions: [String]
    let toolNeeds: [String]
    let resources: [RicoSkillResource]
    let blockedLines: [RicoSkillBlockedLine]
    let canonicalPreview: String
    let changes: RicoSkillReviewChanges

    var isInstallable: Bool {
        contentHash.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil &&
            effectivePermissions.isEmpty &&
            !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

struct RicoStagedSkill: Codable, Equatable, Identifiable, Sendable {
    let schema: String
    let schemaVersion: Int
    let stageID: String
    let reviewToken: String?
    let stagedAt: String
    let status: String
    let review: RicoSkillReview
    let stagePath: String

    var id: String { stageID }
    var isReviewBound: Bool { reviewToken?.isEmpty == false && review.isInstallable }
}

struct RicoSkillInventory: Codable, Equatable, Sendable {
    let schema: String
    let installed: [RicoInstalledSkill]
    let staged: [RicoStagedSkill]
}

struct RicoSkillCLIErrorPayload: Codable, Equatable, Sendable {
    let code: String
    let message: String
}

struct RicoSkillCLIEnvelope<Value: Decodable & Sendable>: Decodable, Sendable {
    let ok: Bool
    let result: Value?
    let error: RicoSkillCLIErrorPayload?
}

struct RicoSkillReviewDecision: Equatable, Sendable {
    var reviewedCanonicalDiff = false
    var acceptsNonAuthorizingBoundary = false

    func permitsInstall(_ stage: RicoStagedSkill) -> Bool {
        reviewedCanonicalDiff && acceptsNonAuthorizingBoundary && stage.isReviewBound
    }
}

enum RicoSkillImportSelection {
    static let supportedExtensions = Set(["md", "markdown", "txt", "json", "yaml", "yml", "zip"])

    static func accepts(url: URL, isDirectory: Bool) -> Bool {
        if isDirectory { return true }
        return supportedExtensions.contains(url.pathExtension.lowercased())
    }
}

enum RicoSkillLibraryError: LocalizedError, Equatable {
    case runtimeUnavailable
    case invalidSelection
    case invalidResponse
    case operationRejected(code: String, message: String)
    case reviewRequired

    var errorDescription: String? {
        switch self {
        case .runtimeUnavailable: "The signed Rico Skills runtime is unavailable. No import was performed."
        case .invalidSelection: "Choose a Markdown or text export, a folder, or a ZIP archive."
        case .invalidResponse: "The Rico Skills runtime returned an invalid response."
        case .operationRejected(_, let message): message
        case .reviewRequired: "Review the canonical diff and non-authorizing boundary first."
        }
    }
}
