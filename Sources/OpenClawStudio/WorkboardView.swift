import SwiftUI

private struct WorkboardCardRecord: Identifiable, Hashable {
    let id: String
    let title: String
    let status: String
    let priority: String
    let notes: String
    let agent: String

    init?(_ raw: [String: Any]) {
        guard let id = raw["id"] as? String, let title = raw["title"] as? String else { return nil }
        self.id = id
        self.title = title
        self.status = raw["status"] as? String ?? "triage"
        self.priority = raw["priority"] as? String ?? "normal"
        self.notes = raw["notes"] as? String ?? ""
        self.agent = raw["agentId"] as? String ?? "unassigned"
    }
}

@MainActor
private final class WorkboardStore: ObservableObject {
    private let gateway = GatewayClient()
    @Published var cards: [WorkboardCardRecord] = []
    @Published var error: String?
    @Published var loading = false

    func refresh() {
        loading = true
        Task { @MainActor in
            defer { loading = false }
            do {
                cards = try await gateway.workboardCards().compactMap(WorkboardCardRecord.init)
                error = nil
            } catch let caught { self.error = caught.localizedDescription }
        }
    }

}

struct WorkboardView: View {
    @StateObject private var store = WorkboardStore()
    private let columns = ["triage", "backlog", "todo", "scheduled", "ready", "running", "review", "blocked", "done"]

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Workboard Ledger").font(.largeTitle.bold())
                    Text("Gateway-reported plan and execution state for governed Missions")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button { store.refresh() } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.bordered)
            }
            Label("Create, review, activate, pause, and resume work from Missions. Workboard no longer has an ungoverned dispatch path.", systemImage: "checkmark.shield")
                .font(.callout)
                .foregroundStyle(.secondary)
            if !store.cards.isEmpty {
                ScrollView(.horizontal) {
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(columns, id: \.self) { column in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(column.uppercased()).font(.caption.bold()).foregroundStyle(.secondary)
                                ForEach(store.cards.filter { $0.status == column }) { card in
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(card.title).font(.headline)
                                        Text(card.priority).font(.caption).foregroundStyle(.secondary)
                                        if card.agent != "unassigned" { Label(card.agent, systemImage: "person") .font(.caption2) }
                                    }.padding(10).frame(width: 190, alignment: .leading).background(.quaternary.opacity(0.5)).clipShape(RoundedRectangle(cornerRadius: 8))
                                }
                                Spacer()
                            }.frame(width: 200, height: 280, alignment: .topLeading)
                        }
                    }.padding(.vertical, 4)
                }
            } else {
                ContentUnavailableView("No Workboard cards", systemImage: "rectangle.3.group", description: Text("Create an objective to begin the autonomy loop."))
            }
            if let error = store.error { Text(error).foregroundStyle(.red) }
        }
        .onAppear { store.refresh() }
    }
}
