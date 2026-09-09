# dim-app-minimal-kb-control

A [DimOS dashboard](https://github.com/jeff-hykin/dim-app) app for **driving a
robot over Zenoh**. It publishes `tele_cmd_vel` (a `geometry_msgs.Twist`) from a
virtual joystick / keyboard and shows the robot's `color_image` camera stream.

- **Drive** — **WASD**: `W`/`S` forward/back (`linear.x`), `A`/`D` turn
  (`angular.z`), `Q`/`E` strafe (`linear.y`), `Space` to stop — the DimOS
  `cmd_vel` convention. On-screen keys mirror the keyboard and are also
  click/touch-holdable. Linear/angular speed caps are adjustable. Velocities are
  re-sent on a fixed tick while held, and a zero `Twist` is sent the instant you
  let go.
- **See** — live `color_image` frames, off the cockpit relay when the stack has
  one, and off Zenoh otherwise.
- Follows the desktop's light/dark theme.

## How it works

### Video: the cockpit relay first

When the running stack is on a DimOS **cockpit relay**, the browser reads
`color_image` itself. The page asks the desktop where the relay is
(`GET /api/relay`), imports the relay's own zero-build SDK bundle
(`<relay>/sdk.js`, served with wildcard CORS), and does:

```js
const session = connect({ url: relayUrl })
session.subscribe("color_image", (snapshot) => { /* snapshot.slot.value is JPEG bytes */ })
```

The JPEG is encoded by the `RelayBridgeModule` **inside the stack**, rate-gated,
and only while some viewer is subscribed — so nothing decodes and re-encodes
images in a helper process, and a closed panel costs nothing. WebTransport needs
a secure context, which `http://127.0.0.1` is.

`tele_cmd_vel` still goes through the Zenoh helper below. The SDK's viewer half
is read-only by design; the tx path lives behind `@dimos/sdk/internal/teleop`,
which the `/sdk.js` bundle does not include (the SDK's vite config builds the
root entry only) and which upstream marks internal until W9. When it becomes
public the helper can be dropped entirely.

### Velocities, and video without a relay

Zenoh (peer mode, `usrpwd` auth, LCM-encoded payloads) has no native Deno
client, so — like `dim-go2-dash` shelling out to a Rust helper — the Deno backend
(`main.js`) runs a tiny Python helper (`zenoh_bridge.py`) through the
desktop-provided interpreter (`ctx.python`). The helper uses DimOS's own
`ZenohTransport`, so the **password defaults to the machine id**
(`global_config.zenoh_password`, overridable with `DIMOS_ZENOH_PASSWORD`) and the
wire format matches the rest of the stack. DimOS namespaces every Zenoh key under
`dimos/`, so the helper subscribes to `dimos/color_image` and publishes to
`dimos/tele_cmd_vel` — a bare `color_image` never matches. The two halves talk
newline-JSON over stdio: velocities down, camera frames up.

The helper only holds the `color_image` subscription while it is actually the
video source: the page sends `video`/`relay` once the relay path is live and the
helper tears the subscription down, so a relayed stack pays nothing for it.

> Note: this fallback decode assumes `color_image` is a raw `sensor_msgs.Image`
> over Zenoh (the default). A JPEG-transport variant of that stream won't decode.
> The relay path is unaffected.

## Install

```bash
dim install https://github.com/jeff-hykin/dim-app-minimal-kb-control
```

Licensed under the Apache License, Version 2.0.
