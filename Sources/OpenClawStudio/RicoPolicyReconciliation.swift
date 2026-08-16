import Darwin
import Foundation

/// User intent is durable and independent from transient runtime health. A
/// missing intent marker starts admission quarantined, but never disables the
/// physical iMessage channel. Only an explicit Pause/Resume action records a
/// reviewed intent.
struct RicoPauseIntentState: Equatable, Sendable {
    let paused: Bool
    let reviewed: Bool
}

@MainActor
enum RicoPauseIntentStore {
    static let pausedKey = "rico.globalPaused"
    static let versionKey = "rico.globalPauseIntentVersion"
    static let currentVersion = 1

    static func load(from defaults: UserDefaults = .standard) -> RicoPauseIntentState {
        let hasStoredValue = defaults.object(forKey: pausedKey) != nil
        let version = defaults.integer(forKey: versionKey)
        guard hasStoredValue else {
            // A new or damaged installation is fail-closed at the admission
            // layer. This is not treated as a user request to turn off the
            // registered iMessage channel.
            return RicoPauseIntentState(paused: false, reviewed: false)
        }

        let paused = defaults.bool(forKey: pausedKey)
        if version == currentVersion {
            return RicoPauseIntentState(paused: paused, reviewed: true)
        }
        if paused {
            // Older Studio builds also wrote `true` after transient health
            // failures, so a legacy true value cannot prove a human Pause.
            return RicoPauseIntentState(paused: false, reviewed: false)
        }
        // A legacy false value can be migrated safely: it never disables the
        // channel, and the active path still requires complete live proof.
        defaults.set(currentVersion, forKey: versionKey)
        return RicoPauseIntentState(paused: false, reviewed: true)
    }

    static func recordExplicit(_ paused: Bool, in defaults: UserDefaults = .standard) {
        defaults.set(paused, forKey: pausedKey)
        defaults.set(currentVersion, forKey: versionKey)
    }
}

/// Projection mode separates desired user state from observed runtime health.
/// Health quarantine blocks every Rico admission/tool/binding path while
/// leaving the registered iMessage channel available for recovery and probes.
enum RicoProjectionMode: Equatable, Sendable {
    case active
    case explicitPause
    case healthQuarantine

    var admissionPaused: Bool {
        self != .active
    }

    var channelEnabled: Bool {
        self != .explicitPause
    }

    var requiresRuntimeProof: Bool {
        self == .active
    }

    static func desired(paused: Bool, reviewed: Bool) -> RicoProjectionMode {
        guard reviewed else { return .healthQuarantine }
        return paused ? .explicitPause : .active
    }
}

enum RicoPauseIntentTransition {
    static func shouldCommit(
        currentPaused: Bool,
        reviewed: Bool,
        requestedPaused: Bool
    ) -> Bool {
        requestedPaused != currentPaused || !reviewed
    }
}

enum RicoActiveProjectionAttempt: Equatable, Sendable {
    /// Guard admission is held paused while model, plugin, and native policy
    /// are proved. The sidecar is unpaused only as the final activation step.
    case stagedActivation
    /// A healthy watchdog pass is read-only. Any drift or failed proof exits
    /// to quarantine before a later staged repair attempt.
    case healthyAudit

    var initialGuardPaused: Bool {
        self == .stagedActivation
    }

    var mayRepairNativeConfig: Bool {
        self == .stagedActivation
    }
}

/// One process owns all Rico sidecar and native-policy projection for its
/// lifetime. `flock` makes a dev build, stale installed build, or duplicate
/// window a read-only observer instead of a competing writer. The kernel
/// releases the lease automatically if the owning process exits.
final class RicoProjectionWriterLease: @unchecked Sendable {
    enum LeaseError: LocalizedError {
        case unsafeDirectory
        case unsafeFile
        case alreadyOwned
        case unavailable

        var errorDescription: String? {
            switch self {
            case .unsafeDirectory, .unsafeFile:
                "Rico's projection-writer lease failed its private file boundary check."
            case .alreadyOwned:
                "Another OpenClaw Studio process already owns Rico's policy writer."
            case .unavailable:
                "Rico could not acquire its single-writer policy lease."
            }
        }
    }

    private var descriptor: Int32

    private init(descriptor: Int32) {
        self.descriptor = descriptor
    }

    deinit {
        release()
    }

