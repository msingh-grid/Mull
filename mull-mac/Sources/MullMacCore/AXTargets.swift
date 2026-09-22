import AppKit
import ApplicationServices
import Foundation

/// The things in this window that can be pressed, numbered.
///
/// `AXHarvest` answers *what does this window say*. This answers *what can be
/// done to it*, and the two are close to complements: the harvest's
/// `chromeRoles` deny-list drops `AXButton`, `AXMenuItem`, `AXPopUpButton`,
/// `AXCheckBox`, `AXRadioButton`, `AXComboBox` and `AXTabGroup` — which is
/// right when the job is reading a conversation, and removes every single thing
/// you would press.
///
/// So this is a second walk over the same tree with the filter inverted. It
/// shares the traversal shape, the budgets, the messaging timeout and the
/// `AXManualAccessibility` warm-up, because a cold Chromium window is just as
/// invisible here as it was there.
///
/// ### Why the model is shown integers rather than names
///
/// An earlier design had the model *name* a target — "press the Send button" —
/// and Mull go looking for it. That was rejected, correctly: two buttons are
/// called Send, "Priya Sharma" sits next to "Priya (you)", and a label lookup
/// is a guess dressed as a lookup.
///
/// Enumerating first dissolves that. Mull walks the tree, numbers what it
/// found, and shows the model the list; the model answers with an index. Two
/// buttons named Send are two different integers. "Exact match or refuse" stops
/// being an aspiration and becomes a comparison of numbers.
///
/// Which is also why the `AXUIElement` references are **kept** (see `Store`
/// below) rather than rediscovered at press time. The handle Mull presses is
/// the handle Mull saw.
///
/// ### What this file does not do
///
/// It does not press anything — that is `press(...)`, deliberately below a
/// separate entry point with its own verification — and it never synthesises a
/// mouse click. An element that does not advertise `AXPress` is simply not a
/// target, and the caller says so out loud rather than clicking at its
/// coordinates: a synthetic click moves the user's pointer, lands on whatever
/// has scrolled under it, and cannot be verified afterwards.
public enum AXTargets {

    /// What can be done with a target. Two kinds, and they are not
    /// interchangeable — see the `type` guard in the executor.
    public enum Kind: String {
        /// Advertises `AXPress`. A button, a row, a link, a tab.
        case press
        /// A text or search field. The only thing the navigator may type into,
        /// and never a message composer.
        case type
    }

    public struct Target {
        /// Position in the list handed to the model. Stable only within one
        /// harvest, which is what `harvestId` is for.
        public let index: Int
        public let role: String
        public let subrole: String?
        /// The best name this element has. Never empty — an unnamed control is
        /// dropped, because a model cannot choose it and a user cannot check it.
        public let title: String
        public let help: String?
        public let value: String?
        /// Screen rectangle, so the model can tell the sidebar "Priya" from the
        /// search-result "Priya" by looking at the screenshot beside this list.
        public let frame: CGRect?
        public let actions: [String]
        public let enabled: Bool
        public let focused: Bool
        public let kind: Kind
    }

    public struct Scan {
        public let harvestId: String
        public let targets: [Target]
        public let truncated: Bool
        /// "complete" | "nodes" | "deadline" | "targets" | "no-window"
        /// | "no-accessibility" | "tree-warming" | "browser-cold"
        public let stoppedBy: String
        public let elapsedMs: Int

        // MARK: What the tree looked like
        //
        // Diagnostics, not data. `stoppedBy` says which rule ended the walk;
        // these say what the walk was walking through, and that is the half
        // that was missing when a browser kept answering with its toolbar.
        //
        // The failure this exists for reports `stoppedBy: "complete"` and
        // eighteen targets, which is indistinguishable from a small window that
        // genuinely has eighteen buttons in it. It stops being ambiguous the
        // moment the node counts are attached: 190 nodes and no page is a
        // browser that is not showing us the page, 3836 nodes with 2999 of
        // them from the page is a browser that is.

