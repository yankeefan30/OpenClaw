import SwiftUI
import Contacts
import CryptoKit
import Darwin

enum RicoAccessLevel: String, Codable, CaseIterable, Identifiable, Sendable {
    case blocked = "Blocked"
    case approved = "Approved contact"
    case trusted = "Trusted delegate"
    case owner = "Owner"
    var id: String { rawValue }
}

struct RicoRecipientPolicy: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var contactID: String
    var displayName: String
    var address: String
    var access: RicoAccessLevel
    var requireMention: Bool
    var autoReply: Bool
    var quietStart: Int
    var quietEnd: Int
    var groupChatID: String?
    /// Exact iMessage handles discovered for a group. Optional keeps policies
    /// written by older Studio builds decodable; new group approvals always
    /// persist this list and the Gateway treats an absent list as deny-all.
    var participantAddresses: [String]? = nil
    /// Display-only Contacts names for exact approved group sender handles.
    /// The Gateway always authenticates with `participantAddresses`; names
    /// never grant access and ambiguous Contacts matches are omitted.
    var participantNames: [String: String]? = nil
    /// Optional, style-only configuration for this exact reviewed group.
    /// It is never consulted for identity, authorization, tools, or privacy.
    var groupPersonality: String? = nil

    var isQuietNow: Bool {
        let hour = Calendar.current.component(.hour, from: Date())
        if quietStart == quietEnd { return false }
        return quietStart < quietEnd ? (hour >= quietStart && hour < quietEnd) : (hour >= quietStart || hour < quietEnd)
    }
}

enum RicoContactDirectory {
    static func safeDisplayName(_ value: String) -> String {
        let withoutControls = value.unicodeScalars.map {
            CharacterSet.controlCharacters.contains($0) ? " " : String($0)
        }.joined()
        let collapsed = withoutControls
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        return String(collapsed.prefix(80))
    }

    /// Resolves only exact normalized handles. If more than one Contacts
    /// record owns a handle, no display name is projected so Rico cannot
    /// guess which real person is speaking.
    static func displayNames(for addresses: [String], contacts: [LocalContact]) -> [String: String] {
        let requested = Set(addresses.map(RicoRecipientGuard.normalizeTarget).filter { !$0.isEmpty })
        guard !requested.isEmpty else { return [:] }

        var matches: [String: [String: String]] = [:]
        for contact in contacts {
            let name = safeDisplayName(contact.name)
            guard !name.isEmpty else { continue }
            let values = contact.phones + contact.emails
            for raw in values {
                let normalized = RicoRecipientGuard.normalizeTarget(raw)
                guard requested.contains(normalized) else { continue }
                matches[normalized, default: [:]][contact.id] = name
            }
        }

        var resolved: [String: String] = [:]
        for (address, records) in matches where records.count == 1 {
            resolved[address] = records.values.first
        }
        return resolved
    }
}

enum RicoGroupMembership {
    static func normalized(_ addresses: [String]) -> Set<String> {
        Set(addresses.map(RicoRecipientGuard.normalizeTarget).filter { !$0.isEmpty })
    }

    static func requiresReview(approved: [String], discovered: [String]) -> Bool {
        let live = normalized(discovered)
        guard !live.isEmpty else { return false }
        return live != normalized(approved)
    }
}

/// One-time, fail-closed migration for the exact owner handle that was
/// captured by the earlier owner-command route. The private route file is
/// address authority; a Contacts display name never is. Requiring exactly one
/// handle prevents an old or broadened route from silently creating owners.
enum RicoOwnerIdentityMigration {
    static func apply(to policies: [RicoRecipientPolicy], ownerHandles: [String]) -> [RicoRecipientPolicy] {
        let owners = Set(ownerHandles.compactMap(validOwnerHandle))
        guard owners.count == 1, let owner = owners.first else { return policies }

        var result = policies
        let matchingIDs = result.filter {
            $0.groupChatID == nil && RicoRecipientGuard.normalizeTarget($0.address) == owner
        }.map(\.id)

        if let canonicalID = matchingIDs.first,
           let index = result.firstIndex(where: { $0.id == canonicalID }) {
            result[index].displayName = "Alan Rosa"
            result[index].access = .owner
            result[index].requireMention = false
            result[index].autoReply = true
            result[index].quietStart = 0
            result[index].quietEnd = 0
            result.removeAll { policy in
                policy.id != canonicalID && policy.groupChatID == nil && RicoRecipientGuard.normalizeTarget(policy.address) == owner
            }
        } else {
            result.append(RicoRecipientPolicy(
                id: "rico-owner:\(owner)",
                contactID: "rico.owner",
                displayName: "Alan Rosa",
                address: owner,
                access: .owner,
                requireMention: false,
                autoReply: true,
                quietStart: 0,
                quietEnd: 0,
                groupChatID: nil
            ))
        }
        return result
    }

    private static func validOwnerHandle(_ raw: String) -> String? {
        let value = RicoRecipientGuard.normalizeTarget(raw)
        let phone = value.range(of: "^\\+[1-9][0-9]{6,14}$", options: .regularExpression) != nil
        let email = value.range(of: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", options: .regularExpression) != nil
        return phone || email ? value : nil
    }
}

enum RicoOwnerAccessPolicy {
    static func canAssign(_ requested: RicoAccessLevel, current: RicoAccessLevel?) -> Bool {
        requested != .owner || current == .owner
    }
}

enum RicoDraftIntent: String, Codable, CaseIterable, Identifiable, Sendable {
    case opening = "Opening message"
    case message = "Message"

    var id: String { rawValue }
}

struct RicoDraft: Codable, Identifiable, Hashable {
    enum State: String, Codable { case pending, approved, sending, sent, blocked }
    let id: UUID
    let createdAt: Date
    let recipientName: String
    let address: String
    let message: String
    /// Optional so drafts saved by earlier Studio builds continue to decode.
    /// A legacy draft is an ordinary message, never silently reclassified as
    /// a proactive conversation opener.
    var intent: RicoDraftIntent? = nil
    var state: State
    var reason: String

    var resolvedIntent: RicoDraftIntent { intent ?? .message }
}

struct RicoDraftReview: Identifiable, Hashable {
    enum Audience: Hashable {
        case person
        case group(participantCount: Int)
    }

    let draft: RicoDraft
    let destination: String
    let destinationDetail: String
    let audience: Audience

    var id: UUID { draft.id }

    var audienceSummary: String {
        switch audience {
        case .person:
            return "Direct iMessage to this exact destination"
        case .group(let participantCount):
            let noun = participantCount == 1 ? "participant" : "participants"
            return "Group iMessage · \(participantCount) current \(noun) · visible to everyone in the chat"
        }
    }
}

enum RicoDraftQueue {
    /// Confirmation is the only operation that may place a staged review in
    /// the queue. Matching IDs make repeated button actions idempotent.
    @discardableResult
    static func confirm(_ draft: RicoDraft, into drafts: inout [RicoDraft]) -> Bool {
        guard draft.state == .pending,
              !drafts.contains(where: { $0.id == draft.id }) else { return false }
        var approved = draft
        approved.state = .approved
        approved.reason = "Explicitly approved by Alan"
        drafts.insert(approved, at: 0)
        return true
    }

    static func claimForSending(_ drafts: inout [RicoDraft], id: UUID, paused: Bool, enforcementVerified: Bool) -> RicoDraft? {
        // One authoritative transport operation may hold the current durable
        // receipt proof at a time. A second draft must not consume its grant
        // or enter OpenClaw's per-account queue while the first operation can
        // still degrade that proof.
        guard !paused, enforcementVerified,
              !drafts.contains(where: { $0.state == .sending }),
              let index = drafts.firstIndex(where: { $0.id == id }),
              drafts[index].state == .approved else { return nil }
        drafts[index].state = .sending
        drafts[index].reason = "Sending through the verified OpenClaw iMessage transport…"
        return drafts[index]
    }

    /// A process exit can persist `.sending` after the transport outcome is
    /// no longer knowable by Studio. Never free that row for automatic retry:
    /// turn it into a terminal reviewed item while delivery health starts
    /// unverified and the reconciler re-establishes quarantine.
    @discardableResult
    static func recoverInterruptedSends(_ drafts: inout [RicoDraft]) -> Int {
        var recovered = 0
        for index in drafts.indices where drafts[index].state == .sending {
            drafts[index].state = .blocked
            drafts[index].reason = "Previous send was interrupted; delivery outcome is unknown. Review the conversation before creating a new draft."
            recovered += 1
        }
        return recovered
    }

    @discardableResult
    static func discard(
        _ drafts: inout [RicoDraft],
        id: UUID,
        protectedBy operation: RicoOutboundOperationLease
    ) -> Bool {
        guard !operation.protects(id),
              let index = drafts.firstIndex(where: { $0.id == id }),
              drafts[index].state != .sending else { return false }
        drafts.remove(at: index)
        return true
    }
}

struct RicoOutboundOperationLease: Equatable, Sendable {
    private(set) var draftID: UUID?

    var isHeld: Bool { draftID != nil }

    mutating func claim(_ id: UUID) -> Bool {
        guard draftID == nil else { return false }
        draftID = id
        return true
    }

    mutating func release(_ id: UUID) {
        guard draftID == id else { return }
        draftID = nil
    }

    func protects(_ id: UUID) -> Bool { draftID == id }
}

enum RicoPolicyDecision: Equatable {
    case allow
    case hold(String)
    case block(String)
}

enum RicoMessagePolicy {
    static func evaluate(recipient: RicoRecipientPolicy?, initiatesConversation: Bool, message: String) -> RicoPolicyDecision {
        guard let recipient else { return .hold("Add this person to Rico's approved contacts first.") }
        if recipient.access == .blocked { return .block("This contact is blocked.") }
        if recipient.isQuietNow { return .hold("This contact is inside configured quiet hours.") }
        if initiatesConversation { return .hold("First or proactive outbound messages require your approval.") }
        let sensitive = ["password", "secret", "medical", "diagnosis", "lawyer", "bank", "payment", "promise", "I agree", "Alan confirms"]
        if sensitive.contains(where: { message.localizedCaseInsensitiveContains($0) }) {
            return .hold("Sensitive or commitment-related language requires your approval.")
        }
        return recipient.autoReply ? .allow : .hold("Automatic replies are disabled for this contact.")
    }
}

enum RicoEnforcementState: Equatable, Sendable {
    case applying
    case verified
    case failed(String)
}

enum IMessageProbeReadiness: Equatable, Sendable {
    /// The Gateway channel, account, and native probe are all healthy, but no
    /// concrete send receipt has been recorded since this transport state was
    /// created. This is sufficient to attempt the first governed delivery;
    /// requiring a historical receipt here creates an unrecoverable bootstrap
    /// cycle in which the first send can never occur.
    case transportReady
    case verifiedDelivery
    case deliveryDegraded
    case unavailable

    /// A concrete successful platform receipt is useful delivery telemetry,
    /// but it is not recipient authority and must not be a prerequisite for
    /// the first governed attempt.
    var deliveryVerified: Bool { self == .verifiedDelivery }

    /// Channel/account/native probe liveness is enough to keep admission open.
    /// Delivery telemetry (lastError, awaiting receipt, degraded) is not
    /// recipient authority and must not latch Rico down.
    var transportOperational: Bool {
        self != .unavailable
    }
}

struct IMessageDeliveryVerificationError: LocalizedError, Equatable, Sendable {
    let readiness: IMessageProbeReadiness

