import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct RicoSkillsView: View {
    @StateObject private var model = RicoSkillsStore()
    @State private var pendingEnable: RicoInstalledSkill?
    @State private var pendingRollback: RicoSkillRollbackTarget?

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            header
            securityBoundary
            if let notice = model.notice { noticeBanner(notice, error: false) { model.notice = nil } }
            if let error = model.error { noticeBanner(error, error: true) { model.error = nil } }
            HStack(alignment: .top, spacing: 18) {
                libraryBrowser.frame(minWidth: 300, idealWidth: 340, maxWidth: 380)
                if let skill = model.selectedSkill {
                    skillDetail(skill).frame(maxWidth: .infinity)
                } else {
                    emptyDetail.frame(maxWidth: .infinity)
                }
            }
        }
        .task { await model.refresh() }
        .sheet(item: $model.pendingReview) { stage in
            RicoSkillReviewSheet(stage: stage, store: model)
        }
        .confirmationDialog(
            "Enable reviewed skill?",
            isPresented: Binding(get: { pendingEnable != nil }, set: { if !$0 { pendingEnable = nil } }),
            titleVisibility: .visible
        ) {
            if let skill = pendingEnable {
                Button("Enable contextual guidance") {
                    pendingEnable = nil
                    Task { await model.setEnabled(skill, enabled: true, approved: true) }
                }
            }
            Button("Cancel", role: .cancel) { pendingEnable = nil }
        } message: {
            if let skill = pendingEnable {
                Text("Enable only version \(skill.version), hash \(skill.contentHash.prefix(12))…. It grants no tools, contacts, email, messaging, credentials, owner status, or policy overrides.")
            }
        }
        .confirmationDialog(
            "Roll back this skill?",
            isPresented: Binding(get: { pendingRollback != nil }, set: { if !$0 { pendingRollback = nil } }),
            titleVisibility: .visible
        ) {
            if let target = pendingRollback {
                Button("Roll back and leave disabled") {
                    pendingRollback = nil
                    Task { await model.rollback(target.skill, version: target.version, approved: true) }
                }
                Button("Cancel", role: .cancel) { pendingRollback = nil }
            }
        } message: {
            if let target = pendingRollback {
                Text("Restore \(target.version.version), hash \(target.version.contentHash.prefix(12))…. Rollback never enables the restored version automatically.")
            }
        }
    }

    private var header: some View {
        HStack(spacing: 16) {
            ZStack {
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .fill(LinearGradient(colors: [StudioDesign.accent, StudioDesign.violet], startPoint: .topLeading, endPoint: .bottomTrailing))
                Image(systemName: "brain.head.profile.fill").font(.title2.bold()).foregroundStyle(.white)
            }
            .frame(width: 50, height: 50)
            VStack(alignment: .leading, spacing: 3) {
                Text("Rico Skills").font(.largeTitle.bold())
                Text("Import knowledge from other bots through reviewable, non-authorizing packages.")
                    .foregroundStyle(.secondary)
            }
            Spacer()
            StudioStatusPill(label: "\(model.installed.filter(\.enabled).count) enabled", color: model.installed.contains(where: { $0.enabled }) ? StudioDesign.accent : .secondary, symbol: "checkmark.shield")
            Button {
                Task { await model.refresh() }
            } label: {
                if model.busy { ProgressView().controlSize(.small) }
                else { Image(systemName: "arrow.clockwise") }
            }
            .buttonStyle(.bordered)
            .disabled(model.busy)
            Button {
                chooseImport()
            } label: {
                Label("Import skill", systemImage: "square.and.arrow.down")
            }
            .buttonStyle(.borderedProminent)
            .tint(StudioDesign.violet)
            .disabled(model.busy)
            .accessibilityIdentifier("skills.import")
        }
    }

    private var securityBoundary: some View {
        HStack(spacing: 12) {
            Image(systemName: "lock.shield.fill").foregroundStyle(StudioDesign.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text("Knowledge is not authority").font(.subheadline.weight(.semibold))
                Text("Imports are quarantined, scanned, normalized, reviewed, installed disabled, and versioned. They cannot grant tools or change Rico's contact, privacy, approval, provenance, credential, or security policy.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text("Local · private · rollback-ready")
                .font(.caption2.monospaced().weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .background(StudioDesign.accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(StudioDesign.accent.opacity(0.16)))
    }

    private var libraryBrowser: some View {
        StudioCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Library").font(.headline)
                        Text("\(model.installed.count) installed").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                if model.installed.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: "books.vertical").font(.system(size: 30)).foregroundStyle(.tertiary)
                        Text("No reviewed skills yet").font(.headline)
                        Text("Import a Markdown export, folder, or ZIP to begin in quarantine.")
                            .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 24)
                } else {
                    VStack(spacing: 7) {
                        ForEach(model.installed) { skill in
                            Button { model.selectedSkillID = skill.id } label: {
                                HStack(spacing: 11) {
                                    Image(systemName: skill.enabled ? "brain.fill" : "brain")
                                        .foregroundStyle(skill.enabled ? StudioDesign.accent : .secondary)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(skill.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                                        Text(skill.enabled ? "Enabled · contextual only" : "Disabled")
                                            .font(.caption2).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                }
                                .padding(10)
                                .background(model.selectedSkill?.id == skill.id ? StudioDesign.violet.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 10))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                if !model.staged.isEmpty {
                    Divider()
                    Text("READY FOR REVIEW").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                    ForEach(model.staged) { stage in
                        Button {
                            Task { await model.review(stage) }
                        } label: {
                            HStack {
                                Image(systemName: "shippingbox.and.arrow.backward")
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(stage.review.name).lineLimit(1)
                                    Text("Quarantined · not installed").font(.caption2).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                            }
                            .padding(.vertical, 6)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func skillDetail(_ skill: RicoInstalledSkill) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                StudioCard {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(skill.name).font(.title2.bold())
                                Text(skill.description).foregroundStyle(.secondary)
                            }
                            Spacer()
                            StudioStatusPill(label: skill.enabled ? "Enabled" : "Disabled", color: skill.enabled ? .green : .secondary, symbol: skill.enabled ? "checkmark.circle.fill" : "pause.circle")
                        }
                        Divider()
                        detailRow("Version", skill.version)
                        detailRow("Content hash", "\(skill.contentHash.prefix(20))…")
                        detailRow("Source", "\(skill.provenance.sourceName) · \(skill.provenance.sourceKind)")
                        detailRow("Audience", skill.audienceScope == "owner_private" ? "Alan · private direct conversations only" : "Unavailable")
                        detailRow("Authority", "Context only · 0 effective permissions")
                        HStack {
                            if skill.enabled {
                                Button("Disable") { Task { await model.setEnabled(skill, enabled: false, approved: false) } }
                                    .buttonStyle(.bordered)
                            } else {
                                Button("Review & enable") { pendingEnable = skill }
                                    .buttonStyle(.borderedProminent).tint(StudioDesign.accent)
                            }
                            Spacer()
                        }
                    }
                }
                HStack(alignment: .top, spacing: 16) {
                    StudioCard {
                        VStack(alignment: .leading, spacing: 9) {
                            Label("Triggers", systemImage: "bolt.badge.clock").font(.headline)
                            ForEach(skill.triggers, id: \.self) { Text("• \($0)").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    StudioCard {
                        VStack(alignment: .leading, spacing: 9) {
                            Label("Capability requests", systemImage: "hand.raised.fill").font(.headline)
                            if skill.requestedPermissions.isEmpty && skill.toolNeeds.isEmpty {
                                Text("None detected").font(.caption).foregroundStyle(.secondary)
                            } else {
                                ForEach(skill.requestedPermissions + skill.toolNeeds.map { "tool: \($0)" }, id: \.self) {
                                    Text("• \($0) — not granted").font(.caption).foregroundStyle(.orange)
                                }
                            }
                        }
                    }
                }
                StudioCard {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("Version history", systemImage: "clock.arrow.circlepath").font(.headline)
                        let versions = skill.versions ?? []
                        if versions.isEmpty {
                            Text("No prior version is available.").font(.caption).foregroundStyle(.secondary)
                        } else {
                            ForEach(versions) { version in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(version.version).font(.subheadline.weight(.semibold))
                                        Text("\(version.contentHash.prefix(16))…").font(.caption2.monospaced()).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if version.active {
                                        Text("Active").font(.caption.weight(.semibold)).foregroundStyle(StudioDesign.accent)
                                    } else {
                                        Button("Roll back") { pendingRollback = RicoSkillRollbackTarget(skill: skill, version: version) }
                                            .buttonStyle(.bordered).controlSize(.small)
                                    }
                                }
                                if version.id != versions.last?.id { Divider() }
                            }
                        }
                    }
                }
            }
        }
    }

    private var emptyDetail: some View {
        StudioCard {
            VStack(spacing: 14) {
                Image(systemName: "brain.head.profile").font(.system(size: 42)).foregroundStyle(.tertiary)
                Text("A reviewed knowledge layer for Rico").font(.title3.bold())
                Text("Imports never alter OpenClaw plugins, Gateway configuration, contact approvals, or tool grants.")
                    .foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button("Choose an import") { chooseImport() }.buttonStyle(.borderedProminent).tint(StudioDesign.violet)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 44)
        }
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary).frame(width: 100, alignment: .leading)
            Text(value).font(.caption).textSelection(.enabled)
        }
    }

    private func noticeBanner(_ text: String, error: Bool, dismiss: @escaping () -> Void) -> some View {
        HStack(spacing: 10) {
            Image(systemName: error ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundStyle(error ? .orange : StudioDesign.accent)
            Text(text).font(.subheadline)
            Spacer()
            Button(action: dismiss) { Image(systemName: "xmark") }.buttonStyle(.plain)
        }
        .padding(12)
        .background((error ? Color.orange : StudioDesign.accent).opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    }

    private func chooseImport() {
        let panel = NSOpenPanel()
        panel.title = "Import a Rico skill"
        panel.prompt = "Stage for review"
        panel.message = "Choose a Markdown/text export, a folder, or a ZIP. The selection is quarantined and scanned before review."
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.resolvesAliases = false
        panel.allowedContentTypes = [
            .plainText,
            .json,
            .zip,
            UTType(filenameExtension: "md") ?? .plainText,
            UTType(filenameExtension: "markdown") ?? .plainText,
            UTType(filenameExtension: "yaml") ?? .plainText,
            UTType(filenameExtension: "yml") ?? .plainText
        ]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await model.stage(url: url) }
    }
}

private struct RicoSkillRollbackTarget: Identifiable {
    let skill: RicoInstalledSkill
    let version: RicoSkillVersionRecord
    var id: String { "\(skill.id):\(version.versionID)" }
}

private struct RicoSkillReviewSheet: View {
    let stage: RicoStagedSkill
    @ObservedObject var store: RicoSkillsStore
    @Environment(\.dismiss) private var dismiss
    @State private var decision = RicoSkillReviewDecision()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Review imported skill").font(.title2.bold())
                    Text("\(stage.review.sourceName) → \(stage.review.name)").foregroundStyle(.secondary)
                }
                Spacer()
                StudioStatusPill(label: "Quarantined", color: .orange, symbol: "shippingbox")
            }
            HStack(alignment: .top, spacing: 14) {
                reviewSummary
                    .frame(width: 310)
                canonicalDiff
                    .frame(maxWidth: .infinity)
            }
            Divider()
            Toggle("I reviewed the canonical instructions and removed directives.", isOn: $decision.reviewedCanonicalDiff)
            Toggle("I understand this skill grants no tools, contacts, email, messaging, credentials, owner status, or policy overrides.", isOn: $decision.acceptsNonAuthorizingBoundary)
            HStack {
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Install disabled") {
                    Task {
                        await store.install(stage, decision: decision)
                        if store.pendingReview == nil { dismiss() }
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(StudioDesign.violet)
                .disabled(!decision.permitsInstall(stage) || store.busy)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(22)
        .frame(minWidth: 880, minHeight: 680)
    }

    private var reviewSummary: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                group("Changes") {
                    Text("\(stage.review.changes.sourceFileCount) source files → \(stage.review.changes.installedFileCount) canonical files")
                    Text("\(stage.review.changes.blockedDirectiveCount) privileged directives removed")
                    Text("\(stage.review.changes.removedReadmes) README files excluded")
                }
                group("Permissions") {
                    if stage.review.requestedPermissions.isEmpty { Text("No privileged requests detected") }
                    ForEach(stage.review.requestedPermissions, id: \.self) { Text("• \($0) — not granted").foregroundStyle(.orange) }
                    Text("Effective permissions: none").foregroundStyle(StudioDesign.accent)
                }
                group("Audience") {
                    Text(stage.review.audienceScope == "owner_private" ? "Alan's authenticated private direct conversation only" : "Unavailable")
                    Text("Never injected into groups or approved-contact conversations.").foregroundStyle(StudioDesign.accent)
                }
                group("Tool needs") {
                    if stage.review.toolNeeds.isEmpty { Text("None declared") }
                    ForEach(stage.review.toolNeeds, id: \.self) { Text("• \($0) — informational only") }
                }
                group("Triggers") {
                    ForEach(stage.review.triggers, id: \.self) { Text("• \($0)") }
                }
                group("Resources") {
                    if stage.review.resources.isEmpty { Text("No bundled resources") }
                    ForEach(stage.review.resources) { Text("• \($0.path) · \($0.bytes) bytes") }
                }
                if !stage.review.blockedLines.isEmpty {
                    group("Removed directives") {
                        ForEach(stage.review.blockedLines.prefix(20)) { line in
                            Text("\(line.relativePath):\(line.line) · \(line.rules.joined(separator: ", "))\n\(line.preview)")
                                .foregroundStyle(.orange)
                        }
                    }
                }
            }
            .font(.caption)
        }
    }

    private var canonicalDiff: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Canonical SKILL.md").font(.headline)
            Text("This is the exact normalized instruction surface. The full package is bound to hash \(stage.review.contentHash.prefix(16))…")
                .font(.caption).foregroundStyle(.secondary)
            ScrollView([.vertical, .horizontal]) {
                Text(stage.review.canonicalPreview)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .background(Color.black.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private func group<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title.uppercased()).font(.caption2.weight(.bold)).foregroundStyle(.secondary)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
