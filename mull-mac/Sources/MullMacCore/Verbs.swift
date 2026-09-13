import Foundation

/// Verb registration + param validation.
///
/// Mirrors `src/shared/sidecar-api.ts`, which is the source of truth. As of M2
/// every verb in that map is implemented: init, checkPermissions,
/// promptAccessibility, frontmostApp, focusedElement, insertText (ax | paste |
/// type), replaceSelection, replaceRange, secureInputState, activateApp,
/// keyChord.
///
/// Guard order is the same for every write verb, and deliberate:
///   secure input  ->  accessibility  ->  do the thing
/// Secure input comes first because it is the one the user can turn on *after*
/// Mull decided to write, and the one where being wrong means typing a password
/// fragment into a chat window.

/// Protocol 3 (M3): adds the hotkey event tap and, with it, the sidecar's
/// first *notifications* — messages the sidecar sends unprompted. `init`
/// rejects a mismatch loudly, so a stale binary fails at boot rather than
/// returning shapes the host cannot parse.
public let SIDECAR_PROTOCOL_VERSION = 3
public let SIDECAR_VERSION = "0.3.0"

// MARK: - Param structs (mirror the zod schemas)

struct InitParams: Decodable {
    let protocolVersion: Int
}

struct InsertTextParams: Decodable {
    let text: String
    let strategy: String?
    /// Paste settle delay in ms; the host tunes it per app. Default 150.
    let settleMs: Int?
}

struct FocusedElementParams: Decodable {
    let contextBytes: Int?
}

struct ReplaceRangeParams: Decodable {
    let start: Int
    let length: Int
    let text: String
    let expect: String?
}

struct ActivateAppParams: Decodable {
    let bundleId: String
}

struct KeyChordParams: Decodable {
    let key: String
    let modifiers: [String]?
}

struct StartHotkeyTapParams: Decodable {
    /// "opt-space" | "fn"
    let chord: String
    /// Consume the chord so the focused app never sees it. Ignored for Fn.
    let swallow: Bool?
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

public struct SelectionInfo {
    public let start: Int
    public let length: Int
    public let text: String
    public init(start: Int, length: Int, text: String) {
        self.start = start
        self.length = length
        self.text = text
    }
}

public struct FocusedElementInfo {
    public let role: String
    public let editable: Bool
    public let text: String
    public let textStart: Int
    public let truncated: Bool
    public let selection: SelectionInfo?
    public init(
        role: String, editable: Bool, text: String, textStart: Int, truncated: Bool,
        selection: SelectionInfo?
    ) {
        self.role = role
        self.editable = editable
        self.text = text
        self.textStart = textStart
        self.truncated = truncated
        self.selection = selection
    }
}

public enum FocusedElementLookup {
    case found(FocusedElementInfo)
    /// 'no-accessibility' | 'no-focused-element' | 'unreadable'
    case unavailable(String)
}

/// One shape for every write verb. `verified` is tri-state on purpose: nil means
/// "the target would not tell us", which is different from "we checked and it
/// wasn't there" (false).
public struct InsertOutcome {
    public let inserted: Bool
    public let strategyUsed: String?
    public let reason: String?
    public let verified: Bool?
    public let caret: Int?
    public let replacedText: String?

