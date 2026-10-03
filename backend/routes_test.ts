// No robot, no bridge: moves are dry runs, or go to a fake page (internal/page) that publishes nothing.
import { assert, assertEquals } from "@std/assert"
import { geometry_msgs } from "@dimos/msgs"
import { handle } from "./http.ts"
import { DESCRIPTION, handleInternal, pendingCaptureIds, routes, stop } from "./routes.ts"
import { encodeTwist } from "../frontend/src/twist.ts"

const request = (method: string, path: string, body?: unknown) =>
    new Request(`http://app/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) })
const call = async (method: string, path: string, body?: unknown) => {
    const response = (await handle(request(method, path, body), routes, DESCRIPTION)) ??
        (await handleInternal(request(method, path, body)))
    return { status: response!.status, json: await response!.json() }
}
const page = (extra: Record<string, unknown>) => call("POST", "internal/page", { id: "test-page", ...extra })

Deno.test("api/state reports limits and no command", async () => {
    const { status, json } = await call("GET", "api/state")
    assertEquals(status, 200)
    assertEquals(json.command, null)
    assert(json.limits.linear > 0)
    assertEquals((await call("GET", "api/stat")).status, 404)
})

Deno.test("api/move: a dry run is clamped and shown, never published", async () => {
    await call("PUT", "api/limits", { linear: 0.5, angular: 1 })
    const { status, json } = await call("POST", "api/move", { vx: 3, wz: -0.2, durationMs: 800, dryRun: true })
    assertEquals(status, 200)
    assertEquals(json.published, false)
    assertEquals(json.clamped, true)
    assertEquals([json.command.vx, json.command.vy, json.command.wz], [0.5, 0, -0.2])
    const state = (await call("GET", "api/state")).json
    assertEquals(state.command, null)
    assertEquals(state.lastCommand.dryRun, true)
    assertEquals((await call("POST", "api/move", { vx: "fast", dryRun: true })).status, 400)
    assertEquals((await call("POST", "api/move", { vx: 0.1, durationMs: 60_000, dryRun: true })).status, 400)
})

Deno.test("api/move without a page that can publish is 409; with one it becomes the command", async () => {
    assertEquals((await call("POST", "api/move", { vx: 0.1 })).status, 409)
    await page({ zenoh: "connected", publisher: "open" })
    const { status, json } = await call("POST", "api/move", { vx: 0.2, durationMs: 5000, source: "test" })
    assertEquals(status, 200)
    assertEquals(json.published, true)
    assertEquals((await call("GET", "api/state")).json.command.vx, 0.2)
    stop()
    await page({ closed: true })
})

Deno.test("api/stop clears the command", async () => {
    await page({ zenoh: "connected", publisher: "open" })
    await call("POST", "api/move", { vx: 0.2, durationMs: 5000 })
    const { json } = await call("POST", "api/stop", {})
    assertEquals(json, { stopped: true, wasMoving: true, source: "agent" })
    assertEquals((await call("GET", "api/state")).json.command, null)
    const bad = await handle(new Request("http://app/api/stop", { method: "POST", body: "{nope" }), routes, DESCRIPTION)
    assertEquals(bad!.status, 400)
    await page({ closed: true })
})

Deno.test("api/limits validates its ranges", async () => {
    assertEquals((await call("PUT", "api/limits", { linear: 1.2 })).json.limits.linear, 1.2)
    assertEquals((await call("PUT", "api/limits", { angular: 9 })).status, 400)
    assertEquals((await call("PUT", "api/limits", { linear: 0.5 })).json.limits, { linear: 0.5, angular: 1 })
})

Deno.test("api/camera: 503 without video; with a page it returns the page's frame", async () => {
    assertEquals((await call("GET", "api/camera")).status, 503)
    await page({ zenoh: "connected", publisher: "open", video: true })
    // the page answers the capture request it gets on api/events/ws; here the test is the page
    const pending = call("GET", "api/camera")
    await new Promise((resolve) => setTimeout(resolve, 10))
    assertEquals((await call("POST", "internal/frame/nope", { dataUrl: "data:image/jpeg;base64,AA==" })).status, 404)
    const [id] = pendingCaptureIds()
    await call("POST", `internal/frame/${id}`, { dataUrl: "data:image/jpeg;base64,/9j/AA==", width: 4, height: 3 })
    const { status, json } = await pending
    assertEquals(status, 200)
    assertEquals([json.mimeType, json.data, json.width], ["image/jpeg", "/9j/AA==", 4])
    await page({ closed: true })
})

Deno.test("internal/page needs an id", async () => {
    assertEquals((await call("POST", "internal/page", {})).status, 400)
})

Deno.test("the page's Twist encoding matches @dimos/msgs", () => {
    const V = geometry_msgs.Vector3
    const want = new geometry_msgs.Twist({
        linear: new V({ x: 0.3, y: -0.1, z: 0 }),
        angular: new V({ x: 0, y: 0, z: 1.5 }),
    })
    assertEquals(encodeTwist(0.3, -0.1, 1.5), want.encode())
})

Deno.test("agent.json lists every route", async () => {
    const { json } = await call("GET", "agent.json")
    assertEquals(json.endpoints.length, routes.length)
})
