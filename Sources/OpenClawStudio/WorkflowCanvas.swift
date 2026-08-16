import SwiftUI

struct CanvasStep: Identifiable {
    let id: String
    let type: String
    let channel: String?
    let detail: String
}

struct WorkflowCanvas: View {
    @Binding var yaml: String
    @State private var selectedID: String?
    @State private var showRaw = false

    private var steps: [CanvasStep] {
        var result: [CanvasStep] = []
        var current: (id: String, type: String?, channel: String?, detail: String?)?
        for line in yaml.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("- id:") {
                if let current { result.append(CanvasStep(id: current.id, type: current.type ?? "step", channel: current.channel, detail: current.detail ?? "")) }
                current = (value(after: "id:", in: trimmed), nil, nil, nil)
            } else if current != nil, trimmed.hasPrefix("type:") {
                current?.type = value(after: "type:", in: trimmed)
            } else if current != nil, trimmed.hasPrefix("channel:") {
                current?.channel = value(after: "channel:", in: trimmed)
            } else if current != nil, trimmed.hasPrefix("body:") || trimmed.hasPrefix("query:") || trimmed.hasPrefix("template:") {
                current?.detail = trimmed
            }
        }
        if let current { result.append(CanvasStep(id: current.id, type: current.type ?? "step", channel: current.channel, detail: current.detail ?? "")) }
        return result
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Workflow canvas").font(.headline)
                Spacer()
                Button(showRaw ? "Show canvas" : "Show YAML") { showRaw.toggle() }
                    .buttonStyle(.bordered)
            }
            if showRaw {
                TextEditor(text: $yaml)
                    .font(.system(.body, design: .monospaced))
                    .frame(minHeight: 260)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
            } else if steps.isEmpty {
                ContentUnavailableView("No steps", systemImage: "plus.rectangle.on.rectangle", description: Text("Add actions in YAML, then return to the canvas."))
                    .frame(minHeight: 180)
            } else {
                ScrollView(.horizontal) {
                    HStack(spacing: 0) {
                        ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                            HStack(spacing: 0) {
                                StepCard(step: step, selected: selectedID == step.id) { selectedID = step.id }
                                if index < steps.count - 1 {
                                    Image(systemName: "arrow.right").foregroundStyle(.secondary).padding(.horizontal, 8)
                                }
                            }
                        }
                    }.padding(8)
                }
                if let selected = steps.first(where: { $0.id == selectedID }) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Step inspector").font(.subheadline.bold())
                        Text(selected.id).font(.headline)
                        Text(selected.channel.map { "\(selected.type) · \($0)" } ?? selected.type).foregroundStyle(.secondary)
                        if !selected.detail.isEmpty { Text(selected.detail).font(.system(.caption, design: .monospaced)) }
                        Text("Edit parameters in YAML view. Changes are validated before save.")
                            .font(.caption).foregroundStyle(.secondary)
                    }.padding(10).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary.opacity(0.35)).clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
        }
    }

    private func value(after key: String, in line: String) -> String {
        line.components(separatedBy: key).dropFirst().joined(separator: key)
            .trimmingCharacters(in: .whitespaces)
            .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
    }
}

private struct StepCard: View {
    let step: CanvasStep
    let selected: Bool
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: icon).font(.title2)
                Text(step.id).font(.headline).lineLimit(1)
                Text(step.channel ?? step.type).font(.caption).foregroundStyle(.secondary)
                if !step.detail.isEmpty { Text(step.detail).font(.caption2).lineLimit(2).foregroundStyle(.secondary) }
            }
            .padding(12).frame(width: 170, height: 116, alignment: .topLeading)
            .background(selected ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(selected ? Color.accentColor : .clear, lineWidth: 2))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain)
    }

    private var icon: String {
        switch step.type {
        case "read": return "arrow.down.circle"
        case "write": return "paperplane"
        case "llm_summarize", "llm_reply": return "sparkles"
        case "if": return "arrow.triangle.branch"
        case "template": return "text.alignleft"
        default: return "circle.dotted"
        }
    }
}
