import Foundation

enum MCPTransportKind: String, CaseIterable, Identifiable, Sendable {
    case remote = "Remote server"
    case local = "Local process"

    var id: String { rawValue }
    var symbol: String { self == .remote ? "network" : "terminal" }
}

enum MCPHTTPTransport: String, CaseIterable, Identifiable, Sendable {
    case streamableHTTP = "streamable-http"
    case serverSentEvents = "sse"

    var id: String { rawValue }
    var label: String { self == .streamableHTTP ? "Streamable HTTP" : "Server-sent events" }
}

enum MCPAuthenticationMode: String, CaseIterable, Identifiable, Sendable {
    case none = "No authentication"
    case oauth = "OAuth"
    case bearerEnvironment = "Bearer token from environment"
    case headerEnvironment = "API key from environment"

    var id: String { rawValue }
}

enum MCPActivationMode: String, CaseIterable, Identifiable, Sendable {
    case staged = "Stage disabled"
    case testAndEnable = "Test and enable"

    var id: String { rawValue }
}

enum MCPGovernedActivationPolicy {
    private static let lockedServerNames: Set<String> = [
        "rico-opentable",
        "rico-uber"
    ]

    static func lockReason(for serverName: String) -> String? {
        guard lockedServerNames.contains(serverName) else { return nil }
        return "This governed integration remains disabled until its credential, proof, adapter, and runtime enforcement preflight passes."
    }
}

struct MCPToolFilter: Codable, Equatable, Sendable {
    var include: [String]?
    var exclude: [String]?

    var isEmpty: Bool { (include ?? []).isEmpty && (exclude ?? []).isEmpty }
    var summary: String {
        if let include, !include.isEmpty { return "\(include.count) allowed" }
        if let exclude, !exclude.isEmpty { return "All except \(exclude.count)" }
        return "All tools"
    }
}

struct MCPOAuthStatus: Codable, Equatable, Sendable {
    var hasTokens: Bool?
    var hasClientInformation: Bool?
    var hasCodeVerifier: Bool?
    var hasDiscoveryState: Bool?
    var hasLastAuthorizationUrl: Bool?
}

struct MCPServerRecord: Codable, Identifiable, Equatable, Sendable {
    let name: String
    let configured: Bool
    let enabled: Bool
    let ok: Bool
    let transport: String?
    let launch: String?
    let requestTimeoutMs: Int?
    let connectionTimeoutMs: Int?
    let supportsParallelToolCalls: Bool?
    let toolFilter: MCPToolFilter?
    let auth: String?
    let authStatus: MCPOAuthStatus?

    var id: String { name }
    var isOAuth: Bool { auth == "oauth" }
    var isAuthorized: Bool { isOAuth && authStatus?.hasTokens == true }
    var transportLabel: String {
        switch transport {
        case "streamable-http": "Streamable HTTP"
        case "sse": "Server-sent events"
        case "stdio": "Local process"
        default: transport ?? "Invalid transport"
        }
    }
    var stateLabel: String {
        if !enabled { return "Staged" }
        if !ok { return "Needs attention" }
        if isOAuth && !isAuthorized { return "Needs authorization" }
        return "Configured"
    }
    var safeLaunchSummary: String {
        guard let launch, !launch.isEmpty else { return "Transport is incomplete" }
        if transport == "stdio" {
            let executable = launch.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? "local process"
            return "\(MCPRedactor.redact(executable)) · arguments hidden"
        }
        return MCPRedactor.redactURL(launch)
    }
}

struct MCPStatusEnvelope: Codable, Sendable {
    let path: String
    let servers: [MCPServerRecord]
}

struct MCPDoctorIssue: Codable, Equatable, Identifiable, Sendable {
    let level: String
    let message: String
    var id: String { "\(level):\(message)" }
}

struct MCPDoctorServer: Codable, Equatable, Identifiable, Sendable {
    let name: String
    let ok: Bool
    let issues: [MCPDoctorIssue]
    var id: String { name }
}

