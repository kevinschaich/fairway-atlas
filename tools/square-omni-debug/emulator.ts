#!/usr/bin/env bun
/**
 * Square Golf Omni — emulator
 * ===========================
 *
 * Makes this Mac pretend to be a Square Golf Omni over Bluetooth, so the official Square Golf app
 * (on your phone) connects to it, and prints every command the app sends in plain English. The main
 * use: switch clubs in the app and read the exact club codes it sends, to settle the codes the game uses.
 *
 * It answers like your real unit, SquareGolf(1574): serial, hardware 3.1, firmware lm 1.5.8, and the
 * same query / heartbeat / sensor / clock / battery frames captured from it. It can also fake a ball
 * being placed and a shot, so the app has something to show.
 *
 * Usage (from the repo root):
 *
 *   bun run square-omni-emulator                     advertise as SquareGolf(1574), runs until q / Ctrl+C
 *   bun run square-omni-emulator --name "SquareGolf(ABCD)"
 *   bun run square-omni-emulator --name-only         advertise only the name, not the service ID
 *
 * While running:
 *   b  place / remove a ball      p  fake putt      s  fake full shot with the club the app selected
 *   q  quit (prints a summary of every club code and setting the app sent)
 *
 * Before you start: switch the real Omni OFF (the app would connect to it instead), and give your
 * terminal app Bluetooth permission (System Settings → Privacy & Security → Bluetooth).
 *
 * Limitation: macOS only lets a program advertise a name and service IDs, not manufacturer data. The
 * real Omni also advertises the model code "0300A" there; if the app filters on it, it won't list this
 * Mac, and the emulator needs hardware that can advertise it (a Raspberry Pi or an ESP32).
 */
import { parseArgs } from "node:util";
import { UUID, CMD } from "../../src/game/square-omni.js";
import {
  dim, bold, green, yellow, cyan, magenta, hex, say, info, warn, fail,
  CATEGORY, clubForCode, describeCommand, describeNotification,
} from "./describe.ts";

