import ApplicationServices
import Foundation

/// Accessibility reads and writes against the focused text element.
///
/// Two rules shape everything here:
///
///  1. **Never guess.** Every read that can fail returns nil rather than a
///     plausible default, and every write reports whether it was *confirmed*,
///     *contradicted*, or simply unknown (`VerifyOutcome`). Mull's promise is
///     that it shows you what it did; a fabricated "inserted: true" breaks that
///     promise more quietly, and therefore worse, than a visible failure.
///  2. **UTF-16 everywhere.** AX indexes text by UTF-16 unit, so offsets that
///     cross this boundary (into the journal, back in as `replaceRange`) are
///     UTF-16 offsets too. No conversion, no drift.
enum AXText {

    // MARK: - Finding the element

    /// The focused element of the focused app, via the system-wide element —
    /// i.e. wherever the caret the user can see actually is.
    static func focusedElement() -> AXUIElement? {
        let systemWide = AXUIElementCreateSystemWide()
        var value: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(
                systemWide, kAXFocusedUIElementAttribute as CFString, &value) == .success,
            let value, CFGetTypeID(value) == AXUIElementGetTypeID()
        else { return nil }
        // swiftlint:disable:next force_cast
        return (value as! AXUIElement)
    }

    // MARK: - Primitive reads

    static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
        else { return nil }
        return value as? String
    }

    static func range(_ element: AXUIElement, _ attribute: String) -> CFRange? {
        var value: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
            let value, CFGetTypeID(value) == AXValueGetTypeID()
        else { return nil }
        var out = CFRange(location: 0, length: 0)
        // swiftlint:disable:next force_cast
        guard AXValueGetValue((value as! AXValue), .cfRange, &out) else { return nil }
        return out
    }

    static func settable(_ element: AXUIElement, _ attribute: String) -> Bool {
        var flag: DarwinBoolean = false
        guard AXUIElementIsAttributeSettable(element, attribute as CFString, &flag) == .success
        else { return false }
        return flag.boolValue
    }

    /// Text for an explicit range. Prefers the parameterized attribute (works on
    /// elements too large to hand over whole, e.g. a long document) and falls
    /// back to slicing the value.
    static func text(_ element: AXUIElement, start: Int, length: Int) -> String? {
        guard start >= 0, length >= 0 else { return nil }
        var cfRange = CFRange(location: start, length: length)
        if let rangeValue = AXValueCreate(.cfRange, &cfRange) {
            var out: CFTypeRef?
            if AXUIElementCopyParameterizedAttributeValue(
                element, kAXStringForRangeParameterizedAttribute as CFString, rangeValue, &out)
                == .success, let string = out as? String
            {
                return string
            }
        }
        guard let whole = string(element, kAXValueAttribute) else { return nil }
        let units = Array(whole.utf16)
        guard start <= units.count else { return nil }
        let end = min(start + length, units.count)
        return decode(units[start..<end])
    }

    /// UTF-16 length of the element's value, or nil when it has no text value.
    static func valueLength(_ element: AXUIElement) -> Int? {
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(
            element, kAXNumberOfCharactersAttribute as CFString, &value) == .success,
            let count = value as? Int
        {
            return count
        }
        return string(element, kAXValueAttribute).map { $0.utf16.count }
    }

    static func decode(_ units: ArraySlice<UInt16>) -> String {
        String(decoding: Array(units), as: UTF16.self)
    }

    // MARK: - Snapshot

    struct Snapshot {
        let role: String
        let editable: Bool
        /// Value clamped to a window around the caret.
        let text: String
        /// Absolute UTF-16 offset where `text` begins.
        let textStart: Int
        let truncated: Bool
        let selection: (start: Int, length: Int, text: String)?
    }

    /// Read the focused element. `context` clamps the returned text to that many
    /// UTF-16 units on each side of the caret — a mail thread or a source file
    /// can be megabytes, and nothing downstream needs all of it.
    static func snapshot(_ element: AXUIElement, context: Int) -> Snapshot? {
        let role = string(element, kAXRoleAttribute) ?? ""
        // A settable value or settable selected-text is what "editable" means
        // operationally: it is exactly the condition an AX write needs.
        let editable =
            settable(element, kAXValueAttribute) || settable(element, kAXSelectedTextAttribute)

        let selectedRange = range(element, kAXSelectedTextRangeAttribute)
        let selectedText = string(element, kAXSelectedTextAttribute)

        guard let whole = string(element, kAXValueAttribute) else {
            // Some elements (web text areas, terminals) expose a selection but
            // refuse their whole value. That is still a usable element.
            guard let selectedRange else { return nil }
            return Snapshot(
                role: role,
                editable: editable,
                text: "",
                textStart: max(0, selectedRange.location),
                truncated: true,
                selection: (
                    start: selectedRange.location,
                    length: selectedRange.length,
                    text: selectedText ?? ""
                )
            )
        }

        let units = Array(whole.utf16)
        let caret = selectedRange.map { max(0, min($0.location, units.count)) } ?? units.count
        let start = max(0, caret - context)
        let end = min(units.count, caret + context)
        let window = decode(units[start..<end])

        return Snapshot(
            role: role,
            editable: editable,
            text: window,
            textStart: start,
            truncated: start > 0 || end < units.count,
            selection: selectedRange.map {
                (
                    start: $0.location,
                    length: $0.length,
                    text: selectedText ?? sliceUTF16(units, start: $0.location, length: $0.length)
                )
            }
        )
    }

    static func sliceUTF16(_ units: [UInt16], start: Int, length: Int) -> String {
        guard start >= 0, length > 0, start < units.count else { return "" }
        return decode(units[start..<min(start + length, units.count)])
    }

    // MARK: - Writes

    /// Tri-state read-back. `unknown` is a real answer: some elements accept a
    /// write and then refuse to be read, and saying so is more useful than
    /// picking one of the other two.
    enum VerifyOutcome {
        case confirmed
        case contradicted
        case unknown
    }

    /// Replace the current selection (or insert at the caret when the selection
    /// is empty). Returns `.success` only if AX itself accepted the write.
    static func setSelectedText(_ element: AXUIElement, _ text: String) -> AXError {
        AXUIElementSetAttributeValue(
            element, kAXSelectedTextAttribute as CFString, text as CFTypeRef)
    }

    static func setSelectedRange(_ element: AXUIElement, start: Int, length: Int) -> Bool {
        var cfRange = CFRange(location: start, length: length)
        guard let value = AXValueCreate(.cfRange, &cfRange) else { return false }
        return AXUIElementSetAttributeValue(
            element, kAXSelectedTextRangeAttribute as CFString, value) == .success
    }

    /// Did `text` actually land ending at `caret`? Used after *every* strategy,
    /// including paste — which is how the insertion matrix learns that a paste
    /// into some app silently did nothing.
    static func verify(_ element: AXUIElement, text: String, endingAt caret: Int) -> VerifyOutcome {
        guard !text.isEmpty else { return .confirmed }
        let length = text.utf16.count
        let start = caret - length
        guard start >= 0 else { return .contradicted }
        guard let actual = self.text(element, start: start, length: length) else { return .unknown }
        return actual == text ? .confirmed : .contradicted
    }

    /// Caret offset now, or nil when unreadable.
    static func caret(_ element: AXUIElement) -> Int? {
        range(element, kAXSelectedTextRangeAttribute).map { $0.location + $0.length }
    }
}
