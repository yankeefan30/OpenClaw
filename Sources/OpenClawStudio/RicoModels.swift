import Foundation

enum RicoRole: String, Codable, CaseIterable {
    case owner, trustedDelegate, approvedContact, blocked, unknown
}

enum RicoContextTier: Int, Codable, Comparable, CaseIterable {
    case none = 0
    case publicRepresentative = 1
    case relationship = 2
    case trustedDelegate = 3
    case privateOwner = 4
    static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

enum RicoToolTier: String, Codable, CaseIterable {
    case none, publicOnly, relationshipOnly, delegated, owner
}

enum RicoInboundDecision: Equatable {
    case ignore(String)
    case requestPairing(String)
    case acknowledge(String)
    case sendToRico(context: RicoContextTier)
    case holdForOwner(String)
    case block(String)
}

enum RicoOutboundDecision: Equatable {
    case autoSend
    case redactAndReevaluate(String)
    case holdForOwner(String)
    case block(String)
    case deferred(Date)
}

struct RicoStableIdentity: Codable, Hashable {
    let original: String
    let normalized: String
    let kind: String

    init(_ value: String) {
        let original = value.trimmingCharacters(in: .whitespacesAndNewlines)
        self.original = original
        if original.contains("@") && !original.hasPrefix("+") {
            self.normalized = original.lowercased()
            self.kind = "email"
        } else {
            let digits = original.filter(\.isNumber)
            self.normalized = digits.isEmpty ? original.lowercased() : "+\(digits)"
            self.kind = digits.isEmpty ? "opaque" : "phone"
        }
    }
}

struct RicoRelationship: Codable, Identifiable, Hashable {
    let id: UUID
    var displayName: String
    var identities: [RicoStableIdentity]
    var contactsIdentifier: String?
    var role: RicoRole
    var permittedDMs: Set<String>
    var permittedGroups: Set<String>
    var requireMention: Bool
    var communicationHours: String?
    var allowedTopics: Set<String>
    var prohibitedTopics: Set<String>
    var contextTier: RicoContextTier
    var toolTier: RicoToolTier
    var automaticResponse: Bool
    var approvalRequired: Bool
    var notesMayUse: Set<String>
    var notesNeverDisclose: Set<String>
    var expiresAt: Date?
}

struct RicoRegistry: Codable {
    var schemaVersion: Int = 1
    var ownerIdentityIDs: Set<String> = []
    var relationships: [RicoRelationship] = []

