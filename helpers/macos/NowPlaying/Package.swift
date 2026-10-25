// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "NowPlayingHelper",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "NowPlayingHelper", path: "Sources/NowPlayingHelper")
    ]
)
