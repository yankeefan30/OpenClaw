import Foundation
import Testing
@testable import OpenClawStudio

struct MCPIntegrationTests {
    @Test
    func governedMobilityServersRemainActivationLocked() {
        #expect(MCPGovernedActivationPolicy.lockReason(for: "rico-opentable") != nil)
        #expect(MCPGovernedActivationPolicy.lockReason(for: "rico-uber") != nil)
        #expect(MCPGovernedActivationPolicy.lockReason(for: "RICO-UBER") == nil)
        #expect(MCPGovernedActivationPolicy.lockReason(for: "docs") == nil)
    }

    @Test
    func governedMobilityToolRequestsRemainBlocked() {
        let draft = MCPToolCallDraft(
            serverName: "rico-uber",
            toolName: "uber_status",
            argumentsJSON: "{}"
        )
        #expect(throws: MCPIntegrationError.self) {
            _ = try draft.ricoInstruction()
        }
    }

    @Test
    func remoteValidationRequiresTLSAwayFromLoopback() {
        var draft = MCPServerDraft()
        draft.name = "remote"
        draft.authentication = .none
        draft.url = "http://example.com/mcp"
        #expect(draft.validationErrors().contains { $0.contains("must use HTTPS") })

        draft.url = "http://127.0.0.1:4310/mcp"
        #expect(draft.validationErrors().isEmpty)
    }

    @Test
    func remoteValidationRejectsURLCredentialsAndSensitiveQueries() {
        var draft = MCPServerDraft()
        draft.name = "remote"
        draft.authentication = .none
        draft.url = "https://user:pass@example.com/mcp?token=visible"
        let errors = draft.validationErrors()
        #expect(errors.contains { $0.contains("embedded") })
        #expect(errors.contains { $0.contains("query") })
    }

    @Test
    func addCommandUsesRealOpenClawFlagsAndStagesByDefault() {
        var draft = MCPServerDraft()
        draft.name = "calendar"
        draft.url = "https://mcp.example.com/v1"
        draft.authentication = .bearerEnvironment
        draft.environmentName = "CALENDAR_MCP_TOKEN"
        draft.includeTools = "events_list,events_create"
        let arguments = draft.addArguments()

        #expect(arguments.prefix(3) == ["mcp", "add", "calendar"])
        #expect(arguments.contains("--transport"))
        #expect(arguments.contains("streamable-http"))
        #expect(arguments.contains("Authorization=Bearer $" + "{CALENDAR_MCP_TOKEN}"))
        #expect(arguments.contains("--disabled"))
        #expect(arguments.contains("--no-probe"))
        #expect(!arguments.contains(where: { $0.contains("actual-secret") }))
    }

    @Test
    func localSensitiveEnvironmentRequiresReference() {
        var draft = MCPServerDraft()
        draft.name = "local"
        draft.kind = .local
        draft.command = "uvx"
        draft.environment = "API_TOKEN=plaintext"
        #expect(draft.validationErrors().contains { $0.contains("must use an environment reference") })

        draft.environment = "API_TOKEN=$" + "{API_TOKEN}\nLOG_LEVEL=info"
        #expect(draft.validationErrors().isEmpty)
    }

    @Test
    func statusPayloadDecodesWithoutRawConfiguration() throws {
        let data = Data("""
        {
          "path": "/tmp/openclaw.json",
          "servers": [{
            "name": "docs",
            "configured": true,
            "enabled": true,
            "ok": true,
            "transport": "streamable-http",
            "launch": "https://mcp.example.com/mcp",
            "requestTimeoutMs": 60000,
            "connectionTimeoutMs": 30000,
            "supportsParallelToolCalls": false,
            "toolFilter": {"include": ["search"]},
            "auth": "oauth",
            "authStatus": {"hasTokens": true}
          }]
        }
        """.utf8)
        let decoded = try JSONDecoder().decode(MCPStatusEnvelope.self, from: data)
        #expect(decoded.servers.count == 1)
        #expect(decoded.servers[0].stateLabel == "Configured")
        #expect(decoded.servers[0].toolFilter?.summary == "1 allowed")
    }

    @Test
    func probePayloadListsOnlySelectedServerTools() throws {
        let data = Data("""
        {
          "generatedAt": "2026-08-14T00:00:00Z",
          "servers": {
            "docs": {"launch": "https://example.com", "tools": 2},
            "other": {"launch": "stdio", "tools": 1}
          },
          "tools": ["docs__search", "docs__read", "other__write"],
          "diagnostics": []
        }
        """.utf8)
        let decoded = try JSONDecoder().decode(MCPProbeEnvelope.self, from: data)
        #expect(decoded.tools(for: "docs") == ["docs__search", "docs__read"])
    }

    @Test
    func redactionMasksHeadersURLsAndNestedJSON() {
        let text = "Authorization: Bearer abc123 https://example.com/mcp?token=secret&state=csrf-value"
        let redacted = MCPRedactor.redact(text)
        #expect(!redacted.contains("abc123"))
        #expect(!redacted.contains("secret"))
        #expect(!redacted.contains("csrf-value"))

        let json = MCPRedactor.prettyRedactedJSON([
            "query": "safe",
            "nested": ["api_key": "do-not-show", "limit": 10]
        ])
        #expect(json.contains("safe"))
        #expect(json.contains("[REDACTED]"))
        #expect(!json.contains("do-not-show"))
    }

    @Test
    func localLaunchSummaryNeverDisplaysArguments() {
        let server = MCPServerRecord(
            name: "local",
            configured: true,
            enabled: true,
            ok: true,
            transport: "stdio",
            launch: "node server.js --token never-show",
            requestTimeoutMs: nil,
            connectionTimeoutMs: nil,
            supportsParallelToolCalls: nil,
            toolFilter: nil,
            auth: nil,
            authStatus: nil
        )
        #expect(server.safeLaunchSummary == "node · arguments hidden")
        #expect(!server.safeLaunchSummary.contains("never-show"))
    }

    @Test
    func toolCallRejectsCredentialsBeforeTranscript() {
        let draft = MCPToolCallDraft(
            serverName: "docs",
            toolName: "docs__search",
            argumentsJSON: #"{"query":"hello","api_key":"never-log"}"#
        )
        #expect(throws: MCPIntegrationError.self) {
            _ = try draft.validatedObject()
        }
    }

    @Test
    func toolFiltersRejectShellLikeGarbageEvenThoughNoShellIsUsed() {
        var draft = MCPToolFilterDraft()
        draft.include = "search, delete;whoami"
        #expect(draft.validationError != nil)
        draft.include = "*read*,search_*"
        #expect(draft.validationError == nil)
    }
}