    var errorDescription: String? {
        "The iMessage transport is unavailable for a governed delivery attempt."
    }
}

enum RicoIMessageSessionReset {
    static func matchesGroupSession(_ key: String, groupID: String) -> Bool {
        guard !groupID.isEmpty else { return false }
        let escaped = NSRegularExpression.escapedPattern(for: groupID)
        return key.range(of: ":imessage:group:\(escaped)(?::|$)", options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func resetGroup(_ groupID: String) async throws {
        let gateway = GatewayClient()
        var keys = Set<String>()
        for archived in [false, true] {
            var offset: Int?
            var pageCount = 0
            repeat {
                let page = try await gateway.sessions(limit: 200, offset: offset, archived: archived)
                keys.formUnion(page.rows.map(\.key).filter { matchesGroupSession($0, groupID: groupID) })
                offset = page.nextOffset
                pageCount += 1
                if pageCount >= 20 && offset != nil {
                    throw NSError(domain: "OpenClawStudio.RicoSessionReset", code: 1, userInfo: [NSLocalizedDescriptionKey: "Rico could not safely enumerate every matching iMessage session."])
                }
            } while offset != nil
        }
        for key in keys.sorted() {
            let result = try await gateway.call(method: "sessions.reset", params: ["key": key, "reason": "reset"])
            guard result["ok"] as? Bool == true else {
                throw NSError(domain: "OpenClawStudio.RicoSessionReset", code: 2, userInfo: [NSLocalizedDescriptionKey: "OpenClaw did not confirm the group session reset."])
            }
        }
    }
}

@MainActor
final class RicoCommunicationsStore: ObservableObject {
    @Published private(set) var policies: [RicoRecipientPolicy] = []
    @Published var drafts: [RicoDraft] = [] { didSet { if !hydrating { persistDrafts() } } }
    @Published private(set) var globalPaused = false
    @Published private(set) var healthQuarantined = false
    @Published private(set) var outboundDeliveryVerified = false
    @Published private(set) var imessageProbeReadiness: IMessageProbeReadiness?
    /// Store-owned single-flight lease. It is intentionally independent of
    /// mutable draft rows and is cleared only by the owning send completion.
    @Published private var outboundOperationLease = RicoOutboundOperationLease()
    @Published private(set) var enforcementState: RicoEnforcementState = .applying
    @Published var status = ""
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let writerLease: RicoProjectionWriterLease?
    private let projectionEpochAuthority = RicoProjectionEpochAuthority()
    private var hydrating = true
    private var pauseIntentReviewed = false
    private var deliveryObservationGeneration: UInt64 = 0
    private var projectionTask: Task<Void, Never>?
    private var pendingGroupApprovals: [String: UUID] = [:]

    init() {
        let pauseIntent = RicoPauseIntentStore.load()
        globalPaused = pauseIntent.paused
        pauseIntentReviewed = pauseIntent.reviewed
        healthQuarantined = false
        do {
            writerLease = try RicoProjectionWriterLease.acquire()
        } catch let error as RicoProjectionWriterLease.LeaseError {
            writerLease = nil
            enforcementState = .failed(error.localizedDescription)
            switch error {
            case .alreadyOwned:
                status = "This Studio window is read-only because another canonical OpenClaw Studio process owns Rico's policy writer."
            case .unsafeDirectory, .unsafeFile:
                status = "Rico's policy writer is blocked by an unsafe private lease boundary; no writer was assumed to exist."
            case .unavailable:
                status = "Rico's policy writer lease is unavailable; no writer was assumed to exist."
            }
        } catch {
            writerLease = nil
            enforcementState = .failed("Rico's policy writer could not be initialized safely.")
            status = "Rico's policy writer could not be initialized safely; no writer was assumed to exist."
        }
        if let data = UserDefaults.standard.data(forKey: "rico.policies"), let value = try? decoder.decode([RicoRecipientPolicy].self, from: data) { policies = value }
        if let data = UserDefaults.standard.data(forKey: "rico.drafts"), let value = try? decoder.decode([RicoDraft].self, from: data) { drafts = value }
        let recoveredInterruptedSends = RicoDraftQueue.recoverInterruptedSends(&drafts)
        if let ownerHandles = try? RicoRecipientGuard.readOwnerRouteHandles() {
            policies = RicoOwnerIdentityMigration.apply(to: policies, ownerHandles: ownerHandles)
        }
        hydrating = false
        if recoveredInterruptedSends > 0, writerLease != nil { persistDrafts() }
        guard writerLease != nil else { return }
        _ = commitPolicySnapshot(
            policies: policies,
            paused: globalPaused,
            statusMessage: recoveredInterruptedSends > 0
                ? "An interrupted send has an unknown outcome and was blocked from retry; re-verifying current delivery and policy state."
                : "Verifying the saved Rico messaging policy…"
        )
    }

    func approve(contact: LocalContact, address: String, access: RicoAccessLevel) {
        guard RicoOwnerAccessPolicy.canAssign(access, current: nil) else {
            status = "Owner access can only come from Rico's verified local owner identity."
            return
        }
        let normalized = address.contains("@") ? address.lowercased() : ContactResolver.normalizedPhone(address)
        guard !normalized.isEmpty else {
            status = "Approval failed: the selected contact has no usable phone number or email address."
            return
        }
        let policy = RicoRecipientPolicy(id: contact.id + ":" + normalized, contactID: contact.id, displayName: contact.name, address: normalized, access: access, requireMention: access != .owner, autoReply: access != .blocked, quietStart: access == .owner ? 0 : 22, quietEnd: access == .owner ? 0 : 8, groupChatID: nil)
        var proposed = policies
        proposed.removeAll {
            $0.id == policy.id || ($0.groupChatID == nil && RicoRecipientGuard.normalizeTarget($0.address) == normalized)
        }
        proposed.append(policy)
        _ = commitPolicySnapshot(
            policies: proposed,
            paused: globalPaused,
            statusMessage: "Saved in Rico's guard; verifying OpenClaw policy for \(contact.name)…"
        )
    }

    func approve(group: IMessageChat, contacts: [LocalContact] = []) {
        let participants = Array(Set(group.participants.map(RicoRecipientGuard.normalizeTarget).filter { !$0.isEmpty })).sorted()
        guard !participants.isEmpty else {
            status = "Group approval failed: OpenClaw did not return a verified participant snapshot. No group access was granted."
            return
        }
        let participantNames = RicoContactDirectory.displayNames(for: participants, contacts: contacts)
        let friendlyName = RicoGroupDirectoryNaming.friendlyName(for: group, contacts: contacts)
        let previous = policies.first {
            $0.groupChatID == group.id && RicoRecipientGuard.normalizeTarget($0.address) == RicoRecipientGuard.normalizeTarget(group.target)
        }
        let existingPersonality = RicoGroupPersonalityPolicy.valueForExactGroupReapproval(
            policies: policies,
            groupID: group.id,
            target: group.target
        )
        let policy = RicoRecipientPolicy(
            id: "group:\(group.id)",
            contactID: "",
            displayName: friendlyName,
            address: group.target,
            access: .approved,
            requireMention: true,
            autoReply: true,
            quietStart: 22,
            quietEnd: 8,
            groupChatID: group.id,
            participantAddresses: participants,
            participantNames: participantNames,
            groupPersonality: RicoGroupPersonalityPolicy.valueForStorage(existingPersonality)
        )
        var proposed = policies
        proposed.removeAll { $0.id == policy.id }
        proposed.append(policy)
        let needsSessionReset = previous == nil ||
            RicoGroupMembership.normalized(previous?.participantAddresses ?? []) != Set(participants)
        guard needsSessionReset else {
            pendingGroupApprovals.removeValue(forKey: group.id)
            _ = commitPolicySnapshot(
                policies: proposed,
                paused: globalPaused,
                statusMessage: "Saved in Rico's guard; verifying OpenClaw group policy for \(friendlyName)…"
            )
            return
        }
        let approvalToken = UUID()
        pendingGroupApprovals[group.id] = approvalToken
        status = "Archiving the previous group conversation context before approving this exact audience…"
        Task {
            do {
                try await RicoIMessageSessionReset.resetGroup(group.id)
                guard pendingGroupApprovals[group.id] == approvalToken else { return }
                pendingGroupApprovals.removeValue(forKey: group.id)
                _ = commitPolicySnapshot(
                    policies: proposed,
                    paused: globalPaused,
                    statusMessage: "Group audience reset safely; verifying OpenClaw policy for \(friendlyName)…"
                )
            } catch {
                guard pendingGroupApprovals[group.id] == approvalToken else { return }
                pendingGroupApprovals.removeValue(forKey: group.id)
                status = "Group approval remains blocked because its previous conversation context could not be reset: \(error.localizedDescription)"
            }
        }
    }

    func remove(_ policy: RicoRecipientPolicy) {
        if let groupID = policy.groupChatID { pendingGroupApprovals.removeValue(forKey: groupID) }
        let proposed = policies.filter { $0.id != policy.id }
        _ = commitPolicySnapshot(
            policies: proposed,
            paused: globalPaused,
            statusMessage: "Removed from Rico's guard; verifying OpenClaw no longer admits \(policy.displayName)…"
        )
    }

    func update(_ policy: RicoRecipientPolicy) {
        guard let index = policies.firstIndex(where: { $0.id == policy.id }) else { return }
        guard RicoOwnerAccessPolicy.canAssign(policy.access, current: policies[index].access) else {
            status = "Owner access can only come from Rico's verified local owner identity."
            return
        }
        let normalizedPolicy = RicoGroupPersonalityPolicy.applying(policy.groupPersonality, to: policy)
        var proposed = policies
        proposed[index] = normalizedPolicy
        _ = commitPolicySnapshot(
            policies: proposed,
            paused: globalPaused,
            statusMessage: "Saved in Rico's guard; verifying updated access for \(policy.displayName)…"
        )
    }

    func setGlobalPaused(_ paused: Bool) {
        guard RicoPauseIntentTransition.shouldCommit(
            currentPaused: globalPaused,
            reviewed: pauseIntentReviewed,
            requestedPaused: paused
        ) else { return }
        _ = commitPolicySnapshot(
            policies: policies,
            paused: paused,
            persistExplicitPauseIntent: true,
            statusMessage: paused
                ? "Emergency pause is active in Rico's guard; verifying native OpenClaw controls…"
                : "Rico's guard is resumed; verifying native OpenClaw controls…"
        )
    }

    func retryEnforcement() {
        _ = commitPolicySnapshot(
            policies: policies,
            paused: globalPaused,
            forceFullProjection: true,
            statusMessage: "Reapplying Rico's recipient guard and verifying native OpenClaw controls…"
        )
    }

    /// Applies the Gateway's sanitized, durable iMessage delivery attestation.
    /// A read/chats probe can never promote this state; OpenClaw reports
    /// verified delivery only after persisting a concrete platform receipt.
    func beginIMessageProbeObservation() -> UInt64 {
        deliveryObservationGeneration &+= 1
        return deliveryObservationGeneration
    }

    @discardableResult
    func observeIMessageProbe(
        _ readiness: IMessageProbeReadiness,
        generation: UInt64? = nil
    ) -> Bool {
        if let generation, generation != deliveryObservationGeneration { return false }
        publishIMessageReadiness(readiness)
        // A follower Studio window may render the status, but only the
        // process holding the lifetime writer lease may touch either sidecar
        // or schedule native reconciliation.
        guard RicoDeliveryObservationDecision.decide(
            hasWriterLease: writerLease != nil,
            readiness: readiness,
            explicitlyPaused: globalPaused,
            pauseIntentReviewed: pauseIntentReviewed,
            healthQuarantined: healthQuarantined
        ) == .quarantine else { return true }

        return true
    }

    private func publishIMessageReadiness(_ readiness: IMessageProbeReadiness) {
        // Invalidate every older in-flight UI/status observation before
        // publishing this authoritative result. Projection success and send
        // failure use the same boundary, so a stale pre-canary probe cannot
        // overwrite a newer durable receipt (or vice versa).
        deliveryObservationGeneration &+= 1
        imessageProbeReadiness = readiness
        outboundDeliveryVerified = readiness.deliveryVerified
    }

    /// Reconciles an approved sender snapshot without expanding authority.
    /// Any membership change suspends the whole group because even a reply to
    /// an old approved sender would be visible to the changed audience.
    func refreshGroupParticipants(from groups: [IMessageChat], contacts: [LocalContact] = []) {
        var updated = policies
        var changed = false
        var groupsNeedingReview: [String] = []
        for index in updated.indices {
            guard let groupID = updated[index].groupChatID,
                  let group = groups.first(where: { $0.id == groupID }) else { continue }
            let discovered = RicoGroupMembership.normalized(group.participants)
            guard !discovered.isEmpty else { continue }
            let friendlyName = RicoGroupDirectoryNaming.friendlyName(for: group, contacts: contacts)
            if updated[index].displayName != friendlyName {
                updated[index].displayName = friendlyName
                changed = true
            }
            let approved = RicoGroupMembership.normalized(updated[index].participantAddresses ?? [])
            if discovered != approved {
                groupsNeedingReview.append(friendlyName)
                if !approved.isEmpty || !(updated[index].participantNames ?? [:]).isEmpty {
                    // Suspend both inbound and outbound group traffic. Even an
                    // approved sender's reply would be visible to a newly added
                    // audience member, so retaining the old subset is unsafe.
                    updated[index].participantAddresses = []
                    updated[index].participantNames = [:]
                    changed = true
                }
                continue
            }

            let approvedList = approved.sorted()
            let names = RicoContactDirectory.displayNames(for: approvedList, contacts: contacts)
            if names != (updated[index].participantNames ?? [:]) {
                updated[index].participantNames = names
                changed = true
            }
        }
        if changed {
            _ = commitPolicySnapshot(
                policies: updated,
                paused: globalPaused,
                statusMessage: groupsNeedingReview.isEmpty
                    ? "Updated trusted sender names from Contacts; checking OpenClaw policy…"
                    : "Group membership changed. Rico paused that group until you review its current audience."
            )
        } else if !groupsNeedingReview.isEmpty {
            status = "Group membership changed. Rico paused that group until you review its current audience."
        }
    }

    func refreshParticipantNames(from contacts: [LocalContact]) {
        var updated = policies
        var changed = false
        for index in updated.indices where updated[index].groupChatID != nil {
            let participants = updated[index].participantAddresses ?? []
            let names = RicoContactDirectory.displayNames(for: participants, contacts: contacts)
            if names != (updated[index].participantNames ?? [:]) {
                updated[index].participantNames = names
                changed = true
            }
        }
        guard changed else { return }
        _ = commitPolicySnapshot(
            policies: updated,
            paused: globalPaused,
            statusMessage: "Updated trusted sender names from Contacts; checking Rico's guard…"
        )
    }

    func prepareDraft(name: String, address: String, message: String, intent: RicoDraftIntent = .message) -> RicoDraft {
        let policy = policies.first { $0.address == address }
        let decision: RicoPolicyDecision
        if let reason = RicoOutboundAdmission.draftBlockReason(
            explicitlyPaused: globalPaused,
            healthQuarantined: healthQuarantined,
            outboundTransportOperational: imessageProbeReadiness?.transportOperational == true
        ) {
            decision = .block(reason)
        } else {
            decision = RicoMessagePolicy.evaluate(
                recipient: policy,
                initiatesConversation: true,
                message: message
            )
        }
        let reason: String
        let state: RicoDraft.State
        switch decision {
        case .allow: state = .approved; reason = "Policy allowed"
        case .hold(let value): state = .pending; reason = value
        case .block(let value): state = .blocked; reason = value
        }
        return RicoDraft(id: UUID(), createdAt: Date(), recipientName: name, address: address, message: message, intent: intent, state: state, reason: reason)
    }

    func approve(_ draft: RicoDraft) {
        if let index = drafts.firstIndex(where: { $0.id == draft.id }) {
            guard drafts[index].state == .pending else { return }
            drafts[index].state = .approved
            drafts[index].reason = "Explicitly approved by Alan"
            return
        }
        RicoDraftQueue.confirm(draft, into: &drafts)
    }

    func discard(_ draft: RicoDraft) {
        guard RicoDraftQueue.discard(
            &drafts,
            id: draft.id,
            protectedBy: outboundOperationLease
        ) else {
            status = "This draft is still inside the verified OpenClaw transport boundary and cannot be removed until its outcome is reconciled."
            return
        }
        status = "Removed the outbound draft for \(draft.recipientName)."
    }

    func clearFinishedDrafts() {
        let count = drafts.filter { $0.state == .sent || $0.state == .blocked }.count
        drafts.removeAll { $0.state == .sent || $0.state == .blocked }
        status = count == 0 ? "There were no finished drafts to clear." : "Cleared \(count) finished draft\(count == 1 ? "" : "s")."
    }

    func send(_ draft: RicoDraft) async {
        guard outboundOperationLease.claim(draft.id) else {
            status = "Another reviewed iMessage is still awaiting a durable transport receipt."
            return
        }
        var operationClaimed = true
        defer {
            if operationClaimed {
                outboundOperationLease.release(draft.id)
            }
        }
        guard let claimed = RicoDraftQueue.claimForSending(
            &drafts,
            id: draft.id,
            paused: globalPaused,
            enforcementVerified: outboundAdmissionVerified
        ) else {
            outboundOperationLease.release(draft.id)
            operationClaimed = false
            status = "Approve the draft and wait for Rico's live Gateway enforcement to be verified before sending."
            return
        }
        do {
            try await IMessageCommand.send(
                to: claimed.address,
                text: claimed.message,
                idempotencyKey: claimed.id
            )
            let postSendGeneration = beginIMessageProbeObservation()
            let postSendReadiness: IMessageProbeReadiness
            do {
                postSendReadiness = IMessageCommand.probeReadiness(try await IMessageCommand.probe())
            } catch {
                postSendReadiness = .unavailable
            }
            _ = observeIMessageProbe(postSendReadiness, generation: postSendGeneration)
            let effectivePostSendReadiness = imessageProbeReadiness ?? postSendReadiness
            if let index = drafts.firstIndex(where: { $0.id == claimed.id }), drafts[index].state == .sending {
                drafts[index].state = .sent
                drafts[index].reason = "Confirmed by the OpenClaw Gateway"
            }
            switch effectivePostSendReadiness {
            case .verifiedDelivery:
                status = "Sent to \(claimed.recipientName)."
            case .transportReady:
                status = "OpenClaw confirmed the send to \(claimed.recipientName); durable receipt telemetry is still pending."
            case .deliveryDegraded, .unavailable:
                status = "OpenClaw confirmed the send to \(claimed.recipientName). Delivery telemetry is still catching up; admission stays open."
            }
        } catch {
            observeIMessageProbe(.deliveryDegraded)
            if let index = drafts.firstIndex(where: { $0.id == claimed.id }), drafts[index].state == .sending {
                drafts[index].state = .approved
                drafts[index].reason = "Send failed; still approved for an explicit retry."
            }
            status = "iMessage delivery failed. This draft stays approved for an explicit retry. Rico admission remains open."
        }
    }

    var outboundAdmissionVerified: Bool {
        RicoOutboundAdmission.isVerified(
            explicitlyPaused: globalPaused,
            healthQuarantined: healthQuarantined,
            enforcementVerified: enforcementState == .verified,
            outboundTransportOperational: imessageProbeReadiness?.transportOperational == true
        )
    }

    var outboundSendInFlight: Bool {
        outboundOperationLease.isHeld
    }

    func draftIsInFlight(_ id: UUID) -> Bool {
        outboundOperationLease.protects(id) || drafts.first(where: { $0.id == id })?.state == .sending
    }

    var requiresIntentReview: Bool { !pauseIntentReviewed }

    @discardableResult
    private func commitPolicySnapshot(
        policies proposedPolicies: [RicoRecipientPolicy],
        paused proposedPause: Bool,
        persistExplicitPauseIntent: Bool = false,
        forceFullProjection: Bool = false,
        statusMessage: String
    ) -> Bool {
        guard writerLease != nil else {
            enforcementState = .failed("Rico's policy writer is unavailable in this Studio window.")
            status = "This Studio window cannot change Rico until its exact policy-writer lease condition is repaired."
            return false
        }
        let canonicalPolicies = proposedPolicies.map {
            RicoGroupPersonalityPolicy.applying($0.groupPersonality, to: $0)
        }
        let encoded: Data
        do {
            encoded = try encoder.encode(canonicalPolicies)
        } catch {
            enforcementState = .failed(error.localizedDescription)
            status = "Could not encode Rico's reviewed recipient policy."
            return false
        }

        // Invalidate and cancel before the first of the two sidecar files is
        // touched. A partial or failed stage can never leave an older detached
        // activation authorized.
        projectionEpochAuthority.invalidate()
        projectionTask?.cancel()
        do {
            if proposedPause {
                try RicoRecipientGuard.stagePausedPolicyPair(policies: canonicalPolicies)
            } else {
                try RicoRecipientGuard.writePolicy(policies: canonicalPolicies, paused: false)
            }
        } catch {
            enforcementState = .applying
            healthQuarantined = false
            status = "Rico could not write the private guard yet. Admission stays on the last live policy while Studio retries."
            scheduleEmergencyRecoveryAfterStageFailure(
                proposedPolicies: canonicalPolicies,
                encodedPolicies: encoded,
                proposedPause: proposedPause,
                persistExplicitPauseIntent: persistExplicitPauseIntent,
                successStatus: statusMessage
            )
            return false
        }

        if persistExplicitPauseIntent {
            RicoPauseIntentStore.recordExplicit(proposedPause)
            pauseIntentReviewed = true
        }
        UserDefaults.standard.set(encoded, forKey: "rico.policies")
        policies = canonicalPolicies
        globalPaused = proposedPause
        healthQuarantined = false
        enforcementState = .applying
        status = statusMessage
        scheduleNativeProjection(
            policies: canonicalPolicies,
            paused: proposedPause,
            initialSidecarStaged: true,
            forceFullProjection: forceFullProjection
        )
        return true
    }

    private func scheduleEmergencyRecoveryAfterStageFailure(
        proposedPolicies: [RicoRecipientPolicy],
        encodedPolicies: Data,
        proposedPause: Bool,
        persistExplicitPauseIntent: Bool,
        successStatus: String
    ) {
        let currentMode = RicoProjectionMode.desired(
            paused: globalPaused,
            reviewed: pauseIntentReviewed
        )
        let epoch = projectionEpochAuthority.begin(desiredMode: currentMode)
        let attestCurrent: @Sendable () async throws -> Void = { @MainActor [weak self] in
            guard let self else { throw RicoProjectionEpochAuthority.EpochError.stale }
            let liveMode = RicoProjectionMode.desired(
                paused: self.globalPaused,
                reviewed: self.pauseIntentReviewed
            )
            try self.projectionEpochAuthority.attest(epoch, currentMode: liveMode)
        }
        projectionTask = Task {
            var failures = 0
            while !Task.isCancelled {
                let liveMode = RicoProjectionMode.desired(
                    paused: globalPaused,
                    reviewed: pauseIntentReviewed
                )
                guard projectionEpochAuthority.isCurrent(epoch, currentMode: liveMode) else { return }
                do {
                    try await attestCurrent()
                    enforcementState = .applying
                    healthQuarantined = false
                    status = "Rico is retrying the private guard write. Live admission stays open."

                    try projectionEpochAuthority.performIfCurrent(epoch, currentMode: liveMode) {
                        if proposedPause {
                            try RicoRecipientGuard.stagePausedPolicyPair(policies: proposedPolicies)
                        } else {
                            try RicoRecipientGuard.writePolicy(policies: proposedPolicies, paused: false)
                        }
                    }
                    if persistExplicitPauseIntent {
                        RicoPauseIntentStore.recordExplicit(proposedPause)
                        pauseIntentReviewed = true
                    }
                    UserDefaults.standard.set(encodedPolicies, forKey: "rico.policies")
                    policies = proposedPolicies
                    globalPaused = proposedPause
                    healthQuarantined = false
                    enforcementState = .applying
                    status = successStatus
                    scheduleNativeProjection(
                        policies: proposedPolicies,
                        paused: proposedPause,
                        initialSidecarStaged: true
                    )
                    return
                } catch {
                    let retryMode = RicoProjectionMode.desired(
                        paused: globalPaused,
                        reviewed: pauseIntentReviewed
                    )
                    guard projectionEpochAuthority.isCurrent(epoch, currentMode: retryMode),
                          !Task.isCancelled else { return }
                    failures += 1
                    enforcementState = .applying
                    healthQuarantined = false
                    status = "Rico has not accepted the requested policy change yet. Live admission stays open while Studio retries."
                    do {
                        try await Task.sleep(nanoseconds: RicoProjectionRetryPolicy.delay(afterFailure: failures))
                    } catch { return }
                }
            }
        }
    }

    private func persistDrafts() {
        if let data = try? encoder.encode(drafts) { UserDefaults.standard.set(data, forKey: "rico.drafts") }
    }

    private func scheduleNativeProjection(
        policies snapshot: [RicoRecipientPolicy],
        paused: Bool,
        initialSidecarStaged: Bool,
        forceFullProjection: Bool = false
    ) {
        // Epoch attestation prevents stale writes, and bounded child commands
        // observe task cancellation. Never await a predecessor here: an
        // explicit Pause must be able to stage and start recovery immediately.
        projectionTask?.cancel()
        let reviewedPauseIntent = pauseIntentReviewed
        let desiredMode = RicoProjectionMode.desired(paused: paused, reviewed: reviewedPauseIntent)
        let epoch = projectionEpochAuthority.begin(desiredMode: desiredMode)
        let attestCurrent: @Sendable () async throws -> Void = { @MainActor [weak self] in
            guard let self else { throw RicoProjectionEpochAuthority.EpochError.stale }
            let currentMode = RicoProjectionMode.desired(
                paused: self.globalPaused,
                reviewed: self.pauseIntentReviewed
            )
            try self.projectionEpochAuthority.attest(epoch, currentMode: currentMode)
        }
        let writeAdmissionPaused: @Sendable (Bool) async throws -> Void = { @MainActor [weak self] targetPaused in
            guard let self else { throw RicoProjectionEpochAuthority.EpochError.stale }
            let currentMode = RicoProjectionMode.desired(
                paused: self.globalPaused,
                reviewed: self.pauseIntentReviewed
            )
            // Health verification must never overwrite a live unpaused guard.
            // Only an explicit Pause may write paused:true.
            let shouldPause = targetPaused && currentMode == .explicitPause
            if shouldPause,
               !self.projectionEpochAuthority.isCurrent(epoch, currentMode: currentMode),
               RicoRecipientGuard.readPausedState() == true {
                return
            }
            try self.projectionEpochAuthority.performIfCurrent(epoch, currentMode: currentMode) {
                if shouldPause {
                    try RicoRecipientGuard.stagePausedPolicyPair(policies: snapshot)
                } else {
                    try RicoRecipientGuard.writePolicy(policies: snapshot, paused: false)
                }
            }
        }
        let stageIntendedAdmission: @Sendable () async throws -> Void = { @MainActor [weak self] in
            guard let self else { throw RicoProjectionEpochAuthority.EpochError.stale }
            let currentMode = RicoProjectionMode.desired(
                paused: self.globalPaused,
                reviewed: self.pauseIntentReviewed
            )
            try self.projectionEpochAuthority.performIfCurrent(epoch, currentMode: currentMode) {
                if currentMode == .explicitPause {
                    try RicoRecipientGuard.stagePausedPolicyPair(policies: snapshot)
                } else {
                    try RicoRecipientGuard.writePolicy(policies: snapshot, paused: false)
                }
            }
        }
        let liveGuardPaused = RicoRecipientGuard.readPausedState()
        let nativeAllowlistsMatch = desiredMode == .active
            && RicoNativePolicyProjection.reviewedAllowlistsMatchLiveNative(policies: snapshot)
        let launchDecision = RicoLaunchPolicySync.decide(
            desiredMode: desiredMode,
            liveGuardPaused: liveGuardPaused,
            nativeAllowlistsMatch: nativeAllowlistsMatch
        )
        let paintsVerifiedImmediately = !forceFullProjection && launchDecision.paintsVerifiedImmediately
        if paintsVerifiedImmediately {
            enforcementState = .verified
            healthQuarantined = false
            status = "Rico's live guard is unpaused and native iMessage allowlists already match the reviewed policy."
        }

        projectionTask = Task {
            let initialMode = RicoProjectionMode.desired(
                paused: globalPaused,
                reviewed: pauseIntentReviewed
            )
            guard projectionEpochAuthority.isCurrent(epoch, currentMode: initialMode) else { return }
            var sidecarStaged = initialSidecarStaged
            if sidecarStaged {
                let skipDebounce = paintsVerifiedImmediately
                    || RicoLaunchPolicySync.shouldSkipLaunchDebounce(
                        desiredMode: desiredMode,
                        liveGuardPaused: liveGuardPaused
                    )
                let launchDelay = skipDebounce
                    ? 0
                    : RicoProjectionRetryPolicy.launchDelayNanoseconds(liveGuardPaused: liveGuardPaused)
                if launchDelay > 0 {
                    do {
                        try await Task.sleep(nanoseconds: launchDelay)
                    } catch { return }
                }
            } else if !paintsVerifiedImmediately {
                enforcementState = .applying
                healthQuarantined = false
                status = desiredMode == .explicitPause
                    ? "Rico's explicit Pause is being written. Studio will retry the private guard."
                    : "Rico is verifying native policy. Live admission stays open."
            }

            var failures = 0
            var activeVerified = paintsVerifiedImmediately
            var skipNextProjection = paintsVerifiedImmediately
            while !Task.isCancelled {
                let loopMode = RicoProjectionMode.desired(
                    paused: globalPaused,
                    reviewed: pauseIntentReviewed
                )
                guard projectionEpochAuthority.isCurrent(epoch, currentMode: loopMode) else { return }
                if skipNextProjection {
                    skipNextProjection = false
                    failures = 0
                    activeVerified = desiredMode == .active
                    do {
                        try await Task.sleep(nanoseconds: RicoProjectionRetryPolicy.healthyAuditNanoseconds)
                    } catch { return }
                    continue
                }
                if !sidecarStaged {
                    do {
                        try await stageIntendedAdmission()
                        sidecarStaged = true
                    } catch {
                        failures += 1
                        if enforcementState != .verified {
                            enforcementState = .applying
                        }
                        healthQuarantined = false
                        status = desiredMode == .explicitPause
                            ? "Rico remains paused in the local guard; Studio will retry the private write."
                            : "Rico could not refresh the private guard yet. Live admission stays open while Studio retries."
                        let delay = RicoProjectionRetryPolicy.delay(afterFailure: failures)
                        do { try await Task.sleep(nanoseconds: delay) } catch { return }
                        continue
                    }
                }
                do {
                    let activeAttempt: RicoActiveProjectionAttempt = activeVerified
                        ? .healthyAudit
                        : .stagedActivation
                    if desiredMode == .explicitPause {
                        try await stageIntendedAdmission()
                    }
                    let summary = try await RicoNativePolicyProjection.apply(
                        policies: snapshot,
                        mode: desiredMode,
                        activeAttempt: activeAttempt,
                        attestCurrent: attestCurrent,
                        writeAdmissionPaused: writeAdmissionPaused
                    )
                    try await attestCurrent()
                    enforcementState = .verified
                    healthQuarantined = false
                    status = summary
                    failures = 0
                    activeVerified = desiredMode == .active
                    do {
                        try await Task.sleep(nanoseconds: RicoProjectionRetryPolicy.healthyAuditNanoseconds)
                    } catch { return }
                } catch {
                    let catchMode = RicoProjectionMode.desired(
                        paused: globalPaused,
                        reviewed: pauseIntentReviewed
                    )
                    guard projectionEpochAuthority.isCurrent(epoch, currentMode: catchMode),
                          !Task.isCancelled else { return }
                    failures += 1
                    // A failed proof must be allowed to repair. Only a prior
                    // verified paint stays on cheap healthy audits.
                    activeVerified = enforcementState == .verified
                        && desiredMode == .active
                        && RicoRecipientGuard.readPausedState() == false
                    if let deliveryError = error as? IMessageDeliveryVerificationError {
                        publishIMessageReadiness(deliveryError.readiness)
                    }

                    if enforcementState != .verified {
                        enforcementState = .applying
                    }
                    healthQuarantined = false
                    status = desiredMode == .explicitPause
                        ? "Rico remains paused in the local guard; Studio will retry native verification automatically."
                        : "Rico is still verifying the local model, Gateway, or native policy. Admission stays open; Studio will retry automatically."

                    let delay = RicoProjectionRetryPolicy.delay(afterFailure: failures)
                    do {
                        try await Task.sleep(nanoseconds: delay)
                    } catch { return }
                }
            }
        }
    }

}

enum RicoRecipientGuard {
    enum PolicyWriteStage: Equatable {
        case beforePolicy
        case afterPolicy
    }

    enum PolicyPairError: LocalizedError, Equatable {
        case cleanupFailed

        var errorDescription: String? {
            "Rico could not finish and verify its paused recipient/owner-route sidecar pair."
        }
    }

    private static var supportDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/OpenClaw Studio", isDirectory: true)
    }

    static var policyURL: URL { supportDirectory.appendingPathComponent("rico-recipient-guard.json") }
    static var ownerRoutePolicyURL: URL { supportDirectory.appendingPathComponent("rico-owner-command-route.json") }
    static var grantsDirectoryURL: URL { supportDirectory.appendingPathComponent("owner-send-grants", isDirectory: true) }

    static func normalizeTarget(_ value: String) -> String {
        let raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.lowercased().hasPrefix("chat_id:") || raw.lowercased().hasPrefix("chat_guid:") || raw.lowercased().hasPrefix("chat_identifier:") {
            let parts = raw.split(separator: ":", maxSplits: 1)
            return parts.count == 2 ? "\(parts[0].lowercased()):\(parts[1])" : raw.lowercased()
        }
        if raw.contains("@") { return raw.lowercased() }
        return ContactResolver.normalizedPhone(raw)
    }

    static func readOwnerRouteHandles(in directory: URL? = nil) throws -> [String] {
        let root = directory ?? supportDirectory
        let route = root.appendingPathComponent("rico-owner-command-route.json")
        let rootAttributes = try FileManager.default.attributesOfItem(atPath: root.path)
        guard rootAttributes[.type] as? FileAttributeType == .typeDirectory,
              (rootAttributes[.posixPermissions] as? NSNumber)?.intValue == 0o700 else {
            throw NSError(domain: "OpenClawStudio.Rico", code: 42, userInfo: [NSLocalizedDescriptionKey: "Owner route directory is not private."])
        }
        let routeAttributes = try FileManager.default.attributesOfItem(atPath: route.path)
        guard routeAttributes[.type] as? FileAttributeType == .typeRegular,
              (routeAttributes[.posixPermissions] as? NSNumber)?.intValue == 0o600 else {
            throw NSError(domain: "OpenClawStudio.Rico", code: 43, userInfo: [NSLocalizedDescriptionKey: "Owner route file is not private."])
        }
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: route)) as? [String: Any]
        guard object?["schemaVersion"] as? Int == 1,
              object?["enabled"] as? Bool == true,
              let handles = object?["ownerHandles"] as? [String],
              handles.count == 1 else {
            throw NSError(domain: "OpenClawStudio.Rico", code: 44, userInfo: [NSLocalizedDescriptionKey: "Owner route is unavailable or ambiguous."])
        }
        return handles
    }

