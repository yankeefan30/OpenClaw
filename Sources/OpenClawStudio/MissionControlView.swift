import SwiftUI

@MainActor
struct MissionControlView: View {
    @StateObject private var store: MissionGovernorStore
    private let agentID: String
    private let onCreateMission: (() -> Void)?
    @State private var reviewContext: MissionActionReviewContext?
    @State private var preparingReview = false
    @State private var showingMissionBuilder = false

    init(agentID: String = "main", onCreateMission: (() -> Void)? = nil) {
        _store = StateObject(wrappedValue: MissionGovernorStore())
        self.agentID = agentID
        self.onCreateMission = onCreateMission
    }

    init(store: MissionGovernorStore, agentID: String = "main", onCreateMission: (() -> Void)? = nil) {
        _store = StateObject(wrappedValue: store)
        self.agentID = agentID
        self.onCreateMission = onCreateMission
    }

    var body: some View {
        ZStack {
            StudioBackdrop()
            VStack(spacing: 0) {
                header
                if let errorMessage = store.errorMessage {
                    alertBanner(message: errorMessage, warning: true)
                } else if let noticeMessage = store.noticeMessage {
                    alertBanner(message: noticeMessage, warning: false)
                }
                overview
                Divider().opacity(0.45)
                HSplitView {
                    missionList
                        .frame(minWidth: 280, idealWidth: 330, maxWidth: 390)
                    missionDetail
                        .frame(minWidth: 560)
                }
            }
        }
        .task { store.startMonitoring() }
        .onDisappear { store.stopMonitoring() }
        .sheet(item: $reviewContext) { context in
            MissionActionReviewSheet(context: context) { review in
                reviewContext = nil
                Task { await store.perform(review) }
            }
        }
        .sheet(isPresented: $showingMissionBuilder) {
            NaturalLanguageMissionBuilderView(
                agentID: agentID,
                onCancel: { showingMissionBuilder = false },
                onReviewed: { contract in
                    showingMissionBuilder = false
                    Task { await store.saveReviewed(contract: contract) }
                }
            )
        }
        .accessibilityIdentifier("missionControl.root")
    }

    private var header: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Mission Control")
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                Text("Durable autonomy with Gateway-enforced authority, proof, and intervention.")
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if store.status.enforcementVerified {
                StudioStatusPill(label: "Gateway enforced", color: .green, symbol: "checkmark.shield.fill")
                    .accessibilityIdentifier("missionControl.enforcement.verified")
            } else {
                StudioStatusPill(label: "Enforcement unverified", color: .red, symbol: "exclamationmark.shield.fill")
                    .accessibilityIdentifier("missionControl.enforcement.unverified")
            }
            StudioStatusPill(
                label: !store.status.globalPauseReported ? "Pause state unknown" : store.status.globalPaused ? "All paused" : "Governor ready",
                color: !store.status.globalPauseReported ? .red : store.status.globalPaused ? .orange : StudioDesign.accent,
                symbol: !store.status.globalPauseReported ? "questionmark.circle.fill" : store.status.globalPaused ? "pause.fill" : "waveform.path.ecg"
            )
            if store.status.globalPauseReported && store.status.globalPaused {
                Button("Resume all") { requestGlobalReview(.globalResume) }
                    .buttonStyle(.bordered)
                    .disabled(!store.status.enforcementVerified || preparingReview)
                    .accessibilityIdentifier("missionControl.globalResume")
            } else {
                Button("Pause all", role: .destructive) { requestGlobalReview(.globalPause) }
                    .buttonStyle(.bordered)
                    .disabled(preparingReview)
                    .accessibilityIdentifier("missionControl.globalPause")
            }
            Button("New Mission", systemImage: "plus") {
                if let onCreateMission { onCreateMission() }
                else { showingMissionBuilder = true }
            }
            .buttonStyle(.borderedProminent)
            .tint(StudioDesign.violet)
            .accessibilityIdentifier("missionControl.newMission")
            Button {
                Task { await store.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .disabled(store.isRefreshing)
            .help("Refresh Mission Governor state")
            .accessibilityIdentifier("missionControl.refresh")
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 18)
    }

