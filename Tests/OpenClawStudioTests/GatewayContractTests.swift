import Foundation
import Testing
@testable import OpenClawStudio

@Suite("Installed Gateway contract regressions")
struct GatewayContractTests {
    @Test("Approval decisions use OpenClaw's canonical values")
    func approvalDecisionValues() {
        #expect(ApprovalDecision.approve.rawValue == "allow-once")
        #expect(ApprovalDecision.reject.rawValue == "deny")
    }

    @Test("History rows without message IDs keep a stable derived identity")
    func stableHistoryIdentity() throws {
        let row: [String: Any] = [
            "role": "assistant",
            "timestamp": 1_786_700_000_000 as Double,
            "content": [["type": "text", "text": "Finished"]]
        ]
        let first = try #require(TranscriptItem(row))
        let second = try #require(TranscriptItem(row))
        #expect(first.id == second.id)
        #expect(first.id.hasPrefix("derived-"))

        var later = row
        later["timestamp"] = 1_786_700_000_001 as Double
        #expect(TranscriptItem(later)?.id != first.id)
    }

    @Test("Cron list rows decode the nested installed schema")
    func cronNestedShape() throws {
        let row: [String: Any] = [
            "id": "job-1",
            "name": "Morning brief",
            "enabled": false,
            "schedule": [
                "kind": "cron",
                "expr": "0 8 * * 1-5",
                "tz": "America/New_York"
            ],
            "state": [
                "nextRunAtMs": 1_786_700_000_000 as Double,
                "lastRunAtMs": 1_786_600_000_000 as Double
            ]
        ]
        let job = try #require(CronJobRecord(row))
        #expect(job.schedule == "0 8 * * 1-5")
        #expect(job.timezone == "America/New_York")
        #expect(job.enabled == false)
        #expect(job.nextRun != nil)
        #expect(job.lastRun != nil)
    }

