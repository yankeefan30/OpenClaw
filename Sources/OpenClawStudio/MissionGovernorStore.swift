import SwiftUI

@MainActor
final class MissionGovernorStore: ObservableObject {
    @Published private(set) var status: MissionGovernorStatus = .unavailable
    @Published private(set) var missions: [MissionSummary] = []
    @Published private(set) var selectedMission: MissionDetail?
    @Published private(set) var events: [MissionEvent] = []
    @Published private(set) var nextEventCursor: String?
    @Published private(set) var isRefreshing = false
    @Published private(set) var isLoadingDetail = false
    @Published private(set) var isStale = true
    @Published private(set) var lastRefresh: Date?
    @Published var selectedMissionID: String? {
        didSet {
            guard selectedMissionID != oldValue else { return }
            detailTask?.cancel()
            selectedMission = nil
            events = []
            nextEventCursor = nil
            if let selectedMissionID {
                detailTask = Task { [weak self] in await self?.loadMission(id: selectedMissionID) }
            }
        }
    }
    @Published var errorMessage: String?
    @Published var noticeMessage: String?

    private let client: MissionGovernorClient
    private var refreshTask: Task<Void, Never>?
    private var detailTask: Task<Void, Never>?

    init(client: MissionGovernorClient = MissionGovernorClient()) {
        self.client = client
    }

    deinit {
        refreshTask?.cancel()
        detailTask?.cancel()
    }

    var selectedSummary: MissionSummary? {
        guard let selectedMissionID else { return nil }
        return missions.first { $0.id == selectedMissionID }
    }

    var activeCount: Int {
        missions.filter { $0.state == .active }.count
    }

    var openExceptionCount: Int {
        missions.reduce(0) { $0 + $1.exceptionCount }
    }

    var shadowCount: Int {
        missions.filter { $0.mode == .shadow || $0.state == .shadow }.count
    }

    func startMonitoring(every seconds: Double = 15) {
        guard refreshTask == nil else { return }
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                do { try await Task.sleep(for: .seconds(max(seconds, 5))) }
                catch { break }
            }
        }
    }

    func stopMonitoring() {
        refreshTask?.cancel()
        refreshTask = nil
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            async let statusRequest = client.status()
            async let missionRequest = client.missions()
            let (newStatus, newMissions) = try await (statusRequest, missionRequest)
            status = newStatus
            missions = newMissions.sorted { left, right in
                if left.state == .active && right.state != .active { return true }
                if right.state == .active && left.state != .active { return false }
                return (left.updatedAt ?? .distantPast) > (right.updatedAt ?? .distantPast)
            }
            isStale = false
            lastRefresh = Date()
            errorMessage = nil
            if selectedMissionID == nil || !newMissions.contains(where: { $0.id == selectedMissionID }) {
                selectedMissionID = newMissions.first?.id
            } else if let selectedMissionID {
                await loadMission(id: selectedMissionID)
            }
        } catch is CancellationError {
            return
        } catch {
            // Preserve the last successful read for operator context, but revoke the
            // enforcement badge and all activation/resume affordances immediately.
            status = .unavailable
            isStale = true
            errorMessage = MissionRedactor.redact(error.localizedDescription)
        }
    }

    func selectMission(_ id: String) {
        selectedMissionID = id
    }

    func loadMission(id: String) async {
        isLoadingDetail = true
        defer { isLoadingDetail = false }
        do {
            async let detailRequest = client.mission(id: id)
            async let eventRequest = client.events(missionID: id, limit: 200)
            let (detail, page) = try await (detailRequest, eventRequest)
            guard id == selectedMissionID else { return }
            selectedMission = detail
            events = page.events
            nextEventCursor = page.nextCursor
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            guard id == selectedMissionID else { return }
            errorMessage = MissionRedactor.redact(error.localizedDescription)
        }
    }

    func loadMoreEvents() async {
        guard let selectedMissionID, let nextEventCursor else { return }
        do {
            let page = try await client.events(missionID: selectedMissionID, limit: 200, cursor: nextEventCursor)
            let existing = Set(events.map(\.id))
            events.append(contentsOf: page.events.filter { !existing.contains($0.id) })
            self.nextEventCursor = page.nextCursor
        } catch {
            errorMessage = MissionRedactor.redact(error.localizedDescription)
        }
    }

    func evaluation(for action: MissionMutationAction, missionID: String) async -> MissionEvaluation {
        do {
            return try await client.evaluate(missionID: missionID, action: action)
        } catch {
            return MissionEvaluation([
                "eligible": false,
                "decision": "unavailable",
                "reason": MissionRedactor.redact(error.localizedDescription)
            ])
        }
    }

    /// Accept only the builder's final reviewed callback. Saving creates or updates
    /// the inactive contract; activation remains a separate typed review.
    func saveReviewed(contract: MissionContract) async {
        noticeMessage = nil
        errorMessage = nil
        do {
            _ = try await client.upsertReviewed(contract: contract)
            noticeMessage = "Saved \(MissionRedactor.redact(contract.title)) as an inactive Mission. Activation still requires a separate review."
            await refresh()
        } catch {
            errorMessage = MissionRedactor.redact(error.localizedDescription)
        }
    }

    func perform(_ review: MissionMutationReview) async {
        noticeMessage = nil
        errorMessage = nil
        do {
            let result: MissionMutationResult
            if review.action == .globalPause || review.action == .globalResume {
                result = try await client.setGlobalPause(review)
            } else {
                result = try await client.mutateMission(review)
            }
            noticeMessage = result.message
            await refresh()
        } catch {
            errorMessage = MissionRedactor.redact(error.localizedDescription)
        }
    }
}
