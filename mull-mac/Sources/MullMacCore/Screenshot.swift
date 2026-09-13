import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// One picture of the window the user is looking at.
///
/// The Accessibility harvest reads text. This reads everything else: a chart, a
/// canvas, a PDF, a screenshot someone pasted into a thread, the layout that
/// tells you which message is a reply to which. They are complementary, and
/// Mull takes both — the harvest is exact about names and wording where a
/// vision model reads them off rendered glyphs, and the image sees what has no
/// accessibility representation at all.
///
/// Two decisions worth stating, because both are about not capturing more than
/// was asked for:
///
///  - **One window, not the screen.** `SCContentFilter(desktopIndependentWindow:)`
///    renders exactly one window's contents. Everything else the user has open
///    stays out of the frame — and so, incidentally, does Mull's own HUD, which
///    is floating on top of the very thing being captured.
///  - **A file, not a payload.** A JPEG is a couple of hundred kilobytes; base64
///    in an ndjson line it is a third bigger again, on a channel where every
///    message is one line and the log tails it. The verb returns a path. The
///    host reads it, sends it, and deletes it.
public enum Screenshot {

    public struct Capture {
        public let path: String
        public let width: Int
        public let height: Int
        public let bytes: Int
        public let elapsedMs: Int
    }

    public enum Failure: String, Error {
        case noPermission = "no-screen-recording"
        case noWindow = "no-window"
        case timedOut = "capture-timed-out"
        case captureFailed = "capture-failed"
        case encodeFailed = "encode-failed"
    }

    /// Has Screen Recording been granted? Never prompts.
    public static func permitted() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    /// Ask for Screen Recording. Shows the system prompt once per install; the
    /// grant does not take effect until the app is relaunched, which is why
    /// nothing here treats `true` as "we can capture now".
    @discardableResult
    public static func requestAccess() -> Bool {
        CGRequestScreenCaptureAccess()
    }

    /// Capture the frontmost window of `pid`, downscaled, as a JPEG on disk.
    ///
    /// `expectedTitle` comes from the AX focused-window read that has already
    /// happened. It is a tie-breaker, not a requirement: apps with several
    /// windows open are exactly where "the biggest one" guesses wrong.
    public static func frontWindow(
        pid: pid_t,
        expectedTitle: String?,
        maxEdge: Int = 1400,
        quality: Double = 0.6,
        timeout: TimeInterval = 2.0
    ) -> Result<Capture, Failure> {
        let startedAt = CFAbsoluteTimeGetCurrent()
        guard permitted() else { return .failure(.noPermission) }

        var image: CGImage?
        var failure: Failure?
        let done = DispatchSemaphore(value: 0)

        // ScreenCaptureKit is async; this handler runs on the sidecar's stdin
        // thread while the main thread is parked in CFRunLoopRun(), so blocking
        // here cannot deadlock the process — the Task runs on the cooperative
        // pool, which is neither of those threads.
        Task {
            defer { done.signal() }
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(
                    true, onScreenWindowsOnly: true)
                guard let window = pick(from: content.windows, pid: pid, title: expectedTitle)
                else {
                    failure = .noWindow
                    return
                }
                let filter = SCContentFilter(desktopIndependentWindow: window)
                let configuration = SCStreamConfiguration()
                let size = scaled(window.frame, maxEdge: maxEdge)
                configuration.width = size.width
                configuration.height = size.height
                configuration.showsCursor = false
                configuration.captureResolution = .best
                image = try await SCScreenshotManager.captureImage(
                    contentFilter: filter, configuration: configuration)
            } catch {
                failure = .captureFailed
            }
        }

        guard done.wait(timeout: .now() + timeout) == .success else { return .failure(.timedOut) }
        if let failure { return .failure(failure) }
        guard let image else { return .failure(.captureFailed) }

        guard let written = write(image, quality: quality) else { return .failure(.encodeFailed) }
        return .success(
            Capture(
                path: written.path,
                width: image.width,
                height: image.height,
                bytes: written.bytes,
                elapsedMs: Int(((CFAbsoluteTimeGetCurrent() - startedAt) * 1000).rounded())))
    }

    // MARK: - Choosing the window

    private static func pick(from windows: [SCWindow], pid: pid_t, title: String?) -> SCWindow? {
        let mine = windows.filter { window in
            window.owningApplication?.processID == pid
                && window.isOnScreen
                // Layer 0 is a normal window. Panels, tooltips and menus float
                // above it, and one of them being frontmost is not a reason to
                // photograph it instead of the document.
                && window.windowLayer == 0
                && window.frame.width > 120 && window.frame.height > 120
        }
        if let title, !title.isEmpty, let match = mine.first(where: { $0.title == title }) {
            return match
        }
        return mine.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
    }

    /// Target pixel size: retina detail, capped on the long edge.
    ///
    /// `frame` is in points, so a 1200pt window is 2400px of real glyphs. Ask
    /// for those and then cap, rather than asking for points and getting text
    /// too soft to read.
    private static func scaled(_ frame: CGRect, maxEdge: Int) -> (width: Int, height: Int) {
        let pixels = CGSize(width: frame.width * 2, height: frame.height * 2)
        let longest = max(pixels.width, pixels.height)
        let factor = longest > CGFloat(maxEdge) ? CGFloat(maxEdge) / longest : 1
        return (
            width: max(1, Int((pixels.width * factor).rounded())),
            height: max(1, Int((pixels.height * factor).rounded()))
        )
    }

    // MARK: - Writing it out

    private static func write(_ image: CGImage, quality: Double) -> (path: String, bytes: Int)? {
        let path = (NSTemporaryDirectory() as NSString)
            .appendingPathComponent("mull-shot-\(UUID().uuidString).jpg")
        let url = URL(fileURLWithPath: path)
        guard
            let destination = CGImageDestinationCreateWithURL(
                url as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(
            destination, image,
            [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        let bytes =
            (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0
        return (path, bytes)
    }
}
