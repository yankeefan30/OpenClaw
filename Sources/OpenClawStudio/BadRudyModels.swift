import CryptoKit
import Foundation
import Security

enum BadRudyKeychainContract {
    static let service = "openclaw-grok"
    static let account = "alan"
}

enum BadRudyCredentialState: Sendable, Equatable {
    case available
    case missing
    case unavailable(String)

    var label: String {
        switch self {
        case .available: "OK"
        case .missing: "Missing"
        case .unavailable: "Unavailable"
        }
    }

    var isAvailable: Bool {
        if case .available = self { return true }
        return false
    }

    var explanation: String? {
        switch self {
        case .available: nil
        case .missing:
            "Add the Grok credential to macOS Keychain using service openclaw-grok and account alan."
        case .unavailable(let message): message
        }
    }
}

protocol BadRudyCredentialReading: Sendable {
    func credentialState() -> BadRudyCredentialState
}

/// Presence-only Keychain probe. The UI requests attributes rather than the
/// secret data; credential bytes stay inside Keychain until the bounded worker
/// performs a governed capture.
struct BadRudyKeychainCredentialReader: BadRudyCredentialReading {
    func credentialState() -> BadRudyCredentialState {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: BadRudyKeychainContract.service,
            kSecAttrAccount as String: BadRudyKeychainContract.account,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return .missing }
        guard status == errSecSuccess, result != nil else {
            return .unavailable("macOS Keychain denied the Grok credential lookup (status \(status)).")
        }
        return .available
    }
}

enum BadRudyWorkerTransport: Sendable, Equatable {
    case loopback(URL)
    case process(executable: URL, module: URL)

    static func validatedLoopback(_ url: URL) throws -> Self {
        let permittedHosts = Set(["127.0.0.1", "localhost", "::1"])
        guard url.scheme == "http", let host = url.host?.lowercased(), permittedHosts.contains(host), url.user == nil, url.password == nil else {
            throw BadRudyError.nonLocalWorker
        }
        return .loopback(url)
    }

    static func validatedProcess(executable: URL, module: URL) throws -> Self {
        guard executable.isFileURL, module.isFileURL,
              executable.path.hasPrefix("/"), module.path.hasPrefix("/") else {
            throw BadRudyError.nonLocalWorker
        }
        return .process(executable: executable.standardizedFileURL, module: module.standardizedFileURL)
    }
}

struct BadRudyWorkerHealth: Sendable, Equatable {
    var playwrightReady: Bool
    var ffmpegReady: Bool
    var companionsWebAvailable: Bool
    var detail: String

    static let companionsUnavailable = Self(
        playwrightReady: false,
        ffmpegReady: false,
        companionsWebAvailable: false,
        detail: "Grok Companions does not currently expose a supported web surface. Companions web: unavailable."
    )

    var isReady: Bool { playwrightReady && ffmpegReady && companionsWebAvailable }
}

struct BadRudyRecipient: Identifiable, Sendable, Codable, Equatable, Hashable {
    let id: String
    let displayName: String
    let handle: String
}

enum BadRudyDelivery: String, CaseIterable, Identifiable, Sendable, Codable {
    case workflow
    case rico
    case scheduler

    var id: String { rawValue }
    var label: String {
        switch self {
        case .workflow: "Workflow (log only)"
        case .rico: "Rico attachment"
        case .scheduler: "Scheduler"
        }
    }
}

enum BadRudyCaptureFormat: String, CaseIterable, Identifiable, Sendable, Codable {
    case mp4
    var id: String { rawValue }
    var mime: String { "video/mp4" }
}

struct CapturedClip: Identifiable, Sendable, Codable, Equatable {
    let id: UUID
    let path: String
    let mime: String
    let durationMS: Int
    let thumbnailPath: String?
    let prompt: String
    let createdAt: Date
    let source: String

    enum CodingKeys: String, CodingKey {
        case id, path, mime, prompt, source
        case durationMS = "duration_ms"
        case thumbnailPath = "thumbnail_path"
        case createdAt = "created_at"
    }