struct MCPDoctorEnvelope: Codable, Sendable {
    let path: String
    let ok: Bool
    let servers: [MCPDoctorServer]
}

struct MCPProbeServer: Codable, Equatable, Sendable {
    let launch: String?
    let tools: Int
    let requestTimeoutMs: Int?
    let supportsParallelToolCalls: Bool?
    let filteredTools: Int?
    let resources: Bool?
    let prompts: Bool?
}

struct MCPProbeDiagnostic: Codable, Equatable, Identifiable, Sendable {
    let serverName: String?
    let message: String
    var id: String { "\(serverName ?? "server"):\(message)" }
}

struct MCPProbeEnvelope: Codable, Equatable, Sendable {
    let generatedAt: String?
    let servers: [String: MCPProbeServer]
    let tools: [String]
    let diagnostics: [MCPProbeDiagnostic]

    func tools(for serverName: String) -> [String] {
        let prefixes = ["\(serverName)__", "\(serverName).", "\(serverName)/"]
        let matching = tools.filter { name in prefixes.contains { name.hasPrefix($0) } }
        return matching.isEmpty && servers.count == 1 ? tools : matching
    }
}

struct MCPToolFilterDraft: Equatable, Sendable {
    var include = ""
    var exclude = ""

    init(filter: MCPToolFilter? = nil) {
        include = filter?.include?.joined(separator: ", ") ?? ""
        exclude = filter?.exclude?.joined(separator: ", ") ?? ""
    }

    var includeValues: [String] { Self.csv(include) }
    var excludeValues: [String] { Self.csv(exclude) }
    var isEmpty: Bool { includeValues.isEmpty && excludeValues.isEmpty }
    var validationError: String? {
        if (includeValues + excludeValues).contains(where: { !$0.isValidToolPattern }) {
            return "Tool filters may contain tool-name characters and * globs only."
        }
        return nil
    }

    private static func csv(_ value: String) -> [String] {
        value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
}

struct MCPServerDraft: Equatable, Sendable {
    var name = ""
    var kind: MCPTransportKind = .remote
    var url = ""
    var httpTransport: MCPHTTPTransport = .streamableHTTP
    var authentication: MCPAuthenticationMode = .oauth
    var environmentName = ""
    var headerName = "X-API-Key"
    var oauthScope = ""
    var command = ""
    var arguments = ""
    var workingDirectory = ""
    var environment = ""
    var includeTools = ""
    var excludeTools = ""
    var requestTimeoutSeconds = 60
    var connectionTimeoutSeconds = 30
    var supportsParallelCalls = false
    var activation: MCPActivationMode = .staged

    var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    func validationErrors() -> [String] {
        var errors: [String] = []
        if trimmedName.range(of: #"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"#, options: .regularExpression) == nil {
            errors.append("Use 1–64 letters, numbers, periods, underscores, or hyphens for the server name.")
        }
        if !(1...600).contains(requestTimeoutSeconds) { errors.append("Request timeout must be between 1 and 600 seconds.") }
        if !(1...120).contains(connectionTimeoutSeconds) { errors.append("Connection timeout must be between 1 and 120 seconds.") }
        if Self.csv(includeTools).contains(where: { !$0.isValidToolPattern }) || Self.csv(excludeTools).contains(where: { !$0.isValidToolPattern }) {
            errors.append("Tool filters may contain tool-name characters and * globs only.")
        }

        switch kind {
        case .remote:
            errors.append(contentsOf: validateRemote())
        case .local:
            errors.append(contentsOf: validateLocal())
        }
        return errors
    }