    static func readPausedState(in directory: URL? = nil) -> Bool? {
        let root = directory ?? supportDirectory
        let policy = root.appendingPathComponent("rico-recipient-guard.json")
        var rootStat = stat()
        guard lstat(root.path, &rootStat) == 0,
              rootStat.st_mode & S_IFMT == S_IFDIR,
              rootStat.st_mode & 0o777 == 0o700,
              rootStat.st_uid == getuid() else { return nil }

        let descriptor = Darwin.open(policy.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { return nil }
        defer { Darwin.close(descriptor) }
        var before = stat()
        guard fstat(descriptor, &before) == 0,
              before.st_mode & S_IFMT == S_IFREG,
              before.st_mode & 0o777 == 0o600,
              before.st_uid == getuid(),
              before.st_nlink == 1,
              before.st_size > 0,
              before.st_size <= 4 * 1_024 * 1_024 else { return nil }
        do {
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
            let data = try handle.readToEnd() ?? Data()
            var after = stat()
            guard fstat(descriptor, &after) == 0,
                  before.st_dev == after.st_dev,
                  before.st_ino == after.st_ino,
                  before.st_size == after.st_size,
                  data.count == Int(after.st_size),
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  object["schemaVersion"] as? Int == 2,
                  let paused = object["paused"] as? Bool else { return nil }
            return paused
        } catch {
            return nil
        }
    }

    static func pausedPairVerified(
        policies: [RicoRecipientPolicy]? = nil,
        in directory: URL? = nil
    ) -> Bool {
        let root = directory ?? supportDirectory
        guard readPausedState(in: root) == true,
              let policyObject = readPrivateJSONObject(
                root.appendingPathComponent("rico-recipient-guard.json"),
                maximumBytes: 4 * 1_024 * 1_024
              ) else { return false }
        let route = root.appendingPathComponent("rico-owner-command-route.json")
        guard let routeObject = readPrivateJSONObject(route, maximumBytes: 1_024 * 1_024),
              policyObject["schemaVersion"] as? Int == 2,
              policyObject["paused"] as? Bool == true,
              policyObject["mentionPatterns"] as? [String] == ["@rico"],
              routeObject["schemaVersion"] as? Int == 1,
              routeObject["enabled"] as? Bool == false,
              let notBefore = routeObject["notBeforeMs"] as? NSNumber,
              notBefore.doubleValue.isFinite else { return false }
        guard let policies else { return true }
        let expectedIdentities = projectedIdentities(policies)
        guard jsonEquivalent(policyObject["identities"], expectedIdentities) else { return false }
        let expectedOwners = projectedOwnerHandles(policies)
        let expectedGroups = projectedAllowedGroupChatIDs(policies)
        guard routeObject["ownerHandles"] as? [String] == expectedOwners,
              routeObject["allowedGroupChatIds"] as? [Int] == expectedGroups else { return false }
        let managedGroups = Set(policyObject["managedGroupIDs"] as? [String] ?? [])
        let managedOwners = Set(policyObject["managedOwnerHandles"] as? [String] ?? [])
        guard managedGroups.isSuperset(of: Set(policies.compactMap(\.groupChatID))),
              managedOwners.isSuperset(of: Set(expectedOwners)) else { return false }
        return true
    }

    private static func readPrivateJSONObject(_ url: URL, maximumBytes: Int) -> [String: Any]? {
        let descriptor = Darwin.open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { return nil }
        defer { Darwin.close(descriptor) }
        var before = stat()
        guard fstat(descriptor, &before) == 0,
              before.st_mode & S_IFMT == S_IFREG,
              before.st_mode & 0o777 == 0o600,
              before.st_uid == getuid(),
              before.st_nlink == 1,
              before.st_size > 0,
              before.st_size <= maximumBytes else { return nil }
        do {
            let data = try FileHandle(fileDescriptor: descriptor, closeOnDealloc: false).readToEnd() ?? Data()
            var after = stat()
            guard fstat(descriptor, &after) == 0,
                  before.st_dev == after.st_dev,
                  before.st_ino == after.st_ino,
                  before.st_size == after.st_size,
                  data.count == Int(after.st_size) else { return nil }
            return try JSONSerialization.jsonObject(with: data) as? [String: Any]
        } catch {
            return nil
        }
    }

    /// Stages both private sidecars paused. If the recipient-policy write
    /// succeeds and the owner-route write fails, retry the pair immediately
    /// without the injected/transient fault and verify both boundaries before
    /// returning the original error. A failed cleanup is a hard safety error.
    static func stagePausedPolicyPair(
        policies: [RicoRecipientPolicy],
        in directory: URL? = nil,
        fault: ((PolicyWriteStage) throws -> Void)? = nil
    ) throws {
        if fault == nil, pausedPairVerified(policies: policies, in: directory) { return }
        do {
            try writePolicy(policies: policies, paused: true, in: directory, fault: fault)
            guard pausedPairVerified(policies: policies, in: directory) else { throw PolicyPairError.cleanupFailed }
        } catch {
            let originalError = error
            guard readPausedState(in: directory) == true else { throw originalError }
            do {
                try writePolicy(policies: policies, paused: true, in: directory)
                guard pausedPairVerified(policies: policies, in: directory) else { throw PolicyPairError.cleanupFailed }
            } catch {
                throw PolicyPairError.cleanupFailed
            }
            throw originalError
        }
    }

    private static func projectedOwnerHandles(_ policies: [RicoRecipientPolicy]) -> [String] {
        Array(Set(policies.compactMap { policy -> String? in
            guard policy.groupChatID == nil, policy.access == .owner, policy.autoReply else { return nil }
            let target = normalizeTarget(policy.address)
            return target.isEmpty ? nil : target
        })).sorted()
    }

    private static func projectedAllowedGroupChatIDs(_ policies: [RicoRecipientPolicy]) -> [Int] {
        Array(Set(policies.compactMap { policy -> Int? in
            guard policy.access != .blocked, policy.autoReply,
                  let rawID = policy.groupChatID,
                  let id = Int(rawID), id > 0 else { return nil }
            return id
        })).sorted()
    }

    private static func projectedIdentities(_ policies: [RicoRecipientPolicy]) -> [[String: Any]] {
        policies.map { policy in
            var value: [String: Any] = [
                "target": normalizeTarget(policy.address),
                "kind": policy.groupChatID == nil ? "individual" : "group",
                "access": accessKey(policy.access),
                "requireMention": policy.requireMention,
                "autoReply": policy.autoReply,
                "quietStart": policy.quietStart,
                "quietEnd": policy.quietEnd,
            ]
            let displayName = RicoContactDirectory.safeDisplayName(policy.displayName)
            if !displayName.isEmpty { value["displayName"] = displayName }
            if let groupID = policy.groupChatID {
                value["groupChatID"] = groupID
                let participants = Array(Set((policy.participantAddresses ?? []).map(normalizeTarget).filter { !$0.isEmpty })).sorted()
                value["participants"] = participants
                let allowed = Set(participants)
                value["participantNames"] = (policy.participantNames ?? [:]).reduce(into: [String: String]()) { result, entry in
                    let target = normalizeTarget(entry.key)
                    let name = RicoContactDirectory.safeDisplayName(entry.value)
                    if allowed.contains(target), !name.isEmpty { result[target] = name }
                }
                if let personality = RicoGroupPersonalityPolicy.valueForStorage(policy.groupPersonality) {
                    value["personality"] = personality
                }
            }
            return value
        }
    }

    private static func jsonEquivalent(_ lhs: Any?, _ rhs: Any) -> Bool {
        guard let lhs,
              JSONSerialization.isValidJSONObject(["value": lhs]),
              JSONSerialization.isValidJSONObject(["value": rhs]),
              let left = try? JSONSerialization.data(withJSONObject: ["value": lhs], options: [.sortedKeys]),
              let right = try? JSONSerialization.data(withJSONObject: ["value": rhs], options: [.sortedKeys]) else {
            return false
        }
        return left == right
    }

    static func writePolicy(
        policies: [RicoRecipientPolicy],
        paused: Bool,
        in directory: URL? = nil,
        fault: ((PolicyWriteStage) throws -> Void)? = nil
    ) throws {
        let root = directory ?? supportDirectory
        try secureDirectory(root)
        try secureDirectory(root.appendingPathComponent("owner-send-grants", isDirectory: true))

        let destination = root.appendingPathComponent("rico-recipient-guard.json")
        try requireRegularFileIfPresent(destination)
        let existing = (try? JSONSerialization.jsonObject(with: Data(contentsOf: destination))) as? [String: Any]
        let previousManaged = existing?["managedGroupIDs"] as? [String] ?? []
        let currentGroups = policies.compactMap(\.groupChatID)
        let managedGroupIDs = Array(Set(previousManaged + currentGroups)).sorted()
        let ownerHandles = projectedOwnerHandles(policies)
        let previousOwners = existing?["managedOwnerHandles"] as? [String] ?? []
        let managedOwnerHandles = Array(Set(previousOwners + ownerHandles)).sorted()
        let sharedSenderHandles = Array(Set(policies.compactMap { policy -> String? in
            guard policy.groupChatID == nil, policy.access != .blocked, policy.access != .owner, policy.autoReply else { return nil }
            let target = normalizeTarget(policy.address)
            return target.isEmpty ? nil : target
        })).sorted()
        let previousSharedSenders = existing?["managedSharedSenderHandles"] as? [String] ?? []
        let managedSharedSenderHandles = Array(Set(previousSharedSenders + sharedSenderHandles)).sorted()
        let sharedBindingTargets = Array(Set(policies.compactMap { policy -> String? in
            guard policy.access != .blocked, policy.autoReply else { return nil }
            if let groupID = policy.groupChatID?.trimmingCharacters(in: .whitespacesAndNewlines) {
                guard !groupID.isEmpty, !(policy.participantAddresses ?? []).isEmpty else { return nil }
                return "group:\(groupID)"
            }
            guard policy.access != .owner else { return nil }
            let target = normalizeTarget(policy.address)
            return target.isEmpty ? nil : "direct:\(target)"
        })) .sorted()
        let previousBindingTargets = existing?["managedSharedBindingTargets"] as? [String] ?? []
        let managedSharedBindingTargets = Array(Set(previousBindingTargets + sharedBindingTargets)).sorted()
        let identities = projectedIdentities(policies)
        let object: [String: Any] = [
            "schemaVersion": 2,
            "paused": paused,
            "mentionPatterns": ["@rico"],
            "managedGroupIDs": managedGroupIDs,
            "managedOwnerHandles": managedOwnerHandles,
            "managedSharedSenderHandles": managedSharedSenderHandles,
            "managedSharedBindingTargets": managedSharedBindingTargets,
            "identities": identities,
        ]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        try fault?(.beforePolicy)
        try secureAtomicWrite(data, to: destination)
        try fault?(.afterPolicy)

        let allowedGroupChatIDs = projectedAllowedGroupChatIDs(policies)
        let ownerRouteURL = root.appendingPathComponent("rico-owner-command-route.json")
        let existingOwnerRoute = (try? JSONSerialization.jsonObject(with: Data(contentsOf: ownerRouteURL))) as? [String: Any]
        let routeEnabled = !paused && !ownerHandles.isEmpty && !allowedGroupChatIDs.isEmpty
        let existingNotBefore = (existingOwnerRoute?["notBeforeMs"] as? NSNumber)?.doubleValue
        let sameActiveScope = routeEnabled && existingOwnerRoute?["enabled"] as? Bool == true &&
            (existingOwnerRoute?["ownerHandles"] as? [String] ?? []) == ownerHandles &&
            (existingOwnerRoute?["allowedGroupChatIds"] as? [Int] ?? []) == allowedGroupChatIDs
        let notBeforeMs = sameActiveScope && existingNotBefore?.isFinite == true
            ? existingNotBefore!
            : Date().timeIntervalSince1970 * 1000
        let ownerRoute: [String: Any] = [
            "schemaVersion": 1,
            "enabled": routeEnabled,
            "ownerHandles": ownerHandles,
            "allowedGroupChatIds": allowedGroupChatIDs,
            "notBeforeMs": notBeforeMs,
        ]
        let ownerRouteData = try JSONSerialization.data(withJSONObject: ownerRoute, options: [.prettyPrinted, .sortedKeys])
        try secureAtomicWrite(ownerRouteData, to: ownerRouteURL)
    }

    @discardableResult
    static func authorizeOwnerSend(target: String, message: String, in directory: URL? = nil) throws -> URL {
        let root = directory ?? supportDirectory
        try secureDirectory(root)
        let grants = root.appendingPathComponent("owner-send-grants", isDirectory: true)
        try secureDirectory(grants)
        let object: [String: Any] = [
            "schemaVersion": 1,
            "target": normalizeTarget(target),
            "messageSHA256": sha256(message),
            "expiresAt": Date().addingTimeInterval(120).timeIntervalSince1970
        ]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let destination = grants.appendingPathComponent("\(UUID().uuidString.lowercased()).json")
        try secureAtomicWrite(data, to: destination)
        return destination
    }

    static func sha256(_ message: String) -> String {
        SHA256.hash(data: Data(message.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func accessKey(_ access: RicoAccessLevel) -> String {
        switch access {
        case .blocked: "blocked"
        case .approved: "approved"
        case .trusted: "trusted"
        case .owner: "owner"
        }
    }

    private static func secureDirectory(_ url: URL) throws {
        if let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
           attributes[.type] as? FileAttributeType != .typeDirectory {
            throw NSError(domain: "OpenClawStudio.Rico", code: 40, userInfo: [NSLocalizedDescriptionKey: "Refusing a non-directory Rico support path: \(url.path)"])
        }
        try FileManager.default.createDirectory(
            at: url,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory else {
            throw NSError(domain: "OpenClawStudio.Rico", code: 40, userInfo: [NSLocalizedDescriptionKey: "Refusing a non-directory Rico support path: \(url.path)"])
        }
    }

    private static func secureAtomicWrite(_ data: Data, to destination: URL) throws {
        try requireRegularFileIfPresent(destination)
        try data.write(to: destination, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
        try requireRegularFileIfPresent(destination)
    }

    private static func requireRegularFileIfPresent(_ url: URL) throws {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path) else { return }
        guard attributes[.type] as? FileAttributeType == .typeRegular else {
            throw NSError(domain: "OpenClawStudio.Rico", code: 41, userInfo: [NSLocalizedDescriptionKey: "Refusing a non-regular Rico policy file: \(url.path)"])
        }
    }
}

enum RicoOwnerRouteInstaller {
    private static var binDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/OpenClaw Studio/bin", isDirectory: true)
    }

    // OpenClaw recognizes local iMessage behavior by the executable basename.
    // Keep the stable installed name exactly `imsg` while the bundled source
    // remains descriptively named for development.
    static func ensureInstalled() async throws -> String {
        guard let source = Bundle.main.resourceURL?
            .appendingPathComponent("RicoOwnerRoute", isDirectory: true)
            .appendingPathComponent("imsg-owner-route.mjs"),
              FileManager.default.fileExists(atPath: source.path) else {
            throw NSError(domain: "OpenClawStudio.RicoOwnerRoute", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "The signed app is missing Rico's bundled iMessage owner route. Reinstall OpenClaw Studio before resuming messaging."
            ])
        }
        try requireRegularSource(source)
        let sourceData = try Data(contentsOf: source)
        let version = SHA256.hash(data: sourceData).map { String(format: "%02x", $0) }.joined()
        try ensurePrivateDirectory(binDirectory)
        let destination = binDirectory
            .appendingPathComponent(version, isDirectory: true)
            .appendingPathComponent("imsg")
        return try await ensureInstalled(source: source, destination: destination, sourceData: sourceData)
    }

    static func ensureInstalled(source: URL, destination: URL) async throws -> String {
        try requireRegularSource(source)
        let sourceData = try Data(contentsOf: source)
        return try await ensureInstalled(source: source, destination: destination, sourceData: sourceData)
    }

    private static func ensureInstalled(source: URL, destination: URL, sourceData: Data) async throws -> String {
        if installedMatches(sourceData: sourceData, destination: destination) {
            return destination.path
        }
        try await install(source: source, destination: destination)
        return destination.path
    }

    private static func requireRegularSource(_ source: URL) throws {
        let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else {
            throw NSError(domain: "OpenClawStudio.RicoOwnerRoute", code: 2, userInfo: [NSLocalizedDescriptionKey: "Rico's bundled owner route is not a regular file."])
        }
    }

    static func install(source: URL, destination: URL) async throws {
        let manager = FileManager.default
        let sourceValues = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard sourceValues.isRegularFile == true, sourceValues.isSymbolicLink != true else {
            throw NSError(domain: "OpenClawStudio.RicoOwnerRoute", code: 2, userInfo: [NSLocalizedDescriptionKey: "Rico's bundled owner route is not a regular file."])
        }
        let directory = destination.deletingLastPathComponent()
        try ensurePrivateDirectory(directory)
        let directoryValues = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard directoryValues.isDirectory == true, directoryValues.isSymbolicLink != true else {
            throw NSError(domain: "OpenClawStudio.RicoOwnerRoute", code: 3, userInfo: [NSLocalizedDescriptionKey: "Rico's owner-route directory is unsafe."])
        }
        if manager.fileExists(atPath: destination.path) {
            let existing = try destination.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard existing.isRegularFile == true, existing.isSymbolicLink != true else {
                throw NSError(domain: "OpenClawStudio.RicoOwnerRoute", code: 4, userInfo: [NSLocalizedDescriptionKey: "Rico refused to replace an unsafe owner-route path."])
            }
        }
        let sourceData = try Data(contentsOf: source)
        try sourceData.write(to: destination, options: .atomic)
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: destination.path)
        let installedData = try Data(contentsOf: destination)
        guard SHA256.hash(data: sourceData) == SHA256.hash(data: installedData) else {
            throw NSError(domain: "OpenClawStudio.RicoOwnerRoute", code: 5, userInfo: [NSLocalizedDescriptionKey: "Rico could not verify the installed owner route."])
        }
        let validation = try await BoundedProcessRunner.run(
            executable: URL(fileURLWithPath: "/opt/homebrew/bin/node"),
            arguments: ["--check", destination.path],
            timeoutSeconds: 5,
            maxOutputBytes: 1_024 * 1_024
        )
        guard validation.status == 0 else {
            throw NSError(domain: "OpenClawStudio.RicoOwnerRoute", code: 6, userInfo: [NSLocalizedDescriptionKey: "Rico's installed owner route failed bounded syntax validation."])
        }
    }

    private static func ensurePrivateDirectory(_ url: URL) throws {
        let manager = FileManager.default
        var fileStat = stat()
        if lstat(url.path, &fileStat) == 0 {
            guard fileStat.st_mode & S_IFMT == S_IFDIR,
                  fileStat.st_uid == getuid() else {
                throw NSError(domain: "OpenClawStudio.RicoOwnerRoute", code: 3, userInfo: [NSLocalizedDescriptionKey: "Rico's owner-route directory is unsafe."])
            }
            if fileStat.st_mode & 0o777 != 0o700 {
                try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
            }
        } else {
            guard errno == ENOENT else {
                throw NSError(domain: "OpenClawStudio.RicoOwnerRoute", code: 3, userInfo: [NSLocalizedDescriptionKey: "Rico's owner-route directory is unavailable."])
            }
            try manager.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        guard lstat(url.path, &fileStat) == 0,
              fileStat.st_mode & S_IFMT == S_IFDIR,
              fileStat.st_mode & 0o777 == 0o700,
              fileStat.st_uid == getuid() else {
            throw NSError(domain: "OpenClawStudio.RicoOwnerRoute", code: 3, userInfo: [NSLocalizedDescriptionKey: "Rico's owner-route directory failed its private boundary check."])
        }
    }

    private static func installedMatches(sourceData: Data, destination: URL) -> Bool {
        var directoryStat = stat()
        var fileStat = stat()
        let directory = destination.deletingLastPathComponent()
        guard lstat(directory.path, &directoryStat) == 0,
              directoryStat.st_mode & S_IFMT == S_IFDIR,
              directoryStat.st_mode & 0o777 == 0o700,
              directoryStat.st_uid == getuid(),
              lstat(destination.path, &fileStat) == 0,
              fileStat.st_mode & S_IFMT == S_IFREG,
              fileStat.st_mode & 0o777 == 0o700,
              fileStat.st_uid == getuid(),
              fileStat.st_nlink == 1,
              let installedData = try? Data(contentsOf: destination),
              SHA256.hash(data: installedData) == SHA256.hash(data: sourceData) else { return false }
        return true
    }
}

enum RicoSharedWorkspace {
    static var directory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".openclaw/workspace-rico-shared", isDirectory: true)
    }

    static func ensureInstalled(in overrideDirectory: URL? = nil) throws -> String {
        let manager = FileManager.default
        let root = overrideDirectory ?? directory
        var rootStat = stat()
        if lstat(root.path, &rootStat) == 0 {
            guard rootStat.st_mode & S_IFMT == S_IFDIR,
                  rootStat.st_uid == getuid() else {
                throw NSError(domain: "OpenClawStudio.RicoSharedWorkspace", code: 1, userInfo: [NSLocalizedDescriptionKey: "Rico's shared workspace path is not a private directory."])
            }
            if rootStat.st_mode & 0o777 != 0o700 {
                try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
            }
        } else {
            guard errno == ENOENT else {
                throw NSError(domain: "OpenClawStudio.RicoSharedWorkspace", code: 1, userInfo: [NSLocalizedDescriptionKey: "Rico's shared workspace path is unavailable."])
            }
            try manager.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        guard lstat(root.path, &rootStat) == 0,
              rootStat.st_mode & S_IFMT == S_IFDIR,
              rootStat.st_mode & 0o777 == 0o700,
              rootStat.st_uid == getuid() else {
            throw NSError(domain: "OpenClawStudio.RicoSharedWorkspace", code: 1, userInfo: [NSLocalizedDescriptionKey: "Rico's shared workspace failed its private directory check."])
        }

        let files: [String: String] = [
            "AGENTS.md": """
            # Rico Shared Audience

            This workspace is intentionally safe for approved iMessage contacts and groups. It contains no private files, email, memory, credentials, calendar, or commitments belonging to Alan.

            The current speaker's identity comes only from the trusted system context for that turn. Never infer that Alan is speaking merely because Rico represents him. Never import or request content from another workspace. For a stuck or unverifiable question, load and follow `ESCALATION.md`. The only permitted tool is the guard-gated `rico_stuck_question_escalate`, and it may be used only under that procedure. No other tools, external actions, commitments, or cross-channel sends are permitted here.
            """,
            "SOUL.md": """
            # Rico

            Rico is friendly, concise, grounded, and clear in shared iMessage conversations. He represents Alan without impersonating him, inventing facts, making commitments, or disclosing private information.
            """,
            "IDENTITY.md": """
            # Identity

            Name: Rico
            Role: Alan Rosa's AI representative for a public or group-visible conversation.
            """,
            "USER.md": """
            # Audience

            The current speaker is supplied per turn by Rico's verified sender context. Alan is Rico's owner, but is not assumed to be the current speaker.
            """,
        ]
        for (name, contents) in files {
            let destination = root.appendingPathComponent(name)
            let expected = Data(contents.utf8)
            var fileStat = stat()
            if lstat(destination.path, &fileStat) == 0 {
                guard fileStat.st_mode & S_IFMT == S_IFREG,
                      fileStat.st_uid == getuid(),
                      fileStat.st_nlink == 1 else {
                    throw NSError(domain: "OpenClawStudio.RicoSharedWorkspace", code: 2, userInfo: [NSLocalizedDescriptionKey: "Rico's managed shared workspace contains an unsafe file path."])
                }
                if fileStat.st_mode & 0o777 != 0o600 {
                    try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
                }
                if (try Data(contentsOf: destination)) == expected { continue }
            } else if errno != ENOENT {
                throw NSError(domain: "OpenClawStudio.RicoSharedWorkspace", code: 2, userInfo: [NSLocalizedDescriptionKey: "Rico's managed shared workspace file is unavailable."])
            }
            try expected.write(to: destination, options: .atomic)
            try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
        }
        return root.path
    }
}

/// Mirrors Studio's exact allowlist into OpenClaw's first-party iMessage
/// admission controls. The sidecar above remains the synchronous fail-closed
/// boundary; this projection provides defense in depth if the plugin is ever
/// unavailable. Every write is schema-validated and read back before Studio
/// reports it as applied.
enum RicoNativePolicyProjection {
    static let requiredDMScope = "per-account-channel-peer"
    static let requiredGuardVersion = "0.5.7"
    static let requiredGuardContract = "rico-recipient-guard/v6"
    static let recipientGuardPluginID = "rico-recipient-guard"
    static let groupEmailToolName = "rico_group_email_execute"
    static let escalationPluginID = "rico-escalation-handoff"
    static let escalationToolName = "rico_stuck_question_escalate"
    static let sharedToolNames = [groupEmailToolName, escalationToolName]
    static let requiredSharedLocalModel = "lmstudio/qwen/qwen3.6-35b-a3b"
    static let requiredGuardHooks: Set<String> = [
        "inbound_claim", "before_dispatch", "before_prompt_build",
        "before_agent_run", "before_tool_call", "agent_end",
        "reply_payload_sending", "message_sending"
    ]
    static let requiredGuardTools: Set<String> = [groupEmailToolName]

    /// Rico's shared agent is Studio-managed. The active projection pins it to
    /// `requiredSharedLocalModel` with no cloud fallback; generic route
    /// verification remains available below for status validation and tests.
    struct SharedModelRoute: Equatable, Sendable {
        let primary: String
        let fallbacks: [String]

        var configuration: [String: Any] {
            ["primary": primary, "fallbacks": fallbacks]
        }
    }

    static func decodeConfigJSON(_ output: String) throws -> Any {
        guard let data = output.data(using: .utf8) else {
            throw projectionError("OpenClaw returned unreadable JSON.")
        }
        return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    struct Plan: Sendable {
        let channelEnabled: Bool
        let dmPolicy: String
        let allowFrom: [String]
        let groupPolicy: String
        let groupAllowFrom: [String]
        let groups: [String: [String: Bool]]
        let mentionPattern: String
        let managedGroupIDs: Set<String>
        let ownerAllowFrom: [String]
        let managedOwnerHandles: Set<String>
        let sharedToolDenySenders: [String]
        let managedSharedSenderHandles: Set<String>
        let sharedBindingTargets: Set<String>
        let managedSharedBindingTargets: Set<String>
    }

    struct RawConfigSnapshot {
        let root: [String: Any]
        let sha256: String
    }

    private enum ConfigTransactionError: Error {
        case changedDuringProjection
    }

    static func denyAllToolPolicy() -> [String: Any] {
        ["deny": ["*"]]
    }

    static func managedGroupConfiguration(existing: [String: Any], requireMention: Bool, ownerHandles: [String] = []) -> [String: Any] {
        var merged = existing
        merged["requireMention"] = requireMention
        let exactOwners = Array(Set(ownerHandles.map(RicoRecipientGuard.normalizeTarget).filter { !$0.isEmpty })).sorted()
        guard exactOwners.count == 1 else {
            merged["tools"] = denyAllToolPolicy()
            merged["toolsBySender"] = ["*": denyAllToolPolicy()]
            return merged
        }
        merged["tools"] = ["allow": sharedToolNames]
        // Group sender overrides take precedence over the group policy. Every
        // reviewed participant receives only the fixed escalation handoff;
        // the one exact reviewed owner can additionally reach governed email.
        merged["toolsBySender"] = [
            "*": ["allow": [escalationToolName]],
            "channel:imessage:\(exactOwners[0])": ["allow": sharedToolNames],
        ]
        return merged
    }

    static func identityLinksTouchManagedIMessageHandles(_ value: Any, managedHandles: Set<String>) -> Bool {
        guard !managedHandles.isEmpty else { return false }
        func touches(_ raw: String) -> Bool {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let lower = trimmed.lowercased()
            if lower.hasPrefix("imessage:") {
                return managedHandles.contains(RicoRecipientGuard.normalizeTarget(String(trimmed.dropFirst("imessage:".count))))
            }
            return managedHandles.contains(RicoRecipientGuard.normalizeTarget(trimmed))
        }
        guard let links = value as? [String: Any] else { return false }
        for (canonical, peers) in links {
            if touches(canonical) { return true }
            if let values = peers as? [String], values.contains(where: touches) { return true }
        }
        return false
    }

    static func exactIMessageCommandOwners(existing: [String], reviewedOwners: [String]) -> [String] {
        // Unprefixed command owners apply to every provider in OpenClaw, while
        // imessage:<id> applies specifically to iMessage. Remove both classes
        // before installing Rico's exact reviewed owner; preserve only entries
        // explicitly scoped to unrelated providers.
        let unrelatedProviders = existing.filter { entry in
            let trimmed = entry.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let separator = trimmed.firstIndex(of: ":") else { return false }
            return trimmed[..<separator].lowercased() != "imessage"
        }
        return Array(Set(unrelatedProviders + reviewedOwners)).sorted()
    }

    static func managedEscalationPluginEntry(existing _: [String: Any]) -> [String: Any] {
        // The handoff is a static tool and deliberately owns no conversation
        // hooks or live configuration. Replacing the whole entry with this
        // exact object removes every stale nested permission atomically.
        ["enabled": true]
    }

    static func rawConfigSnapshot(configURL: URL? = nil) throws -> RawConfigSnapshot {
        let url = configURL ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".openclaw/openclaw.json")
        let descriptor = Darwin.open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else {
            throw projectionError("Studio could not securely open OpenClaw's private configuration.")
        }
        defer { Darwin.close(descriptor) }

        var before = stat()
        guard fstat(descriptor, &before) == 0,
              before.st_mode & S_IFMT == S_IFREG,
              before.st_mode & 0o777 == 0o600,
              before.st_uid == getuid(),
              before.st_nlink == 1,
              before.st_size > 0,
              before.st_size <= 16 * 1_024 * 1_024 else {
            throw projectionError("OpenClaw's private configuration failed its file boundary check.")
        }

        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
        let data = try handle.readToEnd() ?? Data()
        var after = stat()
        guard fstat(descriptor, &after) == 0,
              before.st_dev == after.st_dev,
              before.st_ino == after.st_ino,
              before.st_size == after.st_size,
              data.count == Int(after.st_size),
              let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw projectionError("OpenClaw's private configuration was unavailable or changed during read-back.")
        }
        return RawConfigSnapshot(
            root: root,
            sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        )
    }

    static func rawConfigDocument(configURL: URL? = nil) throws -> [String: Any] {
        try rawConfigSnapshot(configURL: configURL).root
    }

    static func rawEscalationPluginEntry(configURL: URL? = nil) throws -> [String: Any] {
        let root = try rawConfigDocument(configURL: configURL)
        guard let plugins = root["plugins"] as? [String: Any],
              let entries = plugins["entries"] as? [String: Any],
              let entry = entries[escalationPluginID] as? [String: Any] else {
            throw projectionError("OpenClaw's private escalation entry was unavailable during read-back.")
        }
        return entry
    }

    /// Cheap local comparison used on launch. It reads OpenClaw's private
    /// config file and does not invoke the CLI, Gateway, or model catalog.
    static func reviewedAllowlistsMatchNativeConfig(
        policies: [RicoRecipientPolicy],
        rawConfig: [String: Any],
        paused: Bool = false
    ) -> Bool {
        let projection = plan(
            policies: policies,
            paused: paused,
            channelEnabledOverride: !paused
        )
        guard let channel = rawValue(in: rawConfig, path: "channels.imessage") as? [String: Any],
              channel["enabled"] as? Bool == projection.channelEnabled,
              channel["dmPolicy"] as? String == projection.dmPolicy,
              Set(stringArray(channel["allowFrom"])) == Set(projection.allowFrom),
              channel["groupPolicy"] as? String == projection.groupPolicy,
              Set(stringArray(channel["groupAllowFrom"])) == Set(projection.groupAllowFrom) else {
            return false
        }
        let nativeGroups = channel["groups"] as? [String: Any] ?? [:]
        for (id, expected) in projection.groups {
            guard let native = nativeGroups[id] as? [String: Any],
                  native["requireMention"] as? Bool == expected["requireMention"] else {
                return false
            }
        }
        let existingOwners = rawValue(in: rawConfig, path: "commands.ownerAllowFrom") as? [String] ?? []
        let expectedOwners = exactIMessageCommandOwners(
            existing: existingOwners,
            reviewedOwners: projection.ownerAllowFrom
        )
        return Set(existingOwners) == Set(expectedOwners)
    }

    static func reviewedAllowlistsMatchLiveNative(policies: [RicoRecipientPolicy]) -> Bool {
        guard let raw = try? rawConfigDocument() else { return false }
        return reviewedAllowlistsMatchNativeConfig(policies: policies, rawConfig: raw)
    }

    static func operationValuesMatchRawConfig(
        _ operations: [[String: Any]],
        rawConfig: [String: Any]
    ) -> Bool {
        operations.allSatisfy { operation in
            guard let path = operation["path"] as? String,
                  let expected = operation["value"],
                  let actual = rawValue(in: rawConfig, path: path) else { return false }
            return jsonValuesEqual(actual, expected)
        }
    }

    private static func rawValue(in root: [String: Any], path: String) -> Any? {
        var value: Any = root
        for component in path.split(separator: ".").map(String.init) {
            guard let dictionary = value as? [String: Any],
                  let next = dictionary[component] else { return nil }
            value = next
        }
        return value
    }

    private static func jsonValuesEqual(_ lhs: Any, _ rhs: Any) -> Bool {
        let left = ["value": lhs]
        let right = ["value": rhs]
        guard JSONSerialization.isValidJSONObject(left),
              JSONSerialization.isValidJSONObject(right),
              let leftData = try? JSONSerialization.data(withJSONObject: left, options: [.sortedKeys]),
              let rightData = try? JSONSerialization.data(withJSONObject: right, options: [.sortedKeys]) else {
            return false
        }
        return leftData == rightData
    }

    static func pluginProjectionOperations(
        pluginAllow: [String],
        existingEscalationEntry: [String: Any]
    ) -> [[String: Any]] {
        [
            ["path": "plugins.allow", "value": pluginAllow],
            ["path": "plugins.entries.rico-recipient-guard.hooks.allowConversationAccess", "value": true],
            ["path": "plugins.entries.rico-recipient-guard.hooks.allowPromptInjection", "value": true],
            ["path": "plugins.entries.rico-recipient-guard.enabled", "value": true],
            [
                "path": "plugins.entries.rico-escalation-handoff",
                "value": managedEscalationPluginEntry(existing: existingEscalationEntry),
            ],
        ]
    }

    static func configuredAgents(
        existing: [[String: Any]],
        mainWorkspace: String,
        sharedWorkspace: String,
        ownerHandles: [String] = [],
        modelRoute: SharedModelRoute? = nil
    ) -> [[String: Any]] {
        var agents = existing.filter { ($0["id"] as? String) != "rico-shared" }
        if agents.isEmpty {
            agents.append([
                "id": "main",
                "default": true,
                "name": "Main Agent",
                "workspace": mainWorkspace,
            ])
        }
        let exactOwners = Array(Set(ownerHandles.map(RicoRecipientGuard.normalizeTarget).filter { !$0.isEmpty })).sorted()
        let toolPolicy: [String: Any]
        if exactOwners.count == 1 {
            toolPolicy = [
                "allow": sharedToolNames,
                "elevated": ["enabled": false],
                "toolsBySender": [
                    "*": ["allow": [escalationToolName]],
                    "channel:imessage:\(exactOwners[0])": ["allow": sharedToolNames],
                ],
            ]
        } else {
            toolPolicy = ["deny": ["*"], "elevated": ["enabled": false], "toolsBySender": ["*": denyAllToolPolicy()]]
        }
        var sharedAgent: [String: Any] = [
            "id": "rico-shared",
            "default": false,
            "name": "Rico Shared Audience",
            "workspace": sharedWorkspace,
            "skills": [],
            "identity": ["name": "Rico", "theme": "public iMessage representative"],
            "tools": toolPolicy,
        ]
        if let modelRoute {
            sharedAgent["model"] = modelRoute.configuration
        }
        agents.append(sharedAgent)
        return agents
    }

    static func verifiedSharedModelRoute(
        defaultsModel: Any,
        modelsStatus: Any,
        usableLocalProviders: Set<String> = []
    ) throws -> SharedModelRoute {
        guard let status = modelsStatus as? [String: Any],
              let auth = status["auth"] as? [String: Any] else {
            throw projectionError("OpenClaw returned unreadable model availability status for Rico.")
        }

        let allowed = Set(stringArray(status["allowed"]))
        guard !allowed.isEmpty else {
            throw projectionError("OpenClaw did not report an allowed model catalog for Rico.")
        }

        let aliases = (status["aliases"] as? [String: Any] ?? [:]).reduce(into: [String: String]()) { result, entry in
            if let model = entry.value as? String { result[entry.key] = model }
        }
        var lowerAliases: [String: String] = [:]
        var ambiguousLowerAliases = Set<String>()
        for (alias, model) in aliases {
            let lower = alias.lowercased()
            if let existing = lowerAliases[lower], existing != model {
                ambiguousLowerAliases.insert(lower)
                lowerAliases.removeValue(forKey: lower)
            } else if !ambiguousLowerAliases.contains(lower) {
                lowerAliases[lower] = model
            }
        }
        func canonicalModel(_ raw: String) -> String? {
            let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { return nil }
            if let exact = aliases[value] { return exact }
            let lower = value.lowercased()
            return ambiguousLowerAliases.contains(lower) ? nil : lowerAliases[lower] ?? value
        }

        var configuredCandidates: [String] = []
        if let value = defaultsModel as? String, let canonical = canonicalModel(value) {
            configuredCandidates = [canonical]
        } else if let value = defaultsModel as? [String: Any],
                  let primary = value["primary"] as? String,
                  let canonicalPrimary = canonicalModel(primary) {
            configuredCandidates.append(canonicalPrimary)
            for fallback in stringArray(value["fallbacks"]) {
                if let canonical = canonicalModel(fallback) { configuredCandidates.append(canonical) }
            }
        }
        configuredCandidates = configuredCandidates.reduce(into: []) { result, model in
            if !result.contains(model) { result.append(model) }
        }
        guard !configuredCandidates.isEmpty else {
            throw projectionError("OpenClaw has no configured default model route for Rico.")
        }

        var usableProviders = Set<String>()
        var blockedProviders = Set(stringArray(auth["missingProvidersInUse"]).map { $0.lowercased() })

        for providerStatus in auth["providers"] as? [[String: Any]] ?? [] {
            guard let rawProvider = providerStatus["provider"] as? String else { continue }
            let provider = rawProvider.lowercased()
            let effective = providerStatus["effective"] as? [String: Any]
            let kind = (effective?["kind"] as? String)?.lowercased() ?? ""
            if ["missing", "unusable", "expired", "error"].contains(kind) {
                blockedProviders.insert(provider)
                continue
            }
            let rawProfileCount = (providerStatus["profiles"] as? [String: Any])?["count"]
            let profileCount = rawProfileCount as? Int ?? (rawProfileCount as? NSNumber)?.intValue ?? 0
            if profileCount > 0 || ["profiles", "oauth", "api_key", "token", "config", "keychain", "runtime", "environment", "env", "none-required"].contains(kind) {
                usableProviders.insert(provider)
            }
        }

        for route in auth["runtimeAuthRoutes"] as? [[String: Any]] ?? [] {
            guard (route["status"] as? String)?.lowercased() == "usable",
                  let provider = (route["provider"] as? String)?.lowercased() else { continue }
            usableProviders.insert(provider)
        }

        if let oauth = auth["oauth"] as? [String: Any] {
            for providerStatus in oauth["providers"] as? [[String: Any]] ?? [] {
                guard let provider = (providerStatus["provider"] as? String)?.lowercased(),
                      let state = (providerStatus["status"] as? String)?.lowercased() else { continue }
                if ["ok", "static"].contains(state) {
                    usableProviders.insert(provider)
                } else if ["missing", "expired", "error", "invalid"].contains(state) {
                    blockedProviders.insert(provider)
                }
            }
        }
        usableProviders.subtract(blockedProviders)
        // A reviewed loopback provider deliberately needs no cloud auth
        // profile. It is admitted only after RicoLocalModelRuntime has proved
        // the exact endpoint, loaded models, visible generation, and embedding
        // shape during this enforcement attempt.
        usableProviders.formUnion(usableLocalProviders.map { $0.lowercased() })

        let verified = configuredCandidates.filter { model in
            guard allowed.contains(model), let separator = model.firstIndex(of: "/") else { return false }
            let provider = String(model[..<separator]).lowercased()
            return usableProviders.contains(provider)
        }
        guard let primary = verified.first else {
            throw projectionError("None of OpenClaw's configured default models has a usable authentication route for Rico.")
        }
        return SharedModelRoute(primary: primary, fallbacks: Array(verified.dropFirst()))
    }

    static func verifiedStrictLocalSharedModelRoute(
        modelsStatus: Any,
        usableLocalProviders: Set<String>
    ) throws -> SharedModelRoute {
        guard let status = modelsStatus as? [String: Any] else {
            throw projectionError("OpenClaw returned unreadable model availability status for Rico.")
        }
        let allowed = Set(stringArray(status["allowed"]))
        guard allowed.contains(requiredSharedLocalModel),
              usableLocalProviders.map({ $0.lowercased() }).contains("lmstudio") else {
            throw projectionError("Rico's required local model is not currently verified and available.")
        }
        return SharedModelRoute(primary: requiredSharedLocalModel, fallbacks: [])
    }

    static func validateSharedModelStatus(
        _ value: Any,
        expected: SharedModelRoute,
        usableLocalProviders: Set<String> = []
    ) throws {
        guard let status = value as? [String: Any],
              status["defaultModel"] as? String == expected.primary,
              stringArray(status["fallbacks"]) == expected.fallbacks else {
            throw projectionError("OpenClaw did not activate Rico's verified shared-agent model route.")
        }
        let route = try verifiedSharedModelRoute(
            defaultsModel: expected.configuration,
            modelsStatus: status,
            usableLocalProviders: usableLocalProviders
        )
        guard route == expected else {
            throw projectionError("OpenClaw could not verify Rico's shared-agent model providers after projection.")
        }
    }

    static func bindingTargetKey(_ binding: [String: Any]) -> String? {
        guard let match = binding["match"] as? [String: Any],
              (match["channel"] as? String)?.lowercased() == "imessage",
              let peer = match["peer"] as? [String: Any],
              let kind = (peer["kind"] as? String)?.lowercased(),
              ["direct", "group"].contains(kind),
              let rawID = peer["id"] as? String else { return nil }
        return canonicalSharedBindingTarget("\(kind):\(rawID)")
    }

    static func canonicalSharedBindingTarget(_ rawValue: String) -> String? {
        let components = rawValue.split(separator: ":", maxSplits: 1).map(String.init)
        guard components.count == 2 else { return nil }
        let kind = components[0].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var rawID = components[1].trimmingCharacters(in: .whitespacesAndNewlines)
        guard ["direct", "group"].contains(kind), !rawID.isEmpty else { return nil }
        if kind == "group" {
            let lower = rawID.lowercased()
            for prefix in ["chat_id:", "chat_guid:", "chat_identifier:"] where lower.hasPrefix(prefix) {
                rawID = String(rawID.dropFirst(prefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
                break
            }
            return rawID.isEmpty ? nil : "group:\(rawID)"
        }
        let target = RicoRecipientGuard.normalizeTarget(rawID)
        return target.isEmpty ? nil : "direct:\(target)"
    }

    static func configuredSharedBindings(
        existing: [[String: Any]],
        activeTargets: Set<String>,
        managedTargets: Set<String>
    ) -> [[String: Any]] {
        let canonicalActiveTargets = Set(activeTargets.compactMap(canonicalSharedBindingTarget))
        let canonicalManagedTargets = Set(managedTargets.compactMap(canonicalSharedBindingTarget))
        var bindings = existing.filter { binding in
            let isOwnedAgentRoute = (binding["agentId"] as? String) == "rico-shared" &&
                ((binding["match"] as? [String: Any])?["channel"] as? String)?.lowercased() == "imessage"
            if isOwnedAgentRoute { return false }
            guard let key = bindingTargetKey(binding) else { return true }
            return !canonicalManagedTargets.contains(key) && !canonicalActiveTargets.contains(key)
        }
        for key in canonicalActiveTargets.sorted() {
            let components = key.split(separator: ":", maxSplits: 1).map(String.init)
            guard components.count == 2 else { continue }
            bindings.append([
                "agentId": "rico-shared",
                "match": [
                    "channel": "imessage",
                    "peer": ["kind": components[0], "id": components[1]],
                ],
                "session": ["dmScope": requiredDMScope],
            ])
        }
        return bindings
    }

    static func plan(
        policies: [RicoRecipientPolicy],
        paused: Bool,
        channelEnabledOverride: Bool? = nil,
        managedGroupIDs: [String] = [],
        managedOwnerHandles: [String] = [],
        managedSharedSenderHandles: [String] = [],
        managedSharedBindingTargets: [String] = []
    ) -> Plan {
        let individualsByTarget = Dictionary(grouping: policies.filter { $0.groupChatID == nil }) {
            RicoRecipientGuard.normalizeTarget($0.address)
        }
        let activeIndividuals = individualsByTarget.values.compactMap { bucket -> RicoRecipientPolicy? in
            guard bucket.count == 1, let policy = bucket.first,
                  !RicoRecipientGuard.normalizeTarget(policy.address).isEmpty,
                  policy.access != .blocked, policy.autoReply else { return nil }
            return policy
        }
        let activeGroups = policies.filter {
            $0.groupChatID != nil && $0.access != .blocked && $0.autoReply &&
            !Set(($0.participantAddresses ?? []).map(RicoRecipientGuard.normalizeTarget).filter { !$0.isEmpty }).isEmpty
        }
        let direct = Array(Set(activeIndividuals.map { RicoRecipientGuard.normalizeTarget($0.address) }.filter { !$0.isEmpty })).sorted()
        let participants = activeGroups.flatMap { ($0.participantAddresses ?? []).map(RicoRecipientGuard.normalizeTarget) }
        let owners = activeIndividuals
            .filter { $0.access == .owner }
            .map { RicoRecipientGuard.normalizeTarget($0.address) }
        // `groupAllowFrom` is a sender allowlist. Including a chat target here
        // would admit every member of that chat at OpenClaw's native ingress
        // boundary. `groups` already scopes the exact approved chats, so keep
        // this list to the snapshotted participant handles plus explicit owner
        // identities. Owner routing is still constrained to an exact approved
        // chat and a literal @rico command by the owner-command proxy.
        let groupSenders = Array(Set((participants + owners).filter { !$0.isEmpty })).sorted()
        var groupMap: [String: [String: Bool]] = [:]
        for policy in activeGroups {
            guard let id = policy.groupChatID, !id.isEmpty else { continue }
            groupMap[id] = ["requireMention": policy.requireMention]
        }
        let managed = Set(managedGroupIDs).union(policies.compactMap(\.groupChatID))
        let commandOwners = owners.map { "imessage:\($0)" }.sorted()
        let sharedToolDenySenders = activeIndividuals
            .filter { $0.access != .owner }
            .map { RicoRecipientGuard.normalizeTarget($0.address) }
            .filter { !$0.isEmpty }
            .sorted()
        let directBindingTargets = activeIndividuals
            .filter { $0.access != .owner }
            .map { "direct:\(RicoRecipientGuard.normalizeTarget($0.address))" }
        let groupBindingTargets = activeGroups.compactMap { policy -> String? in
            guard let groupID = policy.groupChatID?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !groupID.isEmpty else { return nil }
            return "group:\(groupID)"
        }
        let sharedBindingTargets = Set(directBindingTargets + groupBindingTargets)
        return Plan(
            channelEnabled: channelEnabledOverride ?? !paused,
            dmPolicy: paused || direct.isEmpty ? "disabled" : "allowlist",
            allowFrom: paused ? [] : direct,
            groupPolicy: paused || groupMap.isEmpty || groupSenders.isEmpty ? "disabled" : "allowlist",
            groupAllowFrom: paused ? [] : groupSenders,
            groups: paused ? [:] : groupMap,
            // OpenClaw compiles mention patterns case-insensitively; JavaScript
            // regex syntax does not support an inline (?i) flag.
            mentionPattern: "(?:^|\\s)@rico\\b",
            managedGroupIDs: managed,
            ownerAllowFrom: paused ? [] : commandOwners,
            managedOwnerHandles: Set(managedOwnerHandles).union(owners),
            sharedToolDenySenders: sharedToolDenySenders,
            managedSharedSenderHandles: Set(managedSharedSenderHandles).union(sharedToolDenySenders),
            sharedBindingTargets: paused ? [] : sharedBindingTargets,
            managedSharedBindingTargets: Set(managedSharedBindingTargets).union(sharedBindingTargets)
        )
    }

    /// Independent native emergency path used only when the private guard
    /// pair cannot be staged. It does not read or trust that sidecar, does not
    /// require Gateway/model health, and never enables a shared binding/tool.
    /// The physical channel stays registered unless the user explicitly chose
    /// Pause.
    static func emergencyQuarantine(
        policies: [RicoRecipientPolicy],
        mode: RicoProjectionMode,
        attestCurrent: @escaping @Sendable () async throws -> Void
    ) async throws {
        var lastChange: Error?
        for _ in 0..<3 {
            try await attestCurrent()
            let lease = try await RicoNativeConfigLease.acquire()
            do {
                try await emergencyQuarantineHoldingLease(
                    policies: policies,
                    mode: mode,
                    attestCurrent: attestCurrent
                )
                guard lease.release() else {
                    throw projectionError("Studio could not release the shared OpenClaw configuration lease safely.")
                }
                return
            } catch ConfigTransactionError.changedDuringProjection {
                _ = lease.release()
                lastChange = ConfigTransactionError.changedDuringProjection
                continue
            } catch {
                _ = lease.release()
                throw error
            }
        }
        throw lastChange ?? projectionError("OpenClaw configuration kept changing during emergency quarantine.")
    }

    private static func emergencyQuarantineHoldingLease(
        policies _: [RicoRecipientPolicy],
        mode: RicoProjectionMode,
        attestCurrent: @escaping @Sendable () async throws -> Void
    ) async throws {
        try await attestCurrent()
        let baseline = try rawConfigSnapshot()
        let raw = baseline.root
        let operations = emergencyQuarantineOperations(rawConfig: raw, mode: mode)
        if !operationValuesMatchRawConfig(operations, rawConfig: raw) {
            let data = try JSONSerialization.data(withJSONObject: operations, options: [.sortedKeys])
            guard let batch = String(data: data, encoding: .utf8) else {
                throw projectionError("Could not encode Rico's emergency native quarantine.")
            }
            try await attestCurrent()
            guard try rawConfigSnapshot().sha256 == baseline.sha256 else {
                throw ConfigTransactionError.changedDuringProjection
            }
            _ = try await OpenClawPolicyCommand.run(["config", "set", "--batch-json", batch, "--replace", "--dry-run"])
            try await attestCurrent()
            guard try rawConfigSnapshot().sha256 == baseline.sha256 else {
                throw ConfigTransactionError.changedDuringProjection
            }
            _ = try await OpenClawPolicyCommand.run(["config", "set", "--batch-json", batch, "--replace"])
        }
        try await attestCurrent()
        let verified = try rawConfigDocument()
        guard operationValuesMatchRawConfig(operations, rawConfig: verified) else {
            throw projectionError("OpenClaw did not retain Rico's emergency native quarantine.")
        }
        let validation = try await OpenClawPolicyCommand.run(["config", "validate", "--json"])
        if let data = validation.data(using: .utf8),
           let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           value["valid"] as? Bool == false {
            throw projectionError("OpenClaw rejected Rico's emergency native quarantine.")
        }
        try await attestCurrent()
    }

    static func emergencyQuarantineOperations(
        rawConfig raw: [String: Any],
        mode: RicoProjectionMode
    ) -> [[String: Any]] {
        // Health verification must never empty native allowlists. Only an
        // explicit Pause disables the channel and admission paths.
        if mode != .explicitPause {
            return [
                ["path": "channels.imessage.enabled", "value": true],
            ]
        }
        let existingAgents = rawValue(in: raw, path: "agents.list") as? [[String: Any]] ?? []
        let mainWorkspace = rawValue(in: raw, path: "agents.defaults.workspace") as? String ??
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".openclaw/workspace").path
        let quarantinedAgents = configuredAgents(
            existing: existingAgents,
            mainWorkspace: mainWorkspace,
            sharedWorkspace: RicoSharedWorkspace.directory.path,
            ownerHandles: [],
            modelRoute: SharedModelRoute(primary: requiredSharedLocalModel, fallbacks: [])
        )
        let existingBindings = rawValue(in: raw, path: "bindings") as? [[String: Any]] ?? []
        let quarantinedBindings = existingBindings.filter { ($0["agentId"] as? String) != "rico-shared" }
        let existingOwners = rawValue(in: raw, path: "commands.ownerAllowFrom") as? [String] ?? []
        return [
            ["path": "channels.imessage.enabled", "value": mode.channelEnabled],
            ["path": "channels.imessage.dmPolicy", "value": "disabled"],
            ["path": "channels.imessage.allowFrom", "value": [String]()],
            ["path": "channels.imessage.groupPolicy", "value": "disabled"],
            ["path": "channels.imessage.groupAllowFrom", "value": [String]()],
            ["path": "commands.ownerAllowFrom", "value": exactIMessageCommandOwners(existing: existingOwners, reviewedOwners: [])],
            ["path": "agents.list", "value": quarantinedAgents],
            ["path": "bindings", "value": quarantinedBindings],
        ]
    }

    static func apply(
        policies: [RicoRecipientPolicy],
        mode: RicoProjectionMode,
        activeAttempt: RicoActiveProjectionAttempt,
        attestCurrent: @escaping @Sendable () async throws -> Void,
        writeAdmissionPaused: @escaping @Sendable (Bool) async throws -> Void
    ) async throws -> String {
        if activeAttempt == .healthyAudit, mode == .active {
            try await attestCurrent()
            if RicoRecipientGuard.readPausedState() == false,
               reviewedAllowlistsMatchLiveNative(policies: policies) {
                return "Rico's live guard is unpaused and native iMessage allowlists already match the reviewed policy."
            }
        }
        var lastChange: Error?
        for _ in 0..<3 {
            try await attestCurrent()
            if mode.requiresRuntimeProof, activeAttempt != .healthyAudit {
                // Transport proof is best-effort. Delivery telemetry and
                // transient Gateway errors must not block writing the reviewed
                // allowlists or latch admission closed.
                try? await requireOperationalIMessageTransport(attestCurrent: attestCurrent)
            }
            let lease = try await RicoNativeConfigLease.acquire()
            do {
                let summary = try await applyHoldingLease(
                    policies: policies,
                    mode: mode,
                    activeAttempt: activeAttempt,
                    attestCurrent: attestCurrent,
                    writeAdmissionPaused: writeAdmissionPaused
                )
                guard lease.release() else {
                    throw projectionError("Studio could not release the shared OpenClaw configuration lease safely.")
                }
                return summary
            } catch ConfigTransactionError.changedDuringProjection {
                _ = lease.release()
                lastChange = ConfigTransactionError.changedDuringProjection
                continue
            } catch {
                _ = lease.release()
                throw error
            }
        }
        throw lastChange ?? projectionError("OpenClaw configuration kept changing during Rico projection.")
    }

    private static func requireOperationalIMessageTransport(
        attestCurrent: @escaping @Sendable () async throws -> Void
    ) async throws {
        try await attestCurrent()
        let imessageStatus = try await IMessageCommand.probe()
        let readiness = IMessageCommand.probeReadiness(imessageStatus)
        guard readiness.transportOperational else {
            throw IMessageDeliveryVerificationError(readiness: readiness)
        }
        try await attestCurrent()
    }

    private static func applyHoldingLease(
        policies: [RicoRecipientPolicy],
        mode: RicoProjectionMode,
        activeAttempt: RicoActiveProjectionAttempt,
        attestCurrent: @escaping @Sendable () async throws -> Void,
        writeAdmissionPaused: @escaping @Sendable (Bool) async throws -> Void
    ) async throws -> String {
        try await attestCurrent()
            let baseline = try rawConfigSnapshot()
            let raw = baseline.root
            let paused = mode.admissionPaused
            let sidecar = try readJSONFile(RicoRecipientGuard.policyURL)
            let managed = sidecar["managedGroupIDs"] as? [String] ?? []
            let managedOwners = sidecar["managedOwnerHandles"] as? [String] ?? []
            let managedSharedSenders = sidecar["managedSharedSenderHandles"] as? [String] ?? []
            let managedSharedBindings = sidecar["managedSharedBindingTargets"] as? [String] ?? []
            let projection = plan(
                policies: policies,
                paused: paused,
                channelEnabledOverride: mode.channelEnabled,
                managedGroupIDs: managed,
                managedOwnerHandles: managedOwners,
                managedSharedSenderHandles: managedSharedSenders,
                managedSharedBindingTargets: managedSharedBindings
            )
            let projectedOwnerHandles = projection.ownerAllowFrom.compactMap { value -> String? in
                let prefix = "imessage:"
                guard value.lowercased().hasPrefix(prefix) else { return nil }
                let handle = RicoRecipientGuard.normalizeTarget(String(value.dropFirst(prefix.count)))
                return handle.isEmpty ? nil : handle
            }
            let activeOwnerHandles = paused ? [] : projectedOwnerHandles
            // A staged activation proves the exact live guard while admission
            // is paused. A healthy watchdog audit compares local files and
            // does not serialize Gateway or model proofs.
            if mode.requiresRuntimeProof, activeAttempt != .healthyAudit {
                try await requireStableLiveGuardStatus(
                    paused: mode.admissionPaused
                )
            }
            try await attestCurrent()

            let existingChannel = rawValue(in: raw, path: "channels.imessage") as? [String: Any] ?? [:]
            try await attestCurrent()
            let ownerRoutePath = try await RicoOwnerRouteInstaller.ensureInstalled()
            try await attestCurrent()
            let sharedWorkspace = try RicoSharedWorkspace.ensureInstalled()
            try await attestCurrent()
            let mainWorkspace = (rawValue(in: raw, path: "agents.defaults.workspace") as? String) ??
                FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".openclaw/workspace").path
            let existingAgents = (rawValue(in: raw, path: "agents.list") as? [[String: Any]]) ?? []
            let modelRoute: SharedModelRoute
            var usableLocalProviders = Set<String>()
            if mode.requiresRuntimeProof, activeAttempt != .healthyAudit {
                // Shared iMessage conversations stay local-only. A failed
                // live-model proof must not empty iMessage allowlists.
                if let providerConfiguration = try? RicoLocalModelRuntime.providerConfiguration(),
                   let serverConfiguration = try? RicoLocalModelRuntime.serverConfiguration() {
                    usableLocalProviders = (try? RicoLocalModelRuntime.verifiedProviders(
                        providerConfiguration: providerConfiguration,
                        serverConfiguration: serverConfiguration
                    )) ?? []
                }
                let statusArguments = existingAgents.contains(where: { ($0["id"] as? String) == "rico-shared" })
                    ? ["models", "status", "--agent", "rico-shared", "--json"]
                    : ["models", "status", "--json"]
                if let statusOutput = try? await OpenClawPolicyCommand.run(statusArguments),
                   let modelStatus = try? decodeConfigJSON(statusOutput),
                   let verified = try? verifiedStrictLocalSharedModelRoute(
                    modelsStatus: modelStatus,
                    usableLocalProviders: usableLocalProviders
                   ) {
                    modelRoute = verified
                } else {
                    modelRoute = SharedModelRoute(primary: requiredSharedLocalModel, fallbacks: [])
                }
            } else {
                // Paused and health-quarantined states never need a live model,
                // but they retain the exact local-only pin so no transient
                // condition can reintroduce a frontier fallback.
                modelRoute = SharedModelRoute(primary: requiredSharedLocalModel, fallbacks: [])
            }
            try await attestCurrent()
            let nextAgents = configuredAgents(
                existing: existingAgents,
                mainWorkspace: mainWorkspace,
                sharedWorkspace: sharedWorkspace,
                ownerHandles: paused ? [] : activeOwnerHandles,
                modelRoute: modelRoute
            )
            let existingBindings = (rawValue(in: raw, path: "bindings") as? [[String: Any]]) ?? []
            let nextBindings = configuredSharedBindings(
                existing: existingBindings,
                activeTargets: projection.sharedBindingTargets,
                managedTargets: projection.managedSharedBindingTargets
            )
            let managedIdentityHandles = Set(policies.flatMap { policy -> [String] in
                if policy.groupChatID != nil {
                    return (policy.participantAddresses ?? []).map(RicoRecipientGuard.normalizeTarget).filter { !$0.isEmpty }
                }
                let target = RicoRecipientGuard.normalizeTarget(policy.address)
                return target.isEmpty ? [] : [target]
            })
            let identityLinks = rawValue(in: raw, path: "session.identityLinks") as? [String: Any] ?? [:]
            guard !identityLinksTouchManagedIMessageHandles(identityLinks, managedHandles: managedIdentityHandles) else {
                throw projectionError("A session identity link touches a Rico-managed iMessage identity. Remove that link before enabling shared messaging.")
            }
            var existingGroups = existingChannel["groups"] as? [String: Any] ?? [:]
            let activeGroupIDs = Set(projection.groups.keys)
            projection.managedGroupIDs.subtracting(activeGroupIDs).forEach { existingGroups.removeValue(forKey: $0) }
            projection.groups.forEach { id, projected in
                // Preserve unrelated native defenses such as toolsBySender or
                // a future per-group system prompt. Studio owns only the
                // reviewed mention gate and removes entries only on revoke.
                existingGroups[id] = managedGroupConfiguration(
                    existing: existingGroups[id] as? [String: Any] ?? [:],
                    requireMention: projected["requireMention"] ?? true,
                    ownerHandles: paused ? [] : activeOwnerHandles
                )
            }

            let existingPatterns = (rawValue(in: raw, path: "messages.groupChat.mentionPatterns") as? [String]) ?? []
            let patterns = Array(Set(existingPatterns + [projection.mentionPattern])).sorted()
            let existingCommandOwners = (rawValue(in: raw, path: "commands.ownerAllowFrom") as? [String]) ?? []
            let commandOwners = exactIMessageCommandOwners(existing: existingCommandOwners, reviewedOwners: projection.ownerAllowFrom)
            let existingPluginAllow = (rawValue(in: raw, path: "plugins.allow") as? [String]) ?? []
            let pluginAllow = Array(Set(existingPluginAllow + [recipientGuardPluginID, escalationPluginID])).sorted()
            let existingEscalationEntry = (rawValue(in: raw, path: "plugins.entries.rico-escalation-handoff") as? [String: Any]) ?? [:]
            let escalationPluginEntry = managedEscalationPluginEntry(existing: existingEscalationEntry)
            var existingToolsBySender = (rawValue(in: raw, path: "tools.toolsBySender") as? [String: Any]) ?? [:]
            projection.managedSharedSenderHandles.forEach { existingToolsBySender.removeValue(forKey: "channel:imessage:\($0)") }
            projection.sharedToolDenySenders.forEach { existingToolsBySender["channel:imessage:\($0)"] = denyAllToolPolicy() }
            let operations: [[String: Any]] = [
                ["path": "channels.imessage.enabled", "value": projection.channelEnabled],
                ["path": "channels.imessage.dmPolicy", "value": projection.dmPolicy],
                ["path": "channels.imessage.allowFrom", "value": projection.allowFrom],
                ["path": "channels.imessage.groupPolicy", "value": projection.groupPolicy],
                ["path": "channels.imessage.groupAllowFrom", "value": projection.groupAllowFrom],
                ["path": "channels.imessage.groups", "value": existingGroups],
                ["path": "channels.imessage.contextVisibility", "value": "allowlist"],
                ["path": "channels.imessage.cliPath", "value": ownerRoutePath],
                ["path": "messages.groupChat.mentionPatterns", "value": patterns],
                ["path": "commands.ownerAllowFrom", "value": commandOwners],
                ["path": "tools.toolsBySender", "value": existingToolsBySender],
                ["path": "session.dmScope", "value": requiredDMScope],
            ] + pluginProjectionOperations(
                pluginAllow: pluginAllow,
                existingEscalationEntry: existingEscalationEntry
            ) + [
                ["path": "agents.list", "value": nextAgents],
                ["path": "bindings", "value": nextBindings],
            ]
            let batchData = try JSONSerialization.data(withJSONObject: operations, options: [.sortedKeys])
            guard let batch = String(data: batchData, encoding: .utf8) else {
                throw projectionError("Could not encode the native policy transaction.")
            }

            // Repeated app launches and watchdog passes are read-only when the
            // exact managed values are already present. This prevents config
            // audit churn and eliminates a race window with unrelated writers
            // such as the ISTS workflow.
            if !operationValuesMatchRawConfig(operations, rawConfig: raw) {
                if mode == .active, !activeAttempt.mayRepairNativeConfig {
                    throw projectionError("Rico's native policy drifted during a healthy audit; Studio will repair without closing admission.")
                }
                try await attestCurrent()
                guard try rawConfigSnapshot().sha256 == baseline.sha256 else {
                    throw ConfigTransactionError.changedDuringProjection
                }
                _ = try await OpenClawPolicyCommand.run(["config", "set", "--batch-json", batch, "--replace", "--dry-run"])
                try await attestCurrent()
                guard try rawConfigSnapshot().sha256 == baseline.sha256 else {
                    throw ConfigTransactionError.changedDuringProjection
                }
                _ = try await OpenClawPolicyCommand.run(["config", "set", "--batch-json", batch, "--replace"])
                try await attestCurrent()
            }
            let validationOutput = try await OpenClawPolicyCommand.run(["config", "validate", "--json"])
            if let validationData = validationOutput.data(using: .utf8),
               let validation = try? JSONSerialization.jsonObject(with: validationData) as? [String: Any],
               validation["valid"] as? Bool == false {
                throw projectionError("OpenClaw rejected the projected configuration during validation.")
            }

            let channel = try requireDictionary(await OpenClawPolicyCommand.json(path: "channels.imessage"), label: "channels.imessage")
            try validateIMessageChannelRegistration(channel, expectedEnabled: projection.channelEnabled)
            guard channel["dmPolicy"] as? String == projection.dmPolicy,
                  Set(stringArray(channel["allowFrom"])) == Set(projection.allowFrom),
                  channel["groupPolicy"] as? String == projection.groupPolicy,
                  Set(stringArray(channel["groupAllowFrom"])) == Set(projection.groupAllowFrom),
                  dictionariesEqual(channel["groups"], existingGroups),
                  channel["contextVisibility"] as? String == "allowlist",
                  channel["cliPath"] as? String == ownerRoutePath else {
                throw projectionError("OpenClaw read-back did not match the reviewed iMessage policy.")
            }
            let readPatterns = try requireStringArray(await OpenClawPolicyCommand.json(path: "messages.groupChat.mentionPatterns"), label: "messages.groupChat.mentionPatterns")
            guard Set(readPatterns) == Set(patterns) else {
                throw projectionError("OpenClaw read-back did not confirm Rico's mention pattern.")
            }
            let readCommandOwners = try requireStringArray(await OpenClawPolicyCommand.json(path: "commands.ownerAllowFrom"), label: "commands.ownerAllowFrom")
            guard Set(readCommandOwners) == Set(commandOwners) else {
                throw projectionError("OpenClaw read-back did not confirm Rico's exact owner identity.")
            }
            let readToolsBySender = try requireDictionary(await OpenClawPolicyCommand.json(path: "tools.toolsBySender"), label: "tools.toolsBySender")
            guard dictionariesEqual(readToolsBySender, existingToolsBySender) else {
                throw projectionError("OpenClaw read-back did not confirm the shared-audience tool boundary.")
            }
            guard (try await OpenClawPolicyCommand.json(path: "session.dmScope")) as? String == requiredDMScope else {
                throw projectionError("OpenClaw read-back did not confirm isolated direct-message sessions.")
            }
            let readPluginAllow = try requireStringArray(await OpenClawPolicyCommand.json(path: "plugins.allow"), label: "plugins.allow")
            guard Set(readPluginAllow) == Set(pluginAllow) else {
                throw projectionError("OpenClaw read-back did not confirm Rico's exact plugin allowlist.")
            }
            let readIdentityLinks = (try? await OpenClawPolicyCommand.json(path: "session.identityLinks")) as? [String: Any] ?? [:]
            guard !identityLinksTouchManagedIMessageHandles(readIdentityLinks, managedHandles: managedIdentityHandles) else {
                throw projectionError("OpenClaw read-back found a session identity link touching a Rico-managed sender.")
            }
            guard (try await OpenClawPolicyCommand.json(path: "plugins.entries.rico-recipient-guard.hooks.allowConversationAccess")) as? Bool == true,
                  (try await OpenClawPolicyCommand.json(path: "plugins.entries.rico-recipient-guard.hooks.allowPromptInjection")) as? Bool == true else {
                throw projectionError("OpenClaw did not retain Rico's required conversation-hook permissions.")
            }
            guard (try await OpenClawPolicyCommand.json(path: "plugins.entries.rico-recipient-guard.enabled")) as? Bool == true else {
                throw projectionError("OpenClaw did not retain Rico's recipient guard as enabled.")
            }
            let readEscalationEntry = try rawEscalationPluginEntry()
            guard dictionariesEqual(readEscalationEntry, escalationPluginEntry),
                  readEscalationEntry["hooks"] == nil else {
                throw projectionError("OpenClaw did not retain Rico's hookless escalation handoff boundary.")
            }
            let readAgents = try requireArrayOfDictionaries(await OpenClawPolicyCommand.json(path: "agents.list"), label: "agents.list")
            guard arraysOfDictionariesEqual(readAgents, nextAgents),
                  readAgents.contains(where: { agent in
                      guard agent["id"] as? String == "rico-shared",
                            agent["workspace"] as? String == sharedWorkspace,
                            let tools = agent["tools"] as? [String: Any] else { return false }
                      let ownerToolBoundary = activeOwnerHandles.count == 1
                          ? tools["allow"] as? [String] == sharedToolNames
                          : tools["deny"] as? [String] == ["*"]
                      let modelMatches: Bool
                      modelMatches = dictionariesEqual(agent["model"], modelRoute.configuration)
                      return ownerToolBoundary && modelMatches && (agent["skills"] as? [String])?.isEmpty == true
                  }) else {
                throw projectionError("OpenClaw did not confirm Rico's isolated shared-audience agent.")
            }
            if mode.requiresRuntimeProof, activeAttempt != .healthyAudit {
                var readbackLocalProviders = Set<String>()
                let appliedCandidates = [modelRoute.primary] + modelRoute.fallbacks
                if appliedCandidates.contains(where: { $0.lowercased().hasPrefix("lmstudio/") }) {
                    readbackLocalProviders = try RicoLocalModelRuntime.verifiedProviders(
                        providerConfiguration: try RicoLocalModelRuntime.providerConfiguration(),
                        serverConfiguration: try RicoLocalModelRuntime.serverConfiguration()
                    )
                }
                let modelStatusOutput = try await OpenClawPolicyCommand.run(["models", "status", "--agent", "rico-shared", "--json"])
                try validateSharedModelStatus(
                    try decodeConfigJSON(modelStatusOutput),
                    expected: modelRoute,
                    usableLocalProviders: readbackLocalProviders
                )
            }
            let readBindings = try requireArrayOfDictionaries(await OpenClawPolicyCommand.json(path: "bindings"), label: "bindings")
            guard arraysOfDictionariesEqual(readBindings, nextBindings),
                  projection.sharedBindingTargets.allSatisfy({ target in
                      readBindings.contains(where: { binding in
                          bindingTargetKey(binding) == target &&
                          binding["agentId"] as? String == "rico-shared" &&
                          ((binding["session"] as? [String: Any])?["dmScope"] as? String) == requiredDMScope
                      })
                  }) else {
                throw projectionError("OpenClaw did not confirm exact shared-audience routing into Rico's public workspace.")
            }
            if mode.requiresRuntimeProof {
                if activeAttempt == .stagedActivation {
                    try? await requireOperationalIMessageTransport(attestCurrent: attestCurrent)
                    try await RicoFinalActivationBoundary.activate(
                        attestCurrent: attestCurrent,
                        writePaused: writeAdmissionPaused,
                        proveActive: {
                            try await requireStableLiveGuardStatus(paused: false)
                            try? await requireOperationalIMessageTransport(attestCurrent: attestCurrent)
                        }
                    )
                } else {
                    try await attestCurrent()
                }
            } else {
                try await attestCurrent()
                try await requireLiveGuardStatus(paused: mode.admissionPaused)
                try await attestCurrent()
            }
        switch mode {
        case .active:
            return "Recipient policy applied and verified in Rico's live Gateway guard, isolated sessions, and native OpenClaw iMessage controls."
        case .explicitPause:
            return "Explicit emergency pause saved and verified; Rico admission and the iMessage channel are disabled."
        case .healthQuarantine:
            return "Rico is still verifying health. Admission stays open and iMessage remains registered."
        }
    }

    static func validateIMessageChannelRegistration(_ channel: [String: Any], expectedEnabled: Bool) throws {
        guard channel["enabled"] as? Bool == expectedEnabled else {
            throw projectionError(expectedEnabled
                ? "OpenClaw did not retain the iMessage channel as enabled."
                : "OpenClaw did not retain the iMessage channel as disabled during emergency pause.")
        }
    }

    static func validateGuardStatus(_ value: Any, paused: Bool) throws {
        let status = try requireDictionary(value, label: "rico.recipient.status")
        let enforcement = try requireDictionary(status["enforcement"] as Any, label: "rico.recipient.status.enforcement")
        let hookPermissions = try requireDictionary(status["hookPermissions"] as Any, label: "rico.recipient.status.hookPermissions")
        let escalation = try requireDictionary(status["escalation"] as Any, label: "rico.recipient.status.escalation")
        guard status["version"] as? String == requiredGuardVersion,
              status["contractVersion"] as? String == requiredGuardContract,
              status["healthy"] as? Bool == true,
              status["paused"] as? Bool == paused,
              status["policySchema"] as? Int == 2,
              Set(stringArray(status["hooks"])) == requiredGuardHooks,
              Set(stringArray(status["tools"])) == requiredGuardTools,
              hookPermissions["allowConversationAccess"] as? Bool == true,
              hookPermissions["allowPromptInjection"] as? Bool == true,
              escalation["toolName"] as? String == escalationToolName,
              escalation["pluginConfigured"] as? Bool == true,
              escalation["originAuthorityHealthy"] as? Bool == true,
              enforcement["verified"] as? Bool == true,
              enforcement["authority"] as? String == "gateway",
              enforcement["contractVersion"] as? String == requiredGuardContract else {
            throw projectionError("The running Gateway did not prove Rico recipient enforcement (requiredGuardVersion).")
        }
    }

    private static func requireLiveGuardStatus(paused: Bool) async throws {
        let output = try await OpenClawPolicyCommand.run([
            "gateway", "call", "rico.recipient.status", "--json", "--timeout", "10000"
        ], timeoutSeconds: 12)
        guard let data = output.data(using: .utf8) else {
            throw projectionError("The running Gateway returned unreadable Rico enforcement status.")
        }
        do {
            try validateGuardStatus(try JSONSerialization.jsonObject(with: data), paused: paused)
        } catch let error as NSError where error.domain != "OpenClawStudio.RicoProjection" {
            throw projectionError("The running Gateway returned malformed Rico enforcement status (\(error.localizedDescription)).")
        }
    }

    private static func requireStableLiveGuardStatus(paused: Bool) async throws {
        try await requireLiveGuardStatus(paused: paused)
        // A single healthy sample can occur while Gateway plugins are being
        // installed or reloaded. Require a second exact contract proof before
        // native admission is enabled.
        try await Task.sleep(nanoseconds: 250_000_000)
        try await requireLiveGuardStatus(paused: paused)
    }

    private static func readJSONFile(_ url: URL) throws -> [String: Any] {
        do {
            return try requireDictionary(JSONSerialization.jsonObject(with: Data(contentsOf: url)), label: url.lastPathComponent)
        } catch let error as NSError where error.domain != "OpenClawStudio.RicoProjection" {
            throw projectionError("Studio could not read \(url.lastPathComponent) as JSON (\(error.localizedDescription)).")
        }
    }

    private static func stringArray(_ value: Any?) -> [String] {
        value as? [String] ?? []
    }

    private static func requireDictionary(_ value: Any, label: String) throws -> [String: Any] {
        guard let dictionary = value as? [String: Any] else { throw projectionError("\(label) was not a JSON object.") }
        return dictionary
    }

    private static func requireStringArray(_ value: Any, label: String) throws -> [String] {
        guard let array = value as? [String] else { throw projectionError("\(label) was not a string array.") }
        return array
    }

    private static func requireArrayOfDictionaries(_ value: Any, label: String) throws -> [[String: Any]] {
        guard let array = value as? [[String: Any]] else { throw projectionError("\(label) was not a JSON object array.") }
        return array
    }

    private static func dictionariesEqual(_ lhs: Any?, _ rhs: [String: Any]) -> Bool {
        guard let lhs = lhs as? [String: Any],
              JSONSerialization.isValidJSONObject(lhs), JSONSerialization.isValidJSONObject(rhs),
              let left = try? JSONSerialization.data(withJSONObject: lhs, options: [.sortedKeys]),
              let right = try? JSONSerialization.data(withJSONObject: rhs, options: [.sortedKeys]) else { return false }
        return left == right
    }

    private static func arraysOfDictionariesEqual(_ lhs: [[String: Any]], _ rhs: [[String: Any]]) -> Bool {
        guard JSONSerialization.isValidJSONObject(lhs), JSONSerialization.isValidJSONObject(rhs),
              let left = try? JSONSerialization.data(withJSONObject: lhs, options: [.sortedKeys]),
              let right = try? JSONSerialization.data(withJSONObject: rhs, options: [.sortedKeys]) else { return false }
        return left == right
    }

    private static func projectionError(_ message: String) -> NSError {
        NSError(domain: "OpenClawStudio.RicoProjection", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

private enum OpenClawPolicyCommand {
    static func json(path: String) async throws -> Any {
        let output = try await run(["config", "get", path, "--json"])
        do {
            // `openclaw config get --json` legitimately returns top-level
            // scalar JSON for leaf paths (for example a string dmScope or a
            // Boolean hook flag). Foundation rejects those values unless
            // fragments are explicitly allowed, which previously made a
            // correct live policy look unverifiable and forced an auto-pause.
            return try RicoNativePolicyProjection.decodeConfigJSON(output)
        } catch {
            throw NSError(domain: "OpenClawStudio.RicoProjection", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "OpenClaw returned malformed JSON for \(path) (\(error.localizedDescription))."
            ])
        }
    }

    static func run(_ arguments: [String], timeoutSeconds: TimeInterval = 15) async throws -> String {
        guard let executable = ["/opt/homebrew/bin/openclaw", "/usr/local/bin/openclaw"].first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            throw NSError(domain: "OpenClawStudio.RicoProjection", code: 3, userInfo: [NSLocalizedDescriptionKey: "The OpenClaw CLI is not installed in a supported location."])
        }
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        let result = try await BoundedProcessRunner.run(
            executable: URL(fileURLWithPath: executable),
            arguments: arguments,
            environment: environment,
            timeoutSeconds: timeoutSeconds
        )
        guard result.status == 0 else {
            throw NSError(domain: "OpenClawStudio.RicoProjection", code: Int(result.status), userInfo: [
                NSLocalizedDescriptionKey: "The bounded OpenClaw policy command failed without exposing its output."
            ])
        }
        return result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum IMessageCommand {
    static let probeArguments = [
        "channels", "status", "--probe", "--channel", "imessage",
        "--json", "--timeout", "20000",
    ]

    static var executablePath: String? {
        ["/opt/homebrew/bin/imsg", "/usr/local/bin/imsg"].first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    static func status() async throws -> String {
        guard let path = executablePath else {
            throw NSError(domain: "OpenClawStudio.Rico", code: 10, userInfo: [NSLocalizedDescriptionKey: "imsg was not found at /opt/homebrew/bin/imsg or /usr/local/bin/imsg."])
        }
        return try await Task.detached(priority: .utility) {
            try runCommand(executable: path, arguments: ["status", "--json"])
        }.value
    }

    static func gatewaySendParameters(to address: String, text: String, idempotencyKey: UUID) -> [String: Any] {
        [
            "to": address,
            "message": text,
            "channel": "imessage",
            // Keep this stable for the lifetime of the reviewed draft. If the
            // socket response is lost after platform delivery, an explicit
            // retry resolves through OpenClaw's Gateway dedupe cache instead
            // of creating a second iMessage.
            "idempotencyKey": "rico-studio-\(idempotencyKey.uuidString.lowercased())"
        ]
    }

    static func send(to address: String, text: String, idempotencyKey: UUID) async throws {
        // A reviewed Studio send is the sole one-time exception for an
        // unapproved target. The Gateway guard consumes this grant. Delivery
        // must also run through the Gateway: invoking `openclaw message send`
        // locally makes iMessage's direct adapter inherit Studio's TCC/FDA
        // identity rather than the already-authorized Gateway Node process.
        let grant = try RicoRecipientGuard.authorizeOwnerSend(target: address, message: text)
        // A cached Gateway success does not rerun message_sending, so always
        // remove this exact grant on return as well as on error. If the live
        // hook consumed it first, this is a harmless no-op.
        defer { try? FileManager.default.removeItem(at: grant) }
        let payload = try await GatewayClient().call(
            method: "send",
            params: gatewaySendParameters(to: address, text: text, idempotencyKey: idempotencyKey)
        )
        guard payload["channel"] as? String == "imessage",
              let messageID = payload["messageId"] as? String,
              !messageID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw GatewayClientError.invalidResponse
        }
    }

    static func probe() async throws -> String {
        try await runOpenClaw(probeArguments)
    }

    static func probeReportsReady(_ output: String) -> Bool {
        probeReadiness(output).transportOperational
    }

    /// Parses only the supported structured Gateway status contract. Current
    /// account and native-probe health may establish cold-start operability;
    /// a concrete receipt is tracked separately as delivery confirmation.
    static func probeReadiness(_ output: String) -> IMessageProbeReadiness {
        guard let data = output.data(using: .utf8), data.count <= 1_024 * 1_024,
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              statusPayloadIsComplete(root["partial"]),
              let defaults = root["channelDefaultAccountId"] as? [String: Any],
              let rawDefaultID = defaults["imessage"] as? String else {
            return .unavailable
        }
        let defaultID = rawDefaultID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !defaultID.isEmpty,
              let accountsByChannel = root["channelAccounts"] as? [String: Any],
              let rawAccounts = accountsByChannel["imessage"] as? [Any] else {
            return .unavailable
        }
        let matches = rawAccounts.compactMap { $0 as? [String: Any] }.filter {
            ($0["accountId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) == defaultID
        }
        guard matches.count == 1 else { return .unavailable }
        let account = matches[0]
        guard isJSONBoolean(account["enabled"], equalTo: true),
              isJSONBoolean(account["configured"], equalTo: true),
              isJSONBoolean(account["running"], equalTo: true),
              let probe = account["probe"] as? [String: Any],
              isJSONBoolean(probe["ok"], equalTo: true),
              let health = account["outboundDeliveryHealth"] as? [String: Any],
              Set(health.keys) == Set(["version", "state", "observedAt", "reason"]),
              isJSONNumber(health["version"], equalToInteger: 1),
              let state = health["state"] as? String,
              let reason = health["reason"] as? String,
              let observedAt = health["observedAt"] as? NSNumber,
              CFGetTypeID(observedAt) != CFBooleanGetTypeID(),
              observedAt.doubleValue.isFinite,
              observedAt.doubleValue >= 0 else {
            return .unavailable
        }
        if state == "degraded" {
            // lastError, outbound_delivery_degraded, awaiting receipt, and a
            // nonzero observedAt are delivery telemetry. A running account
            // with a healthy native probe stays operational.
            if reason == "successful_send_receipt_not_observed" {
                return .transportReady
            }
            return .deliveryDegraded
        }
        if state == "verified", reason == "successful_send_receipt" {
            return .verifiedDelivery
        }
        return .transportReady
    }

    private static func hasNonemptyString(_ value: Any?) -> Bool {
        guard let value = value as? String else { return false }
        return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func statusPayloadIsComplete(_ value: Any?) -> Bool {
        value == nil || isJSONBoolean(value, equalTo: false)
    }

    private static func isJSONBoolean(_ value: Any?, equalTo expected: Bool) -> Bool {
        guard let value = value as? NSNumber,
              CFGetTypeID(value) == CFBooleanGetTypeID() else { return false }
        return value.boolValue == expected
    }

    private static func isAbsentNullOrEmptyString(_ value: Any?) -> Bool {
        guard let value else { return true }
        if value is NSNull { return true }
        guard let value = value as? String else { return false }
        return value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func isJSONNumber(_ value: Any?, equalToInteger expected: Int) -> Bool {
        guard let value = value as? NSNumber,
              CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue.isFinite,
              value.doubleValue == Double(expected) else { return false }
        return true
    }

    static func groups() async throws -> [IMessageChat] {
        let payload = try await GatewayClient().call(method: "rico.imessage.groups", params: [:])
        let rows = payload["groups"] as? [[String: Any]] ?? []
        return rows.compactMap(IMessageChat.init(directory:))
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    private static func runOpenClaw(_ arguments: [String]) async throws -> String {
        // The inner CLI probe has a 20-second budget. Keep a slightly wider,
        // still-bounded process deadline so Studio does not kill a legitimate
        // result before OpenClaw's own timeout fires.
        try await OpenClawPolicyCommand.run(arguments, timeoutSeconds: 25)
    }

    private static func runCommand(executable: String, arguments: [String]) throws -> String {
        let process = Process()
        let output = Pipe()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        process.waitUntilExit()
        let stdout = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        guard process.terminationStatus == 0 else {
            throw NSError(domain: "OpenClawStudio.Rico", code: Int(process.terminationStatus), userInfo: [
                NSLocalizedDescriptionKey: stderr.isEmpty ? (stdout.isEmpty ? "OpenClaw iMessage command failed." : stdout) : stderr
            ])
        }
        return stdout + (stderr.isEmpty ? "" : "\n" + stderr)
    }
}

struct IMessageChat: Identifiable, Hashable {
    let id: String
    let target: String
    let displayName: String
    let service: String
    let participants: [String]
    let explicitName: String?

    init?(_ raw: [String: Any]) {
        guard let numericID = raw["id"] else { return nil }
        id = String(describing: numericID)
        target = "chat_id:\(id)"
        participants = raw["participants"] as? [String] ?? []
        service = raw["service"] as? String ?? "Messages"
        let supplied = (raw["display_name"] as? String ?? raw["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        explicitName = supplied.isEmpty ? nil : RicoContactDirectory.safeDisplayName(supplied)
        displayName = explicitName ?? "Unnamed group"
    }

    init?(directory raw: [String: Any]) {
        let rawID = raw["chatId"] ?? raw["chat_id"] ?? raw["groupId"] ?? raw["id"] ?? raw["target"]
        guard let rawID else { return nil }
        var stable = String(describing: rawID)
        if stable.hasPrefix("chat_id:") { stable.removeFirst("chat_id:".count) }
        id = stable
        let suppliedTarget = raw["target"] as? String
        target = suppliedTarget?.contains(":") == true ? suppliedTarget! : "chat_id:\(stable)"
        service = raw["service"] as? String ?? raw["channel"] as? String ?? "iMessage"
        participants = raw["participants"] as? [String] ?? raw["members"] as? [String] ?? []
        let supplied = (raw["displayName"] as? String ?? raw["display_name"] as? String ?? raw["name"] as? String ?? raw["title"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        explicitName = supplied.isEmpty ? nil : RicoContactDirectory.safeDisplayName(supplied)
        displayName = explicitName ?? "Unnamed group"
    }
}

enum RicoGroupDirectoryNaming {
    static func friendlyName(for group: IMessageChat, contacts: [LocalContact]) -> String {
        if let explicit = group.explicitName, !explicit.isEmpty { return explicit }
        let names = uniqueNames(for: group.participants, contacts: contacts)
        let total = RicoGroupMembership.normalized(group.participants).count
        guard !names.isEmpty else { return total == 1 ? "Unnamed conversation" : "Unnamed group" }
        if names.count == 1 {
            let others = max(0, total - 1)
            return others == 0 ? names[0] : "\(names[0]) & \(others) other\(others == 1 ? "" : "s")"
        }
        if names.count == 2, total <= 2 { return "\(names[0]) & \(names[1])" }
        let shown = Array(names.prefix(2))
        let others = max(0, total - shown.count)
        return others == 0
            ? shown.joined(separator: " & ")
            : "\(shown.joined(separator: ", ")) & \(others) other\(others == 1 ? "" : "s")"
    }

    static func participantPreview(for group: IMessageChat, contacts: [LocalContact]) -> String {
        let names = uniqueNames(for: group.participants, contacts: contacts)
        let total = RicoGroupMembership.normalized(group.participants).count
        guard !names.isEmpty else { return "\(total) participant\(total == 1 ? "" : "s")" }
        let shown = Array(names.prefix(3))
        let remainder = max(0, total - shown.count)
        return remainder == 0
            ? shown.joined(separator: ", ")
            : "\(shown.joined(separator: ", ")) + \(remainder) more"
    }

    private static func uniqueNames(for addresses: [String], contacts: [LocalContact]) -> [String] {
        Array(Set(RicoContactDirectory.displayNames(for: addresses, contacts: contacts).values))
            .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }
}

enum RicoCommunicationsWorkspace: String, CaseIterable, Identifiable {
    case send = "Send"
    case access = "People & groups"
    case queue = "Queue"

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .send: "square.and.pencil"
        case .access: "person.2.badge.gearshape"
        case .queue: "tray.full"
        }
    }
}

enum RicoPolicyFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case people = "People"
    case groups = "Groups"

    var id: String { rawValue }
}

enum RicoStatusTone: Equatable {
    case neutral
    case working
    case success
    case warning

    static func classify(_ message: String) -> RicoStatusTone {
        let value = message.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !value.isEmpty else { return .neutral }
        let warningTerms = ["failed", "error", "could not", "unavailable", "degraded", "denied", "permission", "offline", "not ready", "not configured", "missing", "blocked", "refusing", "unknown"]
        if warningTerms.contains(where: value.contains) { return .warning }
        let workingTerms = ["verifying", "checking", "refreshing", "sending", "applying", "probing"]
        if workingTerms.contains(where: value.contains) { return .working }
        let successTerms = ["applied and verified", "saved and verified", "confirmed", "sent to", "cleared", "removed the outbound draft"]
        if successTerms.contains(where: value.contains) { return .success }
        return .neutral
    }
}

struct RicoCommunicationsView: View {
    @StateObject private var contacts = ContactsStore()
    @StateObject private var store: RicoCommunicationsStore
    @StateObject private var peopleProfiles = RicoPeopleProfileStore()
    @StateObject private var emailAuthorizations = RicoPersonEmailAuthorizationStore()
    @State private var query = ""
    @State private var matches: [LocalContact] = []
    @State private var selectedContact: LocalContact?
    @State private var selectedAddress = ""
    @State private var access: RicoAccessLevel = .approved
    @State private var composeIntent: RicoDraftIntent = .opening
    @State private var message = ""
    @State private var reviewDraft: RicoDraftReview?
    @State private var reviewPolicy = false
    @State private var showAddIdentity = false
    @State private var showCreateGroup = false
    @State private var imsgProbe = "Not probed"
    @State private var imessageProbeGeneration = 0
    @State private var groups: [IMessageChat] = []
    @State private var selectedGroupID = ""
    @State private var recipientKind = 0
    @State private var workspace: RicoCommunicationsWorkspace = .send
    @State private var policyFilter: RicoPolicyFilter = .all
    @State private var policySearch = ""
    @State private var loadingGroups = false
    @State private var groupDiscoveryError: String?
    @State private var groupLoadGeneration = 0
    @State private var awaitingGroupCreation = false
    @State private var showDiagnostics = false
    @State private var showStatusDetails = false
    @State private var confirmResume = false
    @State private var reviewGroup: IMessageChat?
    @State private var policyPendingRemoval: RicoRecipientPolicy?
    @State private var profileTarget: RicoRecipientPolicy?
    @EnvironmentObject private var gateway: StudioStore

    @MainActor
    init(store: RicoCommunicationsStore? = nil) {
        _store = StateObject(wrappedValue: store ?? RicoCommunicationsStore())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            if store.globalPaused {
                pausedBanner
            } else if store.enforcementState == .applying {
                verificationBanner
            }
            healthOverview
            if !store.status.isEmpty { statusBanner }
            workspacePicker
            switch workspace {
            case .send: composer
            case .access: policyPanel
            case .queue: draftsPanel
            }
            diagnosticsPanel
        }
        .animation(.easeInOut(duration: 0.18), value: workspace)
        .animation(.easeInOut(duration: 0.18), value: store.globalPaused)
        .animation(.easeInOut(duration: 0.18), value: store.healthQuarantined)
        .onAppear { contacts.load(); probeIMessage(); loadGroups() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            contacts.refreshAuthorization()
            if awaitingGroupCreation { refreshAfterGroupCreation() }
        }
        .onChange(of: contacts.contacts) { _, loaded in
            store.refreshParticipantNames(from: loaded)
        }
        .sheet(item: $reviewDraft) { review in
            RicoDraftReviewSheet(review: review) {
                reviewDraft = nil
            } onConfirm: {
                store.approve(review.draft)
                workspace = .queue
                reviewDraft = nil
            }
        }
        .sheet(item: $profileTarget) { policy in
            RicoPersonProfileSheet(
                policy: policy,
                contact: contacts.contacts.first { $0.id == policy.contactID },
                peopleProfiles: peopleProfiles,
                emailAuthorizations: emailAuthorizations
            )
        }
        .confirmationDialog("Approve this iMessage group?", isPresented: Binding(get: { reviewGroup != nil }, set: { if !$0 { reviewGroup = nil } })) {
            if let group = reviewGroup {
                Button("Approve exact group") {
                    store.approve(group: group, contacts: contacts.contacts)
                    workspace = .access
                    reviewGroup = nil
                }
                Button("Cancel", role: .cancel) { reviewGroup = nil }
            }
        } message: {
            Text(groupApprovalSummary)
        }
        .confirmationDialog("Resume Rico messaging?", isPresented: $confirmResume) {
            Button("Resume messaging") { store.setGlobalPaused(false) }
            Button("Keep paused", role: .cancel) {}
        } message: {
            Text("Approved people and groups will be able to invoke Rico again under their current mention and quiet-hour rules.")
        }
        .confirmationDialog("Remove this approved route?", isPresented: Binding(get: { policyPendingRemoval != nil }, set: { if !$0 { policyPendingRemoval = nil } })) {
            if let policy = policyPendingRemoval {
                Button("Remove access", role: .destructive) {
                    _ = emailAuthorizations.remove(for: policy.address)
                    store.remove(policy)
                    policyPendingRemoval = nil
                }
                Button("Keep access", role: .cancel) { policyPendingRemoval = nil }
            }
        } message: {
            Text("Rico will stop admitting this exact person or group after the native OpenClaw policy is verified.")
        }
        .sheet(isPresented: $reviewPolicy) {
            VStack(alignment: .leading, spacing: 14) {
                Text("Review recipient policy").font(.title2.bold())
                Text("Name: \(selectedContact?.name ?? "Unknown")")
                Text("Stable identity: \(selectedAddress)")
                Text("Authority: \(access.rawValue)")
                Text("Require @rico: yes")
                Text("Automatic replies: enabled for @rico mentions after approval")
                Text("This updates Rico's shared Gateway enforcement registry. Unknown recipients remain blocked.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Spacer()
                    Button("Cancel") { reviewPolicy = false }
                    Button("Apply reviewed mapping") {
                        if let contact = selectedContact {
                            store.approve(contact: contact, address: selectedAddress, access: access)
                        }
                        reviewPolicy = false
                    }.buttonStyle(.borderedProminent)
                }
            }.padding(28).frame(width: 480)
        }
        .sheet(isPresented: $showAddIdentity) {
            RicoIdentityEditorSheet(contacts: contacts, store: store)
        }
        .sheet(isPresented: $showCreateGroup) {
            RicoGroupComposerSheet(contacts: contacts) {
                awaitingGroupCreation = true
            }
        }
        .popover(isPresented: $showStatusDetails) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Communications status").font(.headline)
                Text(store.status).font(.callout).textSelection(.enabled)
                Divider()
                Button("Open technical details") {
                    showStatusDetails = false
                    showDiagnostics = true
                }
            }
            .padding(18)
            .frame(width: 460)
        }
    }

    private func probeIMessage() {
        imessageProbeGeneration += 1
        let generation = imessageProbeGeneration
        let storeGeneration = store.beginIMessageProbeObservation()
        imsgProbe = "Checking Gateway iMessage…"
        Task {
            do {
                let output = try await IMessageCommand.probe()
                guard generation == imessageProbeGeneration else { return }
                let readiness = IMessageCommand.probeReadiness(output)
                guard store.observeIMessageProbe(readiness, generation: storeGeneration) else { return }
                switch readiness {
                case .transportReady:
                    imsgProbe = "Gateway iMessage ready · first receipt pending"
                case .verifiedDelivery:
                    imsgProbe = "Gateway iMessage ready"
                case .deliveryDegraded:
                    imsgProbe = "Gateway iMessage delivery degraded"
                case .unavailable:
                    imsgProbe = "Gateway iMessage not ready"
                }
            } catch {
                guard generation == imessageProbeGeneration else { return }
                guard store.observeIMessageProbe(.unavailable, generation: storeGeneration) else { return }
                imsgProbe = "Gateway iMessage status unavailable"
            }
        }
    }

    private func loadGroups() {
        groupLoadGeneration += 1
        let generation = groupLoadGeneration
        loadingGroups = true
        Task {
            do {
                let discovered = try await IMessageCommand.groups()
                guard generation == groupLoadGeneration else { return }
                groups = discovered
                groupDiscoveryError = nil
                store.refreshGroupParticipants(from: groups, contacts: contacts.contacts)
            }
            catch {
                guard generation == groupLoadGeneration else { return }
                // OpenClaw 2026.7's iMessage adapter does not implement the
                // optional directory-groups capability. That must not poison
                // the outbound queue or imply that direct delivery is broken.
                if error.localizedDescription.localizedCaseInsensitiveContains("does not support directory groups") {
                    groups = []
                    groupDiscoveryError = "This Gateway does not currently expose existing iMessage groups. Direct messages remain available."
                } else {
                    groupDiscoveryError = error.localizedDescription
                    store.status = "Group discovery unavailable: \(error.localizedDescription)"
                }
            }
            if generation == groupLoadGeneration { loadingGroups = false }
        }
    }

    private func refreshAfterGroupCreation() {
        awaitingGroupCreation = false
        loadGroups()
        Task {
            try? await Task.sleep(for: .seconds(2))
            loadGroups()
        }
    }

    private var header: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 16) {
                headerTitle
                Spacer()
                headerActions
            }
            VStack(alignment: .leading, spacing: 12) {
                headerTitle
                headerActions
            }
        }
    }

    private var headerTitle: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Rico Communications")
                .font(.system(size: 30, weight: .bold, design: .rounded))
            Text("A controlled iMessage workspace for people, groups, and reviewed outbound messages.")
                .foregroundStyle(.secondary)
        }
    }

    private var headerActions: some View {
        HStack(spacing: 10) {
            StudioStatusPill(label: enforcementLabel, color: enforcementColor, symbol: enforcementSymbol)
            if case .failed = store.enforcementState {
                Button("Retry") { store.retryEnforcement() }.buttonStyle(.bordered)
            }
            if store.globalPaused {
                Button("Resume") { confirmResume = true }
                    .buttonStyle(.borderedProminent)
                    .tint(StudioDesign.accent)
            } else {
                Button("Pause all", role: .destructive) { store.setGlobalPaused(true) }
                    .buttonStyle(.bordered)
            }
            Button {
                contacts.refreshAuthorization()
                probeIMessage()
                loadGroups()
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .help("Refresh Contacts, iMessage, and group status")
            .disabled(contacts.loading || loadingGroups)
            .accessibilityLabel("Refresh communications status")
        }
    }

    private var pausedBanner: some View {
        HStack(spacing: 12) {
            Image(systemName: pauseVerified ? "pause.circle.fill" : "exclamationmark.triangle.fill")
                .font(.title2).foregroundStyle(pauseVerified ? .orange : .red)
            VStack(alignment: .leading, spacing: 2) {
                Text(pauseVerified ? "All Rico messaging is paused" : "Messaging pause needs verification").font(.headline)
                Text(pauseVerified
                     ? "Rico's recipient guard is paused. Native OpenClaw controls are verified or still synchronizing."
                     : "Studio could not verify the current enforcement state. Retry before relying on this pause.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Spacer()
            if pauseVerified {
                Button("Review and resume") { confirmResume = true }.buttonStyle(.bordered)
            } else {
                Button("Retry enforcement") { store.retryEnforcement() }.buttonStyle(.borderedProminent)
            }
        }
        .padding(14)
        .background((pauseVerified ? Color.orange : Color.red).opacity(0.10), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke((pauseVerified ? Color.orange : Color.red).opacity(0.22)))
    }

    private var verificationBanner: some View {
        HStack(spacing: 12) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.title2).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text("Verifying Rico policy").font(.headline)
                Text("Admission stays open while Studio checks the local model, Gateway guard, and native policy. This is not a Pause.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Spacer()
            if store.requiresIntentReview {
                Button("Review and activate") { confirmResume = true }.buttonStyle(.borderedProminent)
            } else {
                Button("Retry") { store.retryEnforcement() }.buttonStyle(.bordered)
            }
        }
        .padding(14)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.secondary.opacity(0.18)))
    }

    private var healthOverview: some View {
        StudioCard(padding: 12) {
            ScrollView(.horizontal, showsIndicators: true) {
                HStack(spacing: 12) {
                    healthItem(
                        title: "Contacts",
                        value: contacts.canReadContacts ? "Ready" : contacts.authorizationLabel,
                        symbol: contacts.canReadContacts ? "person.crop.circle.badge.checkmark" : "person.crop.circle.badge.exclamationmark",
                        color: contacts.canReadContacts ? StudioDesign.accent : .orange
                    )
                    Divider().frame(height: 32)
                    healthItem(
                        title: "iMessage",
                        value: imessageReady ? "Online" : imessageChecking ? "Checking" : imessageDeliveryDegraded ? "Delivery degraded" : "Attention",
                        symbol: imessageReady ? "message.fill" : "exclamationmark.bubble.fill",
                        color: imessageReady ? .green : imessageChecking ? .secondary : .orange
                    )
                    Divider().frame(height: 32)
                    healthItem(
                        title: "Approved routes",
                        value: "\(activePeopleCount) \(activePeopleCount == 1 ? "person" : "people") · \(activeGroupCount) \(activeGroupCount == 1 ? "group" : "groups")",
                        symbol: "person.2.badge.gearshape",
                        color: StudioDesign.violet
                    )
                    Divider().frame(height: 32)
                    healthItem(
                        title: "Queue",
                        value: "\(pendingDraftCount) waiting · \(approvedDraftCount) ready",
                        symbol: "tray.full.fill",
                        color: pendingDraftCount > 0 ? .orange : .blue
                    )
                }
            }
        }
    }

    private func healthItem(title: String, value: String, symbol: String, color: Color) -> some View {
        HStack(spacing: 9) {
            Image(systemName: symbol).foregroundStyle(color).frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(title.uppercased()).font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                Text(value).font(.subheadline.weight(.semibold)).lineLimit(1)
            }
        }
        .frame(minWidth: 145, alignment: .leading)
    }

    private var statusBanner: some View {
        let tone = RicoStatusTone.classify(store.status)
        let color = statusColor(tone)
        return HStack(alignment: .top, spacing: 10) {
            if tone == .working {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: statusSymbol(tone)).foregroundStyle(color)
            }
            Text(store.status).font(.callout).lineLimit(2)
            Spacer()
            Button("Details") { showStatusDetails = true }
                .buttonStyle(.plain).foregroundStyle(.secondary)
            Button { store.status = "" } label: { Image(systemName: "xmark") }
                .buttonStyle(.plain).foregroundStyle(.secondary)
                .accessibilityLabel("Dismiss status")
        }
        .padding(12)
        .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var workspacePicker: some View {
        HStack {
            Picker("Workspace", selection: $workspace) {
                ForEach(RicoCommunicationsWorkspace.allCases) { item in
                    Label(item.rawValue, systemImage: item.symbol).tag(item)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 620)
            Spacer()
        }
    }

    private var composer: some View {
        StudioCard {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(composeIntent == .opening ? "Opening message" : "Compose a reviewed message").font(.title2.bold())
                    Text(composeIntent == .opening
                         ? "Define the exact line Rico should use to start a conversation. It remains a draft until you review it, add it to the queue, and separately press Send."
                         : "Choose one exact destination. Nothing sends until it reaches the queue and you press Send.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                Picker("Message purpose", selection: $composeIntent) {
                    ForEach(RicoDraftIntent.allCases) { intent in
                        Label(intent.rawValue, systemImage: intent == .opening ? "text.quote" : "text.bubble").tag(intent)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 430)
                Picker("Recipient type", selection: $recipientKind) {
                    Label("Person", systemImage: "person.fill").tag(0)
                    Label("Group chat", systemImage: "person.3.fill").tag(1)
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 430)

                if recipientKind == 0 { individualRecipientPicker }
                else { groupRecipientPicker }

                Divider()
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(composeIntent.rawValue).font(.headline)
                        Spacer()
                        Text("\(message.count) characters").font(.caption).foregroundStyle(.secondary).monospacedDigit()
                    }
                    ZStack(alignment: .topLeading) {
                        TextEditor(text: $message)
                            .scrollContentBackground(.hidden)
                            .padding(8)
                            .frame(height: 150)
                        if message.isEmpty {
                            Text(composeIntent == .opening
                                 ? "Write the exact opening line Rico should use…"
                                 : "Write the exact message Rico should send…")
                                .foregroundStyle(.tertiary)
                                .padding(.horizontal, 13).padding(.vertical, 16)
                                .allowsHitTesting(false)
                        }
                    }
                    .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(.quaternary))
                }
                HStack {
                    Label("Reviewing does not send. A single-use grant is created only when you press Send in the queue.", systemImage: "lock.shield")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button(composeIntent == .opening ? "Review opening message" : "Review message") { stageCurrentDraft() }
                        .buttonStyle(.borderedProminent)
                        .tint(StudioDesign.violet)
                        .disabled(!canReviewDraft)
                }
            }
        }
    }

    private var individualRecipientPicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !contacts.canReadContacts {
                contactsAccessCallout
            } else {
                TextField("Search Contacts by name", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: query) { _, value in resolve(value) }
                if matches.count > 1 {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Choose the exact person").font(.caption.weight(.semibold)).foregroundStyle(.secondary).padding(10)
                        ForEach(matches.prefix(8)) { contact in
                            Button { choose(contact) } label: {
                                HStack {
                                    Image(systemName: "person.crop.circle")
                                    Text(contact.name)
                                    Spacer()
                                    Text("\(contact.phones.count) phone · \(contact.emails.count) email")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                .padding(.horizontal, 10).padding(.vertical, 8)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            Divider()
                        }
                    }
                    .background(.background.opacity(0.55), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(.quaternary))
                }
                if let contact = selectedContact {
                    selectedPersonCard(contact)
                } else if !query.isEmpty && !contacts.loading && matches.isEmpty {
                    Label("No exact contact selected. Rico never guesses a recipient.", systemImage: "magnifyingglass")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func selectedPersonCard(_ contact: LocalContact) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "person.crop.circle.fill")
                .font(.title).foregroundStyle(StudioDesign.accent)
            VStack(alignment: .leading, spacing: 5) {
                Text(contact.name).font(.headline)
                Picker("Exact address", selection: $selectedAddress) {
                    ForEach(addresses(for: contact), id: \.self) { Text($0).tag($0) }
                }
                .labelsHidden()
                .frame(maxWidth: 360)
            }
            Spacer()
            if let policy = selectedRecipientPolicy {
                StudioStatusPill(
                    label: policy.access == .blocked ? "Blocked" : policy.access == .owner ? "Owner" : "Approved",
                    color: policy.access == .blocked ? .red : .green,
                    symbol: policy.access == .blocked ? "hand.raised.fill" : "checkmark.shield.fill"
                )
            } else {
                Button("Approve for @rico") {
                    access = .approved
                    store.status = "Reviewing exact identity \(selectedAddress)…"
                    reviewPolicy = true
                }
                .buttonStyle(.bordered)
                .disabled(selectedAddress.isEmpty)
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var groupRecipientPicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Button {
                    contacts.load()
                    showCreateGroup = true
                } label: {
                    Label("Create group in Messages", systemImage: "person.3.sequence")
                }
                .buttonStyle(.bordered)
                Button { loadGroups() } label: {
                    Label(loadingGroups ? "Loading groups" : "Refresh groups", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .disabled(loadingGroups)
                if loadingGroups { ProgressView().controlSize(.small) }
            }
            if groups.isEmpty && !loadingGroups {
                if let groupDiscoveryError {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Group discovery needs attention").font(.headline)
                            Text(groupDiscoveryError).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                        }
                        Spacer()
                        Button("Try again") { loadGroups() }.buttonStyle(.bordered)
                    }
                    .padding(12)
                    .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                } else {
                    Label("No existing group chats were found. You can create one in Messages, then refresh.", systemImage: "person.3")
                        .font(.callout).foregroundStyle(.secondary)
                }
            } else {
                Picker("Group chat", selection: $selectedGroupID) {
                    Text("Choose a group by name").tag("")
                    ForEach(namedGroups) { group in
                        Text("\(friendlyGroupName(group)) — \(RicoGroupDirectoryNaming.participantPreview(for: group, contacts: contacts.contacts))")
                            .tag(group.id)
                    }
                }
                if let group = selectedGroup {
                    HStack(spacing: 12) {
                        Image(systemName: "person.3.fill").font(.title2).foregroundStyle(StudioDesign.violet)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(friendlyGroupName(group)).font(.headline)
                            Text(RicoGroupDirectoryNaming.participantPreview(for: group, contacts: contacts.contacts))
                                .font(.caption).foregroundStyle(.secondary)
                            Text(groupSenderSummary(group))
                                .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                        Spacer()
                        if let policy = selectedGroupPolicy {
                            if groupMembershipChanged(group, policy: policy) {
                                VStack(alignment: .trailing, spacing: 6) {
                                    StudioStatusPill(label: "Review sender changes", color: .orange, symbol: "person.crop.circle.badge.exclamationmark")
                                    Button("Review senders") { reviewGroup = group }.buttonStyle(.bordered)
                                }
                            } else {
                                StudioStatusPill(label: "Approved senders", color: .green, symbol: "checkmark.shield.fill")
                            }
                        } else {
                            Button("Review group access") { reviewGroup = group }.buttonStyle(.bordered)
                        }
                    }
                    .padding(12)
                    .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
            }
        }
    }

    private var policyPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("People & groups").font(.title2.bold())
                    Text("Only these exact identities can invoke Rico. Display names are never authentication.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    contacts.load()
                    showAddIdentity = true
                } label: {
                    Label("Add person", systemImage: "person.badge.plus")
                }
                .buttonStyle(.borderedProminent)
                .tint(StudioDesign.violet)
                Button {
                    recipientKind = 1
                    workspace = .send
                    loadGroups()
                } label: {
                    Label("Approve group", systemImage: "person.3")
                }
                .buttonStyle(.bordered)
            }
            HStack {
                Picker("Filter", selection: $policyFilter) {
                    ForEach(RicoPolicyFilter.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 360)
                TextField("Search approved routes", text: $policySearch)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 340)
                Spacer()
            }
            if filteredPolicies.isEmpty {
                StudioCard {
                    ContentUnavailableView {
                        Label(store.policies.isEmpty ? "No approved routes" : "No matching routes", systemImage: "person.badge.shield.checkmark")
                    } description: {
                        Text(store.policies.isEmpty
                             ? "Add a person or approve one exact iMessage group. Unknown identities remain blocked."
                             : "Change the filter or search to see another approved route.")
                    } actions: {
                        if store.policies.isEmpty {
                            Button("Add approved person") { contacts.load(); showAddIdentity = true }
                                .buttonStyle(.borderedProminent)
                        }
                    }
                }
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 560), spacing: 12)], spacing: 12) {
                    ForEach(filteredPolicies) { policy in
                        RicoPolicyRow(
                            policy: binding(for: policy),
                            onRemove: { policyPendingRemoval = policy },
                            onProfile: policy.groupChatID == nil && policy.access != .owner
                                ? { profileTarget = policy }
                                : nil
                        )
                    }
                }
            }
        }
    }

    private var draftsPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Outbound queue").font(.title2.bold())
                    Text("Reviewed drafts remain inert until you explicitly send them.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                if store.drafts.contains(where: { $0.state == .sent || $0.state == .blocked }) {
                    Button("Clear finished") { store.clearFinishedDrafts() }.buttonStyle(.bordered)
                }
                Button("New message") { workspace = .send }.buttonStyle(.borderedProminent).tint(StudioDesign.violet)
            }
            if store.drafts.isEmpty {
                StudioCard {
                    ContentUnavailableView(
                        "Queue is empty",
                        systemImage: "tray",
                        description: Text("Compose a message, review its exact target, then return here to send it.")
                    )
                }
            } else {
                ForEach(store.drafts.prefix(30)) { draft in
                    draftRow(draft)
                }
            }
        }
    }

    private func draftRow(_ draft: RicoDraft) -> some View {
        StudioCard(padding: 14) {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: draftStateSymbol(draft.state))
                    .font(.title3).foregroundStyle(draftStateColor(draft.state)).frame(width: 28)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(draft.recipientName).font(.headline)
                        Text(draft.resolvedIntent.rawValue)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        StudioStatusPill(label: draft.state.rawValue.capitalized, color: draftStateColor(draft.state), symbol: draftStateSymbol(draft.state))
                    }
                    Text(RicoRecipientGuard.normalizeTarget(draft.address).hasPrefix("chat_") ? "iMessage group" : draft.address)
                        .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    Text(draft.message).lineLimit(3).textSelection(.enabled)
                    Text(draft.reason).font(.caption).foregroundStyle(.secondary)
                    Text(draft.createdAt.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption2).foregroundStyle(.tertiary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 8) {
                    if draft.state == .pending {
                        Button("Approve") { store.approve(draft) }.buttonStyle(.bordered)
                    }
                    if draft.state == .approved {
                        Button("Send") { Task { await store.send(draft) } }
                            .buttonStyle(.borderedProminent).tint(StudioDesign.violet)
                            .disabled(!store.outboundAdmissionVerified || store.outboundSendInFlight)
                    }
                    Button(role: .destructive) { store.discard(draft) } label: { Image(systemName: "trash") }
                        .buttonStyle(.borderless).help("Remove draft")
                        .disabled(store.draftIsInFlight(draft.id))
                }
            }
        }
    }

    private var diagnosticsPanel: some View {
        StudioCard(padding: 14) {
            DisclosureGroup(isExpanded: $showDiagnostics) {
                VStack(alignment: .leading, spacing: 10) {
                    Divider()
                    diagnosticRow("iMessage probe", value: imsgProbe)
                    diagnosticRow("Gateway channel", value: gatewayIMessageState)
                    diagnosticRow("Contacts authorization", value: contacts.authorizationLabel)
                    diagnosticRow("Discovered group chats", value: "\(groups.count)")
                    diagnosticRow("Policy identities", value: "\(store.policies.count)")
                    if !store.status.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Latest status").foregroundStyle(.secondary)
                            Text(store.status).font(.callout.monospaced()).textSelection(.enabled)
                        }
                    }
                    Text("Studio resolves Contacts locally. OpenClaw Gateway owns Messages database access, admission, and delivery.")
                        .font(.caption).foregroundStyle(.secondary)
                    if contacts.loading { ProgressView("Refreshing Contacts access…") }
                    if let error = contacts.error {
                        Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                    }
                    if contacts.repairRequiresRelaunch {
                        Button("Quit OpenClaw Studio") { NSApp.terminate(nil) }.buttonStyle(.borderedProminent)
                    }
                    HStack {
                        Button("Probe iMessage again") { probeIMessage() }.buttonStyle(.bordered)
                        if !contacts.canReadContacts {
                            Button(contacts.authorization == .denied ? "Open Contacts Settings" : "Request Contacts Access") {
                                contacts.authorization == .denied ? contacts.repairAccess() : contacts.requestAccess()
                            }
                            .buttonStyle(.bordered)
                            .disabled(contacts.loading)
                        }
                    }
                }
                .padding(.top, 10)
            } label: {
                Label("Technical details", systemImage: "stethoscope")
                    .font(.headline)
            }
        }
    }

    private func diagnosticRow(_ label: String, value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.callout.monospaced()).textSelection(.enabled)
        }
    }

    private var contactsAccessCallout: some View {
        HStack(spacing: 12) {
            Image(systemName: "person.crop.circle.badge.exclamationmark").font(.title2).foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 3) {
                Text("Contacts access required").font(.headline)
                Text("Allow Contacts so Studio can resolve a name to an exact phone number or email.")
                    .font(.caption).foregroundStyle(.secondary)
                if let error = contacts.error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
            }
            Spacer()
            Button(contacts.authorization == .denied ? "Open Settings" : "Request Access") {
                contacts.authorization == .denied ? contacts.repairAccess() : contacts.requestAccess()
            }
            .buttonStyle(.borderedProminent)
            .disabled(contacts.loading)
        }
        .padding(12)
        .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var imessageReady: Bool { store.imessageProbeReadiness?.transportOperational == true }
    private var imessageDeliveryDegraded: Bool { store.imessageProbeReadiness == .deliveryDegraded }
    private var imessageChecking: Bool { store.imessageProbeReadiness == nil }
    private var enforcementLabel: String {
        switch store.enforcementState {
        case .applying: store.globalPaused ? "Pause syncing" : "Policy syncing"
        case .verified: store.globalPaused ? "Messaging paused" : "Guard verified"
        case .failed: store.globalPaused ? "Pause retrying" : "Verification retrying"
        }
    }
    private var enforcementColor: Color {
        switch store.enforcementState {
        case .applying: .orange
        case .verified: store.globalPaused ? .orange : .green
        case .failed: store.globalPaused ? .orange : .secondary
        }
    }
    private var enforcementSymbol: String {
        switch store.enforcementState {
        case .applying: "arrow.triangle.2.circlepath"
        case .verified: store.globalPaused ? "pause.fill" : "checkmark.shield.fill"
        case .failed: "arrow.triangle.2.circlepath"
        }
    }
    private var pauseVerified: Bool {
        if case .failed = store.enforcementState { return false }
        return true
    }
    private var gatewayIMessageState: String { gateway.channelRecords.first(where: { $0.id.lowercased() == "imessage" })?.state ?? "Not configured" }
    private var activePeopleCount: Int {
        Set(store.policies.filter { $0.groupChatID == nil && $0.access != .blocked && $0.autoReply }
            .map { $0.contactID.isEmpty ? $0.id : $0.contactID }).count
    }
    private var activeGroupCount: Int {
        store.policies.filter {
            $0.groupChatID != nil && $0.access != .blocked && $0.autoReply && !($0.participantAddresses ?? []).isEmpty
        }.count
    }
    private var pendingDraftCount: Int { store.drafts.filter { $0.state == .pending }.count }
    private var approvedDraftCount: Int { store.drafts.filter { $0.state == .approved }.count }
    private func statusColor(_ tone: RicoStatusTone) -> Color {
        switch tone {
        case .neutral: .blue
        case .working: .blue
        case .success: .green
        case .warning: .orange
        }
    }
    private func statusSymbol(_ tone: RicoStatusTone) -> String {
        switch tone {
        case .neutral: "info.circle.fill"
        case .working: "arrow.triangle.2.circlepath"
        case .success: "checkmark.circle.fill"
        case .warning: "exclamationmark.triangle.fill"
        }
    }
    private var selectedGroup: IMessageChat? { groups.first { $0.id == selectedGroupID } }
    private var namedGroups: [IMessageChat] {
        groups.sorted {
            let lhs = friendlyGroupName($0)
            let rhs = friendlyGroupName($1)
            let comparison = lhs.localizedCaseInsensitiveCompare(rhs)
            if comparison != .orderedSame { return comparison == .orderedAscending }
            return RicoGroupDirectoryNaming.participantPreview(for: $0, contacts: contacts.contacts)
                .localizedCaseInsensitiveCompare(
                    RicoGroupDirectoryNaming.participantPreview(for: $1, contacts: contacts.contacts)
                ) == .orderedAscending
        }
    }
    private func friendlyGroupName(_ group: IMessageChat) -> String {
        RicoGroupDirectoryNaming.friendlyName(for: group, contacts: contacts.contacts)
    }
    private var selectedGroupPolicy: RicoRecipientPolicy? { store.policies.first { $0.groupChatID == selectedGroupID } }
    private var groupApprovalSummary: String {
        guard let group = reviewGroup else { return "No group access will be changed." }
        let names = RicoContactDirectory.displayNames(for: group.participants, contacts: contacts.contacts)
        let uniqueNames = Array(Set(names.values)).sorted()
        let unresolved = max(0, Set(group.participants.map(RicoRecipientGuard.normalizeTarget)).count - names.count)
        var detail = "Approving this exact chat lets \(group.participants.count) current sender address\(group.participants.count == 1 ? "" : "es") invoke @rico. Replies are visible to everyone in the chat."
        if !uniqueNames.isEmpty { detail += " Matched in Contacts: \(uniqueNames.joined(separator: ", "))." }
        if unresolved > 0 { detail += " \(unresolved) sender \(unresolved == 1 ? "is" : "are") not uniquely matched in Contacts and will remain unnamed to Rico." }
        return detail
    }
    private func groupSenderSummary(_ group: IMessageChat) -> String {
        let approved = selectedGroupPolicy?.participantAddresses ?? group.participants
        let names = RicoContactDirectory.displayNames(for: approved, contacts: contacts.contacts)
        let suffix = groupMembershipChanged(group, policy: selectedGroupPolicy)
            ? " · membership changed"
            : ""
        return "\(approved.count) allowed sender address\(approved.count == 1 ? "" : "es") · \(names.count) matched to Contacts\(suffix)"
    }
    private func groupMembershipChanged(_ group: IMessageChat, policy: RicoRecipientPolicy?) -> Bool {
        guard let policy else { return false }
        return RicoGroupMembership.requiresReview(
            approved: policy.participantAddresses ?? [],
            discovered: group.participants
        )
    }
    private var selectedRecipientPolicy: RicoRecipientPolicy? {
        let target = RicoRecipientGuard.normalizeTarget(selectedAddress)
        return store.policies.first { RicoRecipientGuard.normalizeTarget($0.address) == target }
    }
    private var canReviewDraft: Bool {
        let hasTarget = recipientKind == 0 ? (selectedContact != nil && !selectedAddress.isEmpty) : selectedGroup != nil
        return hasTarget && !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && store.outboundAdmissionVerified
    }
    private var filteredPolicies: [RicoRecipientPolicy] {
        let needle = policySearch.trimmingCharacters(in: .whitespacesAndNewlines)
        return store.policies.filter { policy in
            let kindMatches = policyFilter == .all || (policyFilter == .people && policy.groupChatID == nil) || (policyFilter == .groups && policy.groupChatID != nil)
            let textMatches = needle.isEmpty || policy.displayName.localizedCaseInsensitiveContains(needle) || policy.address.localizedCaseInsensitiveContains(needle)
            return kindMatches && textMatches
        }
        .sorted {
            if ($0.groupChatID == nil) != ($1.groupChatID == nil) { return $0.groupChatID == nil }
            return $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
    }

    private func binding(for policy: RicoRecipientPolicy) -> Binding<RicoRecipientPolicy> {
        Binding(
            get: { store.policies.first(where: { $0.id == policy.id }) ?? policy },
            set: { value in
                if value.access == .blocked {
                    _ = emailAuthorizations.remove(for: value.address)
                }
                store.update(value)
            }
        )
    }

    private func addresses(for contact: LocalContact) -> [String] {
        contact.phones.map(ContactResolver.normalizedPhone) + contact.emails.map { $0.lowercased() }
    }

    private func stageCurrentDraft() {
        if recipientKind == 0, let contact = selectedContact, !selectedAddress.isEmpty {
            let draft = store.prepareDraft(
                name: contact.name,
                address: selectedAddress,
                message: message,
                intent: composeIntent
            )
            reviewDraft = RicoDraftReview(
                draft: draft,
                destination: contact.name,
                destinationDetail: selectedAddress,
                audience: .person
            )
        } else if let group = selectedGroup {
            let name = friendlyGroupName(group)
            let draft = store.prepareDraft(
                name: name,
                address: group.target,
                message: message,
                intent: composeIntent
            )
            let participantCount = RicoGroupMembership.normalized(group.participants).count
            reviewDraft = RicoDraftReview(
                draft: draft,
                destination: name,
                destinationDetail: "\(group.service) · \(participantCount) participant\(participantCount == 1 ? "" : "s")",
                audience: .group(participantCount: participantCount)
            )
        }
    }

    private func draftStateColor(_ state: RicoDraft.State) -> Color {
        switch state {
        case .pending: .orange
        case .approved: StudioDesign.violet
        case .sending: .blue
        case .sent: .green
        case .blocked: .red
        }
    }

    private func draftStateSymbol(_ state: RicoDraft.State) -> String {
        switch state {
        case .pending: "clock.fill"
        case .approved: "checkmark.circle.fill"
        case .sending: "paperplane.circle.fill"
        case .sent: "paperplane.fill"
        case .blocked: "hand.raised.fill"
        }
    }

    private func resolve(_ value: String) {
        selectedContact = nil; selectedAddress = ""
        switch ContactResolver.resolve(value, in: contacts.contacts) {
        case .noMatch: matches = []
        case .unique(let contact): choose(contact)
        case .ambiguous(let values): matches = values
        }
    }

    private func choose(_ contact: LocalContact) {
        selectedContact = contact; matches = []; query = contact.name
        selectedAddress = contact.phones.first.map(ContactResolver.normalizedPhone) ?? contact.emails.first?.lowercased() ?? ""
    }
}

