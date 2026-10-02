# dim-app-minimal-kb-control

A [dimOS Desktop](https://github.com/jeff-hykin/dimos-desktop) app for **driving a
robot over Zenoh**. It publishes `tele_cmd_vel` (a `geometry_msgs.Twist`) from a
virtual joystick / keyboard and shows the robot's `color_image` camera stream.

- **Drive** — **WASD**: `W`/`S` forward/back (`linear.x`), `A`/`D` turn
  (`angular.z`), `Q`/`E` strafe (`linear.y`), `Space` to stop — the DimOS
  `cmd_vel` convention. On-screen keys mirror the keyboard and are also
  click/touch-holdable. Linear/angular speed caps are adjustable. Velocities are
  re-sent on a fixed tick while held, and a zero `Twist` is sent the instant you
  let go.
- **See** — live `color_image`, as H.264 video.
- Follows the desktop's light/dark theme.

## dimOS Desktop

```sh
dimos-desktop install https://github.com/jeff-hykin/dim-app-minimal-kb-control --ref dimos-desktop2
```

## How it works

The page is the whole app. It talks to the running stack through Desktop's
[zenoh-web](https://github.com/jeff-hykin/zenoh-web) bridge (`connect(new URL("../../zenoh-web", location.href).href)`, i.e. Desktop's same-origin `/zenoh-web`):

- **Video** — subscribes to `dimos/color_image/sensor_msgs.Image` with the bridge's `dimos-image`
  codec, which turns it into an H.264 track for a `<video>` element.
- **Velocities** — publishes LCM-encoded `Twist`s (via [`@dimos/msgs`](https://jsr.io/@dimos/msgs))
  to `dimos/tele_cmd_vel/geometry_msgs.Twist` at REAL_TIME priority, with a zero-`Twist` **deadman**:
  if the page stops heartbeating for 2 s (tab closed, network gone) the bridge publishes the stop
  itself. A tripped publisher is replaced by a freshly armed one.

No backend, no python helper, no build step.

Licensed under the Apache License, Version 2.0.
