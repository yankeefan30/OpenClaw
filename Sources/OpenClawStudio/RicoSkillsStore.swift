import AppKit
import Foundation

protocol RicoSkillsCommandExecuting: Sendable {
    func execute(command: String, options: [String: String]) async throws -> Data
}

struct RicoSkillsCommandClient: RicoSkillsCommandExecuting, Sendable {
    let libraryRoot: URL

    init(libraryRoot: URL = Self.defaultLibraryRoot) {
        self.libraryRoot = libraryRoot
    }

    static var defaultLibraryRoot: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/OpenClaw Studio/Rico Skills", isDirectory: true)
    }

    func execute(command: String, options: [String: String]) async throws -> Data {
        let request: [String: Any] = [
            "command": command,
            "options": options.merging(["root": libraryRoot.path]) { _, fixedRoot in fixedRoot }
        ]
        let input = try JSONSerialization.data(withJSONObject: request, options: [.sortedKeys])
        let node = try Self.nodeExecutable()
        let module = try Self.runtimeModule()
        return try await Task.detached(priority: .userInitiated) {
            let process = Process()
            process.executableURL = node
            process.arguments = [module.path, "--json-stdin"]
            let standardInput = Pipe()
            let standardOutput = Pipe()
            process.standardInput = standardInput
            process.standardOutput = standardOutput
            // The runtime emits a single sanitized JSON envelope on stdout.
            // Discard raw Node diagnostics so source text can never leak into
            // Studio logs, and drain stdout before waiting to avoid pipe-buffer
            // deadlocks on a larger reviewed inventory.
            process.standardError = FileHandle.nullDevice
            try process.run()
            standardInput.fileHandleForWriting.write(input)
            try standardInput.fileHandleForWriting.close()
            let output = standardOutput.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            if output.isEmpty { throw RicoSkillLibraryError.invalidResponse }
            return output
        }.value
    }

    private static func nodeExecutable() throws -> URL {
        let candidates = [
            "/opt/homebrew/opt/node/bin/node",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node"
        ]
        for candidate in candidates {
            let resolved = URL(fileURLWithPath: candidate).resolvingSymlinksInPath()
            guard FileManager.default.isExecutableFile(atPath: resolved.path),
                  let values = try? resolved.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
                  values.isRegularFile == true,
                  values.isSymbolicLink != true
            else { continue }
            return resolved
        }
        throw RicoSkillLibraryError.runtimeUnavailable
    }

    private static func runtimeModule() throws -> URL {
        let candidates: [(root: URL, module: URL)] = [
            Bundle.main.resourceURL.map {
                let root = $0.appendingPathComponent("RicoSkillsRuntime", isDirectory: true)
                return (root, root.appendingPathComponent("skills-cli.mjs"))
            },
            {
                let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
                    .appendingPathComponent("RicoSkillsRuntime", isDirectory: true)
                return (root, root.appendingPathComponent("skills-cli.mjs"))
            }()
        ].compactMap { $0 }
        for candidate in candidates {
            let root = candidate.root.resolvingSymlinksInPath().standardizedFileURL
            let resolved = candidate.module.resolvingSymlinksInPath().standardizedFileURL
            guard resolved.deletingLastPathComponent() == root,
                  let rootValues = try? root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
                  rootValues.isDirectory == true,
                  rootValues.isSymbolicLink != true,
                  let values = try? resolved.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
                  values.isRegularFile == true,
                  values.isSymbolicLink != true
            else { continue }
            return resolved
        }
        throw RicoSkillLibraryError.runtimeUnavailable
    }
}

@MainActor
final class RicoSkillsStore: ObservableObject {
    @Published private(set) var installed: [RicoInstalledSkill] = []
    @Published private(set) var staged: [RicoStagedSkill] = []
    @Published var selectedSkillID: String?
    @Published var pendingReview: RicoStagedSkill?
    @Published var busy = false
    @Published var notice: String?
    @Published var error: String?

    private let executor: any RicoSkillsCommandExecuting

    init(executor: any RicoSkillsCommandExecuting = RicoSkillsCommandClient()) {
        self.executor = executor
    }

