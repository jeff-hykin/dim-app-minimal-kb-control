// Teleop page: shows the robot's color_image and drives it with WASD. W/S = forward/back (linear.x), A/D = turn
// (angular.z), Q/E = strafe (linear.y), Space = stop (DimOS's cmd_vel convention). Every action goes through the
// backend's endpoints (api.ts); the backend's current command comes back on api/events/ws and this page publishes it
// on tele_cmd_vel through Desktop's zenoh-web bridge (zenoh.ts), so the agent and the keyboard drive the same way.
import { useCallback, useEffect, useRef, useState } from "react"
import { call, events } from "./api.ts"
import { Icon } from "./Icon.tsx"
import { useZenoh } from "./zenoh.ts"

export type CommandView = {
    vx: number
    vy: number
    wz: number
    durationMs: number
    remainingMs: number
    source: string
    dryRun: boolean
}
export type State = {
    limits: { linear: number; angular: number }
    command: CommandView | null
    lastCommand: CommandView | null
    pages: number
    publishers: number
    video: boolean
}

const CONTROL_KEYS = new Set(["w", "a", "s", "d", "q", "e", "arrowup", "arrowdown", "arrowleft", "arrowright", " "])
const PAD: { key: string; label: string; hint: string; icon?: string }[] = [
    { key: "q", label: "Q", hint: "strafe", icon: "chevron-left" },
    { key: "w", label: "W", hint: "fwd" },
    { key: "e", label: "E", hint: "strafe", icon: "chevron-right" },
    { key: "a", label: "A", hint: "turn", icon: "chevron-left" },
    { key: "s", label: "S", hint: "back" },
    { key: "d", label: "D", hint: "turn", icon: "chevron-right" },
]
/** a held key re-sends its move this often, each lasting KEY_MOVE_MS (so a lost release stops by itself) */
const KEY_REPEAT_MS = 200
const KEY_MOVE_MS = 500

function direction(keys: Set<string>) {
    const has = (...names: string[]) => (names.some((name) => keys.has(name)) ? 1 : 0)
    return {
        forward: has("w", "arrowup") - has("s", "arrowdown"),
        turn: has("a", "arrowleft") - has("d", "arrowright"),
        strafe: has("q") - has("e"),
    }
}

