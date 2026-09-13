import CoreGraphics
import Foundation
import IOKit.hid

/// The push-to-talk key, watched at the window-server level.
///
/// M1 needed two listeners to cover one key: Electron's `globalShortcut` could
/// *consume* ⌥Space (so no stray U+00A0 reached the app) but only reported
/// key-down, and `uiohook-napi` could see key-up but could not consume. A
/// `CGEventTap` does both, which is the whole reason this exists.
///
/// Three things about taps that shape the code:
///
///  - **A tap needs a live CFRunLoop.** The sidecar's main thread used to block
///    on `readLine()`; it now runs the run loop while stdin is read on a
///    background thread (see main.swift). The callback below therefore fires on
///    the main thread, and everything it touches lives there.
///  - **macOS disables slow taps.** If a callback takes too long the system
///    sends `.tapDisabledByTimeout` and stops delivering events — silently, and
///    permanently unless re-enabled. That is handled explicitly; a hotkey that
///    quietly stops working after a hitch is worse than one that never worked.
///  - **Fn cannot be swallowed.** The globe/Fn key is handled partly above this
///    layer, so the tap can observe it but the system may still act on it. That
///    is why Fn is opt-in in settings, and why `swallow` is ignored for it
///    rather than promised and not delivered.
public final class HotkeyTap {
    public enum Chord: String {
        case optSpace = "opt-space"
        case fn
    }

    public enum Phase: String {
        case down
        case up
    }

    private let emit: (Phase, Chord) -> Void
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var chord: Chord = .optSpace
    private var swallow = true
    /// True between an emitted `down` and its `up` — the guard against key
    /// auto-repeat turning one press into forty.
    private var held = false

    public init(emit: @escaping (Phase, Chord) -> Void) {
        self.emit = emit
    }

    public var isRunning: Bool { tap != nil }

    /// Returns `(started, reason)`; `reason` is non-nil only on failure.
    public func start(chord: Chord, swallow: Bool) -> (started: Bool, reason: String?) {
        stop()
        self.chord = chord
        // Honest about Fn: asked to swallow, we do not pretend we can.
        self.swallow = swallow && chord != .fn
        self.held = false

        guard IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted else {
            return (false, "no-input-monitoring")
        }

        let mask =
            (1 << CGEventType.keyDown.rawValue)
            | (1 << CGEventType.keyUp.rawValue)
            | (1 << CGEventType.flagsChanged.rawValue)

        guard
            let port = CGEvent.tapCreate(
                tap: .cgSessionEventTap,
                place: .headInsertEventTap,
                // `defaultTap` (not `listenOnly`) is what allows returning nil
                // to consume the event.
                options: .defaultTap,
                eventsOfInterest: CGEventMask(mask),
                callback: hotkeyTapCallback,
                userInfo: Unmanaged.passUnretained(self).toOpaque()
            )
        else {
            return (false, "tap-refused")
        }

        let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
        // The run loop is the main thread's; adding to it from here is safe and
        // means start() can answer synchronously instead of hopping threads.
        CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        CFRunLoopWakeUp(CFRunLoopGetMain())

        self.tap = port
        self.source = runLoopSource
        return (true, nil)
    }

    public func stop() {
        if let source {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
            self.source = nil
        }
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
            self.tap = nil
        }
        // A tap torn down mid-press must not leave the host believing the key
        // is still down, or dictation records until something else stops it.
        if held {
            held = false
            emit(.up, chord)
        }
    }

    fileprivate func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        let passthrough = Unmanaged.passUnretained(event)

        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            // The press that was in flight is lost; end it rather than hang.
            if held {
                held = false
                emit(.up, chord)
            }
            return passthrough
        }

        switch chord {
        case .optSpace:
            return handleOptSpace(type: type, event: event, passthrough: passthrough)
        case .fn:
            return handleFn(type: type, event: event, passthrough: passthrough)
        }
    }

    private func handleOptSpace(
        type: CGEventType, event: CGEvent, passthrough: Unmanaged<CGEvent>
    ) -> Unmanaged<CGEvent>? {
        let spaceKeyCode: Int64 = 49
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        let optionDown = event.flags.contains(.maskAlternate)

        switch type {
        case .keyDown where keyCode == spaceKeyCode && optionDown:
            if !held {
                held = true
                emit(.down, chord)
            }
            // Consuming key-down is what keeps the non-breaking space ⌥Space
            // normally types out of the user's document.
            return swallow ? nil : passthrough

        case .keyUp where keyCode == spaceKeyCode:
            if held {
                held = false
                emit(.up, chord)
                return swallow ? nil : passthrough
            }
            return passthrough

        case .flagsChanged where held && !optionDown:
            // Option released before space: the chord is over either way, and
            // the key-up for space may never carry the modifier we matched on.
            held = false
            emit(.up, chord)
            return passthrough

        default:
            return passthrough
        }
    }

    private func handleFn(
        type: CGEventType, event: CGEvent, passthrough: Unmanaged<CGEvent>
    ) -> Unmanaged<CGEvent>? {
        guard type == .flagsChanged else { return passthrough }
        let down = event.flags.contains(.maskSecondaryFn)
        if down != held {
            held = down
            emit(down ? .down : .up, chord)
        }
        return passthrough
    }
}

/// C callback: recover the tap from the refcon and hand off.
private func hotkeyTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let refcon else { return Unmanaged.passUnretained(event) }
    let tap = Unmanaged<HotkeyTap>.fromOpaque(refcon).takeUnretainedValue()
    return tap.handle(type: type, event: event)
}