    func addArguments() -> [String] {
        var values = ["mcp", "add", trimmedName]
        switch kind {
        case .remote:
            values += ["--url", url.trimmingCharacters(in: .whitespacesAndNewlines), "--transport", httpTransport.rawValue]
            switch authentication {
            case .none: break
            case .oauth:
                values += ["--auth", "oauth"]
                if !oauthScope.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    values += ["--oauth-scope", oauthScope.trimmingCharacters(in: .whitespacesAndNewlines)]
                }
            case .bearerEnvironment:
                values += ["--header", "Authorization=Bearer \(Self.environmentReference(environmentName))"]
            case .headerEnvironment:
                values += ["--header", "\(headerName.trimmingCharacters(in: .whitespacesAndNewlines))=\(Self.environmentReference(environmentName))"]
            }
        case .local:
            values += ["--command", command.trimmingCharacters(in: .whitespacesAndNewlines)]
            for argument in Self.lines(arguments) { values += ["--arg", argument] }
            for entry in Self.environmentEntries(environment) { values += ["--env", "\(entry.key)=\(entry.value)"] }
            if !workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                values += ["--cwd", workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines)]
            }
        }
        if supportsParallelCalls { values.append("--parallel") }
        values += ["--timeout", String(requestTimeoutSeconds), "--connect-timeout", String(connectionTimeoutSeconds)]
        let include = Self.csv(includeTools)
        let exclude = Self.csv(excludeTools)
        if !include.isEmpty { values += ["--include", include.joined(separator: ",")] }
        if !exclude.isEmpty { values += ["--exclude", exclude.joined(separator: ",")] }
        if activation == .staged { values += ["--disabled", "--no-probe"] }
        return values
    }

    var maskedReview: [(String, String)] {
        var rows: [(String, String)] = [
            ("Name", trimmedName),
            ("Transport", kind == .remote ? httpTransport.label : "Local stdio process"),
            ("Activation", activation.rawValue),
            ("Tool access", MCPToolFilterDraft(filter: MCPToolFilter(include: Self.csv(includeTools), exclude: Self.csv(excludeTools))).isEmpty ? "All server tools" : "Filtered")
        ]
        if kind == .remote {
            rows.append(("Endpoint", MCPRedactor.redactURL(url)))
            rows.append(("Authentication", authentication.rawValue))
            if authentication == .bearerEnvironment || authentication == .headerEnvironment {
                rows.append(("Credential", "Environment reference \(Self.environmentReference(environmentName))"))
            }
        } else {
            rows.append(("Executable", command.trimmingCharacters(in: .whitespacesAndNewlines)))
            rows.append(("Arguments", "\(Self.lines(arguments).count) separate argument(s)"))
            rows.append(("Environment", "\(Self.environmentEntries(environment).count) masked value(s)"))
        }
        rows.append(("Timeouts", "Connect \(connectionTimeoutSeconds)s · Request \(requestTimeoutSeconds)s"))
        return rows
    }

    private func validateRemote() -> [String] {
        var errors: [String] = []
        let raw = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: raw), let scheme = components.scheme?.lowercased(), let host = components.host?.lowercased(), !host.isEmpty else {
            return ["Enter a valid MCP server URL."]
        }
        let loopback = host == "localhost" || host == "127.0.0.1" || host == "::1"
        if scheme != "https" && !(scheme == "http" && loopback) {
            errors.append("Remote MCP servers must use HTTPS. Plain HTTP is allowed only on loopback.")
        }
        if components.user != nil || components.password != nil { errors.append("Credentials cannot be embedded in the server URL.") }
        let sensitiveQuery = components.queryItems?.contains { MCPSecretPolicy.isSensitiveURLParameter($0.name) } == true
        if sensitiveQuery { errors.append("Credentials cannot be stored in URL query parameters.") }
        if authentication == .bearerEnvironment || authentication == .headerEnvironment {
            if !MCPSecretPolicy.isValidEnvironmentName(environmentName) {
                errors.append("Enter an uppercase environment variable name, such as RICO_MCP_TOKEN.")
            }
        }
        if authentication == .headerEnvironment && !MCPSecretPolicy.isValidHeaderName(headerName) {
            errors.append("Enter a valid HTTP header name.")
        }
        return errors
    }

    private func validateLocal() -> [String] {
        var errors: [String] = []
        let executable = command.trimmingCharacters(in: .whitespacesAndNewlines)
        if executable.isEmpty { errors.append("Enter the stdio server executable.") }
        if executable.rangeOfCharacter(from: .whitespacesAndNewlines) != nil || executable.contains(";") || executable.contains("|") || executable.contains("&") {
            errors.append("Enter one executable only. Put each argument on its own line.")
        }
        let cwd = workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cwd.isEmpty && !cwd.hasPrefix("/") { errors.append("The working directory must be an absolute path.") }
        for line in Self.lines(environment) {
            guard let split = line.firstIndex(of: "=") else { errors.append("Environment entries must use KEY=value."); continue }
            let key = String(line[..<split]).trimmingCharacters(in: .whitespaces)
            let value = String(line[line.index(after: split)...]).trimmingCharacters(in: .whitespaces)
            if !MCPSecretPolicy.isValidEnvironmentName(key) { errors.append("Invalid environment variable name: \(key)") }
            if MCPSecretPolicy.isSensitiveName(key) && !MCPSecretPolicy.isEnvironmentReference(value) {
                errors.append("Sensitive value \(key) must use an environment reference such as ${\(key)}.")
            }
        }
        return errors
    }

    static func lines(_ value: String) -> [String] {
        value.split(whereSeparator: \.isNewline).map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    static func csv(_ value: String) -> [String] {
        value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }

    static func environmentEntries(_ value: String) -> [(key: String, value: String)] {
        lines(value).compactMap { line in
            guard let split = line.firstIndex(of: "=") else { return nil }
            return (String(line[..<split]).trimmingCharacters(in: .whitespaces), String(line[line.index(after: split)...]).trimmingCharacters(in: .whitespaces))
        }
    }

    static func environmentReference(_ rawName: String) -> String {
        "${" + rawName.trimmingCharacters(in: .whitespacesAndNewlines) + "}"
    }
}

