import Foundation

/// External installation marker for the optional Bad Rudy module. Keeping
/// sidebar visibility behind this private, manifest-owned marker lets the
/// rollback command remove the feature without rewriting the signed app or
/// touching unrelated OpenClaw state.
@MainActor
final class BadRudyFeatureRegistry: ObservableObject {
    @Published private(set) var isInstalled = false

    init() {
        refresh()
    }

    func refresh() {
        isInstalled = Self.validateMarker(at: Self.markerURL)
    }

    static var markerURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/OpenClaw Studio/modules/bad-rudy/feature.json")
    }

    static func validateMarker(at url: URL) -> Bool {
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
              values.isRegularFile == true,
              values.isSymbolicLink != true,
              let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }

        return object["schema"] as? String == "openclaw.bad-rudy-feature/v1" &&
            object["schemaVersion"] as? Int == 1 &&
            object["_ownedBy"] as? String == "openclaw-studio:bad-rudy"
    }
}
