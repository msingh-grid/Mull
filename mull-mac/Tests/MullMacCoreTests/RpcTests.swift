import Foundation
import XCTest
@testable import MullMacCore

/// Stub system: deterministic, never touches TCC / AppKit global state.
final class StubSystem: SystemActions {
    var trusted = true
    var secureInput = false
    var inserts: [(text: String, strategy: String)] = []

    func accessibilityTrusted() -> Bool { trusted }
    func inputMonitoringGranted() -> Bool { true }
    func microphoneStatus() -> String { "granted" }
    func promptAccessibility() -> Bool { true }
    func frontmostApp() -> (app: AppInfo?, windowTitle: String?) {
        (AppInfo(bundleId: "com.apple.TextEdit", name: "TextEdit", pid: 123), "Untitled")
    }
    func secureInputActive() -> Bool { secureInput }
    func insert(text: String, strategy: String) -> InsertOutcome {
        inserts.append((text, strategy))
        return InsertOutcome(inserted: true, strategyUsed: strategy, reason: nil)
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
        let obj = try handle(#"{"jsonrpc":"2.0","id":1,"method":"init","params":{"protocolVersion":1}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["ok"] as? Bool, true)
        XCTAssertEqual(result["protocolVersion"] as? Int, 1)
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

    func testInsertTextAxIsNotImplemented() throws {
        let obj = try handle(
            #"{"jsonrpc":"2.0","id":5,"method":"insertText","params":{"text":"hi","strategy":"ax"}}"#)
        let error = try XCTUnwrap(obj["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? Int, -32000)
        XCTAssertTrue((error["message"] as? String ?? "").contains("M2"))
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

    func testM2VerbsAreNotImplemented() throws {
        for verb in ["focusedElement", "replaceSelection", "activateApp", "keyChord"] {
            let obj = try handle(#"{"jsonrpc":"2.0","id":9,"method":"\#(verb)","params":{}}"#)
            let error = try XCTUnwrap(obj["error"] as? [String: Any])
            XCTAssertEqual(error["code"] as? Int, -32000, verb)
        }
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
