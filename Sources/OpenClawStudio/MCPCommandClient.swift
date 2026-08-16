import Foundation

struct MCPCommandOutput: Sendable {
    let status: Int32
    let stdout: String
    let stderr: String
}

struct MCPOAuthLaunch: Sendable {
    let authorizationURL: URL?
    let message: String
}

struct MCPCommandClient: Sendable {
    private let decoder = JSONDecoder()

    func status() async throws -> MCPStatusEnvelope {
        let output = try await execute(["mcp", "status", "--json"], timeout: 20)
        try requireSuccess(output)
        return try decode(MCPStatusEnvelope.self, output: output)
    }

    func doctor(serverName: String? = nil) async throws -> MCPDoctorEnvelope {
        var arguments = ["mcp", "doctor"]
        if let serverName { arguments.append(serverName) }
        arguments.append("--json")
        let output = try await execute(arguments, timeout: 30)
        // MCP doctor intentionally exits non-zero when it reports an error.
        // Its JSON remains the authoritative diagnostics payload.
        return try decode(MCPDoctorEnvelope.self, output: output)
    }

    func add(_ draft: MCPServerDraft) async throws {
        if let first = draft.validationErrors().first { throw MCPIntegrationError.validation(first) }
        if draft.activation == .testAndEnable,
           let reason = MCPGovernedActivationPolicy.lockReason(for: draft.trimmedName) {
            throw MCPIntegrationError.validation(reason)
        }
        let output = try await execute(draft.addArguments(), timeout: draft.activation == .testAndEnable ? 120 : 30)
        try requireSuccess(output)
        await reloadBestEffort()
    }

    func setEnabled(_ server: MCPServerRecord, enabled: Bool) async throws {
        if enabled, let reason = MCPGovernedActivationPolicy.lockReason(for: server.name) {
            throw MCPIntegrationError.validation(reason)
        }
        var arguments = ["mcp", "configure", server.name, enabled ? "--enable" : "--disable"]
        if enabled && !server.isOAuth { arguments.append("--probe") }
        let output = try await execute(arguments, timeout: enabled ? 120 : 30)
        try requireSuccess(output)
        await reloadBestEffort()
    }

    func updateTools(serverName: String, draft: MCPToolFilterDraft) async throws {
        if let validationError = draft.validationError {
            throw MCPIntegrationError.validation(validationError)
        }
        var arguments = ["mcp", "tools", serverName]
        if draft.isEmpty {
            arguments.append("--clear")
        } else {
            if !draft.includeValues.isEmpty { arguments += ["--include", draft.includeValues.joined(separator: ",")] }
            if !draft.excludeValues.isEmpty { arguments += ["--exclude", draft.excludeValues.joined(separator: ",")] }
        }
        let output = try await execute(arguments, timeout: 30)
        try requireSuccess(output)
        await reloadBestEffort()
    }

    func remove(serverName: String) async throws {
        let output = try await execute(["mcp", "unset", serverName], timeout: 30)
        try requireSuccess(output)
        await reloadBestEffort()
    }

    func probe(serverName: String) async throws -> MCPProbeEnvelope {
        let output = try await execute(["mcp", "probe", serverName, "--json"], timeout: 120)
        try requireSuccess(output)
        return try decode(MCPProbeEnvelope.self, output: output)
    }

    func beginOAuth(serverName: String) async throws -> MCPOAuthLaunch {
        let output = try await execute(["mcp", "login", serverName], timeout: 60)
        try requireSuccess(output)
        let raw = output.stdout + "\n" + output.stderr
        return MCPOAuthLaunch(authorizationURL: Self.firstHTTPURL(in: raw), message: MCPRedactor.redact(raw))
    }

    func finishOAuth(serverName: String, code: String) async throws {
        let value = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { throw MCPIntegrationError.validation("Enter the one-time authorization code.") }
        let output = try await execute(["mcp", "login", serverName, "--code", value], timeout: 90)
        try requireSuccess(output)
        await reloadBestEffort()
    }

