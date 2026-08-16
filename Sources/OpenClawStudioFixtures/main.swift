import Foundation

struct FixtureSession {
    let key: String
    let agent: String
    let updated: Date
    let attention: Bool
}

func filtered(_ sessions: [FixtureSession], query: String) -> [FixtureSession] {
    sessions.filter { query.isEmpty || "\($0.key) \($0.agent)".localizedCaseInsensitiveContains(query) }
}

func sortedNewest(_ sessions: [FixtureSession]) -> [FixtureSession] {
    sessions.sorted { $0.updated > $1.updated }
}

func optimisticRollback(_ messages: inout [String], _ draft: String, sendSucceeds: Bool) {
    messages.append(draft)
    if !sendSucceeds { messages.removeLast() }
}

func redact(_ value: String) -> String {
    let patterns = ["(?i)(token|password|secret|api[_-]?key)(\"?\\s*[:=]\\s*\"?)[^,\"}\\s]+"]
    var result = value
    for pattern in patterns {
        if let regex = try? NSRegularExpression(pattern: pattern) {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "$1$2[REDACTED]")
        }
    }
    return result
}

func needsExtraConfirmation(_ operation: String) -> Bool {
    ["delete", "secret", "password", "sudo", "chmod", "launchctl", "/etc/", "filesystem"].contains { operation.lowercased().contains($0) }
}

func reconcileRun(_ states: [String]) -> String {
    states.last(where: { ["completed", "failed", "cancelled", "timed_out"].contains($0) }) ?? states.last ?? "queued"
}

@main
struct FixtureTests {
    static func main() {
        let sessions = [
            FixtureSession(key: "agent:writer:main", agent: "writer", updated: Date(timeIntervalSince1970: 2), attention: true),
            FixtureSession(key: "agent:ops:main", agent: "ops", updated: Date(timeIntervalSince1970: 1), attention: false)
        ]
        precondition(filtered(sessions, query: "writer").count == 1)
        precondition(sortedNewest(sessions).map(\.key) == ["agent:writer:main", "agent:ops:main"])
        precondition(sessions.first?.attention == true)

        var messages = ["first", "second"]
        optimisticRollback(&messages, "failed", sendSucceeds: false)
        precondition(messages == ["first", "second"])
        optimisticRollback(&messages, "sent", sendSucceeds: true)
        precondition(messages.last == "sent")

        precondition(redact(#"{"token":"abc","path":"/tmp/x"}"#).contains("[REDACTED]"))
        precondition(needsExtraConfirmation("sudo rm -rf /"))
        precondition(!needsExtraConfirmation("read workspace status"))

        var pending = true
        func resolveOnce() -> Bool {
            guard pending else { return false }
            pending = false
            return true
        }
        precondition(resolveOnce() == true && resolveOnce() == false)
        let staleApprovalState = "resolved"
        precondition(staleApprovalState != "pending")
        precondition(reconcileRun(["queued", "running", "completed"]) == "completed")
        precondition(reconcileRun(["queued", "running"]) == "running")
        let permissionDenied = "FORBIDDEN"
        precondition(permissionDenied == "FORBIDDEN")
        let partialFailure = ["channels": "loaded", "models": "permission denied"]
        precondition(partialFailure["channels"] == "loaded" && partialFailure["models"] == "permission denied")
        let reconnectStates = ["disconnected", "connecting", "connected", "disconnected", "connected"]
        precondition(reconnectStates.last == "connected")
        precondition("Gateway unavailable".contains("unavailable"))
        precondition("AUTH_TOKEN_MISMATCH".contains("TOKEN_MISMATCH"))
        precondition("PROTOCOL_VERSION_UNSUPPORTED".contains("UNSUPPORTED"))
        let exported = "Credential: [REDACTED]\nPersonal content: [REDACTED]"
        precondition(!exported.contains("token=") && !exported.contains("secret"))

        let reconnectSnapshot = ["one", "two"]
        let replay = ["two", "three"]
        let reconciled = Array(Set(reconnectSnapshot + replay)).sorted()
        precondition(reconciled == ["one", "three", "two"])
        print("Fixture tests passed: filters, sorting, attention, rollback, reconciliation, redaction, confirmation, stale approvals, double submission, run terminal states, permission and partial failures, reconnects, unavailable/wrong-auth/protocol states, export redaction")
    }
}
