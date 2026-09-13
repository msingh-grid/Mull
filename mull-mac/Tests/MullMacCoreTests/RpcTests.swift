import Foundation
import XCTest
@testable import MullMacCore

/// Stub system: deterministic, never touches TCC / AppKit global state.
///
/// **Keep every protocol method implemented here, even trivially.** This file
/// needs XCTest, XCTest needs full Xcode, and a machine with only the Command
/// Line Tools installed cannot compile it — which is how `selectedText`,
/// `startHotkeyTap` and `stopHotkeyTap` were added to `SystemActions` in M3 and
/// M4.2 without ever being added here. Nothing in package.json runs `swift
/// test`, so the drift was silent for two milestones. An incomplete stub is a
/// suite that fails to build for whoever next has Xcode.
final class StubSystem: SystemActions {
    var trusted = true
    var secureInput = false
    var screenRecording = true
    var harvest = WindowContextInfo(
        blocks: [
            ContextBlockInfo(
                role: "AXStaticText", text: "can you confirm the redlines by EOD?", label: nil,
                focused: false, selected: false),
            ContextBlockInfo(
                role: "AXTextArea", text: "", label: "Message #terms-doc", focused: true,
                selected: false)
        ],
        truncated: false, stoppedBy: "complete", harvestMs: 12, screenshot: nil,
        screenshotReason: "not-requested")
    var harvestCalls: [(maxChars: Int, deadlineMs: Int, screenshot: Bool)] = []
    var inserts: [(text: String, strategy: String, settleMs: Int)] = []
    var replacements: [(text: String, strategy: String)] = []
    var ranges: [(start: Int, length: Int, text: String, expect: String?)] = []
    var chords: [(key: String, modifiers: [String])] = []
    var activations: [String] = []
    var element: FocusedElementLookup = .found(
        FocusedElementInfo(
            role: "AXTextArea", editable: true, text: "hello world", textStart: 0,
            truncated: false,
            selection: SelectionInfo(start: 5, length: 0, text: "")))

    func accessibilityTrusted() -> Bool { trusted }
    func inputMonitoringGranted() -> Bool { true }
    func microphoneStatus() -> String { "granted" }
    func promptAccessibility() -> Bool { true }
    func frontmostApp() -> (app: AppInfo?, windowTitle: String?) {
        (AppInfo(bundleId: "com.apple.TextEdit", name: "TextEdit", pid: 123), "Untitled")
    }
    func secureInputActive() -> Bool { secureInput }
    func screenRecordingGranted() -> Bool { screenRecording }
    func promptScreenRecording() -> Bool { true }
    func focusedElement(context: Int) -> FocusedElementLookup { element }
    func selectedText(allowCopy: Bool) -> SelectionLookup {
        SelectionLookup(text: "world", editable: true, source: "focused", reason: nil)
    }
    func windowContext(maxChars: Int, deadlineMs: Int, screenshot: Bool) -> WindowContextInfo {
        harvestCalls.append((maxChars, deadlineMs, screenshot))
        return harvest
    }
    func startHotkeyTap(chord: String, swallow: Bool) -> (started: Bool, reason: String?) {
        (true, nil)
    }
    func stopHotkeyTap() -> Bool { true }
    func insert(text: String, strategy: String, settleMs: Int) -> InsertOutcome {
        inserts.append((text, strategy, settleMs))
        return InsertOutcome(
            inserted: true, strategyUsed: strategy, reason: nil, verified: true, caret: 11)
    }
    func replaceSelection(text: String, strategy: String, settleMs: Int) -> InsertOutcome {
        replacements.append((text, strategy))
        return InsertOutcome(
            inserted: true, strategyUsed: strategy, reason: nil, verified: true, caret: 11,
            replacedText: "world")
    }
    func replaceRange(start: Int, length: Int, text: String, expect: String?) -> InsertOutcome {
        ranges.append((start, length, text, expect))
        return InsertOutcome(
            inserted: true, strategyUsed: "ax", reason: nil, verified: true, caret: start)
    }
    func activateApp(bundleId: String) -> (activated: Bool, reason: String?) {
        activations.append(bundleId)
        return (true, nil)
    }
    func keyChord(key: String, modifiers: [String]) -> (sent: Bool, reason: String?) {
        chords.append((key, modifiers))
        return (true, nil)
    }
}

private func json(_ data: Data) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

final class RpcFramingTests: XCTestCase {
    func testParseValidRequest() throws {
        let line = #"{"jsonrpc":"2.0","id":7,"method":"init","params":{"protocolVersion":1}}"#
        let req = try RpcFraming.parseRequest(line: Data(line.utf8))
        XCTAssertEqual(req.method, "init")
        XCTAssertEqual(req.id, .int(7))
        XCTAssertNotNil(req.params)
    }

