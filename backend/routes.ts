// Every Teleop action, as an endpoint (http.ts). The UI calls these; so can Desktop's agent.
//
// The backend owns the commanded velocity; open Teleop pages publish it. zenoh-web is WebRTC (a browser transport), so
// the page that holds the bridge connection puts `tele_cmd_vel` on its 100 ms tick, from the command this server
// pushes on `api/events/ws`, and a zero Twist the moment that command ends (plus the bridge's deadman if the page
// dies). Pages report their link here (`internal/page`), so a move with no page able to publish answers 409 instead of
// silently doing nothing, and the camera frame comes from a page too (`internal/frame/{id}`).
import { HttpError, publishEvent, type Route } from "./http.ts"

export const DESCRIPTION =
    "Teleop: drive the robot by publishing velocity commands on tele_cmd_vel (geometry_msgs.Twist), and see its color_image camera"

export const CMD_KEY = "dimos/tele_cmd_vel/geometry_msgs.Twist"
export const IMAGE_KEY = "dimos/color_image/sensor_msgs.Image"

export const LIMIT_RANGES = { linear: [0.05, 1.5], angular: [0.1, 3] } as const
const MAX_DURATION_MS = 10_000
const PAGE_STALE_MS = 5_000
const FRAME_TIMEOUT_MS = 3_000

type Limits = { linear: number; angular: number }
type Command = {
    vx: number
    vy: number
    wz: number
    durationMs: number
    source: string
    dryRun: boolean
    /** Date.now() when it was given */
    at: number
}
type Page = { zenoh: string; publisher: string; video: boolean; seen: number }

const dataDir = Deno.env.get("DIMOS_APP_DATA")
const limitsFile = dataDir ? `${dataDir}/limits.json` : null

function loadLimits(): Limits {
    try {
        if (limitsFile) {
            const saved = JSON.parse(Deno.readTextFileSync(limitsFile))
            return { linear: Number(saved.linear) || 0.5, angular: Number(saved.angular) || 1 }
        }
    } catch {
        // first run
    }
    return { linear: 0.5, angular: 1 }
}

let limits = loadLimits()
/** the velocity pages publish now (null = stopped) */
let command: Command | null = null
/** the newest move, dry runs included, for the readout */
let lastCommand: Command | null = null
let expiry: number | undefined
const pages = new Map<string, Page>()
const frameWaiters = new Map<string, (frame: { dataUrl: string; width: number; height: number }) => void>()

function livePages(): Page[] {
    const now = Date.now()
    return [...pages.values()].filter((page) => now - page.seen < PAGE_STALE_MS)
}

function remainingMs(c: Command | null): number {
    return c ? Math.max(0, c.at + c.durationMs - Date.now()) : 0
}

function commandView(c: Command | null) {
    return c &&
        {
            vx: c.vx,
            vy: c.vy,
            wz: c.wz,
            durationMs: c.durationMs,
            remainingMs: remainingMs(c),
            source: c.source,
            dryRun: c.dryRun,
        }
}

export function state() {
    const live = livePages()
    return {
        limits,
        command: remainingMs(command) > 0 ? commandView(command) : null,
        lastCommand: commandView(lastCommand),
        pages: live.length,
        publishers: live.filter((page) => page.publisher === "open").length,
        video: live.some((page) => page.video),
        keys: { command: CMD_KEY, image: IMAGE_KEY },
    }
}

function changed() {
    publishEvent({ type: "state", ...state() })
}

function number(value: unknown, name: string, fallback: number): number {
    if (value === undefined || value === null || value === "") {
        return fallback
    }
    const n = Number(value)
    if (!Number.isFinite(n)) {
        throw new HttpError(400, `${name} must be a number`)
    }
    return n
}

const clamp = (value: number, max: number) => Math.max(-max, Math.min(max, value))
const truthy = (value: unknown) => value === true || value === "true" || value === 1 || value === "1"

export function stop(source = "agent") {
    clearTimeout(expiry)
    const wasMoving = command !== null
    command = null
    changed()
    return { stopped: true, wasMoving, source }
}

