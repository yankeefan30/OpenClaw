import SwiftUI
import AppKit

struct MCPIntegrationsView: View {
    @EnvironmentObject private var store: StudioStore
    @StateObject private var model = MCPIntegrationsModel()
    @State private var query = ""
    @State private var selectedName: String?
    @State private var showingAdd = false
    @State private var filterTarget: MCPServerRecord?
    @State private var authorizationTarget: MCPServerRecord?
    @State private var toolCallTarget: MCPToolCallTarget?
    @State private var pendingAction: MCPServerAction?

    private var visibleServers: [MCPServerRecord] {
        model.servers.filter {
            query.isEmpty || [$0.name, $0.transportLabel, $0.launch ?? "", $0.stateLabel]
                .joined(separator: " ")
                .localizedCaseInsensitiveContains(query)
        }
    }

    private var selectedServer: MCPServerRecord? {
        model.servers.first { $0.name == selectedName } ?? visibleServers.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            header
            securityBanner
            if let notice = model.notice {
                MCPNoticeBanner(text: notice, error: false) { model.notice = nil }
            }
            if let error = model.error {
                MCPNoticeBanner(text: error, error: true) { model.error = nil }
            }
            HStack(alignment: .top, spacing: 18) {
                serverBrowser
                    .frame(minWidth: 310, idealWidth: 350, maxWidth: 390)
                if let server = selectedServer {
                    MCPServerDetail(
                        server: server,
                        doctor: model.doctor[server.name],
                        probe: model.probes[server.name],
                        busy: model.busyServer == server.name,
                        action: { pendingAction = $0 },
                        editTools: { filterTarget = server },
                        authorize: { authorizationTarget = server },
                        callTool: { toolCallTarget = MCPToolCallTarget(server: server, tool: $0) }
                    )
                    .frame(maxWidth: .infinity)
                } else {
                    MCPEmptyDetail { showingAdd = true }
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .task {
            await model.refresh()
            if selectedName == nil { selectedName = model.servers.first?.name }
        }
        .onChange(of: model.servers) { _, servers in
            if let selectedName, servers.contains(where: { $0.name == selectedName }) { return }
            selectedName = servers.first?.name
        }
        .sheet(isPresented: $showingAdd) {
            MCPAddServerSheet { draft in
                try await model.add(draft)
                selectedName = draft.trimmedName
            }
        }
        .sheet(item: $filterTarget) { server in
            MCPToolFilterEditor(server: server) { draft in
                try await model.updateTools(server: server, draft: draft)
            }
        }
        .sheet(item: $authorizationTarget) { server in
            MCPAuthorizationSheet(
                server: server,
                begin: { try await model.beginOAuth(server) },
                finish: { try await model.finishOAuth(server, code: $0) }
            )
        }
        .sheet(item: $toolCallTarget) { target in
            MCPToolCallSheet(target: target) { draft in
                try await sendToolRequest(draft)
            }
        }
        .confirmationDialog(
            pendingAction?.title ?? "Review MCP operation",
            isPresented: Binding(
                get: { pendingAction != nil },
                set: { if !$0 { pendingAction = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let action = pendingAction {
                Button(action.confirmLabel, role: action.isDestructive ? .destructive : nil) {
                    pendingAction = nil
                    Task { await execute(action) }
                }
                Button("Cancel", role: .cancel) { pendingAction = nil }
            }
        } message: {
            Text(pendingAction?.reviewMessage ?? "")
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 16) {
            ZStack {
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .fill(LinearGradient(colors: [StudioDesign.violet, StudioDesign.accent], startPoint: .topLeading, endPoint: .bottomTrailing))
                Image(systemName: "network").font(.title2.bold()).foregroundStyle(.white)
            }
            .frame(width: 50, height: 50)
            VStack(alignment: .leading, spacing: 3) {
                Text("MCP Connections").font(.largeTitle.bold())
                Text("Bring trusted outside tools into Rico without surrendering control.")
                    .foregroundStyle(.secondary)
            }
            Spacer()
            StudioStatusPill(
                label: "\(model.servers.filter(\.enabled).count) active",
                color: model.servers.contains(where: { $0.enabled && !$0.ok }) ? .orange : StudioDesign.accent,
                symbol: "network"
            )
            Button {
                Task { await model.refresh() }
            } label: {
                if model.loading { ProgressView().controlSize(.small) }
                else { Image(systemName: "arrow.clockwise") }
            }
            .buttonStyle(.bordered)
            .disabled(model.loading)
            Button {
                showingAdd = true
            } label: {
                Label("Add server", systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
            .tint(StudioDesign.violet)
            .accessibilityIdentifier("mcp.addServer")
        }
    }

    private var securityBanner: some View {
        HStack(spacing: 12) {
            Image(systemName: "lock.shield.fill").foregroundStyle(StudioDesign.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text("Safe by default").font(.subheadline.weight(.semibold))
                Text("New remote endpoints require HTTPS, TLS verification stays on, credentials remain OAuth or environment references, and every connection or change is reviewed.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text("OpenClaw 2026.7 MCP")
                .font(.caption2.monospaced().weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .background(StudioDesign.accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(StudioDesign.accent.opacity(0.16)))
    }

    private var serverBrowser: some View {
        StudioCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Connections").font(.headline)
                        Text("\(visibleServers.count) configured").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                TextField("Search connections", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("mcp.search")
                if visibleServers.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "externaldrive.connected.to.line.below")
                            .font(.system(size: 32)).foregroundStyle(.tertiary)
                        Text(model.servers.isEmpty ? "No MCP servers yet" : "No matches")
                            .font(.headline)
                        Text(model.servers.isEmpty ? "Stage a remote service or local tool without connecting first." : "Try another search.")
                            .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        if model.servers.isEmpty {
                            Button("Add your first server") { showingAdd = true }
                                .buttonStyle(.borderedProminent).tint(StudioDesign.violet)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 34)
                } else {
                    LazyVStack(spacing: 8) {
                        ForEach(visibleServers) { server in
                            Button {
                                selectedName = server.name
                            } label: {
                                MCPServerListRow(
                                    server: server,
                                    toolCount: model.probes[server.name]?.tools(for: server.name).count,
                                    busy: model.busyServer == server.name,
                                    selected: selectedServer?.name == server.name
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                Divider()
                Label("Inventory comes from openclaw mcp status and doctor. It does not reveal headers, environment values, or OAuth tokens.", systemImage: "eye.slash")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
        }
    }

    private func execute(_ action: MCPServerAction) async {
        do {
            switch action {
            case .probe(let server): try await model.probe(server)
            case .enable(let server): try await model.setEnabled(server, enabled: true)
            case .disable(let server): try await model.setEnabled(server, enabled: false)
            case .remove(let server):
                try await model.remove(server)
                if selectedName == server.name { selectedName = nil }
            case .logout(let server): try await model.logout(server)
            }
        } catch {
            // The model publishes the redacted error in the shared banner.
        }
    }

    private func sendToolRequest(_ draft: MCPToolCallDraft) async throws {
        guard store.gatewayOnline else { throw MCPIntegrationError.validation("The OpenClaw Gateway is offline.") }
        guard let session = store.sessionRecords.first(where: { $0.key == "agent:main:main" }) else {
            throw MCPIntegrationError.validation("Rico's primary Gateway session is unavailable. Studio will not route a tool request into a different conversation.")
        }
        _ = try await store.send(session: session, text: draft.ricoInstruction())
        model.notice = "The reviewed \(draft.toolName) request was handed to Rico. Any additional approval remains in force."
    }
}

private enum MCPServerAction: Identifiable {
    case probe(MCPServerRecord)
    case enable(MCPServerRecord)
    case disable(MCPServerRecord)
    case remove(MCPServerRecord)
    case logout(MCPServerRecord)

    var id: String { "\(kind):\(server.name)" }
    var server: MCPServerRecord {
        switch self {
        case .probe(let value), .enable(let value), .disable(let value), .remove(let value), .logout(let value): value
        }
    }
    var kind: String {
        switch self {
        case .probe: "probe"
        case .enable: "enable"
        case .disable: "disable"
        case .remove: "remove"
        case .logout: "logout"
        }
    }
    var title: String {
        switch self {
        case .probe: "Connect and inspect capabilities?"
        case .enable: "Test and enable this server?"
        case .disable: "Disable this server?"
        case .remove: "Remove this MCP server?"
        case .logout: "Clear OAuth authorization?"
        }
    }
    var confirmLabel: String {
        switch self {
        case .probe: "Connect and inspect"
        case .enable: server.isOAuth ? "Enable" : "Test and enable"
        case .disable: "Disable"
        case .remove: "Remove server"
        case .logout: "Clear authorization"
        }
    }
    var isDestructive: Bool {
        switch self {
        case .remove, .logout: true
        default: false
        }
    }
    var reviewMessage: String {
        let target = server.safeLaunchSummary
        switch self {
        case .probe:
            return "OpenClaw will connect to \(target) and request its tool, resource, and prompt catalog. No MCP tool will be invoked."
        case .enable:
            if server.isOAuth {
                return "\(server.name) will become available to OpenClaw agents. It still needs OAuth authorization before use. Studio grants no automatic tool approval."
            }
            return "OpenClaw will first probe \(target). It will save the server as enabled only if that connection succeeds. Studio grants no automatic tool approval."
        case .disable:
            return "\(server.name) will remain configured but will no longer be available to new MCP runtime sessions."
        case .remove:
            return "OpenClaw will remove \(server.name) from mcp.servers and clear its stored OAuth credentials, if any. This cannot be undone from Studio."
        case .logout:
            return "OpenClaw will clear the stored OAuth credentials for \(server.name). The server definition will remain configured."
        }
    }
}

private struct MCPToolCallTarget: Identifiable {
    let server: MCPServerRecord
    let tool: String
    var id: String { "\(server.name):\(tool)" }
}

private struct MCPServerListRow: View {
    let server: MCPServerRecord
    let toolCount: Int?
    let busy: Bool
    let selected: Bool

    private var color: Color {
        if busy { return .orange }
        if !server.enabled { return .secondary }
        if !server.ok || (server.isOAuth && !server.isAuthorized) { return .orange }
        return StudioDesign.accent
    }

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous).fill(color.opacity(0.12))
                if busy {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: server.transport == "stdio" ? "terminal" : "network")
                        .foregroundStyle(color)
                }
            }
            .frame(width: 38, height: 38)
            VStack(alignment: .leading, spacing: 3) {
                Text(server.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                HStack(spacing: 5) {
                    Circle().fill(color).frame(width: 6, height: 6)
                    Text(busy ? "Probing" : (toolCount == nil ? server.stateLabel : "Connected"))
                    if let toolCount { Text("· \(toolCount) tools") }
                }
                .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption.bold())
                .foregroundStyle(selected ? StudioDesign.violet : Color.secondary.opacity(0.5))
        }
        .padding(11)
        .background(selected ? StudioDesign.violet.opacity(0.10) : Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(selected ? StudioDesign.violet.opacity(0.22) : Color.clear))
    }
}

private struct MCPServerDetail: View {
    let server: MCPServerRecord
    let doctor: MCPDoctorServer?
    let probe: MCPProbeEnvelope?
    let busy: Bool
    let action: (MCPServerAction) -> Void
    let editTools: () -> Void
    let authorize: () -> Void
    let callTool: (String) -> Void
    @State private var tab = 0

    private var tools: [String] { probe?.tools(for: server.name) ?? [] }
    private var activationLockReason: String? {
        MCPGovernedActivationPolicy.lockReason(for: server.name)
    }
    private var displayedStateLabel: String {
        if activationLockReason != nil {
            return server.enabled ? "Disable required" : "Activation locked"
        }
        return probe == nil ? server.stateLabel : "Connected"
    }
    private var displayedStateSymbol: String {
        if activationLockReason != nil {
            return server.enabled ? "exclamationmark.triangle.fill" : "lock.fill"
        }
        return server.enabled ? "circle.fill" : "pause.fill"
    }
    private var stateColor: Color {
        if activationLockReason != nil { return .orange }
        if !server.enabled { return .secondary }
        if !server.ok || (server.isOAuth && !server.isAuthorized) { return .orange }
        return StudioDesign.accent
    }

    var body: some View {
        StudioCard {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .top, spacing: 14) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(LinearGradient(colors: [stateColor.opacity(0.20), StudioDesign.violet.opacity(0.10)], startPoint: .topLeading, endPoint: .bottomTrailing))
                        Image(systemName: server.transport == "stdio" ? "terminal.fill" : "network")
                            .font(.title2).foregroundStyle(stateColor)
                    }
                    .frame(width: 48, height: 48)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(server.name).font(.title2.bold())
                        Text(server.safeLaunchSummary)
                            .font(.caption.monospaced()).foregroundStyle(.secondary)
                            .textSelection(.enabled).lineLimit(2)
                    }
                    Spacer()
                    StudioStatusPill(label: displayedStateLabel, color: stateColor, symbol: displayedStateSymbol)
                    if busy { ProgressView().controlSize(.small) }
                }
                HStack(spacing: 9) {
                    Button {
                        action(.probe(server))
                    } label: {
                        Label(probe == nil ? "Test connection" : "Test again", systemImage: "wave.3.right")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(StudioDesign.accent)
                    .disabled(!server.enabled || busy || (server.isOAuth && !server.isAuthorized))
                    Button(server.enabled ? "Disable" : (activationLockReason == nil ? "Enable" : "Activation locked")) {
                        action(server.enabled ? .disable(server) : .enable(server))
                    }
                    .buttonStyle(.bordered)
                    .disabled(busy || (!server.enabled && activationLockReason != nil))
                    if server.isOAuth && !server.isAuthorized {
                        Button("Authorize") { authorize() }
                            .buttonStyle(.bordered).tint(StudioDesign.violet)
                    }
                    Menu {
                        Button("Edit tool access", action: editTools)
                        if server.isOAuth && server.isAuthorized {
                            Divider()
                            Button("Clear OAuth authorization", role: .destructive) { action(.logout(server)) }
                        }
                        Divider()
                        Button("Remove server", role: .destructive) { action(.remove(server)) }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    Spacer()
                }
                if let activationLockReason {
                    Label(activationLockReason, systemImage: "lock.shield.fill")
                        .font(.callout)
                        .foregroundStyle(.orange)
                }
                Picker("", selection: $tab) {
                    Text("Overview").tag(0)
                    Text("Tools\(tools.isEmpty ? "" : " (\(tools.count))")").tag(1)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                if tab == 0 {
                    overview
                } else {
                    toolsView
                }
            }
        }
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: 16) {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                MCPFactCard(label: "Transport", value: server.transportLabel, symbol: "arrow.left.arrow.right")
                MCPFactCard(label: "Authentication", value: server.isOAuth ? (server.isAuthorized ? "OAuth authorized" : "OAuth required") : "No stored token shown", symbol: "key")
                MCPFactCard(label: "Tool exposure", value: server.toolFilter?.summary ?? "All tools", symbol: "slider.horizontal.3")
                MCPFactCard(label: "Timeouts", value: "\(seconds(server.connectionTimeoutMs)) connect · \(seconds(server.requestTimeoutMs)) request", symbol: "timer")
            }
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Safety check").font(.headline)
                    Spacer()
                    if doctor?.ok == true {
                        Label("Static checks pass", systemImage: "checkmark.circle.fill")
                            .font(.caption.weight(.semibold)).foregroundStyle(StudioDesign.accent)
                    }
                }
                if let doctor, !doctor.issues.isEmpty {
                    ForEach(doctor.issues) { issue in
                        HStack(alignment: .top, spacing: 9) {
                            Image(systemName: issue.level == "error" ? "xmark.octagon.fill" : "exclamationmark.triangle.fill")
                                .foregroundStyle(issue.level == "error" ? .red : .orange)
                            Text(MCPRedactor.redact(issue.message)).font(.callout)
                        }
                    }
                } else {
                    Text("OpenClaw doctor found no static transport, executable, TLS, or credential-reference problems. A probe is still required to verify the live server.")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
            .padding(14)
            .background(Color.primary.opacity(0.028), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            if let probe {
                HStack(spacing: 10) {
                    Image(systemName: probe.diagnostics.isEmpty ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                        .foregroundStyle(probe.diagnostics.isEmpty ? StudioDesign.accent : .orange)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(probe.diagnostics.isEmpty ? "Live capability probe completed" : "Probe returned diagnostics")
                            .font(.subheadline.weight(.semibold))
                        Text("\(tools.count) tools · resources \(probe.servers[server.name]?.resources == true ? "available" : "not advertised") · prompts \(probe.servers[server.name]?.prompts == true ? "available" : "not advertised")")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            } else {
                Label("Not connected from Studio yet. Status is configuration-only until you approve a probe.", systemImage: "info.circle")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var toolsView: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Available tools").font(.headline)
                    Text("Discovered only by an explicit capability probe. Calls run through Rico and retain his approval policy.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Edit access", action: editTools).buttonStyle(.bordered)
            }
            if tools.isEmpty {
                ContentUnavailableView(
                    "No discovered tools",
                    systemImage: "wrench.and.screwdriver",
                    description: Text(server.enabled ? "Approve a connection test to retrieve the server catalog." : "Enable the server before testing its catalog.")
                )
                .frame(minHeight: 210)
            } else {
                LazyVStack(spacing: 8) {
                    ForEach(tools, id: \.self) { tool in
                        HStack(spacing: 11) {
                            Image(systemName: "wrench.adjustable.fill")
                                .foregroundStyle(StudioDesign.violet)
                                .frame(width: 30, height: 30)
                                .background(StudioDesign.violet.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(tool).font(.subheadline.monospaced().weight(.medium))
                                Text("MCP tool · \(server.name)").font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Review call") { callTool(tool) }
                                .buttonStyle(.bordered)
                                .disabled(activationLockReason != nil)
                        }
                        .padding(11)
                        .background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                    }
                }
            }
        }
    }

    private func seconds(_ milliseconds: Int?) -> String {
        guard let milliseconds else { return "default" }
        return "\(milliseconds / 1_000)s"
    }
}

private struct MCPFactCard: View {
    let label: String
    let value: String
    let symbol: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).foregroundStyle(StudioDesign.violet).frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(label.uppercased()).font(.system(size: 9, weight: .bold, design: .monospaced)).foregroundStyle(.tertiary)
                Text(value).font(.subheadline.weight(.medium)).lineLimit(2)
            }
            Spacer()
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.028), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
    }
}

private struct MCPEmptyDetail: View {
    let add: () -> Void
    var body: some View {
        StudioCard {
            ContentUnavailableView {
                Label("Connect Rico to the outside world", systemImage: "network")
            } description: {
                Text("Add an MCP server, review exactly what it can expose, and keep every live test and tool request under your control.")
            } actions: {
                Button("Add MCP server", action: add).buttonStyle(.borderedProminent).tint(StudioDesign.violet)
            }
            .frame(maxWidth: .infinity, minHeight: 430)
        }
    }
}

private struct MCPNoticeBanner: View {
    let text: String
    let error: Bool
    let dismiss: () -> Void
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: error ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundStyle(error ? .red : StudioDesign.accent)
            Text(MCPRedactor.redact(text)).font(.callout).textSelection(.enabled)
            Spacer()
            Button(action: dismiss) { Image(systemName: "xmark") }.buttonStyle(.plain).foregroundStyle(.secondary)
        }
        .padding(12)
        .background((error ? Color.red : StudioDesign.accent).opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct MCPAddServerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let save: (MCPServerDraft) async throws -> Void
    @State private var draft = MCPServerDraft()
    @State private var reviewing = false
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12).fill(StudioDesign.violet.opacity(0.14))
                    Image(systemName: reviewing ? "checkmark.shield.fill" : "plus.circle.fill")
                        .font(.title2).foregroundStyle(StudioDesign.violet)
                }.frame(width: 42, height: 42)
                VStack(alignment: .leading, spacing: 2) {
                    Text(reviewing ? "Review MCP connection" : "Add MCP server").font(.title2.bold())
                    Text(reviewing ? "Nothing is saved until you confirm." : "Remote URL or local stdio process")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text(reviewing ? "2 OF 2" : "1 OF 2").font(.caption2.monospaced().bold()).foregroundStyle(.secondary)
            }
            .padding(24)
            Divider()
            ScrollView {
                if reviewing { reviewContent.padding(24) }
                else { formContent.padding(24) }
            }
            Divider()
            HStack {
                if reviewing { Button("Back") { reviewing = false }.disabled(saving) }
                Spacer()
                Button("Cancel") { dismiss() }.disabled(saving)
                if reviewing {
                    Button(draft.activation == .staged ? "Save disabled" : "Connect and save") {
                        Task { await persist() }
                    }
                    .buttonStyle(.borderedProminent).tint(StudioDesign.violet).disabled(saving)
                } else {
                    Button("Review connection") {
                        let errors = draft.validationErrors()
                        if let first = errors.first { error = first }
                        else { error = nil; reviewing = true }
                    }
                    .buttonStyle(.borderedProminent).tint(StudioDesign.violet)
                }
                if saving { ProgressView().controlSize(.small) }
            }
            .padding(18)
        }
        .frame(width: 680, height: 720)
    }

    private var formContent: some View {
        VStack(alignment: .leading, spacing: 20) {
            Picker("Server type", selection: $draft.kind) {
                ForEach(MCPTransportKind.allCases) { value in
                    Label(value.rawValue, systemImage: value.symbol).tag(value)
                }
            }
            .pickerStyle(.segmented)
            MCPFormSection(title: "Identity", subtitle: "A stable, human-readable name used as the MCP tool prefix.") {
                TextField("Server name, such as notion or finance", text: $draft.name)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("mcp.add.name")
            }
            if draft.kind == .remote { remoteFields } else { localFields }
            MCPFormSection(title: "Tool access", subtitle: "Leave both blank to expose every tool the server advertises. Use comma-separated names or simple * globs to narrow access.") {
                TextField("Include only, for example search_*, read_page", text: $draft.includeTools)
                    .textFieldStyle(.roundedBorder)
                TextField("Exclude, for example delete_*, admin_*", text: $draft.excludeTools)
                    .textFieldStyle(.roundedBorder)
            }
            MCPFormSection(title: "Runtime", subtitle: "Conservative defaults protect Rico from slow or unresponsive servers.") {
                Stepper("Connect timeout: \(draft.connectionTimeoutSeconds) seconds", value: $draft.connectionTimeoutSeconds, in: 1...120)
                Stepper("Request timeout: \(draft.requestTimeoutSeconds) seconds", value: $draft.requestTimeoutSeconds, in: 1...600)
                Toggle("Server explicitly supports parallel tool calls", isOn: $draft.supportsParallelCalls)
            }
            MCPFormSection(title: "Activation", subtitle: "Staging writes the definition without contacting or starting it. Test and enable probes first, then saves only on success.") {
                Picker("Activation", selection: $draft.activation) {
                    ForEach(MCPActivationMode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.radioGroup)
            }
            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.callout)
            }
        }
    }

    private var remoteFields: some View {
        VStack(alignment: .leading, spacing: 20) {
            MCPFormSection(title: "Endpoint", subtitle: "HTTPS is required off-device. Loopback HTTP is allowed for a server on this Mac.") {
                TextField("https://mcp.example.com/mcp", text: $draft.url)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("mcp.add.url")
                Picker("Protocol", selection: $draft.httpTransport) {
                    ForEach(MCPHTTPTransport.allCases) { Text($0.label).tag($0) }
                }
            }
            MCPFormSection(title: "Authentication", subtitle: "Studio never accepts a plaintext token. OAuth credentials are stored by OpenClaw; static credentials must be environment references.") {
                Picker("Authentication", selection: $draft.authentication) {
                    ForEach(MCPAuthenticationMode.allCases) { Text($0.rawValue).tag($0) }
                }
                if draft.authentication == .oauth {
                    TextField("OAuth scope (optional)", text: $draft.oauthScope).textFieldStyle(.roundedBorder)
                }
                if draft.authentication == .bearerEnvironment || draft.authentication == .headerEnvironment {
                    TextField("Environment variable, such as RICO_MCP_TOKEN", text: $draft.environmentName)
                        .textFieldStyle(.roundedBorder)
                    if draft.authentication == .headerEnvironment {
                        TextField("HTTP header name", text: $draft.headerName).textFieldStyle(.roundedBorder)
                    }
                    Label("Only the reference \(MCPServerDraft.environmentReference(draft.environmentName.isEmpty ? "VARIABLE" : draft.environmentName)) is saved. Its value is never shown or logged by Studio.", systemImage: "eye.slash")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var localFields: some View {
        MCPFormSection(title: "Local command", subtitle: "OpenClaw launches this executable directly—never through a shell. Put one argument or environment entry on each line.") {
            TextField("Executable, such as uvx or /usr/local/bin/my-mcp", text: $draft.command)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("mcp.add.command")
            TextField("Absolute working directory (optional)", text: $draft.workingDirectory)
                .textFieldStyle(.roundedBorder)
            MCPCodeEditor(label: "Arguments — one per line", text: $draft.arguments, height: 90)
            MCPCodeEditor(label: "Environment — KEY=value, one per line", text: $draft.environment, height: 90)
            Label("Sensitive environment keys must point to another environment variable instead of containing a literal credential.", systemImage: "lock")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var reviewContent: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Connection contract").font(.headline)
            ForEach(Array(draft.maskedReview.enumerated()), id: \.offset) { _, row in
                HStack(alignment: .top) {
                    Text(row.0).foregroundStyle(.secondary).frame(width: 130, alignment: .leading)
                    Text(row.1).textSelection(.enabled)
                    Spacer()
                }.font(.callout)
                Divider()
            }
            MCPReviewRow(label: "TLS", value: draft.kind == .remote ? "Certificate verification enforced" : "Not applicable")
            MCPReviewRow(label: "Agent access", value: "OpenClaw default: all agents")
            MCPReviewRow(label: "Approvals", value: "Existing agent policy; Studio grants no auto-approval")
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: draft.activation == .staged ? "pause.circle.fill" : "network")
                    .foregroundStyle(draft.activation == .staged ? Color.secondary : Color.orange)
                Text(draft.activation == .staged
                     ? "Save disabled performs a validated configuration write without connecting to the server."
                     : "Connect and save will contact or start this server, request its capabilities, and save it only if the probe succeeds. It invokes no MCP tool.")
                    .font(.callout)
            }
            .padding(14)
            .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.callout)
            }
        }
    }

    private func persist() async {
        saving = true
        error = nil
        do {
            try await save(draft)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
        saving = false
    }
}

private struct MCPFormSection<Content: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder let content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            content()
        }
        .padding(16)
        .background(Color.primary.opacity(0.028), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    }
}

