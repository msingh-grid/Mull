import AppKit
import ApplicationServices
import AVFoundation
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import IOKit.hid

/// The real macOS implementation of `SystemActions`.
///
/// Permissions map (all attach to the *responsible* app — in dev that is the
/// Electron.app binary / terminal that spawned us):
///   - CGEvent posting + AX reads  -> Accessibility
///   - Event taps (M3)             -> Input Monitoring
///   - Mic (captured Electron-side)-> Microphone
///
/// The three insertion strategies, in the order the host's table normally tries
/// them:
///   - **ax**    write `AXSelectedText`. Atomic, invisible to the pasteboard,
///               verifiable by read-back, and unsupported by roughly half the
///               apps people actually use.
///   - **paste** swap the pasteboard, post ⌘V, swap it back. Works nearly
///               everywhere; costs a pasteboard round-trip and a settle delay.
///   - **type**  synthesise the characters. Slow and visible, but the only
///               thing some targets (terminals, games, remote desktops) accept.
public final class RealSystem: SystemActions {
    /// Where unprompted messages go. main.swift points this at stdout; tests
    /// and the dispatcher never need it. Nil means "nobody is listening", which
    /// is a valid state — the tap simply has nowhere to report.
    public var notify: ((JSON) -> Void)?

    private lazy var hotkeyTap = HotkeyTap { [weak self] phase, chord in
        self?.notify?(
            .object([
                "jsonrpc": .string("2.0"),
                "method": .string("hotkey"),
                "params": .object([
                    "phase": .string(phase.rawValue),
                    "chord": .string(chord.rawValue)
                ])
            ]))
    }

    public init() {}

    // MARK: - Permissions

    public func accessibilityTrusted() -> Bool {
        AXIsProcessTrusted()
    }

    public func inputMonitoringGranted() -> Bool {
        IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted
    }

