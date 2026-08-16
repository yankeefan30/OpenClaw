import Foundation

/// Safe, style-only personality presets for a reviewed Rico group route.
///
/// These values are suggestions for the command-console editor. They do not
/// carry any authorization and are never used to identify a group or sender.
enum RicoGroupPersonalityPreset: String, CaseIterable, Identifiable, Sendable {
    case balanced
    case warm
    case concise
    case witty
    case professional

    var id: String { rawValue }

    var title: String {
        switch self {
        case .balanced: "Balanced"
        case .warm: "Warm"
        case .concise: "Concise"
        case .witty: "Lightly witty"
        case .professional: "Professional"
        }
    }

    var suggestion: String {
        switch self {
        case .balanced:
            "Friendly, grounded, and concise. Be useful without dominating the conversation."
        case .warm:
            "Warm, encouraging, and conversational. Show empathy and keep the tone relaxed."
        case .concise:
            "Direct and economical. Prefer short answers and skip unnecessary setup."
        case .witty:
            "Playful and lightly witty, but never sarcastic, insulting, or distracting."
        case .professional:
            "Polished, calm, and practical. Use clear language and avoid slang."
        }
    }
}

/// Canonicalizes the user-authored group style description before it is saved
/// or projected into the Gateway policy. Runtime authorization and privacy
/// enforcement must remain independent of this display/configuration text.
enum RicoGroupPersonalityPolicy {
    static let maximumLength = 400

    /// Returns a single-line, prompt-delimiter-free style description.
    /// Empty input means the group uses Rico's default personality.
    static func sanitize(_ rawValue: String) -> String {
        var cleaned = ""
        cleaned.reserveCapacity(min(rawValue.count, maximumLength))

        for scalar in rawValue.unicodeScalars {
            let value = scalar.value
            let isDirectionalControl = (0x202A...0x202E).contains(value) || (0x2066...0x2069).contains(value)
            let isInvisibleFormat = value == 0x200B || value == 0x200C || value == 0x200D || value == 0x2060 || value == 0xFEFF
            let isPromptDelimiter = scalar == "<" || scalar == ">" || scalar == "`" || scalar == "{" || scalar == "}"
            if CharacterSet.controlCharacters.contains(scalar) ||
                CharacterSet.illegalCharacters.contains(scalar) ||
                isDirectionalControl || isInvisibleFormat || isPromptDelimiter {
                cleaned.append(" ")
            } else {
                cleaned.unicodeScalars.append(scalar)
            }
        }

        let collapsed = cleaned
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")

        var limited = ""
        limited.reserveCapacity(min(collapsed.count, maximumLength))
        for scalar in collapsed.unicodeScalars.prefix(maximumLength) {
            limited.unicodeScalars.append(scalar)
        }
        return limited
    }

    static func valueForStorage(_ rawValue: String?) -> String? {
        guard let rawValue else { return nil }
        let value = sanitize(rawValue)
        return value.isEmpty ? nil : value
    }

    /// Used for sidecar/runtime readback. A non-canonical value fails closed
    /// instead of being interpreted differently by Studio and the plugin.
    static func isCanonical(_ value: String) -> Bool {
        !value.isEmpty && value.unicodeScalars.count <= maximumLength && sanitize(value) == value
    }

    /// Applies a style value without ever allowing it onto an individual
    /// identity. This is the only mutation API used by the console editor.
    static func applying(_ rawValue: String?, to policy: RicoRecipientPolicy) -> RicoRecipientPolicy {
        var result = policy
        result.groupPersonality = policy.groupChatID == nil ? nil : valueForStorage(rawValue)
        return result
    }

    /// A refreshed group approval keeps its personality only when both the
    /// stable group id and normalized iMessage target still identify the same
    /// exact reviewed group. A reused/mismatched id gets Rico's default.
    static func valueForExactGroupReapproval(
        policies: [RicoRecipientPolicy],
        groupID: String,
        target: String
    ) -> String? {
        let exactTarget = RicoRecipientGuard.normalizeTarget(target)
        guard !groupID.isEmpty, !exactTarget.isEmpty,
              let existing = policies.first(where: {
                  $0.groupChatID == groupID && RicoRecipientGuard.normalizeTarget($0.address) == exactTarget
              }) else { return nil }
        return valueForStorage(existing.groupPersonality)
    }
}
