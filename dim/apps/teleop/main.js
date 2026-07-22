// Teleop — backend half (runs in the DimOS desktop's Deno process).
//
// Zenoh (peer mode, usrpwd auth, LCM encoding) has no good native Deno client,
// so — like go2_dash shelling out to its Rust helper — we run a tiny Python
// helper (zenoh_bridge.py) via the desktop-provided interpreter (ctx.python).
// The helper uses DimOS's own ZenohTransport, so the machine-id password and
// wire format match the rest of the stack. We relay newline-JSON over stdio:
// teleop velocities down to the helper, decoded camera frames back up to the
// browser panel.

import { TextLineStream } from "https://deno.land/std@0.224.0/streams/text_line_stream.ts"
import { DimAppBackend, dimContext } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.3.0/backend.js"

const dimApp = new DimAppBackend()
const ctx = dimContext()

const BRIDGE = new URL("./zenoh_bridge.py", import.meta.url).pathname
const RESTART_MS = 3000

let writer = null
let zenohUp = false

function pythonCmd() {
    return (ctx && ctx.python) || "python3"
}

async function run() {
    let child
    try {
        child = new Deno.Command(pythonCmd(), {
            args: [BRIDGE],
            cwd: (ctx && ctx.dimosDir) || undefined,
            stdin: "piped",
            stdout: "piped",
            stderr: "inherit",
        }).spawn()
    } catch {
        setTimeout(run, RESTART_MS)
        return
    }

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

    await child.status
    try {
        writer?.releaseLock()
    } catch { /* already released */ }
    writer = null
    zenohUp = false
    dimApp.send("status", { zenoh: false })
    setTimeout(run, RESTART_MS)
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
    } else if (kind === "hello") {
        dimApp.send("status", { zenoh: zenohUp })
    }
})