    static var defaultDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/OpenClaw Studio", isDirectory: true)
    }

    static func acquire(in directory: URL = defaultDirectory) throws -> RicoProjectionWriterLease {
        let manager = FileManager.default
        var directoryStat = stat()
        if lstat(directory.path, &directoryStat) != 0 {
            guard errno == ENOENT else { throw LeaseError.unsafeDirectory }
            try manager.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        }
        guard lstat(directory.path, &directoryStat) == 0,
              directoryStat.st_mode & S_IFMT == S_IFDIR,
              directoryStat.st_uid == getuid() else {
            throw LeaseError.unsafeDirectory
        }
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        guard lstat(directory.path, &directoryStat) == 0,
              directoryStat.st_mode & S_IFMT == S_IFDIR,
              directoryStat.st_mode & 0o777 == 0o700,
              directoryStat.st_uid == getuid() else {
            throw LeaseError.unsafeDirectory
        }

        let lockURL = directory.appendingPathComponent("rico-policy-writer.lock")
        let descriptor = Darwin.open(
            lockURL.path,
            O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW,
            S_IRUSR | S_IWUSR
        )
        guard descriptor >= 0 else { throw LeaseError.unsafeFile }
        var shouldClose = true
        defer { if shouldClose { Darwin.close(descriptor) } }

        guard fchmod(descriptor, S_IRUSR | S_IWUSR) == 0 else {
            throw LeaseError.unsafeFile
        }
        var fileStat = stat()
        guard fstat(descriptor, &fileStat) == 0,
              fileStat.st_mode & S_IFMT == S_IFREG,
              fileStat.st_mode & 0o777 == 0o600,
              fileStat.st_uid == getuid(),
              fileStat.st_nlink == 1 else {
            throw LeaseError.unsafeFile
        }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            if errno == EWOULDBLOCK || errno == EAGAIN { throw LeaseError.alreadyOwned }
            throw LeaseError.unavailable
        }
        shouldClose = false
        return RicoProjectionWriterLease(descriptor: descriptor)
    }

    func release() {
        guard descriptor >= 0 else { return }
        _ = flock(descriptor, LOCK_UN)
        Darwin.close(descriptor)
        descriptor = -1
    }
}

/// Cross-process transaction lease for the single OpenClaw configuration
/// document. Studio and the independently launched ISTS activation helper use
/// the same atomic directory protocol, so neither can compose a replacement
/// batch from a snapshot that the other is concurrently changing.
final class RicoNativeConfigLease: @unchecked Sendable {
    static let schema = "openclaw-studio-native-config-lease"
    static let schemaVersion = 1
    static let directoryName = "rico-native-config.lock"
    static let ownerFileName = "owner.json"

    enum LeaseError: LocalizedError, Equatable {
        case unsafeBoundary
        case busy
        case unavailable

        var errorDescription: String? {
            switch self {
            case .unsafeBoundary:
                "The shared OpenClaw configuration lease failed its private boundary check."
            case .busy:
                "Another reviewed workflow is updating OpenClaw configuration."
            case .unavailable:
                "The shared OpenClaw configuration lease is unavailable."
            }
        }
    }

    private struct Owner: Codable, Equatable {
        let schema: String
        let schemaVersion: Int
        let pid: Int32
        let token: String
    }

    private let lock = NSLock()
    private let directory: URL
    private let ownerURL: URL
    private let token: String
    private let device: dev_t
    private let inode: ino_t
    private var owned = true

    private init(directory: URL, ownerURL: URL, token: String, device: dev_t, inode: ino_t) {
        self.directory = directory
        self.ownerURL = ownerURL
        self.token = token
        self.device = device
        self.inode = inode
    }

    deinit {
        release()
    }

