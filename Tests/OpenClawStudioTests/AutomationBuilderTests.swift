import Foundation
import Testing
@testable import OpenClawStudio

@Suite("Natural-language automation builder")
struct AutomationBuilderTests {
    @Test("Parses a fenced proposal from the documented raw model JSON envelope")
    func parsesAgentEnvelope() throws {
        let proposalText = """
        ```json
        {
          "name": "Weekday morning brief",
          "description": "Review the calendar and prepare a short brief.",
          "enabled": false,
          "agentId": "main",
          "schedule": {"kind":"cron","expr":"0 8 * * 1-5","tz":"America/New_York"},
          "sessionTarget": "isolated",
          "wakeMode": "now",
          "payload": {"kind":"agentTurn","message":"Review today's calendar and prepare a five-line brief."},
          "delivery": {"mode":"none"}
        }
        ```
        """
        let envelope: [String: Any] = [
            "ok": true,
            "capability": "model.run",
            "transport": "gateway",
            "outputs": [["text": proposalText, "mediaUrl": NSNull()]],
        ]
        let data = try JSONSerialization.data(withJSONObject: envelope)

        let proposal = try AutomationProposalParser.parseAgentEnvelope(data, agentID: "main")

        #expect(proposal.name == "Weekday morning brief")
        #expect(proposal.agentID == "main")
        #expect(proposal.schedule == .cron(expression: "0 8 * * 1-5", timezone: "America/New_York"))
        #expect(proposal.delivery == .none)
        #expect(proposal.declarationKey.hasPrefix("openclaw-studio."))
    }

    @Test("Rejects unsupported model-authored fields instead of inventing a fallback")
    func rejectsUnsupportedFields() {
        let text = """
        {
          "name":"Unsafe",
          "description":"Unsupported command",
          "schedule":{"kind":"cron","expr":"0 8 * * *","tz":"America/New_York"},
          "sessionTarget":"isolated",
          "wakeMode":"now",
          "payload":{"kind":"agentTurn","message":"Do work"},
          "delivery":{"mode":"none"},
          "command":"rm -rf something"
        }
        """

        #expect(throws: AutomationProposalError.self) {
            try AutomationProposalParser.parseProposalText(text, agentID: "main")
        }
    }

    @Test("Rejects non-agent payloads")
    func rejectsCommandPayload() {
        let text = """
        {
          "name":"Command",
          "description":"Unsupported command",
          "schedule":{"kind":"every","everyMs":60000},
          "sessionTarget":"isolated",
          "wakeMode":"now",
          "payload":{"kind":"command","message":"do work"},
          "delivery":{"mode":"none"}
        }
        """

        #expect(throws: AutomationProposalError.self) {
            try AutomationProposalParser.parseProposalText(text, agentID: "main")
        }
    }

    @Test("Builds canonical cron add arguments and defaults to disabled")
    func buildsDisabledCreationArguments() {
        let proposal = fixtureProposal()
        let arguments = AutomationOpenClawService.creationArguments(for: proposal, enabled: false)

        #expect(arguments.starts(with: ["cron", "add"]))
        #expect(option("--name", in: arguments) == "Weekday brief")
        #expect(option("--cron", in: arguments) == "0 8 * * 1-5")
        #expect(option("--tz", in: arguments) == "America/New_York")
        #expect(option("--session", in: arguments) == "isolated")
        #expect(arguments.contains("--no-deliver"))
        #expect(arguments.contains("--disabled"))
        #expect(arguments.contains("--json"))
    }

    @Test("Activation is sent only after the explicit enabled choice")
    func enabledArgumentsDoNotCarryDisabledFlag() {
        let arguments = AutomationOpenClawService.creationArguments(for: fixtureProposal(), enabled: true)
        #expect(!arguments.contains("--disabled"))
    }

    @Test("Gateway preview contains only CronAddParams fields")
    func rendersExactGatewayParameters() throws {
        let proposal = fixtureProposal()
        let parameters = proposal.gatewayParameters(enabled: false)
        let expectedKeys: Set<String> = [
            "name", "declarationKey", "description", "enabled", "agentId",
            "schedule", "sessionTarget", "wakeMode", "payload", "delivery",
        ]

        #expect(Set(parameters.keys) == expectedKeys)
        #expect(parameters["enabled"] as? Bool == false)
        #expect((parameters["payload"] as? [String: Any])?["kind"] as? String == "agentTurn")
        #expect((parameters["schedule"] as? [String: Any])?["kind"] as? String == "cron")
        #expect(JSONSerialization.isValidJSONObject(parameters))
    }

    @Test("Computes the next weekday cron run in its IANA timezone")
    func computesNextCronRun() throws {
        let formatter = ISO8601DateFormatter()
        let start = try #require(formatter.date(from: "2026-08-14T12:00:00Z"))
        let expected = try #require(formatter.date(from: "2026-08-14T13:00:00Z"))

        let next = AutomationCronPreview.nextRun(
            expression: "0 9 * * 1-5",
            timezone: "America/New_York",
            after: start
        )

        #expect(next == expected)
    }

    @Test("Planner prompt forbids creation and command payloads")
    func plannerPromptKeepsProposalBoundary() {
        let prompt = AutomationOpenClawService.plannerPrompt(
            request: "Every morning make a brief",
            timezone: "America/New_York"
        )
        #expect(prompt.contains("Propose a schedule only"))
        #expect(prompt.contains("Do not execute"))
        #expect(prompt.contains("Never propose a command payload"))
        #expect(prompt.contains("\"enabled\": false"))
        #expect(prompt.contains("America/New_York"))
        #expect(prompt.contains("Every morning make a brief"))
        #expect(!prompt.contains("(timezone)"))
        #expect(!prompt.contains("(request)"))
    }

    @Test("Planner uses OpenClaw's tool-free raw model Gateway surface")
    func plannerUsesRawToolFreeInference() {
        let arguments = AutomationOpenClawService.plannerArguments(prompt: "proposal")
        #expect(arguments.starts(with: ["infer", "model", "run"]))
        #expect(arguments.contains("--gateway"))
        #expect(option("--prompt", in: arguments) == "proposal")
        #expect(!arguments.contains("agent"))
        #expect(!arguments.contains("--session-key"))
        #expect(!arguments.contains("--message"))
    }

    private func fixtureProposal() -> AutomationProposal {
        AutomationProposal(
            declarationKey: "openclaw-studio.test-key",
            name: "Weekday brief",
            description: "Prepare a weekday brief.",
            agentID: "main",
            schedule: .cron(expression: "0 8 * * 1-5", timezone: "America/New_York"),
            action: "Review today's calendar and prepare a brief.",
            delivery: .none,
            sessionTarget: "isolated",
            wakeMode: "now"
        )
    }

    private func option(_ name: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }
}