    func testParseRejectsNonJson() {
        XCTAssertThrowsError(try RpcFraming.parseRequest(line: Data("not json".utf8))) { error in
            XCTAssertEqual((error as? RpcError)?.code, -32700)
        }
    }

    func testParseRejectsMissingVersion() {
        let line = #"{"id":1,"method":"init"}"#
        XCTAssertThrowsError(try RpcFraming.parseRequest(line: Data(line.utf8))) { error in
            XCTAssertEqual((error as? RpcError)?.code, -32600)
        }
    }

    func testResponseRoundTrip() throws {
        let out = RpcFraming.successLine(id: .int(3), result: .object(["ok": .bool(true)]))
        XCTAssertFalse(out.contains(UInt8(ascii: "\n")), "ndjson lines must not embed newlines")
        let obj = try json(out)
        XCTAssertEqual(obj["jsonrpc"] as? String, "2.0")
        XCTAssertEqual(obj["id"] as? Int, 3)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["ok"] as? Bool, true)
    }

    func testNewlinesInStringsAreEscaped() throws {
        let out = RpcFraming.successLine(id: .int(1), result: .object(["text": .string("a\nb")]))
        XCTAssertFalse(out.contains(UInt8(ascii: "\n")))
        let obj = try json(out)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["text"] as? String, "a\nb")
    }
}

final class VerbTests: XCTestCase {
    var system = StubSystem()

    func handle(_ line: String) throws -> [String: Any] {
        let dispatcher = makeDispatcher(system: system)
        let response = try XCTUnwrap(dispatcher.handle(line: Data(line.utf8)))
        return try json(response)
    }

