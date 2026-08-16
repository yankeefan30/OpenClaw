# OpenClaw Studio release checklist

## Build and signing

1. Build an archive with a pinned Xcode/Swift toolchain and `swift build -c release`.
2. Package the executable as a signed `.app` bundle with a stable bundle identifier and `Info.plist`.
3. Sign with Developer ID Application and enable hardened runtime.
4. Include only required entitlements. Request network client access and Keychain access as needed; do not grant LAN server, arbitrary file, or automation privileges.
5. Register the login item through `SMAppService.mainApp`; do not install launch agents manually.

## Sandbox and privacy

- Keep Gateway connections outbound to the user-selected endpoint.
- Never rewrite OpenClaw configuration.
- Store only the Gateway credential in Keychain.
- Redact credentials, personal content, and sensitive endpoint material from diagnostics.
- Review notification content and deep-link metadata before release.

## Validation

- `swift build -c release`
- `swift run OpenClawStudioFixtures`
- Repeated Gateway disconnect/reconnect
- Relaunch and state restoration
- Gateway unavailable
- Wrong credentials
- Incompatible protocol version
- Audit log and diagnostics secret scan
- Accessibility inspection of setup, settings, and critical actions

## Notarization

1. Sign the app and zip it.
2. Submit with `xcrun notarytool submit --wait`.
3. Staple with `xcrun stapler staple`.
4. Verify with `spctl --assess --type execute`.
5. Publish the notarized artifact and checksum.
