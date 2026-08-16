import Darwin
import Foundation

/// Runs a child without the classic `waitUntilExit`/full-pipe deadlock. Both
/// pipes are drained concurrently, runtime and output are bounded, and task
/// cancellation terminates then kills the exact child before returning.
enum BoundedProcessRunner {
    struct Output: Sendable {
        let stdout: String
        let stderr: String
        let status: Int32
    }

    enum RunnerError: LocalizedError, Equatable {
        case timedOut
        case outputLimitExceeded
        case outputReadFailed
        case childDidNotExit

        var errorDescription: String? {
            switch self {
            case .timedOut: "The bounded local command timed out."
            case .outputLimitExceeded: "The bounded local command exceeded its output limit."
            case .outputReadFailed: "The bounded local command output could not be read."
            case .childDidNotExit: "The bounded local command could not be stopped safely."
            }
        }
    }

    private struct DrainResult: Sendable {
        let data: Data
        let exceeded: Bool
        let failed: Bool
    }

    private final class DrainState: @unchecked Sendable {
        private let lock = NSLock()
        private var limitExceeded = false
        private var drainCompleted = false

        var exceeded: Bool { lock.withLock { limitExceeded } }
        var completed: Bool { lock.withLock { drainCompleted } }

        func markExceeded() {
            lock.withLock { limitExceeded = true }
        }

        func markCompleted() {
            lock.withLock { drainCompleted = true }
        }
    }

    private final class Control: @unchecked Sendable {
        private let lock = NSLock()
        private let process: Process
        private var stopRequested = false

        init(_ process: Process) {
            self.process = process
        }

        var isRunning: Bool {
            lock.withLock { process.isRunning }
        }

        var status: Int32 {
            lock.withLock { process.terminationStatus }
        }

        func requestStop() {
            let child: pid_t? = lock.withLock {
                guard !stopRequested, process.isRunning else { return nil }
                stopRequested = true
                return process.processIdentifier
            }
            guard let child, child > 1 else { return }
            _ = Darwin.kill(child, SIGTERM)
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .milliseconds(250)) { [weak self] in
                guard let self else { return }
                let stillRunning = self.lock.withLock { self.process.isRunning }
                if stillRunning { _ = Darwin.kill(child, SIGKILL) }
            }
        }
    }

    static func run(
        executable: URL,
        arguments: [String],
        environment: [String: String]? = nil,
        timeoutSeconds: TimeInterval = 15,
        maxOutputBytes: Int = 16 * 1_024 * 1_024
    ) async throws -> Output {
        guard timeoutSeconds > 0, timeoutSeconds.isFinite, maxOutputBytes > 0 else {
            throw RunnerError.timedOut
        }
        try Task.checkCancellation()

        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        try process.run()
        // The child inherited duplicated write descriptors. Closing the
        // parent's copies guarantees EOF as soon as the exact child exits.
        stdoutPipe.fileHandleForWriting.closeFile()
        stderrPipe.fileHandleForWriting.closeFile()
        let control = Control(process)
        let stdoutState = DrainState()
        let stderrState = DrainState()

        let stdoutTask = Task.detached(priority: .utility) {
            let result = drain(stdoutPipe.fileHandleForReading, limit: maxOutputBytes, state: stdoutState)
            stdoutState.markCompleted()
            return result
        }
        let stderrTask = Task.detached(priority: .utility) {
            let result = drain(stderrPipe.fileHandleForReading, limit: maxOutputBytes, state: stderrState)
            stderrState.markCompleted()
            return result
        }

        let started = DispatchTime.now().uptimeNanoseconds
        let timeoutNanoseconds = UInt64(timeoutSeconds * 1_000_000_000)
        do {
            try await withTaskCancellationHandler {
                while control.isRunning {
                    try Task.checkCancellation()
                    if stdoutState.exceeded || stderrState.exceeded {
                        control.requestStop()
                        guard await waitForExit(control, nanoseconds: 1_500_000_000) else {
                            throw RunnerError.childDidNotExit
                        }
                        throw RunnerError.outputLimitExceeded
                    }
                    if DispatchTime.now().uptimeNanoseconds - started >= timeoutNanoseconds {
                        control.requestStop()
                        guard await waitForExit(control, nanoseconds: 1_500_000_000) else {
                            throw RunnerError.childDidNotExit
                        }
                        throw RunnerError.timedOut
                    }
                    try await Task.sleep(nanoseconds: 20_000_000)
                }
            } onCancel: {
                control.requestStop()
            }
        } catch {
            control.requestStop()
            let stopped = await waitForExit(control, nanoseconds: 1_500_000_000)
            // A descendant must not be able to keep an inherited pipe open
            // and strand cancellation after the exact Process has stopped.
            stdoutPipe.fileHandleForReading.closeFile()
            stderrPipe.fileHandleForReading.closeFile()
            _ = await stdoutTask.value
            _ = await stderrTask.value
            if !stopped { throw RunnerError.childDidNotExit }
            throw error
        }

        do {
            let drained = try await waitForDrains(
                stdoutState,
                stderrState,
                nanoseconds: 500_000_000
            )
            if !drained {
                // The exact child exited but a descendant retained a pipe.
                // Close locally so no inherited descriptor can strand the
                // reconciler or its lifetime config lease.
                stdoutPipe.fileHandleForReading.closeFile()
                stderrPipe.fileHandleForReading.closeFile()
            }
        } catch {
            stdoutPipe.fileHandleForReading.closeFile()
            stderrPipe.fileHandleForReading.closeFile()
            _ = await stdoutTask.value
            _ = await stderrTask.value
            throw error
        }
        let stdout = await stdoutTask.value
        let stderr = await stderrTask.value
        try Task.checkCancellation()
        guard !stdout.failed, !stderr.failed else { throw RunnerError.outputReadFailed }
        guard !stdout.exceeded, !stderr.exceeded else { throw RunnerError.outputLimitExceeded }
        return Output(
            stdout: String(data: stdout.data, encoding: .utf8) ?? "",
            stderr: String(data: stderr.data, encoding: .utf8) ?? "",
            status: control.status
        )
    }

    private static func drain(_ handle: FileHandle, limit: Int, state: DrainState) -> DrainResult {
        var retained = Data()
        var exceeded = false
        do {
            while true {
                guard let chunk = try handle.read(upToCount: 64 * 1_024), !chunk.isEmpty else { break }
                let remaining = max(0, limit - retained.count)
                if remaining > 0 { retained.append(chunk.prefix(remaining)) }
                if chunk.count > remaining {
                    exceeded = true
                    state.markExceeded()
                }
            }
            return DrainResult(data: retained, exceeded: exceeded, failed: false)
        } catch {
            return DrainResult(data: retained, exceeded: exceeded, failed: true)
        }
    }

    private static func waitForExit(_ control: Control, nanoseconds: UInt64) async -> Bool {
        let started = DispatchTime.now().uptimeNanoseconds
        while control.isRunning {
            if DispatchTime.now().uptimeNanoseconds - started >= nanoseconds { return false }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return true
    }

    private static func waitForDrains(
        _ stdout: DrainState,
        _ stderr: DrainState,
        nanoseconds: UInt64
    ) async throws -> Bool {
        let started = DispatchTime.now().uptimeNanoseconds
        while !stdout.completed || !stderr.completed {
            try Task.checkCancellation()
            if DispatchTime.now().uptimeNanoseconds - started >= nanoseconds { return false }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        return true
    }
}

private extension NSLock {
    func withLock<T>(_ operation: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try operation()
    }
}
