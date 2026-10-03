// This page's link to Desktop's zenoh-web bridge (../../zenoh-web): color_image arrives as an H.264 video track (the
// bridge's dimos-image codec), and the backend's current command is published on tele_cmd_vel every tick, with a
// zero-Twist deadman so the bridge stops the robot if this page goes away mid-drive. The page reports its link to the
// backend (internal/page), which is how `api/move` knows someone can publish and `api/camera` knows there is video.
import { type RefObject, useEffect, useRef, useState } from "react"
import { connect, type ConnectionState, Priority, type Publisher, type ZenohWeb } from "./vendor/zenoh_web/zenoh_web.ts"
import { encodeTwist } from "./twist.ts"
import type { CommandView } from "./App.tsx"

const CMD_KEY = "dimos/tele_cmd_vel/geometry_msgs.Twist"
const IMAGE_KEY = "dimos/color_image/sensor_msgs.Image"
const TICK_MS = 100
const REPORT_MS = 2000
const STOP = encodeTwist(0, 0, 0)

export type Link = {
    /** publish this command (from the backend) until it runs out; null = stop */
    follow(command: CommandView | null): void
    /** answer the backend's capture request with the current video frame */
    sendFrame(id: string): void
}

export function useZenoh(videoRef: RefObject<HTMLVideoElement | null>) {
    const [connection, setConnection] = useState<ConnectionState | "connecting">("connecting")
    const [publisherState, setPublisherState] = useState("none")
    const [video, setVideo] = useState(false)
    const pageId = useRef(crypto.randomUUID())
    const publisher = useRef<Publisher | null>(null)
    const command = useRef<{ vx: number; vy: number; wz: number; until: number } | null>(null)
    const lastNonZero = useRef(false)
    const report = useRef({ zenoh: "connecting", publisher: "none", video: false })

    const send = (bytes: Uint8Array<ArrayBuffer>) => {
        if (publisher.current?.state !== "open") {
            return
        }
        try {
            publisher.current.put(bytes)
        } catch {
            // tripped or closed: arm() replaces it
        }
    }
    const tick = () => {
        const c = command.current
        if (c && performance.now() < c.until && (c.vx || c.vy || c.wz)) {
            send(encodeTwist(c.vx, c.vy, c.wz)) // re-sent every tick while the command lasts
            lastNonZero.current = true
        } else if (lastNonZero.current) {
            send(STOP)
            lastNonZero.current = false
        }
    }

    const link = useRef<Link>({
        follow(next) {
            command.current = next && { ...next, until: performance.now() + next.remainingMs }
            tick()
        },
        sendFrame(id) {
            const element = videoRef.current
            if (!element || !element.videoWidth) {
                return
            }
            const canvas = document.createElement("canvas")
            canvas.width = element.videoWidth
            canvas.height = element.videoHeight
            canvas.getContext("2d")!.drawImage(element, 0, 0)
            fetch(`internal/frame/${id}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    dataUrl: canvas.toDataURL("image/jpeg", 0.85),
                    width: canvas.width,
                    height: canvas.height,
                }),
            }).catch(() => {})
        },
    }).current

    useEffect(() => {
        let zenoh: ZenohWeb | null = null
        let stopped = false
        const post = (extra: Record<string, unknown> = {}) =>
            fetch("internal/page", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ id: pageId.current, ...report.current, ...extra }),
                keepalive: true,
            }).catch(() => {})
        const update = (patch: Partial<typeof report.current>) => {
            report.current = { ...report.current, ...patch }
            post()
        }

        // The deadman publishes one zero Twist if this page stops heartbeating. Once it fires the publisher is spent
        // ("tripped"), so a fresh one is armed in its place.
        const arm = async () => {
            if (!zenoh || stopped) {
                return
            }
            const current = zenoh.publisher(CMD_KEY, {
                delivery: "latest",
                priority: Priority.REAL_TIME,
                latencyLimit: 300,
            })
            publisher.current = current
            current.onTripped(() => {
                setPublisherState("tripped")
                update({ publisher: "tripped" })
                setTimeout(() => publisher.current === current && arm(), 1000)
            })
            try {
                await current.ready()
                await current.setDeadman(STOP)
            } catch (error) {
                console.warn("teleop: tele_cmd_vel publisher not armed", error)
            }
            setPublisherState(current.state)
            update({ publisher: current.state })
        }

        const start = async () => {
            while (!zenoh && !stopped) {
                try {
                    // a missed heartbeat for 2 s (8 beats at 4 Hz) trips the deadman
                    zenoh = await connect(new URL("../../zenoh-web", location.href).href, {
                        heartbeatHz: 4,
                        heartbeatMisses: 8,
                    })
                } catch {
                    setConnection("lost")
                    update({ zenoh: "lost" })
                    await new Promise((resolve) => setTimeout(resolve, 3000))
                }
            }
            if (!zenoh) {
                return
            }
            setConnection("connected")
            update({ zenoh: "connected" })
            zenoh.onState((state) => {
                setConnection(state)
                update({ zenoh: state })
            })
            zenoh.subscribe(IMAGE_KEY, { delivery: "latest", maxHz: 20, codec: "dimos-image" }, (message) => {
                const element = videoRef.current
                if (message.mediaStream && element && element.srcObject !== message.mediaStream) {
                    element.srcObject = message.mediaStream
                    element.play().catch(() => {})
                }
                if (!report.current.video) {
                    setVideo(true)
                    update({ video: true })
                }
            })
            arm()
        }
        start()
        post()
        const ticker = setInterval(tick, TICK_MS)
        const reporter = setInterval(() => post(), REPORT_MS)
        const closed = () => post({ closed: true })
        addEventListener("pagehide", closed)
        return () => {
            stopped = true
            clearInterval(ticker)
            clearInterval(reporter)
            removeEventListener("pagehide", closed)
            closed()
            zenoh?.close?.()
        }
    }, [videoRef])

    const live = connection === "connected" && publisherState === "open"
    const statusText = live
        ? "zenoh-web"
        : connection === "connected"
        ? "arming…"
        : connection === "connecting"
        ? "connecting…"
        : "no bridge"
    return { link, video, live, statusText }
}
