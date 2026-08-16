#!/bin/zsh
set -euo pipefail

project_root=${0:A:h:h}
app_path="$project_root/dist/OpenClaw Studio.app"
contents_path="$app_path/Contents"
binary_path="$project_root/.build/arm64-apple-macosx/release/OpenClawStudio"
entitlements_path="$project_root/Packaging/OpenClawStudio.entitlements"
sdk_path=${SDKROOT:-/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk}
cache_path=${CLANG_MODULE_CACHE_PATH:-/private/tmp/openclawstudio-clang-cache}
preferred_identity='Apple Development: alan.a.rosa@icloud.com (4S8K7CBCNP)'
signing_identity=${SIGN_IDENTITY:-$preferred_identity}
identity_inventory=$(security find-identity -v -p codesigning 2>/dev/null || true)
if [[ "$signing_identity" == "-" ]]; then
    print -u2 "Refusing ad-hoc signing for the production OpenClaw Studio bundle."
    exit 1
elif ! print -r -- "$identity_inventory" | grep -Fq \"$signing_identity\"; then
    print -u2 "Required stable signing identity is unavailable: $signing_identity"
    print -u2 "Open Xcode Accounts or Keychain Access and restore that identity before packaging."
    exit 1
fi

CLANG_MODULE_CACHE_PATH="$cache_path" SDKROOT="$sdk_path" \
    swift build -c release --disable-sandbox --package-path "$project_root"

if [[ ! -x "$binary_path" ]]; then
    print -u2 "Release executable was not produced at $binary_path"
    exit 1
fi
if [[ ! -f "$entitlements_path" ]] || ! plutil -lint "$entitlements_path" >/dev/null; then
    print -u2 "Required Contacts entitlement file is missing or invalid: $entitlements_path"
    exit 1
fi