    func validated(artifactsRoot: URL = BadRudyPaths.artifactsRoot) throws -> Self {
        guard source == "grok:bad-rudy", mime == "video/mp4", durationMS > 0 else {
            throw BadRudyError.invalidClip
        }
        let resolvedRoot = artifactsRoot.standardizedFileURL.resolvingSymlinksInPath()
        let clipURL = URL(fileURLWithPath: path).standardizedFileURL
        guard BadRudyPaths.isDescendant(clipURL, of: artifactsRoot),
              BadRudyPaths.isDescendant(clipURL.resolvingSymlinksInPath(), of: resolvedRoot),
              clipURL.pathExtension.lowercased() == "mp4" else {
            throw BadRudyError.nonLocalArtifact
        }
        if let thumbnailPath {
            let thumbnailURL = URL(fileURLWithPath: thumbnailPath).standardizedFileURL
            guard BadRudyPaths.isDescendant(thumbnailURL, of: artifactsRoot),
                  BadRudyPaths.isDescendant(thumbnailURL.resolvingSymlinksInPath(), of: resolvedRoot),
                  ["jpg", "jpeg"].contains(thumbnailURL.pathExtension.lowercased()) else {
                throw BadRudyError.nonLocalArtifact
            }
        }
        return self
    }
}

struct BadRudyCaptureRequest: Sendable, Equatable {
    let prompt: String
    let format: BadRudyCaptureFormat
    let maximumDurationSeconds: Int
    let exportStillFrame: Bool
    let retries: Int
    let dryRun: Bool
}

/// Host-only routing envelope. It is deliberately separate from the capture
/// request so the browser worker never receives a recipient, channel, or
/// schedule and cannot initiate delivery.
struct BadRudySubmission: Sendable, Equatable {
    let capture: BadRudyCaptureRequest
    let delivery: BadRudyDelivery
    let recipient: BadRudyRecipient?
    let scheduledAt: Date?
    let deduplicationKey: String
}

struct BadRudyDeliveryRequest: Sendable, Equatable {
    let clip: CapturedClip
    let delivery: BadRudyDelivery
    let recipient: BadRudyRecipient?
    let scheduledAt: Date?
    let dryRun: Bool
    let deduplicationKey: String
}

struct BadRudyDeliveryPreview: Identifiable, Sendable, Equatable {
    let id: UUID
    let request: BadRudyDeliveryRequest
    let filename: String
    let byteSize: Int64

    var channel: String {
        switch request.delivery {
        case .workflow: "Local workflow"
        case .rico: "iMessage"
        case .scheduler: "Scheduled iMessage"
        }
    }

    var recipientLabel: String {
        request.recipient.map { "\($0.displayName) · \($0.handle)" } ?? "None"
    }
}

protocol BadRudyCaptureClient: Sendable {
    func health() async -> BadRudyWorkerHealth
    func capture(_ request: BadRudyCaptureRequest) async throws -> CapturedClip
}

protocol BadRudyDeliveryClient: Sendable {
    func deliver(_ request: BadRudyDeliveryRequest) async throws
    func queueForScheduledConfirmation(_ request: BadRudyDeliveryRequest) async throws
    func recordWouldSend(_ request: BadRudyDeliveryRequest) async throws
}

/// Production remains fail-closed until a supported Companions web capability
/// exists. This client performs no Process launch, browser action, or send.
struct BadRudyUnavailableClient: BadRudyCaptureClient, BadRudyDeliveryClient {
    func health() async -> BadRudyWorkerHealth { .companionsUnavailable }
    func capture(_ request: BadRudyCaptureRequest) async throws -> CapturedClip { throw BadRudyError.companionsUnavailable }
    func deliver(_ request: BadRudyDeliveryRequest) async throws { throw BadRudyError.companionsUnavailable }
    func queueForScheduledConfirmation(_ request: BadRudyDeliveryRequest) async throws { throw BadRudyError.companionsUnavailable }
    func recordWouldSend(_ request: BadRudyDeliveryRequest) async throws { throw BadRudyError.companionsUnavailable }
}

protocol BadRudyPromptFiltering: Sendable {
    func rejectionReason(for prompt: String) -> String?
}

/// Mirrors OpenClaw's existing untrusted-input boundary: user content may
/// describe a performance but may not redefine host rules, expose credentials,
/// or forge Rico's trusted sender context.
struct BadRudyOpenClawPromptFilter: BadRudyPromptFiltering {
    private static let forbidden = [
        "ignore previous instructions",
        "ignore all previous",
        "reveal the system prompt",
        "show the system prompt",
        "reveal credentials",
        "show cookies",
        "session cookie",
        "<rico_trusted_sender_context>",
        "developer message:",
        "system message:",
    ]