    static var defaultSupportDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/OpenClaw Studio", isDirectory: true)
    }

    static func acquire(
        in supportDirectory: URL = defaultSupportDirectory,
        timeoutNanoseconds: UInt64 = 10_000_000_000,
        pollNanoseconds: UInt64 = 50_000_000
    ) async throws -> RicoNativeConfigLease {
        try secureSupportDirectory(supportDirectory)
        let directory = supportDirectory.appendingPathComponent(directoryName, isDirectory: true)
        let deadline = DispatchTime.now().uptimeNanoseconds &+ timeoutNanoseconds

        while true {
            try Task.checkCancellation()
            if Darwin.mkdir(directory.path, S_IRWXU) == 0 {
                do {
                    return try initialize(directory: directory)
                } catch {
                    _ = Darwin.unlink(directory.appendingPathComponent(ownerFileName).path)
                    _ = Darwin.rmdir(directory.path)
                    throw error
                }
            }
            guard errno == EEXIST else { throw LeaseError.unavailable }
            try inspectOrRecover(directory: directory)
            if DispatchTime.now().uptimeNanoseconds >= deadline { throw LeaseError.busy }
            try await Task.sleep(nanoseconds: pollNanoseconds)
        }
    }

    static func withLease<T: Sendable>(
        in supportDirectory: URL = defaultSupportDirectory,
        timeoutNanoseconds: UInt64 = 10_000_000_000,
        operation: @escaping @Sendable (RicoNativeConfigLease) async throws -> T
    ) async throws -> T {
        let lease = try await acquire(
            in: supportDirectory,
            timeoutNanoseconds: timeoutNanoseconds
        )
        do {
            let result = try await operation(lease)
            guard lease.release() else { throw LeaseError.unavailable }
            return result
        } catch {
            _ = lease.release()
            throw error
        }
    }

    @discardableResult
    func release() -> Bool {
        let shouldRelease = lock.withLock { () -> Bool in
            guard owned else { return false }
            owned = false
            return true
        }
        guard shouldRelease else { return true }

        var directoryStat = stat()
        guard lstat(directory.path, &directoryStat) == 0,
              directoryStat.st_mode & S_IFMT == S_IFDIR,
              directoryStat.st_uid == getuid(),
              directoryStat.st_dev == device,
              directoryStat.st_ino == inode,
              let owner = try? Self.readOwner(ownerURL),
              owner.token == token,
              owner.pid == getpid() else { return false }
        guard Darwin.unlink(ownerURL.path) == 0 else { return false }
        return Darwin.rmdir(directory.path) == 0
    }

    private static func initialize(directory: URL) throws -> RicoNativeConfigLease {
        guard chmod(directory.path, S_IRWXU) == 0 else { throw LeaseError.unsafeBoundary }
        var directoryStat = stat()
        guard lstat(directory.path, &directoryStat) == 0,
              directoryStat.st_mode & S_IFMT == S_IFDIR,
              directoryStat.st_mode & 0o777 == 0o700,
              directoryStat.st_uid == getuid() else { throw LeaseError.unsafeBoundary }

        let token = UUID().uuidString.lowercased()
        let owner = Owner(schema: schema, schemaVersion: schemaVersion, pid: getpid(), token: token)
        let data = try JSONEncoder().encode(owner)
        let ownerURL = directory.appendingPathComponent(ownerFileName)
        let descriptor = Darwin.open(
            ownerURL.path,
            O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
            S_IRUSR | S_IWUSR
        )
        guard descriptor >= 0 else { throw LeaseError.unsafeBoundary }
        defer { Darwin.close(descriptor) }
        guard fchmod(descriptor, S_IRUSR | S_IWUSR) == 0,
              writeAll(data, to: descriptor),
              fsync(descriptor) == 0 else { throw LeaseError.unavailable }
        var ownerStat = stat()
        guard fstat(descriptor, &ownerStat) == 0,
              ownerStat.st_mode & S_IFMT == S_IFREG,
              ownerStat.st_mode & 0o777 == 0o600,
              ownerStat.st_uid == getuid(),
              ownerStat.st_nlink == 1 else { throw LeaseError.unsafeBoundary }
        return RicoNativeConfigLease(
            directory: directory,
            ownerURL: ownerURL,
            token: token,
            device: directoryStat.st_dev,
            inode: directoryStat.st_ino
        )
    }

    /// Valid metadata owned by a dead PID is the only automatically reclaimed
    /// state. Missing, malformed, linked, or permission-broadened state remains
    /// fail-closed for manual inspection instead of being guessed away.
    private static func inspectOrRecover(directory: URL) throws {
        var directoryStat = stat()
        guard lstat(directory.path, &directoryStat) == 0,
              directoryStat.st_mode & S_IFMT == S_IFDIR,
              directoryStat.st_mode & 0o777 == 0o700,
              directoryStat.st_uid == getuid() else { throw LeaseError.unsafeBoundary }
        let ownerURL = directory.appendingPathComponent(ownerFileName)
        let owner = try readOwner(ownerURL)
        guard owner.schema == schema,
              owner.schemaVersion == schemaVersion,
              owner.pid > 1,
              UUID(uuidString: owner.token) != nil else { throw LeaseError.unsafeBoundary }
        if Darwin.kill(owner.pid, 0) == 0 || errno == EPERM { return }
        guard errno == ESRCH else { throw LeaseError.unavailable }

        // The recorded owner is dead, so no valid process can release or
        // replace this directory until it is removed. Recheck the exact inode
        // immediately before removing its single metadata file.
        var recheck = stat()
        guard lstat(directory.path, &recheck) == 0,
              recheck.st_dev == directoryStat.st_dev,
              recheck.st_ino == directoryStat.st_ino,
              (try? readOwner(ownerURL)) == owner,
              Darwin.unlink(ownerURL.path) == 0,
              Darwin.rmdir(directory.path) == 0 else { throw LeaseError.unsafeBoundary }
    }

    private static func readOwner(_ url: URL) throws -> Owner {
        let descriptor = Darwin.open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw LeaseError.unsafeBoundary }
        defer { Darwin.close(descriptor) }
        var before = stat()
        guard fstat(descriptor, &before) == 0,
              before.st_mode & S_IFMT == S_IFREG,
              before.st_mode & 0o777 == 0o600,
              before.st_uid == getuid(),
              before.st_nlink == 1,
              before.st_size > 0,
              before.st_size <= 4_096 else { throw LeaseError.unsafeBoundary }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
        let data = try handle.readToEnd() ?? Data()
        var after = stat()
        guard fstat(descriptor, &after) == 0,
              before.st_dev == after.st_dev,
              before.st_ino == after.st_ino,
              before.st_size == after.st_size,
              data.count == Int(after.st_size) else { throw LeaseError.unsafeBoundary }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["schema", "schemaVersion", "pid", "token"] else {
            throw LeaseError.unsafeBoundary
        }
        return try JSONDecoder().decode(Owner.self, from: data)
    }

    private static func secureSupportDirectory(_ directory: URL) throws {
        let manager = FileManager.default
        var fileStat = stat()
        if lstat(directory.path, &fileStat) != 0 {
            guard errno == ENOENT else { throw LeaseError.unsafeBoundary }
            try manager.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        }
        guard lstat(directory.path, &fileStat) == 0,
              fileStat.st_mode & S_IFMT == S_IFDIR,
              fileStat.st_uid == getuid() else { throw LeaseError.unsafeBoundary }
        if fileStat.st_mode & 0o777 != 0o700 {
            try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        }
        guard lstat(directory.path, &fileStat) == 0,
              fileStat.st_mode & S_IFMT == S_IFDIR,
              fileStat.st_mode & 0o777 == 0o700,
              fileStat.st_uid == getuid() else { throw LeaseError.unsafeBoundary }
    }

    private static func writeAll(_ data: Data, to descriptor: Int32) -> Bool {
        data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return data.isEmpty }
            var offset = 0
            while offset < data.count {
                let result = Darwin.write(descriptor, base.advanced(by: offset), data.count - offset)
                if result > 0 { offset += result; continue }
                if result < 0, errno == EINTR { continue }
                return false
            }
            return true
        }
    }
}