        /// Elements visited. Against `Budget.maxNodes`, so a walk that stopped
        /// early can be told from one that ran out of tree.
        public let nodes: Int
        /// How many of those carried an `AXDOMIdentifier`.
        ///
        /// **Not a page detector, though it was built as one.** Chrome's own
        /// toolbar and tab strip are WebUI, so they carry DOM identifiers too:
        /// a Chrome window showing nothing but its own furniture measures 119
        /// nodes of which 112 are "web". Kept because the ratio is still worth
        /// seeing, and because the number is what proved the detector wrong.
        public let webNodes: Int
        /// Web *documents* in this window — nodes whose role is `AXWebArea`.
        ///
        /// This is the honest test `webNodes` was standing in for. A browser
        /// rendering a page has at least one; a browser whose renderer
        /// accessibility is off has none, however much WebUI furniture it
        /// publishes. Zero here, in a Chromium app, means the page is not
        /// visible to us at all.
        public let webAreas: Int
        /// Targets dropped as the same control seen twice. Chrome publishes its
        /// toolbar under two sibling groups, so in a browser this is normally
        /// large, and its being zero is itself a signal.
        public let duplicates: Int
        /// Subtrees abandoned at `maxDepth`. Non-zero means this scan did not
        /// see the whole window, whatever `stoppedBy` says.
        public let clipped: Int
        /// The deepest level the walk reached. Against `maxDepth`, it says
        /// whether the bound was brushed or leaned on.
        public let deepest: Int
        /// Does this app keep its page behind a renderer at all? A missing web
        /// document means nothing in Finder and everything in Chrome.
        public let chromium: Bool
        /// What this app said when asked to build a tree: "enabled" or
        /// "unsupported". A browser that answers "unsupported" is one Mull has
        /// no lever on — see `AXHarvest.ManualAccessibility`.
        public let wake: String

        public init(
            harvestId: String,
            targets: [Target],
            truncated: Bool,
            stoppedBy: String,
            elapsedMs: Int,
            nodes: Int = 0,
            webNodes: Int = 0,
            webAreas: Int = 0,
            duplicates: Int = 0,
            clipped: Int = 0,
            deepest: Int = 0,
            chromium: Bool = false,
            wake: String = "unknown"
        ) {
            self.harvestId = harvestId
            self.targets = targets
            self.truncated = truncated
            self.stoppedBy = stoppedBy
            self.elapsedMs = elapsedMs
            self.nodes = nodes
            self.webNodes = webNodes
            self.webAreas = webAreas
            self.duplicates = duplicates
            self.clipped = clipped
            self.deepest = deepest
            self.chromium = chromium
            self.wake = wake
        }
    }

    public struct Budget {
        public var maxNodes: Int
        public var maxDepth: Int
        public var maxTargets: Int
        public var deadline: TimeInterval

        /// Roomier than the reading harvest's 0.35s, and it buys a second IPC
        /// per node (see `actionNames`). Affordable because this runs between
        /// plan steps with a card already on screen, not during a hold with the
        /// user mid-sentence.
        ///
        /// ### Why these numbers grew
        ///
        /// The originals were measured against native apps, where Finder and
        /// Notes return eleven targets and finish in 36–64ms. A browser is a
        /// different order of thing. Measured against a live Chrome showing
        /// Gmail, with its accessibility tree awake:
        ///
        ///     3836 nodes visited · 627 raw targets · ~550ms
        ///
        /// Every single bound was hit — `maxNodes` at 3000, `maxTargets` at
        /// 120, `deadline` at 0.8s — and the walk stopped inside Chrome's own
        /// toolbar, having never reached the page. The page is the only part a
        /// user means when they say "click the Archive button".
        ///
        /// The deduplication below is what makes the larger numbers affordable:
        /// those 627 targets are 254 distinct ones, so the list the model pays
        /// tokens for grew by a third, not by five times.
        public init(
            maxNodes: Int = 5000,
            maxDepth: Int = AXHarvest.defaultMaxDepth,
            maxTargets: Int = 300,
            deadline: TimeInterval = 1.5
        ) {
            self.maxNodes = maxNodes
            self.maxDepth = maxDepth
            self.maxTargets = maxTargets
            self.deadline = deadline
        }
    }

    // MARK: - The walk

    /// Roles that can hold typed text.
    ///
    /// Separated from the press targets because the two want different guards:
    /// a press is one event in a place the user can see, and a typed string has
    /// to land in something that actually takes text.
    ///
    /// ### Why `AXTextArea` is on this list now
    ///
    /// It was deliberately left off, on the reasoning that a message composer is
    /// a text area while a search box is a text field — so excluding the role
    /// meant the navigator could not focus a composer even before anything
    /// checked what the thing was called.
    ///
    /// That guard was aimed at the wrong act. What makes a composer dangerous is
    /// **sending**, not typing: text that appears in a box is visible, is
    /// reversible, and does nothing until something presses Return. And the
    /// closure that makes Return unreachable is elsewhere and unchanged —
    /// `ClassifiedIntent` has no `send`, `NavStepSchema` carries no keystroke,
    /// `navKey` is a separate enum from `keyChord` with no Return in it, and
    /// `AGENT_TOOLS` has no key verb. Four layers, none of which depends on
    /// guessing which box is a composer.
    ///
    /// Meanwhile the cost of the exclusion was the whole feature: an event
    /// title, a description, a comment, a guest list and every multi-line field
    /// in every app are text areas, so "fill this in" was unreachable in
    /// general in order to avoid one specific field it could not reliably
    /// identify anyway.
    private static let textRoles: Set<String> = [
        "AXTextField", "AXSearchField", "AXComboBox", "AXTextArea"
    ]

