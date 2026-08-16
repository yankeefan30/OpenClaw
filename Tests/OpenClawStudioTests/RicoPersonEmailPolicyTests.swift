import Foundation
import Testing
@testable import OpenClawStudio

@Suite("Rico person email authorization")
struct RicoPersonEmailPolicyTests {
    @Test("email and attachment permissions are separate and Outlook-only")
    func independentAuthority() {
        let principal = RicoPersonPrincipal(authenticatedHandle: "+15550000001")!
        let valid = RicoPersonEmailAuthorization(
            profileId: RicoPersonEmailAuthorization.stableProfileID(for: principal),
            contactIdentifierHash: String(repeating: "c", count: 64),
            displayName: "Example Person",
            principal: principal,
            email: .init(
                enabled: true,
                attachmentsAllowed: false,
                recipientEmail: "person@example.com",
                recipientSource: .init(
                    contactIdentifierHash: String(repeating: "c", count: 64),
                    emailValueHash: RicoPersonEmailAuthorization.digest("person@example.com"),
                    reviewedAt: Date()
                ),
                senderAccount: .personalGmail
            ),
            revision: 1,
            authorizedAt: Date()
        )
        #expect(valid.validationErrors.isEmpty)
        var invalid = valid
        invalid.email.enabled = false
        invalid.email.attachmentsAllowed = true
        #expect(invalid.validationErrors.contains("Attachment permission requires email permission."))
        invalid = valid
        invalid.email.client = "gmail"
        #expect(invalid.validationErrors.contains("Rico email must use Microsoft Outlook."))
    }

    @Test("enabled email needs an exact recipient and approved sender")
    func completeAuthority() {
        let principal = RicoPersonPrincipal(authenticatedHandle: "+15550000001")!
        let value = RicoPersonEmailAuthorization(
            profileId: RicoPersonEmailAuthorization.stableProfileID(for: principal),
            contactIdentifierHash: String(repeating: "c", count: 64),
            displayName: "Example Person",
            principal: principal,
            email: .init(enabled: true, attachmentsAllowed: false, recipientEmail: nil, recipientSource: nil, senderAccount: nil),
            revision: 1,
            authorizedAt: Date()
        )
        #expect(value.validationErrors.contains("Email permission needs one exact recipient and one exact sender account."))
        #expect(Set(RicoEmailSenderAccount.allCases.map(\.rawValue)) == [
            "alan.a.rosa@gmail.com", "alan.rosa@cvshealth.com"
        ])
    }

    @Test("review binds email authority to the exact approved route and linked Contact")
    func exactContactsReview() {
        let contact = LocalContact(
            id: "contact-1",
            name: "Example Person",
            phones: ["+15550000001"],
            emails: ["Person@Example.com"]
        )
        var policy = RicoRecipientPolicy(
            id: "policy-1",
            contactID: contact.id,
            displayName: contact.name,
            address: "+15550000001",
            access: .approved,
            requireMention: true,
            autoReply: true,
            quietStart: 0,
            quietEnd: 0
        )
        #expect(RicoPersonEmailReview.reviewedRecipient(
            policy: policy,
            contact: contact,
            requestedEmail: "PERSON@example.com",
            enabled: true
        ) == "person@example.com")

        policy.contactID = "another-contact"
        #expect(RicoPersonEmailReview.reviewedRecipient(
            policy: policy,
            contact: contact,
            requestedEmail: "person@example.com",
            enabled: true
        ) == nil)

        policy.contactID = contact.id
        policy.access = .blocked
        #expect(RicoPersonEmailReview.reviewedRecipient(
            policy: policy,
            contact: contact,
            requestedEmail: "person@example.com",
            enabled: true
        ) == nil)
        #expect(RicoPersonEmailReview.reviewedRecipient(
            policy: RicoRecipientPolicy(
                id: "policy-2", contactID: contact.id, displayName: contact.name,
                address: "+15550000001", access: .approved, requireMention: true,
                autoReply: true, quietStart: 0, quietEnd: 0
            ),
            contact: contact,
            requestedEmail: "other@example.com",
            enabled: true
        ) == nil)
    }
}
