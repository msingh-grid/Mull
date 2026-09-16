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
///    is why `swallow` is ignored for it rather than promised and not
///    delivered — and why the host tells the user to set "Press the globe key
///    to" to "Do Nothing" in System Settings.
///
/// Since M5a the tap watches **both** chords at once rather than one chosen in
/// settings, because they now mean different things: ⌥Space is dictation and Fn
/// is "do what I say". Each carries its own held state, and a chord's key-down
/// is ignored while any other chord is still held — one utterance at a time,
/// enforced here rather than left for the host to untangle.
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
    private var chords: [Chord] = [.optSpace]
    private var swallow = true
    /// Which chord is mid-press, or nil. Also the guard against key auto-repeat
    /// turning one press into forty, and against a second chord starting an
    /// utterance while the first is still speaking.
    private var held: Chord?

    public init(emit: @escaping (Phase, Chord) -> Void) {
        self.emit = emit
    }

    public var isRunning: Bool { tap != nil }

    /// Returns `(started, reason)`; `reason` is non-nil only on failure.
    ///
    /// `chords` is the set to watch simultaneously. Swallowing applies only to
    /// the ones that can be swallowed — Fn never can, and saying so is the
    /// point of the separate `swallowing` flag in the result.
    public func start(chords: [Chord], swallow: Bool) -> (started: Bool, reason: String?) {
        stop()
        self.chords = chords.isEmpty ? [.optSpace] : chords
        self.swallow = swallow
        self.held = nil

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
        if let chord = held {
            held = nil
            emit(.up, chord)
        }
    }

    fileprivate func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        let passthrough = Unmanaged.passUnretained(event)

        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            // The press that was in flight is lost; end it rather than hang.
            if let chord = held {
                held = nil
                emit(.up, chord)
            }
            return passthrough
        }

        // Fn first: it arrives as a flagsChanged, so it can never be confused
        // with the ⌥Space key event, and checking it first means a Fn release
        // is seen even while the option flag is also in play.
        if chords.contains(.fn) {
            if let result = handleFn(type: type, event: event, passthrough: passthrough) {
                return result
            }
        }
        if chords.contains(.optSpace) {
            if let result = handleOptSpace(type: type, event: event, passthrough: passthrough) {
                return result
            }
        }
        return passthrough
    }

    /// Returns nil for "this event was not mine" — the caller then offers it to
    /// the other chord, and finally passes it through untouched.
    private func handleOptSpace(
        type: CGEventType, event: CGEvent, passthrough: Unmanaged<CGEvent>
    ) -> Unmanaged<CGEvent>? {
        let spaceKeyCode: Int64 = 49
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        let optionDown = event.flags.contains(.maskAlternate)
        let mine = held == .optSpace

        switch type {
        case .keyDown where keyCode == spaceKeyCode && optionDown:
            // Not while something else is mid-press. Two chords starting two
            // utterances over each other is a knot the host should never be
            // handed, and the second press is far more likely to be a mistake.
            if held != nil { return mine ? (swallow ? nil : passthrough) : nil }
            held = .optSpace
            emit(.down, .optSpace)
            // Consuming key-down is what keeps the non-breaking space ⌥Space
            // normally types out of the user's document.
            return swallow ? nil : passthrough

        case .keyUp where keyCode == spaceKeyCode && mine:
            held = nil
            emit(.up, .optSpace)
            return swallow ? nil : passthrough

        case .flagsChanged where mine && !optionDown:
            // Option released before space: the chord is over either way, and
            // the key-up for space may never carry the modifier we matched on.
            held = nil
            emit(.up, .optSpace)
            return passthrough

        default:
            return nil
        }
    }

    /// See `handleOptSpace` for the nil convention.
    private func handleFn(
        type: CGEventType, event: CGEvent, passthrough: Unmanaged<CGEvent>
    ) -> Unmanaged<CGEvent>? {
        guard type == .flagsChanged else { return nil }
        let down = event.flags.contains(.maskSecondaryFn)
        let mine = held == .fn

        if down && !mine {
            // Same rule as above: Fn pressed while ⌥Space is still down is
            // ignored rather than allowed to interrupt.
            if held != nil { return nil }
            held = .fn
            emit(.down, .fn)
            // Never swallowed — the window server handles the globe key partly
            // above this layer, so returning nil here would drop the flag
            // change without stopping whatever macOS does with it.
            return passthrough
        }
        if !down && mine {
            held = nil
            emit(.up, .fn)
            return passthrough
        }
        return nil
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
