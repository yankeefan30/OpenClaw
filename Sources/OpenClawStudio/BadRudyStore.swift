import Foundation
import SwiftUI

@MainActor
final class BadRudyStore: ObservableObject {
    @Published private(set) var governance = BadRudyGovernanceStatus()
    @Published private(set) var recipients: [BadRudyRecipient] = []
    @Published private(set) var recentCaptures: [BadRudyRecentCapture] = []
    @Published private(set) var pendingConfirmation: BadRudyDeliveryPreview?
    @Published private(set) var isCapturing = false
    @Published private(set) var isConfirming = false
    @Published private(set) var notice: String?

    @Published var prompt = "" {
        didSet {
            if prompt.count > Self.hardPromptLimit {
                prompt = String(prompt.prefix(Self.hardPromptLimit))
            }
        }
    }
    @Published var delivery: BadRudyDelivery = .workflow
    @Published var selectedRecipientID: String?
    @Published var scheduledAt: Date
    @Published var advancedExpanded = false
    @Published var captureFormat: BadRudyCaptureFormat = .mp4
    @Published var maximumDurationSeconds = 20
    @Published var exportStillFrame = true
    @Published var retries = 1

    static let softPromptLimit = 500
    static let hardPromptLimit = 2_000

    private let credentialReader: any BadRudyCredentialReading
    private let captureClient: any BadRudyCaptureClient
    private let deliveryClient: any BadRudyDeliveryClient
    private let promptFilter: any BadRudyPromptFiltering
    private let logLoader: any BadRudyCaptureLogLoading
    private let fileManager: FileManager
    private let artifactsRoot: URL
    private let now: @Sendable () -> Date

    init(
        credentialReader: any BadRudyCredentialReading = BadRudyKeychainCredentialReader(),
        captureClient: any BadRudyCaptureClient = BadRudyUnavailableClient(),
        deliveryClient: any BadRudyDeliveryClient = BadRudyUnavailableClient(),
        promptFilter: any BadRudyPromptFiltering = BadRudyOpenClawPromptFilter(),
        logLoader: any BadRudyCaptureLogLoading = BadRudyJSONLCaptureLog(),
        fileManager: FileManager = .default,
        artifactsRoot: URL = BadRudyPaths.artifactsRoot,
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.credentialReader = credentialReader
        self.captureClient = captureClient
        self.deliveryClient = deliveryClient
        self.promptFilter = promptFilter
        self.logLoader = logLoader
        self.fileManager = fileManager
        self.artifactsRoot = artifactsRoot.standardizedFileURL
        self.now = now
        self.scheduledAt = now().addingTimeInterval(5 * 60)
    }

    var selectedRecipient: BadRudyRecipient? {
        recipients.first { $0.id == selectedRecipientID }
    }

    var promptCount: Int { prompt.count }
    var isOverSoftPromptLimit: Bool { promptCount > Self.softPromptLimit }
    var scheduleRange: ClosedRange<Date> { BadRudySchedulePolicy.range(now: now()) }
    var runLabel: String { governance.dryRun ? "Capture (dry-run)" : "Capture & queue send" }

