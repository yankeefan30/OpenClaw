import SwiftUI

private struct RicoCLIEntry: Identifiable {
    let id: String
    let role: String
    let text: String
}

struct RicoCLIView: View {
    @EnvironmentObject private var store: StudioStore
    @State private var command = ""
    @State private var entries: [RicoCLIEntry] = []
    @State private var sending = false
    @State private var activity = ""
    @State private var error: String?
    @State private var sendTask: Task<Void, Never>?
    @State private var showingGatewayRepair = false
    @FocusState private var focused: Bool

    private var session: SessionRecord? {
        store.sessionRecords.first { $0.key == "agent:main:main" }
    }

    var body: some View {
        ZStack {
            StudioBackdrop()
            VStack(spacing: 0) {
            HStack(spacing: 14) {
                ZStack {
                    RoundedRectangle(cornerRadius: 13, style: .continuous)
                        .fill(LinearGradient(colors: [StudioDesign.accent, StudioDesign.violet], startPoint: .topLeading, endPoint: .bottomTrailing))
                    Image(systemName: "sparkles").font(.title3.bold()).foregroundStyle(.white)
                }.frame(width: 44, height: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Command Rico").font(.title2.bold())
                    Text("Your operating conversation")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                StudioStatusPill(label: store.gatewayOnline ? "Gateway online" : "Connecting", color: store.gatewayOnline ? StudioDesign.accent : .orange,
                                 symbol: store.gatewayOnline ? "bolt.fill" : "bolt.slash")
                if !store.gatewayOnline {
                    Button(store.gatewayRepairing ? "Repairing…" : "Repair Gateway") {
                        showingGatewayRepair = true
                    }
                    .buttonStyle(.bordered)
                    .disabled(store.gatewayRepairing)
                }
                if !store.taskRecords.isEmpty {
                    StudioStatusPill(label: "\(store.taskRecords.filter { !$0.isTerminal }.count) active", color: StudioDesign.violet, symbol: "circle.dotted")
                }
                if sending {
                    ProgressView().controlSize(.small)
                    Button("Stop") { stop() }
                        .buttonStyle(.bordered).tint(.red)
                }
                Button { Task { await loadHistory() } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless).help("Refresh")
            }.padding(.horizontal, 28).padding(.vertical, 18)
            Divider().opacity(0.45)
            if let repairMessage = store.gatewayRepairMessage {
                Label(repairMessage, systemImage: store.gatewayOnline ? "checkmark.circle.fill" : "wrench.and.screwdriver.fill")
                    .font(.caption)
                    .foregroundStyle(store.gatewayOnline ? StudioDesign.accent : .orange)
                    .padding(.horizontal, 28)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.ultraThinMaterial)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 20) {
                        if entries.isEmpty {
                            emptyState.padding(.top, 62)
                        }
                        ForEach(entries) { entry in
                            HStack(alignment: .top, spacing: 11) {
                                ZStack {
                                    Circle().fill(entry.role == "user" ? StudioDesign.violet.opacity(0.18) : StudioDesign.accent.opacity(0.18))
                                    Image(systemName: entry.role == "user" ? "person.fill" : "sparkles")
                                        .font(.caption.bold()).foregroundStyle(entry.role == "user" ? StudioDesign.violet : StudioDesign.accent)
                                }.frame(width: 30, height: 30)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(entry.role == "user" ? "YOU" : "RICO")
                                        .font(.system(size: 10, weight: .bold, design: .monospaced)).foregroundStyle(.secondary)
                                    Text(entry.text).textSelection(.enabled).font(.body).lineSpacing(3)
                                }
                                .padding(14)
                                .background(entry.role == "user" ? StudioDesign.violet.opacity(0.07) : Color.primary.opacity(0.035),
                                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            }.id(entry.id)
                        }
                        if let error {
                            Label(error, systemImage: "exclamationmark.triangle.fill")
                                .font(.caption).foregroundStyle(.red).padding(12)
                                .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                        }
                    }.frame(maxWidth: 860, alignment: .leading).padding(.horizontal, 36).padding(.bottom, 28)
                }
                .onChange(of: entries.count) { _, _ in
                    if let id = entries.last?.id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
                }
            }
            VStack(spacing: 9) {
                HStack(alignment: .bottom, spacing: 12) {
                    Image(systemName: "chevron.right.2").font(.headline.bold()).foregroundStyle(StudioDesign.accent)
                    TextField("Task Rico…", text: $command, axis: .vertical)
                        .textFieldStyle(.plain).lineLimit(1...6).focused($focused)
                        .font(.system(size: 16, weight: .regular, design: .rounded)).onSubmit { submit() }
                    Button(action: submit) { Image(systemName: "arrow.up").frame(width: 26, height: 26) }
                        .buttonStyle(.borderedProminent).buttonBorderShape(.circle)
                        .tint(StudioDesign.accent)
                        .disabled(command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending || session == nil)
                }
                HStack {
                    Label("Primary memory", systemImage: "brain.head.profile")
                    Spacer()
                    Text(sending ? activity : (session == nil ? "Primary session unavailable" : "Return to send"))
                }.font(.caption2).foregroundStyle(.tertiary)
            }
            .padding(16).frame(maxWidth: 900)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(StudioDesign.accent.opacity(focused ? 0.35 : 0.12)))
            .shadow(color: .black.opacity(0.16), radius: 22, y: 8)
            .padding(.horizontal, 28).padding(.bottom, 22)
            }
        }
        .task { await loadHistory(); focused = true }
        .onChange(of: session?.key) { _, _ in Task { await loadHistory() } }
        .onDisappear { sendTask?.cancel() }
        .confirmationDialog(
            "Repair the OpenClaw Gateway service?",
            isPresented: $showingGatewayRepair,
            titleVisibility: .visible
        ) {
            Button("Repair Gateway") { store.repairGatewayService() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Studio will ask OpenClaw to reinstall and load its existing macOS LaunchAgent on port 18789. Mission authority remains globally paused.")
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("What are we moving forward?").font(.system(size: 34, weight: .semibold, design: .rounded))
            Text("Give Rico the outcome. He can plan the work, use your connected tools, and return with decisions—not a pile of setup questions.")
                .font(.title3).foregroundStyle(.secondary).frame(maxWidth: 680, alignment: .leading)
            VStack(alignment: .leading, spacing: 8) {
                suggestion("Review everything in motion and tell me the three decisions I need to make.")
                suggestion("Turn my latest idea into a concrete plan and start the first safe step.")
                suggestion("Build an automation from a plain-English description.")
            }.padding(.top, 6)
        }
    }

    private func suggestion(_ text: String) -> some View {
        Button { command = text; focused = true } label: {
            HStack { Text(text); Spacer(); Image(systemName: "arrow.up.left") }
                .frame(maxWidth: 620, alignment: .leading)
        }
        .buttonStyle(.plain).padding(.horizontal, 14).padding(.vertical, 10)
        .background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
    }

    private func submit() {
        let text = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let session, !sending else { return }
        command = ""; sending = true; activity = "Starting Rico…"; error = nil
        let optimisticID = "local-\(UUID().uuidString)"
        entries.append(RicoCLIEntry(id: optimisticID, role: "user", text: text))
        sendTask = Task {
            defer {
                sending = false
                activity = ""
                sendTask = nil
                focused = true
            }
            do {
                let existing = try await store.history(session: session)
                let existingAssistantIDs = Set(existing.filter { $0.role == "assistant" }.map(\.id))
                let receipt = try await store.send(session: session, text: text)
                activity = "Rico is working…"
                let result = try await store.waitForRun(receipt.runID)
                try Task.checkCancellation()
                if result.isTimeout {
                    error = "Rico is still working after one minute. You can keep waiting in Sessions or stop the run."
                    return
                }
                guard result.completedSuccessfully else {
                    throw GatewayClientError.rejected(result.error ?? "Rico's run ended with status: \(result.status).")
                }
                activity = "Finishing the response…"
                for _ in 0..<20 {
                    let history = try await store.history(session: session)
                    let mapped = history.filter { !$0.text.isEmpty }.suffix(80).map {
                        RicoCLIEntry(id: $0.id, role: $0.role, text: $0.text)
                    }
                    if history.contains(where: { $0.role == "assistant" && !existingAssistantIDs.contains($0.id) }) {
                        entries = mapped
                        return
                    }
                    try await Task.sleep(for: .milliseconds(350))
                }
                error = "The run completed, but its final transcript has not appeared yet. Refresh once to reconcile it."
            } catch is CancellationError {
                return
            } catch { self.error = error.localizedDescription }
        }
    }

    private func stop() {
        guard let session, sending else { return }
        sendTask?.cancel()
        activity = "Stopping…"
        Task {
            do {
                try await store.abort(session: session)
                error = "Rico's active run was stopped."
                await loadHistory()
            } catch {
                self.error = "Could not stop Rico: \(error.localizedDescription)"
            }
            sending = false
            activity = ""
        }
    }

    private func loadHistory() async {
        guard let session else { return }
        do {
            entries = try await store.history(session: session).filter { !$0.text.isEmpty }.suffix(80).map {
                RicoCLIEntry(id: $0.id, role: $0.role, text: $0.text)
            }
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}