private struct MCPCodeEditor: View {
    let label: String
    @Binding var text: String
    let height: CGFloat
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $text)
                .font(.system(.body, design: .monospaced))
                .frame(height: height)
                .padding(6)
                .scrollContentBackground(.hidden)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
        }
    }
}

private struct MCPReviewRow: View {
    let label: String
    let value: String
    var body: some View {
        HStack(alignment: .top) {
            Text(label).foregroundStyle(.secondary).frame(width: 130, alignment: .leading)
            Text(value)
            Spacer()
        }.font(.callout)
    }
}

private struct MCPToolFilterEditor: View {
    @Environment(\.dismiss) private var dismiss
    let server: MCPServerRecord
    let save: (MCPToolFilterDraft) async throws -> Void
    @State private var draft: MCPToolFilterDraft
    @State private var reviewing = false
    @State private var saving = false
    @State private var error: String?

    init(server: MCPServerRecord, save: @escaping (MCPToolFilterDraft) async throws -> Void) {
        self.server = server
        self.save = save
        _draft = State(initialValue: MCPToolFilterDraft(filter: server.toolFilter))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(reviewing ? "Review tool access" : "Tool access · \(server.name)").font(.title2.bold())
            if reviewing {
                MCPReviewRow(label: "Include", value: draft.includeValues.isEmpty ? "No allow-only filter" : draft.includeValues.joined(separator: ", "))
                MCPReviewRow(label: "Exclude", value: draft.excludeValues.isEmpty ? "No exclusions" : draft.excludeValues.joined(separator: ", "))
                MCPReviewRow(label: "Result", value: draft.isEmpty ? "Every advertised tool can be presented to agents" : "OpenClaw applies these exact filters")
                if draft.isEmpty {
                    Label("Clearing both fields broadens access to every tool this server advertises.", systemImage: "exclamationmark.triangle.fill")
                        .font(.callout).foregroundStyle(.orange)
                }
            } else {
                Text("Use exact MCP tool names or simple * globs. Include creates an allow-only list; exclude removes tools from that result.")
                    .foregroundStyle(.secondary)
                TextField("Include only", text: $draft.include).textFieldStyle(.roundedBorder)
                TextField("Exclude", text: $draft.exclude).textFieldStyle(.roundedBorder)
            }
            if let error { Text(error).foregroundStyle(.red).font(.callout) }
            Spacer()
            HStack {
                if reviewing { Button("Back") { reviewing = false }.disabled(saving) }
                Spacer()
                Button("Cancel") { dismiss() }.disabled(saving)
                if reviewing {
                    Button("Apply tool access") { Task { await persist() } }
                        .buttonStyle(.borderedProminent).tint(StudioDesign.violet).disabled(saving)
                } else {
                    Button("Review change") { reviewing = true }.buttonStyle(.borderedProminent).tint(StudioDesign.violet)
                }
                if saving { ProgressView().controlSize(.small) }
            }
        }
        .padding(26).frame(width: 590, height: 410)
    }

    private func persist() async {
        saving = true; error = nil
        do { try await save(draft); dismiss() }
        catch { self.error = error.localizedDescription }
        saving = false
    }
}

