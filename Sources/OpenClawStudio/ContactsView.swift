import Contacts
import SwiftUI
import AppKit

struct LocalContact: Identifiable, Hashable {
    let id: String
    let name: String
    let phones: [String]
    let emails: [String]
}

enum ContactResolution: Equatable {
    case noMatch
    case unique(LocalContact)
    case ambiguous([LocalContact])
}

enum ContactResolver {
    static func resolve(_ query: String, in contacts: [LocalContact]) -> ContactResolution {
        let needle = normalizedName(query)
        guard !needle.isEmpty else { return .noMatch }
        let exact = contacts.filter { normalizedName($0.name) == needle }
        if exact.count == 1, let contact = exact.first { return .unique(contact) }
        if exact.count > 1 { return .ambiguous(exact) }
        let prefix = contacts.filter { normalizedName($0.name).hasPrefix(needle) }
        if prefix.count == 1, let contact = prefix.first { return .unique(contact) }
        if prefix.count > 1 { return .ambiguous(prefix) }
        let contains = contacts.filter { normalizedName($0.name).contains(needle) }
        if contains.count == 1, let contact = contains.first { return .unique(contact) }
        return contains.isEmpty ? .noMatch : .ambiguous(contains)
    }

    static func normalizedPhone(_ value: String) -> String {
        let digits = value.filter(\.isNumber)
        if value.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("+") { return "+" + digits }
        if digits.count == 10 { return "+1" + digits }
        if digits.count == 11, digits.hasPrefix("1") { return "+" + digits }
        return digits
    }

    private static func normalizedName(_ value: String) -> String {
        value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .split(whereSeparator: { $0.isWhitespace || $0 == "-" })
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum ContactsAuthorizationPolicy {
    static func canRead(_ status: CNAuthorizationStatus) -> Bool {
        // CNAuthorizationStatus.limited is explicitly unavailable on macOS.
        status == .authorized
    }
}

struct ContactsRepairResult: Sendable, Equatable {
    let succeeded: Bool
    let detail: String
}

enum ContactsPermissionRepair {
    static func arguments(bundleIdentifier: String) -> [String] {
        ["reset", "AddressBook", bundleIdentifier]
    }

    /// Uses Apple's supported privacy reset utility for this bundle only.
    /// The action is invoked solely from the explicit Repair button in Studio.
    static func reset(bundleIdentifier: String) -> ContactsRepairResult {
        guard !bundleIdentifier.isEmpty else {
            return ContactsRepairResult(succeeded: false, detail: "The packaged app bundle identifier is unavailable.")
        }
        let process = Process()
        let output = Pipe()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
        process.arguments = arguments(bundleIdentifier: bundleIdentifier)
        process.standardOutput = output
        process.standardError = errors
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return ContactsRepairResult(succeeded: false, detail: error.localizedDescription)
        }
        let stdout = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let detail = [stderr, stdout]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? "Contacts permission reset failed."
        return ContactsRepairResult(
            succeeded: process.terminationReason == .exit && process.terminationStatus == 0,
            detail: detail
        )
    }
}

@MainActor
final class ContactsStore: ObservableObject {
    @Published private(set) var contacts: [LocalContact] = []
    @Published private(set) var authorization: CNAuthorizationStatus = CNContactStore.authorizationStatus(for: .contacts)
    @Published var error: String?
    @Published var loading = false
    @Published private(set) var repairRequiresRelaunch = false

    private let contactStore = CNContactStore()

    var canReadContacts: Bool {
        ContactsAuthorizationPolicy.canRead(authorization)
    }

    func load() {
        refreshAuthorization()
        if authorization == .notDetermined {
            requestAccess()
        } else if canReadContacts {
            readContacts()
        } else {
            contacts = []
            loading = false
        }
    }

    func requestAccess() {
        authorization = CNContactStore.authorizationStatus(for: .contacts)
        if authorization == .denied || authorization == .restricted {
            error = "Contacts access is disabled in System Settings. Enable OpenClaw Studio under Privacy & Security → Contacts."
            openPrivacySettings()
            return
        }
        if canReadContacts {
            readContacts()
            return
        }
        loading = true
        error = nil
        repairRequiresRelaunch = false
        contactStore.requestAccess(for: .contacts) { [weak self] granted, requestError in
            Task { @MainActor in
                guard let self else { return }
                self.authorization = CNContactStore.authorizationStatus(for: .contacts)
                if granted {
                    self.readContacts()
                } else {
                    self.error = requestError?.localizedDescription ?? "Contacts permission was not granted."
                    self.loading = false
                }
            }
        }
    }

    func repairAccess() {
        authorization = CNContactStore.authorizationStatus(for: .contacts)
        guard authorization == .denied else {
            requestAccess()
            return
        }
        guard let bundleIdentifier = Bundle.main.bundleIdentifier,
              bundleIdentifier == "ai.openclaw.studio" else {
            error = "Contacts repair is available only from the packaged OpenClaw Studio app."
            return
        }
        loading = true
        error = nil
        Task { [weak self] in
            let result = await Task.detached(priority: .userInitiated) {
                ContactsPermissionRepair.reset(bundleIdentifier: bundleIdentifier)
            }.value
            guard let self else { return }
            guard result.succeeded else {
                self.loading = false
                self.error = result.detail
                return
            }
            try? await Task.sleep(for: .milliseconds(350))
            self.authorization = CNContactStore.authorizationStatus(for: .contacts)
            if self.authorization == .notDetermined {
                self.requestAccess()
            } else if self.canReadContacts {
                self.readContacts()
            } else {
                self.loading = false
                self.repairRequiresRelaunch = true
                self.error = "The stale decision was cleared. Quit and reopen OpenClaw Studio once, then approve Contacts."
            }
        }
    }

