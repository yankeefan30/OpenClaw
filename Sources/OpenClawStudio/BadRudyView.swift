import AppKit
import SwiftUI

struct BadRudyView: View {
    @ObservedObject var store: BadRudyStore
    let allowlistedRecipients: [BadRudyRecipient]

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            header
            statusStrip
            promptCard
            deliveryCard
            advancedCard
            runArea
            recentCaptures
        }
        .task {
            store.updateAllowlistedRecipients(allowlistedRecipients)
            await store.refresh()
        }
        .onChange(of: allowlistedRecipients) { _, recipients in
            store.updateAllowlistedRecipients(recipients)
        }
        .sheet(item: confirmationBinding) { preview in
            BadRudyConfirmationView(store: store, preview: preview)
        }
    }

    private var confirmationBinding: Binding<BadRudyDeliveryPreview?> {
        Binding(
            get: { store.pendingConfirmation },
            set: { if $0 == nil { store.dismissConfirmation() } }
        )
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 5) {
                Text("Bad Rudy")
                    .font(.largeTitle.bold())
                Text("Capture a local Grok Companions clip, then review its delivery separately.")
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "film.stack")
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(StudioDesign.coral)
                .accessibilityHidden(true)
        }
    }

    private var statusStrip: some View {
        StudioCard {
            VStack(alignment: .leading, spacing: 12) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 9) { statusPills }
                    VStack(alignment: .leading, spacing: 8) { statusPills }
                }

                if !store.governance.worker.companionsWebAvailable {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Companions web: unavailable")
                                .font(.callout.weight(.semibold))
                            Text("grok_companions_web_unavailable · Capture stays disabled until an exact Companions + Bad Rudy label probe succeeds.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "exclamationmark.shield.fill")
                            .foregroundStyle(.orange)
                    }
                } else if !store.governance.worker.detail.isEmpty {
                    Text(store.governance.worker.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private var statusPills: some View {
        StudioStatusPill(
            label: "Keychain: \(store.governance.credential.label)",
            color: store.governance.credential.isAvailable ? .green : .orange,
            symbol: store.governance.credential.isAvailable ? "key.fill" : "key.slash"
        )
        StudioStatusPill(
            label: "Playwright: \(store.governance.worker.isReady ? "Ready" : "Down")",
            color: store.governance.worker.isReady ? .green : .orange,
            symbol: store.governance.worker.isReady ? "checkmark.circle.fill" : "xmark.circle.fill"
        )
        StudioStatusPill(
            label: "Dry-run: \(store.governance.dryRun ? "On" : "Off")",
            color: store.governance.dryRun ? .green : .secondary,
            symbol: store.governance.dryRun ? "shield.fill" : "shield"
        )
        StudioStatusPill(
            label: "Kill switch: \(store.governance.killSwitchOn ? "On" : "Off")",
            color: store.governance.killSwitchOn ? .orange : .green,
            symbol: store.governance.killSwitchOn ? "stop.circle.fill" : "play.circle.fill"
        )
        StudioStatusPill(
            label: "Allowlist: \(store.governance.allowlistCount > 0 ? "Ready" : "Empty")",
            color: store.governance.allowlistCount > 0 ? .green : .orange,
            symbol: store.governance.allowlistCount > 0 ? "person.crop.circle.badge.checkmark" : "person.crop.circle.badge.exclamationmark"
        )
        StudioStatusPill(
            label: "Rate limit: \(store.governance.rateLimitApproved ? "Ready" : "Held")",
            color: store.governance.rateLimitApproved ? .green : .orange,
            symbol: store.governance.rateLimitApproved ? "gauge.with.dots.needle.67percent" : "gauge.with.dots.needle.0percent"
        )
    }

    private var promptCard: some View {
        StudioCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("What should Bad Rudy say or do?")
                        .font(.headline)
                    Spacer()
                    Text("\(store.promptCount) / \(BadRudyStore.softPromptLimit)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(store.isOverSoftPromptLimit ? .orange : .secondary)
                }
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $store.prompt)
                        .font(.body)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 118)
                        .padding(8)
                        .background(Color(nsColor: .textBackgroundColor).opacity(0.58), in: RoundedRectangle(cornerRadius: 11))
                        .overlay(RoundedRectangle(cornerRadius: 11).stroke(.quaternary))
                        .accessibilityIdentifier("badRudy.prompt")
                    if store.prompt.isEmpty {
                        Text("Write a short performance prompt…")
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 16)
                            .allowsHitTesting(false)
                    }
                }
                HStack {
                    Text("Soft cap 500 · hard cap 2,000 characters")
                    Spacer()
                    if store.isOverSoftPromptLimit {
                        Text("Consider shortening this prompt.")
                            .foregroundStyle(.orange)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
    }

    private var deliveryCard: some View {
        StudioCard {
            VStack(alignment: .leading, spacing: 14) {
                Text("Delivery")
                    .font(.headline)
                Picker("Delivery path", selection: $store.delivery) {
                    ForEach(BadRudyDelivery.allCases) { delivery in
                        Text(delivery.label).tag(delivery)
                    }
                }
                .pickerStyle(.radioGroup)
                .accessibilityIdentifier("badRudy.delivery")

                if store.delivery != .workflow {
                    Divider()
                    Picker("Approved recipient", selection: recipientBinding) {
                        Text("Choose from Rico’s allowlist").tag("")
                        ForEach(store.recipients) { recipient in
                            Text("\(recipient.displayName) · \(recipient.handle)").tag(recipient.id)
                        }
                    }
                    .accessibilityIdentifier("badRudy.recipient")
                    if store.recipients.isEmpty {
                        Label("No approved Rico recipients are available. Free-text addresses are never accepted here.", systemImage: "person.crop.circle.badge.exclamationmark")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }

                if store.delivery == .scheduler {
                    Divider()
                    DatePicker(
                        "Send time",
                        selection: $store.scheduledAt,
                        in: store.scheduleRange,
                        displayedComponents: [.date, .hourAndMinute]
                    )
                    .environment(\.timeZone, BadRudySchedulePolicy.timezone)
                    .accessibilityIdentifier("badRudy.schedule")
                    Text("America/New_York · at least 2 minutes from now · no more than 30 days")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var recipientBinding: Binding<String> {
        Binding(
            get: { store.selectedRecipientID ?? "" },
            set: { store.selectedRecipientID = $0.isEmpty ? nil : $0 }
        )
    }

    private var advancedCard: some View {
        StudioCard {
            DisclosureGroup(isExpanded: $store.advancedExpanded) {
                VStack(alignment: .leading, spacing: 14) {
                    Picker("Capture format", selection: $store.captureFormat) {
                        ForEach(BadRudyCaptureFormat.allCases) { format in
                            Text(format.rawValue.uppercased()).tag(format)
                        }
                    }
                    Stepper("Maximum duration: \(store.maximumDurationSeconds) seconds", value: $store.maximumDurationSeconds, in: 1...20)
                    Toggle("Export a .jpg still frame", isOn: $store.exportStillFrame)
                    Stepper("Retries: \(store.retries)", value: $store.retries, in: 0...2)
                    Text("The confirmation screen always requires a generated thumbnail before any external delivery.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 14)
            } label: {
                Label("Advanced", systemImage: "slider.horizontal.3")
                    .font(.headline)
            }
        }
    }

    private var runArea: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Button {
                    Task { await store.capture() }
                } label: {
                    Label(store.isCapturing ? "Capturing…" : store.runLabel, systemImage: "record.circle")
                        .frame(minWidth: 160)
                }
                .buttonStyle(.borderedProminent)
                .tint(StudioDesign.coral)
                .disabled(!store.mayRun)
                .accessibilityIdentifier("badRudy.run")
                if store.isCapturing { ProgressView().controlSize(.small) }
            }

            if let validation = store.validationMessage {
                Label(validation, systemImage: "lock.shield")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let notice = store.notice {
                Text(notice)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var recentCaptures: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Recent captures")
                    .font(.title2.bold())
                Spacer()
                Text("Last 20 · local JSONL")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if store.recentCaptures.isEmpty {
                StudioCard {
                    ContentUnavailableView(
                        "No local captures",
                        systemImage: "film",
                        description: Text("Completed captures appear here without exposing credentials or browser data.")
                    )
                    .frame(maxWidth: .infinity)
                }
            } else {
                ForEach(store.recentCaptures) { capture in
                    BadRudyCaptureRow(capture: capture)
                }
            }
        }
    }
}

private struct BadRudyCaptureRow: View {
    let capture: BadRudyRecentCapture

    var body: some View {
        StudioCard(padding: 14) {
            HStack(spacing: 14) {
                captureThumbnail
                VStack(alignment: .leading, spacing: 5) {
                    Text(capture.clip.prompt)
                        .lineLimit(2)
                        .font(.headline)
                    Text(capture.clip.createdAt.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(capture.clip.path)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
                Spacer()
                StudioStatusPill(label: capture.deliveryStatus, color: statusColor, symbol: "circle.fill")
                Button("Play") { openClip() }
                    .buttonStyle(.bordered)
                Button("Reveal in Finder") { revealClip() }
                    .buttonStyle(.bordered)
            }
        }
    }

    @ViewBuilder
    private var captureThumbnail: some View {
        if let path = capture.clip.thumbnailPath, let image = NSImage(contentsOfFile: path) {
            Image(nsImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 92, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 8))
        } else {
            RoundedRectangle(cornerRadius: 8)
                .fill(.quaternary)
                .frame(width: 92, height: 56)
                .overlay(Image(systemName: "film").foregroundStyle(.secondary))
        }
    }

    private var statusColor: Color {
        switch capture.deliveryStatus.lowercased() {
        case "sent": .green
        case "failed": .red
        case "would_send", "queued_pending_confirmation": .orange
        default: StudioDesign.violet
        }
    }

    private func openClip() {
        let url = URL(fileURLWithPath: capture.clip.path).standardizedFileURL
        guard BadRudyPaths.isDescendant(url, of: BadRudyPaths.artifactsRoot) else { return }
        NSWorkspace.shared.open(url)
    }

    private func revealClip() {
        let url = URL(fileURLWithPath: capture.clip.path).standardizedFileURL
        guard BadRudyPaths.isDescendant(url, of: BadRudyPaths.artifactsRoot) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
}

private struct BadRudyConfirmationView: View {
    @ObservedObject var store: BadRudyStore
    let preview: BadRudyDeliveryPreview

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Confirm send")
                    .font(.title.bold())
                Text("Capture is complete. Delivery remains held until this review is confirmed.")
                    .foregroundStyle(.secondary)
            }

            thumbnail

            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 10) {
                detail("Recipient", preview.recipientLabel)
                detail("Channel", preview.channel)
                detail("Filename", preview.filename)
                detail("Size", ByteCountFormatter.string(fromByteCount: preview.byteSize, countStyle: .file))
                detail("Duration", String(format: "%.1f seconds", Double(preview.request.clip.durationMS) / 1_000))
                if let scheduledAt = preview.request.scheduledAt {
                    detail("Scheduled", scheduledAt.formatted(date: .abbreviated, time: .shortened) + " ET")
                }
            }

            Text(preview.request.clip.path)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .truncationMode(.middle)
                .textSelection(.enabled)

            if preview.request.dryRun {
                Label("Dry-run is on. Confirm send records would_send only; it cannot dispatch a message or schedule.", systemImage: "shield.fill")
                    .font(.callout)
                    .foregroundStyle(.orange)
            } else if preview.request.delivery == .scheduler {
                Label("This queues a held item. A second Confirm send is required when the scheduled time arrives.", systemImage: "calendar.badge.exclamationmark")
                    .font(.callout)
                    .foregroundStyle(.orange)
            }

            HStack {
                Button("Cancel") { store.dismissConfirmation() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button {
                    Task { await store.confirmPendingDelivery() }
                } label: {
                    if store.isConfirming {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Confirm send")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.isConfirming)
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("badRudy.confirmSend")
            }
        }
        .padding(26)
        .frame(width: 620)
        .interactiveDismissDisabled(store.isConfirming)
    }

    @ViewBuilder
    private var thumbnail: some View {
        if let path = preview.request.clip.thumbnailPath,
           let image = NSImage(contentsOfFile: path) {
            Image(nsImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: 230)
                .background(.black.opacity(0.25), in: RoundedRectangle(cornerRadius: 12))
                .clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }

    private func detail(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(value).fontWeight(.medium).textSelection(.enabled)
        }
    }
}
