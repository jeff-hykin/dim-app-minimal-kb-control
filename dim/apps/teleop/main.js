// Teleop — backend half (runs in the DimOS desktop's Deno process).
//
// Zenoh (peer mode, LCM encoding) has no good native Deno client, so — like
// go2_dash shelling out to its Rust helper — we run a tiny Python helper
// (zenoh_bridge.py) via the desktop-provided interpreter (ctx.python).
// The helper uses DimOS's own ZenohTransport, so the wire format matches the
// rest of the stack. We relay newline-JSON over stdio:
// teleop velocities down to the helper, decoded camera frames back up to the
// browser panel.

import { TextLineStream } from "https://deno.land/std@0.224.0/streams/text_line_stream.ts"
import { DimAppBackend, dimContext } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.3.0/backend.js"

const dimApp = new DimAppBackend()
const ctx = dimContext()

const BRIDGE = new URL("./zenoh_bridge.py", import.meta.url).pathname
const RESTART_MS = 3000
const MAX_RESTART_MS = 60000
// A bridge that survives this long counts as a real session, so the next crash
// starts backing off from scratch rather than from the accumulated delay.
const HEALTHY_MS = 15000
const KEPT_STDERR_LINES = 40

let writer = null
let zenohUp = false
let restartMs = RESTART_MS
let lastFailure = ""

function pythonCmd() {
    return (ctx && ctx.python) || "python3"
}

// The bridge shares the desktop's stdout/stderr, so an inherited stderr from a
// crash-looping helper writes straight into the service log forever. Report each
// distinct failure once and swallow the repeats.
function reportFailure(text) {
    const failure = text.trim()
    if (!failure) {
        return
    }
    if (failure !== lastFailure) {
        lastFailure = failure
        console.error(`teleop: zenoh bridge failed\n${failure}`)
    }
    dimApp.send("status", { zenoh: false, error: failure.split("\n").pop() })
}

async function run() {
    const startedAt = Date.now()
    let child
    try {
        child = new Deno.Command(pythonCmd(), {
            args: [BRIDGE],
            cwd: (ctx && ctx.dimosDir) || undefined,
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
        }).spawn()
    } catch (error) {
        reportFailure(`cannot start ${pythonCmd()}: ${error.message}`)
        restartMs = Math.min(restartMs * 2, MAX_RESTART_MS)
        setTimeout(run, restartMs)
        return
    }

    const stderrTail = []
    const stderrLines = child.stderr.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream())
    const stderrDone = (async () => {
        for await (const line of stderrLines) {
            stderrTail.push(line)
            if (stderrTail.length > KEPT_STDERR_LINES) {
                stderrTail.shift()
            }
        }
    })()

    writer = child.stdin.getWriter()

    const lines = child.stdout.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream())
    ;(async () => {
        for await (const line of lines) {
            let msg
            try {
                msg = JSON.parse(line)
            } catch {
                continue // stray log line from a library — ignore
            }
            if (!msg || typeof msg !== "object" || !msg.type) continue
            if (msg.type === "frame") {
                dimApp.send("frame", { w: msg.w, h: msg.h, b64: msg.b64 })
            } else if (msg.type === "status") {
                zenohUp = !!msg.zenoh
                dimApp.send("status", { zenoh: zenohUp })
            }
        }
    })()

    const status = await child.status
    await stderrDone
    try {
        writer?.releaseLock()
    } catch { /* already released */ }
    writer = null
    zenohUp = false
    if (Date.now() - startedAt >= HEALTHY_MS) {
        restartMs = RESTART_MS
        lastFailure = ""
    } else {
        restartMs = Math.min(restartMs * 2, MAX_RESTART_MS)
    }
    if (status.success) {
        dimApp.send("status", { zenoh: false })
    } else {
        reportFailure(stderrTail.join("\n"))
    }
    setTimeout(run, restartMs)
}
run()

async function toBridge(obj) {
    if (!writer) return
    try {
        await writer.write(new TextEncoder().encode(JSON.stringify(obj) + "\n"))
    } catch { /* helper is (re)starting — drop */ }
}

dimApp.onReceive((kind, payload) => {
    if (kind === "cmd_vel") {
        toBridge({ type: "cmd_vel", vx: +payload?.vx || 0, vy: +payload?.vy || 0, wz: +payload?.wz || 0 })
    } else if (kind === "stop") {
        toBridge({ type: "stop" })
    } else if (kind === "video") {
        // The page found (or lost) a cockpit relay. Passed straight through so the
        // helper can drop its color_image subscription while the relay carries video.
        toBridge({ type: "video", source: payload?.source === "relay" ? "relay" : "bridge" })
    } else if (kind === "hello") {
        dimApp.send("status", { zenoh: zenohUp, error: zenohUp ? "" : lastFailure.split("\n").pop() })
    }
})
