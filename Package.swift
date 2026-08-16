// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OpenClawStudio",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "OpenClawStudio", targets: ["OpenClawStudio"]),
        .executable(name: "OpenClawStudioFixtures", targets: ["OpenClawStudioFixtures"])
    ],
    targets: [
        .executableTarget(name: "OpenClawStudio", swiftSettings: [.swiftLanguageMode(.v6)]),
        .executableTarget(name: "OpenClawStudioFixtures", swiftSettings: [.swiftLanguageMode(.v6)]),
        .testTarget(name: "OpenClawStudioTests", dependencies: ["OpenClawStudio"], swiftSettings: [.swiftLanguageMode(.v6)])
    ]
)
