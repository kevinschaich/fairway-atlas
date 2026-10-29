/**
 * A stand-in for a Web Bluetooth device that plays back frames captured from real Omni hardware,
 * so the debug console (and the game's session code) can be exercised with no device nearby.
 *
 * Sources: a real Omni SquareGolf(1574), hw 3.1, lm fw 1.5.8 (idle/heartbeat/battery/clock/query),
 * plus divotmaker/allsquare's captured frames from the same firmware (ball in position, a 1.59 m/s
 * putt, and the "nothing tracked" club reply). Like the real device, some frames are sent twice.
 */
import { UUID, CMD } from "../../src/game/square-omni.js";

const bytes = (s: string) => Uint8Array.from(s.replace(/\s/g, "").match(/../g)!, (h) => parseInt(h, 16));
const text = (s: string) => new TextEncoder().encode(s);

export function replayDevice() {
  const device: any = new EventTarget();
  device.name = "SquareGolf(1574)";
  device.id = "replay";
  let counter = 0, state = 3, detecting = false, awaitingClub = false;
  const timers: ReturnType<typeof setTimeout>[] = [];

  const events: any = new EventTarget();
  events.startNotifications = async () => events;
  const emit = (hexOrBytes: string | Uint8Array, twice = false) => {
    const b = typeof hexOrBytes === "string" ? bytes(hexOrBytes) : hexOrBytes;
    const send = () => { events.value = new DataView(b.buffer.slice(0)); events.dispatchEvent(new Event("characteristicvaluechanged")); };
    send();
    if (twice) setTimeout(send, 15);
  };
  // 0x11-family frames carry a device-side counter in byte 2 (except ball/club frames).
  const counted = (type: number, rest: string) => { counter = (counter + 1) & 255; return bytes(`11${type.toString(16).padStart(2, "0")}${counter.toString(16).padStart(2, "0")}${rest}`); };
  const sensor = (ready: number, detected: number) =>
    counted(0x01, `${ready.toString(16).padStart(2, "0")}${detected.toString(16).padStart(2, "0")}` + (detected ? "b8220000a4fbffff36ffffff" : "000000000000000000000000"));

  const command: any = {
    async writeValueWithResponse(v: Uint8Array) {
      await new Promise((r) => setTimeout(r, 20));
      switch (v[1]) {
        case CMD.query: emit("1106000100"); break;
        case CMD.heartbeat: emit(counted(0x03, `${state.toString(16).padStart(2, "0")}0303000000`)); break;
        case CMD.requestClubMetrics: if (awaitingClub) { awaitingClub = false; emit("110700ffffffffffffffffffffffffffffffff", true); state = 6; } break;
        case CMD.detectBall:
          if (v[3] === 1 && !detecting) { detecting = true; script(); }
          if (v[3] === 0) { detecting = false; timers.forEach(clearTimeout); state = 1; }
          break;
      }
    },
  };

  function script() {
    const at = (s: number, f: () => void) => timers.push(setTimeout(f, s * 1000));
    at(0.0, () => emit("7100000000000000fd"));
    at(1.0, () => emit(sensor(0, 0)));
    at(1.6, () => emit("915b01"));
    at(2.5, () => emit("710000000000000100"));
    at(3.0, () => { emit(sensor(0, 1)); });                       // ball set down, still settling
    at(4.0, () => { state = 4; emit(sensor(1, 1), true); });      // ready — this one arrives twice
    at(6.0, () => { state = 5; awaitingClub = true; emit("1102379f004800dcff0000000000000000", true); }); // the putt
    at(7.5, () => { state = 3; emit(sensor(0, 0)); });
    at(8.0, () => emit("710000000000000108"));
  }

  const chars: Record<string, any> = {
    [UUID.command]: command,
    [UUID.events]: events,
    [UUID.deviceId]: { readValue: async () => new DataView(text("3c00105da2848851990").buffer) },
    [UUID.hardware]: { readValue: async () => new DataView(text("3.1").buffer) },
    [UUID.firmware]: { readValue: async () => new DataView(text('{"launcher": "1.0.1", "mmi": "1.4.0", "lm": "1.5.8"}').buffer) },
  };
  const service = { getCharacteristic: async (uuid: string) => chars[uuid] };
  device.gatt = {
    connected: false,
    async connect() { await new Promise((r) => setTimeout(r, 300)); device.gatt.connected = true; return { getPrimaryService: async () => service }; },
    disconnect() { timers.forEach(clearTimeout); device.gatt.connected = false; device.dispatchEvent(new Event("gattserverdisconnected")); },
  };
  return device;
}
