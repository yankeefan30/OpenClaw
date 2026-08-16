import Foundation
import Testing
@testable import OpenClawStudio

@Suite("Rico local model runtime")
struct RicoLocalModelRuntimeTests {
    @Test("Exact private LM Studio route passes generation and embedding canaries")
    func healthyRuntime() throws {
        let providers = try RicoLocalModelRuntime.verifiedProviders(
            providerConfiguration: providerConfiguration(),
            serverConfiguration: serverConfiguration(),
            runHTTP: fixtureHTTP
        )
        #expect(providers == ["lmstudio"])
    }

    @Test("Sensitive or verbose local logging fails closed")
    func unsafeLoggingRejected() {
        var unsafe = serverConfiguration()
        unsafe["logSensitiveData"] = true
        #expect(throws: (any Error).self) {
            try RicoLocalModelRuntime.validateServerConfiguration(unsafe)
        }
        unsafe = serverConfiguration()
        unsafe["verbose"] = true
        #expect(throws: (any Error).self) {
            try RicoLocalModelRuntime.validateServerConfiguration(unsafe)
        }
    }

    @Test("Local provider still requires exact loaded generation and embedding models")
    func exactInventoryRequired() {
        let incomplete: [String: Any] = [
            "data": [["id": RicoLocalModelRuntime.apiModel]],
        ]
        #expect(throws: (any Error).self) {
            try RicoLocalModelRuntime.validateLoadedModels(incomplete)
        }
    }

    @Test("Private OpenClaw config exposes the exact local marker without CLI redaction")
    func privateProviderConfiguration() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("rico-local-provider-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: root) }
        let value: [String: Any] = [
            "models": ["providers": ["lmstudio": providerConfiguration()]],
        ]
        try JSONSerialization.data(withJSONObject: value).write(to: root, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: root.path)
        let loaded = try #require(try RicoLocalModelRuntime.providerConfiguration(configURL: root) as? [String: Any])
        #expect(loaded["apiKey"] as? String == "lmstudio-local")
    }

    @Test("Verified loopback provider overrides cloud-auth missing marker only for LM Studio")
    func localProviderAdmittedAfterRuntimeProof() throws {
        let defaults: [String: Any] = [
            "primary": RicoLocalModelRuntime.configuredModel,
            "fallbacks": ["openai/gpt-5.6-sol"],
        ]
        let status: [String: Any] = [
            "allowed": [RicoLocalModelRuntime.configuredModel, "openai/gpt-5.6-sol"],
            "auth": [
                "missingProvidersInUse": ["lmstudio"],
                "providers": [
                    ["provider": "lmstudio", "effective": ["kind": "missing"]],
                    ["provider": "openai", "effective": ["kind": "profiles"], "profiles": ["count": 1]],
                ],
            ],
        ]
        let route = try RicoNativePolicyProjection.verifiedSharedModelRoute(
            defaultsModel: defaults,
            modelsStatus: status,
            usableLocalProviders: ["lmstudio"]
        )
        #expect(route.primary == RicoLocalModelRuntime.configuredModel)
        #expect(route.fallbacks == ["openai/gpt-5.6-sol"])
    }

    @Test("Final route readback rejects a stale local-health proof")
    func readbackRequiresFreshLocalProof() throws {
        let route = RicoNativePolicyProjection.SharedModelRoute(
            primary: RicoLocalModelRuntime.configuredModel,
            fallbacks: ["openai/gpt-5.6-sol"]
        )
        let status: [String: Any] = [
            "defaultModel": route.primary,
            "fallbacks": route.fallbacks,
            "allowed": [route.primary] + route.fallbacks,
            "auth": [
                "missingProvidersInUse": ["lmstudio"],
                "providers": [
                    ["provider": "lmstudio", "effective": ["kind": "missing"]],
                    ["provider": "openai", "effective": ["kind": "profiles"], "profiles": ["count": 1]],
                ],
            ],
        ]
        try RicoNativePolicyProjection.validateSharedModelStatus(
            status,
            expected: route,
            usableLocalProviders: ["lmstudio"]
        )
        #expect(throws: (any Error).self) {
            try RicoNativePolicyProjection.validateSharedModelStatus(status, expected: route)
        }
    }

    private func providerConfiguration() -> [String: Any] {
        [
            "baseUrl": RicoLocalModelRuntime.endpoint,
            "apiKey": "lmstudio-local",
            "api": "openai-responses",
            "models": [[
                "id": RicoLocalModelRuntime.apiModel,
                "reasoning": false,
                "contextTokens": 131_072,
                "maxTokens": 8_192,
            ]],
        ]
    }

    private func serverConfiguration() -> [String: Any] {
        [
            "networkInterface": "127.0.0.1",
            "port": 1_234,
            "cors": false,
            "logSensitiveData": false,
            "verbose": false,
        ]
    }

    private func fixtureHTTP(_ arguments: [String]) throws -> String {
        let joined = arguments.joined(separator: " ")
        if joined.contains("/models") {
            return #"{"data":[{"id":"qwen3.6-35b-a3b-gguf-local"},{"id":"qwen/qwen3.6-35b-a3b"},{"id":"text-embedding-nomic-embed-text-v1.5"}]}"#
        }
        if joined.contains("/responses") {
            return #"{"output":[{"content":[{"type":"output_text","text":"LOCAL_OK"}]}]}"#
        }
        if joined.contains("/embeddings") {
            let vector = Array(repeating: 0.0, count: RicoLocalModelRuntime.embeddingDimensions)
            let data = try JSONSerialization.data(withJSONObject: ["data": [["embedding": vector]]])
            return String(decoding: data, as: UTF8.self)
        }
        throw NSError(domain: "fixture", code: 1)
    }
}
