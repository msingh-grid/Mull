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

/// Protocol 5 (M5a): `windowContext` — the focused window read two ways, as an
/// Accessibility transcript and as a JPEG — plus `promptScreenRecording` and a
/// `screenRecording` field on `checkPermissions`. `init` rejects a mismatch
/// loudly, so a stale binary fails at boot rather than returning shapes the
/// host cannot parse.
/// Protocol 7 (M5a Stage 5): `uiTargets` — the same window read a third way, as
/// a numbered list of things that can be pressed or typed into. A read, like
/// `windowContext`, and under the same guards; nothing here acts.
public let SIDECAR_PROTOCOL_VERSION = 7
public let SIDECAR_VERSION = "0.7.0"

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

struct SelectedTextParams: Decodable {
    let allowCopy: Bool?
}

struct WindowContextParams: Decodable {
    let maxChars: Int?
    let deadlineMs: Int?
    let screenshot: Bool?
}

struct UiTargetsParams: Decodable {
    let maxTargets: Int?
    let deadlineMs: Int?
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
    /// Chords to watch at once: "opt-space" and/or "fn" (M5a — they mean
    /// different things now, so both are watched rather than one chosen).
    let chords: [String]
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

/// A selection found anywhere in the frontmost app, and whether it can be
/// written back to. `editable: false` is the interesting case: text the user
/// can point at but Mull cannot rewrite in place — a sent message, a web page,
/// somebody else's document.
public struct SelectionLookup {
    public let text: String?
    public let editable: Bool
    /// "focused" | "tree" | "copy", or nil when nothing was found.
    public let source: String?
    public let reason: String?
    public init(text: String?, editable: Bool, source: String?, reason: String?) {
        self.text = text
        self.editable = editable
        self.source = source
        self.reason = reason
    }
}

/// One readable thing in the window, in the order it appears.
public struct ContextBlockInfo {
    public let role: String
    public let text: String
    public let label: String?
    public let focused: Bool
    public let selected: Bool
    public init(role: String, text: String, label: String?, focused: Bool, selected: Bool) {
        self.role = role
        self.text = text
        self.label = label
        self.focused = focused
        self.selected = selected
    }
}

/// One actionable thing in the window, as the host and the model see it.
///
/// `index` is the address. The model is shown this list and answers with a
/// number, never a name — see `AXTargets` for why that is the whole reason
/// pressing things is safe to build at all.
public struct UiTargetInfo {
    public let index: Int
    public let role: String
    public let subrole: String?
    public let title: String
    public let help: String?
    public let value: String?
    /// Screen rectangle, when the element reports one. Sent so the model can
    /// line this list up against the screenshot beside it.
    public let frame: (x: Double, y: Double, width: Double, height: Double)?
    public let actions: [String]
    public let enabled: Bool
    public let focused: Bool
    /// "press" | "type".
    public let kind: String

    public init(
        index: Int, role: String, subrole: String?, title: String, help: String?, value: String?,
        frame: (x: Double, y: Double, width: Double, height: Double)?, actions: [String],
        enabled: Bool, focused: Bool, kind: String
    ) {
        self.index = index
        self.role = role
        self.subrole = subrole
        self.title = title
        self.help = help
        self.value = value
        self.frame = frame
        self.actions = actions
        self.enabled = enabled
        self.focused = focused
        self.kind = kind
    }
}

public struct UiTargetsInfo {
    /// Names the set of element handles the sidecar is holding. A press quotes
    /// it back, so a press decided against a stale look is refused rather than
    /// landing on whatever now occupies that index.
    public let harvestId: String
    public let targets: [UiTargetInfo]
    public let truncated: Bool
    public let stoppedBy: String
    public let scanMs: Int

