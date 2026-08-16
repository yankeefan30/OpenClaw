import Foundation

/// Canonical source catalog for Rico's governed research broker. A source's
/// presence in this catalog is not proof that its connector is installed or
/// healthy; runtime capability status is tracked separately.
enum RicoResearchSource: String, Codable, CaseIterable, Identifiable, Sendable {
    case publicWeb = "Public websites"
    case legalCases = "Legal cases"
    case magazines = "Magazine articles"
    case newspapers = "Newspaper articles"
    case books = "Books"
    case chatGPT = "ChatGPT"
    case claude = "Claude"
    case grok = "Grok"
    case gemini = "Gemini"
    case perplexity = "Perplexity"
    case googleDrive = "Google Drive"
    case gmail = "Gmail"
    case slack = "Slack"
    case outlook = "Outlook"
    case appleMail = "Apple Mail"
    case limitless = "Limitless lifelogs"
    case plaud = "PLAUD recordings"

    var id: String { rawValue }

    /// Only these five classes may appear as a citation in a text or email.
    /// Models and private repositories may help locate or understand evidence,
    /// but are never represented as the authority for a claim.
    var mayBeCited: Bool {
        switch self {
        case .publicWeb, .legalCases, .magazines, .newspapers, .books: true
        default: false
        }
    }

    var isPrivate: Bool {
        switch self {
        case .googleDrive, .gmail, .slack, .outlook, .appleMail, .limitless, .plaud: true
        default: false
        }
    }

    var isModel: Bool {
        switch self {
        case .chatGPT, .claude, .grok, .gemini, .perplexity: true
        default: false
        }
    }
}

enum RicoCapabilityState: String, Codable, CaseIterable, Sendable {
    case unavailable
    case allowed
    case configured
    case healthy

    var canUse: Bool { self == .healthy }
}

struct RicoResearchCapability: Codable, Equatable, Identifiable, Sendable {
    var source: RicoResearchSource
    var state: RicoCapabilityState
    /// Opaque reference such as an MCP server/tool name. It may identify a
    /// capability but must never contain a token, password, cookie, or URL
    /// credential.
    var capabilityReference: String?
    var verifiedAt: Date?

    var id: RicoResearchSource { source }

    var isUsable: Bool {
        state.canUse && Self.safeReference(capabilityReference)
    }

    static func safeReference(_ value: String?) -> Bool {
        guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty, raw.count <= 180 else { return false }
        let forbidden = ["password", "secret", "token=", "cookie", "bearer ", "api_key", "apikey"]
        return !forbidden.contains { raw.localizedCaseInsensitiveContains($0) }
    }
}

enum RicoEvidenceUse: String, Codable, Sendable {
    case privateBackground
    case modelLead
    case citableAuthority
}

struct RicoResearchEvidence: Codable, Equatable, Identifiable, Sendable {
    var id: UUID
    var source: RicoResearchSource
    var use: RicoEvidenceUse
    var title: String
    var publicURL: URL?
    var locatorDigest: String
    var collectedAt: Date

    var validationErrors: [String] {
        var errors: [String] = []
        let safeTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if safeTitle.isEmpty || safeTitle.count > 300 { errors.append("Evidence needs a bounded title.") }
        if locatorDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) == nil {
            errors.append("Evidence needs a SHA-256 locator digest.")
        }
        if use == .citableAuthority && !source.mayBeCited {
            errors.append("This source may inform research but cannot be cited.")
        }
        if source.mayBeCited && use != .citableAuthority {
            errors.append("A public authority must be explicitly classified before citation.")
        }
        if let publicURL {
            guard publicURL.scheme?.lowercased() == "https",
                  publicURL.user == nil,
                  publicURL.password == nil,
                  publicURL.host?.isEmpty == false else {
                errors.append("Citation links must be public HTTPS URLs without embedded credentials.")
                return errors
            }
        }
        if use == .citableAuthority {
            switch source {
            case .publicWeb, .magazines, .newspapers:
                if publicURL == nil { errors.append("This citation class requires a public hyperlink.") }
            case .legalCases, .books:
                break
            default:
                errors.append("Only websites, legal cases, magazine articles, newspaper articles, and books are citable.")
            }
        } else if publicURL != nil && (source.isPrivate || source.isModel) {
            errors.append("Private repositories and AI models cannot supply outbound citation links.")
        }
        return errors
    }
}

struct RicoAnswerCitation: Codable, Equatable, Identifiable, Sendable {
    var id: UUID
    var evidenceID: UUID
    var label: String
    var hyperlink: URL?
}