export function App() {
    const [state, setState] = useState<State | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [held, setHeld] = useState<Set<string>>(new Set())
    const [dryShown, setDryShown] = useState(false)
    const keysRef = useRef(new Set<string>())
    const limitsRef = useRef({ linear: 0.5, angular: 1 })
    const videoRef = useRef<HTMLVideoElement>(null)
    const zenoh = useZenoh(videoRef)
    const link = zenoh.link

    const show = useCallback((next: State) => {
        setState(next)
        limitsRef.current = next.limits
        link.follow(next.command)
        const last = next.lastCommand
        if (last?.dryRun && last.remainingMs > 0) {
            setDryShown(true)
            setTimeout(() => setDryShown(false), last.remainingMs)
        }
    }, [link])

    useEffect(() => {
        call<State>("GET", "api/state").then(show, (e) => setError(e.message))
        return events((event) => {
            if (event.type === "state") {
                show(event as unknown as State)
            } else if (event.type === "capture") {
                link.sendFrame(String(event.id))
            }
        })
    }, [show, link])

    const act = useCallback((promise: Promise<unknown>) => {
        promise.then(() => setError(null), (e) => setError(e.message))
    }, [])
    const stopNow = useCallback(() => {
        keysRef.current.clear()
        setHeld(new Set())
        act(call("POST", "api/stop", { source: "keyboard" }))
    }, [act])

    // held keys → a move, re-sent while held; letting go of everything → stop
    const sendKeys = useCallback(() => {
        const { forward, turn, strafe } = direction(keysRef.current)
        if (forward === 0 && turn === 0 && strafe === 0) {
            return false
        }
        const { linear, angular } = limitsRef.current
        act(call("POST", "api/move", {
            vx: forward * linear,
            vy: strafe * linear,
            wz: turn * angular,
            durationMs: KEY_MOVE_MS,
            source: "keyboard",
        }))
        return true
    }, [act])
    const press = useCallback((key: string) => {
        if (!keysRef.current.has(key)) {
            keysRef.current.add(key)
            setHeld(new Set(keysRef.current))
            sendKeys()
        }
    }, [sendKeys])
    const release = useCallback((key: string) => {
        if (keysRef.current.delete(key)) {
            setHeld(new Set(keysRef.current))
            if (!sendKeys()) {
                act(call("POST", "api/stop", { source: "keyboard" }))
            }
        }
    }, [sendKeys, act])

    useEffect(() => {
        const timer = setInterval(sendKeys, KEY_REPEAT_MS)
        const down = (event: KeyboardEvent) => {
            const key = event.key.toLowerCase()
            if (!CONTROL_KEYS.has(key) || (event.target as HTMLElement)?.tagName === "INPUT") {
                return
            }
            event.preventDefault()
            if (event.repeat) {
                return
            }
            key === " " ? stopNow() : press(key)
        }
        const up = (event: KeyboardEvent) => {
            const key = event.key.toLowerCase()
            if (CONTROL_KEYS.has(key)) {
                release(key)
            }
        }
        const blur = () => keysRef.current.size && stopNow()
        addEventListener("keydown", down)
        addEventListener("keyup", up)
        addEventListener("blur", blur)
        return () => {
            clearInterval(timer)
            removeEventListener("keydown", down)
            removeEventListener("keyup", up)
            removeEventListener("blur", blur)
        }
    }, [sendKeys, press, release, stopNow])

    const setLimit = (name: "linear" | "angular", value: number) => {
        limitsRef.current = { ...limitsRef.current, [name]: value }
        setState((s) => s && { ...s, limits: limitsRef.current })
        act(call("PUT", "api/limits", { [name]: value }))
    }

    const shown = state?.command ?? (dryShown ? state?.lastCommand : null) ?? null
    const dry = !state?.command && dryShown
    const last = state?.lastCommand
    return (
        <>
            <div id="stage">
                <video
                    id="cam"
                    ref={videoRef}
                    muted
                    playsInline
                    autoPlay
                    style={{ display: zenoh.video ? "block" : "none" }}
                />
                {!zenoh.video && (
                    <div id="placeholder">
                        <div className="big">
                            Waiting for <code>color_image</code>
                        </div>
                        Start a DimOS stack publishing a camera.
                    </div>
                )}
            </div>

            <div className="topbar">
                <svg
                    className="brand"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <line x1="6" y1="11" x2="10" y2="11" />
                    <line x1="8" y1="9" x2="8" y2="13" />
                    <line x1="15" y1="13" x2="15" y2="13" />
                    <line x1="18" y1="10" x2="18" y2="10" />
                    <path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.544-.604-6.584-.685-7.258-.007-.05-.011-.101-.017-.151A4 4 0 0 0 17.32 5z" />
                </svg>
                <span className="title">Teleop</span>
                <span className="sub">tele_cmd_vel &nbsp;·&nbsp; color_image</span>
                <span className="spacer" />
                <span className={`dim-badge dim-mono${zenoh.live ? " ok" : ""}`} id="status">
                    <span className="dot" />
                    <span>{zenoh.statusText}</span>
                </span>
            </div>

            <div className="keyhint">
                click the view, then use <kbd>W</kbd>
                <kbd>A</kbd>
                <kbd>S</kbd>
                <kbd>D</kbd> · <kbd>Q</kbd>
                <kbd>E</kbd> strafe · <kbd>Space</kbd> stop
            </div>

            <div className="dock dim-panel glass">
                <div className="pad" id="pad">
                    {PAD.map(({ key, label, hint, icon }) => (
                        <div
                            key={key}
                            className={`key${held.has(key) ? " active" : ""}`}
                            onPointerDown={(event) => {
                                event.preventDefault()
                                event.currentTarget.setPointerCapture(event.pointerId)
                                press(key)
                            }}
                            onPointerUp={() => release(key)}
                            onPointerCancel={() => release(key)}
                        >
                            {label}
                            <small>
                                {hint} {icon && <Icon name={icon} />}
                            </small>
                        </div>
                    ))}
                    <div className="key wide" onPointerDown={(event) => (event.preventDefault(), stopNow())}>
                        SPACE · stop
                    </div>
                </div>
                <div className="side">
                    <div className="readout">
                        {([["vx m/s", shown?.vx], ["vy m/s", shown?.vy], ["ωz r/s", shown?.wz]] as const).map((
                            [label, value],
                        ) => (
                            <div key={label} className={`cell${dry ? " dry" : ""}`}>
                                <b>{label}</b>
                                <span>{(value ?? 0).toFixed(2)}</span>
                            </div>
                        ))}
                    </div>
                    <div className="lastmove" id="lastmove">
                        {last && (
                            <>
                                last: {last.source} · {last.vx.toFixed(2)}, {last.vy.toFixed(2)}, {last.wz.toFixed(2)} ·
                                {" "}
                                {last.durationMs} ms
                                {last.dryRun && <span className="dim-badge warn">dry run</span>}
                            </>
                        )}
                    </div>
                    <div className="sliders">
                        <label className="dim-label">
                            Linear
                            <input
                                className="dim-range"
                                type="range"
                                min="0.05"
                                max="1.5"
                                step="0.05"
                                value={state?.limits.linear ?? 0.5}
                                onChange={(event) => setLimit("linear", Number(event.target.value))}
                            />
                            <span className="val">{(state?.limits.linear ?? 0.5).toFixed(2)}</span>
                        </label>
                        <label className="dim-label">
                            Angular
                            <input
                                className="dim-range"
                                type="range"
                                min="0.1"
                                max="3"
                                step="0.1"
                                value={state?.limits.angular ?? 1}
                                onChange={(event) => setLimit("angular", Number(event.target.value))}
                            />
                            <span className="val">{(state?.limits.angular ?? 1).toFixed(2)}</span>
                        </label>
                    </div>
                    <button type="button" className="dim-btn danger icon" onClick={stopNow}>
                        <Icon name="stop" />
                        Stop
                    </button>
                    {error && <div className="dim-alert danger">{error}</div>}
                </div>
            </div>
        </>
    )
}
