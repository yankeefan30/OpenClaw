import SwiftUI

/// Alan's reviewed, exact-principal profile editor. Context and email
/// authority intentionally remain separate stores: knowing something about a
/// person never grants Rico permission to contact them or send email.
struct RicoPersonProfileSheet: View {
    let policy: RicoRecipientPolicy
    let contact: LocalContact?
    @ObservedObject var peopleProfiles: RicoPeopleProfileStore
    @ObservedObject var emailAuthorizations: RicoPersonEmailAuthorizationStore

    @Environment(\.dismiss) private var dismiss
    @State private var profileText = ""
    @State private var emailEnabled = false
    @State private var attachmentsAllowed = false
    @State private var recipientEmail = ""
    @State private var senderAccount: RicoEmailSenderAccount = .personalGmail
    @State private var localStatus = ""
    @State private var loaded = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    identityCard
                    contextCard
                    learningCard
                    emailCard
                    privacyCard
                }
                .padding(22)
            }
            Divider()
            HStack {
                Text(statusText)
                    .font(.caption)
                    .foregroundStyle(statusColor)
                    .lineLimit(2)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(16)
        }
        .frame(minWidth: 720, idealWidth: 780, minHeight: 690, idealHeight: 780)
        .onAppear { loadOnce() }
    }

    private var header: some View {
        HStack(spacing: 14) {
            Image(systemName: "person.text.rectangle.fill")
                .font(.title2)
                .foregroundStyle(StudioDesign.violet)
                .frame(width: 34, height: 34)
            VStack(alignment: .leading, spacing: 3) {
                Text("Rico profile for \(policy.displayName)")
                    .font(.title2.bold())
                Text("Reviewed context and exact email authority for this iMessage identity")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(20)
    }

    private var identityCard: some View {
        StudioCard(padding: 14) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "checkmark.shield.fill")
                    .foregroundStyle(policy.access == .blocked ? .red : .green)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Exact authenticated identity").font(.headline)
                    Text(policy.address)
                        .font(.callout.monospaced())
                        .textSelection(.enabled)
                    Text("The Contacts name is for display only. Rico authenticates this exact address.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                StudioStatusPill(
                    label: policy.access == .blocked ? "Blocked" : "Approved route",
                    color: policy.access == .blocked ? .red : .green,
                    symbol: policy.access == .blocked ? "hand.raised.fill" : "checkmark.shield.fill"
                )
            }
        }
    }

    private var contextCard: some View {
        StudioCard(padding: 16) {
            VStack(alignment: .leading, spacing: 11) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Custom instructions and background").font(.headline)
                        Text("One reviewed note per line. Use background:, instruction:, or preference: to describe its purpose.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    StudioStatusPill(
                        label: peopleProfiles.operational ? "Private store ready" : "Store unavailable",
                        color: peopleProfiles.operational ? .green : .red,
                        symbol: peopleProfiles.operational ? "lock.fill" : "exclamationmark.triangle.fill"
                    )
                }

                ZStack(alignment: .topLeading) {
                    TextEditor(text: $profileText)
                        .font(.body)
                        .frame(minHeight: 150)
                        .padding(7)
                        .scrollContentBackground(.hidden)
                        .background(.quaternary.opacity(0.18), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(.quaternary))
                    if profileText.isEmpty {
                        Text("background: Their role and relevant background\ninstruction: How Rico should respond to them\npreference: Tone, format, and communication preferences")
                            .font(.callout)
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 16)
                            .allowsHitTesting(false)
                    }
                }

                HStack {
                    Text("\(RicoPeopleContextParser.parse(profileText).count) reviewed note\(RicoPeopleContextParser.parse(profileText).count == 1 ? "" : "s")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Save reviewed profile") { saveProfile() }
                        .buttonStyle(.borderedProminent)
                        .tint(StudioDesign.violet)
                        .disabled(!peopleProfiles.operational)
                }
            }
        }
    }

    @ViewBuilder
    private var learningCard: some View {
        let candidates = peopleProfiles.pendingCandidates(for: policy.address)
        let approved = peopleProfiles.approvedLearnedItems(for: policy.address)
        StudioCard(padding: 16) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Learning suggestions").font(.headline)
                        Text("Conversation-derived notes remain untrusted until you approve each one.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text("\(candidates.count) pending")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(candidates.isEmpty ? Color.secondary : Color.orange)
                }
                if candidates.isEmpty {
                    Text("No suggestions need review. Rico cannot silently promote conversation content into a trusted profile.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(candidates) { candidate in
                        Divider().opacity(0.5)
                        VStack(alignment: .leading, spacing: 8) {
                            Text(candidateLabel(candidate.proposedKind))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(StudioDesign.violet)
                            Text(candidate.proposedText)
                                .font(.callout)
                                .textSelection(.enabled)
                            HStack {
                                Text("Confidence \(candidate.confidence.formatted(.percent.precision(.fractionLength(0))))")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Button("Reject", role: .destructive) {
                                    _ = peopleProfiles.reviewCandidate(candidate.id, address: policy.address, approve: false)
                                }
                                .buttonStyle(.bordered)
                                Button("Approve note") {
                                    _ = peopleProfiles.reviewCandidate(candidate.id, address: policy.address, approve: true)
                                    profileText = peopleProfiles.editorText(for: policy.address)
                                }
                                .buttonStyle(.borderedProminent)
                                .tint(StudioDesign.violet)
                            }
                        }
                    }
                }
                if !approved.isEmpty {
                    Divider().opacity(0.5)
                    Text("Approved learned notes")
                        .font(.subheadline.weight(.semibold))
                    ForEach(approved) { item in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(candidateLabel(item.kind))
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                Text(item.text).font(.callout).textSelection(.enabled)
                            }
                        }
                    }
                }
            }
        }
    }

    private var emailCard: some View {
        StudioCard(padding: 16) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Email authority").font(.headline)
                        Text("Outlook only · exact recipient and exact sender account · no fallback")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    StudioStatusPill(
                        label: "Delivery adapter unavailable",
                        color: .orange,
                        symbol: "exclamationmark.lock.fill"
                    )
                }

                Toggle("Allow Rico to email this person", isOn: $emailEnabled)
                    .toggleStyle(.switch)
                    .disabled(!canConfigureEmail)
                    .onChange(of: emailEnabled) { _, enabled in
                        if !enabled { attachmentsAllowed = false }
                    }
                Toggle("Allow email attachments", isOn: $attachmentsAllowed)
                    .toggleStyle(.switch)
                    .disabled(!emailEnabled || !canConfigureEmail)

                LabeledContent("Send only to") {
                    Picker("Recipient email", selection: $recipientEmail) {
                        if contactEmails.isEmpty { Text("No linked Contact email").tag("") }
                        ForEach(contactEmails, id: \.self) { Text($0).tag($0) }
                    }
                    .labelsHidden()
                    .frame(maxWidth: 360)
                }
                LabeledContent("Send from") {
                    Picker("Sender account", selection: $senderAccount) {
                        ForEach(RicoEmailSenderAccount.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .labelsHidden()
                    .frame(maxWidth: 360)
                }
                LabeledContent("Email client") {
                    Text("Microsoft Outlook").foregroundStyle(.secondary)
                }

                if !canConfigureEmail {
                    Label(emailConfigurationBlocker, systemImage: "person.crop.circle.badge.exclamationmark")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                Text("Rico will compose a complete, technical, fact-based email and append: “Rico an Autonmous Agent on behalf of Alan Rosa”. Permission can be saved now, but delivery remains blocked until the reviewed Outlook proof adapter is installed and healthy.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                HStack {
                    Spacer()
                    Button("Save email permission") { saveEmailAuthorization() }
                        .buttonStyle(.borderedProminent)
                        .tint(StudioDesign.violet)
                        .disabled(!emailAuthorizations.operational || (emailEnabled && !emailSelectionComplete))
                }
            }
        }
    }

    private var privacyCard: some View {
        StudioCard(padding: 16) {
            VStack(alignment: .leading, spacing: 8) {
                Label("Permanent private-source boundary", systemImage: "eye.slash.fill")
                    .font(.headline)
                    .foregroundStyle(.red)
                Text("Rico may use approved conversation-derived notes to improve an answer. He may never say or imply that the information came from a conversation, recording, transcript, meeting recording, lifelog, Limitless, or PLAUD. That rule is enforced again immediately before every text and email is delivered.")
                    .font(.callout)
                Text("Only public websites, legal cases, magazine articles, newspaper articles, and books may be cited or linked. Private files, messages, mail, recordings, and AI models may inform research but are never named as sources.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Divider().opacity(0.5)
                Text("Meeting requests")
                    .font(.subheadline.weight(.semibold))
                Text("Rico cannot create or change meetings. A qualifying request is handed to Janet through the separately governed Outlook path; no calendar mutation is permitted.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var contactEmails: [String] {
        guard contact?.id == policy.contactID else { return [] }
        return Array(Set((contact?.emails ?? []).compactMap(RicoPersonEmailAuthorization.normalizedEmail))).sorted()
    }

    private var canConfigureEmail: Bool {
        policy.groupChatID == nil && policy.access != .blocked && contact?.id == policy.contactID && !contactEmails.isEmpty
    }

    private var emailSelectionComplete: Bool {
        canConfigureEmail && contactEmails.contains(recipientEmail)
    }

    private var emailConfigurationBlocker: String {
        if policy.access == .blocked { return "This identity is blocked. Email authority cannot be granted." }
        if contact == nil || contact?.id != policy.contactID { return "Relink this identity to its exact macOS Contact before granting email authority." }
        return "The linked Contact has no email address available for review."
    }

    private var statusText: String {
        if !localStatus.isEmpty { return localStatus }
        if !emailAuthorizations.status.isEmpty { return emailAuthorizations.status }
        return peopleProfiles.status
    }

    private var statusColor: Color {
        let lower = statusText.lowercased()
        return lower.contains("unavailable") || lower.contains("not saved") || lower.contains("invalid") ? .red : .secondary
    }

    private func loadOnce() {
        guard !loaded else { return }
        loaded = true
        profileText = peopleProfiles.editorText(for: policy.address)
        if let authorization = emailAuthorizations.authorization(for: policy.address) {
            emailEnabled = authorization.email.enabled
            attachmentsAllowed = authorization.email.attachmentsAllowed
            recipientEmail = authorization.email.recipientEmail ?? ""
            senderAccount = authorization.email.senderAccount ?? .personalGmail
        } else {
            recipientEmail = contactEmails.first ?? ""
        }
    }

    private func saveProfile() {
        if peopleProfiles.saveReviewedText(profileText, for: policy.address, displayName: policy.displayName) {
            profileText = peopleProfiles.editorText(for: policy.address)
            localStatus = peopleProfiles.status
        } else {
            localStatus = peopleProfiles.status
        }
    }

    private func saveEmailAuthorization() {
        guard let contact, contact.id == policy.contactID else {
            localStatus = emailConfigurationBlocker
            return
        }
        let selectedRecipient = recipientEmail.isEmpty ? nil : recipientEmail
        let saved = emailAuthorizations.save(
            policy: policy,
            contact: contact,
            enabled: emailEnabled,
            attachmentsAllowed: attachmentsAllowed,
            recipientEmail: selectedRecipient,
            senderAccount: senderAccount
        )
        localStatus = emailAuthorizations.status
        if !saved { emailEnabled = emailAuthorizations.authorization(for: policy.address)?.email.enabled ?? false }
    }

    private func candidateLabel(_ kind: RicoPersonContextKind) -> String {
        switch kind {
        case .backgroundFact: "Background fact"
        case .customInstruction: "Custom instruction"
        case .communicationPreference: "Communication preference"
        }
    }
}