enum RicoResearchPolicyDecision: Equatable, Sendable {
    case allow
    case deny([String])
}

enum RicoResearchPolicy {
    static let systemInstruction = """
    Research may use only capabilities that Rico's local broker reports as healthy for this exact run. ChatGPT, Claude, Grok, Gemini, and Perplexity are research assistants, never sources to cite. Google Drive, Gmail, Slack, Outlook, Apple Mail, private conversations, lifelogs, and recordings are private background sources: they may inform the substance and personalization of an answer, but Rico must never quote, name, link, cite, or imply their provenance and must never mention Limitless or PLAUD. An outbound citation may identify only a public website, legal case, magazine article, newspaper article, or book. Hyperlinks must be public HTTPS links with no credentials. Never fabricate public corroboration for a private fact.
    """

    static func authorize(
        requestedSources: Set<RicoResearchSource>,
        capabilities: [RicoResearchCapability]
    ) -> RicoResearchPolicyDecision {
        let bySource = Dictionary(grouping: capabilities, by: \.source)
        var failures: [String] = []
        for source in requestedSources.sorted(by: { $0.rawValue < $1.rawValue }) {
            let matches = bySource[source] ?? []
            guard matches.count == 1, matches[0].isUsable else {
                failures.append("\(source.rawValue) is not backed by one verified capability.")
                continue
            }
        }
        return failures.isEmpty ? .allow : .deny(failures)
    }

    static func validateOutboundCitations(
        _ citations: [RicoAnswerCitation],
        evidence: [RicoResearchEvidence]
    ) -> RicoResearchPolicyDecision {
        let evidenceByID = Dictionary(uniqueKeysWithValues: evidence.map { ($0.id, $0) })
        var errors: [String] = []
        var seen = Set<UUID>()
        for citation in citations {
            guard seen.insert(citation.evidenceID).inserted else {
                errors.append("A citation cannot be duplicated.")
                continue
            }
            guard let item = evidenceByID[citation.evidenceID] else {
                errors.append("A citation has no matching evidence record.")
                continue
            }
            errors.append(contentsOf: item.validationErrors)
            guard item.use == .citableAuthority, item.source.mayBeCited else {
                errors.append("A citation points to a private or model source.")
                continue
            }
            let label = citation.label.trimmingCharacters(in: .whitespacesAndNewlines)
            if label.isEmpty || label.count > 300 { errors.append("Citation labels must be bounded.") }
            if citation.hyperlink != item.publicURL {
                errors.append("Citation hyperlink does not match the verified evidence record.")
            }
        }
        return errors.isEmpty ? .allow : .deny(Array(Set(errors)).sorted())
    }
}

