import Foundation
import Testing
@testable import OpenClawStudio

@Suite("Rico messaging security boundary")
struct MessagingSecurityTests {
    @Test("Policy and one-time grants use private permissions and message hashes")
    func secureFiles() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("rico-security-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let identity = RicoRecipientPolicy(
            id: "contact:+15550000002", contactID: "contact", displayName: "Contact",
            address: "+15550000002", access: .approved, requireMention: true,
            autoReply: true, quietStart: 22, quietEnd: 8, groupChatID: nil
        )
        try RicoRecipientGuard.writePolicy(policies: [identity], paused: true, in: root)
        let grant = try RicoRecipientGuard.authorizeOwnerSend(target: identity.address, message: "do not store this plaintext", in: root)

        #expect(permissions(root) == 0o700)
        #expect(permissions(root.appendingPathComponent("rico-recipient-guard.json")) == 0o600)
        #expect(permissions(root.appendingPathComponent("rico-owner-command-route.json")) == 0o600)
        #expect(permissions(root.appendingPathComponent("owner-send-grants")) == 0o700)
        #expect(permissions(grant) == 0o600)

        let grantText = try String(contentsOf: grant, encoding: .utf8)
        #expect(!grantText.contains("do not store this plaintext"))
        #expect(grantText.contains(RicoRecipientGuard.sha256("do not store this plaintext")))
        let policy = try json(root.appendingPathComponent("rico-recipient-guard.json"))
        #expect(policy["schemaVersion"] as? Int == 2)
        #expect(policy["paused"] as? Bool == true)
        let identities = try #require(policy["identities"] as? [[String: Any]])
        #expect(identities.first?["displayName"] as? String == "Contact")
        #expect(RicoRecipientGuard.readPausedState(in: root) == true)
    }

    @Test("Unreadable or missing guard state never implies unpaused messaging")
    func guardPauseReadbackFailsClosed() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("rico-missing-guard-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        #expect(RicoRecipientGuard.readPausedState(in: root) == nil)

        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let policy = root.appendingPathComponent("rico-recipient-guard.json")
        try Data(#"{"schemaVersion":2,"paused":false,"identities":[]}"#.utf8).write(to: policy)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: policy.path)
        #expect(RicoRecipientGuard.readPausedState(in: root) == false)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: policy.path)
        #expect(RicoRecipientGuard.readPausedState(in: root) == nil)
    }

    @Test("Owner command routing persists only exact owners and approved groups")
    func ownerCommandRoutePolicy() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("rico-owner-route-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let owner = RicoRecipientPolicy(
            id: "owner", contactID: "owner", displayName: "Owner", address: "+1 (555) 000-0001",
            access: .owner, requireMention: true, autoReply: true,
            quietStart: 0, quietEnd: 0, groupChatID: nil
        )
        let group = RicoRecipientPolicy(
            id: "group:42", contactID: "", displayName: "Family", address: "chat_id:42",
            access: .approved, requireMention: true, autoReply: true,
            quietStart: 22, quietEnd: 8, groupChatID: "42",
            participantAddresses: ["+15550000002"]
        )

        try RicoRecipientGuard.writePolicy(policies: [owner, group], paused: false, in: root)
        let route = try json(root.appendingPathComponent("rico-owner-command-route.json"))
        #expect(route["schemaVersion"] as? Int == 1)
        #expect(route["enabled"] as? Bool == true)
        #expect(route["ownerHandles"] as? [String] == ["+15550000001"])
        #expect(route["allowedGroupChatIds"] as? [Int] == [42])
        #expect((route["notBeforeMs"] as? NSNumber)?.doubleValue ?? 0 > 0)
    }

    @Test("A private legacy owner route migrates exactly one address to Alan")
    func ownerIdentityMigration() throws {
        let existing = RicoRecipientPolicy(
            id: "contact", contactID: "contact", displayName: "Stale display name", address: "+1 (555) 000-0001",
            access: .approved, requireMention: false, autoReply: false,
            quietStart: 22, quietEnd: 8, groupChatID: nil
        )
        let migrated = RicoOwnerIdentityMigration.apply(to: [existing], ownerHandles: ["+15550000001"])
        let owner = try #require(migrated.first)
        #expect(owner.displayName == "Alan Rosa")
        #expect(owner.access == .owner)
        #expect(!owner.requireMention)
        #expect(owner.autoReply)
        #expect(owner.quietStart == owner.quietEnd)

        #expect(RicoOwnerIdentityMigration.apply(to: [existing], ownerHandles: []).first?.access == .approved)
        #expect(RicoOwnerIdentityMigration.apply(to: [existing], ownerHandles: ["+15550000001", "+15550000009"]).first?.access == .approved)
        #expect(RicoOwnerIdentityMigration.apply(to: [existing], ownerHandles: ["not-an-address"]).first?.access == .approved)
    }

    @Test("Generic contact controls can never promote a new owner")
    func ownerAccessIsNotGenericContactAccess() {
        #expect(!RicoOwnerAccessPolicy.canAssign(.owner, current: nil))
        #expect(!RicoOwnerAccessPolicy.canAssign(.owner, current: .approved))
        #expect(RicoOwnerAccessPolicy.canAssign(.owner, current: .owner))
        #expect(RicoOwnerAccessPolicy.canAssign(.approved, current: .owner))
    }

    @Test("Group participants are persisted and projected into native sender admission")
    func groupParticipants() throws {
        let group = RicoRecipientPolicy(
            id: "group:42", contactID: "", displayName: "Family", address: "chat_id:42",
            access: .approved, requireMention: true, autoReply: true,
            quietStart: 22, quietEnd: 8, groupChatID: "42",
            participantAddresses: ["(555) 000-0002", "PERSON@example.com"]
        )
        let plan = RicoNativePolicyProjection.plan(policies: [group], paused: false)
        #expect(plan.groupPolicy == "allowlist")
        #expect(plan.groups["42"]?["requireMention"] == true)
        #expect(plan.groupAllowFrom.contains("+15550000002"))
        #expect(plan.groupAllowFrom.contains("person@example.com"))
        #expect(!plan.groupAllowFrom.contains("chat_id:42"))
    }

    @Test("Contacts names are display-only, exact, and ambiguous handles are omitted")
    func contactNameProjection() {
        let addresses = ["+15550000002", "PERSON@example.com"]
        let unique = [
            LocalContact(id: "janet", name: "Janet\nCummings", phones: ["(555) 000-0002"], emails: []),
            LocalContact(id: "person", name: "Person Example", phones: [], emails: ["person@example.com"]),
        ]
        #expect(RicoContactDirectory.displayNames(for: addresses, contacts: unique) == [
            "+15550000002": "Janet Cummings",
            "person@example.com": "Person Example",
        ])

        let ambiguous = unique + [
            LocalContact(id: "shared", name: "Shared Number", phones: ["5550000002"], emails: []),
        ]
        #expect(RicoContactDirectory.displayNames(for: addresses, contacts: ambiguous)["+15550000002"] == nil)
    }

    @Test("Only names for exact approved group handles enter the private sidecar")
    func groupNameSidecar() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("rico-names-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let group = RicoRecipientPolicy(
            id: "group:42", contactID: "", displayName: "Family", address: "chat_id:42",
            access: .approved, requireMention: true, autoReply: true,
            quietStart: 22, quietEnd: 8, groupChatID: "42",
            participantAddresses: ["+15550000002"],
            participantNames: ["+15550000002": "Janet Cummings", "+15550000003": "Not approved"]
        )
        try RicoRecipientGuard.writePolicy(policies: [group], paused: false, in: root)
        let policy = try json(root.appendingPathComponent("rico-recipient-guard.json"))
        let identities = try #require(policy["identities"] as? [[String: Any]])
        let names = try #require(identities.first?["participantNames"] as? [String: String])
        #expect(names == ["+15550000002": "Janet Cummings"])
    }

    @Test("Any reviewed group membership change requires explicit review")
    func membershipChangeSuspendsGroup() {
        let approved = ["+15550000002", "person@example.com"]
        #expect(!RicoGroupMembership.requiresReview(approved: approved, discovered: ["PERSON@example.com", "+1 (555) 000-0002"]))
        #expect(RicoGroupMembership.requiresReview(approved: approved, discovered: approved + ["+15550000003"]))
        #expect(RicoGroupMembership.requiresReview(approved: approved, discovered: ["+15550000002"]))
    }

    @Test("An approved group without verified participants stays disabled")
    func groupWithoutParticipantsFailsClosed() {
        let group = RicoRecipientPolicy(
            id: "group:42", contactID: "", displayName: "Family", address: "chat_id:42",
            access: .approved, requireMention: true, autoReply: true,
            quietStart: 22, quietEnd: 8, groupChatID: "42",
            participantAddresses: []
        )
        let plan = RicoNativePolicyProjection.plan(policies: [group], paused: false)
        #expect(plan.groupPolicy == "disabled")
        #expect(plan.groupAllowFrom.isEmpty)
    }

    @Test("A suspended group is absent even when another group remains active")
    func suspendedGroupIsNotProjectedBesideActiveGroup() {
        let active = RicoRecipientPolicy(
            id: "group:42", contactID: "", displayName: "Active", address: "chat_id:42",
            access: .approved, requireMention: true, autoReply: true,
            quietStart: 22, quietEnd: 8, groupChatID: "42",
            participantAddresses: ["+15550000002"]
        )
        let suspended = RicoRecipientPolicy(
            id: "group:43", contactID: "", displayName: "Needs review", address: "chat_id:43",
            access: .approved, requireMention: true, autoReply: true,
            quietStart: 22, quietEnd: 8, groupChatID: "43",
            participantAddresses: []
        )
        let plan = RicoNativePolicyProjection.plan(policies: [active, suspended], paused: false)
        #expect(plan.groupPolicy == "allowlist")
        #expect(Set(plan.groups.keys) == Set(["42"]))
        #expect(plan.groupAllowFrom == ["+15550000002"])
    }

    @Test("An explicit owner is admitted only alongside an approved group")
    func ownerGroupAdmission() {
        let owner = RicoRecipientPolicy(
            id: "owner", contactID: "owner", displayName: "Owner", address: "+15550000001",
            access: .owner, requireMention: true, autoReply: true,
            quietStart: 0, quietEnd: 0, groupChatID: nil
        )
        let group = RicoRecipientPolicy(
            id: "group:42", contactID: "", displayName: "Family", address: "chat_id:42",
            access: .approved, requireMention: true, autoReply: true,
            quietStart: 22, quietEnd: 8, groupChatID: "42",
            participantAddresses: ["+15550000002"]
        )

        let plan = RicoNativePolicyProjection.plan(policies: [owner, group], paused: false)
        #expect(plan.groupPolicy == "allowlist")
        #expect(plan.groupAllowFrom == ["+15550000001", "+15550000002"])
        #expect(plan.ownerAllowFrom == ["imessage:+15550000001"])

        let ownerWithoutGroup = RicoNativePolicyProjection.plan(policies: [owner], paused: false)
        #expect(ownerWithoutGroup.groupPolicy == "disabled")
        #expect(ownerWithoutGroup.groups.isEmpty)
        #expect(ownerWithoutGroup.ownerAllowFrom == ["imessage:+15550000001"])
    }

    @Test("Pause disables both native DM and group admission")
    func pausedProjection() {
        let identity = RicoRecipientPolicy(
            id: "owner", contactID: "owner", displayName: "Owner", address: "+15550000001",
            access: .owner, requireMention: false, autoReply: true,
            quietStart: 0, quietEnd: 0, groupChatID: nil
        )
        let plan = RicoNativePolicyProjection.plan(policies: [identity], paused: true)
        #expect(plan.dmPolicy == "disabled")
        #expect(plan.groupPolicy == "disabled")
        #expect(plan.allowFrom.isEmpty)
        #expect(plan.groupAllowFrom.isEmpty)
    }

    @Test("Healthy unpaused projection registers iMessage and rejects a disabled read-back")
    func activeProjectionRequiresRegisteredIMessageChannel() throws {
        let owner = RicoRecipientPolicy(
            id: "owner", contactID: "owner", displayName: "Owner", address: "+15550000001",
            access: .owner, requireMention: true, autoReply: true,
            quietStart: 0, quietEnd: 0, groupChatID: nil
        )

        let active = RicoNativePolicyProjection.plan(policies: [owner], paused: false)
        #expect(active.channelEnabled)
        try RicoNativePolicyProjection.validateIMessageChannelRegistration(
            ["enabled": true], expectedEnabled: active.channelEnabled
        )
        #expect(throws: (any Error).self) {
            try RicoNativePolicyProjection.validateIMessageChannelRegistration(
                ["enabled": false], expectedEnabled: active.channelEnabled
            )
        }

        let paused = RicoNativePolicyProjection.plan(policies: [owner], paused: true)
        #expect(!paused.channelEnabled)
        try RicoNativePolicyProjection.validateIMessageChannelRegistration(
            ["enabled": false], expectedEnabled: paused.channelEnabled
        )
        #expect(throws: (any Error).self) {
            try RicoNativePolicyProjection.validateIMessageChannelRegistration(
                ["enabled": true], expectedEnabled: paused.channelEnabled
            )
        }
    }

    @Test("Duplicate exact individual addresses are excluded from native admission")
    func duplicateDirectIdentityFailsClosed() {
        let approved = RicoRecipientPolicy(
            id: "one", contactID: "one", displayName: "One", address: "+15550000002",
            access: .approved, requireMention: true, autoReply: true,
            quietStart: 0, quietEnd: 0, groupChatID: nil
        )
        var blocked = approved
        blocked.id = "two"
        blocked.contactID = "two"
        blocked.displayName = "Two"
        blocked.access = .blocked
        for policies in [[approved, blocked], [blocked, approved]] {
            let plan = RicoNativePolicyProjection.plan(policies: policies, paused: false)
            #expect(plan.dmPolicy == "disabled")
            #expect(plan.allowFrom.isEmpty)
        }
    }

    @Test("Approved non-owner DMs receive an exact native deny-all tool policy")
    func sharedDirectToolBoundary() {
        let contact = RicoRecipientPolicy(
            id: "contact", contactID: "contact", displayName: "Contact", address: "+15550000002",
            access: .approved, requireMention: true, autoReply: true,
            quietStart: 0, quietEnd: 0, groupChatID: nil
        )
        let plan = RicoNativePolicyProjection.plan(policies: [contact], paused: false)
        #expect(plan.sharedToolDenySenders == ["+15550000002"])
        #expect(plan.ownerAllowFrom.isEmpty)
        let directPolicy = RicoNativePolicyProjection.denyAllToolPolicy()
        #expect(directPolicy["deny"] as? [String] == ["*"])
        #expect(directPolicy["allow"] == nil)

        let groupPolicy = RicoNativePolicyProjection.managedGroupConfiguration(
            existing: ["systemPrompt": "preserved"],
            requireMention: true
        )
        #expect(groupPolicy["systemPrompt"] as? String == "preserved")
        #expect(groupPolicy["requireMention"] as? Bool == true)
        #expect((groupPolicy["tools"] as? [String: Any])?["deny"] as? [String] == ["*"])
        #expect(((groupPolicy["toolsBySender"] as? [String: Any])?["*"] as? [String: Any])?["deny"] as? [String] == ["*"])
    }

    @Test("Shared audiences receive only escalation and one exact owner can also use governed email")
    func exactSharedEscalationAndOwnerEmailToolBoundary() throws {
        let group = RicoNativePolicyProjection.managedGroupConfiguration(
            existing: ["systemPrompt": "preserved"],
            requireMention: true,
            ownerHandles: ["+1 (555) 000-0001"]
        )
        #expect((group["tools"] as? [String: Any])?["allow"] as? [String] == RicoNativePolicyProjection.sharedToolNames)
        let bySender = try #require(group["toolsBySender"] as? [String: Any])
        #expect((bySender["*"] as? [String: Any])?["allow"] as? [String] == [RicoNativePolicyProjection.escalationToolName])
        #expect((bySender["*"] as? [String: Any])?["deny"] == nil)
        #expect((bySender["channel:imessage:+15550000001"] as? [String: Any])?["allow"] as? [String] == RicoNativePolicyProjection.sharedToolNames)

        let ambiguous = RicoNativePolicyProjection.managedGroupConfiguration(
            existing: [:], requireMention: true,
            ownerHandles: ["+15550000001", "+15550000002"]
        )
        #expect((ambiguous["tools"] as? [String: Any])?["deny"] as? [String] == ["*"])

        let agents = RicoNativePolicyProjection.configuredAgents(
            existing: [], mainWorkspace: "/private/main", sharedWorkspace: "/private/shared",
            ownerHandles: ["+15550000001"]
        )
        let shared = try #require(agents.last)
        let tools = try #require(shared["tools"] as? [String: Any])
        #expect(tools["allow"] as? [String] == RicoNativePolicyProjection.sharedToolNames)
        #expect(tools["deny"] == nil)
        let agentBySender = try #require(tools["toolsBySender"] as? [String: Any])
        #expect((agentBySender["*"] as? [String: Any])?["allow"] as? [String] == [RicoNativePolicyProjection.escalationToolName])
        #expect((agentBySender["channel:imessage:+15550000001"] as? [String: Any])?["allow"] as? [String] == RicoNativePolicyProjection.sharedToolNames)
    }

    @Test("Rico-managed iMessage identities cannot be collapsed through session identity links")
    func managedIdentityLinksFailClosed() {
        let managed: Set<String> = ["+15550000002", "person@example.com"]
        #expect(RicoNativePolicyProjection.requiredDMScope == "per-account-channel-peer")
        #expect(!RicoNativePolicyProjection.identityLinksTouchManagedIMessageHandles(
            ["someone": ["discord:123", "telegram:456"]], managedHandles: managed
        ))
        #expect(RicoNativePolicyProjection.identityLinksTouchManagedIMessageHandles(
            ["janet": ["imessage:+1 (555) 000-0002"]], managedHandles: managed
        ))
        #expect(RicoNativePolicyProjection.identityLinksTouchManagedIMessageHandles(
            ["person@example.com": ["discord:123"]], managedHandles: managed
        ))
    }

    @Test("Command ownership removes global and stale iMessage principals")
    func exactCommandOwnerProjection() {
        let merged = RicoNativePolicyProjection.exactIMessageCommandOwners(
            existing: ["+15550000009", "imessage:+15550000008", "telegram:123", "discord:456"],
            reviewedOwners: ["imessage:+15550000001"]
        )
        #expect(merged == ["discord:456", "imessage:+15550000001", "telegram:123"])
    }

    @Test("Shared iMessage audiences route only to a public deny-all agent")
    func sharedAudienceRouting() throws {
        let agents = RicoNativePolicyProjection.configuredAgents(
            existing: [], mainWorkspace: "/private/main", sharedWorkspace: "/private/shared"
        )
        #expect(agents.map { $0["id"] as? String } == ["main", "rico-shared"])
        let shared = try #require(agents.last)
        #expect(shared["workspace"] as? String == "/private/shared")
        #expect((shared["skills"] as? [String])?.isEmpty == true)
        #expect(((shared["tools"] as? [String: Any])?["deny"] as? [String]) == ["*"])

        let existing: [[String: Any]] = [
            ["agentId": "private", "match": ["channel": "imessage", "peer": ["kind": "direct", "id": "+15550000002"]], "session": ["dmScope": "main"]],
            ["agentId": "old-shared", "match": ["channel": "imessage", "peer": ["kind": "group", "id": "chat_id:41"]]],
            ["agentId": "rico-shared", "match": ["channel": "imessage", "peer": ["kind": "group", "id": "chat_id:40"]]],
            ["agentId": "other", "match": ["channel": "telegram", "peer": ["kind": "direct", "id": "123"]]],
        ]
        let targets: Set<String> = ["direct:+15550000002", "group:42"]
        let bindings = RicoNativePolicyProjection.configuredSharedBindings(
            existing: existing,
            activeTargets: targets,
            managedTargets: targets.union(["group:chat_id:41", "group:chat_id:40"])
        )
        #expect(bindings.count == 3)
        #expect(bindings.contains { (($0["match"] as? [String: Any])?["channel"] as? String) == "telegram" })
        for target in targets {
            let binding = try #require(bindings.first { RicoNativePolicyProjection.bindingTargetKey($0) == target })
            #expect(binding["agentId"] as? String == "rico-shared")
            #expect(((binding["session"] as? [String: Any])?["dmScope"] as? String) == RicoNativePolicyProjection.requiredDMScope)
        }
        #expect(!bindings.contains { RicoNativePolicyProjection.bindingTargetKey($0) == "group:41" })
        let group = try #require(bindings.first { RicoNativePolicyProjection.bindingTargetKey($0) == "group:42" })
        let groupPeer = try #require((group["match"] as? [String: Any])?["peer"] as? [String: Any])
        #expect(groupPeer["id"] as? String == "42")
        #expect(RicoNativePolicyProjection.canonicalSharedBindingTarget("group:chat_id:42") == "group:42")
    }

    @Test("Shared Rico route skips an unavailable default and preserves verified fallback order")
    func sharedModelRouteUsesVerifiedDefaultCandidates() throws {
        let defaults: [String: Any] = [
            "primary": "lmstudio/local-model",
            "fallbacks": ["opus", "openai/gpt-5.6-sol", "anthropic/claude-opus-4-8"],
        ]
        let status: [String: Any] = [
            "allowed": [
                "lmstudio/local-model",
                "anthropic/claude-opus-4-8",
                "openai/gpt-5.6-sol",
            ],
            "aliases": ["opus": "anthropic/claude-opus-4-8"],
            "auth": [
                "missingProvidersInUse": ["lmstudio"],
                "providers": [
                    ["provider": "lmstudio", "effective": ["kind": "missing"], "profiles": ["count": 0]],
                    ["provider": "anthropic", "effective": ["kind": "profiles"], "profiles": ["count": 1]],
                    ["provider": "openai", "effective": ["kind": "profiles"], "profiles": ["count": 1]],
                ],
                "runtimeAuthRoutes": [
                    ["provider": "openai", "status": "usable"],
                ],
                "oauth": [
                    "providers": [
                        ["provider": "anthropic", "status": "static"],
                        ["provider": "openai", "status": "ok"],
                    ],
                ],
            ],
        ]

        let route = try RicoNativePolicyProjection.verifiedSharedModelRoute(
            defaultsModel: defaults,
            modelsStatus: status
        )
        #expect(route.primary == "anthropic/claude-opus-4-8")
        #expect(route.fallbacks == ["openai/gpt-5.6-sol"])
    }

    @Test("Studio's active Rico projection is pinned to the exact local model without fallbacks")
    func strictLocalSharedModelRoute() throws {
        let status: [String: Any] = [
            "allowed": [
                RicoNativePolicyProjection.requiredSharedLocalModel,
                "anthropic/claude-opus-4-8",
            ],
        ]
        let route = try RicoNativePolicyProjection.verifiedStrictLocalSharedModelRoute(
            modelsStatus: status,
            usableLocalProviders: ["lmstudio", "anthropic"]
        )
        #expect(route.primary == RicoNativePolicyProjection.requiredSharedLocalModel)
        #expect(route.fallbacks.isEmpty)

        var rejected = false
        do {
            _ = try RicoNativePolicyProjection.verifiedStrictLocalSharedModelRoute(
                modelsStatus: status,
                usableLocalProviders: ["anthropic"]
            )
        } catch {
            rejected = true
        }
        #expect(rejected)
    }

    @Test("Studio replaces every stale Rico model pin with the verified managed route")
    func sharedAgentModelPinIsReconciled() throws {
        let route = RicoNativePolicyProjection.SharedModelRoute(
            primary: "anthropic/claude-opus-4-8",
            fallbacks: ["openai/gpt-5.6-sol"]
        )
        let existing: [[String: Any]] = [
            ["id": "main", "default": true, "workspace": "/private/main"],
            [
                "id": "rico-shared",
                "workspace": "/private/shared",
                "model": ["primary": "lmstudio/unavailable", "fallbacks": []],
            ],
        ]
        let agents = RicoNativePolicyProjection.configuredAgents(
            existing: existing,
            mainWorkspace: "/private/main",
            sharedWorkspace: "/private/shared",
            modelRoute: route
        )
        let shared = try #require(agents.first { ($0["id"] as? String) == "rico-shared" })
        let model = try #require(shared["model"] as? [String: Any])
        #expect(model["primary"] as? String == "anthropic/claude-opus-4-8")
        #expect(model["fallbacks"] as? [String] == ["openai/gpt-5.6-sol"])

        let pausedAgents = RicoNativePolicyProjection.configuredAgents(
            existing: existing,
            mainWorkspace: "/private/main",
            sharedWorkspace: "/private/shared"
        )
        let pausedShared = try #require(pausedAgents.first { ($0["id"] as? String) == "rico-shared" })
        #expect(pausedShared["model"] == nil)
    }

    @Test("Rico model routing fails closed when no configured provider is usable")
    func sharedModelRouteFailsClosed() {
        let defaults: [String: Any] = [
            "primary": "lmstudio/local-model",
            "fallbacks": ["openai/gpt-5.6-sol"],
        ]
        let status: [String: Any] = [
            "allowed": ["lmstudio/local-model", "openai/gpt-5.6-sol"],
            "auth": [
                "missingProvidersInUse": ["lmstudio", "openai"],
                "providers": [
                    ["provider": "lmstudio", "effective": ["kind": "missing"]],
                    ["provider": "openai", "effective": ["kind": "missing"]],
                ],
            ],
        ]
        var rejected = false
        do {
            _ = try RicoNativePolicyProjection.verifiedSharedModelRoute(
                defaultsModel: defaults,
                modelsStatus: status
            )
        } catch {
            rejected = true
        }
        #expect(rejected)
    }

    @Test("Rico model status read-back must match the verified route exactly")
    func sharedModelStatusReadback() throws {
        let route = RicoNativePolicyProjection.SharedModelRoute(
            primary: "anthropic/claude-opus-4-8",
            fallbacks: ["openai/gpt-5.6-sol"]
        )
        let status: [String: Any] = [
            "defaultModel": route.primary,
            "fallbacks": route.fallbacks,
            "allowed": [route.primary] + route.fallbacks,
            "auth": [
                "providers": [
                    ["provider": "anthropic", "effective": ["kind": "profiles"], "profiles": ["count": 1]],
                    ["provider": "openai", "effective": ["kind": "profiles"], "profiles": ["count": 1]],
                ],
            ],
        ]
        try RicoNativePolicyProjection.validateSharedModelStatus(status, expected: route)

        var rejected = false
        do {
            var changed = status
            changed["fallbacks"] = []
            try RicoNativePolicyProjection.validateSharedModelStatus(changed, expected: route)
        } catch {
            rejected = true
        }
        #expect(rejected)
    }

    @Test("Managed shared workspace contains public-only private files")
    func sharedWorkspaceFiles() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("rico-shared-workspace-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        #expect(try RicoSharedWorkspace.ensureInstalled(in: root) == root.path)
        #expect(permissions(root) == 0o700)
        for name in ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"] {
            let file = root.appendingPathComponent(name)
            #expect(permissions(file) == 0o600)
            let text = try String(contentsOf: file, encoding: .utf8)
            #expect(!text.localizedCaseInsensitiveContains("password"))
            #expect(!text.localizedCaseInsensitiveContains("email address"))
        }
        let agents = try String(contentsOf: root.appendingPathComponent("AGENTS.md"), encoding: .utf8)
        #expect(agents.contains("load and follow `ESCALATION.md`"))
        #expect(agents.contains("The only permitted tool is the guard-gated `rico_stuck_question_escalate`"))
        #expect(agents.contains("No other tools, external actions, commitments, or cross-channel sends are permitted here."))
        #expect(!agents.contains("rico_group_email_execute"))
    }

    @Test("Owner route installs as an exact private imsg executable")
    func ownerRouteInstaller() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("rico-owner-route-install-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let source = root.appendingPathComponent("source.mjs")
        let destination = root.appendingPathComponent("bin/imsg")
        try Data("#!/opt/homebrew/bin/node\nconsole.log('ok')\n".utf8).write(to: source)
        try await RicoOwnerRouteInstaller.install(source: source, destination: destination)
        #expect(destination.lastPathComponent == "imsg")
        #expect(permissions(destination) == 0o700)
        #expect(try Data(contentsOf: source) == Data(contentsOf: destination))
    }

    @Test("Reviewed sends use the Gateway transport with stable idempotency")
    func reviewedSendGatewayContract() {
        let draftID = UUID(uuidString: "6C76D9F8-82F9-40CD-9691-645601BBAEAC")!
        let first = IMessageCommand.gatewaySendParameters(
            to: "chat_id:42",
            text: "Opening line",
            idempotencyKey: draftID
        )
        let retry = IMessageCommand.gatewaySendParameters(
            to: "chat_id:42",
            text: "Opening line",
            idempotencyKey: draftID
        )

        #expect(first["channel"] as? String == "imessage")
        #expect(first["to"] as? String == "chat_id:42")
        #expect(first["message"] as? String == "Opening line")
        #expect(first["idempotencyKey"] as? String == "rico-studio-6c76d9f8-82f9-40cd-9691-645601bbaeac")
        #expect((first as NSDictionary).isEqual(to: retry))
        #expect(GatewayContract.scopes(for: "send") == ["operator.write"])
    }

    @Test("Group session reset matches only one exact iMessage group key")
    func exactGroupSessionResetMatch() {
        #expect(RicoIMessageSessionReset.matchesGroupSession("agent:main:imessage:group:42", groupID: "42"))
        #expect(RicoIMessageSessionReset.matchesGroupSession("agent:rico-shared:imessage:group:42:thread:1", groupID: "42"))
        #expect(!RicoIMessageSessionReset.matchesGroupSession("agent:main:imessage:group:142", groupID: "42"))
        #expect(!RicoIMessageSessionReset.matchesGroupSession("agent:main:imessage:direct:42", groupID: "42"))
        #expect(!RicoIMessageSessionReset.matchesGroupSession("agent:main:imessage:group:42", groupID: ""))
    }

    @Test("Studio accepts only the exact live recipient-guard contract")
    func liveGuardContractValidation() throws {
        let status: [String: Any] = [
            "version": RicoNativePolicyProjection.requiredGuardVersion,
            "contractVersion": RicoNativePolicyProjection.requiredGuardContract,
            "healthy": true,
            "paused": false,
            "policySchema": 2,
            "hooks": Array(RicoNativePolicyProjection.requiredGuardHooks),
            "tools": Array(RicoNativePolicyProjection.requiredGuardTools),
            "escalation": [
                "toolName": RicoNativePolicyProjection.escalationToolName,
                "pluginConfigured": true,
                "originAuthorityHealthy": true,
            ],
            "hookPermissions": [
                "allowConversationAccess": true,
                "allowPromptInjection": true,
            ],
            "enforcement": [
                "verified": true,
                "authority": "gateway",
                "contractVersion": RicoNativePolicyProjection.requiredGuardContract,
            ],
        ]
        try RicoNativePolicyProjection.validateGuardStatus(status, paused: false)

        var stale = status
        stale["version"] = "0.2.0"
        var rejectedStale = false
        do { try RicoNativePolicyProjection.validateGuardStatus(stale, paused: false) }
        catch { rejectedStale = true }
        #expect(rejectedStale)

        var missingHook = status
        missingHook["hooks"] = ["message_sending"]
        var rejectedMissingHook = false
        do { try RicoNativePolicyProjection.validateGuardStatus(missingHook, paused: false) }
        catch { rejectedMissingHook = true }
        #expect(rejectedMissingHook)

        var stalePermissions = status
        stalePermissions["hookPermissions"] = [
            "allowConversationAccess": false,
            "allowPromptInjection": true,
        ]
        var rejectedStalePermissions = false
        do { try RicoNativePolicyProjection.validateGuardStatus(stalePermissions, paused: false) }
        catch { rejectedStalePermissions = true }
        #expect(rejectedStalePermissions)

        var unavailableEscalation = status
        unavailableEscalation["escalation"] = [
            "toolName": RicoNativePolicyProjection.escalationToolName,
            "pluginConfigured": false,
            "originAuthorityHealthy": true,
        ]
        var rejectedUnavailableEscalation = false
        do { try RicoNativePolicyProjection.validateGuardStatus(unavailableEscalation, paused: false) }
        catch { rejectedUnavailableEscalation = true }
        #expect(rejectedUnavailableEscalation)

        var wrongPause = false
        do { try RicoNativePolicyProjection.validateGuardStatus(status, paused: true) }
        catch { wrongPause = true }
        #expect(wrongPause)
    }

    @Test("Studio's emitted plugin transaction removes every handoff hook permission")
    func escalationHandoffRemainsHookless() throws {
        let existing: [String: Any] = [
            "enabled": false,
            "config": ["enabled": true],
            "hooks": ["allowConversationAccess": true, "allowPromptInjection": true],
        ]
        let operations = RicoNativePolicyProjection.pluginProjectionOperations(
            pluginAllow: ["rico-escalation-handoff", "rico-recipient-guard"],
            existingEscalationEntry: existing
        )
        #expect(!operations.contains { operation in
            (operation["path"] as? String)?.hasPrefix("plugins.entries.rico-escalation-handoff.hooks") == true
        })
        let handoff = try #require(operations.first {
            ($0["path"] as? String) == "plugins.entries.rico-escalation-handoff"
        })
        let entry = try #require(handoff["value"] as? [String: Any])
        #expect(entry["enabled"] as? Bool == true)
        #expect(entry["hooks"] == nil)
        #expect(Set(entry.keys) == Set(["enabled"]))
    }

    @Test("Studio reads the exact raw handoff entry without accepting normalized defaults")
    func rawEscalationEntryReadback() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("rico-raw-handoff-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let config = root.appendingPathComponent("openclaw.json")
        let document: [String: Any] = [
            "plugins": [
                "entries": [
                    "rico-escalation-handoff": ["enabled": true],
                ],
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: document, options: [.sortedKeys])
        try data.write(to: config, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: config.path)

        let entry = try RicoNativePolicyProjection.rawEscalationPluginEntry(configURL: config)
        #expect(entry["enabled"] as? Bool == true)
        #expect(Set(entry.keys) == Set(["enabled"]))

        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: config.path)
        #expect(throws: (any Error).self) {
            _ = try RicoNativePolicyProjection.rawEscalationPluginEntry(configURL: config)
        }
    }

    @Test("OpenClaw leaf config JSON accepts valid scalar values")
    func scalarConfigJSON() throws {
        let scope = try RicoNativePolicyProjection.decodeConfigJSON(#""per-account-channel-peer""#)
        let enabled = try RicoNativePolicyProjection.decodeConfigJSON("true")
        let count = try RicoNativePolicyProjection.decodeConfigJSON("2")

        #expect(scope as? String == "per-account-channel-peer")
        #expect(enabled as? Bool == true)
        #expect((count as? NSNumber)?.intValue == 2)
    }

    @Test("Existing mention and auto-reply choices survive decoding")
    func persistedTogglesRemainAuthoritative() throws {
        let original = RicoRecipientPolicy(
            id: "contact", contactID: "contact", displayName: "Contact", address: "+15550000002",
            access: .approved, requireMention: false, autoReply: false,
            quietStart: 21, quietEnd: 7, groupChatID: nil
        )
        let decoded = try JSONDecoder().decode(RicoRecipientPolicy.self, from: JSONEncoder().encode(original))
        #expect(decoded.requireMention == false)
        #expect(decoded.autoReply == false)
    }

    private func permissions(_ url: URL) -> Int {
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attributes?[.posixPermissions] as? NSNumber)?.intValue ?? -1
    }

    private func json(_ url: URL) throws -> [String: Any] {
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        return try #require(object as? [String: Any])
    }
}