const { values: opts } = parseArgs({
  args: Bun.argv.slice(2).filter((a) => a !== "--"),
  options: {
    name: { type: "string", default: "SquareGolf(1574)" },
    "name-only": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});
if (opts.help) {
  console.log(await Bun.file(import.meta.path).text().then((s) => s.split("*/")[0].replace(/^[\s\S]*?\/\*\*\n/, "").replace(/^ \* ?/gm, "")));
  process.exit(0);
}

const { default: bleno } = await import("@stoprocent/bleno");
const short = (uuid: string) => uuid.replace(/-/g, "").toLowerCase();

// Log markers from the emulator's point of view.
const fromApp = (text: string, raw?: Uint8Array) => say(magenta("←"), text, raw);
const toApp = (text: string, raw: Uint8Array) => say(cyan("→"), text, raw);

// ─── Device identity (captured from a real Omni) ───────────────────────────────────────────────

const SERIAL = "3c00105da2848851990";
const HARDWARE = "3.1";
const FIRMWARE = '{"launcher": "1.0.1", "mmi": "1.4.0", "lm": "1.5.8"}';
const BALL_POSITION = [0xb8, 0x22, 0x00, 0x00, 0xa4, 0xfb, 0xff, 0xff, 0x36, 0xff, 0xff, 0xff]; // captured, ball in place

// ─── Emulated device state ──────────────────────────────────────────────────────────────────────

const bootedAt = Date.now() - 253_000; // the real unit's clock read 253 s at connect
let counter = 0;                  // 0x11-family message counter (byte 2)
let state = 1;                    // 1 idle, 3 detecting, 4 ready, 5 shot, 6 done
let category = 0;                 // echoed in heartbeat byte 5; the real unit starts at 00
let clubNumber = 0;
let detecting = false;
let ball: "none" | "settling" | "ready" = "none";
let pendingClubFrame: Uint8Array | null = null;
let clubRequestTimer: ReturnType<typeof setTimeout> | null = null;
let notifyApp: ((data: Buffer) => void) | null = null;

const summary = { clubCodes: new Map<string, number>(), settings: new Map<string, string>(), reads: new Map<string, number>(), unknownWrites: 0 };

const counted = (type: number, rest: number[]) => { counter = (counter + 1) & 255; return Uint8Array.from([0x11, type, counter, ...rest]); };
const i16 = (v: number) => { const x = Math.round(v) & 0xffff; return [x & 0xff, x >> 8]; };
const u64be = (n: number) => { const out: number[] = []; let v = BigInt(Math.max(0, Math.floor(n))); for (let i = 0; i < 8; i++) { out.unshift(Number(v & 0xffn)); v >>= 8n; } return out; };

function send(frame: Uint8Array, quiet = false) {
  if (!notifyApp) return;
  notifyApp(Buffer.from(frame));
  if (!quiet) toApp(describeNotification(frame), frame);
}

const heartbeatAck = () => counted(0x03, [state, 0x03, category, 0, 0, 0]);
const sensorFrame = () => counted(0x01, [ball === "ready" ? 1 : 0, ball === "none" ? 0 : 1, ...(ball === "none" ? new Array(12).fill(0) : BALL_POSITION)]);
const clockFrame = () => Uint8Array.from([0x71, ...u64be((Date.now() - bootedAt) / 1000)]);
const batteryFrame = () => Uint8Array.from([0x91, 91, 1]);

// Ball frame in the device's own units and signs (m/s ×100, degrees ×100, RPM; sidespin/axis negative = curves right).
function ballFrame(mph: number, launch: number, direction: number, totalSpin: number, axisRight: number) {
  const axis = -axisRight, back = totalSpin * Math.cos((axis * Math.PI) / 180), side = totalSpin * Math.sin((axis * Math.PI) / 180);
  return Uint8Array.from([0x11, 0x02, 0x37, ...i16((mph / 2.2369363) * 100), ...i16(launch * 100), ...i16(direction * 100), ...i16(totalSpin), ...i16(axis * 100), ...i16(back), ...i16(side)]);
}
function clubFrame(p: { path: number; face: number; attack: number; loft: number; impactH: number; impactV: number; mph: number; smash: number }) {
  return Uint8Array.from([0x11, 0x07, 0xff, ...[p.path, p.face, p.attack, p.loft, p.impactH, p.impactV, p.mph / 2.2369363, p.smash].flatMap((v) => i16(v * 100))]);
}
const UNTRACKED_CLUB = Uint8Array.from([0x11, 0x07, 0x00, ...new Array(16).fill(0xff)]);

// Plausible full shots per category (driver, wood/hybrid, iron/wedge) — a slight fade.
const FULL_SHOTS: Record<number, { ball: [number, number, number, number, number]; club: Parameters<typeof clubFrame>[0] }> = {
  0: { ball: [150, 11.5, 1.0, 2650, 3], club: { path: -1.5, face: 0.8, attack: 2.5, loft: 13.5, impactH: 3, impactV: 4, mph: 102, smash: 1.47 } },
  1: { ball: [138, 12.5, 0.8, 3700, 3], club: { path: -1.2, face: 0.6, attack: -0.5, loft: 16, impactH: 2, impactV: -3, mph: 96, smash: 1.44 } },
  2: { ball: [118, 16.5, 0.6, 6800, 2.5], club: { path: -1.0, face: 0.5, attack: -4.2, loft: 22, impactH: 1, impactV: -2, mph: 88, smash: 1.34 } },
};

// ─── Handling commands from the app ─────────────────────────────────────────────────────────────

function handleCommand(b: Uint8Array) {
  fromApp(`App: ${describeCommand(b)}`, b);
  const reply = (frame: Uint8Array, delay = 25) => setTimeout(() => send(frame), delay);
  switch (b[1]) {
    case CMD.query: reply(Uint8Array.from([0x11, 0x06, 0x00, 0x01, 0x00])); break;
    case CMD.heartbeat: reply(heartbeatAck()); break;
    case CMD.clubSelect: {
      const key = `${b[3].toString(16).padStart(2, "0")} ${b[4].toString(16).padStart(2, "0")}`;
      if (b[3] === 0x00 && b[4] === 0x63) { summary.settings.set("handedness", b[5] ? "left" : "right"); break; }
      summary.clubCodes.set(key, (summary.clubCodes.get(key) ?? 0) + 1);
      clubNumber = b[3];
      category = b[4] > 3 ? b[4] - 4 : b[4]; // the real unit folded the original Square's categories (e.g. 07 → 03)
      summary.settings.set("handedness", b[5] ? "left" : "right");
      info(`Club now: ${bold(clubForCode(clubNumber, category))} ${dim(`(category ${CATEGORY[category] ?? category})`)}`);
      break;
    }
    case CMD.detectBall:
      detecting = b[3] === 1;
      state = detecting ? (ball === "ready" ? 4 : 3) : 1;
      info(`Ball detection is now ${bold(detecting ? "ON" : "OFF")}${b[4] === 0x11 ? " (advanced spin)" : b[4] === 0x10 ? " (standard spin)" : ""}`);
      if (detecting) setTimeout(() => send(sensorFrame()), 300);
      break;
    case CMD.requestClubMetrics: {
      if (clubRequestTimer) { clearTimeout(clubRequestTimer); clubRequestTimer = null; }
      const frame = pendingClubFrame ?? UNTRACKED_CLUB;
      pendingClubFrame = null;
      reply(frame);
      setTimeout(() => { state = 6; setTimeout(() => { state = detecting ? 3 : 1; }, 1000); }, 50);
      break;
    }
    case 0x88: summary.settings.set("display units", describeCommand(b).replace(/^Set display units: /, "").replace(/\s*\S*#\d+.*$/, "")); break;
    case 0x89: summary.settings.set("green speed", `stimp ${8 + b[3]}`); break;
    case 0x8a: summary.settings.set("carry adjustment", `${b[3] - 100}%`); break;
    default: summary.unknownWrites++; warn(`Unrecognised command 0x${b[1].toString(16)} — logged, not answered`);
  }
}

// ─── GATT service (same layout as the real Omni) ────────────────────────────────────────────────

const { Characteristic, PrimaryService } = bleno as any;
const OK = Characteristic.RESULT_SUCCESS;
const NAMES: Record<string, string> = { "2001": "serial number", "2002": "hardware version", "2003": "firmware versions", "2004": "clock" };

function readable(id: string, value: () => Uint8Array, properties: string[] = ["read"]) {
  return new Characteristic({
    uuid: short(`8660${id}-6b7e-439a-bdd1-489a3213e9bb`),
    properties,
    onReadRequest(_h: unknown, offset: number, cb: (r: number, d?: Buffer) => void) {
      const data = Buffer.from(value());
      if (offset === 0) {
        summary.reads.set(NAMES[id], (summary.reads.get(NAMES[id]) ?? 0) + 1);
        fromApp(`App read the ${NAMES[id]} → ${bold(JSON.stringify(new TextDecoder().decode(data).replace(/[^\x20-\x7e]/g, "·")))}`);
      }
      cb(OK, data.subarray(offset));
    },
    onWriteRequest: properties.includes("write") ? (_h: unknown, data: Buffer, _o: number, _w: boolean, cb: (r: number) => void) => {
      fromApp(`App set the ${NAMES[id]}: ${Number(data.readBigUInt64LE(0))} s`, data);
      cb(OK);
    } : undefined,
  });
}

function writeOnly(id: string, label: string, properties: string[]) {
  return new Characteristic({
    uuid: short(`8660${id}-6b7e-439a-bdd1-489a3213e9bb`),
    properties,
    onWriteRequest(_h: unknown, data: Buffer, _o: number, _w: boolean, cb: (r: number) => void) {
      summary.unknownWrites++;
      fromApp(yellow(`App wrote to ${label} (${id}) — logged only, never acted on`), Uint8Array.from(data));
      cb(OK);
    },
  });
}

const enc = (s: string) => new TextEncoder().encode(s);
const service = new PrimaryService({
  uuid: short(UUID.service),
  characteristics: [
    readable("2001", () => enc(SERIAL)),
    readable("2002", () => enc(HARDWARE)),
    readable("2003", () => enc(FIRMWARE)),
    readable("2004", () => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(Math.floor((Date.now() - bootedAt) / 1000))); return b; }, ["read", "write"]),
    new Characteristic({
      uuid: short(UUID.command),
      properties: ["write"],
      onWriteRequest(_h: unknown, data: Buffer, _o: number, _w: boolean, cb: (r: number) => void) {
        cb(OK);
        handleCommand(Uint8Array.from(data));
      },
    }),
    new Characteristic({
      uuid: short(UUID.events),
      properties: ["read", "notify"],
      onReadRequest(_h: unknown, _o: number, cb: (r: number, d?: Buffer) => void) { cb(OK, Buffer.alloc(0)); },
      onSubscribe(_h: unknown, maxValueSize: number, update: (d: Buffer) => void) {
        notifyApp = update;
        info(green(`App subscribed to device events`) + dim(` (max ${maxValueSize} bytes per message)`));
      },
      onUnsubscribe() { notifyApp = null; info("App unsubscribed from device events"); },
    }),
    writeOnly("2201", "the firmware-update channel", ["write"]),
    writeOnly("2202", "an unknown channel", ["write"]),
    writeOnly("8001", "an unknown channel", ["writeWithoutResponse"]),
  ],
});

// ─── Background traffic, like the real unit ────────────────────────────────────────────────────

setInterval(() => send(clockFrame(), true), 3000);                                          // clock tick every ~3 s (not printed)
setInterval(() => { if (detecting && ball !== "ready") send(sensorFrame(), true); }, 3000); // idle sensor frames (not printed)
setInterval(() => send(batteryFrame(), true), 15000);                                       // battery (not printed)

// ─── Keyboard ───────────────────────────────────────────────────────────────────────────────────

function toggleBall() {
  if (!notifyApp) return warn("No app connected yet");
  if (ball !== "none") { ball = "none"; state = detecting ? 3 : 1; info("Ball removed"); send(sensorFrame()); return; }
  if (!detecting) warn("The app hasn't switched ball detection on — the real unit wouldn't report the ball");
  ball = "settling"; info("Ball placed"); send(sensorFrame());
  setTimeout(() => { if (ball === "settling") { ball = "ready"; if (detecting) state = 4; send(sensorFrame()); } }, 1000);
}

function fakeShot(kind: "putt" | "full") {
  if (!notifyApp) return warn("No app connected yet");
  if (!detecting) return warn("The app hasn't switched ball detection on — the real unit wouldn't send a shot");
  if (ball !== "ready") warn("No ball in position (press b first) — sending the shot anyway");
  state = 5; ball = "none";
  let frame: Uint8Array;
  if (kind === "putt" || category === 3) {
    frame = Uint8Array.from([0x11, 0x02, 0x37, 0x9f, 0x00, 0x48, 0x00, 0xdc, 0xff, 0, 0, 0, 0, 0, 0, 0, 0]); // captured 1.59 m/s putt
    pendingClubFrame = UNTRACKED_CLUB;
  } else {
    const s = FULL_SHOTS[category] ?? FULL_SHOTS[2];
    frame = ballFrame(...s.ball);
    pendingClubFrame = clubFrame(s.club);
  }
  info(bold(`Fake ${kind === "putt" || category === 3 ? "putt" : `${CATEGORY[category]} shot`}`));
  send(frame);
  clubRequestTimer = setTimeout(() => { clubRequestTimer = null; warn("The app didn't ask for club data within 3 s"); }, 3000);
}

async function quit() {
  console.log("");
  info(bold("Summary of what the app sent"));
  const codes = [...summary.clubCodes.entries()];
  console.log(`${" ".repeat(13)}Club codes:   ${codes.length ? "" : dim("none — change clubs in the app")}`);
  for (const [code, n] of codes) {
    const [num, cat] = code.split(" ").map((x) => parseInt(x, 16));
    console.log(`${" ".repeat(15)}${bold(code)}  ${clubForCode(num, cat > 3 ? cat - 4 : cat).padEnd(16)} ${dim(`category ${CATEGORY[cat > 3 ? cat - 4 : cat] ?? cat} · sent ${n}×`)}`);
  }
  for (const [k, v] of summary.settings) console.log(`${" ".repeat(13)}${k.padEnd(14)}${v}`);
  console.log(`${" ".repeat(13)}Reads:        ${[...summary.reads.entries()].map(([k, n]) => `${k} ×${n}`).join(", ") || dim("none")}`);
  if (summary.unknownWrites) console.log(`${" ".repeat(13)}${yellow(`${summary.unknownWrites} unrecognised write(s) — see the log above`)}`);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  await bleno.stopAdvertisingAsync().catch(() => {});
  bleno.stop?.();
  process.exit(0);
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (buf: Buffer) => {
    const key = buf.toString();
    if (key === "b") toggleBall();
    else if (key === "p") fakeShot("putt");
    else if (key === "s") fakeShot("full");
    else if (key === "q" || key === "\u0003") quit();
  });
}
process.on("SIGINT", quit);

