// geometry_msgs.Twist, LCM-encoded (what dimos's tele_cmd_vel carries): the type's 8-byte fingerprint, then
// linear.{x,y,z} and angular.{x,y,z} as big-endian f64. Matches @dimos/msgs (backend/routes_test.ts checks).
const FINGERPRINT = [0x2e, 0x7c, 0x07, 0xd7, 0xcd, 0xf7, 0xe0, 0x27]

export function encodeTwist(vx: number, vy: number, wz: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(8 + 6 * 8)
    bytes.set(FINGERPRINT)
    const view = new DataView(bytes.buffer)
    ;[vx, vy, 0, 0, 0, wz].forEach((value, index) => view.setFloat64(8 + index * 8, value, false))
    return bytes
}