    func logout(serverName: String) async throws {
        let output = try await execute(["mcp", "logout", serverName], timeout: 30)
        try requireSuccess(output)
        await reloadBestEffort()
    }

    private func reloadBestEffort() async {
        _ = try? await execute(["mcp", "reload"], timeout: 20)
    }

    private func decode<T: Decodable>(_ type: T.Type, output: MCPCommandOutput) throws -> T {
        guard let data = output.stdout.data(using: .utf8),
              let value = try? decoder.decode(type, from: data) else {
            if output.status != 0 { throw failure(from: output) }
            throw MCPIntegrationError.invalidResponse
        }
        return value
    }

    private func requireSuccess(_ output: MCPCommandOutput) throws {
        if output.status != 0 { throw failure(from: output) }
    }

    private func failure(from output: MCPCommandOutput) -> MCPIntegrationError {
        let message = [output.stderr, output.stdout]
            .map(MCPRedactor.redact)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? "OpenClaw rejected the MCP operation."
        return .commandFailed(String(message.prefix(2_000)))
    }

    private func execute(_ arguments: [String], timeout: TimeInterval) async throws -> MCPCommandOutput {
        try await Task.detached(priority: .userInitiated) {
            guard let executable = Self.openClawExecutable() else { throw MCPIntegrationError.unavailable }
            let fileManager = FileManager.default
            let temporaryDirectory = fileManager.temporaryDirectory
                .appendingPathComponent("openclaw-studio-mcp-\(UUID().uuidString)", isDirectory: true)
            try fileManager.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
            defer { try? fileManager.removeItem(at: temporaryDirectory) }

            let standardOutputURL = temporaryDirectory.appendingPathComponent("stdout")
            let standardErrorURL = temporaryDirectory.appendingPathComponent("stderr")
            guard fileManager.createFile(atPath: standardOutputURL.path, contents: nil),
                  fileManager.createFile(atPath: standardErrorURL.path, contents: nil) else {
                throw MCPIntegrationError.commandFailed("Could not create protected temporary output files.")
            }
            let standardOutput = try FileHandle(forWritingTo: standardOutputURL)
            let standardError = try FileHandle(forWritingTo: standardErrorURL)
            defer {
                try? standardOutput.close()
                try? standardError.close()
            }

            let process = Process()
            process.executableURL = executable
            process.arguments = arguments
            process.currentDirectoryURL = fileManager.homeDirectoryForCurrentUser
            process.standardOutput = standardOutput
            process.standardError = standardError
            var environment = ProcessInfo.processInfo.environment
            let requiredPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            environment["PATH"] = requiredPath + (environment["PATH"].map { ":\($0)" } ?? "")
            process.environment = environment
            try process.run()

            let deadline = Date().addingTimeInterval(timeout)
            while process.isRunning && Date() < deadline {
                if Task.isCancelled {
                    process.terminate()
                    throw CancellationError()
                }
                try await Task.sleep(for: .milliseconds(50))
            }
            if process.isRunning {
                process.terminate()
                let graceDeadline = Date().addingTimeInterval(2)
                while process.isRunning && Date() < graceDeadline {
                    try? await Task.sleep(for: .milliseconds(50))
                }
                throw MCPIntegrationError.timedOut
            }
            process.waitUntilExit()
            try? standardOutput.synchronize()
            try? standardError.synchronize()
            let stdoutData = (try? Data(contentsOf: standardOutputURL, options: .mappedIfSafe)) ?? Data()
            let stderrData = (try? Data(contentsOf: standardErrorURL, options: .mappedIfSafe)) ?? Data()
            let limit = 4 * 1_024 * 1_024
            guard stdoutData.count <= limit, stderrData.count <= limit else {
                throw MCPIntegrationError.commandFailed("OpenClaw returned more MCP output than Studio can safely display.")
            }
            return MCPCommandOutput(
                status: process.terminationStatus,
                stdout: String(decoding: stdoutData, as: UTF8.self),
                stderr: String(decoding: stderrData, as: UTF8.self)
            )
        }.value
    }

