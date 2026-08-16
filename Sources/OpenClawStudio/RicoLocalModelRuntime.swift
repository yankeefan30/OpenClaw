import Foundation

/// Runtime proof for Rico's Studio-managed local model route. OpenClaw's
/// authentication report labels LM Studio "missing" because this loopback
/// provider intentionally has no real credential. Studio therefore proves the
/// local transport directly before treating it as usable.
enum RicoLocalModelRuntime {
    static let provider = "lmstudio"
    static let configuredModel = "lmstudio/qwen/qwen3.6-35b-a3b"
    static let apiModel = "qwen/qwen3.6-35b-a3b"
    static let loadedModelIdentifier = "qwen3.6-35b-a3b-gguf-local"
    static let embeddingModel = "text-embedding-nomic-embed-text-v1.5"
    static let embeddingDimensions = 768
    static let endpoint = "http://127.0.0.1:1234/v1"

    typealias HTTPRunner = @Sendable (_ arguments: [String]) throws -> String

    static func verifiedProviders(
        providerConfiguration: Any,
        serverConfiguration: Any,
        runHTTP: HTTPRunner = runCurl
    ) throws -> Set<String> {
        try validateProviderConfiguration(providerConfiguration)
        try validateServerConfiguration(serverConfiguration)

        let models = try decodeJSON(runHTTP(["--request", "GET", "\(endpoint)/models"]))
        try validateLoadedModels(models)

        let responseBody: [String: Any] = [
            "model": apiModel,
            "input": "Reply with exactly LOCAL_OK.",
            "max_output_tokens": 32,
            "reasoning": ["effort": "none"],
        ]
        let response = try decodeJSON(runHTTP([
            "--request", "POST", "\(endpoint)/responses",
            "--header", "Content-Type: application/json",
            "--data-binary", try jsonString(responseBody),
        ]))
        guard visibleResponseText(response).trimmingCharacters(in: .whitespacesAndNewlines) == "LOCAL_OK" else {
            throw healthError("The local generation canary did not return visible output.")
        }

        let embeddingBody: [String: Any] = [
            "model": embeddingModel,
            "input": "local health check",
        ]
        let embedding = try decodeJSON(runHTTP([
            "--request", "POST", "\(endpoint)/embeddings",
            "--header", "Content-Type: application/json",
            "--data-binary", try jsonString(embeddingBody),
        ]))
        try validateEmbedding(embedding)
        return [provider]
    }

    static func validateProviderConfiguration(_ value: Any) throws {
        guard let config = value as? [String: Any],
              config["baseUrl"] as? String == endpoint,
              config["api"] as? String == "openai-responses",
              config["apiKey"] as? String == "lmstudio-local",
              let models = config["models"] as? [[String: Any]],
              let model = models.first(where: { ($0["id"] as? String) == apiModel }),
              model["reasoning"] as? Bool == false,
              integer(model["contextTokens"]) == 131_072,
              integer(model["maxTokens"]) ?? 0 > 0 else {
            throw healthError("OpenClaw's local model route is not the reviewed loopback configuration.")
        }
    }

    static func validateServerConfiguration(_ value: Any) throws {
        guard let config = value as? [String: Any],
              config["networkInterface"] as? String == "127.0.0.1",
              integer(config["port"]) == 1_234,
              config["cors"] as? Bool == false,
              config["logSensitiveData"] as? Bool == false,
              config["verbose"] as? Bool == false else {
            throw healthError("LM Studio is not using Rico's private loopback and redacted-logging settings.")
        }
    }

    static func validateLoadedModels(_ value: Any) throws {
        guard let root = value as? [String: Any],
              let models = root["data"] as? [[String: Any]] else {
            throw healthError("LM Studio returned unreadable model inventory.")
        }
        let identifiers = Set(models.compactMap { $0["id"] as? String })
        guard identifiers.contains(loadedModelIdentifier),
              identifiers.contains(apiModel),
              identifiers.contains(embeddingModel) else {
            throw healthError("Rico's reviewed local generation and embedding models are not loaded.")
        }
    }

    static func visibleResponseText(_ value: Any) -> String {
        guard let root = value as? [String: Any] else { return "" }
        if let text = root["output_text"] as? String, !text.isEmpty { return text }
        guard let output = root["output"] as? [[String: Any]] else { return "" }
        return output.flatMap { item -> [String] in
            guard let content = item["content"] as? [[String: Any]] else { return [] }
            return content.compactMap { part in
                guard let text = part["text"] as? String else { return nil }
                let type = (part["type"] as? String) ?? "output_text"
                return ["output_text", "text"].contains(type) ? text : nil
            }
        }.joined()
    }

    static func validateEmbedding(_ value: Any) throws {
        guard let root = value as? [String: Any],
              let data = root["data"] as? [[String: Any]],
              data.count == 1,
              let vector = data[0]["embedding"] as? [Any],
              vector.count == embeddingDimensions else {
            throw healthError("The local embedding canary returned an unexpected vector.")
        }
    }

    static func serverConfiguration() throws -> Any {
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".lmstudio/.internal/http-server-config.json")
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular else {
            throw healthError("LM Studio's server configuration is unavailable.")
        }
        let data = try Data(contentsOf: url)
        return try JSONSerialization.jsonObject(with: data)
    }

    static func providerConfiguration(configURL: URL? = nil) throws -> Any {
        let url = configURL ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".openclaw/openclaw.json")
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let permissions = (attributes[.posixPermissions] as? NSNumber)?.intValue
        guard values.isRegularFile == true, values.isSymbolicLink != true, permissions == 0o600 else {
            throw healthError("OpenClaw's private local-provider configuration is unavailable.")
        }
        let data = try Data(contentsOf: url)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let models = root["models"] as? [String: Any],
              let providers = models["providers"] as? [String: Any],
              let provider = providers[Self.provider] as? [String: Any] else {
            throw healthError("OpenClaw's local provider configuration is missing.")
        }
        return provider
    }

    private static func runCurl(_ arguments: [String]) throws -> String {
        let process = Process()
        let output = Pipe()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        process.arguments = [
            "--fail-with-body", "--silent", "--show-error",
            "--connect-timeout", "3", "--max-time", "90",
        ] + arguments
        process.environment = ["PATH": "/usr/bin:/bin"]
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        process.waitUntilExit()
        let stdout = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        guard process.terminationStatus == 0 else {
            throw healthError("The local model runtime did not answer its health probe.")
        }
        return stdout
    }

    private static func decodeJSON(_ text: String) throws -> Any {
        guard let data = text.data(using: .utf8) else { throw healthError("The local model runtime returned unreadable data.") }
        do {
            return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        } catch {
            throw healthError("The local model runtime returned malformed data.")
        }
    }

    private static func jsonString(_ value: Any) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        guard let string = String(data: data, encoding: .utf8) else { throw healthError("Studio could not encode the local health probe.") }
        return string
    }

    private static func integer(_ value: Any?) -> Int? {
        value as? Int ?? (value as? NSNumber)?.intValue
    }

    private static func healthError(_ message: String) -> NSError {
        NSError(domain: "OpenClawStudio.RicoLocalModel", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