    func rejectionReason(for prompt: String) -> String? {
        let normalized = prompt.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        if Self.forbidden.contains(where: normalized.contains) {
            return "This prompt tries to override OpenClaw instructions or request protected session data."
        }
        return nil
    }
}

struct BadRudyGovernanceStatus: Sendable, Equatable {
    var credential: BadRudyCredentialState = .missing
    var worker: BadRudyWorkerHealth = .companionsUnavailable
    var dryRun = true
    var killSwitchOn = true
    var allowlistCount = 0
    var rateLimitApproved = false

    var captureBlockers: [String] {
        var blockers: [String] = []
        if !credential.isAvailable { blockers.append(credential.explanation ?? "Grok credential is unavailable.") }
        if !worker.isReady { blockers.append(worker.detail) }
        if killSwitchOn { blockers.append("The Bad Rudy kill switch is on.") }
        if allowlistCount == 0 { blockers.append("Rico's approved-recipient allowlist is empty.") }
        if !rateLimitApproved { blockers.append("The existing Rico rate-limit governor has not approved this capture.") }
        return blockers
    }

    var mayCapture: Bool { captureBlockers.isEmpty }
    var mayDispatch: Bool { mayCapture && !dryRun }
}

enum BadRudySchedulePolicy {
    static let timezone = TimeZone(identifier: "America/New_York")!
    static let minimumLeadTime: TimeInterval = 2 * 60
    static let maximumLeadTime: TimeInterval = 30 * 24 * 60 * 60

    static func range(now: Date) -> ClosedRange<Date> {
        now.addingTimeInterval(minimumLeadTime)...now.addingTimeInterval(maximumLeadTime)
    }

    static func isValid(_ date: Date, now: Date) -> Bool { range(now: now).contains(date) }
}