    func testInitHappyPath() throws {
        let obj = try handle(
            #"{"jsonrpc":"2.0","id":1,"method":"init","params":{"protocolVersion":\#(SIDECAR_PROTOCOL_VERSION)}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["ok"] as? Bool, true)
        XCTAssertEqual(result["protocolVersion"] as? Int, SIDECAR_PROTOCOL_VERSION)
        XCTAssertEqual(result["sidecarVersion"] as? String, SIDECAR_VERSION)
    }

    func testInitRejectsVersionMismatch() throws {
        let obj = try handle(#"{"jsonrpc":"2.0","id":1,"method":"init","params":{"protocolVersion":99}}"#)
        let error = try XCTUnwrap(obj["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? Int, -32602)
    }

    func testUnknownMethod() throws {
        let obj = try handle(#"{"jsonrpc":"2.0","id":2,"method":"launchMissiles","params":{}}"#)
        let error = try XCTUnwrap(obj["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? Int, -32601)
    }

    func testInsertTextValidatesParams() throws {
        let obj = try handle(#"{"jsonrpc":"2.0","id":3,"method":"insertText","params":{}}"#)
        let error = try XCTUnwrap(obj["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? Int, -32602)
    }

    func testInsertTextRejectsUnknownStrategy() throws {
        let obj = try handle(
            #"{"jsonrpc":"2.0","id":4,"method":"insertText","params":{"text":"hi","strategy":"osmosis"}}"#)
        let error = try XCTUnwrap(obj["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? Int, -32602)
    }

    func testInsertTextAcceptsAx() throws {
        let obj = try handle(
            #"{"jsonrpc":"2.0","id":5,"method":"insertText","params":{"text":"hi","strategy":"ax"}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["strategyUsed"] as? String, "ax")
        XCTAssertEqual(result["verified"] as? Bool, true)
        XCTAssertEqual(system.inserts.first?.strategy, "ax")
    }

    func testInsertTextBlocksOnSecureInput() throws {
        system.secureInput = true
        let obj = try handle(#"{"jsonrpc":"2.0","id":6,"method":"insertText","params":{"text":"hi"}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["inserted"] as? Bool, false)
        XCTAssertEqual(result["reason"] as? String, "secure-input")
        XCTAssertTrue(result["strategyUsed"] is NSNull, "strategyUsed must be explicit null")
        XCTAssertTrue(system.inserts.isEmpty)
    }

    func testInsertTextBlocksWithoutAccessibility() throws {
        system.trusted = false
        let obj = try handle(#"{"jsonrpc":"2.0","id":7,"method":"insertText","params":{"text":"hi"}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["inserted"] as? Bool, false)
        XCTAssertEqual(result["reason"] as? String, "no-accessibility")
    }

    func testInsertTextDefaultsToPaste() throws {
        let obj = try handle(#"{"jsonrpc":"2.0","id":8,"method":"insertText","params":{"text":"hello"}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["inserted"] as? Bool, true)
        XCTAssertEqual(result["strategyUsed"] as? String, "paste")
        XCTAssertEqual(system.inserts.first?.text, "hello")
        XCTAssertEqual(system.inserts.first?.strategy, "paste")
    }

    func testInsertTextPassesSettleDelayThrough() throws {
        _ = try handle(
            #"{"jsonrpc":"2.0","id":8,"method":"insertText","params":{"text":"hi","settleMs":400}}"#)
        XCTAssertEqual(system.inserts.first?.settleMs, 400)
    }

    func testInsertTextDefaultsSettleDelay() throws {
        _ = try handle(#"{"jsonrpc":"2.0","id":8,"method":"insertText","params":{"text":"hi"}}"#)
        XCTAssertEqual(system.inserts.first?.settleMs, DEFAULT_SETTLE_MS)
    }

    // MARK: M2 verbs

    func testFocusedElementShape() throws {
        let obj = try handle(#"{"jsonrpc":"2.0","id":20,"method":"focusedElement","params":{}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        let element = try XCTUnwrap(result["element"] as? [String: Any])
        XCTAssertEqual(element["role"] as? String, "AXTextArea")
        XCTAssertEqual(element["editable"] as? Bool, true)
        XCTAssertEqual(element["textStart"] as? Int, 0)
        XCTAssertEqual(element["truncated"] as? Bool, false)
        let selection = try XCTUnwrap(element["selection"] as? [String: Any])
        XCTAssertEqual(selection["start"] as? Int, 5)
        XCTAssertTrue(result["reason"] is NSNull)
    }

    func testFocusedElementReportsWhyItIsUnavailable() throws {
        system.element = .unavailable("no-focused-element")
        let obj = try handle(#"{"jsonrpc":"2.0","id":21,"method":"focusedElement","params":{}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertTrue(result["element"] is NSNull)
        XCTAssertEqual(result["reason"] as? String, "no-focused-element")
    }

    func testFocusedElementWorksWithoutParams() throws {
        let obj = try handle(#"{"jsonrpc":"2.0","id":22,"method":"focusedElement"}"#)
        XCTAssertNotNil(obj["result"])
    }

    func testReplaceSelectionReturnsWhatItDestroyed() throws {
        let obj = try handle(
            #"{"jsonrpc":"2.0","id":23,"method":"replaceSelection","params":{"text":"there"}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["replaced"] as? Bool, true)
        XCTAssertEqual(result["replacedText"] as? String, "world")
        XCTAssertEqual(system.replacements.first?.strategy, "ax", "ax is the default for edits")
    }

    func testReplaceSelectionBlocksOnSecureInput() throws {
        system.secureInput = true
        let obj = try handle(
            #"{"jsonrpc":"2.0","id":24,"method":"replaceSelection","params":{"text":"x"}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["replaced"] as? Bool, false)
        XCTAssertEqual(result["reason"] as? String, "secure-input")
        XCTAssertTrue(system.replacements.isEmpty)
    }

    func testReplaceRangePassesExpectThrough() throws {
        let obj = try handle(
            #"{"jsonrpc":"2.0","id":25,"method":"replaceRange","params":{"start":6,"length":5,"text":"","expect":"world"}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["replaced"] as? Bool, true)
        XCTAssertEqual(system.ranges.first?.expect, "world")
        XCTAssertEqual(system.ranges.first?.start, 6)
    }

    func testReplaceRangeRejectsNegativeOffsets() throws {
        let obj = try handle(
            #"{"jsonrpc":"2.0","id":26,"method":"replaceRange","params":{"start":-1,"length":2,"text":""}}"#)
        let error = try XCTUnwrap(obj["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? Int, -32602)
    }

    func testReplaceRangeBlocksWithoutAccessibility() throws {
        system.trusted = false
        let obj = try handle(
            #"{"jsonrpc":"2.0","id":27,"method":"replaceRange","params":{"start":0,"length":1,"text":""}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["reason"] as? String, "no-accessibility")
        XCTAssertTrue(system.ranges.isEmpty)
    }

    func testActivateAppRejectsEmptyBundleId() throws {
        let obj = try handle(
            #"{"jsonrpc":"2.0","id":28,"method":"activateApp","params":{"bundleId":""}}"#)
        let error = try XCTUnwrap(obj["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? Int, -32602)
    }

    func testKeyChordRejectsUnknownModifier() throws {
        let obj = try handle(
            #"{"jsonrpc":"2.0","id":29,"method":"keyChord","params":{"key":"v","modifiers":["hyper"]}}"#)
        let error = try XCTUnwrap(obj["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? Int, -32602)
        XCTAssertTrue(system.chords.isEmpty)
    }

    func testKeyChordPassesModifiersThrough() throws {
        let obj = try handle(
            #"{"jsonrpc":"2.0","id":30,"method":"keyChord","params":{"key":"v","modifiers":["cmd"]}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["sent"] as? Bool, true)
        XCTAssertEqual(system.chords.first?.modifiers, ["cmd"])
    }

    /// The guard against a verb existing in `src/shared/sidecar-api.ts` and
    /// nowhere else. It had drifted three methods behind by M4.2 — see the note
    /// on `StubSystem`.
    func testEveryContractMethodIsRegistered() {
        let dispatcher = makeDispatcher(system: system)
        let expected = [
            "activateApp", "checkPermissions", "focusedElement", "frontmostApp", "init",
            "insertText", "keyChord", "promptAccessibility", "promptScreenRecording",
            "replaceRange", "replaceSelection", "secureInputState", "selectedText",
            "startHotkeyTap", "stopHotkeyTap", "windowContext"
        ]
        XCTAssertEqual(dispatcher.methods, expected)
    }

    // MARK: - windowContext (M5a)

    func testWindowContextReturnsBlocksInOrder() throws {
        let obj = try handle(#"{"jsonrpc":"2.0","id":40,"method":"windowContext","params":{}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        let blocks = try XCTUnwrap(result["blocks"] as? [[String: Any]])
        XCTAssertEqual(blocks.count, 2)
        XCTAssertEqual(blocks[0]["text"] as? String, "can you confirm the redlines by EOD?")
        // The empty focused composer survives: "there is a box here and it is
        // empty" is the fact that makes a reply possible.
        XCTAssertEqual(blocks[1]["text"] as? String, "")
        XCTAssertEqual(blocks[1]["focused"] as? Bool, true)
        XCTAssertEqual(blocks[1]["label"] as? String, "Message #terms-doc")
        XCTAssertEqual(result["stoppedBy"] as? String, "complete")
    }

    func testWindowContextClampsItsBudgets() throws {
        _ = try handle(
            #"{"jsonrpc":"2.0","id":41,"method":"windowContext","params":{"maxChars":999999,"deadlineMs":1}}"#)
        let call = try XCTUnwrap(system.harvestCalls.first)
        XCTAssertEqual(call.maxChars, 32_000)
        XCTAssertEqual(call.deadlineMs, 50)
    }

    func testWindowContextDoesNotPhotographUnlessAsked() throws {
        _ = try handle(#"{"jsonrpc":"2.0","id":42,"method":"windowContext","params":{}}"#)
        XCTAssertEqual(system.harvestCalls.first?.screenshot, false)
    }

    /// Reading a password field is its own harm, distinct from typing into one.
    /// So secure input refuses the whole verb rather than only its write half.
    func testWindowContextRefusesUnderSecureInput() throws {
        system.secureInput = true
        let obj = try handle(#"{"jsonrpc":"2.0","id":43,"method":"windowContext","params":{}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["stoppedBy"] as? String, "secure-input")
        XCTAssertEqual((result["blocks"] as? [[String: Any]])?.count, 0)
        XCTAssertTrue(system.harvestCalls.isEmpty)
    }

    func testWindowContextRefusesWithoutAccessibility() throws {
        system.trusted = false
        let obj = try handle(#"{"jsonrpc":"2.0","id":44,"method":"windowContext","params":{}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["stoppedBy"] as? String, "no-accessibility")
        XCTAssertTrue(system.harvestCalls.isEmpty)
    }

    func testCheckPermissionsReportsScreenRecording() throws {
        system.screenRecording = false
        let obj = try handle(#"{"jsonrpc":"2.0","id":45,"method":"checkPermissions","params":{}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["screenRecording"] as? Bool, false)
    }

    /// A ✓ never comes from the click: the grant needs a relaunch, so the verb
    /// re-reads rather than echoing that it prompted.
    func testPromptScreenRecordingRereadsRatherThanAssuming() throws {
        system.screenRecording = false
        let obj = try handle(
            #"{"jsonrpc":"2.0","id":46,"method":"promptScreenRecording","params":{}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["prompted"] as? Bool, true)
        XCTAssertEqual(result["screenRecording"] as? Bool, false)
    }

    func testNotificationGetsNoResponse() {
        let dispatcher = makeDispatcher(system: system)
        let line = #"{"jsonrpc":"2.0","method":"checkPermissions","params":{}}"#
        XCTAssertNil(dispatcher.handle(line: Data(line.utf8)))
    }

    func testFrontmostAppShape() throws {
        let obj = try handle(#"{"jsonrpc":"2.0","id":10,"method":"frontmostApp","params":{}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        let app = try XCTUnwrap(result["app"] as? [String: Any])
        XCTAssertEqual(app["bundleId"] as? String, "com.apple.TextEdit")
        XCTAssertEqual(result["windowTitle"] as? String, "Untitled")
    }

    func testSecureInputStateShape() throws {
        let obj = try handle(#"{"jsonrpc":"2.0","id":11,"method":"secureInputState","params":{}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["active"] as? Bool, false)
        XCTAssertTrue(result["pid"] is NSNull)
    }
}