private struct RicoDraftReviewSheet: View {
    let review: RicoDraftReview
    let onCancel: () -> Void
    let onConfirm: () -> Void
    @State private var confirmationInProgress = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Review \(review.draft.resolvedIntent.rawValue.lowercased())")
                    .font(.title2.bold())
                Text("This preview is inert. Confirming adds one reviewed item to the queue; it does not send an iMessage.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 12) {
                reviewRow(label: "Destination", value: review.destination, symbol: destinationSymbol)
                Divider()
                reviewRow(label: "Exact route", value: review.destinationDetail, symbol: "scope")
                Divider()
                reviewRow(label: "Audience", value: review.audienceSummary, symbol: "person.2.fill")
            }
            .padding(14)
            .background(.quaternary.opacity(0.22), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            VStack(alignment: .leading, spacing: 8) {
                Text("Message preview").font(.headline)
                ScrollView {
                    Text(review.draft.message)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(14)
                }
                .frame(minHeight: 100, maxHeight: 220)
                .background(.background.opacity(0.65), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(.quaternary))
            }

            if review.draft.state == .blocked {
                Label(review.draft.reason, systemImage: "hand.raised.fill")
                    .font(.callout)
                    .foregroundStyle(.red)
            } else {
                Label("After confirmation, use the separate Send button in Outbound queue when you are ready.", systemImage: "tray.and.arrow.down.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack {
                Button("Cancel") { onCancel() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(confirmationInProgress)
                Spacer()
                Button("Confirm and add to queue") {
                    guard !confirmationInProgress else { return }
                    confirmationInProgress = true
                    onConfirm()
                }
                .buttonStyle(.borderedProminent)
                .tint(StudioDesign.violet)
                .keyboardShortcut(.defaultAction)
                .disabled(confirmationInProgress || review.draft.state != .pending)
            }
        }
        .padding(26)
        .frame(width: 600)
    }

    private var destinationSymbol: String {
        switch review.audience {
        case .person: "person.fill"
        case .group: "person.3.fill"
        }
    }

    private func reviewRow(label: String, value: String, symbol: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol)
                .foregroundStyle(StudioDesign.violet)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text(value).font(.callout).textSelection(.enabled)
            }
        }
    }
}