    var validationMessage: String? {
        do {
            _ = try request()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    var mayRun: Bool { validationMessage == nil && !isCapturing && !isConfirming }

    func applyGovernance(
        killSwitchOn: Bool,
        dryRun: Bool,
        rateLimitApproved: Bool,
        allowlistedRecipients: [BadRudyRecipient]
    ) {
        governance.killSwitchOn = killSwitchOn
        governance.dryRun = dryRun
        governance.rateLimitApproved = rateLimitApproved
        updateAllowlistedRecipients(allowlistedRecipients)
    }

    func updateAllowlistedRecipients(_ allowlistedRecipients: [BadRudyRecipient]) {
        recipients = Self.canonicalRecipients(allowlistedRecipients)
        governance.allowlistCount = recipients.count
        if !recipients.contains(where: { $0.id == selectedRecipientID }) {
            selectedRecipientID = nil
        }
    }

    func refresh() async {
        let reader = credentialReader
        governance.credential = await Task.detached(priority: .utility) {
            reader.credentialState()
        }.value
        governance.worker = await captureClient.health()
        recentCaptures = logLoader.loadRecent(limit: 20)
    }

    func capture() async {
        guard !isCapturing else { return }
        let submission: BadRudySubmission
        do {
            submission = try request()
        } catch {
            notice = error.localizedDescription
            return
        }

        isCapturing = true
        notice = "Capturing locally…"
        defer { isCapturing = false }
        do {
            let clip = try await captureClient.capture(submission.capture).validated(artifactsRoot: artifactsRoot)
            let request = BadRudyDeliveryRequest(
                clip: clip,
                delivery: submission.delivery,
                recipient: submission.recipient,
                scheduledAt: submission.scheduledAt,
                dryRun: submission.capture.dryRun,
                deduplicationKey: submission.deduplicationKey
            )
            recentCaptures.insert(BadRudyRecentCapture(clip: clip, deliveryStatus: "captured"), at: 0)
            recentCaptures = Array(recentCaptures.prefix(20))

            if submission.delivery == .workflow {
                pendingConfirmation = nil
                notice = "Clip captured locally. Workflow delivery is log only."
            } else {
                pendingConfirmation = try deliveryPreview(for: request)
                notice = submission.capture.dryRun
                    ? "Clip captured. Review the would-send record; dry-run cannot dispatch."
                    : "Clip captured. Nothing will leave this Mac until you confirm."
            }
        } catch {
            pendingConfirmation = nil
            notice = error.localizedDescription
        }
    }

    func dismissConfirmation() {
        guard !isConfirming else { return }
        pendingConfirmation = nil
    }

    func confirmPendingDelivery() async {
        guard let preview = pendingConfirmation, !isConfirming else { return }
        isConfirming = true
        defer { isConfirming = false }
        do {
            if let blocker = governance.captureBlockers.first {
                throw BadRudyError.blocked(blocker)
            }
            if let recipient = preview.request.recipient,
               !recipients.contains(where: { $0.id == recipient.id && $0.handle == recipient.handle }) {
                throw BadRudyError.blocked("This recipient is no longer in Rico's approved allowlist.")
            }

            // A dry capture can never be upgraded later by turning dry-run
            // off. Conversely, switching dry-run on after capture tightens the
            // pending action into a would-send record.
            if preview.request.dryRun || governance.dryRun {
                try await deliveryClient.recordWouldSend(preview.request)
                updateRecent(id: preview.request.clip.id, status: "would_send")
                notice = "Dry-run recorded would_send. No message or schedule was dispatched."
            } else if preview.request.delivery == .scheduler {
                // This call may persist only a held job. It may never dispatch
                // media. The governed scheduler must surface a second human
                // confirmation after the item becomes due.
                try await deliveryClient.queueForScheduledConfirmation(preview.request)
                updateRecent(id: preview.request.clip.id, status: "queued_pending_confirmation")
                notice = "Queued in a held state. Confirm send is still required when the schedule becomes due."
            } else {
                try await deliveryClient.deliver(preview.request)
                updateRecent(id: preview.request.clip.id, status: "sent")
                notice = "Rico attachment delivery was confirmed."
            }
            pendingConfirmation = nil
        } catch {
            notice = error.localizedDescription
        }
    }

    func request() throws -> BadRudySubmission {
        let cleanedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanedPrompt.isEmpty else { throw BadRudyError.promptEmpty }
        guard cleanedPrompt.count <= Self.hardPromptLimit else { throw BadRudyError.promptTooLong }
        if let reason = promptFilter.rejectionReason(for: cleanedPrompt) {
            throw BadRudyError.promptRejected(reason)
        }
        if let blocker = governance.captureBlockers.first { throw BadRudyError.blocked(blocker) }

        let recipient: BadRudyRecipient?
        if delivery == .workflow {
            recipient = nil
        } else {
            guard let selectedRecipient else { throw BadRudyError.recipientRequired }
            recipient = selectedRecipient
        }

        let scheduled: Date?
        if delivery == .scheduler {
            guard BadRudySchedulePolicy.isValid(scheduledAt, now: now()) else { throw BadRudyError.invalidSchedule }
            scheduled = scheduledAt
        } else {
            scheduled = nil
        }

        let deduplicationKey = BadRudyDeduplication.key(
            prompt: cleanedPrompt,
            recipient: recipient?.handle,
            date: scheduled ?? now()
        )
        let capture = BadRudyCaptureRequest(
            prompt: cleanedPrompt,
            format: captureFormat,
            maximumDurationSeconds: min(max(maximumDurationSeconds, 1), 20),
            exportStillFrame: exportStillFrame,
            retries: min(max(retries, 0), 2),
            dryRun: governance.dryRun
        )
        return BadRudySubmission(
            capture: capture,
            delivery: delivery,
            recipient: recipient,
            scheduledAt: scheduled,
            deduplicationKey: deduplicationKey
        )
    }

    private func deliveryPreview(for request: BadRudyDeliveryRequest) throws -> BadRudyDeliveryPreview {
        let clipURL = URL(fileURLWithPath: request.clip.path)
        guard fileManager.fileExists(atPath: clipURL.path),
              let attributes = try? fileManager.attributesOfItem(atPath: clipURL.path),
              let byteSize = (attributes[.size] as? NSNumber)?.int64Value,
              byteSize > 0,
              let thumbnailPath = request.clip.thumbnailPath,
              fileManager.fileExists(atPath: thumbnailPath) else {
            throw BadRudyError.fileUnavailable
        }
        return BadRudyDeliveryPreview(
            id: UUID(),
            request: request,
            filename: clipURL.lastPathComponent,
            byteSize: byteSize
        )
    }

    private func updateRecent(id: UUID, status: String) {
        guard let index = recentCaptures.firstIndex(where: { $0.id == id }) else { return }
        recentCaptures[index] = BadRudyRecentCapture(clip: recentCaptures[index].clip, deliveryStatus: status)
    }

    private static func canonicalRecipients(_ recipients: [BadRudyRecipient]) -> [BadRudyRecipient] {
        var seen = Set<String>()
        return recipients
            .filter { !$0.handle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
            .filter { seen.insert($0.id).inserted }
    }
}