struct MCPToolCallDraft: Equatable, Sendable {
    let serverName: String
    let toolName: String
    var argumentsJSON = "{}"

    func validatedObject() throws -> [String: Any] {
        let data = Data(argumentsJSON.utf8)
        guard data.count <= 65_536 else { throw MCPIntegrationError.validation("Tool input must be 64 KB or smaller.") }
        guard let object = try? JSONSerialization.jsonObject(with: data), let dictionary = object as? [String: Any] else {
            throw MCPIntegrationError.validation("Tool input must be a valid JSON object.")
        }
        if Self.containsCredentialValue(dictionary) {
            throw MCPIntegrationError.validation("Credentials cannot be placed in tool input. Configure MCP authentication instead so secrets do not enter Rico's transcript.")
        }
        return dictionary
    }

    func maskedArguments() -> String {
        guard let object = try? validatedObject() else { return "Invalid JSON" }
        return MCPRedactor.prettyRedactedJSON(object)
    }

    func ricoInstruction() throws -> String {
        if let reason = MCPGovernedActivationPolicy.lockReason(for: serverName) {
            throw MCPIntegrationError.validation(reason)
        }
        _ = try validatedObject()
        return """
        Use the MCP tool `\(toolName)` from the `\(serverName)` server with exactly this JSON input:
        \(argumentsJSON)

        This tool request was explicitly reviewed in OpenClaw Studio. Do not substitute another tool or broaden the input. If the tool is unavailable or requests additional authority, stop and report that without taking an alternate external action.
        """
    }

    private static func containsCredentialValue(_ value: Any, key: String? = nil) -> Bool {
        if let key, MCPSecretPolicy.isSensitiveName(key) {
            if value is NSNull { return false }
            if let string = value as? String { return !string.isEmpty }
            return true
        }
        if let dictionary = value as? [String: Any] {
            return dictionary.contains { containsCredentialValue($0.value, key: $0.key) }
        }
        if let array = value as? [Any] {
            return array.contains { containsCredentialValue($0) }
        }
        return false
    }
}

enum MCPSecretPolicy {
    static func isSensitiveName(_ value: String) -> Bool {
        let lower = value.lowercased().replacingOccurrences(of: "-", with: "_")
        return ["token", "secret", "password", "passwd", "authorization", "api_key", "apikey", "client_key", "private_key", "credential"].contains { lower.contains($0) }
    }

