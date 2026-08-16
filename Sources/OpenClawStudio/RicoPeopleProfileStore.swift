import Foundation

enum RicoPeopleProfilePresentation {
    static func ownerEditorText(_ profile: RicoPersonContextProfile, at now: Date) -> String {
        profile.reviewedItems
            .filter { $0.isActive(at: now) && $0.provenance.sourceKind == .ownerAuthored }
            .map { item in
                let prefix: String
                switch item.kind {
                case .backgroundFact: prefix = "background:"
                case .customInstruction: prefix = "instruction:"
                case .communicationPreference: prefix = "preference:"
                }
                return "\(prefix) \(item.text)"
            }
            .joined(separator: "\n")
    }
}

@MainActor
final class RicoPeopleProfileStore: ObservableObject {
    @Published private(set) var archive = RicoPeopleContextArchive(profiles: [])
    @Published private(set) var status = ""
    @Published private(set) var operational = false

    init() {
        reload()
    }

    func reload() {
        do {
            if FileManager.default.fileExists(atPath: RicoPeopleContextStore.defaultDirectory
                .appendingPathComponent(RicoPeopleContextStore.archiveFilename).path) {
                archive = try RicoPeopleContextStore.loadArchive()
            } else {
                archive = RicoPeopleContextArchive(profiles: [])
                try RicoPeopleContextStore.save(archive, at: Date())
            }
            operational = true
            status = "Reviewed people context is stored privately."
        } catch {
            operational = false
            status = "People profiles are unavailable: \(error.localizedDescription)"
        }
    }

    func profile(for address: String) -> RicoPersonContextProfile? {
        guard let principal = RicoPersonPrincipal(authenticatedHandle: address) else { return nil }
        let matches = archive.profiles.filter { $0.principal == principal }
        return matches.count == 1 ? matches[0] : nil
    }

    func editorText(for address: String, at now: Date = Date()) -> String {
        guard let profile = profile(for: address) else { return "" }
        return RicoPeopleProfilePresentation.ownerEditorText(profile, at: now)
    }

    func approvedLearnedItems(for address: String, at now: Date = Date()) -> [RicoReviewedPersonContextItem] {
        profile(for: address)?.reviewedItems.filter {
            $0.isActive(at: now) && $0.provenance.sourceKind != .ownerAuthored
        } ?? []
    }

    @discardableResult
    func saveReviewedText(
        _ rawText: String,
        for address: String,
        displayName: String,
        now: Date = Date()
    ) -> Bool {
        guard operational,
              let principal = RicoPersonPrincipal(authenticatedHandle: address) else {
            status = "This profile is not attached to one exact phone number or email address."
            return false
        }
        let safeName = RicoPeopleContextSanitizer.displayName(displayName)
        guard !safeName.isEmpty else {
            status = "The profile needs a safe display name."
            return false
        }
        let drafts = RicoPeopleContextParser.parse(rawText)
        var proposed = archive
        let existingMatches = proposed.profiles.indices.filter { proposed.profiles[$0].principal == principal }
        guard existingMatches.count <= 1 else {
            status = "This exact identity has ambiguous profile records. Nothing was saved."
            return false
        }

        let reviewedItems = drafts.map { draft in
            RicoReviewedPersonContextItem(
                id: UUID(),
                kind: draft.kind,
                text: draft.text,
                provenance: RicoPersonContextProvenance(
                    sourceKind: .ownerAuthored,
                    sourceReference: "owner-edit-\(UUID().uuidString.lowercased())",
                    observedAt: now,
                    reviewedAt: now,
                    reviewedBy: "alan"
                ),
                expiresAt: nil
            )
        }

        if let index = existingMatches.first {
            // Replacing the editor text replaces only owner-authored rows.
            // Approved learning/import rows retain their original provenance.
            let retained = proposed.profiles[index].reviewedItems.filter { $0.provenance.sourceKind != .ownerAuthored }
            proposed.profiles[index].displayName = safeName
            proposed.profiles[index].reviewedItems = retained + reviewedItems
            proposed.profiles[index].updatedAt = now
        } else {
            proposed.profiles.append(RicoPersonContextProfile(
                id: UUID(),
                principal: principal,
                displayName: safeName,
                reviewedItems: reviewedItems,
                learningCandidates: [],
                createdAt: now,
                updatedAt: now
            ))
        }
        return persist(proposed, message: drafts.isEmpty
            ? "Cleared owner-authored context for \(safeName)."
            : "Saved \(drafts.count) reviewed profile instruction\(drafts.count == 1 ? "" : "s") for \(safeName).")
    }