export const routes: Route[] = [
    {
        method: "GET",
        path: "api/state",
        description:
            "Teleop's state: speed limits, the velocity being published now (with time left), the last move (dry runs too), and how many open pages can publish / show video",
        role: "context",
        handler: () => state(),
    },
    {
        method: "POST",
        path: "api/move",
        description:
            "Drive: publish a velocity on tele_cmd_vel for durationMs, then stop. vx forward (+) / back (m/s), vy strafe left (+) / right, wz turn left (+) / right (rad/s); each is clamped to the speed limits. dryRun validates and shows it in the UI without moving the robot. Needs an open Teleop page (it holds the zenoh-web link); else 409",
        params: {
            vx: { type: "number", description: "forward velocity, m/s (default 0)" },
            vy: { type: "number", description: "strafe velocity, m/s, + = left (default 0)" },
            wz: { type: "number", description: "turn rate, rad/s, + = left (default 0)" },
            durationMs: { type: "number", description: `how long, 1-${MAX_DURATION_MS} ms (default 1000)` },
            dryRun: { type: "boolean", description: "true: don't publish, only report what would be sent" },
            source: { type: "string", description: 'who is driving, shown in the UI (default "agent")' },
        },
        handler: (args) => {
            const durationMs = number(args.durationMs, "durationMs", 1000)
            if (durationMs < 1 || durationMs > MAX_DURATION_MS) {
                throw new HttpError(400, `durationMs must be 1-${MAX_DURATION_MS}`)
            }
            const want = { vx: number(args.vx, "vx", 0), vy: number(args.vy, "vy", 0), wz: number(args.wz, "wz", 0) }
            const next: Command = {
                vx: clamp(want.vx, limits.linear),
                vy: clamp(want.vy, limits.linear),
                wz: clamp(want.wz, limits.angular),
                durationMs,
                source: typeof args.source === "string" && args.source ? args.source : "agent",
                dryRun: truthy(args.dryRun),
                at: Date.now(),
            }
            const clamped = next.vx !== want.vx || next.vy !== want.vy || next.wz !== want.wz
            if (!next.dryRun) {
                if (state().publishers === 0) {
                    throw new HttpError(
                        409,
                        "no Teleop page can publish right now (open Teleop in Desktop; it needs the zenoh-web bridge)",
                    )
                }
                clearTimeout(expiry)
                command = next
                expiry = setTimeout(() => {
                    command = null
                    changed()
                }, durationMs)
            }
            lastCommand = next
            changed()
            return { command: commandView(next), clamped, published: !next.dryRun, key: CMD_KEY }
        },
    },
    {
        method: "POST",
        path: "api/stop",
        description: "Stop now: publish a zero Twist on tele_cmd_vel (always safe to call)",
        params: { source: { type: "string", description: 'who stopped it (default "agent")' } },
        handler: ({ source }) => stop(typeof source === "string" && source ? source : "agent"),
    },
    {
        method: "PUT",
        path: "api/limits",
        description: `Set the speed limits every move is clamped to: linear ${
            LIMIT_RANGES.linear.join("-")
        } m/s, angular ${LIMIT_RANGES.angular.join("-")} rad/s (the UI's sliders)`,
        params: {
            linear: { type: "number", description: "max |vx| and |vy|, m/s" },
            angular: { type: "number", description: "max |wz|, rad/s" },
        },
        handler: async (args) => {
            const next = { ...limits }
            for (const name of ["linear", "angular"] as const) {
                if (args[name] === undefined) {
                    continue
                }
                const value = number(args[name], name, 0)
                const [low, high] = LIMIT_RANGES[name]
                if (value < low || value > high) {
                    throw new HttpError(400, `${name} must be ${low}-${high}`)
                }
                next[name] = Math.round(value * 100) / 100
            }
            limits = next
            if (limitsFile) {
                await Deno.writeTextFile(limitsFile, JSON.stringify(limits))
            }
            changed()
            return { limits }
        },
    },
    {
        method: "GET",
        path: "api/camera",
        description:
            "The robot's current color_image camera frame as a JPEG (taken from an open Teleop page's video); 503 when no page shows video",
        role: "view",
        handler: async () => {
            if (!livePages().some((page) => page.video)) {
                throw new HttpError(503, "no camera video: no open Teleop page is receiving color_image")
            }
            const id = crypto.randomUUID()
            const frame = await new Promise<{ dataUrl: string; width: number; height: number } | null>((resolve) => {
                const timer = setTimeout(() => {
                    frameWaiters.delete(id)
                    resolve(null)
                }, FRAME_TIMEOUT_MS)
                frameWaiters.set(id, (frame) => {
                    clearTimeout(timer)
                    resolve(frame)
                })
                publishEvent({ type: "capture", id })
            })
            if (!frame) {
                throw new HttpError(503, "no page answered with a camera frame in time")
            }
            const [, mimeType, data] = frame.dataUrl.match(/^data:([^;]+);base64,(.*)$/) ?? []
            return { mimeType, data, width: frame.width, height: frame.height, key: IMAGE_KEY }
        },
    },
]

/** capture requests no page has answered yet (tests play the page with these) */
export const pendingCaptureIds = () => [...frameWaiters.keys()]

/** The page's own reports (not agent actions, so not in agent.json): its link state, and camera frames asked for. */
export async function handleInternal(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname.replace(/^\/+/, "")
    if (request.method !== "POST" || !path.startsWith("internal/")) {
        return null
    }
    let body: Record<string, unknown>
    try {
        body = await request.json()
    } catch {
        return Response.json({ error: "the body isn't JSON" }, { status: 400 })
    }
    if (path === "internal/page") {
        if (typeof body.id !== "string") {
            return Response.json({ error: "id is required" }, { status: 400 })
        }
        const before = JSON.stringify(state())
        pages.set(body.id, {
            zenoh: String(body.zenoh ?? "unknown"),
            publisher: String(body.publisher ?? "none"),
            video: body.video === true,
            seen: Date.now(),
        })
        if (body.closed === true) {
            pages.delete(body.id)
        }
        if (JSON.stringify(state()) !== before) {
            changed()
        }
        return Response.json({ ok: true })
    }
    const frameId = path.match(/^internal\/frame\/([\w-]+)$/)?.[1]
    if (frameId) {
        const waiter = frameWaiters.get(frameId)
        if (!waiter || typeof body.dataUrl !== "string") {
            return Response.json({ error: "no such capture request, or no dataUrl" }, { status: 404 })
        }
        frameWaiters.delete(frameId)
        waiter({ dataUrl: body.dataUrl, width: Number(body.width), height: Number(body.height) })
        return Response.json({ ok: true })
    }
    return Response.json({ error: `no such endpoint: POST /${path}` }, { status: 404 })
}