private struct RicoPolicyRow: View {
    @Binding var policy: RicoRecipientPolicy
    let onRemove: () -> Void
    let onProfile: (() -> Void)?
    @State private var personalityDraft = ""
    @State private var personalityExpanded = false

    var body: some View {
        StudioCard(padding: 14) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 11) {
                    Image(systemName: policy.groupChatID == nil ? "person.crop.circle.fill" : "person.3.fill")
                        .font(.title2)
                        .foregroundStyle(policy.access == .blocked ? .red : policy.groupChatID == nil ? StudioDesign.accent : StudioDesign.violet)
                        .frame(width: 30)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(policy.displayName).font(.headline)
                        Text(policy.groupChatID == nil ? policy.address : "iMessage group")
                            .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        if let participants = policy.participantAddresses, policy.groupChatID != nil {
                            let named = policy.participantNames?.count ?? 0
                            Text("\(participants.count) allowed sender address\(participants.count == 1 ? "" : "es") · \(named) named from Contacts")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Menu {
                        ForEach(availableAccessLevels) { level in
                            Button {
                                policy.access = level
                                if level == .blocked { policy.autoReply = false }
                            } label: {
                                if policy.access == level { Label(accessLabel(level), systemImage: "checkmark") }
                                else { Text(accessLabel(level)) }
                            }
                        }
                    } label: {
                        StudioStatusPill(label: accessLabel(policy.access), color: accessColor, symbol: accessSymbol)
                    }
                    .menuStyle(.borderlessButton)
                    Button(role: .destructive, action: onRemove) { Image(systemName: "trash") }
                        .buttonStyle(.borderless).help("Remove this approved route")
                }
                Divider().opacity(0.55)
                if let onProfile {
                    HStack {
                        Button(action: onProfile) {
                            Label("Profile & email", systemImage: "person.text.rectangle")
                        }
                        .buttonStyle(.bordered)
                        Text("Reviewed context and person-specific email permissions")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                    }
                }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 18) {
                        Toggle("Require @rico", isOn: $policy.requireMention).toggleStyle(.switch)
                        Toggle("Auto-reply", isOn: $policy.autoReply).toggleStyle(.switch)
                        Spacer()
                        quietHoursMenu
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 18) {
                            Toggle("Require @rico", isOn: $policy.requireMention).toggleStyle(.switch)
                            Toggle("Auto-reply", isOn: $policy.autoReply).toggleStyle(.switch)
                        }
                        quietHoursMenu
                    }
                }
                .font(.callout)
                if policy.groupChatID != nil {
                    Divider().opacity(0.55)
                    DisclosureGroup(isExpanded: $personalityExpanded) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Describe Rico's tone for this group. This changes conversational style only; recipient approval, privacy, and tool access stay unchanged.")
                                .font(.caption)
                                .foregroundStyle(.secondary)

                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    ForEach(RicoGroupPersonalityPreset.allCases) { preset in
                                        Button(preset.title) {
                                            personalityDraft = preset.suggestion
                                        }
                                        .buttonStyle(.bordered)
                                        .controlSize(.small)
                                    }
                                }
                            }

                            TextEditor(text: $personalityDraft)
                                .font(.callout)
                                .frame(minHeight: 72, maxHeight: 100)
                                .padding(7)
                                .scrollContentBackground(.hidden)
                                .background(.quaternary.opacity(0.22), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(.quaternary))

                            HStack(spacing: 10) {
                                Text("\(sanitizedPersonalityLength)/\(RicoGroupPersonalityPolicy.maximumLength) saved characters")
                                    .font(.caption2)
                                    .foregroundStyle(sanitizedPersonalityLength >= RicoGroupPersonalityPolicy.maximumLength ? .orange : .secondary)
                                Spacer()
                                Button("Use default") { personalityDraft = "" }
                                    .buttonStyle(.borderless)
                                Button("Apply") { applyPersonality() }
                                    .buttonStyle(.borderedProminent)
                                    .tint(StudioDesign.violet)
                                    .disabled(!personalityHasChanges)
                            }
                        }
                        .padding(.top, 10)
                    } label: {
                        Label(
                            policy.groupPersonality == nil ? "Group personality · Rico default" : "Group personality · Custom",
                            systemImage: "theatermasks.fill"
                        )
                        .font(.callout.weight(.semibold))
                    }
                }
            }
        }
        .onAppear { personalityDraft = policy.groupPersonality ?? "" }
        .onChange(of: policy.groupPersonality) { _, value in
            personalityDraft = value ?? ""
        }
    }

    private var sanitizedPersonalityLength: Int {
        RicoGroupPersonalityPolicy.sanitize(personalityDraft).unicodeScalars.count
    }

    private var personalityHasChanges: Bool {
        personalityDraft != (policy.groupPersonality ?? "")
    }

    private func applyPersonality() {
        let value = RicoGroupPersonalityPolicy.valueForStorage(personalityDraft)
        personalityDraft = value ?? ""
        guard value != policy.groupPersonality else { return }
        policy.groupPersonality = value
    }

    private var availableAccessLevels: [RicoAccessLevel] {
        if policy.groupChatID != nil { return [.blocked, .approved] }
        var levels: [RicoAccessLevel] = [.blocked, .approved]
        if policy.access == .trusted { levels.append(.trusted) }
        if policy.access == .owner { levels.append(.owner) }
        return levels
    }

    private var quietHoursMenu: some View {
        Menu {
            Button("10 PM–8 AM") { policy.quietStart = 22; policy.quietEnd = 8 }
            Button("9 PM–7 AM") { policy.quietStart = 21; policy.quietEnd = 7 }
            Button("No quiet hours") { policy.quietStart = 0; policy.quietEnd = 0 }
        } label: {
            Label(quietHoursLabel, systemImage: "moon.zzz.fill")
                .font(.caption).foregroundStyle(.secondary)
        }
        .menuStyle(.borderlessButton)
    }

    private func accessLabel(_ access: RicoAccessLevel) -> String {
        if policy.groupChatID != nil && access == .approved { return "Approved group" }
        return access.rawValue
    }

    private var accessColor: Color {
        switch policy.access {
        case .blocked: .red
        case .approved: .green
        case .trusted: StudioDesign.violet
        case .owner: .blue
        }
    }

    private var accessSymbol: String {
        switch policy.access {
        case .blocked: "hand.raised.fill"
        case .approved: "checkmark.shield.fill"
        case .trusted: "person.badge.key.fill"
        case .owner: "crown.fill"
        }
    }

    private var quietHoursLabel: String {
        guard policy.quietStart != policy.quietEnd else { return "Quiet hours off" }
        return "Quiet \(hourLabel(policy.quietStart))–\(hourLabel(policy.quietEnd))"
    }

    private func hourLabel(_ hour: Int) -> String {
        let normalized = ((hour % 24) + 24) % 24
        if normalized == 0 { return "12 AM" }
        if normalized == 12 { return "12 PM" }
        return normalized < 12 ? "\(normalized) AM" : "\(normalized - 12) PM"
    }
}