    public init(
        harvestId: String, targets: [UiTargetInfo], truncated: Bool, stoppedBy: String, scanMs: Int
    ) {
        self.harvestId = harvestId
        self.targets = targets
        self.truncated = truncated
        self.stoppedBy = stoppedBy
        self.scanMs = scanMs
    }
}

public struct ScreenshotInfo {
    public let path: String
    public let width: Int
    public let height: Int
    public let bytes: Int
    public let elapsedMs: Int
    public init(path: String, width: Int, height: Int, bytes: Int, elapsedMs: Int) {
        self.path = path
        self.width = width
        self.height = height
        self.bytes = bytes
        self.elapsedMs = elapsedMs
    }
}

/// The window, read both ways. `screenshot` is nil whenever the picture was not
/// taken — not requested, not permitted, or it failed — and `screenshotReason`
/// always says which, because "no image" and "no image *because*" are different
/// facts to the host.
public struct WindowContextInfo {
    public let blocks: [ContextBlockInfo]
    public let truncated: Bool
    public let stoppedBy: String
    public let harvestMs: Int
    public let screenshot: ScreenshotInfo?
    public let screenshotReason: String?
    public init(
        blocks: [ContextBlockInfo], truncated: Bool, stoppedBy: String, harvestMs: Int,
        screenshot: ScreenshotInfo?, screenshotReason: String?
    ) {
        self.blocks = blocks
        self.truncated = truncated
        self.stoppedBy = stoppedBy
        self.harvestMs = harvestMs
        self.screenshot = screenshot
        self.screenshotReason = screenshotReason
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
    /// CGPreflightScreenCaptureAccess() — gates the picture half of
    /// `windowContext`. Never prompts.
    func screenRecordingGranted() -> Bool
    /// Show the Screen Recording prompt. The grant needs a relaunch to take
    /// effect, so the caller must re-read rather than assume.
    func promptScreenRecording() -> Bool
    /// 'granted' | 'denied' | 'undetermined' — AVCaptureDevice status for THIS
    /// process; in dev TCC attributes it to the responsible (parent) app.
    func microphoneStatus() -> String
    func promptAccessibility() -> Bool
    func frontmostApp() -> (app: AppInfo?, windowTitle: String?)
    func secureInputActive() -> Bool
    /// Read the focused element, clamped to `context` UTF-16 units per side.
    func focusedElement(context: Int) -> FocusedElementLookup
    /// The selection, wherever it is in the frontmost app. `allowCopy` permits
    /// the ⌘C fallback, which presses a key in someone else's app and so is
    /// never taken without the host asking for it.
    func selectedText(allowCopy: Bool) -> SelectionLookup
    /// The whole focused window, as an Accessibility transcript and — when
    /// asked and permitted — as a JPEG on disk. A read; it presses nothing.
    func windowContext(maxChars: Int, deadlineMs: Int, screenshot: Bool) -> WindowContextInfo
    /// Everything in the focused window that can be pressed or typed into,
    /// numbered. Also a read — it presses nothing, and the numbering is the
    /// only thing a later `pressTarget` is allowed to act on.
    func uiTargets(maxTargets: Int, deadlineMs: Int) -> UiTargetsInfo
    /// Insert at the caret with a concrete strategy ("ax" | "paste" | "type").
    func insert(text: String, strategy: String, settleMs: Int) -> InsertOutcome
    /// Replace the current selection, reporting what was there before.
    func replaceSelection(text: String, strategy: String, settleMs: Int) -> InsertOutcome
    /// Replace an explicit UTF-16 range. AX-only; this is undo's instrument.
    func replaceRange(start: Int, length: Int, text: String, expect: String?) -> InsertOutcome
    func activateApp(bundleId: String) -> (activated: Bool, reason: String?)
    func keyChord(key: String, modifiers: [String]) -> (sent: Bool, reason: String?)
    /// Watch the push-to-talk chord. Emits `hotkey` notifications until stopped.
    func startHotkeyTap(chords: [String], swallow: Bool) -> (started: Bool, reason: String?)
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
            "screenRecording": .bool(system.screenRecordingGranted()),
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

    d.register("promptScreenRecording") { _ in
        let prompted = system.promptScreenRecording()
        return .object([
            "prompted": .bool(prompted),
            // Re-read rather than echo the click: the grant does not take
            // effect until relaunch, so this is usually still false. Saying so
            // is the point — a ✓ never comes from the button.
            "screenRecording": .bool(system.screenRecordingGranted())
        ])
    }

    /// Read the focused window: the AX tree in reading order, and optionally a
    /// picture of it.
    ///
    /// Deliberately *not* behind `blockedReason()`. That guard is for verbs
    /// that write into another app, and its secure-input clause is about not
    /// typing a password fragment somewhere. This verb types nothing — but it
    /// reads, and reading a password field is its own harm, so secure input is
    /// checked here on its own terms and refuses the whole thing.
    d.register("windowContext") { raw in
        let params = try decodeParams(
            WindowContextParams.self, from: raw,
            defaultIfMissing: WindowContextParams(
                maxChars: nil, deadlineMs: nil, screenshot: nil))
        let (app, title) = system.frontmostApp()

        func empty(_ reason: String) -> JSON {
            .object([
                "app": appJSON(app),
                "windowTitle": optional(title),
                "blocks": .array([]),
                "truncated": .bool(false),
                "stoppedBy": .string(reason),
                "harvestMs": .int(0),
                "screenshot": .null,
                "screenshotReason": .string(reason)
            ])
        }

        if system.secureInputActive() { return empty("secure-input") }
        guard system.accessibilityTrusted() else { return empty("no-accessibility") }

        let info = system.windowContext(
            maxChars: min(max(params.maxChars ?? 12_000, 200), 32_000),
            deadlineMs: min(max(params.deadlineMs ?? 350, 50), 2_000),
            screenshot: params.screenshot ?? false)

        return .object([
            "app": appJSON(app),
            "windowTitle": optional(title),
            "blocks": .array(
                info.blocks.map { block in
                    .object([
                        "role": .string(block.role),
                        "text": .string(block.text),
                        "label": optional(block.label),
                        "focused": .bool(block.focused),
                        "selected": .bool(block.selected)
                    ])
                }),
            "truncated": .bool(info.truncated),
            "stoppedBy": .string(info.stoppedBy),
            "harvestMs": .int(info.harvestMs),
            "screenshot": info.screenshot.map { shot in
                JSON.object([
                    "path": .string(shot.path),
                    "width": .int(shot.width),
                    "height": .int(shot.height),
                    "bytes": .int(shot.bytes),
                    "elapsedMs": .int(shot.elapsedMs)
                ])
            } ?? .null,
            "screenshotReason": optional(info.screenshotReason)
        ])
    }

    /// What can be pressed here.
    ///
    /// Guarded exactly like `windowContext` and for the same reason: it writes
    /// nothing, but it reads, and enumerating the controls of a password
    /// manager is its own harm. Secure input refuses the whole thing.
    d.register("uiTargets") { raw in
        let params = try decodeParams(
            UiTargetsParams.self, from: raw,
            defaultIfMissing: UiTargetsParams(maxTargets: nil, deadlineMs: nil))
        let (app, title) = system.frontmostApp()

        func empty(_ reason: String) -> JSON {
            .object([
                "app": appJSON(app),
                "windowTitle": optional(title),
                "harvestId": .string(""),
                "targets": .array([]),
                "truncated": .bool(false),
                "stoppedBy": .string(reason),
                "scanMs": .int(0)
            ])
        }

        if system.secureInputActive() { return empty("secure-input") }
        guard system.accessibilityTrusted() else { return empty("no-accessibility") }

        let info = system.uiTargets(
            maxTargets: min(max(params.maxTargets ?? 120, 1), 400),
            deadlineMs: min(max(params.deadlineMs ?? 800, 50), 2_000))

        return .object([
            "app": appJSON(app),
            "windowTitle": optional(title),
            "harvestId": .string(info.harvestId),
            "targets": .array(
                info.targets.map { target in
                    .object([
                        "index": .int(target.index),
                        "role": .string(target.role),
                        "subrole": optional(target.subrole),
                        "title": .string(target.title),
                        "help": optional(target.help),
                        "value": optional(target.value),
                        "frame": target.frame.map { frame in
                            JSON.object([
                                "x": .double(frame.x),
                                "y": .double(frame.y),
                                "width": .double(frame.width),
                                "height": .double(frame.height)
                            ])
                        } ?? .null,
                        "actions": .array(target.actions.map { .string($0) }),
                        "enabled": .bool(target.enabled),
                        "focused": .bool(target.focused),
                        "kind": .string(target.kind)
                    ])
                }),
            "truncated": .bool(info.truncated),
            "stoppedBy": .string(info.stoppedBy),
            "scanMs": .int(info.scanMs)
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

    d.register("selectedText") { raw in
        let params = try decodeParams(
            SelectedTextParams.self, from: raw,
            defaultIfMissing: SelectedTextParams(allowCopy: nil))
        let found = system.selectedText(allowCopy: params.allowCopy ?? false)
        return .object([
            "text": optional(found.text),
            "editable": .bool(found.editable),
            "source": optional(found.source),
            "reason": optional(found.reason)
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
        let chords = params.chords
        guard !chords.isEmpty else { throw RpcError.invalidParams("no chords given") }
        for chord in chords where !["opt-space", "fn"].contains(chord) {
            throw RpcError.invalidParams("unknown chord '\(chord)'")
        }
        let (started, reason) = system.startHotkeyTap(
            chords: chords, swallow: params.swallow ?? true)
        return .object([
            "started": .bool(started),
            "reason": optional(reason),
            // Fn is observable but not consumable; say so rather than letting
            // the host assume the key never reaches the focused app. Reported
            // for the *swallowable* chords only — with both watched, ⌥Space is
            // consumed and Fn is not, and the host has to tell the user so.
            "swallowing": .bool(started && chords.contains("opt-space") && (params.swallow ?? true))
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