    public init(
        inserted: Bool,
        strategyUsed: String?,
        reason: String?,
        verified: Bool? = nil,
        caret: Int? = nil,
        replacedText: String? = nil
    ) {
        self.inserted = inserted
        self.strategyUsed = strategyUsed
        self.reason = reason
        self.verified = verified
        self.caret = caret
        self.replacedText = replacedText
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
    /// Read the focused element, clamped to `context` UTF-16 units per side.
    func focusedElement(context: Int) -> FocusedElementLookup
    /// Insert at the caret with a concrete strategy ("ax" | "paste" | "type").
    func insert(text: String, strategy: String, settleMs: Int) -> InsertOutcome
    /// Replace the current selection, reporting what was there before.
    func replaceSelection(text: String, strategy: String, settleMs: Int) -> InsertOutcome
    /// Replace an explicit UTF-16 range. AX-only; this is undo's instrument.
    func replaceRange(start: Int, length: Int, text: String, expect: String?) -> InsertOutcome
    func activateApp(bundleId: String) -> (activated: Bool, reason: String?)
    func keyChord(key: String, modifiers: [String]) -> (sent: Bool, reason: String?)
    /// Watch the push-to-talk chord. Emits `hotkey` notifications until stopped.
    func startHotkeyTap(chord: String, swallow: Bool) -> (started: Bool, reason: String?)
    func stopHotkeyTap() -> Bool
}

// MARK: - JSON helpers

private func optional(_ value: String?) -> JSON { value.map { JSON.string($0) } ?? .null }
private func optional(_ value: Bool?) -> JSON { value.map { JSON.bool($0) } ?? .null }
private func optional(_ value: Int?) -> JSON { value.map { JSON.int($0) } ?? .null }

private func insertJSON(_ outcome: InsertOutcome, key: String) -> JSON {
    .object([
        key: .bool(outcome.inserted),
        "strategyUsed": optional(outcome.strategyUsed),
        "reason": optional(outcome.reason),
        "verified": optional(outcome.verified),
        "caret": optional(outcome.caret)
    ])
}

private let knownStrategies = ["ax", "paste", "type"]

/// Paste settle delay when the caller does not specify one.
let DEFAULT_SETTLE_MS = 150

// MARK: - Dispatcher assembly

public func makeDispatcher(system: SystemActions) -> RpcDispatcher {
    let d = RpcDispatcher()

    /// Shared preflight for anything that writes into another app.
    func blockedReason() -> String? {
        if system.secureInputActive() { return "secure-input" }
        if !system.accessibilityTrusted() { return "no-accessibility" }
        return nil
    }

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
        return .object([
            "app": appJSON(app),
            "windowTitle": optional(title)
        ])
    }

    d.register("secureInputState") { _ in
        .object([
            "active": .bool(system.secureInputActive()),
            // The OS does not cleanly expose the holding pid; null for v0.
            "pid": .null
        ])
    }

    d.register("focusedElement") { raw in
        let params = try decodeParams(
            FocusedElementParams.self, from: raw,
            defaultIfMissing: FocusedElementParams(contextBytes: nil))
        let context = min(max(params.contextBytes ?? 2048, 1), 8192)
        let (app, _) = system.frontmostApp()

        switch system.focusedElement(context: context) {
        case .found(let element):
            return .object([
                "element": .object([
                    "role": .string(element.role),
                    "editable": .bool(element.editable),
                    "text": .string(element.text),
                    "textStart": .int(element.textStart),
                    "truncated": .bool(element.truncated),
                    "selection": element.selection.map {
                        JSON.object([
                            "start": .int($0.start),
                            "length": .int($0.length),
                            "text": .string($0.text)
                        ])
                    } ?? .null
                ]),
                "app": appJSON(app),
                "reason": .null
            ])
        case .unavailable(let reason):
            return .object([
                "element": .null,
                "app": appJSON(app),
                "reason": .string(reason)
            ])
        }
    }

    d.register("insertText") { raw in
        let params = try decodeParams(InsertTextParams.self, from: raw)
        if let strategy = params.strategy, !knownStrategies.contains(strategy) {
            throw RpcError.invalidParams("unknown strategy '\(strategy)'")
        }
        if let reason = blockedReason() {
            return insertJSON(
                InsertOutcome(inserted: false, strategyUsed: nil, reason: reason), key: "inserted")
        }
        // The host picks the strategy from its per-app table
        // (src/main/services/insertion-table.ts); paste is the safe default for
        // a caller that does not.
        let strategy = params.strategy ?? "paste"
        let outcome = system.insert(
            text: params.text, strategy: strategy, settleMs: params.settleMs ?? DEFAULT_SETTLE_MS)
        return insertJSON(outcome, key: "inserted")
    }