private struct RicoGroupComposerSheet: View {
    @ObservedObject var contacts: ContactsStore
    let onComplete: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var selectedByContact: [String: String] = [:]

    private var filtered: [LocalContact] {
        let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? contacts.contacts : contacts.contacts.filter { $0.name.localizedCaseInsensitiveContains(value) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { Text("Create iMessage group").font(.title2.bold()); Spacer(); Button("Cancel") { dismiss() } }
            Text("Select at least two contacts. Messages will open with the recipients filled in; send the first message there to create the group.")
                .foregroundStyle(.secondary)
            if !contacts.canReadContacts {
                contactsPermissionRecovery
            } else {
                TextField("Search contacts", text: $query).textFieldStyle(.roundedBorder)
                List(filtered) { contact in
                    let addresses = contact.phones.map(ContactResolver.normalizedPhone) + contact.emails.map { $0.lowercased() }
                    if !addresses.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(contact.name).font(.headline)
                            ForEach(addresses, id: \.self) { address in
                                Button {
                                    if selectedByContact[contact.id] == address { selectedByContact.removeValue(forKey: contact.id) }
                                    else { selectedByContact[contact.id] = address }
                                } label: {
                                    HStack {
                                        Image(systemName: selectedByContact[contact.id] == address ? "checkmark.circle.fill" : "circle")
                                            .foregroundStyle(selectedByContact[contact.id] == address ? StudioDesign.accent : .secondary)
                                        Text(address).font(.callout.monospaced())
                                        Spacer()
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.vertical, 5)
                    }
                }
            }
            HStack {
                Text("\(selectedByContact.count) people selected").foregroundStyle(.secondary)
                Spacer()
                Button("Open group in Messages") { openMessages() }
                    .buttonStyle(.borderedProminent).disabled(selectedByContact.count < 2)
            }
        }.padding(24).frame(width: 600, height: 560).onAppear { contacts.load() }
    }

    private var contactsPermissionRecovery: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Contacts access required", systemImage: "person.crop.circle.badge.exclamationmark")
                .font(.headline)
            Button(contacts.authorization == .denied ? "Repair Contacts Access" : "Request Contacts Access") {
                contacts.authorization == .denied ? contacts.repairAccess() : contacts.requestAccess()
            }
            .buttonStyle(.borderedProminent)
            .disabled(contacts.loading)
            if contacts.loading { ProgressView("Repairing Contacts access…") }
            if let error = contacts.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if contacts.repairRequiresRelaunch {
                Button("Quit OpenClaw Studio") { NSApp.terminate(nil) }.buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }

    private func openMessages() {
        var components = URLComponents()
        components.scheme = "sms"
        components.path = "/open"
        components.queryItems = [URLQueryItem(name: "addresses", value: selectedByContact.values.sorted().joined(separator: ","))]
        guard let url = components.url else { return }
        guard NSWorkspace.shared.open(url) else { return }
        onComplete()
        dismiss()
    }
}

private struct RicoIdentityEditorSheet: View {
    @ObservedObject var contacts: ContactsStore
    @ObservedObject var store: RicoCommunicationsStore
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var matches: [LocalContact] = []
    @State private var selectedContact: LocalContact?
    @State private var selectedAddress = ""
    @State private var access: RicoAccessLevel = .approved

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Add approved identity").font(.title2.bold())
                Spacer()
                Button("Cancel") { dismiss() }
            }
            Text("Search your Contacts, then approve one exact phone number or email address.")
                .foregroundStyle(.secondary)
            TextField("Contact name", text: $query)
                .textFieldStyle(.roundedBorder)
                .onChange(of: query) { _, value in resolve(value) }