enum RicoProjectionRetryPolicy {
    /// A short launch debounce absorbs Gateway/plugin/model warm-up. Thereafter
    /// the watchdog keeps retrying while quarantine remains in force.
    static let launchDebounceNanoseconds: UInt64 = 750_000_000
    static let transientRetryNanoseconds: [UInt64] = [1_000_000_000, 2_000_000_000]
    static let watchdogNanoseconds: UInt64 = 15_000_000_000
    static let healthyAuditNanoseconds: UInt64 = 30_000_000_000

    static func delay(afterFailure failureCount: Int) -> UInt64 {
        guard failureCount > 0 else { return launchDebounceNanoseconds }
        let index = failureCount - 1
        return index < transientRetryNanoseconds.count
            ? transientRetryNanoseconds[index]
            : watchdogNanoseconds
    }
}

enum RicoProjectionRecoveryPolicy {
    /// Every transient active-path failure (Gateway unavailable, local-model
    /// warm-up, plugin install/reload, or read-back race) has the same safe
    /// response. The cause never becomes durable user intent.
    static func fallback(for desiredMode: RicoProjectionMode) -> RicoProjectionMode {
        desiredMode == .active ? .healthQuarantine : desiredMode
    }
}

enum RicoOutboundAdmission {
    static func isVerified(
        explicitlyPaused: Bool,
        healthQuarantined: Bool,
        enforcementVerified: Bool,
        outboundTransportOperational: Bool
    ) -> Bool {
        !explicitlyPaused && !healthQuarantined && enforcementVerified && outboundTransportOperational
    }

