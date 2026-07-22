# dim-teleop

A [DimOS dashboard](https://github.com/jeff-hykin/dim-app) app for **driving a
robot over Zenoh**. It publishes `tele_cmd_vel` (a `geometry_msgs.Twist`) from a
virtual joystick / keyboard and shows the robot's `color_image` camera stream.

- **Drive** — **WASD**: `W`/`S` forward/back (`linear.x`), `A`/`D` turn
  (`angular.z`), `Q`/`E` strafe (`linear.y`), `Space` to stop — the DimOS
  `cmd_vel` convention. On-screen keys mirror the keyboard and are also
  click/touch-holdable. Linear/angular speed caps are adjustable. Velocities are
  re-sent on a fixed tick while held, and a zero `Twist` is sent the instant you
  let go.
- **See** — live `color_image` frames, JPEG-relayed off Zenoh.
- Follows the desktop's light/dark theme.

## How it works

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

> Note: the camera decode assumes `color_image` is a raw `sensor_msgs.Image` over
> Zenoh (the default). A JPEG-transport variant of that stream won't decode.

## Install

```bash
dim install https://github.com/jeff-hykin/dim-teleop
```

Licensed under the Apache License, Version 2.0.