    public func microphoneStatus() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "granted"
        case .denied, .restricted: return "denied"
        case .notDetermined: return "undetermined"
        @unknown default: return "undetermined"
        }
    }

    public func promptAccessibility() -> Bool {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
        return true
    }

    public func screenRecordingGranted() -> Bool {
        Screenshot.permitted()
    }

    public func promptScreenRecording() -> Bool {
        Screenshot.requestAccess()
        return true
    }

    // MARK: - Context

    public func frontmostApp() -> (app: AppInfo?, windowTitle: String?) {
        guard let front = Frontmost.resolve() else { return (nil, nil) }
        return (front.app, focusedWindowTitle(pid: front.pid))
    }

    private func focusedWindowTitle(pid: pid_t) -> String? {
        guard AXIsProcessTrusted() else { return nil }
        let appElement = AXUIElementCreateApplication(pid)
        var window: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            appElement, kAXFocusedWindowAttribute as CFString, &window) == .success,
            let window, CFGetTypeID(window) == AXUIElementGetTypeID()
        else { return nil }
        var title: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            // swiftlint:disable:next force_cast
            (window as! AXUIElement), kAXTitleAttribute as CFString, &title) == .success
        else { return nil }
        return title as? String
    }

    public func secureInputActive() -> Bool {
        IsSecureEventInputEnabled()
    }

    /// Read the focused window — text, and optionally a picture of it.
    ///
    /// The two halves are independent on purpose: an app with a hostile AX tree
    /// still photographs, and a Mac without the Screen Recording grant still
    /// reads. Whichever half fails says why rather than taking the other down
    /// with it.
    public func windowContext(maxChars: Int, deadlineMs: Int, screenshot: Bool)
        -> WindowContextInfo
    {
        let (app, title) = frontmostApp()
        guard let pid = app.map({ pid_t($0.pid) }) else {
            return WindowContextInfo(
                blocks: [], truncated: false, stoppedBy: "no-frontmost-app", harvestMs: 0,
                screenshot: nil, screenshotReason: "no-frontmost-app")
        }

        let harvest = AXHarvest.harvest(
            pid: pid,
            budget: AXHarvest.Budget(
                maxChars: maxChars, deadline: TimeInterval(deadlineMs) / 1000))

        var shot: ScreenshotInfo?
        var shotReason: String? = screenshot ? nil : "not-requested"
        if screenshot {
            switch Screenshot.frontWindow(pid: pid, expectedTitle: title) {
            case .success(let capture):
                shot = ScreenshotInfo(
                    path: capture.path, width: capture.width, height: capture.height,
                    bytes: capture.bytes, elapsedMs: capture.elapsedMs)
            case .failure(let failure):
                shotReason = failure.rawValue
            }
        }

        return WindowContextInfo(
            blocks: harvest.blocks.map {
                ContextBlockInfo(
                    role: $0.role, text: $0.text, label: $0.label, focused: $0.focused,
                    selected: $0.selected)
            },
            truncated: harvest.truncated,
            stoppedBy: harvest.stoppedBy,
            harvestMs: harvest.elapsedMs,
            screenshot: shot,
            screenshotReason: shotReason)
    }

    public func uiTargets(maxTargets: Int, deadlineMs: Int) -> UiTargetsInfo {
        let (app, _) = frontmostApp()
        guard let pid = app.map({ pid_t($0.pid) }) else {
            return UiTargetsInfo(
                harvestId: "", targets: [], truncated: false, stoppedBy: "no-frontmost-app",
                scanMs: 0)
        }

        let scan = AXTargets.scan(
            pid: pid,
            budget: AXTargets.Budget(
                maxTargets: maxTargets, deadline: TimeInterval(deadlineMs) / 1000))

        return UiTargetsInfo(
            harvestId: scan.harvestId,
            targets: scan.targets.map { target in
                UiTargetInfo(
                    index: target.index,
                    role: target.role,
                    subrole: target.subrole,
                    title: target.title,
                    help: target.help,
                    value: target.value,
                    frame: target.frame.map {
                        (
                            x: Double($0.origin.x), y: Double($0.origin.y),
                            width: Double($0.size.width), height: Double($0.size.height)
                        )
                    },
                    actions: target.actions,
                    enabled: target.enabled,
                    focused: target.focused,
                    kind: target.kind.rawValue)
            },
            truncated: scan.truncated,
            stoppedBy: scan.stoppedBy,
            scanMs: scan.elapsedMs)
    }

    public func pressTarget(
        harvestId: String, index: Int, expectRole: String?, expectTitle: String?
    ) -> TargetActionInfo {
        let outcome = AXTargets.press(
            harvestId: harvestId, index: index, expectRole: expectRole, expectTitle: expectTitle)
        return TargetActionInfo(
            ok: outcome.ok, reason: outcome.reason, actualRole: outcome.actualRole,
            actualTitle: outcome.actualTitle)
    }

    public func focusTarget(
        harvestId: String, index: Int, expectRole: String?, expectTitle: String?
    ) -> TargetActionInfo {
        let outcome = AXTargets.focus(
            harvestId: harvestId, index: index, expectRole: expectRole, expectTitle: expectTitle)
        return TargetActionInfo(
            ok: outcome.ok, reason: outcome.reason, actualRole: outcome.actualRole,
            actualTitle: outcome.actualTitle)
    }

    public func scrollTarget(
        harvestId: String, index: Int, expectRole: String?, expectTitle: String?
    ) -> TargetActionInfo {
        let outcome = AXTargets.scroll(
            harvestId: harvestId, index: index, expectRole: expectRole, expectTitle: expectTitle)
        return TargetActionInfo(
            ok: outcome.ok, reason: outcome.reason, actualRole: outcome.actualRole,
            actualTitle: outcome.actualTitle)
    }

    /// The only keys the navigator may ask for.
    ///
    /// A separate map from `keyCodes`, not a filter over it, because the point
    /// is that ⏎ cannot be named here. `keyCodes` contains "return" and
    /// "enter"; this one contains neither, and a filter would be one edit away
    /// from letting them through. ⏎ is how Slack, Messages, Discord and Mail all
    /// send — it is the actuator, so it is not navigation.
    ///
    /// No modifier is ever *accepted* — the caller names a key, never a chord,
    /// so there is no ⌘Q, no ⌘W, and no combination that could mean something
    /// else in an app nobody tested.
    ///
    /// `backTab` is the one entry that posts a modifier, and it does not weaken
    /// that. The shift lives here, in Mull's own table, welded to a name; the
    /// caller still cannot compose one, so the set of chords that can leave this
    /// function is exactly as long as this literal. ⇧⇥ is worth the entry
    /// because moving *backwards* through a form is otherwise unreachable —
    /// there is no menu command for it in any application, which is not true of
    /// ⌘F or ⌘S.
    static let navKeyCodes: [String: (code: CGKeyCode, flags: CGEventFlags)] = [
        "escape": (CGKeyCode(kVK_Escape), []),
        "tab": (CGKeyCode(kVK_Tab), []),
        "backtab": (CGKeyCode(kVK_Tab), .maskShift),
        "up": (CGKeyCode(kVK_UpArrow), []),
        "down": (CGKeyCode(kVK_DownArrow), []),
        "left": (CGKeyCode(kVK_LeftArrow), []),
        "right": (CGKeyCode(kVK_RightArrow), []),
        "pageup": (CGKeyCode(kVK_PageUp), []),
        "pagedown": (CGKeyCode(kVK_PageDown), [])
    ]

    public func navKey(key: String) -> (sent: Bool, reason: String?) {
        guard let stroke = Self.navKeyCodes[key.lowercased()] else {
            return (false, "not-a-navigation-key")
        }
        return postKey(stroke.code, flags: stroke.flags)
            ? (true, nil) : (false, "cgevent-post-failed")
    }

    public func focusedElement(context: Int) -> FocusedElementLookup {
        guard AXIsProcessTrusted() else { return .unavailable("no-accessibility") }
        guard let element = AXText.focusedElement() else {
            return .unavailable("no-focused-element")
        }
        guard let snapshot = AXText.snapshot(element, context: context) else {
            return .unavailable("unreadable")
        }
        return .found(
            FocusedElementInfo(
                role: snapshot.role,
                editable: snapshot.editable,
                text: snapshot.text,
                textStart: snapshot.textStart,
                truncated: snapshot.truncated,
                selection: snapshot.selection.map {
                    SelectionInfo(start: $0.start, length: $0.length, text: $0.text)
                }
            ))
    }

    // MARK: - Insertion

    public func insert(text: String, strategy: String, settleMs: Int) -> InsertOutcome {
        switch strategy {
        case "ax":
            return axWrite(text, replacingSelection: false)
        case "paste":
            return pasteInsert(text, settleMs: settleMs)
        case "type":
            return typeInsert(text)
        default:
            return InsertOutcome(inserted: false, strategyUsed: nil, reason: "unknown-strategy")
        }
    }

    public func replaceSelection(text: String, strategy: String, settleMs: Int) -> InsertOutcome {
        // Read what is about to be destroyed first — it is the `before` half of
        // the journal entry, and there is no second chance to read it.
        // Read from the element the write will target, not from whatever has
        // focus — they are not always the same, and a `before` taken from the
        // wrong element would be a lie in the journal.
        let element = AXText.writeTarget(pid: frontmostPid())
        let previous = element.flatMap { AXText.string($0, kAXSelectedTextAttribute) }

        let outcome: InsertOutcome
        switch strategy {
        case "ax":
            outcome = axWrite(text, replacingSelection: true)
        case "paste":
            // ⌘V over a selection replaces it; that is the same gesture a person
            // would make.
            outcome = pasteInsert(text, settleMs: settleMs)
        case "type":
            outcome = typeInsert(text)
        default:
            return InsertOutcome(inserted: false, strategyUsed: nil, reason: "unknown-strategy")
        }

        return InsertOutcome(
            inserted: outcome.inserted,
            strategyUsed: outcome.strategyUsed,
            reason: outcome.reason,
            verified: outcome.verified,
            caret: outcome.caret,
            replacedText: previous
        )
    }

    public func replaceRange(start: Int, length: Int, text: String, expect: String?)
        -> InsertOutcome
    {
        guard let element = AXText.writeTarget(pid: frontmostPid()) else {
            return InsertOutcome(inserted: false, strategyUsed: nil, reason: "no-focused-element")
        }
        guard AXText.settable(element, kAXSelectedTextAttribute) else {
            return InsertOutcome(inserted: false, strategyUsed: nil, reason: "ax-unsupported")
        }

        // The caller tells us what it believes is there. If the document moved
        // under us — the user typed, an autocorrect fired, focus changed — we
        // refuse rather than delete whatever now occupies those offsets.
        if let expect {
            guard let actual = AXText.text(element, start: start, length: length) else {
                return InsertOutcome(inserted: false, strategyUsed: nil, reason: "unreadable")
            }
            guard actual == expect else {
                return InsertOutcome(inserted: false, strategyUsed: nil, reason: "expect-mismatch")
            }
        }

        let lengthBefore = AXText.valueLength(element)
        guard AXText.setSelectedRange(element, start: start, length: length) else {
            return InsertOutcome(inserted: false, strategyUsed: nil, reason: "ax-select-failed")
        }
        guard AXText.setSelectedText(element, text) == .success else {
            return InsertOutcome(inserted: false, strategyUsed: nil, reason: "ax-write-failed")
        }

        // Verify by arithmetic: a replacement of `length` units with `text`
        // must change the value length by exactly this much.
        var verified: Bool?
        if let lengthBefore, let lengthAfter = AXText.valueLength(element) {
            verified = lengthAfter == lengthBefore - length + text.utf16.count
        }
        return InsertOutcome(
            inserted: true,
            strategyUsed: "ax",
            reason: nil,
            verified: verified,
            caret: AXText.caret(element)
        )
    }

    // MARK: ax: write AXSelectedText, then read it back

    private func axWrite(_ text: String, replacingSelection: Bool) -> InsertOutcome {
        guard let element = AXText.writeTarget(pid: frontmostPid()) else {
            return InsertOutcome(inserted: false, strategyUsed: nil, reason: "no-focused-element")
        }
        guard AXText.settable(element, kAXSelectedTextAttribute) else {
            // Not a failure of Mull's — this app simply does not implement the
            // attribute. The host's chain falls through to paste.
            return InsertOutcome(inserted: false, strategyUsed: nil, reason: "ax-unsupported")
        }
        if !replacingSelection,
            let range = AXText.range(element, kAXSelectedTextRangeAttribute), range.length > 0
        {
            // Insert means insert: collapse the selection to its start so a
            // stray selection is not silently overwritten.
            _ = AXText.setSelectedRange(element, start: range.location, length: 0)
        }

        guard AXText.setSelectedText(element, text) == .success else {
            return InsertOutcome(inserted: false, strategyUsed: nil, reason: "ax-write-failed")
        }

        let caret = AXText.caret(element)
        switch caret.map({ AXText.verify(element, text: text, endingAt: $0) }) ?? .unknown {
        case .confirmed:
            return InsertOutcome(
                inserted: true, strategyUsed: "ax", reason: nil, verified: true, caret: caret)
        case .contradicted:
            // AX said yes and the document says no. Report failure so the host
            // falls through to paste — a duplicate is impossible because we
            // just read the range and our text is not in it.
            return InsertOutcome(
                inserted: false, strategyUsed: nil, reason: "ax-verify-failed", verified: false)
        case .unknown:
            return InsertOutcome(
                inserted: true, strategyUsed: "ax", reason: nil, verified: nil, caret: caret)
        }
    }

    // MARK: paste: pasteboard swap + CGEvent ⌘V + restore

    private func pasteInsert(_ text: String, settleMs: Int) -> InsertOutcome {
        let pasteboard = NSPasteboard.general
        let saved = savePasteboard(pasteboard)

        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)

        guard postKey(CGKeyCode(kVK_ANSI_V), flags: .maskCommand) else {
            restorePasteboard(pasteboard, saved: saved)
            return InsertOutcome(inserted: false, strategyUsed: nil, reason: "cgevent-post-failed")
        }

        // Restoring the pasteboard before the target has read it steals the
        // paste. The delay is per-app (docs/INSERTION-MATRIX.md) because
        // Electron targets are an order of magnitude slower than Cocoa ones.
        usleep(UInt32(max(0, settleMs) * 1000))
        restorePasteboard(pasteboard, saved: saved)

        let (verified, caret) = verifyAfterKeyWrite(text)
        return InsertOutcome(
            inserted: true, strategyUsed: "paste", reason: nil, verified: verified, caret: caret)
    }

    // MARK: selectedText: the selection, wherever it is

    /// Find what the user has selected, even when it is not in the focused
    /// element.
    ///
    /// Three ways, in increasing order of how much they disturb the machine:
    ///
    ///   focused  the focused element's own `AXSelectedText`. Free.
    ///   tree     a bounded walk of the frontmost app's AX tree. Cheap, and the
    ///            one that catches "selected a sent message while the composer
    ///            has focus" — the case that made Mull type an instruction into
    ///            a Slack box instead of acting on it.
    ///   copy     post ⌘C and read the pasteboard. Universal, because it is
    ///            what every Mac app implements, and the only option in an app
    ///            whose AX tree hides its selection. It is also the only one
    ///            that presses a key in someone else's app, so the host asks
    ///            for it explicitly and only when the other two found nothing.
    ///
    /// The pasteboard is saved and restored around the copy, the same way the
    /// paste strategy does, so the user's clipboard survives.
    private func frontmostPid() -> pid_t {
        Frontmost.resolve()?.pid ?? 0
    }

    public func selectedText(allowCopy: Bool) -> SelectionLookup {
        guard AXIsProcessTrusted() else {
            return SelectionLookup(text: nil, editable: false, source: nil, reason: "no-accessibility")
        }

        let pid = frontmostPid()
        if pid != 0, let found = AXText.anySelection(pid: pid) {
            return SelectionLookup(
                text: found.text, editable: found.editable, source: found.source, reason: nil)
        }

        guard allowCopy else {
            return SelectionLookup(text: nil, editable: false, source: nil, reason: "no-selection")
        }
        // Never while a password field holds the keyboard: ⌘C there is both
        // useless and exactly the kind of thing this app promises not to do.
        if IsSecureEventInputEnabled() {
            return SelectionLookup(text: nil, editable: false, source: nil, reason: "secure-input")
        }
        return copySelection()
    }

    private func copySelection() -> SelectionLookup {
        let pasteboard = NSPasteboard.general
        let saved = savePasteboard(pasteboard)
        let before = pasteboard.changeCount

        guard postKey(CGKeyCode(kVK_ANSI_C), flags: .maskCommand) else {
            return SelectionLookup(
                text: nil, editable: false, source: nil, reason: "cgevent-post-failed")
        }

        // Poll rather than sleep a fixed amount: a native app answers in a few
        // milliseconds, Electron takes longer, and waiting the worst case every
        // time would be felt.
        var copied: String?
        for _ in 0..<24 {
            usleep(10_000)
            if pasteboard.changeCount != before {
                copied = pasteboard.string(forType: .string)
                break
            }
        }

        restorePasteboard(pasteboard, saved: saved)

        guard let copied, !copied.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            // Nothing was selected, or the app ignored ⌘C. Either way there is
            // nothing to edit, which is a fine answer.
            return SelectionLookup(text: nil, editable: false, source: nil, reason: "no-selection")
        }
        // A copy says nothing about whether the source can be written back to,
        // and guessing "yes" would let an edit try to overwrite a web page.
        return SelectionLookup(text: copied, editable: false, source: "copy", reason: nil)
    }

    private func savePasteboard(_ pasteboard: NSPasteboard) -> [[NSPasteboard.PasteboardType: Data]] {
        (pasteboard.pasteboardItems ?? []).map { item in
            var entry: [NSPasteboard.PasteboardType: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) {
                    entry[type] = data
                }
            }
            return entry
        }
    }

    private func restorePasteboard(
        _ pasteboard: NSPasteboard, saved: [[NSPasteboard.PasteboardType: Data]]
    ) {
        pasteboard.clearContents()
        guard !saved.isEmpty else { return }
        let items = saved.map { entry -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in entry {
                item.setData(data, forType: type)
            }
            return item
        }
        pasteboard.writeObjects(items)
    }

    // MARK: type: CGEvent unicode typing

    private func typeInsert(_ text: String) -> InsertOutcome {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            return InsertOutcome(inserted: false, strategyUsed: nil, reason: "cgevent-post-failed")
        }
        let utf16 = Array(text.utf16)
        // keyboardSetUnicodeString caps at ~20 UTF-16 units per event.
        let chunkSize = 20
        var index = 0
        while index < utf16.count {
            let chunk = Array(utf16[index..<min(index + chunkSize, utf16.count)])
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
            else {
                return InsertOutcome(inserted: false, strategyUsed: nil, reason: "cgevent-post-failed")
            }
            down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
            usleep(5_000)
            index += chunkSize
        }

        let (verified, caret) = verifyAfterKeyWrite(text)
        return InsertOutcome(
            inserted: true, strategyUsed: "type", reason: nil, verified: verified, caret: caret)
    }

    /// Best-effort read-back for the key-event strategies. They are fire and
    /// forget by nature, so an unreadable element yields nil (unknown) — never a
    /// confident `true`. When the element *is* readable this is what tells the
    /// insertion matrix that a paste into some app silently did nothing.
    private func verifyAfterKeyWrite(_ text: String) -> (verified: Bool?, caret: Int?) {
        guard let element = AXText.focusedElement(), let caret = AXText.caret(element) else {
            return (nil, nil)
        }
        switch AXText.verify(element, text: text, endingAt: caret) {
        case .confirmed: return (true, caret)
        case .contradicted: return (false, caret)
        case .unknown: return (nil, caret)
        }
    }

    // MARK: - App activation and key chords

    public func activateApp(bundleId: String) -> (activated: Bool, reason: String?) {
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
        guard let app = running.first else {
            // Launching apps is an M5 command with its own confirmation; the
            // sidecar only ever raises something already running.
            return (false, "not-running")
        }
        let activated: Bool
        if #available(macOS 14.0, *) {
            activated = app.activate()
        } else {
            activated = app.activate(options: [.activateIgnoringOtherApps])
        }
        // We just moved the front ourselves, so the cached answer describes the
        // app we left. Everything the navigator does after an activation — the
        // settle, the scan, the press — would otherwise spend the TTL aimed at
        // the wrong process.
        if activated { Frontmost.invalidate() }
        return (activated, activated ? nil : "activate-failed")
    }

    public func keyChord(key: String, modifiers: [String]) -> (sent: Bool, reason: String?) {
        guard let code = Self.keyCodes[key.lowercased()] else {
            return (false, "unknown-key")
        }
        var flags: CGEventFlags = []
        for modifier in modifiers {
            switch modifier {
            case "cmd": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "alt": flags.insert(.maskAlternate)
            case "ctrl": flags.insert(.maskControl)
            case "fn": flags.insert(.maskSecondaryFn)
            default: return (false, "unknown-modifier")
            }
        }
        return postKey(code, flags: flags)
            ? (true, nil)
            : (false, "cgevent-post-failed")
    }

    private func postKey(_ code: CGKeyCode, flags: CGEventFlags) -> Bool {
        guard let source = CGEventSource(stateID: .combinedSessionState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
        else { return false }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        // Small gap so the target sees a plausible key press.
        usleep(8_000)
        up.post(tap: .cghidEventTap)
        return true
    }

    /// The keys the whitelisted verbs need — not a full keyboard map. Anything
    /// absent is rejected as `unknown-key` rather than approximated.
    static let keyCodes: [String: CGKeyCode] = {
        var map: [String: CGKeyCode] = [
            "return": CGKeyCode(kVK_Return),
            "enter": CGKeyCode(kVK_Return),
            "tab": CGKeyCode(kVK_Tab),
            "space": CGKeyCode(kVK_Space),
            "delete": CGKeyCode(kVK_Delete),
            "backspace": CGKeyCode(kVK_Delete),
            "forwarddelete": CGKeyCode(kVK_ForwardDelete),
            "escape": CGKeyCode(kVK_Escape),
            "left": CGKeyCode(kVK_LeftArrow),
            "right": CGKeyCode(kVK_RightArrow),
            "up": CGKeyCode(kVK_UpArrow),
            "down": CGKeyCode(kVK_DownArrow),
            "home": CGKeyCode(kVK_Home),
            "end": CGKeyCode(kVK_End),
            "pageup": CGKeyCode(kVK_PageUp),
            "pagedown": CGKeyCode(kVK_PageDown)
        ]
        let letters: [(String, Int)] = [
            ("a", kVK_ANSI_A), ("b", kVK_ANSI_B), ("c", kVK_ANSI_C), ("d", kVK_ANSI_D),
            ("e", kVK_ANSI_E), ("f", kVK_ANSI_F), ("g", kVK_ANSI_G), ("h", kVK_ANSI_H),
            ("i", kVK_ANSI_I), ("j", kVK_ANSI_J), ("k", kVK_ANSI_K), ("l", kVK_ANSI_L),
            ("m", kVK_ANSI_M), ("n", kVK_ANSI_N), ("o", kVK_ANSI_O), ("p", kVK_ANSI_P),
            ("q", kVK_ANSI_Q), ("r", kVK_ANSI_R), ("s", kVK_ANSI_S), ("t", kVK_ANSI_T),
            ("u", kVK_ANSI_U), ("v", kVK_ANSI_V), ("w", kVK_ANSI_W), ("x", kVK_ANSI_X),
            ("y", kVK_ANSI_Y), ("z", kVK_ANSI_Z)
        ]
        for (name, code) in letters { map[name] = CGKeyCode(code) }
        let digits: [(String, Int)] = [
            ("0", kVK_ANSI_0), ("1", kVK_ANSI_1), ("2", kVK_ANSI_2), ("3", kVK_ANSI_3),
            ("4", kVK_ANSI_4), ("5", kVK_ANSI_5), ("6", kVK_ANSI_6), ("7", kVK_ANSI_7),
            ("8", kVK_ANSI_8), ("9", kVK_ANSI_9)
        ]
        for (name, code) in digits { map[name] = CGKeyCode(code) }
        return map
    }()

    // MARK: - Hotkey tap (M3)

    public func startHotkeyTap(chords: [String], swallow: Bool) -> (started: Bool, reason: String?) {
        let parsed = chords.compactMap(HotkeyTap.Chord.init(rawValue:))
        guard parsed.count == chords.count, !parsed.isEmpty else {
            return (false, "unknown-chord")
        }
        return hotkeyTap.start(chords: parsed, swallow: swallow)
    }

    public func stopHotkeyTap() -> Bool {
        let wasRunning = hotkeyTap.isRunning
        hotkeyTap.stop()
        return wasRunning
    }
}