    private static func openClawExecutable() -> URL? {
        let fileManager = FileManager.default
        let candidates = [
            "/opt/homebrew/bin/openclaw",
            "/usr/local/bin/openclaw"
        ]
        if let match = candidates.first(where: { fileManager.isExecutableFile(atPath: $0) }) {
            return URL(fileURLWithPath: match)
        }
        for directory in (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":") {
            let candidate = String(directory) + "/openclaw"
            if fileManager.isExecutableFile(atPath: candidate) { return URL(fileURLWithPath: candidate) }
        }
        return nil
    }

    private static func firstHTTPURL(in text: String) -> URL? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        return detector.matches(in: text, range: range)
            .compactMap(\.url)
            .first { $0.scheme == "https" || $0.scheme == "http" }
    }
}

@MainActor
final class MCPIntegrationsModel: ObservableObject {
    @Published private(set) var servers: [MCPServerRecord] = []
    @Published private(set) var doctor: [String: MCPDoctorServer] = [:]
    @Published private(set) var probes: [String: MCPProbeEnvelope] = [:]
    @Published private(set) var loading = false
    @Published private(set) var busyServer: String?
    @Published var notice: String?
    @Published var error: String?

    private let client = MCPCommandClient()

    func refresh() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            async let status = client.status()
            async let diagnostics = client.doctor()
            let (statusValue, doctorValue) = try await (status, diagnostics)
            servers = statusValue.servers.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            doctor = Dictionary(uniqueKeysWithValues: doctorValue.servers.map { ($0.name, $0) })
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func add(_ draft: MCPServerDraft) async throws {
        try await perform(name: draft.trimmedName) { try await client.add(draft) }
        notice = draft.activation == .staged
            ? "\(draft.trimmedName) was staged disabled. Review and enable it when you are ready."
            : "\(draft.trimmedName) passed OpenClaw's connection probe and was saved."
        await refresh()
    }

    func setEnabled(_ server: MCPServerRecord, enabled: Bool) async throws {
        try await perform(name: server.name) { try await client.setEnabled(server, enabled: enabled) }
        notice = enabled ? "\(server.name) was tested and enabled." : "\(server.name) is disabled."
        if !enabled { probes[server.name] = nil }
        await refresh()
    }

    func updateTools(server: MCPServerRecord, draft: MCPToolFilterDraft) async throws {
        try await perform(name: server.name) { try await client.updateTools(serverName: server.name, draft: draft) }
        notice = "Tool access for \(server.name) was updated."
        probes[server.name] = nil
        await refresh()
    }

    func remove(_ server: MCPServerRecord) async throws {
        try await perform(name: server.name) { try await client.remove(serverName: server.name) }
        notice = "\(server.name) was removed."
        probes[server.name] = nil
        await refresh()
    }

    func probe(_ server: MCPServerRecord) async throws {
        try await perform(name: server.name) {
            let result = try await client.probe(serverName: server.name)
            probes[server.name] = result
        }
        await refresh()
        let count = probes[server.name]?.tools(for: server.name).count ?? 0
        notice = "\(server.name) responded with \(count) available tool\(count == 1 ? "" : "s")."
    }

    func beginOAuth(_ server: MCPServerRecord) async throws -> MCPOAuthLaunch {
        var launch: MCPOAuthLaunch?
        try await perform(name: server.name) { launch = try await client.beginOAuth(serverName: server.name) }
        guard let launch else { throw MCPIntegrationError.invalidResponse }
        return launch
    }

    func finishOAuth(_ server: MCPServerRecord, code: String) async throws {
        try await perform(name: server.name) { try await client.finishOAuth(serverName: server.name, code: code) }
        notice = "\(server.name) is authorized."
        await refresh()
    }

    func logout(_ server: MCPServerRecord) async throws {
        try await perform(name: server.name) { try await client.logout(serverName: server.name) }
        notice = "Stored OAuth credentials for \(server.name) were cleared."
        await refresh()
    }

    private func perform(name: String, operation: () async throws -> Void) async throws {
        busyServer = name
        error = nil
        defer { busyServer = nil }
        do { try await operation() }
        catch {
            self.error = error.localizedDescription
            throw error
        }
    }
}