    @discardableResult
    func addLearningCandidate(
        text: String,
        kind: RicoPersonContextKind,
        address: String,
        displayName: String,
        conversationReference: String,
        deliveryReference: String,
        observedAt: Date,
        confidence: Double,
        now: Date = Date()
    ) -> Bool {
        guard operational,
              let principal = RicoPersonPrincipal(authenticatedHandle: address),
              let candidate = RicoPeopleContextEditor.proposeLearning(
                principal: principal,
                kind: kind,
                text: text,
                conversationReference: conversationReference,
                deliveryReference: deliveryReference,
                observedAt: observedAt,
                proposedAt: now,
                confidence: confidence
              ) else { return false }
        var proposed = archive
        let matches = proposed.profiles.indices.filter { proposed.profiles[$0].principal == principal }
        guard matches.count <= 1 else { return false }
        if let index = matches.first {
            proposed.profiles[index].learningCandidates.append(candidate)
            proposed.profiles[index].updatedAt = now
        } else {
            let safeName = RicoPeopleContextSanitizer.displayName(displayName)
            guard !safeName.isEmpty else { return false }
            proposed.profiles.append(.init(
                id: UUID(), principal: principal, displayName: safeName,
                reviewedItems: [], learningCandidates: [candidate],
                createdAt: now, updatedAt: now
            ))
        }
        return persist(proposed, message: "Added a learning suggestion for review. It is not trusted context yet.")
    }

    @discardableResult
    func reviewCandidate(_ candidateID: UUID, address: String, approve: Bool, now: Date = Date()) -> Bool {
        guard operational, let principal = RicoPersonPrincipal(authenticatedHandle: address) else { return false }
        var proposed = archive
        let matches = proposed.profiles.indices.filter { proposed.profiles[$0].principal == principal }
        guard matches.count == 1, let index = matches.first else { return false }
        let result = RicoPeopleContextEditor.review(
            candidateID: candidateID,
            approve: approve,
            in: &proposed.profiles[index],
            reviewedAt: now
        )
        if approve && result == nil { return false }
        return persist(proposed, message: approve
            ? "Approved the learning suggestion as reviewed context."
            : "Rejected the learning suggestion; it will never enter Rico's prompt.")
    }

    func pendingCandidates(for address: String) -> [RicoLearningCandidate] {
        profile(for: address)?.learningCandidates.filter { $0.state == .pending } ?? []
    }

    @discardableResult
    func deleteProfile(for address: String) -> Bool {
        guard let principal = RicoPersonPrincipal(authenticatedHandle: address) else { return false }
        var proposed = archive
        let prior = proposed.profiles.count
        proposed.profiles.removeAll { $0.principal == principal }
        guard proposed.profiles.count != prior else { return false }
        return persist(proposed, message: "Deleted the reviewed people profile for this exact identity.")
    }

    @discardableResult
    private func persist(_ proposed: RicoPeopleContextArchive, message: String) -> Bool {
        do {
            try RicoPeopleContextStore.save(proposed, at: Date())
            archive = proposed
            operational = true
            status = message
            return true
        } catch {
            operational = false
            status = "People profile was not saved: \(error.localizedDescription)"
            return false
        }
    }
}
