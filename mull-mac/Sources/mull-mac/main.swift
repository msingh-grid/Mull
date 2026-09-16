import CoreFoundation
import Foundation
import MullMacCore

/// mull-mac — Swift sidecar for Mull (protocol 3, M3).
///
/// ndjson JSON-RPC 2.0 over stdio; contract: src/shared/sidecar-api.ts.
/// One message per line: requests in on stdin, responses and notifications out
/// on stdout. Diagnostics go to stderr only — stdout is the protocol channel.
///
/// **Why this file has threads now.** Through M2 the main thread simply blocked
/// on `readLine()`. The M3 event tap needs a live CFRunLoop, and a blocked main
/// thread has none, so the roles are swapped: stdin is read on a background
/// thread, and the main thread runs the run loop for the tap. That makes stdout
/// writable from two threads, which is what `LineWriter` is for — interleaved
/// bytes from a response and a notification would corrupt both lines.

setvbuf(stdout, nil, _IONBF, 0) // unbuffered: each line flushes immediately

/// Serialises writes so a response and a notification can never interleave.
final class LineWriter {
    private let handle = FileHandle.standardOutput
    private let lock = NSLock()

    func write(_ line: Data) {
        lock.lock()
        defer { lock.unlock() }
        handle.write(line)
        handle.write(Data("\n".utf8))
    }
}

let writer = LineWriter()
let system = RealSystem()
system.notify = { json in writer.write(json.encodedLine()) }

let dispatcher = makeDispatcher(system: system)

FileHandle.standardError.write(
    Data("mull-mac \(SIDECAR_VERSION) ready (protocol \(SIDECAR_PROTOCOL_VERSION))\n".utf8))

let stdinThread = Thread {
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        if let response = dispatcher.handle(line: Data(line.utf8)) {
            writer.write(response)
        }
    }
    // stdin closed => the parent exited or shut us down. Exiting from here
    // rather than unwinding is deliberate: the main thread is parked in
    // CFRunLoopRun() and has nothing to return to.
    exit(0)
}
stdinThread.name = "mull.stdin"
stdinThread.start()

// The event tap's run loop. Idle and cheap until a tap is installed.
CFRunLoopRun()
