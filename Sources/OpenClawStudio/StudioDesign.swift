import SwiftUI

enum StudioDesign {
    static let accent = Color(red: 0.35, green: 0.82, blue: 0.72)
    static let violet = Color(red: 0.52, green: 0.46, blue: 0.96)
    static let coral = Color(red: 0.98, green: 0.48, blue: 0.38)
    static let panelRadius: CGFloat = 18
}

struct StudioStatusPill: View {
    let label: String
    let color: Color
    var symbol: String = "circle.fill"

    var body: some View {
        Label(label, systemImage: symbol)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(color.opacity(0.11), in: Capsule())
            .overlay(Capsule().stroke(color.opacity(0.18)))
    }
}

struct StudioCard<Content: View>: View {
    var padding: CGFloat = 18
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .padding(padding)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: StudioDesign.panelRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: StudioDesign.panelRadius, style: .continuous).stroke(.white.opacity(0.07)))
    }
}

struct StudioBackdrop: View {
    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
            RadialGradient(colors: [StudioDesign.violet.opacity(0.13), .clear], center: .topLeading, startRadius: 20, endRadius: 700)
            RadialGradient(colors: [StudioDesign.accent.opacity(0.09), .clear], center: .bottomTrailing, startRadius: 10, endRadius: 650)
        }.ignoresSafeArea()
    }
}
