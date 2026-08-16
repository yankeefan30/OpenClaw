import SwiftUI
import Foundation
import AppKit
import Security
import ServiceManagement

struct ConnectionSettings: Sendable {
    let endpoint: String
    let token: String?
}

enum KeychainStore {
    private static let service = "ai.openclaw.studio"
    private static let account = "gateway-token"

    static func readToken() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func replaceToken(_ token: String) throws {
        let data = Data(token.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let attributes: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            let addStatus = SecItemAdd(item as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw AppSupportError.keychain(addStatus) }
        } else if status != errSecSuccess {
            throw AppSupportError.keychain(status)
        }
    }

    static func deleteToken() throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw AppSupportError.keychain(status) }
    }
}

enum AppearanceMode: String, CaseIterable, Identifiable {
    case system = "System", light = "Light", dark = "Dark"
    var id: String { rawValue }
    var colorScheme: ColorScheme? {
        switch self { case .system: nil; case .light: .light; case .dark: .dark }
    }
}

@MainActor
final class AppPreferences: ObservableObject {
    @Published var endpoint: String { didSet { defaults.set(endpoint, forKey: "endpoint") } }
    @Published var refreshSeconds: Double { didSet { defaults.set(refreshSeconds, forKey: "refreshSeconds") } }
    @Published var appearance: AppearanceMode { didSet { defaults.set(appearance.rawValue, forKey: "appearance") } }
    @Published var launchAtLogin: Bool { didSet { defaults.set(launchAtLogin, forKey: "launchAtLogin"); LoginItemManager.setEnabled(launchAtLogin) } }
    @Published var completedSetup: Bool { didSet { defaults.set(completedSetup, forKey: "completedSetup") } }
    private let defaults = UserDefaults.standard

    init() {
        endpoint = defaults.string(forKey: "endpoint") ?? LocalGatewayDetector.detect() ?? "ws://127.0.0.1:18789"
        refreshSeconds = max(5, defaults.double(forKey: "refreshSeconds") == 0 ? 15 : defaults.double(forKey: "refreshSeconds"))
        appearance = AppearanceMode(rawValue: defaults.string(forKey: "appearance") ?? "") ?? .system
        launchAtLogin = defaults.bool(forKey: "launchAtLogin")
        completedSetup = defaults.bool(forKey: "completedSetup")
    }

    func resetLocalState() {
        let preserved = endpoint
        defaults.removePersistentDomain(forName: Bundle.main.bundleIdentifier ?? "ai.openclaw.studio")
        AuditStore.clear()
        endpoint = preserved
        refreshSeconds = 15
        appearance = .system
        launchAtLogin = false
        completedSetup = false
    }
}

enum LocalGatewayDetector {
    static func detect() -> String? {
        let url = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".openclaw/openclaw.json")
        guard let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let gateway = root["gateway"] as? [String: Any],
              let port = gateway["port"] as? Int else { return nil }
        let tls = gateway["tls"] as? [String: Any]
        return (tls?["enabled"] as? Bool == true ? "wss" : "ws") + "://127.0.0.1:\(port)"
    }
}

enum LoginItemManager {
    static var status: SMAppService.Status { SMAppService.mainApp.status }
    static func setEnabled(_ enabled: Bool) {
        do {
            if enabled { if status != .enabled { try SMAppService.mainApp.register() } }
            else if status == .enabled { try SMAppService.mainApp.unregister() }
        } catch { /* surfaced by the next settings refresh; never changes Gateway state */ }
    }
}

enum AppSupportError: LocalizedError {
    case keychain(OSStatus)
    case invalidEndpoint
    case resetFailed
    var errorDescription: String? {
        switch self {
        case .keychain(let status): "Keychain operation failed (\(status))."
        case .invalidEndpoint: "Enter a valid ws:// or wss:// Gateway endpoint."
        case .resetFailed: "App-local reset could not be completed."
        }
    }
}

enum DiagnosticsExporter {
    static func export(settings: ConnectionSettings, gatewayVersion: String, destination: URL) throws {
        let text = """
        OpenClaw Studio diagnostics
        App version: \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "development")
        Protocol: 4
        Gateway version: \(gatewayVersion)
        Endpoint: \(redactEndpoint(settings.endpoint))
        Credential: [REDACTED]
        Personal content: [REDACTED]
        """
        guard let data = text.data(using: .utf8) else { throw AppSupportError.resetFailed }
        try data.write(to: destination, options: .atomic)
    }
    private static func redactEndpoint(_ endpoint: String) -> String {
        guard let url = URL(string: endpoint), let scheme = url.scheme else { return "[REDACTED]" }
        return "\(scheme)://[REDACTED]"
    }
}

