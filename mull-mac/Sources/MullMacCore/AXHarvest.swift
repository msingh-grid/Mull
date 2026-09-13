import ApplicationServices
import Foundation

/// Reading the window, not just the caret.
///
/// `AXText` answers two narrow questions — what is the caret in, and what is
/// highlighted. Neither is enough to answer *"reply to this"*, because "this"
/// is the conversation above the composer: text nobody selected, in elements
/// nobody focused. This file reads that.
///
/// Three things make it different from `AXText.searchTree`, and each is a
/// consequence of wanting to *read* rather than to *find*:
///
///  1. **Depth-first, pre-order.** `searchTree` is breadth-first because it
///     wants the shallowest selection and wants it fast. A harvest wants
///     reading order, and reading order is the tree's own order.
///  2. **One IPC per node.** Every AX attribute read is a synchronous message
///     into another process. Read six attributes one at a time across three
///     thousand nodes and that is eighteen thousand round trips;
///     `AXUIElementCopyMultipleAttributeValues` makes it three thousand.
///  3. **A wall-clock deadline.** The other budgets bound the work; this one
///     bounds the *waiting*. An app that has stopped servicing its accessibility
///     queue will hang any walk that only counts nodes, and this runs while the
///     user is mid-sentence.
///
/// Nothing here writes, presses, or focuses anything. It is a read.
public enum AXHarvest {

    /// One readable thing on screen, in the order it appears.
    public struct Block {
        public let role: String
        public let text: String
        /// The element's own label, when the text came from its value — "To:"
        /// in front of an address field is worth as much as the address.
        public let label: String?
        /// This is where the caret is. Emitted even when the text is empty,
        /// because "the composer is here and it is empty" is the fact that
        /// makes a reply possible.
        public let focused: Bool
        /// This element reports a non-empty selection.
        public let selected: Bool

        public init(role: String, text: String, label: String?, focused: Bool, selected: Bool) {
            self.role = role
            self.text = text
            self.label = label
            self.focused = focused
            self.selected = selected
        }
    }

    public struct Harvest {
        public let blocks: [Block]
        /// True when any budget stopped the walk before the tree ran out.
        public let truncated: Bool
        /// Which one: "complete" | "nodes" | "chars" | "deadline".
        public let stoppedBy: String
        /// How long it actually took, so the host can put it in the ledger.
        public let elapsedMs: Int
    }

    /// The four bounds. Defaults chosen against a Slack window, the deepest
    /// tree we expect to meet; the deadline is the one that actually fires.
    public struct Budget {
        public var maxNodes: Int
        public var maxDepth: Int
        public var maxChars: Int
        public var deadline: TimeInterval
        /// Per-block clamp, so one enormous value cannot spend the whole
        /// character budget and hide the rest of the window.
        public var maxBlockChars: Int

        public init(
            maxNodes: Int = 3000,
            maxDepth: Int = 40,
            maxChars: Int = 12_000,
            deadline: TimeInterval = 0.35,
            maxBlockChars: Int = 2_000
        ) {
            self.maxNodes = maxNodes
            self.maxDepth = maxDepth
            self.maxChars = maxChars
            self.deadline = deadline
            self.maxBlockChars = maxBlockChars
        }
    }

    /// How long any single AX message may block before the walk gives up on it.
    /// Separate from the overall deadline: this one stops one unresponsive
    /// element from consuming the entire budget by itself.
    private static let messagingTimeout: Float = 0.25

