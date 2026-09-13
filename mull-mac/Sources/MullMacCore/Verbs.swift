import Foundation

/// Verb registration + param validation for the v0 sidecar.
///
/// v0 subset of src/shared/sidecar-api.ts:
///   init, checkPermissions, promptAccessibility, frontmostApp,
///   insertText (paste | type; ax => NotImplemented until M2),
///   secureInputState.
/// M2 verbs (focusedElement, replaceSelection, activateApp, keyChord) are
/// registered as explicit NotImplemented so callers get a clear error rather
/// than method-not-found.

public let SIDECAR_PROTOCOL_VERSION = 1
public let SIDECAR_VERSION = "0.1.0"

// MARK: - Param structs (mirror the zod schemas)

struct InitParams: Decodable {
    let protocolVersion: Int
}

struct InsertTextParams: Decodable {
    let text: String
    let strategy: String?
}

// MARK: - System abstraction (so XCTest never touches TCC / AppKit state)

public struct AppInfo {
    public let bundleId: String
    public let name: String
    public let pid: Int
    public init(bundleId: String, name: String, pid: Int) {
        self.bundleId = bundleId
        self.name = name
        self.pid = pid
    }
}

public struct InsertOutcome {
    public let inserted: Bool
    public let strategyUsed: String?
    public let reason: String?
    public init(inserted: Bool, strategyUsed: String?, reason: String?) {
        self.inserted = inserted
        self.strategyUsed = strategyUsed
        self.reason = reason
    }
}

public protocol SystemActions {
    func accessibilityTrusted() -> Bool
    func inputMonitoringGranted() -> Bool
    /// 'granted' | 'denied' | 'undetermined' — AVCaptureDevice status for THIS
    /// process; in dev TCC attributes it to the responsible (parent) app.
    func microphoneStatus() -> String
    func promptAccessibility() -> Bool
    func frontmostApp() -> (app: AppInfo?, windowTitle: String?)
    func secureInputActive() -> Bool
    /// Perform insertion with a concrete strategy ("paste" or "type").
    func insert(text: String, strategy: String) -> InsertOutcome
}

// MARK: - Dispatcher assembly

public func makeDispatcher(system: SystemActions) -> RpcDispatcher {
    let d = RpcDispatcher()

    d.register("init") { raw in
        let params = try decodeParams(InitParams.self, from: raw)
        guard params.protocolVersion == SIDECAR_PROTOCOL_VERSION else {
            throw RpcError.invalidParams(
                "protocol version mismatch: host=\(params.protocolVersion) sidecar=\(SIDECAR_PROTOCOL_VERSION)")
        }
        return .object([
            "ok": .bool(true),
            "sidecarVersion": .string(SIDECAR_VERSION),
            "protocolVersion": .int(SIDECAR_PROTOCOL_VERSION),
            "pid": .int(Int(ProcessInfo.processInfo.processIdentifier))
        ])
    }

    d.register("checkPermissions") { _ in
        .object([
            "accessibility": .bool(system.accessibilityTrusted()),
            "inputMonitoring": .bool(system.inputMonitoringGranted()),
            // Additive field (optional in the zod schema): mic status as seen
            // from this process. The authoritative mic check for capture is
            // Electron-side (systemPreferences.getMediaAccessStatus).
            "microphone": .string(system.microphoneStatus())
        ])
    }

    d.register("promptAccessibility") { _ in
        let prompted = system.promptAccessibility()
        return .object([
            "prompted": .bool(prompted),
            "accessibility": .bool(system.accessibilityTrusted())
        ])
    }

    d.register("frontmostApp") { _ in
        let (app, title) = system.frontmostApp()
        let appJson: JSON
        if let app {
            appJson = .object([
                "bundleId": .string(app.bundleId),
                "name": .string(app.name),
                "pid": .int(app.pid)
            ])
        } else {
            appJson = .null
        }
        return .object([
            "app": appJson,
            "windowTitle": title.map { JSON.string($0) } ?? .null
        ])
    }

    d.register("secureInputState") { _ in
        .object([
            "active": .bool(system.secureInputActive()),
            // The OS does not cleanly expose the holding pid; null for v0.
            "pid": .null
        ])
    }

    d.register("insertText") { raw in
        let params = try decodeParams(InsertTextParams.self, from: raw)
        if let strategy = params.strategy {
            guard ["ax", "paste", "type"].contains(strategy) else {
                throw RpcError.invalidParams("unknown strategy '\(strategy)'")
            }
            if strategy == "ax" {
                // AX writes land in M2 with the focused-element reader.
                throw RpcError.notImplemented("insertText strategy 'ax' lands in M2")
            }
        }
        if system.secureInputActive() {
            return .object([
                "inserted": .bool(false),
                "strategyUsed": .null,
                "reason": .string("secure-input")
            ])
        }
        if !system.accessibilityTrusted() {
            return .object([
                "inserted": .bool(false),
                "strategyUsed": .null,
                "reason": .string("no-accessibility")
            ])
        }
        // v0 default chain is paste (ax is M2; type on request).
        let strategy = params.strategy ?? "paste"
        let outcome = system.insert(text: params.text, strategy: strategy)
        return .object([
            "inserted": .bool(outcome.inserted),
            "strategyUsed": outcome.strategyUsed.map { JSON.string($0) } ?? .null,
            "reason": outcome.reason.map { JSON.string($0) } ?? .null
        ])
    }

    // M2 verbs: explicit NotImplemented (clearer than method-not-found).
    for verb in ["focusedElement", "replaceSelection", "activateApp", "keyChord"] {
        d.register(verb) { _ in
            throw RpcError.notImplemented("\(verb) lands in M2")
        }
    }

    return d
}