private struct MCPAuthorizationSheet: View {
    @Environment(\.dismiss) private var dismiss
    let server: MCPServerRecord
    let begin: () async throws -> MCPOAuthLaunch
    let finish: (String) async throws -> Void
    @State private var started = false
    @State private var code = ""
    @State private var busy = false
    @State private var status: String?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Image(systemName: "person.badge.key.fill").font(.title).foregroundStyle(StudioDesign.violet)
                VStack(alignment: .leading) {
                    Text("Authorize \(server.name)").font(.title2.bold())
                    Text("OAuth credentials are stored by OpenClaw, never displayed in Studio.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Text("Beginning authorization connects to \(server.safeLaunchSummary) to discover its OAuth flow. Review the provider page before granting access.")
                .font(.callout)
            if started {
                Label(status ?? "The authorization page was opened in your browser.", systemImage: "safari")
                    .font(.callout).foregroundStyle(.secondary)
                SecureField("One-time authorization code", text: $code)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("mcp.oauth.code")
                Text("The code stays masked in the interface and is passed only to OpenClaw's supported login command.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let error { Text(MCPRedactor.redact(error)).foregroundStyle(.red).font(.callout) }
            Spacer()
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.disabled(busy)
                if !started {
                    Button("Begin authorization") { Task { await start() } }
                        .buttonStyle(.borderedProminent).tint(StudioDesign.violet).disabled(busy)
                } else {
                    Button("Submit code") { Task { await complete() } }
                        .buttonStyle(.borderedProminent).tint(StudioDesign.violet)
                        .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
                }
                if busy { ProgressView().controlSize(.small) }
            }
        }
        .padding(28).frame(width: 560, height: 340)
    }

    private func start() async {
        busy = true; error = nil
        do {
            let launch = try await begin()
            started = true
            status = "Authorization started. Return here with the one-time code."
            if let url = launch.authorizationURL { NSWorkspace.shared.open(url) }
        } catch { self.error = error.localizedDescription }
        busy = false
    }

    private func complete() async {
        busy = true; error = nil
        do { try await finish(code); code = ""; dismiss() }
        catch { self.error = error.localizedDescription }
        busy = false
    }
}

private struct MCPToolCallSheet: View {
    @Environment(\.dismiss) private var dismiss
    let target: MCPToolCallTarget
    let send: (MCPToolCallDraft) async throws -> Void
    @State private var arguments = "{}"
    @State private var reviewing = false
    @State private var sending = false
    @State private var error: String?