struct SetupWizard: View {
    @ObservedObject var preferences: AppPreferences
    @Environment(\.dismiss) private var dismiss
    @State private var token = ""
    @State private var status = ""
    @State private var testing = false
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Set up OpenClaw Studio").font(.largeTitle.bold())
            Text("Connect to your local OpenClaw Gateway or enter a trusted ws:// or wss:// endpoint. Loopback still requires valid Gateway authentication.")
                .foregroundStyle(.secondary)
            TextField("Gateway endpoint", text: $preferences.endpoint).textFieldStyle(.roundedBorder).accessibilityIdentifier("setup.endpoint")
            SecureField("Gateway token (stored in Keychain)", text: $token).textFieldStyle(.roundedBorder).accessibilityIdentifier("setup.token")
            Text("OpenClaw Studio keeps Gateway authentication and TLS intact. Reviewed Rico, automation, and MCP changes are applied only through OpenClaw's supported interfaces.")
                .font(.caption).foregroundStyle(.secondary)
            if !status.isEmpty { Text(status).font(.callout).foregroundStyle(status.hasPrefix("Connected") ? .green : .red) }
            HStack { Spacer(); Button("Test Connection") { testConnection() }.disabled(testing).accessibilityIdentifier("setup.testConnection"); Button("Save & Continue") { save() }.buttonStyle(.borderedProminent).accessibilityIdentifier("setup.save") }
        }
        .padding(30).frame(width: 560)
    }
    private func testConnection() {
        testing = true; status = "Testing…"
        Task {
            do {
                let settings = try persistToken()
                let health = try await GatewayClient().health(settings: settings)
                status = "Connected\(health.version.map { " · \($0)" } ?? "")"
            } catch { status = error.localizedDescription }
            testing = false
        }
    }
    private func persistToken() throws -> ConnectionSettings {
        guard let url = URL(string: preferences.endpoint),
              url.scheme == "ws" || url.scheme == "wss",
              url.host != nil,
              url.user == nil,
              url.password == nil,
              url.query == nil else { throw AppSupportError.invalidEndpoint }
        if !token.isEmpty { try KeychainStore.replaceToken(token) }
        return ConnectionSettings(endpoint: preferences.endpoint, token: KeychainStore.readToken())
    }
    private func save() {
        do { _ = try persistToken(); preferences.completedSetup = true; dismiss() }
        catch { status = error.localizedDescription }
    }
}

struct AboutView: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "circle.hexagongrid.fill").font(.system(size: 42)).foregroundStyle(.orange)
            Text("OpenClaw Studio").font(.title.bold())
            Text("App \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "development")")
            Text("OpenClaw \(UserDefaults.standard.string(forKey: "gatewayVersion") ?? "detected at connection")")
            Text("Gateway protocol v4").foregroundStyle(.secondary)
            Button("Close") { dismiss() }.buttonStyle(.borderedProminent)
        }.padding(30).frame(width: 360)
    }
}

struct PreferencesView: View {
    @EnvironmentObject private var preferences: AppPreferences
    @Environment(\.dismiss) private var dismiss
    @State private var token = ""
    @State private var message = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("OpenClaw Studio Settings").font(.title2.bold())
            TextField("Gateway endpoint", text: $preferences.endpoint).textFieldStyle(.roundedBorder).accessibilityIdentifier("settings.endpoint")
            SecureField("Replace Keychain token", text: $token).textFieldStyle(.roundedBorder).accessibilityIdentifier("settings.token")
            Picker("Appearance", selection: $preferences.appearance) { ForEach(AppearanceMode.allCases) { Text($0.rawValue).tag($0) } }.accessibilityIdentifier("settings.appearance")
            HStack { Text("Refresh every \(Int(preferences.refreshSeconds)) seconds"); Slider(value: $preferences.refreshSeconds, in: 5...300, step: 5).accessibilityIdentifier("settings.refreshInterval") }
            Toggle("Launch at login", isOn: $preferences.launchAtLogin).accessibilityIdentifier("settings.launchAtLogin")
            if !message.isEmpty { Text(message).font(.callout).foregroundStyle(.secondary) }
            HStack {
                Button("Replace Token") {
                    do { try KeychainStore.replaceToken(token); token = ""; message = "Keychain credential replaced." }
                    catch { message = error.localizedDescription }
                }.disabled(token.isEmpty)
                Button("Export Diagnostics") {
                    let panel = NSSavePanel()
                    panel.nameFieldStringValue = "openclaw-studio-diagnostics.txt"
                    if panel.runModal() == .OK, let url = panel.url {
                        do {
                            try DiagnosticsExporter.export(settings: ConnectionSettings(endpoint: preferences.endpoint, token: nil), gatewayVersion: "redacted until connected", destination: url)
                            message = "Redacted diagnostics exported."
                        } catch { message = error.localizedDescription }
                    }
                }.accessibilityIdentifier("settings.exportDiagnostics")
                Button("Reset App Data", role: .destructive) { preferences.resetLocalState(); message = "Local preferences reset. Gateway configuration was not changed." }
                Spacer(); Button("Done") { dismiss() }.buttonStyle(.borderedProminent)
            }
            Divider()
            Text("Diagnostics exports redact the Gateway token, endpoint credentials, and personal content.").font(.caption).foregroundStyle(.secondary)
        }.padding(28).frame(width: 560)
    }
}
