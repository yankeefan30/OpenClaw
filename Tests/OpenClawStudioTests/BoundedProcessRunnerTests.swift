import Darwin
import Foundation
import Testing
@testable import OpenClawStudio

@Suite("Bounded process and shared config transaction safety")
struct BoundedProcessRunnerTests {
    @Test("stdout and stderr are drained concurrently without pipe saturation")
    func concurrentPipeDrain() async throws {
        let script = "i=0; while [ $i -lt 6000 ]; do printf 'stdout-%05d-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n' $i; printf 'stderr-%05d-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\\n' $i >&2; i=$((i+1)); done"
        let result = try await BoundedProcessRunner.run(
            executable: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", script],
            timeoutSeconds: 5,
            maxOutputBytes: 2 * 1_024 * 1_024
        )
        #expect(result.status == 0)
        #expect(result.stdout.contains("stdout-05999"))
        #expect(result.stderr.contains("stderr-05999"))
    }

    @Test("output overflow terminates the exact child instead of buffering without bound")
    func outputLimitStopsChild() async {
        do {
            _ = try await BoundedProcessRunner.run(
                executable: URL(fileURLWithPath: "/usr/bin/yes"),
                arguments: [],
                timeoutSeconds: 3,
                maxOutputBytes: 32 * 1_024
            )
            Issue.record("An unbounded writer must not complete successfully")
        } catch let error as BoundedProcessRunner.RunnerError {
            #expect(error == .outputLimitExceeded)
        } catch {
            Issue.record("Expected the bounded output error")
        }
    }

    @Test("timeout kills a child that ignores TERM")
    func timeoutKillsTermIgnoringChild() async {
        let started = DispatchTime.now().uptimeNanoseconds
        do {
            _ = try await BoundedProcessRunner.run(
                executable: URL(fileURLWithPath: "/bin/sh"),
                arguments: ["-c", "trap '' TERM; while :; do :; done"],
                timeoutSeconds: 0.12,
                maxOutputBytes: 1_024
            )
            Issue.record("The hung child must time out")
        } catch let error as BoundedProcessRunner.RunnerError {
            #expect(error == .timedOut)
        } catch {
            Issue.record("Expected the bounded timeout error")
        }
        #expect(DispatchTime.now().uptimeNanoseconds - started < 2_000_000_000)
    }

    @Test("task cancellation kills the child and returns promptly")
    func cancellationKillsChild() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("rico-runner-cancel-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let pidURL = root.appendingPathComponent("pid")
        let task = Task {
            try await BoundedProcessRunner.run(
                executable: URL(fileURLWithPath: "/bin/sh"),
                arguments: ["-c", "printf '%d' $$ > \"$1\"; trap '' TERM; while :; do :; done", "runner", pidURL.path],
                timeoutSeconds: 10,
                maxOutputBytes: 1_024
            )
        }
        for _ in 0..<100 where !FileManager.default.fileExists(atPath: pidURL.path) {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        let pidText = try String(contentsOf: pidURL, encoding: .utf8)
        let pid = try #require(pid_t(pidText))
        let started = DispatchTime.now().uptimeNanoseconds
        task.cancel()
        do {
            _ = try await task.value
            Issue.record("A canceled command must not succeed")
        } catch is CancellationError {
            // Expected.
        } catch {
            Issue.record("Cancellation should remain observable to the caller")
        }
        #expect(DispatchTime.now().uptimeNanoseconds - started < 2_000_000_000)
        #expect(Darwin.kill(pid, 0) == -1 && errno == ESRCH)
    }

    @Test("a descendant-held pipe cannot hang normal process completion")
    func inheritedPipeIsBounded() async {
        let started = DispatchTime.now().uptimeNanoseconds
        do {
            _ = try await BoundedProcessRunner.run(
                executable: URL(fileURLWithPath: "/bin/sh"),
                arguments: ["-c", "(sleep 1) & exit 0"],
                timeoutSeconds: 3,
                maxOutputBytes: 1_024
            )
        } catch {
            // A forced local pipe close is an acceptable fail-closed result.
        }
        #expect(DispatchTime.now().uptimeNanoseconds - started < 900_000_000)
    }

    @Test("cancellation releases the shared config lease for the next writer")
    func cancellationReleasesSharedLease() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("rico-config-lease-cancel-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let task = Task {
            try await RicoNativeConfigLease.withLease(in: root) { _ in
                try await BoundedProcessRunner.run(
                    executable: URL(fileURLWithPath: "/bin/sh"),
                    arguments: ["-c", "trap '' TERM; while :; do :; done"],
                    timeoutSeconds: 10,
                    maxOutputBytes: 1_024
                )
            }
        }
        try await Task.sleep(nanoseconds: 80_000_000)
        task.cancel()
        do { _ = try await task.value } catch {}
        let replacement = try await RicoNativeConfigLease.acquire(
            in: root,
            timeoutNanoseconds: 500_000_000
        )
        #expect(replacement.release())
    }
}