    @Test("Interval schedules render a human readable cadence")
    func intervalSchedule() throws {
        let job = try #require(CronJobRecord([
            "id": "job-2",
            "name": "Pulse",
            "enabled": true,
            "schedule": ["kind": "every", "everyMs": 3_600_000]
        ]))
        #expect(job.schedule == "Every 1 hour")
    }

    @Test("Top-level array payloads remain available to list decoders")
    func topLevelArrayPayload() {
        let raw: [[String: Any]] = [["id": "approval-1"]]
        let payload = GatewayContract.normalizedPayload(raw)
        let rows = GatewayContract.rows(in: payload, preferredKeys: ["approvals"])

        #expect(rows.count == 1)
        #expect(rows.first?["id"] as? String == "approval-1")
    }

    @Test("Approval records decode the nested installed request schema")
    func nestedApprovalRequest() throws {
        let record = try #require(ApprovalRecord([
            "id": "exec-1",
            "request": [
                "command": "rm -rf /tmp/openclaw-test",
                "cwd": "/tmp",
                "host": "node",
                "nodeId": "mac-mini",
                "security": "full",
                "agentId": "main",
                "sessionKey": "agent:main:main"
            ],
            "createdAtMs": 1_786_700_000_000 as Double,
            "expiresAtMs": 1_786_700_060_000 as Double
        ], kind: "exec"))

        #expect(record.kind == "exec")
        #expect(record.agent == "main")
        #expect(record.session == "agent:main:main")
        #expect(record.operation == "rm -rf /tmp/openclaw-test")
        #expect(record.node == "mac-mini")
        #expect(record.risk == "full")
        #expect(record.expires != nil)
        #expect(record.destructive)
    }

    @Test("Plugin approvals use nested title and metadata")
    func nestedPluginApprovalRequest() throws {
        let record = try #require(ApprovalRecord([
            "id": "plugin-1",
            "request": [
                "title": "Publish customer update",
                "description": "Send the reviewed release notice",
                "severity": "high",
                "pluginId": "messaging",
                "agentId": "rico",
                "sessionKey": "agent:rico:main"
            ],
            "createdAtMs": 1_786_700_000_000 as Double,
            "expiresAtMs": 1_786_700_060_000 as Double
        ], kind: "plugin"))

        #expect(record.operation == "Publish customer update")
        #expect(record.arguments == "Send the reviewed release notice")
        #expect(record.node == "messaging")
        #expect(record.risk == "high")
    }

    @Test("Cron run history accepts the installed entries envelope")
    func cronRunEntriesEnvelope() throws {
        let payload: [String: Any] = [
            "entries": [[
                "runId": "run-1",
                "jobId": "job-1",
                "status": "completed",
                "startedAtMs": 1_786_700_000_000 as Double,
                "finishedAtMs": 1_786_700_001_000 as Double
            ]]
        ]
        let runs = GatewayContract.rows(in: payload, preferredKeys: ["entries", "runs"])
            .compactMap(CronRunRecord.init)

        #expect(runs.count == 1)
        #expect(runs.first?.id == "run-1")
        #expect(runs.first?.state == "completed")
    }

    @Test("Task cancellation omits the unsupported requestId")
    func taskCancelParameters() {
        let params = GatewayContract.taskCancelParameters(id: "task-1", reason: "Operator cancelled")

        #expect(params["taskId"] as? String == "task-1")
        #expect(params["reason"] as? String == "Operator cancelled")
        #expect(params["requestId"] == nil)
    }

    @Test("Agent mutation payloads and scopes match the installed Gateway")
    func agentMutationContracts() {
        let create = GatewayContract.agentCreateParameters(
            name: "Research Agent",
            workspace: "/tmp/research-agent",
            model: "openai/gpt-5"
        )
        let delete = GatewayContract.agentDeleteParameters(id: "research-agent")

        #expect(create["agentId"] == nil)
        #expect(create["name"] as? String == "Research Agent")
        #expect(delete["agentId"] as? String == "research-agent")
        #expect(delete["deleteFiles"] as? Bool == false)
        #expect(GatewayContract.scopes(for: "agents.create") == ["operator.admin"])
        #expect(GatewayContract.scopes(for: "agents.update") == ["operator.admin"])
        #expect(GatewayContract.scopes(for: "agents.delete") == ["operator.admin"])
        #expect(GatewayContract.scopes(for: "agents.list") == ["operator.read"])
        #expect(GatewayContract.scopes(for: "sessions.reset") == ["operator.admin"])
    }

    @Test("Session enumeration uses the installed offset contract")
    func sessionOffsetContract() {
        let params = GatewayContract.sessionListParameters(limit: 500, offset: 200)
        #expect(params["limit"] as? Int == 200)
        #expect(params["offset"] as? Int == 200)
        #expect(params["cursor"] == nil)
        #expect(params["archived"] == nil)
        #expect(GatewayContract.sessionListParameters(limit: 200, offset: nil, archived: true)["archived"] as? Bool == true)
        #expect(GatewayContract.sessionNextOffset(["hasMore": true, "nextOffset": 400]) == 400)
        #expect(GatewayContract.sessionNextOffset(["hasMore": false, "nextOffset": 400]) == nil)
    }

    @Test("Autonomy governor reads and mutations request distinct authority")
    func autonomyGovernorScopes() {
        #expect(GatewayContract.scopes(for: "rico.autonomy.status") == ["operator.read"])
        #expect(GatewayContract.scopes(for: "rico.autonomy.missions.list") == ["operator.read"])
        #expect(GatewayContract.scopes(for: "rico.autonomy.events.list") == ["operator.read"])
        #expect(GatewayContract.scopes(for: "rico.autonomy.evaluate") == ["operator.read"])
        #expect(GatewayContract.scopes(for: "rico.autonomy.missions.upsert") == ["operator.admin"])
        #expect(GatewayContract.scopes(for: "rico.autonomy.missions.activate") == ["operator.admin"])
        #expect(GatewayContract.scopes(for: "rico.autonomy.missions.advance") == ["operator.admin"])
        #expect(GatewayContract.scopes(for: "rico.autonomy.global.pause") == ["operator.admin"])
    }

    @Test("Gateway repair uses the supported service installer without a shell")
    func gatewayRepairContract() {
        #expect(GatewayServiceRepair.arguments(port: 18_789) == [
            "gateway", "install", "--force", "--port", "18789", "--json"
        ])
    }
}