    func match(identity: String) -> RicoRelationship? {
        let normalized = RicoStableIdentity(identity).normalized
        return relationships.first { $0.identities.contains { $0.normalized == normalized } }
    }
}

struct RicoInboundEnvelope: Hashable {
    var channel: String
    var sender: RicoStableIdentity
    var chatID: String
    var isGroup: Bool
    var text: String
    var mentionPresent: Bool
    var localTime: Date
    var attachmentCount: Int
    var deliveryID: String
}

struct RicoInboundPolicy: Codable, Hashable {
    var groupMentionPatterns: [String] = ["@rico"]
    var ownerDMRequiresMention = false
    var rateLimitPerHour = 20
    var quietHours: String?
    var quietHoursBehavior = "acknowledge_and_defer"
    var vacationMode = false
    var muted = false
}

struct RicoPolicySnapshot {
    var registry: RicoRegistry
    var policy: RicoInboundPolicy
    var now: Date
    var recentDeliveryIDs: Set<String> = []
    var recentSenderCounts: [String: Int] = [:]
}

enum RicoMentionMatcher {
    static func containsAcceptedMention(_ text: String, patterns: [String]) -> Bool {
        patterns.contains { pattern in
            let value = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { return false }
            return text.range(of: value, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
    }
}

enum RicoInboundPolicyEngine {
    static func evaluate(_ envelope: RicoInboundEnvelope, snapshot: RicoPolicySnapshot) -> RicoInboundDecision {
        guard envelope.channel == "imessage" else { return .ignore("Unsupported channel.") }
        guard !snapshot.policy.muted else { return .ignore("External replies are muted.") }
        guard !snapshot.recentDeliveryIDs.contains(envelope.deliveryID) else { return .ignore("Duplicate delivery.") }
        let senderID = envelope.sender.normalized
        if snapshot.registry.ownerIdentityIDs.contains(senderID) {
            if envelope.isGroup && !envelope.mentionPresent { return .ignore("Rico mention is required in groups.") }
            if (snapshot.recentSenderCounts[senderID] ?? 0) >= snapshot.policy.rateLimitPerHour {
                return .holdForOwner("Sender rate limit reached.")
            }
            return .sendToRico(context: .privateOwner)
        }
        guard let relationship = snapshot.registry.match(identity: envelope.sender.original) else {
            return .requestPairing("Sender identity is not registered.")
        }
        guard relationship.role != .blocked else { return .block("Sender is blocked.") }
        if let expiresAt = relationship.expiresAt, expiresAt <= snapshot.now {
            return .block("Temporary permission has expired.")
        }
        guard relationship.role == .owner || relationship.role == .trustedDelegate || relationship.role == .approvedContact else {
            return .requestPairing("Sender is not approved.")
        }
        if relationship.role != .owner && envelope.isGroup {
            guard relationship.permittedGroups.contains(envelope.chatID) else { return .block("Group is not permitted for this identity.") }
            guard envelope.mentionPresent else { return .ignore("Rico mention is required.") }
        } else if relationship.role != .owner && !envelope.isGroup {
            guard relationship.permittedDMs.contains(envelope.chatID) else { return .block("DM is not permitted for this identity.") }
            guard relationship.requireMention == false || envelope.mentionPresent else { return .ignore("Rico mention is required.") }
        } else if relationship.role == .owner && !snapshot.policy.ownerDMRequiresMention && !envelope.isGroup {
            // Owner identity is authenticated by the stable sender ID, not by message content.
        } else if envelope.isGroup && !envelope.mentionPresent {
            return .ignore("Rico mention is required in groups.")
        }
        if (snapshot.recentSenderCounts[envelope.sender.normalized] ?? 0) >= snapshot.policy.rateLimitPerHour {
            return .holdForOwner("Sender rate limit reached.")
        }
        if isWithinWindow(snapshot.policy.quietHours, date: envelope.localTime) {
            switch snapshot.policy.quietHoursBehavior {
            case "ignore": return .ignore("Quiet hours are active.")
            case "draft_without_sending": return .holdForOwner("Quiet hours: draft only.")
            case "escalate": return .holdForOwner("Quiet hours: escalation requested.")
            default: return .acknowledge("Quiet hours: acknowledge and defer.")
            }
        }
        if isWithinWindow(relationship.communicationHours, date: envelope.localTime) == false,
           relationship.communicationHours != nil {
            return .holdForOwner("Outside this relationship's communication hours.")
        }
        if relationship.role == .owner { return .sendToRico(context: .privateOwner) }
        return .sendToRico(context: min(relationship.contextTier, .relationship))
    }
}

struct RicoContextItem: Codable, Hashable, Identifiable {
    let id: UUID
    let source: String
    let owner: String
    let sensitivity: String
    let permittedAudiences: Set<String>
    let permittedPurposes: Set<String>
    let expiresAt: Date?
    let quoting: String
    let text: String
}

struct RicoContextRequest {
    var audience: String
    var purpose: String
    var maximumTier: RicoContextTier
}

enum RicoSourceKind: String, Codable, CaseIterable {
    case email, localFile, memory, calendar, contacts
}

struct RicoSourceAccessRequest: Hashable {
    var source: RicoSourceKind
    var audience: String
    var purpose: String
    var contextTier: RicoContextTier
    var mayQuote: Bool
}

enum RicoSourceAccessDecision: Equatable {
    case allow
    case deny(String)
}

/// Policy-only broker. Concrete OpenClaw connectors must call this before
/// searching; the broker never retrieves a source and then filters it.
struct RicoSourceBroker {
    func authorize(_ request: RicoSourceAccessRequest) -> RicoSourceAccessDecision {
        if request.contextTier == .none { return .deny("No context is permitted.") }
        if request.audience != "owner" && request.source == .email {
            return .deny("Email is private by default for non-owner audiences.")
        }
        if request.audience != "owner" && request.source == .localFile {
            return .deny("Files are private by default for non-owner audiences.")
        }
        if request.audience != "owner" && request.source == .memory && request.contextTier < .relationship {
            return .deny("Memory tier is insufficient for this audience.")
        }
        if request.source == .email && request.mayQuote && request.audience != "owner" {
            return .deny("Private email may not be quoted externally.")
        }
        return .allow
    }
}

enum RicoToolAuthority {
    static func permits(tool: String, role: RicoRole, contextTier: RicoContextTier) -> Bool {
        let normalized = tool.lowercased()
        let ownerOnly = ["email", "file", "private", "workflow", "exec", "calendar", "contacts", "memory"]
        if ownerOnly.contains(where: { normalized.contains($0) }) {
            return role == .owner && contextTier == .privateOwner
        }
        return role == .owner || (role == .trustedDelegate && contextTier >= .trustedDelegate) ||
            (role == .approvedContact && contextTier >= .relationship && normalized == "public_profile")
    }
}

struct RicoContextBroker {
    func filter(_ items: [RicoContextItem], request: RicoContextRequest, now: Date) -> [RicoContextItem] {
        items.filter { item in
            guard request.maximumTier >= tier(for: item.sensitivity) else { return false }
            guard item.permittedAudiences.contains(request.audience) else { return false }
            guard item.permittedPurposes.contains(request.purpose) else { return false }
            guard item.expiresAt.map({ $0 > now }) ?? true else { return false }
            return true
        }
    }

    private func tier(for sensitivity: String) -> RicoContextTier {
        switch sensitivity.lowercased() {
        case "private", "owner": return .privateOwner
        case "delegate", "trusted": return .trustedDelegate
        case "relationship": return .relationship
        case "public": return .publicRepresentative
        default: return .none
        }
    }
}

struct RicoOutboundDraft: Hashable {
    var recipient: RicoStableIdentity
    var chatID: String
    var senderRole: RicoRole
    var text: String
    var topic: String
    var sensitivity: String
    var referencedPeople: Set<String>
    var contextSources: [RicoContextItem]
    var requestedAction: String?
    var commitment: Bool
    var schedulingClaim: Bool
    var attachmentFromPrivateStorage: Bool
    var initiatesContact: Bool
    var confidence: Double
    var now: Date
}

struct RicoOutboundPolicy: Codable, Hashable {
    var quietHours: String?
    var rateLimitPerHour = 20
    var requireApprovalForFirstContact = true
    var requireApprovalForCommitments = true
    var requireApprovalForSensitiveTopics = true
    var globalPause = false
}

struct RicoOutboundPolicyEngine {
    func evaluate(_ draft: RicoOutboundDraft, policy: RicoOutboundPolicy, recipient: RicoRelationship?, recentCount: Int) -> RicoOutboundDecision {
        if policy.globalPause { return .holdForOwner("Global external-reply pause is active.") }
        guard draft.senderRole == .owner || draft.senderRole == .trustedDelegate || draft.senderRole == .approvedContact else {
            return .block("Sender authority cannot send outbound messages.")
        }
        guard let recipient, recipient.role != .blocked else { return .block("Recipient is not approved.") }
        if recentCount >= policy.rateLimitPerHour { return .deferred(draft.now.addingTimeInterval(3600)) }
        if let quietHours = policy.quietHours, isWithinWindow(quietHours, date: draft.now) {
            return .deferred(nextAllowedTime(after: draft.now, window: quietHours))
        }
        if draft.initiatesContact && policy.requireApprovalForFirstContact { return .holdForOwner("First outbound contact requires approval.") }
        if draft.commitment && policy.requireApprovalForCommitments { return .holdForOwner("Commitments on Alan's behalf require approval.") }
        let sensitiveTopics: Set<String> = ["financial", "health", "legal", "employment", "romantic", "conflict", "reputational"]
        if policy.requireApprovalForSensitiveTopics && sensitiveTopics.contains(draft.topic.lowercased()) {
            return .holdForOwner("Sensitive topic requires approval.")
        }
        if draft.schedulingClaim { return .holdForOwner("Scheduling confirmation requires approval.") }
        if draft.attachmentFromPrivateStorage { return .holdForOwner("Private attachment requires approval.") }
        if draft.contextSources.contains(where: { $0.sensitivity.lowercased() == "private" || $0.sensitivity.lowercased() == "owner" }) {
            return .holdForOwner("Private source disclosure requires approval.")
        }
        if draft.confidence < 0.8 { return .holdForOwner("Low-confidence policy classification requires approval.") }
        return .autoSend
    }
}

private func isWithinWindow(_ specification: String?, date: Date) -> Bool {
    guard let specification else { return false }
    let pieces = specification.split(separator: "-", maxSplits: 1).map(String.init)
    guard pieces.count == 2 else { return false }
    func minutes(_ value: String) -> Int? {
        let parts = value.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2, (0..<24).contains(parts[0]), (0..<60).contains(parts[1]) else { return nil }
        return parts[0] * 60 + parts[1]
    }
    guard let start = minutes(pieces[0]), let end = minutes(pieces[1]) else { return false }
    let now = Calendar.current.dateComponents([.hour, .minute], from: date)
    let current = (now.hour ?? 0) * 60 + (now.minute ?? 0)
    if start == end { return true }
    return start < end ? (start...end).contains(current) : current >= start || current <= end
}

private func nextAllowedTime(after date: Date, window: String) -> Date {
    let calendar = Calendar.current
    for minute in 1...1440 {
        if let candidate = calendar.date(byAdding: .minute, value: minute, to: date),
           !isWithinWindow(window, date: candidate) { return candidate }
    }
    return date.addingTimeInterval(3600)
}

struct RicoAuditEvent: Codable, Identifiable, Hashable {
    let id: UUID
    let timestamp: Date
    let direction: String
    let chatID: String
    let senderOrRecipient: String
    let decision: String
    let reason: String
    let contextSources: [String]
}

struct RicoPersonalityProfile: Codable, Hashable {
    var schemaVersion = 1
    var voice = "Warm, concise, and clear"
    var messageLength = "short"
    var humorLevel = "light"
    var formalityByRelationship: [String: String] = [:]
    var disclosurePhrase = "I’m Rico, Alan’s AI assistant."
    var prohibitedClaims: [String] = ["I am Alan", "Alan approved this"]
    var uncertaintyBehavior = "State uncertainty and ask Alan when authority is unclear."
    var escalationStyle = "Hold for Alan"
    var correctionBehavior = "Correct plainly without pretending certainty."
}

struct RicoRelationshipMemoryProposal: Codable, Identifiable, Hashable {
    let id: UUID
    let fact: String
    let sourceConversation: String
    let personOrGroup: String
    let sensitivity: String
    let confidence: Double
    let suggestedExpiration: Date?
    let permittedFutureUses: Set<String>
    var approved: Bool = false
}

enum RicoWorkflowTrigger: String, Codable, CaseIterable {
    case ownerDMReceived = "owner DM received"
    case approvedContactDMReceived = "approved-contact DM received"
    case ricoMentioned = "@rico mentioned in approved group"
    case topicMatch = "message matches topic"
    case scheduled = "scheduled time"
    case approvalGranted = "approval granted"
    case noResponse = "no response interval"
}

enum RicoWorkflowAction: String, Codable, CaseIterable {
    case draftResponse = "draft response"
    case autoSend = "auto-send response"
    case holdForApproval = "hold for approval"
    case notifyOwner = "notify Alan"
    case createWorkboardCard = "create Workboard card"
    case ownerWorkflow = "run owner-approved workflow"
    case searchMemory = "search permitted memory"
    case searchFiles = "search permitted files"
    case searchEmail = "search permitted email"
    case deferred = "defer"
    case ignore, block, proposeRelationshipMemory
}

struct RicoCommunicationWorkflow: Codable, Identifiable, Hashable {
    let id: UUID
    var name: String
    var trigger: RicoWorkflowTrigger
    var conditions: [String]
    var actions: [RicoWorkflowAction]
    var enabled = false
    var schemaVersion = 1

    var validationErrors: [String] {
        var errors: [String] = []
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { errors.append("Name is required.") }
        if actions.isEmpty { errors.append("At least one action is required.") }
        if enabled && actions.contains(.autoSend) && !conditions.contains(where: { $0.localizedCaseInsensitiveContains("approved") || $0.localizedCaseInsensitiveContains("owner") }) {
            errors.append("Auto-send requires an explicit approved/owner condition.")
        }
        if actions.contains(.searchEmail) && !conditions.contains(where: { $0.localizedCaseInsensitiveContains("owner") || $0.localizedCaseInsensitiveContains("delegated") }) {
            errors.append("Email search requires an owner or delegated condition.")
        }
        return errors
    }
}

@MainActor
final class RicoRegistryStore: ObservableObject {
    @Published private(set) var registry: RicoRegistry = .init()
    @Published private(set) var policy: RicoInboundPolicy = .init()
    @Published private(set) var outboundPolicy: RicoOutboundPolicy = .init()
    @Published private(set) var personality = RicoPersonalityProfile()
    @Published private(set) var workflows: [RicoCommunicationWorkflow] = []
    @Published private(set) var audit: [RicoAuditEvent] = []
    private let root = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".openclaw/workspace/rico")

    init() { load() }
    func add(_ relationship: RicoRelationship) { registry.relationships.append(relationship); save() }
    func setOwner(identity: String) { registry.ownerIdentityIDs.insert(RicoStableIdentity(identity).normalized); save() }
    func setGlobalPause(_ paused: Bool) { outboundPolicy.globalPause = paused; save() }
    func addWorkflow(_ workflow: RicoCommunicationWorkflow) {
        guard workflow.validationErrors.isEmpty else { return }
        workflows.append(workflow); save()
    }
    func appendAudit(_ event: RicoAuditEvent) { audit.append(event); audit = Array(audit.suffix(500)); save() }
    private func load() {
        let decoder = JSONDecoder()
        if let data = try? Data(contentsOf: root.appendingPathComponent("registry.json")) { registry = (try? decoder.decode(RicoRegistry.self, from: data)) ?? registry }
        if let data = try? Data(contentsOf: root.appendingPathComponent("inbound-policy.json")) { policy = (try? decoder.decode(RicoInboundPolicy.self, from: data)) ?? policy }
        if let data = try? Data(contentsOf: root.appendingPathComponent("outbound-policy.json")) { outboundPolicy = (try? decoder.decode(RicoOutboundPolicy.self, from: data)) ?? outboundPolicy }
        if let data = try? Data(contentsOf: root.appendingPathComponent("personality.json")) { personality = (try? decoder.decode(RicoPersonalityProfile.self, from: data)) ?? personality }
        if let data = try? Data(contentsOf: root.appendingPathComponent("workflows.json")) { workflows = (try? decoder.decode([RicoCommunicationWorkflow].self, from: data)) ?? [] }
        if let data = try? Data(contentsOf: root.appendingPathComponent("audit.json")) { audit = (try? decoder.decode([RicoAuditEvent].self, from: data)) ?? [] }
    }
    private func save() {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try encoder.encode(registry).write(to: root.appendingPathComponent("registry.json"), options: .atomic)
            try encoder.encode(policy).write(to: root.appendingPathComponent("inbound-policy.json"), options: .atomic)
            try encoder.encode(outboundPolicy).write(to: root.appendingPathComponent("outbound-policy.json"), options: .atomic)
            try encoder.encode(personality).write(to: root.appendingPathComponent("personality.json"), options: .atomic)
            try encoder.encode(workflows).write(to: root.appendingPathComponent("workflows.json"), options: .atomic)
            try encoder.encode(audit).write(to: root.appendingPathComponent("audit.json"), options: .atomic)
        } catch { /* UI surfaces diagnostics in the communications console */ }
    }
}