    /// Roles that are never worth offering even when they advertise `AXPress`.
    ///
    /// `AXStaticText` and `AXImage` in a Chromium tree frequently claim to be
    /// pressable because some ancestor attached a click handler; offering three
    /// hundred of them buries the six controls that matter. `AXWindow` and
    /// `AXApplication` press as a no-op.
    private static let neverTargets: Set<String> = [
        "AXStaticText", "AXImage", "AXWindow", "AXApplication", "AXScrollArea",
        "AXSplitGroup", "AXUnknown"
    ]

    /// Roles that mean "the things below me are choices, not prose".
    ///
    /// Google Calendar's start time is the case this exists for. Pressing it
    /// opens a listbox of 96 times; every one of them is an `AXStaticText`, so
    /// `neverTargets` dropped all 96 and the scan offered the empty `AXList` and
    /// nothing inside it. Measured, not guessed: 97 time strings in the window
    /// text, 96 of them `AXStaticText`, **0** offered as targets.
    ///
    /// The container is the whole test, and it has to be, because
    /// `neverTargets`' own docstring is right about why: a Chromium tree is full
    /// of `AXStaticText` that claims `AXPress` because an ancestor somewhere
    /// attached a click handler, and offering all of it buries the six controls
    /// that matter. Inside a list or a menu that same claim means something
    /// different — there, a pressable line of text *is* an option.
    /// `AXScrollToVisible`, spelled out.
    ///
    /// `kAXPressAction` and friends are bridged into Swift; this one is not — it
    /// is declared in `NSAccessibility` rather than in the C API, and the
    /// literal is the whole of what the bridged constant would have been.
    private static let scrollAction = "AXScrollToVisible"

    private static let choiceContainers: Set<String> = ["AXList", "AXMenu", "AXComboBox"]

    /// Roles that become targets when they are inside one of the above.
    private static let optionRoles: Set<String> = ["AXStaticText"]

    /// How many options one scan may offer.
    ///
    /// A dropdown's worth, and not a chat log's — a separate cap from the
    /// 300-target budget because the feared case is one open list crowding out
    /// every real control, which the shared budget cannot distinguish from an
    /// app that genuinely has 300 buttons.
    ///
    /// **A hundred, because the feared case did not happen.** The number started
    /// at forty on the reasoning that a message list is plausibly an `AXList`
    /// full of pressable `AXStaticText`; measuring said otherwise — Slack, the
    /// likeliest victim, reports exactly the 288 targets it reported before this
    /// rule existed, and so do VS Code, Notes and Finder. The container test is
    /// doing the work the cap was insurance against.
    ///
    /// Forty had a real cost, too: Calendar's time list truncated at 9:45am, so
    /// the one case this was built for could not reach 3pm and could not tell
    /// that it had been cut off. A hundred covers a 24-hour list at quarter-hour
    /// granularity, which is about as long as an honest chooser gets, and still
    /// leaves two thirds of the budget for controls.
    private static let maxOptions = 100

    private static let attributes =
        [
            kAXRoleAttribute,
            kAXSubroleAttribute,
            kAXTitleAttribute,
            kAXDescriptionAttribute,
            kAXValueAttribute,
            kAXEnabledAttribute,
            kAXFocusedAttribute,
            kAXPositionAttribute,
            kAXSizeAttribute,
            kAXChildrenAttribute
        ] as CFArray

    /// Walk the frontmost window of `pid` and number everything actionable.
    ///
    /// `treeDeadline` carries the Chromium warm-up across retries exactly as
    /// `AXHarvest.harvest` does, so the wait is bounded in total rather than
    /// per attempt.
    public static func scan(
        pid: pid_t,
        budget: Budget = Budget(),
        treeDeadline: CFAbsoluteTime? = nil
    ) -> Scan {
        let startedAt = CFAbsoluteTimeGetCurrent()
        // The same anchor the reading walk uses, and that is the point: a `look`
        // reads the window and then scans it, and before this the read consumed
        // the one-shot "I just switched it on" signal and the scan was told the
        // tree was settled. See `AXHarvest.warmUpDeadline`.
        let wake = AXHarvest.manualAccessibility(pid: pid)
        let treeDeadline = treeDeadline ?? AXHarvest.warmUpDeadline(wake)
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, AXHarvest.messagingTimeout)
        // Resolved once, up front, rather than at the single point it used to
        // be asked. Every result carries it now, including the ones that return
        // before the walk: "no window, and it was a browser" is a different
        // sentence from "no window", and the log only gets to say it if the
        // early returns know too.
        let chromium = isChromiumBrowser(pid: pid)

        guard let root = AXHarvest.window(of: app) else {
            return Scan(
                harvestId: "", targets: [], truncated: false, stoppedBy: "no-window",
                elapsedMs: AXHarvest.elapsed(since: startedAt), chromium: chromium,
                wake: wake.name)
        }