enum BadRudyDeduplication {
    static func key(prompt: String, recipient: String?, date: Date) -> String {
        let minute = Int(date.timeIntervalSince1970 / 60)
        let normalizedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalizedRecipient = recipient?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "workflow"
        let digest = SHA256.hash(data: Data("\(normalizedPrompt)|\(normalizedRecipient)|\(minute)".utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

struct BadRudyRecentCapture: Identifiable, Sendable, Equatable {
    let clip: CapturedClip
    let deliveryStatus: String
    var id: UUID { clip.id }
}

protocol BadRudyCaptureLogLoading: Sendable {
    func loadRecent(limit: Int) -> [BadRudyRecentCapture]
}

enum BadRudyPaths {
    static var artifactsRoot: URL {
        URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent("OpenClaw/artifacts/bad-rudy", isDirectory: true)
    }

    static func isDescendant(_ child: URL, of root: URL) -> Bool {
        let rootPath = root.standardizedFileURL.path.hasSuffix("/") ? root.standardizedFileURL.path : root.standardizedFileURL.path + "/"
        return child.standardizedFileURL.path.hasPrefix(rootPath)
    }
}

struct BadRudyJSONLCaptureLog: BadRudyCaptureLogLoading {
    private struct Event: Decodable {
        let event: String?
        let clip: CapturedClip
        let deliveryStatus: String?

        enum CodingKeys: String, CodingKey {
            case event, clip
            case deliveryStatus = "delivery_status"
        }
    }

    private struct RuntimeEvent: Decodable {
        struct Payload: Decodable { let clip: CapturedClip? }
        let type: String
        let data: Payload
    }

    private struct WorkerEvent: Decodable {
        let event: String
        let id: UUID
        let path: String
        let mime: String
        let durationMS: Int
        let thumbnailPath: String?
        let promptPreview: String
        let createdAt: Date
        let source: String

        enum CodingKeys: String, CodingKey {
            case event, id, path, mime, source
            case durationMS = "duration_ms"
            case thumbnailPath = "thumbnail_path"
            case promptPreview = "prompt_preview"
            case createdAt = "created_at"
        }

        var clip: CapturedClip {
            CapturedClip(
                id: id,
                path: path,
                mime: mime,
                durationMS: durationMS,
                thumbnailPath: thumbnailPath,
                prompt: promptPreview,
                createdAt: createdAt,
                source: source
            )
        }
    }

    let root: URL

    init(root: URL = BadRudyPaths.artifactsRoot) {
        self.root = root.standardizedFileURL
    }

    func loadRecent(limit: Int = 20) -> [BadRudyRecentCapture] {
        let fileManager = FileManager.default
        guard limit > 0,
              let directories = try? fileManager.contentsOfDirectory(
                at: root,
                includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
                options: [.skipsHiddenFiles]
              ) else { return [] }

        let datePattern = try? NSRegularExpression(pattern: "^\\d{4}-\\d{2}-\\d{2}$")
        var logURLs = directories.compactMap { directory -> URL? in
            let name = directory.lastPathComponent
            let range = NSRange(location: 0, length: name.utf16.count)
            guard datePattern?.firstMatch(in: name, range: range) != nil,
                  let values = try? directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
                  values.isDirectory == true, values.isSymbolicLink != true else { return nil }
            let log = directory.appendingPathComponent("captures.jsonl").standardizedFileURL
            return BadRudyPaths.isDescendant(log, of: root) ? log : nil
        }
        let governedLog = root.appendingPathComponent("_state/events.jsonl").standardizedFileURL
        if BadRudyPaths.isDescendant(governedLog, of: root) {
            logURLs.append(governedLog)
        }

        let decoder = JSONDecoder.badRudy
        let captures = logURLs.flatMap { url -> [BadRudyRecentCapture] in
            guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
                  values.isRegularFile == true, values.isSymbolicLink != true else { return [] }
            guard let data = try? Data(contentsOf: url, options: [.mappedIfSafe]) else { return [] }
            return String(decoding: data, as: UTF8.self).split(separator: "\n").compactMap { line in
                let bytes = Data(line.utf8)
                if let event = try? decoder.decode(Event.self, from: bytes),
                   event.event == nil || event.event == "capture.completed",
                   (try? event.clip.validated(artifactsRoot: root)) != nil {
                    return BadRudyRecentCapture(clip: event.clip, deliveryStatus: event.deliveryStatus ?? "captured")
                }
                if let event = try? decoder.decode(RuntimeEvent.self, from: bytes),
                   event.type == "capture.completed",
                   let clip = event.data.clip,
                   (try? clip.validated(artifactsRoot: root)) != nil {
                    return BadRudyRecentCapture(clip: clip, deliveryStatus: "captured")
                }
                if let event = try? decoder.decode(WorkerEvent.self, from: bytes),
                   event.event == "capture.completed",
                   (try? event.clip.validated(artifactsRoot: root)) != nil {
                    return BadRudyRecentCapture(clip: event.clip, deliveryStatus: "captured")
                }
                return nil
            }
        }
        .sorted { $0.clip.createdAt > $1.clip.createdAt }
        var seen = Set<UUID>()
        return captures.filter { seen.insert($0.id).inserted }.prefix(limit).map { $0 }
    }
}

private extension JSONDecoder {
    static var badRudy: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            if let number = try? container.decode(Double.self) {
                return Date(timeIntervalSince1970: number > 10_000_000_000 ? number / 1_000 : number)
            }
            let value = try container.decode(String.self)
            let withFraction = ISO8601DateFormatter()
            withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = withFraction.date(from: value) { return date }
            let plain = ISO8601DateFormatter()
            if let date = plain.date(from: value) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid Bad Rudy timestamp.")
        }
        return decoder
    }
}

enum BadRudyError: LocalizedError, Equatable {
    case credentialMissing
    case companionsUnavailable
    case nonLocalWorker
    case nonLocalArtifact
    case invalidClip
    case promptEmpty
    case promptTooLong
    case promptRejected(String)
    case recipientRequired
    case invalidSchedule
    case blocked(String)
    case fileUnavailable

    var errorDescription: String? {
        switch self {
        case .credentialMissing: "The Grok Keychain credential is missing."
        case .companionsUnavailable: "Companions web is unavailable; no capture or send was attempted."
        case .nonLocalWorker: "The Bad Rudy worker must use a local process or a loopback-only HTTP endpoint."
        case .nonLocalArtifact: "The captured clip is outside the local Bad Rudy artifacts directory."
        case .invalidClip: "The worker returned an invalid captured clip."
        case .promptEmpty: "Describe what Bad Rudy should say or do."
        case .promptTooLong: "The prompt exceeds the 2,000-character hard limit."
        case .promptRejected(let reason): reason
        case .recipientRequired: "Choose an approved Rico recipient."
        case .invalidSchedule: "Choose a time from 2 minutes through 30 days from now."
        case .blocked(let reason): reason
        case .fileUnavailable: "The captured clip is not available for confirmation."
        }
    }
}
