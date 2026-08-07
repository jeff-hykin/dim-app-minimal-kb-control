"""Zenoh <-> stdio bridge for the Teleop dim app.

Publishes teleop velocities as `tele_cmd_vel` (geometry_msgs.Twist) and
subscribes to `color_image` (sensor_msgs.Image), forwarding JPEG frames to the
Deno backend. Uses DimOS's own ZenohTransport, so the LCM wire encoding matches
the rest of the stack exactly.

Protocol: newline-delimited JSON on stdin/stdout.
  in : {"type":"cmd_vel","vx":f,"vy":f,"wz":f} | {"type":"stop"}
  out: {"type":"status","zenoh":true} | {"type":"frame","w":W,"h":H,"b64":"..."}
"""

from __future__ import annotations

import base64
import json
import sys
import threading
import time
from typing import Any

_protocol_out = sys.stdout
sys.stdout = sys.stderr

from dimos.core.transport import ZenohTransport
from dimos.msgs.geometry_msgs.Twist import Twist
from dimos.msgs.sensor_msgs.Image import Image

FRAME_HZ = 12.0
JPEG_QUALITY = 60
# DimOS namespaces every Zenoh key under this prefix (transport_factory.transport_topic)
ZENOH_NAMESPACE = "dimos"


_write_lock = threading.Lock()


def emit(message: dict[str, Any]) -> None:
    line = json.dumps(message)
    with _write_lock:
        _protocol_out.write(line + "\n")
        _protocol_out.flush()


def main() -> None:
    cmd_publisher = ZenohTransport(f"{ZENOH_NAMESPACE}/tele_cmd_vel", Twist)
    image_subscriber = ZenohTransport(f"{ZENOH_NAMESPACE}/color_image", Image)

    last_frame_at = [0.0]

    def on_image(image: Image) -> None:
        now = time.monotonic()
        if now - last_frame_at[0] < 1.0 / FRAME_HZ:
            return
        last_frame_at[0] = now
        try:
            jpeg = image.to_jpeg_bytes(quality=JPEG_QUALITY)
        except Exception as error:
            emit({"type": "log", "level": "error", "msg": f"jpeg encode failed: {error}"})
            return
        emit(
            {
                "type": "frame",
                "w": image.width,
                "h": image.height,
                "b64": base64.b64encode(jpeg).decode("ascii"),
            }
        )

    image_subscriber.subscribe(on_image)
    cmd_publisher.start()
    emit({"type": "status", "zenoh": True})

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        try:
            command = json.loads(raw_line)
        except json.JSONDecodeError:
            continue
        kind = command.get("type")
        if kind == "cmd_vel":
            twist = Twist(
                [float(command.get("vx", 0.0)), float(command.get("vy", 0.0)), 0.0],
                [0.0, 0.0, float(command.get("wz", 0.0))],
            )
            cmd_publisher.broadcast(None, twist)
        elif kind == "stop":
            cmd_publisher.broadcast(None, Twist.zero())

    cmd_publisher.stop()
    image_subscriber.stop()


if __name__ == "__main__":
    main()
