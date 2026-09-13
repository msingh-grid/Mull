// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "mull-mac",
    platforms: [.macOS(.v13)],
    targets: [
        // Core: RPC framing, dispatch, verb handlers. Library so XCTest can
        // exercise framing + validation without spawning the executable.
        .target(name: "MullMacCore"),
        .executableTarget(
            name: "mull-mac",
            dependencies: ["MullMacCore"]
        ),
        .testTarget(
            name: "MullMacCoreTests",
            dependencies: ["MullMacCore"]
        )
    ]
)