    private var draft: MCPToolCallDraft {
        MCPToolCallDraft(serverName: target.server.name, toolName: target.tool, argumentsJSON: arguments)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                Image(systemName: "wrench.adjustable.fill").font(.title2).foregroundStyle(StudioDesign.violet)
                VStack(alignment: .leading, spacing: 2) {
                    Text(reviewing ? "Review Rico tool request" : "Request MCP tool").font(.title2.bold())
                    Text(target.tool).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
            }
            if reviewing {
                MCPReviewRow(label: "Server", value: target.server.name)
                MCPReviewRow(label: "Tool", value: target.tool)
                VStack(alignment: .leading, spacing: 6) {
                    Text("MASKED INPUT").font(.caption2.monospaced().bold()).foregroundStyle(.secondary)
                    ScrollView {
                        Text(draft.maskedArguments()).font(.body.monospaced()).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(12).background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
                }
                Label("Confirming sends this exact request to Rico. Studio does not call the server directly, and Rico may still ask for another approval.", systemImage: "checkmark.shield")
                    .font(.callout).foregroundStyle(.secondary)
            } else {
                Text("Enter a JSON object for the tool. Sensitive-looking fields are masked on the review screen.")
                    .foregroundStyle(.secondary)
                MCPCodeEditor(label: "Tool input JSON", text: $arguments, height: 230)
            }
            if let error { Text(MCPRedactor.redact(error)).foregroundStyle(.red).font(.callout) }
            Spacer()
            HStack {
                if reviewing { Button("Back") { reviewing = false }.disabled(sending) }
                Spacer()
                Button("Cancel") { dismiss() }.disabled(sending)
                if reviewing {
                    Button("Send reviewed request to Rico") { Task { await submit() } }
                        .buttonStyle(.borderedProminent).tint(StudioDesign.violet).disabled(sending)
                } else {
                    Button("Review request") {
                        do { _ = try draft.validatedObject(); error = nil; reviewing = true }
                        catch { self.error = error.localizedDescription }
                    }
                    .buttonStyle(.borderedProminent).tint(StudioDesign.violet)
                }
                if sending { ProgressView().controlSize(.small) }
            }
        }
        .padding(28).frame(width: 650, height: 560)
    }

    private func submit() async {
        sending = true; error = nil
        do { try await send(draft); dismiss() }
        catch { self.error = error.localizedDescription }
        sending = false
    }
}