    /// Roles that are furniture, not content.
    ///
    /// Measured rather than guessed: a first pass over a TextEdit window
    /// returned twenty blocks, eighteen of which were the formatting bar —
    /// "bold", "align centre", "rgb 1 1 1 1". Every one of those costs tokens
    /// and tells the model nothing about what the user is looking at, and a
    /// window of them would push the real text out of the character budget.
    ///
    /// A deny-list rather than an allow-list, deliberately: an unfamiliar app
    /// whose content sits on an unusual role should come through as noise, not
    /// be silently invisible. The screenshot is the backstop either way.
    ///
    /// Anything focused is exempt — the caret's own element is always worth
    /// reporting, whatever it happens to be.
    private static let chromeRoles: Set<String> = [
        "AXButton", "AXCheckBox", "AXRadioButton", "AXRadioGroup", "AXPopUpButton",
        "AXMenuButton", "AXMenu", "AXMenuItem", "AXMenuBar", "AXMenuBarItem", "AXComboBox",
        "AXColorWell", "AXSlider", "AXIncrementor", "AXStepper", "AXScrollBar", "AXSplitter",
        "AXGrowArea", "AXProgressIndicator", "AXBusyIndicator", "AXDisclosureTriangle",
        "AXToolbar", "AXTabGroup", "AXRuler", "AXRulerMarker", "AXValueIndicator", "AXHelpTag",
        // The window's own title is returned separately as `windowTitle`;
        // repeating it as the first block is pure duplication.
        "AXWindow", "AXSheet", "AXDrawer"
    ]

    /// Shorter than this and it is punctuation or a separator — the "—" between
    /// a document's title and its edited state, a bullet glyph, a divider.
    private static let minimumBlockChars = 2

    private static let attributes =
        [
            kAXRoleAttribute,
            kAXValueAttribute,
            kAXTitleAttribute,
            kAXDescriptionAttribute,
            kAXSelectedTextAttribute,
            kAXFocusedAttribute,
            kAXChildrenAttribute
        ] as CFArray

    /// Read the frontmost window of `pid` in reading order.
    ///
    /// Starts at the focused window rather than the application element, which
    /// is both cheaper and more correct: the application's children include the
    /// menu bar and every other window it owns, none of which is what the user
    /// is looking at.
    public static func harvest(
        pid: pid_t,
        budget: Budget = Budget(),
        /// How long to keep waiting for a freshly-enabled Chromium tree. Set on
        /// the first call and carried through the retries, so the wait is
        /// bounded in total rather than per attempt. Nil on the first call.
        treeDeadline: CFAbsoluteTime? = nil
    ) -> Harvest {
        let startedAt = CFAbsoluteTimeGetCurrent()
        // Carried, not recomputed: `enableManualAccessibility` only answers
        // "yes" once per app, so asking it again inside the retry would say no
        // and end the wait after a single poll. That bug made the whole thing
        // look like it did not work.
        let warming = treeDeadline != nil || enableManualAccessibility(pid: pid)
        let treeDeadline = treeDeadline ?? (startedAt + manualAccessibilityWait)
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, messagingTimeout)

        guard let root = window(of: app) else {
            return Harvest(
                blocks: [], truncated: false, stoppedBy: "no-window",
                elapsedMs: elapsed(since: startedAt))
        }

        var blocks: [Block] = []
        var chars = 0
        var visited = 0
        var stoppedBy = "complete"
        // Explicit stack rather than recursion: the depth bound is a number
        // here, not a hope about the call stack.
        var stack: [(element: AXUIElement, depth: Int)] = [(root, 0)]
        let deadline = startedAt + budget.deadline

        while let (element, depth) = stack.popLast() {
            if visited >= budget.maxNodes {
                stoppedBy = "nodes"
                break
            }
            if chars >= budget.maxChars {
                stoppedBy = "chars"
                break
            }
            if CFAbsoluteTimeGetCurrent() > deadline {
                stoppedBy = "deadline"
                break
            }
            visited += 1

            let node = read(element)

            if let block = block(from: node, budget: budget, previous: blocks.last) {
                chars += block.text.count
                blocks.append(block)
            }

            guard depth < budget.maxDepth else { continue }
            // Reversed, because popLast() is the cheap end of the array and
            // reading order is first-child-first.
            for child in node.children.reversed() {
                stack.append((child, depth + 1))
            }
        }