        var targets: [Target] = []
        var elements: [AXUIElement] = []
        var visited = 0
        var stoppedBy = "complete"
        var stack: [(element: AXUIElement, depth: Int, inChoices: Bool)] = [(root, 0, false)]
        /// How many list options have been offered. See `maxOptions`.
        var choicesTaken = 0
        let deadline = startedAt + budget.deadline
        /// Identities already offered. See `identity(of:)`.
        var seen = Set<String>()
        var duplicates = 0
        /// Did anything in this window belong to a web page? Browsers answer no
        /// when their renderer accessibility is asleep, and that is worth
        /// saying out loud rather than returning a toolbar and calling it a
        /// window. See `webContent` and the `browser-cold` result below.
        var webNodes = 0
        /// Web documents seen. See `Scan.webAreas` — this, not `webNodes`, is
        /// what "is the page here" actually asks.
        var webAreas = 0
        /// Subtrees abandoned at `maxDepth`, and how far down the walk got. See
        /// the depth guard below for why these are worth a counter each.
        var clipped = 0
        var deepest = 0

        while let (element, depth, inChoices) = stack.popLast() {
            if visited >= budget.maxNodes {
                stoppedBy = "nodes"
                break
            }
            if targets.count >= budget.maxTargets {
                stoppedBy = "targets"
                break
            }
            if CFAbsoluteTimeGetCurrent() > deadline {
                stoppedBy = "deadline"
                break
            }
            visited += 1

            let node = read(element)
            if webContent(element) { webNodes += 1 }
            if node.role == webAreaRole { webAreas += 1 }
            if let target = target(
                from: node, index: targets.count, element: element, inChoices: inChoices,
                choicesTaken: choicesTaken)
            {
                if optionRoles.contains(node.role) { choicesTaken += 1 }
                // Deduplicated *before* the cap, so `maxTargets` counts things
                // the user could distinguish rather than times we saw the same
                // button. Chrome publishes its toolbar and tab strip under two
                // sibling groups, so more than half of what it offers is the
                // same control twice — 627 raw, 254 distinct. Capping first
                // would have spent the whole budget on the duplicate half.
                if seen.insert(identity(of: target)).inserted {
                    targets.append(target)
                    elements.append(element)
                } else {
                    duplicates += 1
                }
            }

            // The depth bound, and the one budget that used to leave no trace.
            //
            // The other three announce themselves in `stoppedBy`; this one
            // dropped the subtree and let the walk report "complete", which is
            // how a browser window came to answer that it had finished reading
            // a page it had never entered. A modern web app is a long chain of
            // nested wrappers before the first thing a person would recognise,
            // so this is the bound a page hits, and it hit it silently.
            guard depth < budget.maxDepth else {
                clipped += 1
                continue
            }
            deepest = max(deepest, depth)
            // Once inside a list of choices, everything below it is too. See
            // `choiceContainers`.
            let below = inChoices || choiceContainers.contains(node.role)
            for child in node.children.reversed() {
                stack.append((child, depth + 1, below))
            }
        }

        // The same cold-Chromium wait as the reading harvest. A Slack window
        // that has never been read has no tree at all, and an empty target list
        // from one of those means "ask again", not "nothing here is clickable".
        if let treeDeadline, targets.isEmpty {
            if CFAbsoluteTimeGetCurrent() < treeDeadline {
                Thread.sleep(forTimeInterval: AXHarvest.manualAccessibilityPoll)
                return scan(pid: pid, budget: budget, treeDeadline: treeDeadline)
            }
            return Scan(
                harvestId: "", targets: [], truncated: true, stoppedBy: "tree-warming",
                elapsedMs: AXHarvest.elapsed(since: startedAt), nodes: visited,
                webNodes: webNodes, webAreas: webAreas, duplicates: duplicates,
                clipped: clipped, deepest: deepest, chromium: chromium, wake: wake.name)
        }

        // A browser whose renderer accessibility is asleep. It answers every
        // query politely and returns its own furniture — Back, Reload, the tab
        // strip — with not one element of the page in it. Reported rather than
        // returned as an ordinary result, because "this page has no buttons"
        // and "this browser is not showing me the page" look identical from
        // here and mean completely different things to the person asking.
        //
        // ### The test is web *documents*, not web nodes
        //
        // This used to ask `webNodes == 0`, meaning "did anything here carry an
        // `AXDOMIdentifier`", and the answer in Chrome is always yes — because
        // Chrome's own toolbar and tab strip are WebUI and carry them too. A
        // Chrome window showing none of Google Calendar measures 119 nodes of
        // which **112 are "web"**, so the guard never once fired and every cold
        // browser was reported as an ordinary complete scan of eighteen
        // buttons. The agent believed it, hunted for a Create button among the
        // tab strip, decided it had navigated wrong, re-opened the URL, and
        // went round again: twelve turns and thirty-eight seconds to do nothing.
        //
        // `AXWebArea` is the honest test. It is the root of a rendered
        // document: one per page when the renderer is awake, none at all when
        // it is not, however much furniture the browser publishes.
        if webAreas == 0, chromium {
            return Scan(
                harvestId: Store.shared.keep(elements: elements, pid: pid),
                targets: targets, truncated: true, stoppedBy: "browser-cold",
                elapsedMs: AXHarvest.elapsed(since: startedAt), nodes: visited,
                webNodes: webNodes, webAreas: webAreas, duplicates: duplicates,
                clipped: clipped, deepest: deepest, chromium: chromium, wake: wake.name)
        }

