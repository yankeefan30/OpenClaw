import CryptoKit
import Darwin
import Foundation

enum RicoEmailSenderAccount: String, Codable, CaseIterable, Identifiable, Sendable {
    case personalGmail = "alan.a.rosa@gmail.com"
    case cvsHealth = "alan.rosa@cvshealth.com"
    var id: String { rawValue }
}

struct RicoPersonEmailSettings: Codable, Hashable, Sendable {
    var enabled: Bool
    var attachmentsAllowed: Bool
    var recipientEmail: String?
    var recipientSource: RicoEmailRecipientSource?
    var senderAccount: RicoEmailSenderAccount?
    var client = "outlook"
}

struct RicoEmailRecipientSource: Codable, Hashable, Sendable {
    var kind = "macos-contacts-reviewed-email"
    var contactIdentifierHash: String
    var emailValueHash: String
    var reviewedAt: Date
}

struct RicoPersonEmailAuthorization: Codable, Identifiable, Hashable, Sendable {
    var schema = "rico.person-email-authorization"
    var schemaVersion = 1
    var profileId: String
    var contactIdentifierHash: String
    var displayName: String
    var principal: RicoPersonPrincipal
    var email: RicoPersonEmailSettings
    var revision: Int
    var authorizedAt: Date

    var id: String { profileId }

    var validationErrors: [String] {
        var errors: [String] = []
        if schema != "rico.person-email-authorization" || schemaVersion != 1 {
            errors.append("Unsupported person email authorization schema.")
        }
        if profileId.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", options: .regularExpression) == nil {
            errors.append("Profile ID is invalid.")
        }
        if contactIdentifierHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) == nil {
            errors.append("The linked Contacts identity is invalid.")
        }
        if !principal.isCanonical { errors.append("One exact authenticated iMessage principal is required.") }
        let safeName = RicoPeopleContextSanitizer.displayName(displayName)
        if safeName.isEmpty || safeName != displayName { errors.append("Display name is invalid.") }
        if email.client != "outlook" { errors.append("Rico email must use Microsoft Outlook.") }
        if !email.enabled && email.attachmentsAllowed { errors.append("Attachment permission requires email permission.") }
        if let recipient = email.recipientEmail, Self.normalizedEmail(recipient) != recipient {
            errors.append("Recipient email is not canonical.")
        }
        if email.recipientEmail == nil && email.recipientSource != nil {
            errors.append("Recipient provenance requires an exact recipient email.")
        }
        if let recipient = email.recipientEmail {
            guard let source = email.recipientSource else {
                errors.append("Recipient email needs reviewed Contacts provenance.")
                return errors
            }
            if source.kind != "macos-contacts-reviewed-email" ||
                source.contactIdentifierHash != contactIdentifierHash ||
                source.emailValueHash != Self.digest(recipient) {
                errors.append("Recipient email no longer matches the reviewed Contacts address.")
            }
        }
        if email.enabled && (email.recipientEmail == nil || email.senderAccount == nil) {
            errors.append("Email permission needs one exact recipient and one exact sender account.")
        }
        if revision < 1 { errors.append("Authorization revision is invalid.") }
        return errors
    }

    static func normalizedEmail(_ raw: String) -> String? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard value.count <= 254,
              value.range(of: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", options: .regularExpression) != nil else { return nil }
        return value
    }

    static func stableProfileID(for principal: RicoPersonPrincipal) -> String {
        "person:\(digest(principal.handle))"
    }

    static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

struct RicoPersonEmailAuthorizationArchive: Codable, Hashable, Sendable {
    var schema = "rico.person-email-authorizations"
    var schemaVersion = 1
    var authorizations: [RicoPersonEmailAuthorization]

    var isCanonical: Bool {
        schema == "rico.person-email-authorizations" && schemaVersion == 1 &&
            authorizations.allSatisfy { $0.validationErrors.isEmpty } &&
            Set(authorizations.map(\.principal)).count == authorizations.count &&
            Set(authorizations.map(\.profileId)).count == authorizations.count
    }
}