    static func draftBlockReason(
        explicitlyPaused: Bool,
        healthQuarantined: Bool,
        outboundTransportOperational: Bool
    ) -> String? {
        if explicitlyPaused { return "Rico communications are explicitly paused." }
        if !outboundTransportOperational {
            return "The Gateway iMessage transport is unavailable."
        }
        if healthQuarantined { return "Rico admission is safety-quarantined pending live verification." }
        return nil
    }
}

enum RicoDeliveryObservationDecision: Equatable, Sendable {
    case displayOnly
    case noProjectionChange
    case quarantine

    static func decide(
        hasWriterLease: Bool,
        readiness: IMessageProbeReadiness,
        explicitlyPaused: Bool,
        pauseIntentReviewed: Bool,
        healthQuarantined _: Bool
    ) -> RicoDeliveryObservationDecision {
        guard hasWriterLease else { return .displayOnly }
        guard !readiness.transportOperational,
              !explicitlyPaused,
              pauseIntentReviewed else { return .noProjectionChange }
        // Even an already-quarantined Store can be midway through a staged
        // activation. Every newer transport-unavailable observation must
        // invalidate that epoch; treating quarantine as a no-op would let the
        // older proof unpause after this observation.
        return .quarantine
    }
}

/// A projection epoch binds every asynchronous stage to one exact policy
/// generation and one exact reviewed pause intent. Detached work may finish
/// after cancellation, but it cannot mutate or activate once a newer epoch has
/// been issued.
struct RicoProjectionEpoch: Equatable, Sendable {
    let sequence: UInt64
    let desiredMode: RicoProjectionMode
}

@MainActor
final class RicoProjectionEpochAuthority {
    enum EpochError: LocalizedError, Equatable {
        case stale

        var errorDescription: String? {
            "Rico discarded a stale policy-projection attempt."
        }
    }

    private var sequence: UInt64 = 0
    private var current: RicoProjectionEpoch?

    func begin(desiredMode: RicoProjectionMode) -> RicoProjectionEpoch {
        precondition(sequence < UInt64.max, "Rico projection epoch exhausted")
        sequence += 1
        let epoch = RicoProjectionEpoch(sequence: sequence, desiredMode: desiredMode)
        current = epoch
        return epoch
    }

    /// Invalidates every outstanding epoch before a multi-file staging write
    /// begins. This is deliberately separate from `begin`: a staging failure
    /// must leave no older detached task authorized to reactivate admission.
    func invalidate() {
        precondition(sequence < UInt64.max, "Rico projection epoch exhausted")
        sequence += 1
        current = nil
    }

    func isCurrent(_ epoch: RicoProjectionEpoch, currentMode: RicoProjectionMode) -> Bool {
        current == epoch && epoch.desiredMode == currentMode
    }

    func attest(_ epoch: RicoProjectionEpoch, currentMode: RicoProjectionMode) throws {
        guard isCurrent(epoch, currentMode: currentMode) else {
            throw EpochError.stale
        }
    }

    /// The attestation and mutation execute in one MainActor turn. A newer
    /// explicit Pause or policy snapshot therefore cannot interleave between
    /// the final epoch check and the sidecar write.
    func performIfCurrent<T>(
        _ epoch: RicoProjectionEpoch,
        currentMode: RicoProjectionMode,
        _ operation: () throws -> T
    ) throws -> T {
        try attest(epoch, currentMode: currentMode)
        return try operation()
    }
}

/// Activating admission is a tiny, separately testable transaction. If either
/// active proof or the post-proof epoch attestation fails, pause must be
/// restored before the error is allowed to escape. Failure to restore pause is
/// promoted to a hard boundary error and must never be treated as quarantined.
enum RicoFinalActivationBoundary {
    enum BoundaryError: LocalizedError, Equatable {
        case requarantineFailed

        var errorDescription: String? {
            "Rico could not restore its paused admission boundary after activation verification failed."
        }
    }

    static func activate(
        attestCurrent: @escaping @Sendable () async throws -> Void,
        writePaused: @escaping @Sendable (Bool) async throws -> Void,
        proveActive: @escaping @Sendable () async throws -> Void
    ) async throws {
        try await attestCurrent()
        do {
            // The admission writer updates more than one private sidecar. A
            // partial activation write is therefore handled exactly like a
            // failed proof: restore pause before returning any error.
            try await writePaused(false)
            try await proveActive()
            try await attestCurrent()
        } catch {
            do {
                try await writePaused(true)
            } catch {
                throw BoundaryError.requarantineFailed
            }
            throw error
        }
    }
}