        // Chromium populates its tree asynchronously after the switch above is
        // thrown, and takes its time about it — Slack measured well past a
        // quarter of a second on a cold tree. So the first harvest of an
        // Electron app waits and looks again, up to a budget.
        //
        // Only ever on the run that actually enabled it, which is once per app
        // per sidecar launch, and only while the tree is still empty. Every
        // harvest after that is the 30ms one. It is paid during the hold, with
        // the user still speaking, which is the one moment there is time to
        // spend.
        if warming && blocks.count <= 1 {
            if CFAbsoluteTimeGetCurrent() < treeDeadline {
                Thread.sleep(forTimeInterval: manualAccessibilityPoll)
                return harvest(pid: pid, budget: budget, treeDeadline: treeDeadline)
            }
            // Out of patience, not out of tree. Said out loud rather than
            // returned as an ordinary empty result, because the two mean very
            // different things to the host: "this window has nothing in it" and
            // "ask me again in a moment" deserve different answers.
            return Harvest(
                blocks: blocks, truncated: true, stoppedBy: "tree-warming",
                elapsedMs: elapsed(since: startedAt))
        }

        return Harvest(
            blocks: blocks,
            truncated: stoppedBy != "complete",
            stoppedBy: stoppedBy,
            elapsedMs: elapsed(since: startedAt))
    }

    /// Apps whose accessibility tree has already been switched on this launch.
    private static var manualAccessibility: Set<pid_t> = []
    /// How long to block waiting for a Chromium tree that was just switched on.
    ///
    /// Short, and deliberately shorter than the tree usually takes. The
    /// dispatcher is serial — one stdin thread — so every millisecond spent
    /// sleeping here is a millisecond `focusedElement` and `selectedText` spend
    /// queued behind it, and those two decide what an edit can even act on.
    ///
    /// The host does the patient half: it sees `stoppedBy == "tree-warming"`
    /// and asks again a moment later, which leaves the queue free in between.
    /// Measured on a cold Claude Desktop, the tree took ~2s to appear; on a
    /// cold Slack, under one.
    private static let manualAccessibilityWait: TimeInterval = 0.6
    private static let manualAccessibilityPoll: TimeInterval = 0.15

    /// Ask Chromium to build an accessibility tree, and say whether we just did.
    ///
    /// This is the whole reason Mull could see nothing in Slack. Chromium — and
    /// therefore every Electron app: Slack, Discord, VS Code, Notion, Teams —
    /// does not maintain an accessibility tree at all unless an assistive
    /// client asks for one. Until then the app element has a window with a
    /// title and essentially nothing inside it, which is exactly what the
    /// harvest reported: one block, forty characters, two milliseconds.
    ///
    /// `AXManualAccessibility` is Chromium's own opt-in for this, and it is the
    /// right one to use rather than the older `AXEnhancedUserInterface`: that
    /// one is the global VoiceOver switch, and some apps change their layout and
    /// window animations when they see it. This one only turns the tree on.
    ///
    /// Set once per process and remembered, because it is not free for the
    /// target app — Chromium keeps the tree live afterwards, which costs it
    /// memory and a little CPU on every DOM change. Doing it once, when the user
    /// first asks Mull to read that app, is a fair trade; doing it on every
    /// keystroke would not be.
    ///
    /// Returns false for apps that are not Chromium: they have no such
    /// attribute, the write fails harmlessly, and nothing is remembered.
    @discardableResult
    private static func enableManualAccessibility(pid: pid_t) -> Bool {
        if manualAccessibility.contains(pid) { return false }
        let app = AXUIElementCreateApplication(pid)
        let result = AXUIElementSetAttributeValue(
            app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        guard result == .success else { return false }
        manualAccessibility.insert(pid)
        return true
    }

    // MARK: - One node

    private struct Node {
        var role: String
        var value: String?
        var title: String?
        var help: String?
        var selectedText: String?
        var focused: Bool
        var children: [AXUIElement]
    }

    /// Every attribute this walk needs, in one message to the target process.
    private static func read(_ element: AXUIElement) -> Node {
        var raw: CFArray?
        let status = AXUIElementCopyMultipleAttributeValues(
            element, attributes, AXCopyMultipleAttributeOptions(rawValue: 0), &raw)
        guard status == .success, let values = raw as? [CFTypeRef] , values.count >= 7 else {
            return Node(
                role: "", value: nil, title: nil, help: nil, selectedText: nil, focused: false,
                children: [])
        }
        return Node(
            role: string(values[0]) ?? "",
            value: string(values[1]),
            title: string(values[2]),
            help: string(values[3]),
            selectedText: string(values[4]),
            focused: bool(values[5]) ?? false,
            children: elements(values[6]))
    }

    /// What, if anything, this node contributes to the transcript.
    ///
    /// Skipping is the common case and the important one — a Chromium tree is
    /// mostly structural nodes with no text of their own, and an AXGroup that
    /// merely repeats its child's string is noise that costs real tokens.
    private static func block(from node: Node, budget: Budget, previous: Block?) -> Block? {
        let selected = !(node.selectedText ?? "").trimmed.isEmpty

        // Value first: it is what the element *contains*. Title and description
        // are what it is *called*, which only matters when there is no content
        // — a button, a heading, an image.
        var text = node.value ?? ""
        var label = node.title
        if text.trimmed.isEmpty {
            text = node.title ?? node.help ?? ""
            label = nil
        }
        text = clamp(text, to: budget.maxBlockChars)

        // Focus and a selection both outrank every filter below: wherever the
        // caret is gets reported whatever it is, and an empty composer is not
        // nothing — it is the place a reply goes.
        if node.focused || selected {
            return Block(
                role: node.role, text: text, label: text.trimmed.isEmpty ? node.title : label,
                focused: node.focused, selected: selected)
        }

        if chromeRoles.contains(node.role) { return nil }
        if text.trimmed.count < minimumBlockChars { return nil }

        // Parents restate their children, and Chromium's do it thoroughly.
        //
        // Slack composes one `AXGroup` per message whose label is the whole
        // thing — "Mohit Singh: You reached Poland? 7:17 PM." — and then hangs
        // the same words off it again as separate `AXStaticText` children: the
        // timestamp, the body, each link. Pre-order means the summary arrives
        // first, so every fragment that follows can be checked against it.
        //
        // Containment rather than equality, because the fragments are pieces of
        // the summary rather than copies of it. This roughly halves the
        // transcript, and the half it keeps is the better one — the summary is
        // the only place the *speaker's name* appears.
        if let previous, previous.text.contains(text.trimmed) { return nil }

        return Block(
            role: node.role, text: text, label: label, focused: node.focused, selected: selected)
    }

    // MARK: - Finding the window

    private static func window(of app: AXUIElement) -> AXUIElement? {
        for attribute in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(app, attribute as CFString, &value) == .success,
                let value, CFGetTypeID(value) == AXUIElementGetTypeID()
            {
                // swiftlint:disable:next force_cast
                return (value as! AXUIElement)
            }
        }
        // Some apps answer neither. Their first window beats nothing, and the
        // application element itself would drag in the menu bar.
        var value: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
            let windows = value as? [AXUIElement]
        else { return nil }
        return windows.first
    }

    // MARK: - CFTypeRef unwrapping
    //
    // `AXUIElementCopyMultipleAttributeValues` with no options returns a slot
    // for every attribute asked for, and fills the ones that failed with an
    // AXValue wrapping an error rather than failing the whole call. So every
    // slot is checked by type, and a wrong type is simply absent.

    private static func string(_ value: CFTypeRef) -> String? {
        guard CFGetTypeID(value) == CFStringGetTypeID() else { return nil }
        return value as? String
    }

    private static func bool(_ value: CFTypeRef) -> Bool? {
        guard CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
        return value as? Bool
    }

    private static func elements(_ value: CFTypeRef) -> [AXUIElement] {
        guard CFGetTypeID(value) == CFArrayGetTypeID(), let array = value as? [AXUIElement]
        else { return [] }
        return array
    }

    private static func clamp(_ text: String, to limit: Int) -> String {
        guard text.count > limit else { return text }
        return String(text.prefix(limit)) + "…"
    }

    private static func elapsed(since start: CFAbsoluteTime) -> Int {
        Int(((CFAbsoluteTimeGetCurrent() - start) * 1000).rounded())
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
