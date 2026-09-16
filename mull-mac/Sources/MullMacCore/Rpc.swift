import Foundation

/// ndjson JSON-RPC 2.0 framing + dispatch for the `mull-mac` sidecar.
///
/// Wire contract: `src/shared/sidecar-api.ts` (source of truth). One JSON-RPC
/// message per line over stdio; requests flow Electron -> sidecar.

// MARK: - Ids

/// JSON-RPC ids may be numbers or strings; the Electron client sends ints.
public enum RpcId: Equatable {
    case int(Int)
    case string(String)

    var json: JSON {
        switch self {
        case .int(let v): return .int(v)
        case .string(let v): return .string(v)
        }
    }
}

// MARK: - Errors

public struct RpcError: Error, Equatable {
    public let code: Int
    public let message: String

    public init(code: Int, message: String) {
        self.code = code
        self.message = message
    }

    public static func parseError(_ detail: String) -> RpcError {
        RpcError(code: -32700, message: "Parse error: \(detail)")
    }
    public static func invalidRequest(_ detail: String) -> RpcError {
        RpcError(code: -32600, message: "Invalid request: \(detail)")
    }
    public static func methodNotFound(_ method: String) -> RpcError {
        RpcError(code: -32601, message: "Method not found: \(method)")
    }
    public static func invalidParams(_ detail: String) -> RpcError {
        RpcError(code: -32602, message: "Invalid params: \(detail)")
    }
    public static func notImplemented(_ detail: String) -> RpcError {
        RpcError(code: -32000, message: "NotImplemented: \(detail)")
    }
    public static func internalError(_ detail: String) -> RpcError {
        RpcError(code: -32603, message: "Internal error: \(detail)")
    }
}

// MARK: - Request parsing

public struct RpcRequest {
    public let id: RpcId?
    public let method: String
    /// Raw JSON bytes of `params` (re-serialized), for decoding into typed
    /// param structs by handlers. Nil when the request omitted params.
    public let params: Data?
}

public enum RpcFraming {
    /// Parse one ndjson line into a request. Throws RpcError on malformed input.
    public static func parseRequest(line: Data) throws -> RpcRequest {
        let parsed: Any
        do {
            parsed = try JSONSerialization.jsonObject(with: line)
        } catch {
            throw RpcError.parseError("not valid JSON")
        }
        guard let obj = parsed as? [String: Any] else {
            throw RpcError.invalidRequest("top level must be an object")
        }
        guard let version = obj["jsonrpc"] as? String, version == "2.0" else {
            throw RpcError.invalidRequest("jsonrpc must be \"2.0\"")
        }
        guard let method = obj["method"] as? String, !method.isEmpty else {
            throw RpcError.invalidRequest("method must be a non-empty string")
        }

        var id: RpcId? = nil
        if let raw = obj["id"] {
            if let n = raw as? Int {
                id = .int(n)
            } else if let s = raw as? String {
                id = .string(s)
            } else if raw is NSNull {
                id = nil
            } else {
                throw RpcError.invalidRequest("id must be an int or string")
            }
        }

        var params: Data? = nil
        if let rawParams = obj["params"], !(rawParams is NSNull) {
            guard rawParams is [String: Any] else {
                throw RpcError.invalidRequest("params must be an object")
            }
            params = try? JSONSerialization.data(withJSONObject: rawParams)
        }

        return RpcRequest(id: id, method: method, params: params)
    }

    public static func successLine(id: RpcId?, result: JSON) -> Data {
        JSON.object([
            "jsonrpc": .string("2.0"),
            "id": id?.json ?? .null,
            "result": result
        ]).encodedLine()
    }

    public static func errorLine(id: RpcId?, error: RpcError) -> Data {
        JSON.object([
            "jsonrpc": .string("2.0"),
            "id": id?.json ?? .null,
            "error": .object([
                "code": .int(error.code),
                "message": .string(error.message)
            ])
        ]).encodedLine()
    }
}

// MARK: - Dispatcher

/// A verb handler: raw params JSON in, JSON result out (throw RpcError to fail).
public typealias RpcHandler = (Data?) throws -> JSON

public final class RpcDispatcher {
    private var handlers: [String: RpcHandler] = [:]

    public init() {}

    public func register(_ method: String, _ handler: @escaping RpcHandler) {
        handlers[method] = handler
    }

    public var methods: [String] { Array(handlers.keys).sorted() }

    /// Handle one raw ndjson line. Returns the response line to write, or nil
    /// for notifications (requests without an id get no response).
    public func handle(line: Data) -> Data? {
        let request: RpcRequest
        do {
            request = try RpcFraming.parseRequest(line: line)
        } catch let err as RpcError {
            return RpcFraming.errorLine(id: nil, error: err)
        } catch {
            return RpcFraming.errorLine(id: nil, error: .parseError("unknown"))
        }

        guard let handler = handlers[request.method] else {
            guard let id = request.id else { return nil }
            return RpcFraming.errorLine(id: id, error: .methodNotFound(request.method))
        }

        do {
            let result = try handler(request.params)
            guard let id = request.id else { return nil }
            return RpcFraming.successLine(id: id, result: result)
        } catch let err as RpcError {
            guard let id = request.id else { return nil }
            return RpcFraming.errorLine(id: id, error: err)
        } catch {
            guard let id = request.id else { return nil }
            return RpcFraming.errorLine(id: id, error: .internalError(String(describing: error)))
        }
    }
}

// MARK: - Param decoding helper

public func decodeParams<T: Decodable>(_ type: T.Type, from data: Data?, defaultIfMissing: T? = nil) throws -> T {
    guard let data else {
        if let fallback = defaultIfMissing { return fallback }
        throw RpcError.invalidParams("params object required")
    }
    do {
        return try JSONDecoder().decode(T.self, from: data)
    } catch {
        throw RpcError.invalidParams(String(describing: error))
    }
}
