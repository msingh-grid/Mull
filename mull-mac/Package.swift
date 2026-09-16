// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "mull-mac",
    // macOS 14 for ScreenCaptureKit's `SCScreenshotManager` (M5a). The
    // alternative, `CGWindowListCreateImage`, is deprecated as of 14 and is not
    // a thing to build a new capability on.
    platforms: [.macOS(.v14)],
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
