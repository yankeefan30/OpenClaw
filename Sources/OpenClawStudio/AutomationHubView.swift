import SwiftUI

struct AutomationHubView: View {
    @EnvironmentObject private var store: StudioStore
    @State private var showingBuilder = false
    @State private var pendingAction: AutomationHubAction?
    @State private var busyJobID: String?
    @State private var notice: String?
    @State private var error: String?

    private var activeJobs: Int { store.cronJobs.filter(\.enabled).count }
    private var nextJob: CronJobRecord? {
        store.cronJobs
            .filter { $0.enabled && $0.nextRun != nil }
            .min { ($0.nextRun ?? .distantFuture) < ($1.nextRun ?? .distantFuture) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            header
            builderHero
            if let notice {
                inlineMessage(notice, symbol: "checkmark.circle.fill", color: StudioDesign.accent)
            }
            if let error {
                inlineMessage(error, symbol: "exclamationmark.triangle.fill", color: .red)
            }
            scheduleSummary
            jobs
        }
        .sheet(isPresented: $showingBuilder) {
            NaturalLanguageAutomationBuilderView(
                agentID: "main",
                onCancel: { showingBuilder = false },
                onCreated: { result in
                    notice = result.enabled
                        ? "\(result.name) is active and verified in the Gateway."
                        : "\(result.name) was created disabled for review."
                    showingBuilder = false
                    store.refresh()
                }
            )
        }
        .confirmationDialog(
            pendingAction?.title ?? "Review automation change",
            isPresented: Binding(
                get: { pendingAction != nil },
                set: { if !$0 { pendingAction = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let action = pendingAction {
                Button(action.confirmLabel, role: action.isDestructive ? .destructive : nil) {
                    pendingAction = nil
                    Task { await execute(action) }
                }
                Button("Cancel", role: .cancel) { pendingAction = nil }
            }
        } message: {
            Text(pendingAction?.reviewMessage ?? "")
        }
    }

    private var header: some View {
        HStack(spacing: 16) {
            ZStack {
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .fill(LinearGradient(colors: [StudioDesign.violet, StudioDesign.accent], startPoint: .topLeading, endPoint: .bottomTrailing))
                Image(systemName: "calendar.badge.clock").font(.title2.bold()).foregroundStyle(.white)
            }
            .frame(width: 50, height: 50)
            VStack(alignment: .leading, spacing: 3) {
                Text("Automations").font(.largeTitle.bold())
                Text("Describe the outcome. Rico turns it into a schedule you can inspect before anything is created.")
                    .foregroundStyle(.secondary)
            }
            Spacer()
            StudioStatusPill(label: "\(activeJobs) active", color: activeJobs > 0 ? StudioDesign.accent : .secondary, symbol: "bolt.fill")
            Button { store.refresh() } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.bordered)
            Button { showingBuilder = true } label: { Label("New automation", systemImage: "plus") }
                .buttonStyle(.borderedProminent)
                .tint(StudioDesign.violet)
        }
    }

    private var builderHero: some View {
        StudioCard(padding: 24) {
            HStack(alignment: .center, spacing: 24) {
                VStack(alignment: .leading, spacing: 9) {
                    Text("Build it in plain English")
                        .font(.system(size: 27, weight: .semibold, design: .rounded))
                    Text("“Every weekday at 8, review my calendar and prepare a five-line brief.”")
                        .font(.title3).foregroundStyle(.secondary)
                    Label("Proposal → exact schedule and authority review → explicit creation", systemImage: "checkmark.shield")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Describe an automation") { showingBuilder = true }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .tint(StudioDesign.accent)
            }
        }
    }

    private var scheduleSummary: some View {
        HStack(spacing: 14) {
            summaryCard(title: "Scheduler", value: store.cronStatus, symbol: "clock.arrow.circlepath")
            summaryCard(title: "Configured", value: "\(store.cronJobs.count)", symbol: "square.stack.3d.up")
            summaryCard(
                title: "Next run",
                value: nextJob?.nextRun?.formatted(date: .abbreviated, time: .shortened) ?? "Nothing queued",
                symbol: "forward.end"
            )
        }
    }

    private func summaryCard(title: String, value: String, symbol: String) -> some View {
        StudioCard(padding: 15) {
            HStack(spacing: 11) {
                Image(systemName: symbol).foregroundStyle(StudioDesign.violet).frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title.uppercased()).font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                    Text(value).font(.subheadline.weight(.semibold)).lineLimit(1)
                }
                Spacer()
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var jobs: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack {
                Text("Scheduled work").font(.title2.bold())
                Spacer()
                Text("OpenClaw Gateway is the source of truth")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let cronError = store.adminErrors["cron"] {
                inlineMessage(cronError, symbol: "bolt.slash", color: .orange)
            } else if store.cronJobs.isEmpty {
                ContentUnavailableView {
                    Label("No automations yet", systemImage: "calendar.badge.plus")
                } description: {
                    Text("Describe the first outcome you want Rico to handle on a schedule.")
                } actions: {
                    Button("Build the first one") { showingBuilder = true }
                        .buttonStyle(.borderedProminent)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(store.cronJobs) { job in
                        jobRow(job)
                    }
                }
            }
        }
    }

    private func jobRow(_ job: CronJobRecord) -> some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill((job.enabled ? StudioDesign.accent : Color.secondary).opacity(0.12))
                if busyJobID == job.id { ProgressView().controlSize(.small) }
                else {
                    Image(systemName: job.enabled ? "bolt.fill" : "pause.fill")
                        .foregroundStyle(job.enabled ? StudioDesign.accent : .secondary)
                }
            }
            .frame(width: 42, height: 42)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(job.name).font(.headline)
                    StudioStatusPill(label: job.enabled ? "Active" : "Disabled", color: job.enabled ? StudioDesign.accent : .secondary, symbol: job.enabled ? "checkmark.circle.fill" : "pause.circle.fill")
                }
                Text("\(job.schedule) · \(job.timezone)").font(.caption).foregroundStyle(.secondary)
                Text(job.nextRun.map { "Next \($0.formatted(date: .abbreviated, time: .shortened))" } ?? "No next run scheduled")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer()
            Button("Run now") { pendingAction = .run(job) }
                .buttonStyle(.bordered).disabled(busyJobID != nil)
            Button(job.enabled ? "Disable" : "Enable") { pendingAction = .setEnabled(job, !job.enabled) }
                .buttonStyle(.bordered).disabled(busyJobID != nil)
            Menu {
                Button("Delete automation", role: .destructive) { pendingAction = .remove(job) }
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuStyle(.borderlessButton)
            .frame(width: 28)
        }
        .padding(15)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(.primary.opacity(0.06)))
    }

    private func inlineMessage(_ text: String, symbol: String, color: Color) -> some View {
        Label(text, systemImage: symbol)
            .font(.callout).foregroundStyle(color)
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func execute(_ action: AutomationHubAction) async {
        busyJobID = action.job.id
        error = nil
        notice = nil
        defer { busyJobID = nil }
        do {
            switch action {
            case .run(let job):
                try await store.runCron(job: job)
                notice = "\(job.name) finished with state: \(store.cronRunState ?? "unknown")."
            case .setEnabled(let job, let enabled):
                try await store.setCronEnabled(job: job, enabled: enabled)
                notice = "\(job.name) is now \(enabled ? "active" : "disabled")."
            case .remove(let job):
                try await store.removeCron(job: job)
                notice = "\(job.name) was removed from the Gateway scheduler."
            }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private enum AutomationHubAction: Identifiable {
    case run(CronJobRecord)
    case setEnabled(CronJobRecord, Bool)
    case remove(CronJobRecord)

    var id: String {
        switch self {
        case .run(let job): "run:\(job.id)"
        case .setEnabled(let job, let enabled): "enabled:\(enabled):\(job.id)"
        case .remove(let job): "remove:\(job.id)"
        }
    }

    var job: CronJobRecord {
        switch self {
        case .run(let value), .setEnabled(let value, _), .remove(let value): value
        }
    }

    var title: String {
        switch self {
        case .run: "Run this automation now?"
        case .setEnabled(_, let enabled): enabled ? "Enable this automation?" : "Disable this automation?"
        case .remove: "Delete this automation?"
        }
    }

    var confirmLabel: String {
        switch self {
        case .run: "Run now"
        case .setEnabled(_, let enabled): enabled ? "Enable" : "Disable"
        case .remove: "Delete automation"
        }
    }

    var isDestructive: Bool {
        if case .remove = self { return true }
        return false
    }

    var reviewMessage: String {
        switch self {
        case .run(let job):
            "OpenClaw will immediately execute ‘\(job.name)’ with its saved agent, tools, and delivery settings. This requires operator.admin."
        case .setEnabled(let job, let enabled):
            enabled
                ? "‘\(job.name)’ may run as soon as its schedule is due. This requires operator.admin."
                : "‘\(job.name)’ will remain configured but will not run until enabled again."
        case .remove(let job):
            "OpenClaw will permanently remove ‘\(job.name)’ and its saved schedule. Existing run history may remain in Gateway logs."
        }
    }
}
