# dim-app-minimal-kb-control (Teleop)

A [dimOS Desktop](https://github.com/jeff-hykin/dimos-desktop) app for **driving a robot over Zenoh**: it publishes
`tele_cmd_vel` (a `geometry_msgs.Twist`) from the keyboard / on-screen keys and shows the robot's `color_image` camera.

- **Drive**: `W`/`S` forward/back (`linear.x`), `A`/`D` turn (`angular.z`), `Q`/`E` strafe (`linear.y`), `Space` stop
  (DimOS's `cmd_vel` convention). Linear/angular speed limits are adjustable.
- **See**: live `color_image`, as H.264 video.
- Follows Desktop's light/dark theme.

```sh
dimos-desktop install https://github.com/jeff-hykin/dim-app-minimal-kb-control
```

## Endpoints

Every action is an HTTP endpoint (`backend/routes.ts`, served as `agent.json` and listed in `dimos.yaml`), so Desktop's
agent drives Teleop exactly like the keyboard does:

| endpoint         | what                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `GET api/state`  | limits, the velocity being published (time left), the last move, pages able to publish      |
| `POST api/move`  | `vx`, `vy`, `wz`, `durationMs`, `dryRun`: publish a clamped velocity for a while, then stop |
| `POST api/stop`  | zero Twist now                                                                              |
| `PUT api/limits` | `linear`, `angular` speed limits                                                            |
| `GET api/camera` | the current camera frame as a JPEG (`role: view`)                                           |

## How it works

The Deno backend owns the commanded velocity. zenoh-web is a WebRTC bridge, so the open Teleop page (connected to
Desktop's same-origin `/zenoh-web`) publishes that command on `tele_cmd_vel` every 100 ms, a zero Twist the moment it
ends, and arms the bridge's **deadman** (a zero Twist if the page stops heartbeating for 2 s). Pages report their link
to the backend, so `api/move` answers 409 when no page can publish, and `api/camera` asks a page for its video frame.

## Development

```sh
deno task test && deno task check     # backend tests (dry runs, no robot), dimos.yaml ↔ routes check
cd frontend && npm install && npm run typecheck && npm run build
deno task dev                         # backend on :8787; `npm run dev` in frontend proxies api/ to it
nix build .#dimosApp                  # what Desktop builds: bin/dimos-app-server
```

Licensed under the Apache License, Version 2.0.