    func openPrivacySettings() {
        let urls = [
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts",
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Contacts"
        ]
        for value in urls {
            if let url = URL(string: value), NSWorkspace.shared.open(url) { return }
        }
        error = "Open System Settings → Privacy & Security → Contacts and enable OpenClaw Studio."
    }

    var authorizationLabel: String {
        switch authorization {
        case .notDetermined: "Not requested"
        case .restricted: "Restricted"
        case .denied: "Denied"
        case .authorized: "Allowed"
        case .limited: "Limited"
        @unknown default: "Unknown"
        }
    }

    func refreshAuthorization() {
        authorization = CNContactStore.authorizationStatus(for: .contacts)
        if canReadContacts {
            repairRequiresRelaunch = false
            readContacts()
        } else {
            contacts = []
            loading = false
        }
    }

    private func readContacts() {
        do {
            let keys: [CNKeyDescriptor] = [
                CNContactGivenNameKey as CNKeyDescriptor,
                CNContactFamilyNameKey as CNKeyDescriptor,
                CNContactOrganizationNameKey as CNKeyDescriptor,
                CNContactPhoneNumbersKey as CNKeyDescriptor,
                CNContactEmailAddressesKey as CNKeyDescriptor
            ]
            let request = CNContactFetchRequest(keysToFetch: keys)
            var loaded: [LocalContact] = []
            try contactStore.enumerateContacts(with: request) { contact, _ in
                let name = [contact.givenName, contact.familyName]
                    .filter { !$0.isEmpty }
                    .joined(separator: " ")
                let displayName = name.isEmpty ? (contact.organizationName.isEmpty ? "Unnamed contact" : contact.organizationName) : name
                loaded.append(LocalContact(
                    id: contact.identifier,
                    name: displayName,
                    phones: contact.phoneNumbers.map(\.value.stringValue),
                    emails: contact.emailAddresses.map { String($0.value) }
                ))
            }
            contacts = loaded.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            error = nil
        } catch let fetchError {
            error = fetchError.localizedDescription
        }
        loading = false
    }
}

struct ContactsView: View {
    @StateObject private var store = ContactsStore()
    @State private var query = ""

    private var filtered: [LocalContact] {
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return store.contacts }
        return store.contacts.filter {
            $0.name.localizedCaseInsensitiveContains(query) ||
            $0.phones.contains { $0.localizedCaseInsensitiveContains(query) } ||
            $0.emails.contains { $0.localizedCaseInsensitiveContains(query) }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Contacts").font(.largeTitle.bold())
                    Text("\(store.contacts.count) contacts available from macOS Contacts").foregroundStyle(.secondary)
                    Text("Permission: \(store.authorizationLabel) · App: \(Bundle.main.bundleIdentifier ?? "unbundled executable")")
                        .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
                Spacer()
                Button(store.authorization == .denied ? "Repair Contacts Access" : "Request Contacts Access") {
                    if store.authorization == .denied {
                        store.repairAccess()
                    } else {
                        store.requestAccess()
                    }
                }
                    .buttonStyle(.borderedProminent)
                    .disabled(store.canReadContacts || store.loading)
                Button("Refresh") { store.refreshAuthorization(); store.load() }
                    .buttonStyle(.bordered)
            }
            if store.authorization == .denied || store.authorization == .restricted {
                permissionCard
            } else {
                TextField("Search contacts", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("contacts.search")
                if store.loading {
                    ProgressView("Loading contacts…")
                } else if let error = store.error {
                    Text(error).foregroundStyle(.red)
                } else if filtered.isEmpty {
                    ContentUnavailableView("No contacts found", systemImage: "person.crop.circle.badge.questionmark")
                } else {
                    List(filtered) { contact in
                        HStack(spacing: 12) {
                            Image(systemName: "person.crop.circle.fill").foregroundStyle(.blue)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(contact.name).font(.headline)
                                let details = (contact.phones + contact.emails).joined(separator: " · ")
                                if !details.isEmpty { Text(details).font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer()
                        }
                        .padding(.vertical, 4)
                    }
                    .listStyle(.inset)
                }
            }
        }
        .onAppear { store.load() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            store.refreshAuthorization()
        }
    }

    private var permissionCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Contacts access is disabled", systemImage: "lock.shield")
                .font(.headline)
            Text("Open System Settings → Privacy & Security → Contacts and enable OpenClaw Studio. The app reads contacts locally and does not upload them.")
                .foregroundStyle(.secondary)
            if store.authorization == .denied {
                Text("Repair clears only OpenClaw Studio's stale Contacts decision, then asks macOS again. Other apps and privacy settings are unchanged.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Repair Contacts Access") { store.repairAccess() }
                    .buttonStyle(.borderedProminent)
                    .disabled(store.loading)
            }
            if store.loading {
                ProgressView("Repairing this app's Contacts decision…")
            }
            if let error = store.error {
                Text(error)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
            if store.repairRequiresRelaunch {
                Button("Quit OpenClaw Studio") { NSApp.terminate(nil) }
                    .buttonStyle(.borderedProminent)
            }
            Button("Open Contacts Privacy Settings") { store.openPrivacySettings() }
                .buttonStyle(.bordered)
        }
        .padding(18)
        .background(.background)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary))
    }
}