    var selectedSkill: RicoInstalledSkill? {
        installed.first { $0.id == selectedSkillID } ?? installed.first
    }

    func refresh() async {
        await perform {
            let inventory: RicoSkillInventory = try await self.request("inventory")
            self.installed = inventory.installed
            self.staged = inventory.staged
            if let selectedSkillID = self.selectedSkillID,
               !inventory.installed.contains(where: { $0.id == selectedSkillID }) {
                self.selectedSkillID = inventory.installed.first?.id
            } else if self.selectedSkillID == nil {
                self.selectedSkillID = inventory.installed.first?.id
            }
        }
    }

    func stage(url: URL) async {
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values?.isSymbolicLink != true,
              RicoSkillImportSelection.accepts(url: url, isDirectory: values?.isDirectory == true)
        else {
            error = RicoSkillLibraryError.invalidSelection.localizedDescription
            return
        }
        await perform {
            let stage: RicoStagedSkill = try await self.request("stage", options: ["source": url.path])
            self.pendingReview = stage
            self.notice = "Import staged in private quarantine. Nothing is installed or enabled yet."
            await self.reloadInventory()
        }
    }

    func review(_ stage: RicoStagedSkill) async {
        await perform {
            let reviewed: RicoStagedSkill = try await self.request("review", options: ["stage": stage.stagePath])
            self.pendingReview = reviewed
        }
    }

    func install(_ stage: RicoStagedSkill, decision: RicoSkillReviewDecision) async {
        guard decision.permitsInstall(stage), let token = stage.reviewToken else {
            error = RicoSkillLibraryError.reviewRequired.localizedDescription
            return
        }
        await perform {
            let installed: RicoInstalledSkill = try await self.request("install", options: [
                "stage": stage.stagePath,
                "token": token,
                "hash": stage.review.contentHash,
                "approve": "true"
            ])
            self.pendingReview = nil
            self.selectedSkillID = installed.id
            self.notice = "\(installed.name) installed disabled. Enable it separately after reviewing the active version."
            await self.reloadInventory()
        }
    }

    func setEnabled(_ skill: RicoInstalledSkill, enabled: Bool, approved: Bool) async {
        if enabled && !approved {
            error = RicoSkillLibraryError.reviewRequired.localizedDescription
            return
        }
        await perform {
            let _: RicoInstalledSkill = try await self.request("enable", options: [
                "skill": skill.id,
                "enabled": enabled ? "true" : "false",
                "approve": approved ? "true" : "false",
                "acknowledge-non-authorizing": approved ? "true" : "false",
                "hash": skill.contentHash
            ])
            self.notice = enabled ? "\(skill.name) enabled as contextual guidance only." : "\(skill.name) disabled."
            await self.reloadInventory()
        }
    }

    func rollback(_ skill: RicoInstalledSkill, version: RicoSkillVersionRecord, approved: Bool) async {
        guard approved else {
            error = RicoSkillLibraryError.reviewRequired.localizedDescription
            return
        }
        await perform {
            let _: RicoInstalledSkill = try await self.request("rollback", options: [
                "skill": skill.id,
                "version": version.versionID,
                "hash": version.contentHash,
                "approve": "true"
            ])
            self.notice = "\(skill.name) rolled back and left disabled for review."
            await self.reloadInventory()
        }
    }

    private func reloadInventory() async {
        do {
            let inventory: RicoSkillInventory = try await request("inventory")
            installed = inventory.installed
            staged = inventory.staged
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func perform(_ operation: @escaping @MainActor () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        error = nil
        do { try await operation() }
        catch { self.error = error.localizedDescription }
        busy = false
    }

    private func request<Value: Decodable & Sendable>(_ command: String, options: [String: String] = [:]) async throws -> Value {
        let data = try await executor.execute(command: command, options: options)
        let envelope = try JSONDecoder().decode(RicoSkillCLIEnvelope<Value>.self, from: data)
        if let result = envelope.result, envelope.ok { return result }
        if let error = envelope.error {
            throw RicoSkillLibraryError.operationRejected(code: error.code, message: error.message)
        }
        throw RicoSkillLibraryError.invalidResponse
    }
}