// ─── Start advertising ──────────────────────────────────────────────────────────────────────────

console.log(bold("Square Golf Omni — emulator"));
console.log(dim(`Advertising as ${opts.name} · b ball · p putt · s shot · q quit`));
console.log(dim(`Legend: ${magenta("←")} from the app   ${cyan("→")} sent to the app   · info   (clock, battery and idle sensor frames are sent but not printed)\n`));

bleno.on("stateChange", (s: string) => info(`Bluetooth adapter: ${s}`));
bleno.on("accept", (address: string) => info(green(bold(`App connected`)) + dim(` ${address ?? ""}`)));
bleno.on("disconnect", (address: string) => { notifyApp = null; detecting = false; state = 1; info(yellow(`App disconnected`) + dim(` ${address ?? ""}`)); });
bleno.on("mtuChange", (mtu: number) => info(dim(`Negotiated MTU ${mtu}`)));

try {
  await bleno.waitForPoweredOnAsync(10_000);
} catch {
  fail(`Bluetooth adapter not ready (state: ${bleno.state}). "unauthorized" means your terminal app lacks Bluetooth permission.`);
  process.exit(1);
}
try {
  await bleno.setServicesAsync([service]);
  info("Square Golf service published (same characteristics as the real Omni)");
  await bleno.startAdvertisingAsync(opts.name!, opts["name-only"] ? [] : [short(UUID.service)]);
  info(`Advertising as ${bold(opts.name!)}${opts["name-only"] ? "" : " with the Square Golf service ID"}. Open the Square Golf app on your phone and connect.`);
} catch (e: any) {
  fail(`Could not start the emulator: ${e?.message ?? e}`);
  process.exit(1);
}
