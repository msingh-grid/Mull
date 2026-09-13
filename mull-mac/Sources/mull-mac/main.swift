import Foundation
import MullMacCore

/// mull-mac — Swift sidecar for Mull (v0, M1).
///
/// ndjson JSON-RPC 2.0 over stdio; contract: src/shared/sidecar-api.ts.
/// Reads one request per line from stdin, writes one response per line to
/// stdout. Diagnostics go to stderr only (stdout is the protocol channel).

setvbuf(stdout, nil, _IONBF, 0) // unbuffered: each response line flushes immediately

let dispatcher = makeDispatcher(system: RealSystem())
let stdoutHandle = FileHandle.standardOutput

FileHandle.standardError.write(Data("mull-mac \(SIDECAR_VERSION) ready (protocol \(SIDECAR_PROTOCOL_VERSION))\n".utf8))

while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    if let response = dispatcher.handle(line: Data(line.utf8)) {
        stdoutHandle.write(response)
        stdoutHandle.write(Data("\n".utf8))
    }
}
// stdin closed => parent exited or shut us down; exit cleanly.