        let harvestId = Store.shared.keep(elements: elements, pid: pid)
        return Scan(
            harvestId: harvestId,
            targets: targets,
            truncated: stoppedBy != "complete",
            stoppedBy: stoppedBy,
            elapsedMs: AXHarvest.elapsed(since: startedAt),
            nodes: visited,
            webNodes: webNodes,
            webAreas: webAreas,
            duplicates: duplicates,
            clipped: clipped,
            deepest: deepest,
            chromium: chromium,
            wake: wake.name)
    }

    // MARK: - One node

    private struct Node {
        var role: String
        var subrole: String?
        var title: String?
        var help: String?
        var value: String?
        var enabled: Bool
        var focused: Bool
        var frame: CGRect?
        var actions: [String]
        var children: [AXUIElement]
    }

    /// Ten attributes in one message, then the action list in a second.
    ///
    /// The action list cannot join the batch —
    /// `AXUIElementCopyMultipleAttributeValues` reads attributes and actions
    /// are not attributes — so it is a second round trip per node, and it is
    /// what makes this walk roughly twice the cost of the reading one.
    ///
    /// It is asked for anyway, on every node rather than on a guessed list of
    /// roles, because *"does this element advertise AXPress"* is the actual
    /// question and a role allow-list would be one more hand-written table that
    /// works in the apps someone tested. Slack's sidebar rows and Finder's
    /// toolbar items do not agree about what role a clickable thing has; they
    /// do agree about `AXPress`.
    private static func read(_ element: AXUIElement) -> Node {
        var raw: CFArray?
        let status = AXUIElementCopyMultipleAttributeValues(
            element, attributes, AXCopyMultipleAttributeOptions(rawValue: 0), &raw)
        guard status == .success, let values = raw as? [CFTypeRef], values.count >= 10 else {
            return Node(
                role: "", subrole: nil, title: nil, help: nil, value: nil, enabled: false,
                focused: false, frame: nil, actions: [], children: [])
        }
        let role = AXHarvest.string(values[0]) ?? ""
        return Node(
            role: role,
            subrole: AXHarvest.string(values[1]),
            title: AXHarvest.string(values[2]),
            help: AXHarvest.string(values[3]),
            value: AXHarvest.string(values[4]),
            enabled: AXHarvest.bool(values[5]) ?? true,
            focused: AXHarvest.bool(values[6]) ?? false,
            frame: rect(position: values[7], size: values[8]),
            actions: role.isEmpty ? [] : actionNames(element),
            children: AXHarvest.elements(values[9]))
    }

    /// Is this node worth offering, and as what?
    ///
    /// Three ways to be dropped, and the third is the one that keeps the list
    /// short enough to read:
    ///
    ///   1. a role that is never a target (`neverTargets`)
    ///   2. neither pressable nor typeable
    ///   3. **no name at all** — an unlabelled button cannot be chosen by a
    ///      model and cannot be checked by the user reading the card, so
    ///      offering it is offering a coin flip. Chromium emits a great many of
    ///      these for layout elements that happen to carry a click handler.
    /// The best name an element has — in **one** place, because two would drift.
    ///
    /// Title, then description, then — for a list option only — its value.
    ///
    /// ### Why the third fallback exists
    ///
    /// It is what actually made `optionRoles` work, and it cost an hour to find.
    /// A pressable `AXStaticText` inside Calendar's time list has an empty
    /// `AXTitle` and keeps its text in `AXValue`, because that is where static
    /// text keeps text. So all 96 options passed the container test, passed the
    /// `AXPress` test, and were then dropped by the unnamed-control rule — two
    /// conditions further down than the one being debugged.
    ///
    /// ### Why it is one function and not two copies
    ///
    /// Because the first version *was* two copies, and the second one was
    /// missed. `resolve` re-reads the element before a press and refuses when
    /// the name it computes does not match the one the caller was shown — so an
    /// option that the scan named "3:00pm" from its value was re-read as ""
    /// and refused as `changed`. The scan offered a target that could never be
    /// pressed, which is worse than not offering it: the model sees the thing it
    /// wants and is told the screen moved.
    ///
    /// ### Why the value fallback is not general
    ///
    /// `AXValue` on an ordinary control is its *contents*, not its name. Naming
    /// a search box after whatever is typed in it would make the target change
    /// identity as the user types — and identity is what `resolve` checks.
    private static func name(of node: Node) -> String? {
        if let named = [node.title, node.help].compactMap({ $0?.trimmed }).first(where: {
            !$0.isEmpty
        }) {
            return named
        }
        guard optionRoles.contains(node.role) else { return nil }
        return node.value?.trimmed
    }

    private static func target(
        from node: Node, index: Int, element: AXUIElement, inChoices: Bool, choicesTaken: Int
    ) -> Target? {
        if node.role.isEmpty { return nil }
        if neverTargets.contains(node.role) {
            // The one exception, and it is narrow on purpose. See `optionRoles`.
            guard inChoices, optionRoles.contains(node.role), choicesTaken < maxOptions,
                node.actions.contains(kAXPressAction)
            else { return nil }
        }

        let kind: Kind
        if textRoles.contains(node.role) {
            kind = .type
        } else if node.actions.contains(kAXPressAction) {
            kind = .press
        } else {
            return nil
        }

        guard let name = name(of: node), !name.isEmpty else { return nil }

        return Target(
            index: index,
            role: node.role,
            subrole: node.subrole,
            title: AXHarvest.clamp(name, to: 120),
            help: node.help,
            value: node.value.map { AXHarvest.clamp($0, to: 200) },
            frame: node.frame,
            actions: node.actions,
            enabled: node.enabled,
            focused: node.focused,
            kind: kind)
    }

    /// What makes two targets the same target.
    ///
    /// Role, name and screen rectangle. The rectangle is the load-bearing part
    /// and the reason this is not simply `role|title`: a list of eleven chat
    /// rows all called "Priya Sharma" is eleven different conversations, and
    /// collapsing them would be much worse than the duplication being fixed.
    /// Two controls cannot occupy the same pixels, so same role + same name +
    /// same rectangle is the same control reached by two paths through the
    /// tree — which is exactly Chrome's toolbar, published once under the tab
    /// strip's group and once under the window's.
    ///
    /// Rounded to whole points because AX returns Doubles and a half-pixel of
    /// layout jitter between two reads of the same button would defeat it.
    ///
    /// An element with no frame keeps its own identity rather than being
    /// deduped on `role|title` alone — an unplaceable control is exactly the
    /// case where we cannot tell a copy from a namesake, and the safe mistake
    /// is showing both.
    private static func identity(of target: Target) -> String {
        guard let frame = target.frame else { return "unplaced:\(target.index)" }
        let box = [frame.origin.x, frame.origin.y, frame.size.width, frame.size.height]
            .map { String(Int($0.rounded())) }
            .joined(separator: ",")
        return "\(target.role)|\(target.title)|\(box)"
    }

    /// Does this element come from a web page rather than the app's own UI?
    ///
    /// `AXDOMIdentifier` is Chromium's marker on nodes that came from the
    /// renderer, and asking for it is a cheap way to answer "is the page
    /// actually here" without knowing anything about the page. Only the
    /// presence of the attribute matters, never its value.
    /// The role a browser gives the root of a rendered document.
    private static let webAreaRole = "AXWebArea"

    private static func webContent(_ element: AXUIElement) -> Bool {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, "AXDOMIdentifier" as CFString, &value)
            == .success
    }

    /// Browsers whose page content is a renderer away, and can be absent.
    ///
    /// A list rather than a capability probe because there is nothing to probe:
    /// a browser with its accessibility asleep is indistinguishable from an
    /// ordinary app with no web content in it. Being wrong here is cheap in one
    /// direction only — an app wrongly on this list would occasionally be
    /// described as a cold browser, so the list holds bundle ids and not
    /// guesses about families.
    private static let chromiumBrowsers: Set<String> = [
        "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev",
        "com.google.Chrome.canary", "com.microsoft.edgemac", "com.brave.Browser",
        "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "company.thebrowser.Browser",
        "com.pushplaylabs.sidekick", "ru.yandex.desktop.yandex-browser"
    ]

    private static func isChromiumBrowser(pid: pid_t) -> Bool {
        guard let bundleId = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
        else { return false }
        return chromiumBrowsers.contains(bundleId)
    }

    private static func actionNames(_ element: AXUIElement) -> [String] {
        var raw: CFArray?
        guard AXUIElementCopyActionNames(element, &raw) == .success,
            let names = raw as? [String]
        else { return [] }
        return names
    }

    private static func rect(position: CFTypeRef, size: CFTypeRef) -> CGRect? {
        guard CFGetTypeID(position) == AXValueGetTypeID(),
            CFGetTypeID(size) == AXValueGetTypeID()
        else { return nil }
        // swiftlint:disable force_cast
        let positionValue = position as! AXValue
        let sizeValue = size as! AXValue
        // swiftlint:enable force_cast
        var origin = CGPoint.zero
        var extent = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &origin),
            AXValueGetValue(sizeValue, .cgSize, &extent)
        else { return nil }
        return CGRect(origin: origin, size: extent)
    }

    // MARK: - Acting on one

    public struct Outcome {
        public let ok: Bool
        /// Why not. "stale-scan" | "no-such-target" | "changed" | "disabled"
        /// | "not-pressable" | "not-typeable" | "press-refused" | "focus-refused"
        public let reason: String?
        /// What the element says it is *now*, so a refusal can be explained on
        /// the card rather than merely reported.
        public let actualRole: String?
        public let actualTitle: String?
    }

    /// Press the element a scan found — after checking it is still that element.
    ///
    /// The re-read is the point. `insertText` verifies *after* it writes, which
    /// is the only honest order for a write; a press has to verify *before*,
    /// because there is no undo and the failure mode is pressing the wrong
    /// thing rather than pressing nothing. Between the scan the model reasoned
    /// about and this call, the user may have scrolled, a notification may have
    /// pushed a row down, the app may have re-rendered. A UI that has moved
    /// under us is the expected case.
    ///
    /// So the caller quotes back the role and title it was shown, and a
    /// mismatch refuses. An index alone would be an offset into a list that no
    /// longer exists.
    public static func press(
        harvestId: String, index: Int, expectRole: String?, expectTitle: String?
    ) -> Outcome {
        switch resolve(harvestId: harvestId, index: index, expectRole: expectRole,
                       expectTitle: expectTitle) {
        case .refused(let outcome):
            return outcome
        case .found(let found):
            guard found.actions.contains(kAXPressAction) else {
                return Outcome(
                    ok: false, reason: "not-pressable", actualRole: found.role,
                    actualTitle: found.title)
            }
            guard found.enabled else {
                return Outcome(
                    ok: false, reason: "disabled", actualRole: found.role,
                    actualTitle: found.title)
            }
            let status = AXUIElementPerformAction(found.element, kAXPressAction as CFString)
            guard status == .success else {
                return Outcome(
                    ok: false, reason: "press-refused", actualRole: found.role,
                    actualTitle: found.title)
            }
            return Outcome(ok: true, reason: nil, actualRole: found.role, actualTitle: found.title)
        }
    }

    /// Bring an element into view without touching it.
    ///
    /// ### Why this is a verb and not a keystroke
    ///
    /// Scrolling was reachable before only through `navKey` — `pageDown`, some
    /// number of times, and then look again to find out whether it worked. That
    /// is blind in both directions: the caller cannot tell how far a page is,
    /// and it moves whatever happens to have keyboard focus, which in a browser
    /// is often not the thing being read.
    ///
    /// `AXScrollToVisible` asks the *element* to make itself visible, so the
    /// application decides which of its scroll views to move and by how much.
    /// It is on 519 of the 575 elements surveyed across six applications, which
    /// is why this is a general answer rather than a per-app one.
    ///
    /// ### Why it re-reads first, like the other two
    ///
    /// It touches nothing, so it cannot press the wrong button — but it can
    /// scroll the user's window somewhere that has nothing to do with what they
    /// asked, and a stale index is exactly how that happens. The verification is
    /// cheap and shared, so there is no reason to skip it here.
    public static func scroll(
        harvestId: String, index: Int, expectRole: String?, expectTitle: String?
    ) -> Outcome {
        switch resolve(harvestId: harvestId, index: index, expectRole: expectRole,
                       expectTitle: expectTitle) {
        case .refused(let outcome):
            return outcome
        case .found(let found):
            guard found.actions.contains(scrollAction) else {
                return Outcome(
                    ok: false, reason: "not-scrollable", actualRole: found.role,
                    actualTitle: found.title)
            }
            let status = AXUIElementPerformAction(found.element, scrollAction as CFString)
            guard status == .success else {
                return Outcome(
                    ok: false, reason: "scroll-refused", actualRole: found.role,
                    actualTitle: found.title)
            }
            return Outcome(ok: true, reason: nil, actualRole: found.role, actualTitle: found.title)
        }
    }

    /// Put the caret in something that takes text.
    ///
    /// This deliberately does not type: the caller focuses here and then uses
    /// the ordinary `insertText` chain, which already knows each app's paste
    /// timing and already reads back what it wrote. Two verbs rather than one,
    /// because "put the caret somewhere" and "write text" want different
    /// guards.
    ///
    /// The role check is a capability check, not a safety one — see
    /// `textRoles`. It answers "will this element accept a caret at all", and
    /// the thing that keeps text from being *sent* lives in the step and tool
    /// vocabularies rather than here.
    public static func focus(
        harvestId: String, index: Int, expectRole: String?, expectTitle: String?
    ) -> Outcome {
        switch resolve(harvestId: harvestId, index: index, expectRole: expectRole,
                       expectTitle: expectTitle) {
        case .refused(let outcome):
            return outcome
        case .found(let found):
            guard textRoles.contains(found.role) else {
                return Outcome(
                    ok: false, reason: "not-typeable", actualRole: found.role,
                    actualTitle: found.title)
            }
            let status = AXUIElementSetAttributeValue(
                found.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            guard status == .success else {
                return Outcome(
                    ok: false, reason: "focus-refused", actualRole: found.role,
                    actualTitle: found.title)
            }
            // Read it back. Setting the attribute is a request, not a result —
            // an app may accept the write and put the caret somewhere else.
            var value: CFTypeRef?
            let focused =
                AXUIElementCopyAttributeValue(found.element, kAXFocusedAttribute as CFString, &value)
                == .success && (value.flatMap { AXHarvest.bool($0) } ?? false)
            guard focused else {
                return Outcome(
                    ok: false, reason: "focus-refused", actualRole: found.role,
                    actualTitle: found.title)
            }
            return Outcome(ok: true, reason: nil, actualRole: found.role, actualTitle: found.title)
        }
    }

    private struct Found {
        let element: AXUIElement
        let role: String
        let title: String
        let actions: [String]
        let enabled: Bool
    }

    private enum Resolution {
        case found(Found)
        case refused(Outcome)
    }

    /// Find the handle, and confirm it is still what the caller was shown.
    private static func resolve(
        harvestId: String, index: Int, expectRole: String?, expectTitle: String?
    ) -> Resolution {
        guard let held = Store.shared.element(harvestId: harvestId, index: index) else {
            // Two different failures, said separately: the scan has aged out of
            // the store, or that scan never had this many targets. The first is
            // "look again", the second is a bug in whatever chose the index.
            let known = Store.shared.knows(harvestId: harvestId)
            return .refused(
                Outcome(
                    ok: false, reason: known ? "no-such-target" : "stale-scan",
                    actualRole: nil, actualTitle: nil))
        }

        AXUIElementSetMessagingTimeout(held.element, messagingTimeout)
        let node = read(held.element)
        let name = name(of: node) ?? ""

        // An element that answers with no role at all is not a changed element,
        // it is a destroyed one — the handle outlived the thing. Pressing
        // Slack's Search button replaces the whole window contents, and every
        // handle from the previous scan comes back empty like this. "The row
        // you meant is gone" and "the row you meant is now somebody else" want
        // different sentences on the card.
        if node.role.isEmpty {
            return .refused(
                Outcome(ok: false, reason: "gone", actualRole: nil, actualTitle: nil))
        }
        if let expectRole, expectRole != node.role {
            return .refused(
                Outcome(
                    ok: false, reason: "changed", actualRole: node.role, actualTitle: name))
        }
        if let expectTitle, expectTitle != AXHarvest.clamp(name, to: 120) {
            return .refused(
                Outcome(
                    ok: false, reason: "changed", actualRole: node.role, actualTitle: name))
        }
        return .found(
            Found(
                element: held.element, role: node.role, title: name, actions: node.actions,
                enabled: node.enabled))
    }

    /// Same as `AXHarvest`'s, and for the same reason: one unresponsive element
    /// must not hang the call.
    private static let messagingTimeout: Float = 0.25

    // MARK: - Keeping the handles

    /// The elements a scan found, held so a later press can address them.
    ///
    /// An `AXUIElement` is a live handle into another process, not a
    /// description, which is exactly what is wanted: pressing the thing that
    /// was seen beats re-finding something with the same label in a tree that
    /// has moved since.
    ///
    /// Bounded, because handles are not free and a long session would otherwise
    /// accumulate one set per plan step forever. Two scans is enough — the
    /// current one and the one immediately before it, so a step decided against
    /// the previous look can still be attempted and then refused *on the
    /// evidence* rather than refused for want of a handle.
    final class Store {
        static let shared = Store()
        private struct Entry {
            let harvestId: String
            let pid: pid_t
            let elements: [AXUIElement]
        }
        private var entries: [Entry] = []
        private var counter = 0
        private let lock = NSLock()

        func keep(elements: [AXUIElement], pid: pid_t) -> String {
            lock.lock()
            defer { lock.unlock() }
            counter += 1
            let harvestId = "scan-\(counter)"
            entries.append(Entry(harvestId: harvestId, pid: pid, elements: elements))
            if entries.count > 2 { entries.removeFirst(entries.count - 2) }
            return harvestId
        }

        /// Is this scan still held at all? Distinguishes "look again" from
        /// "that index never existed".
        func knows(harvestId: String) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            return entries.contains { $0.harvestId == harvestId }
        }

        func element(harvestId: String, index: Int) -> (element: AXUIElement, pid: pid_t)? {
            lock.lock()
            defer { lock.unlock() }
            guard let entry = entries.first(where: { $0.harvestId == harvestId }),
                index >= 0, index < entry.elements.count
            else { return nil }
            return (entry.elements[index], entry.pid)
        }
    }
}