    static func isSensitiveURLParameter(_ value: String) -> Bool {
        if isSensitiveName(value) { return true }
        let normalized = value.lowercased().replacingOccurrences(of: "-", with: "_")
        return ["state", "code", "code_verifier", "signature", "jwt", "session"].contains(normalized)
    }

    static func isValidEnvironmentName(_ value: String) -> Bool {
        value.trimmingCharacters(in: .whitespacesAndNewlines).range(of: #"^[A-Z][A-Z0-9_]{0,127}$"#, options: .regularExpression) != nil
    }

    static func isEnvironmentReference(_ value: String) -> Bool {
        value.range(of: #"^\$\{[A-Z][A-Z0-9_]{0,127}\}$"#, options: .regularExpression) != nil
    }

    static func isValidHeaderName(_ value: String) -> Bool {
        value.trimmingCharacters(in: .whitespacesAndNewlines).range(of: #"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$"#, options: .regularExpression) != nil
    }
}

enum MCPRedactor {
    static func redact(_ text: String) -> String {
        var result = text
        let patterns: [(String, String)] = [
            (#"(?i)bearer\s+[A-Za-z0-9._~+/=-]+"#, "Bearer [REDACTED]"),
            (#"(?i)(--(?:api[-_]?key|token|secret|password|authorization|code))(?:=|\s+)([^\s]+)"#, "$1 [REDACTED]"),
            (#"(?i)(authorization|x-api-key|api[_-]?key|token|secret|password)(\"?\s*[:=]\s*\"?)([^\",\s}\]]+)"#, "$1$2[REDACTED]"),
            (#"(?i)([?&](?:token|key|api[_-]?key|secret|password|code|state|code_verifier|signature|jwt|session)=)[^&#\s]+"#, "$1[REDACTED]")
        ]
        for (pattern, replacement) in patterns {
            guard let expression = try? NSRegularExpression(pattern: pattern) else { continue }
            result = expression.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: replacement)
        }
        return result
    }

    static func redactURL(_ value: String) -> String {
        guard var components = URLComponents(string: value) else { return redact(value) }
        components.user = components.user == nil ? nil : "•••"
        components.password = components.password == nil ? nil : "•••"
        if let queryItems = components.queryItems, !queryItems.isEmpty {
            components.queryItems = queryItems.map { URLQueryItem(name: $0.name, value: MCPSecretPolicy.isSensitiveURLParameter($0.name) ? "•••" : $0.value) }
        }
        return redact(components.string ?? value)
    }

    static func prettyRedactedJSON(_ object: [String: Any]) -> String {
        let safe = redactJSONObject(object)
        guard let data = try? JSONSerialization.data(withJSONObject: safe, options: [.prettyPrinted, .sortedKeys]) else { return "{ … }" }
        return String(decoding: data, as: UTF8.self)
    }

    private static func redactJSONObject(_ value: Any, key: String? = nil) -> Any {
        if let key, MCPSecretPolicy.isSensitiveName(key) { return "[REDACTED]" }
        if let dictionary = value as? [String: Any] {
            var result: [String: Any] = [:]
            for (name, nested) in dictionary {
                result[name] = redactJSONObject(nested, key: name)
            }
            return result
        }
        if let array = value as? [Any] { return array.map { redactJSONObject($0) } }
        return value
    }
}

enum MCPIntegrationError: LocalizedError, Equatable {
    case unavailable
    case commandFailed(String)
    case invalidResponse
    case timedOut
    case validation(String)

    var errorDescription: String? {
        switch self {
        case .unavailable: "The OpenClaw CLI was not found."
        case .commandFailed(let message): message
        case .invalidResponse: "OpenClaw returned an unreadable MCP response."
        case .timedOut: "The OpenClaw MCP operation timed out."
        case .validation(let message): message
        }
    }
}

private extension String {
    var isValidToolPattern: Bool {
        range(of: #"^[A-Za-z0-9._:/*-]+$"#, options: .regularExpression) != nil
    }
}