    private var overview: some View {
        HStack(spacing: 12) {
            overviewMetric("Missions", value: "\(store.missions.count)", symbol: "scope", color: StudioDesign.violet)
            overviewMetric("Active", value: "\(store.activeCount)", symbol: "play.circle.fill", color: StudioDesign.accent)
            overviewMetric("Shadow", value: "\(store.shadowCount)", symbol: "eye.fill", color: .blue)
            overviewMetric("Exceptions", value: "\(store.openExceptionCount)", symbol: "exclamationmark.triangle.fill", color: store.openExceptionCount > 0 ? .orange : .secondary)
            VStack(alignment: .leading, spacing: 5) {
                Text("STATE FRESHNESS").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                HStack(spacing: 7) {
                    Circle().fill(store.isStale ? Color.red : Color.green).frame(width: 8, height: 8)
                    Text(store.lastRefresh.map { $0.formatted(date: .omitted, time: .standard) } ?? "Never")
                        .font(.headline.monospacedDigit())
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 16)
    }

    private func overviewMetric(_ label: String, value: String, symbol: String, color: Color) -> some View {
        HStack(spacing: 11) {
            Image(systemName: symbol).font(.title3).foregroundStyle(color)
            VStack(alignment: .leading, spacing: 2) {
                Text(label.uppercased()).font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                Text(value).font(.title2.weight(.semibold).monospacedDigit())
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var missionList: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("MISSIONS").font(.caption.weight(.bold)).foregroundStyle(.secondary)
                Spacer()
                if store.isRefreshing { ProgressView().controlSize(.small) }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            if store.missions.isEmpty && !store.isRefreshing {
                ContentUnavailableView(
                    "No missions yet",
                    systemImage: "scope",
                    description: Text("Create a bounded mission and validate it in Shadow before activation.")
                )
            } else {
                List(store.missions, selection: Binding(
                    get: { store.selectedMissionID },
                    set: { if let id = $0 { store.selectMission(id) } }
                )) { mission in
                    MissionListRow(mission: mission)
                        .tag(mission.id)
                        .accessibilityIdentifier("missionControl.mission.\(mission.id)")
                }
                .listStyle(.sidebar)
                .scrollContentBackground(.hidden)
            }
        }
    }

    @ViewBuilder
    private var missionDetail: some View {
        if let summary = store.selectedSummary {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    missionHeader(summary)
                    if !store.status.enforcementVerified && (summary.state == .draft || summary.state == .shadow || summary.state == .paused) {
                        lockedEnforcementCard
                    }
                    budgetCard(summary)
                    if let detail = store.selectedMission {
                        evidenceAndExceptions(detail)
                        guardrailsCard(detail)
                    } else if store.isLoadingDetail {
                        StudioCard { HStack { ProgressView(); Text("Loading mission contract…").foregroundStyle(.secondary) } }
                    }
                    timelineCard
                }
                .padding(20)
            }
        } else {
            ContentUnavailableView(
                "Select a mission",
                systemImage: "scope",
                description: Text("Review its operating contract, budget, evidence, exceptions, and timeline.")
            )
        }
    }

    private func missionHeader(_ mission: MissionSummary) -> some View {
        StudioCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 7) {
                        HStack(spacing: 8) {
                            StudioStatusPill(label: mission.state.label, color: stateColor(mission.state), symbol: stateSymbol(mission.state))
                            StudioStatusPill(
                                label: mission.mode.label,
                                color: mission.mode == .shadow ? .blue : StudioDesign.violet,
                                symbol: mission.mode == .shadow ? "eye.fill" : "slider.horizontal.3"
                            )
                        }
                        Text(mission.title).font(.title2.bold())
                        Text(mission.outcome).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    Spacer()
                    actionButtons(mission)
                }
                Divider()
                HStack(spacing: 22) {
                    Label(store.selectedMission?.triggerSummary ?? "Event-driven", systemImage: "clock.arrow.circlepath")
                    if let nextRunAt = mission.nextRunAt {
                        Label("Next \(nextRunAt.formatted(date: .abbreviated, time: .shortened))", systemImage: "calendar")
                    }
                    if let revision = mission.revision {
                        Label("Revision \(revision)", systemImage: "point.3.connected.trianglepath.dotted")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
    }

    private func actionButtons(_ mission: MissionSummary) -> some View {
        HStack(spacing: 8) {
            if mission.state == .active {
                Button("Pause", role: .destructive) { requestMissionReview(.pause, mission: mission) }
                    .buttonStyle(.bordered)
                    .disabled(preparingReview)
                    .accessibilityIdentifier("missionControl.pause")
            } else if mission.state == .paused {
                Button("Resume") { requestMissionReview(.resume, mission: mission) }
                    .buttonStyle(.borderedProminent)
                    .disabled(!store.status.enforcementVerified || mission.mode == .unknown || preparingReview)
                    .accessibilityIdentifier("missionControl.resume")
            } else if mission.state == .draft || mission.state == .shadow {
                Button("Activate") { requestMissionReview(.activate, mission: mission) }
                    .buttonStyle(.borderedProminent)
                    .disabled(!store.status.enforcementVerified || mission.mode == .unknown || preparingReview)
                    .accessibilityIdentifier("missionControl.activate")
            }
        }
    }

    private var lockedEnforcementCard: some View {
        StudioCard {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "lock.shield.fill").font(.title2).foregroundStyle(.red)
                VStack(alignment: .leading, spacing: 5) {
                    Text("Activation locked").font(.headline)
                    Text("Studio cannot verify a healthy Gateway enforcement contract. Pausing remains available; activation and resume fail closed.")
                        .foregroundStyle(.secondary)
                    ForEach(store.status.safetyFailures, id: \.self) { reason in
                        Label(reason, systemImage: "xmark.circle").font(.caption).foregroundStyle(.red)
                    }
                }
            }
        }
    }

