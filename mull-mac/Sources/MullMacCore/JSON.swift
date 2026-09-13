import Foundation

/// Minimal JSON value type used for RPC *results* so that explicit `null`s are
/// always emitted (the TS side validates results with zod `.nullable()`, which
/// requires the key to be present — Swift's Codable omits nil optionals).
public enum JSON: Equatable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])
}

extension JSON: Encodable {
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let v): try container.encode(v)
        case .int(let v): try container.encode(v)
        case .double(let v): try container.encode(v)
        case .string(let v): try container.encode(v)
        case .array(let v): try container.encode(v)
        case .object(let v): try container.encode(v)
        }
    }
}

extension JSON {
    /// Compact single-line UTF-8 encoding (ndjson-safe: JSONEncoder never
    /// emits raw newlines in compact mode; string contents are escaped).
    public func encodedLine() -> Data {
        let encoder = JSONEncoder()
        // Deterministic output for tests.
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        // Encoding JSON cannot throw: all cases are encodable primitives.
        return (try? encoder.encode(self)) ?? Data("null".utf8)
    }
}