enum RicoPrivateProvenanceGuard {
    private static let patterns: [(String, String)] = [
        ("private_source_brand", #"\b(?:l[\s._-]*i[\s._-]*m[\s._-]*i[\s._-]*t[\s._-]*l[\s._-]*e[\s._-]*s[\s._-]*s|p[\s._-]*l[\s._-]*a[\s._-]*u[\s._-]*d)\b"#),
        ("private_recording_source", #"\b(?:life\s*-?\s*log|recorded\s+(?:conversation|meeting|call)|(?:conversation|meeting|call|audio|voice)\s+recording|meeting\s+transcript|(?:notes?|minutes)\s+from\s+(?:(?:our|your|the|a|an)\s+)?(?:(?:prior|previous|past|earlier|private)\s+)?(?:conversation|chat|discussion|meeting|call))\b"#),
        ("private_conversation_reference", #"\b(?:(?:our|your)\s+(?:(?:prior|previous|past|earlier|private)\s+)?|the\s+(?:prior|previous|past|earlier|private)\s+)(?:conversation|chat)\b"#),
        ("private_conversation_attribution", #"\b(?:from|based\s+on|according\s+to|during|in|after|following)\s+(?:(?:our|your|the|a|an)\s+)?(?:(?:prior|previous|past|earlier|recorded|private)\s+)?(?:conversation|chat|exchange|discussion|messages?|recording|transcript)\b"#),
        ("private_discussion_callback", #"\b(?:as\s+(?:we|you|he|she|they)\s+(?:discussed|talked|spoke|said|mentioned|shared|explained|agreed|noted|covered)|when\s+(?:we|you\s+and\s+i)\s+(?:last\s+)?(?:spoke|talked|chatted|met|discussed)|the\s+last\s+time\s+(?:we|you\s+and\s+i)\s+(?:spoke|talked|chatted|met|discussed)|(?:we|you\s+and\s+i)\s+(?:previously\s+)?(?:talked|spoke|chatted|discussed)\s+(?:about|of))\b"#),
        ("private_memory_attribution", #"\b(?:(?:you|he|she|they)\s+(?:(?:said|mentioned|shared|explained|noted)\s+(?:earlier|before|previously|in\s+(?:(?:our|your|the|a|an)\s+)?(?:(?:prior|previous|past|earlier|private)\s+)?(?:conversation|chat|exchange|discussion|messages?|meeting|call|recording))|told\s+(?:me|rico))|earlier\s*,?\s*(?:you|he|she|they)\s+(?:said|mentioned|shared|explained|noted)|(?:i|rico|we)\s+(?:remember|recall)\s+(?:that\s+)?(?:you|we|our|your|the|when))\b"#),
        ("private_repository_attribution", #"\b(?:(?:according\s+to|from|based\s+on|per)\s+(?:(?:your|alan(?:'s)?|the)\s+)?(?:emails?|gmail|outlook(?:\s+(?:email|mailbox|messages?))?|apple\s+mail|slack(?:\s+messages?)?|google\s+drive(?:\s+(?:file|document))?|drive\s+file|mailbox|messages?|transcript)|(?:your|alan(?:'s)?|the)\s+(?:emails?|gmail|outlook(?:\s+(?:email|mailbox|messages?))?|apple\s+mail|slack(?:\s+messages?)?|google\s+drive(?:\s+(?:file|document))?|drive\s+file|mailbox|messages?|transcript)\s+(?:says?|shows?|indicates?|mentions?|states?|confirms?|reveals?))\b"#),
        ("private_repository_access", #"\b(?:i|rico|we)\s+(?:(?:have|had|can|could|did)\s+)?(?:access(?:ed)?|open(?:ed)?|read|re-?read|review(?:ed)?|search(?:ed)?|check(?:ed)?|consult(?:ed)?|use(?:d)?)\s+(?:(?:your|alan(?:'s)?|the)\s+)?(?:emails?|gmail|outlook(?:\s+(?:email|mailbox|messages?))?|apple\s+mail|slack(?:\s+messages?)?|google\s+drive(?:\s+(?:file|document))?|drive\s+file|mailbox)\b"#),
        ("private_access_claim", #"\b(?:i|rico|we)\s+(?:(?:(?:have|had|got|can|could)\s+access\s+to|(?:was|were)\s+able\s+to\s+access)\s+(?:our|your|the|a|an|alan(?:'s)?)\s+(?:(?:prior|previous|past|earlier|recorded|private)\s+)?(?:recordings?|conversations?|chats?|meetings?|calls?|lifelogs?|transcripts?|messages?)|(?:(?:have|had|can|could|did)\s+)?(?:access(?:ed)?|read|re-?read|revisit(?:ed)?|review(?:ed)?|listen(?:ed)?\s+to|hear(?:d)?|search(?:ed)?|check(?:ed)?|consult(?:ed)?|use(?:d)?)\s+(?:our|your|the|a|an|alan(?:'s)?)\s+(?:(?:prior|previous|past|earlier|recorded|private)\s+)?(?:recordings?|conversations?|chats?|meetings?|calls?|lifelogs?|transcripts?))\b"#),
        ("private_source_discovery_claim", #"\b(?:i|rico|we)\s+(?:found|learned|saw|read|heard|pulled|got|confirmed)\s+(?:this|that|it|the\s+(?:detail|information|answer|date|fact))?\s*(?:from|in|through|by\s+(?:reading|reviewing|listening\s+to))\s+(?:(?:your|alan(?:'s)?|the)\s+)?(?:emails?|gmail|outlook(?:\s+(?:email|mailbox|messages?))?|apple\s+mail|slack(?:\s+messages?)?|google\s+drive(?:\s+(?:file|document))?|drive\s+file|mailbox|messages?|recording|transcript|lifelog)\b"#),
    ]

    static func disclosureReason(in content: String) -> String? {
        let compatible = content.precomposedStringWithCompatibilityMapping
        let withoutFormatControls = compatible.replacingOccurrences(
            of: #"[\x{0000}-\x{0008}\x{000B}\x{000C}\x{000E}-\x{001F}\x{007F}-\x{009F}\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}\x{2066}-\x{2069}\x{FEFF}]"#,
            with: "",
            options: .regularExpression
        )
        let value = withoutFormatControls.replacingOccurrences(
            of: #"\s+"#,
            with: " ",
            options: .regularExpression
        )
        return patterns.first { _, pattern in
            value.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
        }?.0
    }
}