    d.register("replaceSelection") { raw in
        let params = try decodeParams(InsertTextParams.self, from: raw)
        if let strategy = params.strategy, !knownStrategies.contains(strategy) {
            throw RpcError.invalidParams("unknown strategy '\(strategy)'")
        }
        if let reason = blockedReason() {
            return .object([
                "replaced": .bool(false),
                "strategyUsed": .null,
                "reason": .string(reason),
                "verified": .null,
                "caret": .null,
                "replacedText": .null
            ])
        }
        let outcome = system.replaceSelection(
            text: params.text,
            strategy: params.strategy ?? "ax",
            settleMs: params.settleMs ?? DEFAULT_SETTLE_MS)
        return .object([
            "replaced": .bool(outcome.inserted),
            "strategyUsed": optional(outcome.strategyUsed),
            "reason": optional(outcome.reason),
            "verified": optional(outcome.verified),
            "caret": optional(outcome.caret),
            "replacedText": optional(outcome.replacedText)
        ])
    }

    d.register("replaceRange") { raw in
        let params = try decodeParams(ReplaceRangeParams.self, from: raw)
        guard params.start >= 0, params.length >= 0 else {
            throw RpcError.invalidParams("start and length must be non-negative")
        }
        if let reason = blockedReason() {
            return .object([
                "replaced": .bool(false),
                "reason": .string(reason),
                "verified": .null
            ])
        }
        let outcome = system.replaceRange(
            start: params.start, length: params.length, text: params.text, expect: params.expect)
        return .object([
            "replaced": .bool(outcome.inserted),
            "reason": optional(outcome.reason),
            "verified": optional(outcome.verified)
        ])
    }

    d.register("activateApp") { raw in
        let params = try decodeParams(ActivateAppParams.self, from: raw)
        guard !params.bundleId.isEmpty else {
            throw RpcError.invalidParams("bundleId must not be empty")
        }
        let (activated, reason) = system.activateApp(bundleId: params.bundleId)
        return .object(["activated": .bool(activated), "reason": optional(reason)])
    }

    d.register("keyChord") { raw in
        let params = try decodeParams(KeyChordParams.self, from: raw)
        let modifiers = params.modifiers ?? []
        let allowed = ["cmd", "shift", "alt", "ctrl", "fn"]
        for modifier in modifiers where !allowed.contains(modifier) {
            throw RpcError.invalidParams("unknown modifier '\(modifier)'")
        }
        if let reason = blockedReason() {
            return .object(["sent": .bool(false), "reason": .string(reason)])
        }
        let (sent, reason) = system.keyChord(key: params.key, modifiers: modifiers)
        return .object(["sent": .bool(sent), "reason": optional(reason)])
    }

    /// Start watching the push-to-talk chord.
    ///
    /// Deliberately *not* behind `blockedReason()`: the tap only observes, and
    /// a user who has not yet granted Accessibility still needs their hotkey to
    /// work so that the rest of the app can tell them what is missing. Input
    /// Monitoring is the permission that actually gates this, and the failure
    /// comes back as a reason rather than an error — the host has a fallback
    /// ladder to walk down.
    d.register("startHotkeyTap") { raw in
        let params = try decodeParams(StartHotkeyTapParams.self, from: raw)
        guard ["opt-space", "fn"].contains(params.chord) else {
            throw RpcError.invalidParams("unknown chord '\(params.chord)'")
        }
        let (started, reason) = system.startHotkeyTap(
            chord: params.chord, swallow: params.swallow ?? true)
        return .object([
            "started": .bool(started),
            "reason": optional(reason),
            // Fn is observable but not consumable; say so rather than letting
            // the host assume the key never reaches the focused app.
            "swallowing": .bool(started && params.chord != "fn" && (params.swallow ?? true))
        ])
    }

    d.register("stopHotkeyTap") { _ in
        .object(["stopped": .bool(system.stopHotkeyTap())])
    }

    return d
}

private func appJSON(_ app: AppInfo?) -> JSON {
    guard let app else { return .null }
    return .object([
        "bundleId": .string(app.bundleId),
        "name": .string(app.name),
        "pid": .int(app.pid)
    ])
}