            if !contacts.canReadContacts {
                ContentUnavailableView {
                    Label("Contacts access required", systemImage: "person.crop.circle.badge.exclamationmark")
                } actions: {
                    Button(contacts.authorization == .denied ? "Repair Contacts Access" : (contacts.authorization == .restricted ? "Open Contacts Settings" : "Request Contacts Access")) {
                        if contacts.authorization == .denied {
                            contacts.repairAccess()
                        } else {
                            contacts.requestAccess()
                        }
                    }
                        .buttonStyle(.borderedProminent)
                }
                if contacts.loading { ProgressView("Repairing Contacts access…") }
                if let error = contacts.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                if contacts.repairRequiresRelaunch {
                    Button("Quit OpenClaw Studio") { NSApp.terminate(nil) }.buttonStyle(.bordered)
                }
            } else if !matches.isEmpty && selectedContact == nil {
                List(matches.prefix(12)) { contact in
                    Button {
                        choose(contact)
                    } label: {
                        VStack(alignment: .leading) {
                            Text(contact.name)
                            Text("\(contact.phones.count) phone · \(contact.emails.count) email")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }.buttonStyle(.plain)
                }.frame(minHeight: 180)
            }

            if let contact = selectedContact {
                GroupBox {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(contact.name).font(.headline)
                        Picker("Exact identity", selection: $selectedAddress) {
                            ForEach(addresses(for: contact), id: \.self) { Text($0).tag($0) }
                        }
                        Picker("Access", selection: $access) {
                            ForEach([RicoAccessLevel.blocked, .approved]) { Text($0.rawValue).tag($0) }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            Spacer()
            HStack {
                Spacer()
                Button("Approve exact identity") {
                    guard let contact = selectedContact else { return }
                    store.approve(contact: contact, address: selectedAddress, access: access)
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(selectedContact == nil || selectedAddress.isEmpty)
            }
        }
        .padding(24)
        .frame(width: 560, height: 500)
        .onAppear { contacts.load() }
    }

    private func addresses(for contact: LocalContact) -> [String] {
        contact.phones.map(ContactResolver.normalizedPhone) + contact.emails.map { $0.lowercased() }
    }

    private func resolve(_ value: String) {
        selectedContact = nil
        selectedAddress = ""
        switch ContactResolver.resolve(value, in: contacts.contacts) {
        case .noMatch: matches = []
        case .unique(let contact): choose(contact)
        case .ambiguous(let values): matches = values
        }
    }

    private func choose(_ contact: LocalContact) {
        selectedContact = contact
        matches = []
        query = contact.name
        selectedAddress = addresses(for: contact).first ?? ""
    }
}