    private func budgetCard(_ mission: MissionSummary) -> some View {
        StudioCard {
            VStack(alignment: .leading, spacing: 13) {
                sectionTitle("Budgets", subtitle: "Gateway ceilings stop execution; Studio never estimates permission from spend.", symbol: "gauge.with.dots.needle.67percent")
                if mission.budgets.isEmpty {
                    Label("No budget snapshot was returned. Activation remains governed by the Gateway contract.", systemImage: "minus.circle")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(mission.budgets) { metric in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(metric.label).font(.callout.weight(.semibold))
                                Spacer()
                                Text(metric.displayValue).font(.caption.monospacedDigit()).foregroundStyle(metric.exceeded ? .red : .secondary)
                            }
                            if let fraction = metric.fraction {
                                ProgressView(value: fraction)
                                    .tint(metric.exceeded ? .red : fraction > 0.8 ? .orange : StudioDesign.accent)
                            }
                        }
                    }
                }
            }
        }
    }

    private func evidenceAndExceptions(_ detail: MissionDetail) -> some View {
        HStack(alignment: .top, spacing: 16) {
            StudioCard {
                VStack(alignment: .leading, spacing: 12) {
                    sectionTitle("Evidence", subtitle: "Recorded completion proof is required before completion.", symbol: "checkmark.seal")
                    if detail.evidence.isEmpty {
                        Text("No evidence recorded.").foregroundStyle(.secondary)
                    } else {
                        ForEach(detail.evidence) { evidence in
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: evidence.verified ? "checkmark.seal.fill" : "circle.dashed")
                                    .foregroundStyle(evidence.verified ? .green : .orange)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(evidence.title).font(.callout.weight(.semibold))
                                    Text("\(evidence.kind) · \(evidence.status)").font(.caption).foregroundStyle(.secondary)
                                    if let source = evidence.source { Text(source).font(.caption2).foregroundStyle(.tertiary).lineLimit(1) }
                                }
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .top)

            StudioCard {
                VStack(alignment: .leading, spacing: 12) {
                    sectionTitle("Exception inbox", subtitle: "Only unresolved deviations need your attention.", symbol: "tray.full")
                    let open = detail.exceptions.filter { !$0.resolved }
                    if open.isEmpty {
                        Label("No open exceptions", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    } else {
                        ForEach(open) { exception in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Image(systemName: exception.requiresApproval ? "person.badge.clock.fill" : "exclamationmark.triangle.fill")
                                        .foregroundStyle(exception.requiresApproval ? .orange : .red)
                                    Text(exception.title).font(.callout.weight(.semibold))
                                }
                                Text(exception.detail).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .top)
        }
    }

    private func guardrailsCard(_ detail: MissionDetail) -> some View {
        StudioCard {
            VStack(alignment: .leading, spacing: 12) {
                sectionTitle("Operating contract", subtitle: "The durable boundaries evaluated before every phase.", symbol: "list.clipboard.fill")
                HStack(alignment: .top, spacing: 28) {
                    contractColumn("Success", values: detail.successCriteria, symbol: "flag.checkered", color: .green)
                    contractColumn("Allowed", values: detail.allowedActions, symbol: "checkmark.circle", color: StudioDesign.accent)
                    contractColumn("Prohibited", values: detail.prohibitedActions, symbol: "nosign", color: .red)
                }
            }
        }
    }

    private func contractColumn(_ title: String, values: [String], symbol: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(title, systemImage: symbol).font(.caption.weight(.bold)).foregroundStyle(color)
            if values.isEmpty {
                Text("Not returned").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(values, id: \.self) { Text("• \($0)").font(.caption).fixedSize(horizontal: false, vertical: true) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var timelineCard: some View {
        StudioCard {
            VStack(alignment: .leading, spacing: 12) {
                sectionTitle("Mission timeline", subtitle: "Gateway ledger events, newest first.", symbol: "point.3.filled.connected.trianglepath.dotted")
                if store.events.isEmpty && !store.isLoadingDetail {
                    Text("No mission events yet.").foregroundStyle(.secondary)
                } else {
                    ForEach(store.events) { event in
                        MissionTimelineRow(event: event)
                    }
                    if store.nextEventCursor != nil {
                        Button("Load earlier events") { Task { await store.loadMoreEvents() } }
                            .buttonStyle(.borderless)
                    }
                }
            }
        }
    }

    private func sectionTitle(_ title: String, subtitle: String, symbol: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).foregroundStyle(StudioDesign.violet).frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func alertBanner(message: String, warning: Bool) -> some View {
        HStack(spacing: 9) {
            Image(systemName: warning ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
            Text(message).font(.callout).lineLimit(3)
            Spacer()
        }
        .foregroundStyle(warning ? Color.red : Color.green)
        .padding(.horizontal, 24)
        .padding(.vertical, 10)
        .background((warning ? Color.red : Color.green).opacity(0.08))
    }

    private func requestMissionReview(_ action: MissionMutationAction, mission: MissionSummary) {
        guard !preparingReview else { return }
        preparingReview = true
        Task {
            let evaluation = await store.evaluation(for: action, missionID: mission.id)
            reviewContext = MissionActionReviewContext(action: action, mission: mission, evaluation: evaluation)
            preparingReview = false
        }
    }

    private func requestGlobalReview(_ action: MissionMutationAction) {
        guard !preparingReview else { return }
        reviewContext = MissionActionReviewContext(action: action, mission: nil, evaluation: nil)
    }

    private func stateColor(_ state: MissionLifecycleState) -> Color {
        switch state {
        case .active: StudioDesign.accent
        case .shadow: .blue
        case .paused, .blocked: .orange
        case .completed: .green
        case .failed: .red
        case .draft, .unknown: .secondary
        }
    }

    private func stateSymbol(_ state: MissionLifecycleState) -> String {
        switch state {
        case .active: "play.fill"
        case .shadow: "eye.fill"
        case .paused: "pause.fill"
        case .completed: "checkmark"
        case .failed: "xmark"
        case .blocked: "hand.raised.fill"
        case .draft: "pencil"
        case .unknown: "questionmark"
        }
    }
}

private struct MissionListRow: View {
    let mission: MissionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(mission.title).font(.callout.weight(.semibold)).lineLimit(1)
                Spacer()
                Circle().fill(color).frame(width: 8, height: 8)
            }
            Text(mission.outcome).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            HStack(spacing: 8) {
                Text(mission.mode.label).foregroundStyle(mission.mode == .shadow ? .blue : .secondary)
                if mission.exceptionCount > 0 {
                    Label("\(mission.exceptionCount)", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                }
                Spacer()
                if let updatedAt = mission.updatedAt { Text(updatedAt, style: .relative) }
            }
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 6)
    }

    private var color: Color {
        switch mission.state {
        case .active: StudioDesign.accent
        case .shadow: .blue
        case .paused, .blocked: .orange
        case .failed: .red
        case .completed: .green
        case .draft, .unknown: .secondary
        }
    }
}

private struct MissionTimelineRow: View {
    let event: MissionEvent

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 0) {
                Circle().fill(event.isException ? Color.red : StudioDesign.accent).frame(width: 9, height: 9)
                Rectangle().fill(.secondary.opacity(0.18)).frame(width: 1, height: 38)
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(event.title).font(.callout.weight(.semibold))
                    Text(event.status.uppercased()).font(.caption2.weight(.bold)).foregroundStyle(event.isException ? .red : .secondary)
                    Spacer()
                    if let occurredAt = event.occurredAt {
                        Text(occurredAt.formatted(date: .abbreviated, time: .shortened)).font(.caption2).foregroundStyle(.tertiary)
                    }
                }
                if let detail = event.detail { Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
                if event.evidenceCount > 0 {
                    Label("\(event.evidenceCount) evidence", systemImage: "checkmark.seal").font(.caption2).foregroundStyle(.green)
                }
            }
        }
    }
}

private struct MissionActionReviewContext: Identifiable {
    let id = UUID()
    let action: MissionMutationAction
    let mission: MissionSummary?
    let evaluation: MissionEvaluation?

    var title: String { mission?.title ?? "Mission Governor" }
    var expectedRevision: Int? { mission?.revision }
}

private struct MissionActionReviewSheet: View {
    let context: MissionActionReviewContext
    let commit: (MissionMutationReview) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var confirmation = ""
    @State private var acknowledgedScope = false
    @State private var acknowledgedBudget = false
    @State private var acknowledgedExternalEffects = false
    @State private var reason = ""
    private let idempotencyKey = UUID().uuidString

    private var draftReview: MissionMutationReview {
        MissionMutationReview(
            action: context.action,
            missionID: context.mission?.id,
            missionTitle: context.title,
            expectedRevision: context.expectedRevision,
            confirmation: confirmation,
            acknowledgedScope: acknowledgedScope,
            acknowledgedBudget: acknowledgedBudget,
            acknowledgedExternalEffects: acknowledgedExternalEffects,
            reason: reason.isEmpty ? nil : reason,
            idempotencyKey: idempotencyKey
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                Image(systemName: context.action == .pause || context.action == .globalPause ? "pause.circle.fill" : "checkmark.shield.fill")
                    .font(.system(size: 34))
                    .foregroundStyle(context.action == .pause || context.action == .globalPause ? .orange : StudioDesign.violet)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Review: \(context.action.verb)").font(.title2.bold())
                    Text(context.title).foregroundStyle(.secondary)
                }
            }

            if let evaluation = context.evaluation {
                StudioCard {
                    VStack(alignment: .leading, spacing: 7) {
                        HStack {
                            StudioStatusPill(
                                label: evaluation.decision,
                                color: evaluation.eligible ? .green : .orange,
                                symbol: evaluation.eligible ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
                            )
                            if let policyVersion = evaluation.policyVersion {
                                Text("Policy \(policyVersion)").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Text(evaluation.reason).font(.callout)
                        ForEach(evaluation.requiredApprovals, id: \.self) { approval in
                            Label(approval, systemImage: "person.badge.clock").font(.caption).foregroundStyle(.orange)
                        }
                    }
                }
            }

            VStack(alignment: .leading, spacing: 11) {
                Toggle("I reviewed the mission scope and prohibited actions.", isOn: $acknowledgedScope)
                Toggle("I reviewed daily runs, tool calls, writes, outbound actions, and per-run runtime ceilings.", isOn: $acknowledgedBudget)
                Toggle("I understand any external effect still requires its configured approval gate.", isOn: $acknowledgedExternalEffects)
            }

            if context.action == .globalPause || context.action == .globalResume {
                TextField("Reason (recorded in the Gateway ledger)", text: $reason)
                    .textFieldStyle(.roundedBorder)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Type \(draftReview.requiredConfirmation) to confirm")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                TextField(draftReview.requiredConfirmation, text: $confirmation)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("missionControl.review.confirmation")
            }

            Text("This request carries a one-time idempotency key. Repeating it cannot duplicate the reviewed transition.")
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack {
                Button("Cancel") { dismiss() }
                Spacer()
                Button(context.action.verb) { commit(draftReview) }
                    .buttonStyle(.borderedProminent)
                    .tint(context.action == .pause || context.action == .globalPause ? .orange : StudioDesign.violet)
                    .disabled(!draftReview.isComplete || (context.evaluation?.eligible == false && context.action != .pause))
                    .accessibilityIdentifier("missionControl.review.commit")
            }
        }
        .padding(24)
        .frame(width: 600)
    }
}