enum RicoPersonEmailReview {
    static func reviewedRecipient(
        policy: RicoRecipientPolicy,
        contact: LocalContact,
        requestedEmail: String?,
        enabled: Bool
    ) -> String? {
        guard policy.groupChatID == nil,
              policy.access == .approved || policy.access == .trusted,
              policy.contactID == contact.id,
              RicoPersonPrincipal(authenticatedHandle: policy.address) != nil else { return nil }
        let reviewed = Set(contact.emails.compactMap(RicoPersonEmailAuthorization.normalizedEmail))
        guard let requestedEmail else { return nil }
        guard let canonical = RicoPersonEmailAuthorization.normalizedEmail(requestedEmail),
              reviewed.contains(canonical) else { return nil }
        return canonical
    }
}

enum RicoPersonEmailStoreError: LocalizedError {
    case unsafeStorage
    case invalidArchive
    case writeFailed

    var errorDescription: String? {
        switch self {
        case .unsafeStorage: "Rico email authorization storage is not private."
        case .invalidArchive: "Rico email authorization data is invalid."
        case .writeFailed: "Rico email authorization could not be written."
        }
    }
}

enum RicoPersonEmailPersistence {
    static var directory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/OpenClaw Studio/rico-email-governance", isDirectory: true)
    }
    static var archiveURL: URL { directory.appendingPathComponent("person-authorizations.json") }

    static func load() throws -> RicoPersonEmailAuthorizationArchive {
        try require(directory, mode: 0o700, kind: S_IFDIR)
        try require(archiveURL, mode: 0o600, kind: S_IFREG)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let value = try decoder.decode(RicoPersonEmailAuthorizationArchive.self, from: Data(contentsOf: archiveURL))
        guard value.isCanonical else { throw RicoPersonEmailStoreError.invalidArchive }
        return value
    }

    static func save(_ value: RicoPersonEmailAuthorizationArchive) throws {
        guard value.isCanonical else { throw RicoPersonEmailStoreError.invalidArchive }
        if FileManager.default.fileExists(atPath: directory.path) {
            try require(directory, mode: 0o700, kind: S_IFDIR)
        } else {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            guard chmod(directory.path, 0o700) == 0 else { throw RicoPersonEmailStoreError.writeFailed }
            try require(directory, mode: 0o700, kind: S_IFDIR)
        }
        if FileManager.default.fileExists(atPath: archiveURL.path) {
            try require(archiveURL, mode: 0o600, kind: S_IFREG)
        }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(value)
        let temporary = directory.appendingPathComponent(".person-authorizations.\(UUID().uuidString).tmp")
        let descriptor = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw RicoPersonEmailStoreError.writeFailed }
        var finished = false
        defer {
            Darwin.close(descriptor)
            if !finished { try? FileManager.default.removeItem(at: temporary) }
        }
        let wrote = data.withUnsafeBytes { buffer -> Bool in
            guard var base = buffer.baseAddress else { return data.isEmpty }
            var remaining = buffer.count
            while remaining > 0 {
                let count = Darwin.write(descriptor, base, remaining)
                if count <= 0 { return false }
                remaining -= count
                base = base.advanced(by: count)
            }
            return true
        }
        guard wrote, fsync(descriptor) == 0,
              Darwin.rename(temporary.path, archiveURL.path) == 0 else { throw RicoPersonEmailStoreError.writeFailed }
        finished = true
        try require(archiveURL, mode: 0o600, kind: S_IFREG)
    }

    private static func require(_ url: URL, mode: mode_t, kind: mode_t) throws {
        var value = stat()
        guard lstat(url.path, &value) == 0,
              value.st_mode & S_IFMT == kind,
              value.st_mode & 0o777 == mode,
              value.st_uid == getuid() else { throw RicoPersonEmailStoreError.unsafeStorage }
    }
}

@MainActor
final class RicoPersonEmailAuthorizationStore: ObservableObject {
    @Published private(set) var archive = RicoPersonEmailAuthorizationArchive(authorizations: [])
    @Published private(set) var operational = false
    @Published private(set) var status = ""