if [[ "$app_path" != "$project_root"/dist/*.app ]]; then
    print -u2 "Refusing unexpected app path: $app_path"
    exit 1
fi

# Always stage a clean bundle so removed resources cannot survive from an
# earlier build. Refuse links or any path outside this exact build product.
if [[ -L "$app_path" ]]; then
    print -u2 "Refusing symlinked app path: $app_path"
    exit 1
fi
if [[ -e "$app_path" ]]; then
    if [[ ! -d "$app_path" || "$app_path" != "$project_root/dist/OpenClaw Studio.app" ]]; then
        print -u2 "Refusing unexpected existing build product: $app_path"
        exit 1
    fi
    rm -rf -- "$app_path"
fi

mkdir -p "$contents_path/MacOS" "$contents_path/Resources"
cp "$project_root/Packaging/Info.plist" "$contents_path/Info.plist"
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :LSMultipleInstancesProhibited' "$contents_path/Info.plist" 2>/dev/null)" != "true" ]]; then
    print -u2 "Refusing a Studio bundle that permits competing policy-writer instances."
    exit 1
fi
cp "$binary_path" "$contents_path/MacOS/OpenClawStudio"
mkdir -p "$contents_path/Resources/RicoRecipientGuard"
cp "$project_root/OpenClawPlugin/index.js" \
   "$project_root/OpenClawPlugin/policy.js" \
   "$project_root/OpenClawPlugin/escalation-guard.js" \
   "$project_root/OpenClawPlugin/automatic-imt-handoff.js" \
   "$project_root/OpenClawPlugin/group-email-integration.js" \
   "$project_root/OpenClawPlugin/ists-incident-integration.js" \
   "$project_root/OpenClawPlugin/skills-context.js" \
   "$project_root/OpenClawPlugin/people-context.js" \
   "$project_root/OpenClawPlugin/research-policy.js" \
   "$project_root/OpenClawPlugin/openclaw.plugin.json" \
   "$project_root/OpenClawPlugin/package.json" \
   "$project_root/OpenClawPlugin/README.md" \
   "$contents_path/Resources/RicoRecipientGuard/"
mkdir -p "$contents_path/Resources/RicoRecipientGuard/RicoEscalationHandoff"
cp "$project_root/RicoEscalationHandoff/handoff.js" \
   "$project_root/RicoEscalationHandoff/automatic-imt.mjs" \
   "$project_root/RicoEscalationHandoff/result-contract.js" \
   "$contents_path/Resources/RicoRecipientGuard/RicoEscalationHandoff/"
mkdir -p "$contents_path/Resources/RicoRecipientGuard/RicoEmailGovernance"
cp "$project_root/RicoEmailGovernance/"*.mjs \
   "$contents_path/Resources/RicoRecipientGuard/RicoEmailGovernance/"
mkdir -p "$contents_path/Resources/RicoRecipientGuard/ISTSIncidentWorkflow"
cp "$project_root/ISTSIncidentWorkflow/index.js" \
   "$project_root/ISTSIncidentWorkflow/runtime.mjs" \
   "$project_root/ISTSIncidentWorkflow/definition.mjs" \
   "$project_root/ISTSIncidentWorkflow/grant.mjs" \
   "$project_root/ISTSIncidentWorkflow/contracts.mjs" \
   "$project_root/ISTSIncidentWorkflow/state-store.mjs" \
   "$project_root/ISTSIncidentWorkflow/engine.mjs" \
   "$project_root/ISTSIncidentWorkflow/context-provider.mjs" \
   "$project_root/ISTSIncidentWorkflow/audience-context.mjs" \
   "$project_root/ISTSIncidentWorkflow/imsg-executable.mjs" \
   "$project_root/ISTSIncidentWorkflow/any-group-classifier.mjs" \
   "$project_root/ISTSIncidentWorkflow/any-group-contracts.mjs" \
   "$project_root/ISTSIncidentWorkflow/any-group-ingress.mjs" \
   "$project_root/ISTSIncidentWorkflow/any-group-source.mjs" \
   "$project_root/ISTSIncidentWorkflow/any-group-state-store.mjs" \
   "$project_root/ISTSIncidentWorkflow/service.mjs" \
   "$project_root/ISTSIncidentWorkflow/activation.mjs" \
   "$project_root/ISTSIncidentWorkflow/status.mjs" \
   "$project_root/ISTSIncidentWorkflow/openclaw.plugin.json" \
   "$project_root/ISTSIncidentWorkflow/package.json" \
   "$contents_path/Resources/RicoRecipientGuard/ISTSIncidentWorkflow/"
mkdir -p "$contents_path/Resources/RicoRecipientGuard/ISTSIncidentWorkflow/RicoEscalationHandoff"
cp "$project_root/RicoEscalationHandoff/handoff.js" \
   "$project_root/RicoEscalationHandoff/automatic-imt.mjs" \
   "$project_root/RicoEscalationHandoff/result-contract.js" \
   "$contents_path/Resources/RicoRecipientGuard/ISTSIncidentWorkflow/RicoEscalationHandoff/"
mkdir -p "$contents_path/Resources/RicoRecipientGuard/ISTSIncidentWorkflow/adapters"
cp "$project_root/ISTSIncidentWorkflow/adapters/local-imessage.mjs" \
   "$project_root/ISTSIncidentWorkflow/adapters/any-local-group.mjs" \
   "$contents_path/Resources/RicoRecipientGuard/ISTSIncidentWorkflow/adapters/"
mkdir -p "$contents_path/Resources/RicoRecipientGuard/ISTSIncidentWorkflow/colleague-zone-adapter/scripts"
cp "$project_root/ISTSIncidentWorkflow/colleague-zone-adapter/index.mjs" \
   "$project_root/ISTSIncidentWorkflow/colleague-zone-adapter/browser-runtime.mjs" \
   "$project_root/ISTSIncidentWorkflow/colleague-zone-adapter/parser.mjs" \
   "$project_root/ISTSIncidentWorkflow/colleague-zone-adapter/selectors.mjs" \
   "$contents_path/Resources/RicoRecipientGuard/ISTSIncidentWorkflow/colleague-zone-adapter/"
cp "$project_root/ISTSIncidentWorkflow/colleague-zone-adapter/scripts/reauth.mjs" \
   "$contents_path/Resources/RicoRecipientGuard/ISTSIncidentWorkflow/colleague-zone-adapter/scripts/"
mkdir -p "$contents_path/Resources/RicoRecipientGuard/ISTSIncidentWorkflow/scripts"
cp "$project_root/ISTSIncidentWorkflow/scripts/ists-incident.mjs" \
   "$contents_path/Resources/RicoRecipientGuard/ISTSIncidentWorkflow/scripts/"
chmod 755 "$contents_path/Resources/RicoRecipientGuard/ISTSIncidentWorkflow/scripts/ists-incident.mjs" \
          "$contents_path/Resources/RicoRecipientGuard/ISTSIncidentWorkflow/colleague-zone-adapter/scripts/reauth.mjs"
mkdir -p "$contents_path/Resources/RicoRecipientGuard/RicoSkillsRuntime"
cp "$project_root/RicoSkillsRuntime/archive.mjs" \
   "$project_root/RicoSkillsRuntime/canonical.mjs" \
   "$project_root/RicoSkillsRuntime/constants.mjs" \
   "$project_root/RicoSkillsRuntime/context.mjs" \
   "$project_root/RicoSkillsRuntime/errors.mjs" \
   "$project_root/RicoSkillsRuntime/importer.mjs" \
   "$project_root/RicoSkillsRuntime/index.mjs" \
   "$project_root/RicoSkillsRuntime/policy.mjs" \
   "$project_root/RicoSkillsRuntime/store.mjs" \
   "$project_root/RicoSkillsRuntime/package.json" \
   "$contents_path/Resources/RicoRecipientGuard/RicoSkillsRuntime/"
mkdir -p "$contents_path/Resources/RicoAutonomyGovernor"
cp "$project_root/AutonomyGovernorPlugin/index.js" \
   "$project_root/AutonomyGovernorPlugin/governor.js" \
   "$project_root/AutonomyGovernorPlugin/state-store.js" \
   "$project_root/AutonomyGovernorPlugin/openclaw.plugin.json" \
   "$project_root/AutonomyGovernorPlugin/package.json" \
   "$project_root/AutonomyGovernorPlugin/README.md" \
   "$contents_path/Resources/RicoAutonomyGovernor/"
mkdir -p "$contents_path/Resources/RicoEscalationHandoff"
cp "$project_root/RicoEscalationHandoff/index.js" \
   "$project_root/RicoEscalationHandoff/authorization.js" \
   "$project_root/RicoEscalationHandoff/handoff.js" \
   "$project_root/RicoEscalationHandoff/automatic-imt.mjs" \
   "$project_root/RicoEscalationHandoff/result-contract.js" \
   "$project_root/RicoEscalationHandoff/openclaw.plugin.json" \
   "$project_root/RicoEscalationHandoff/package.json" \
   "$project_root/RicoEscalationHandoff/README.md" \
   "$contents_path/Resources/RicoEscalationHandoff/"
mkdir -p "$contents_path/Resources/RicoOwnerRoute"
cp "$project_root/IMsgOwnerRoute/imsg-owner-route.mjs" \
   "$project_root/IMsgOwnerRoute/README.md" \
   "$contents_path/Resources/RicoOwnerRoute/"
chmod 755 "$contents_path/Resources/RicoOwnerRoute/imsg-owner-route.mjs"
mkdir -p "$contents_path/Resources/JanetReceiptWorkflow/scripts"
cp "$project_root/JanetReceiptWorkflow/index.js" \
   "$project_root/JanetReceiptWorkflow/definition.mjs" \
   "$project_root/JanetReceiptWorkflow/grant.mjs" \
   "$project_root/JanetReceiptWorkflow/handler.mjs" \
   "$project_root/JanetReceiptWorkflow/ledger.mjs" \
   "$project_root/JanetReceiptWorkflow/messages.mjs" \
   "$project_root/JanetReceiptWorkflow/policy.mjs" \
   "$project_root/JanetReceiptWorkflow/pdf-evidence.mjs" \
   "$project_root/JanetReceiptWorkflow/report-store.mjs" \
   "$project_root/JanetReceiptWorkflow/openclaw.plugin.json" \
   "$project_root/JanetReceiptWorkflow/package.json" \
   "$project_root/JanetReceiptWorkflow/README.md" \
   "$contents_path/Resources/JanetReceiptWorkflow/"
cp "$project_root/JanetReceiptWorkflow/scripts/install-grant.mjs" \
   "$project_root/JanetReceiptWorkflow/scripts/migrate-ledger.mjs" \
   "$contents_path/Resources/JanetReceiptWorkflow/scripts/"
mkdir -p "$contents_path/Resources/OutlookMailMonitor/scripts"
cp "$project_root/OutlookMailMonitor/index.js" \
   "$project_root/OutlookMailMonitor/definition.mjs" \
   "$project_root/OutlookMailMonitor/engine.mjs" \
   "$project_root/OutlookMailMonitor/grant.mjs" \
   "$project_root/OutlookMailMonitor/service.mjs" \
   "$project_root/OutlookMailMonitor/state-store.mjs" \
   "$project_root/OutlookMailMonitor/openclaw.plugin.json" \
   "$project_root/OutlookMailMonitor/package.json" \
   "$project_root/OutlookMailMonitor/README.md" \
   "$contents_path/Resources/OutlookMailMonitor/"
cp "$project_root/OutlookMailMonitor/scripts/install-grant.mjs" \
   "$contents_path/Resources/OutlookMailMonitor/scripts/"

mkdir -p "$contents_path/Resources/ISTSIncidentWorkflow/scripts"
cp "$project_root/ISTSIncidentWorkflow/index.js" \
   "$project_root/ISTSIncidentWorkflow/runtime.mjs" \
   "$project_root/ISTSIncidentWorkflow/definition.mjs" \
   "$project_root/ISTSIncidentWorkflow/grant.mjs" \
   "$project_root/ISTSIncidentWorkflow/contracts.mjs" \
   "$project_root/ISTSIncidentWorkflow/state-store.mjs" \
   "$project_root/ISTSIncidentWorkflow/engine.mjs" \
   "$project_root/ISTSIncidentWorkflow/context-provider.mjs" \
   "$project_root/ISTSIncidentWorkflow/audience-context.mjs" \
   "$project_root/ISTSIncidentWorkflow/imsg-executable.mjs" \
   "$project_root/ISTSIncidentWorkflow/any-group-classifier.mjs" \
   "$project_root/ISTSIncidentWorkflow/any-group-contracts.mjs" \
   "$project_root/ISTSIncidentWorkflow/any-group-ingress.mjs" \
   "$project_root/ISTSIncidentWorkflow/any-group-source.mjs" \
   "$project_root/ISTSIncidentWorkflow/any-group-state-store.mjs" \
   "$project_root/ISTSIncidentWorkflow/service.mjs" \
   "$project_root/ISTSIncidentWorkflow/activation.mjs" \
   "$project_root/ISTSIncidentWorkflow/status.mjs" \
   "$project_root/ISTSIncidentWorkflow/openclaw.plugin.json" \
   "$project_root/ISTSIncidentWorkflow/package.json" \
   "$project_root/ISTSIncidentWorkflow/README.md" \
   "$contents_path/Resources/ISTSIncidentWorkflow/"
mkdir -p "$contents_path/Resources/ISTSIncidentWorkflow/RicoEscalationHandoff"
cp "$project_root/RicoEscalationHandoff/handoff.js" \
   "$project_root/RicoEscalationHandoff/automatic-imt.mjs" \
   "$project_root/RicoEscalationHandoff/result-contract.js" \
   "$contents_path/Resources/ISTSIncidentWorkflow/RicoEscalationHandoff/"
cp "$project_root/ISTSIncidentWorkflow/scripts/install-grant.mjs" \
   "$project_root/ISTSIncidentWorkflow/scripts/ists-incident.mjs" \
   "$contents_path/Resources/ISTSIncidentWorkflow/scripts/"
mkdir -p "$contents_path/Resources/ISTSIncidentWorkflow/adapters"
cp "$project_root/ISTSIncidentWorkflow/adapters/local-imessage.mjs" \
   "$project_root/ISTSIncidentWorkflow/adapters/any-local-group.mjs" \
   "$contents_path/Resources/ISTSIncidentWorkflow/adapters/"
mkdir -p "$contents_path/Resources/ISTSIncidentWorkflow/colleague-zone-adapter/scripts"
cp "$project_root/ISTSIncidentWorkflow/colleague-zone-adapter/index.mjs" \
   "$project_root/ISTSIncidentWorkflow/colleague-zone-adapter/browser-runtime.mjs" \
   "$project_root/ISTSIncidentWorkflow/colleague-zone-adapter/parser.mjs" \
   "$project_root/ISTSIncidentWorkflow/colleague-zone-adapter/selectors.mjs" \
   "$project_root/ISTSIncidentWorkflow/colleague-zone-adapter/README.md" \
   "$contents_path/Resources/ISTSIncidentWorkflow/colleague-zone-adapter/"
cp "$project_root/ISTSIncidentWorkflow/colleague-zone-adapter/scripts/reauth.mjs" \
   "$contents_path/Resources/ISTSIncidentWorkflow/colleague-zone-adapter/scripts/"
chmod 755 "$contents_path/Resources/ISTSIncidentWorkflow/colleague-zone-adapter/scripts/reauth.mjs"
chmod 755 "$contents_path/Resources/ISTSIncidentWorkflow/scripts/ists-incident.mjs"

mkdir -p "$contents_path/Resources/RicoEmailGovernance"
cp "$project_root/RicoEmailGovernance/index.mjs" \
   "$project_root/RicoEmailGovernance/definition.mjs" \
   "$project_root/RicoEmailGovernance/policy.mjs" \
   "$project_root/RicoEmailGovernance/private-store.mjs" \
   "$project_root/RicoEmailGovernance/grant.mjs" \
   "$project_root/RicoEmailGovernance/ledger.mjs" \
   "$project_root/RicoEmailGovernance/adapter-contract.mjs" \
   "$project_root/RicoEmailGovernance/attachments.mjs" \
   "$project_root/RicoEmailGovernance/dispatcher.mjs" \
   "$project_root/RicoEmailGovernance/meeting-handoff.mjs" \
   "$project_root/RicoEmailGovernance/group-email-broker.mjs" \
   "$project_root/RicoEmailGovernance/native-outlook-adapter.mjs" \
   "$project_root/RicoEmailGovernance/group-email-tool.mjs" \
   "$project_root/RicoEmailGovernance/runtime-providers.mjs" \
   "$project_root/RicoEmailGovernance/package.json" \
   "$project_root/RicoEmailGovernance/README.md" \
   "$contents_path/Resources/RicoEmailGovernance/"

mkdir -p "$contents_path/Resources/BadRudyRuntime/scripts"
cp "$project_root/BadRudyRuntime/captured-clip.mjs" \
   "$project_root/BadRudyRuntime/config.mjs" \
   "$project_root/BadRudyRuntime/delivery.mjs" \
   "$project_root/BadRudyRuntime/errors.mjs" \
   "$project_root/BadRudyRuntime/events.mjs" \
   "$project_root/BadRudyRuntime/gates.mjs" \
   "$project_root/BadRudyRuntime/index.mjs" \
   "$project_root/BadRudyRuntime/installer.mjs" \
   "$project_root/BadRudyRuntime/keychain.mjs" \
   "$project_root/BadRudyRuntime/prompt.mjs" \
   "$project_root/BadRudyRuntime/rollback.mjs" \
   "$project_root/BadRudyRuntime/runtime.mjs" \
   "$project_root/BadRudyRuntime/scheduler.mjs" \
   "$project_root/BadRudyRuntime/security.mjs" \
   "$project_root/BadRudyRuntime/status.mjs" \
   "$project_root/BadRudyRuntime/stores.mjs" \
   "$project_root/BadRudyRuntime/worker-client.mjs" \
   "$project_root/BadRudyRuntime/package.json" \
   "$project_root/BadRudyRuntime/README.md" \
   "$contents_path/Resources/BadRudyRuntime/"
cp "$project_root/BadRudyRuntime/scripts/bad-rudy.mjs" \
   "$contents_path/Resources/BadRudyRuntime/scripts/"
chmod 755 "$contents_path/Resources/BadRudyRuntime/scripts/bad-rudy.mjs"

mkdir -p "$contents_path/Resources/GrokCompanionsWorker"
cp "$project_root/workers/grok-companions/index.ts" \
   "$project_root/workers/grok-companions/selectors.ts" \
   "$project_root/workers/grok-companions/package.json" \
   "$project_root/workers/grok-companions/tsconfig.json" \
   "$project_root/workers/grok-companions/README.md" \
   "$contents_path/Resources/GrokCompanionsWorker/"

mkdir -p "$contents_path/Resources/RicoSkillsRuntime"
cp "$project_root/RicoSkillsRuntime/archive.mjs" \
   "$project_root/RicoSkillsRuntime/canonical.mjs" \
   "$project_root/RicoSkillsRuntime/constants.mjs" \
   "$project_root/RicoSkillsRuntime/context.mjs" \
   "$project_root/RicoSkillsRuntime/errors.mjs" \
   "$project_root/RicoSkillsRuntime/importer.mjs" \
   "$project_root/RicoSkillsRuntime/index.mjs" \
   "$project_root/RicoSkillsRuntime/policy.mjs" \
   "$project_root/RicoSkillsRuntime/skills-cli.mjs" \
   "$project_root/RicoSkillsRuntime/store.mjs" \
   "$project_root/RicoSkillsRuntime/package.json" \
   "$contents_path/Resources/RicoSkillsRuntime/"

# Mobility and dining providers are bundled as inert source snapshots. The
# integration controller installs private copies and registers disabled MCP
# entries only; packaging never enables a provider or reads credentials.
mkdir -p "$contents_path/Resources/OpenTableMCP"
cp "$project_root/OpenTableMCP/canonical.mjs" \
   "$project_root/OpenTableMCP/constants.mjs" \
   "$project_root/OpenTableMCP/credentials.mjs" \
   "$project_root/OpenTableMCP/errors.mjs" \
   "$project_root/OpenTableMCP/index.mjs" \
   "$project_root/OpenTableMCP/invocation-proof.mjs" \
   "$project_root/OpenTableMCP/keychain.mjs" \
   "$project_root/OpenTableMCP/mcp-server.mjs" \
   "$project_root/OpenTableMCP/official-client.mjs" \
   "$project_root/OpenTableMCP/private-store.mjs" \
   "$project_root/OpenTableMCP/proof-issuer.mjs" \
   "$project_root/OpenTableMCP/rate-limiter.mjs" \
   "$project_root/OpenTableMCP/runtime.mjs" \
   "$project_root/OpenTableMCP/state-store.mjs" \
   "$project_root/OpenTableMCP/tools.mjs" \
   "$project_root/OpenTableMCP/package.json" \
   "$project_root/OpenTableMCP/README.md" \
   "$contents_path/Resources/OpenTableMCP/"

mkdir -p "$contents_path/Resources/UberMCP"
cp "$project_root/UberMCP/canonical.mjs" \
   "$project_root/UberMCP/constants.mjs" \
   "$project_root/UberMCP/credentials.mjs" \
   "$project_root/UberMCP/errors.mjs" \
   "$project_root/UberMCP/geocoder.mjs" \
   "$project_root/UberMCP/index.mjs" \
   "$project_root/UberMCP/invocation-proof.mjs" \
   "$project_root/UberMCP/keychain.mjs" \
   "$project_root/UberMCP/location-store.mjs" \
   "$project_root/UberMCP/mcp-server.mjs" \
   "$project_root/UberMCP/official-client.mjs" \
   "$project_root/UberMCP/private-store.mjs" \
   "$project_root/UberMCP/proof-issuer.mjs" \
   "$project_root/UberMCP/rate-limiter.mjs" \
   "$project_root/UberMCP/service.mjs" \
   "$project_root/UberMCP/state-store.mjs" \
   "$project_root/UberMCP/tools.mjs" \
   "$project_root/UberMCP/validation.mjs" \
   "$project_root/UberMCP/KeychainWriteHelper.swift" \
   "$project_root/UberMCP/package.json" \
   "$project_root/UberMCP/README.md" \
   "$contents_path/Resources/UberMCP/"

mkdir -p "$contents_path/Resources/MobilityDiningIntegration"
cp "$project_root/MobilityDiningIntegration/constants.mjs" \
   "$project_root/MobilityDiningIntegration/eta-handoff.mjs" \
   "$project_root/MobilityDiningIntegration/health.mjs" \
   "$project_root/MobilityDiningIntegration/index.mjs" \
   "$project_root/MobilityDiningIntegration/installer.mjs" \
   "$project_root/MobilityDiningIntegration/openclaw-cli.mjs" \
   "$project_root/MobilityDiningIntegration/private-files.mjs" \
   "$project_root/MobilityDiningIntegration/package.json" \
   "$project_root/MobilityDiningIntegration/README.md" \
   "$contents_path/Resources/MobilityDiningIntegration/"

chmod 755 "$contents_path/MacOS/OpenClawStudio"

# OpenClaw Studio is non-sandboxed, but Apple requires the Address Book
# resource entitlement when the hardened runtime is enabled. TCC authorization
# also requires the stable signature and NSContactsUsageDescription.
codesign --force --options runtime --timestamp=none \
    --entitlements "$entitlements_path" \
    --sign "$signing_identity" "$app_path"

codesign --verify --deep --strict --verbose=2 "$app_path"
signature_details=$(codesign -dv --verbose=4 "$app_path" 2>&1)
if ! print -r -- "$signature_details" | grep -Fq 'Identifier=ai.openclaw.studio' || \
   ! print -r -- "$signature_details" | grep -Fq 'TeamIdentifier=Q8XD3W5CG4'; then
    print -u2 "Packaged app does not have the required production bundle and team identity."
    exit 1
fi
embedded_entitlements=$(codesign -d --entitlements :- "$app_path" 2>&1)
if print -r -- "$embedded_entitlements" | grep -q "invalid entitlements blob"; then
    print -u2 "Packaged app contains an invalid entitlements blob"
    exit 1
fi
if ! print -r -- "$embedded_entitlements" | grep -Fq 'com.apple.security.personal-information.addressbook'; then
    print -u2 "Packaged app is missing the required Address Book entitlement"
    exit 1
fi
if print -r -- "$embedded_entitlements" | grep -Fq 'com.apple.security.app-sandbox'; then
    print -u2 "Packaged app unexpectedly enables App Sandbox"
    exit 1
fi
plutil -lint "$contents_path/Info.plist"
print "$app_path"
