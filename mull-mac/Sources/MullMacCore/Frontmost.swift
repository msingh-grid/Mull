import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// Which application is actually in front, asked live.
///
/// This file exists because `NSWorkspace.shared.frontmostApplication` does not
/// work here, and fails in the worst possible way: silently, plausibly, and
/// consistently. It returns the app that was frontmost when the sidecar
/// launched, and then never changes. Measured with a process shaped exactly
/// like this one — no `NSApplication`, `CFRunLoopRun()` on main, work on a
/// background thread — while three apps were activated in turn:
///
///     ws=Zed  ax=Zed            cg=Zed
///     ws=Zed  ax=Notes          cg=Notes
///     ws=Zed  ax=Slack          cg=Slack
///     ws=Zed  ax=Google Chrome  cg=Google Chrome
///
/// `frontmostApplication` is an AppKit property kept current by workspace
/// notifications, and a process that never became an app has nothing delivering
/// them. Both live alternatives tracked every switch.
///
/// ### Why this was worth its own file
///
/// The stale pid did not merely mislabel things. Three separate guards exist to
/// stop Mull acting in a window the user has left — before an apply
/// (`selection.ts`), before pressing ⏎ (`sender.ts`), before ⌥Z (`undo.ts`) —
/// and every one of them compares a *stale reading* against a *stale record*.
/// Stale equals stale, so they agreed, and reported that all was well. A guard
/// that cannot fire is worse than no guard, because it is budgeted for.
///
/// `AXTargets` was in the same position from the other side: it retains live
/// `AXUIElement` handles and re-checks role and title before pressing, so a
/// press aimed at a background app passed verification — the element really was
/// what it claimed to be. It was simply in the wrong process.
///
/// So: one resolver, asked live, and everything downstream takes the pid from
/// here.
public enum Frontmost {

    /// The app in front, and the pid that proves it.
    public struct Resolved {
        public let pid: pid_t
        public let app: AppInfo
        /// Which mechanism answered — "ax" or "window-list". Carried for the
        /// trace, because a machine that is always answering from the fallback
        /// is telling us something about its accessibility grant.
        public let source: String
    }

    /// How long one answer may be reused.
    ///
    /// Not a performance tweak — a consistency one. `windowContext` and
    /// `uiTargets` each need the frontmost app twice: once for the pid the walk
    /// runs against, once for the `app` field in the JSON they return. Those
    /// were two independent calls, which was harmless only while both were
    /// equally wrong. Made live, two calls either side of a 550 ms Chrome scan
    /// could straddle an app switch and produce a result whose nameplate
    /// disagrees with its contents.
    ///
    /// Short enough that a switch is never missed by a human measure — nobody
    /// changes app and speaks inside 150 ms — and long enough to span the pair.
    static let cacheTTL: TimeInterval = 0.15

    private static var cached: (at: CFAbsoluteTime, value: Resolved?)?
    private static let lock = NSLock()

    /// The frontmost app, or nil when nothing owns the front.
    ///
    /// Nil is a real answer, not an error: during a Space transition, or with
    /// only the desktop showing, there genuinely is no frontmost application.
    /// Callers already treat a missing app as "there is nothing to act on".
    public static func resolve() -> Resolved? {
        lock.lock()
        defer { lock.unlock() }

        let now = CFAbsoluteTimeGetCurrent()
        if let cached, now - cached.at < cacheTTL { return cached.value }

        let value = query()
        cached = (now, value)
        return value
    }

    /// Drop the cached answer.
    ///
    /// For the tests, and for anything that knows the front just moved —
    /// `activateApp` is the obvious one, since it caused the move itself and
    /// would otherwise spend up to `cacheTTL` reporting the app it left.
    public static func invalidate() {
        lock.lock()
        defer { lock.unlock() }
        cached = nil
    }

    // MARK: - The two mechanisms

    private static func query() -> Resolved? {
        if let viaAccessibility = viaAccessibility() { return viaAccessibility }
        return viaWindowList()
    }

    /// Ask the accessibility server which application has focus.
    ///
    /// The same live path `AXText.focusedElement()` already uses and trusts —
    /// a request to the window server rather than a cached property, which is
    /// exactly the difference that matters here.
    ///
    /// Tried first because it answers the question actually being asked
    /// ("who has keyboard focus") rather than a proxy for it, and because it
    /// agrees with the element reads that follow it.
    private static func viaAccessibility() -> Resolved? {
        guard AXIsProcessTrusted() else { return nil }
        let systemWide = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(systemWide, messagingTimeout)

        var value: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(
                systemWide, kAXFocusedApplicationAttribute as CFString, &value) == .success,
            let value, CFGetTypeID(value) == AXUIElementGetTypeID()
        else { return nil }

        var pid: pid_t = 0
        // swiftlint:disable:next force_cast
        guard AXUIElementGetPid((value as! AXUIElement), &pid) == .success, pid > 0 else {
            return nil
        }
        guard let app = describe(pid: pid) else { return nil }
        return Resolved(pid: pid, app: app, source: "ax")
    }

    /// Ask the window server which on-screen window is on top.
    ///
    /// The fallback, and it earns its place: in the measurement above the
    /// accessibility query returned nil on the very first sample and worked on
    /// every one after, so without this the first read after launch — which is
    /// frequently the first thing a user does — would come back empty.
    ///
    /// `layer == 0` is the normal window level. Anything above it is a panel,
    /// a menu, or Mull's own HUD, and answering "the frontmost app is Mull"
    /// would be both true and useless.
    private static func viaWindowList() -> Resolved? {
        guard
            let windows = CGWindowListCopyWindowInfo(
                [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]]
        else { return nil }

        for window in windows {
            guard let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
                let pid = window[kCGWindowOwnerPID as String] as? pid_t, pid > 0,
                let app = describe(pid: pid)
            else { continue }
            return Resolved(pid: pid, app: app, source: "window-list")
        }
        return nil
    }

    /// Bundle id and name for a pid.
    ///
    /// `NSRunningApplication(processIdentifier:)` is a per-pid LaunchServices
    /// lookup, not the cached workspace property — the distinction this whole
    /// file turns on. Same reason `activateApp`'s
    /// `runningApplications(withBundleIdentifier:)` was never affected.
    private static func describe(pid: pid_t) -> AppInfo? {
        guard let running = NSRunningApplication(processIdentifier: pid) else { return nil }
        return AppInfo(
            bundleId: running.bundleIdentifier ?? "",
            name: running.localizedName ?? "",
            pid: Int(pid))
    }

    /// One unresponsive app must not hang the question everything else waits on.
    private static let messagingTimeout: Float = 0.25
}