    init() { reload() }

    func reload() {
        do {
            if FileManager.default.fileExists(atPath: RicoPersonEmailPersistence.archiveURL.path) {
                archive = try RicoPersonEmailPersistence.load()
            } else {
                archive = RicoPersonEmailAuthorizationArchive(authorizations: [])
                try RicoPersonEmailPersistence.save(archive)
            }
            operational = true
            status = "Email authorizations are stored privately. Delivery remains blocked until Outlook runtime proof is healthy."
        } catch {
            operational = false
            status = "Email authorizations are unavailable: \(error.localizedDescription)"
        }
    }

    func authorization(for address: String) -> RicoPersonEmailAuthorization? {
        guard let principal = RicoPersonPrincipal(authenticatedHandle: address) else { return nil }
        let matches = archive.authorizations.filter { $0.principal == principal }
        return matches.count == 1 ? matches[0] : nil
    }

    @discardableResult
    func save(
        policy: RicoRecipientPolicy,
        contact: LocalContact,
        enabled: Bool,
        attachmentsAllowed: Bool,
        recipientEmail: String?,
        senderAccount: RicoEmailSenderAccount?,
        now: Date = Date()
    ) -> Bool {
        guard operational,
              let principal = RicoPersonPrincipal(authenticatedHandle: policy.address) else {
            status = "Email permission requires one exact authenticated iMessage identity."
            return false
        }
        let safeName = RicoPeopleContextSanitizer.displayName(policy.displayName)
        let canonicalRecipient = RicoPersonEmailReview.reviewedRecipient(
            policy: policy,
            contact: contact,
            requestedEmail: recipientEmail,
            enabled: enabled
        )
        guard (!enabled || canonicalRecipient != nil),
              policy.groupChatID == nil,
              policy.access == .approved || policy.access == .trusted,
              policy.contactID == contact.id else {
            status = "The recipient must be one exact email address currently attached to the linked macOS Contact."
            return false
        }
        let contactHash = RicoPersonEmailAuthorization.digest(contact.id)
        let previous = authorization(for: policy.address)
        let value = RicoPersonEmailAuthorization(
            profileId: previous?.profileId ?? RicoPersonEmailAuthorization.stableProfileID(for: principal),
            contactIdentifierHash: contactHash,
            displayName: safeName,
            principal: principal,
            email: RicoPersonEmailSettings(
                enabled: enabled,
                attachmentsAllowed: enabled && attachmentsAllowed,
                recipientEmail: canonicalRecipient,
                recipientSource: canonicalRecipient.map {
                    RicoEmailRecipientSource(
                        contactIdentifierHash: contactHash,
                        emailValueHash: RicoPersonEmailAuthorization.digest($0),
                        reviewedAt: now
                    )
                },
                senderAccount: senderAccount
            ),
            revision: (previous?.revision ?? 0) + 1,
            authorizedAt: now
        )
        guard value.validationErrors.isEmpty else {
            status = value.validationErrors.joined(separator: " ")
            return false
        }
        var proposed = archive
        proposed.authorizations.removeAll { $0.principal == principal || $0.profileId == value.profileId }
        proposed.authorizations.append(value)
        do {
            try RicoPersonEmailPersistence.save(proposed)
            archive = proposed
            status = enabled
                ? "Authorized Outlook email to \(safeName) from \(senderAccount?.rawValue ?? "no account")."
                : "Email permission is off for \(safeName)."
            return true
        } catch {
            operational = false
            status = "Email permission was not saved: \(error.localizedDescription)"
            return false
        }
    }

    @discardableResult
    func remove(for address: String) -> Bool {
        guard let principal = RicoPersonPrincipal(authenticatedHandle: address) else { return false }
        var proposed = archive
        proposed.authorizations.removeAll { $0.principal == principal }
        guard proposed != archive else { return false }
        do {
            try RicoPersonEmailPersistence.save(proposed)
            archive = proposed
            status = "Removed this person's email authorization."
            return true
        } catch {
            status = "Email authorization was not removed: \(error.localizedDescription)"
            return false
        }
    }
}
