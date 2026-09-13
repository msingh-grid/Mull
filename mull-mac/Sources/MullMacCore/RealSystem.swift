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
public final class RealSystem: SystemActions {
    public init() {}

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

    public func frontmostApp() -> (app: AppInfo?, windowTitle: String?) {
        guard let running = NSWorkspace.shared.frontmostApplication else {
            return (nil, nil)
        }
        let info = AppInfo(
            bundleId: running.bundleIdentifier ?? "",
            name: running.localizedName ?? "",
            pid: Int(running.processIdentifier)
        )
        return (info, focusedWindowTitle(pid: running.processIdentifier))
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

    public func insert(text: String, strategy: String) -> InsertOutcome {
        switch strategy {
        case "paste":
            return pasteInsert(text)
        case "type":
            return typeInsert(text)
        default:
            return InsertOutcome(inserted: false, strategyUsed: nil, reason: "unknown-strategy")
        }
    }

    // MARK: paste: pasteboard swap + CGEvent ⌘V + restore

    private func pasteInsert(_ text: String) -> InsertOutcome {
        let pasteboard = NSPasteboard.general
        let saved = savePasteboard(pasteboard)

        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)

        guard postCommandV() else {
            restorePasteboard(pasteboard, saved: saved)
            return InsertOutcome(inserted: false, strategyUsed: nil, reason: "cgevent-post-failed")
        }

        // Give the target app time to service the paste before we restore the
        // pasteboard out from under it. 150ms is enough for native apps; slow
        // Electron targets get retuned in the M2 insertion matrix.
        usleep(150_000)
        restorePasteboard(pasteboard, saved: saved)
        return InsertOutcome(inserted: true, strategyUsed: "paste", reason: nil)
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

    private func postCommandV() -> Bool {
        guard let source = CGEventSource(stateID: .combinedSessionState) else { return false }
        let vKey = CGKeyCode(kVK_ANSI_V)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: false)
        else { return false }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: .cghidEventTap)
        // Small gap so the target sees a plausible key press.
        usleep(8_000)
        up.post(tap: .cghidEventTap)
        return true
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
        return InsertOutcome(inserted: true, strategyUsed: "type", reason: nil)
    }
}
