#!/usr/bin/env bun
/**
 * Square Golf Omni — debug console
 * ================================
 *
 * Connects to a Square Golf Omni over Bluetooth using the *same* session code the game runs in
 * Chrome (src/game/square-omni.js) — via a small Web Bluetooth adapter over noble — and prints every
 * event in plain English:
 *
 *   · scanning and connection lifecycle
 *   · every characteristic read and every command written to the device   (→)
 *   · every notification from the device, decoded, with its raw bytes     (←)
 *   · the status light exactly as the game's HUD would show it            (●)
 *   · shots, with every metric the Omni measured and what the game gets
 *
 * Usage (from the repo root):
 *
 *   bun run square-omni-debug                   putter selected, runs until Ctrl+C
 *   bun run square-omni-debug --club 7I         any game club: DR 3W 4H 4I–9I PW GW SW LW PT
 *   bun run square-omni-debug --left            left-handed
 *   bun run square-omni-debug --seconds 60      stop after 60 seconds
 *   bun run square-omni-debug --replay          no hardware: replay frames captured from a real Omni
 *   bun run square-omni-debug --verify-clubs    select every club code in turn and record what the Omni reports back
 *
 * While running: ↑ / ↓ switch clubs through the game's bag (↑ = longer, toward the driver), v runs the club
 * verification, q quits.
 *
 * macOS: the terminal app you run this from needs Bluetooth permission
 * (System Settings → Privacy & Security → Bluetooth), otherwise macOS kills the process the moment
 * it starts scanning. Never pair the Omni in the OS Bluetooth settings; it doesn't support pairing.
 */
import { parseArgs } from "node:util";
import {
  SquareOmni, UUID, CMD, parseNotification, lightFor, clubCode, commands, MPS_TO_MPH,
} from "../../src/game/square-omni.js";
import { clubs, bagOrder } from "../../src/game/engine.js";
import {
  type GameClub, dim, bold, red, green, yellow, cyan, magenta, hex, say, info, sent, received, warn, fail, num, side,
  CHARACTERISTIC_NAMES, clubForCode, describeCommand, describeNotification,
} from "./describe.ts";

// ─── Options ─────────────────────────────────────────────────────────────────────────────────────

const { values: opts } = parseArgs({
  args: Bun.argv.slice(2).filter((a) => a !== "--"),
  options: {
    club: { type: "string", default: "PT" },
    left: { type: "boolean", default: false },
    seconds: { type: "string" },
    replay: { type: "boolean", default: false },
    "verify-clubs": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (opts.help) {
  console.log(await Bun.file(import.meta.path).text().then((s) => s.split("*/")[0].replace(/^[\s\S]*?\/\*\*\n/, "").replace(/^ \* ?/gm, "")));
  process.exit(0);
}

const initialClub: GameClub | undefined = (clubs as GameClub[]).find((c) => c.abbr.toLowerCase() === opts.club!.toLowerCase());
if (!initialClub) {
  console.error(`Unknown club "${opts.club}". Choose one of: ${(clubs as GameClub[]).map((c) => c.abbr).join(" ")}`);
  process.exit(1);
}
// The game's bag, driver first, in the same order the game cycles through it.
const bag: GameClub[] = (bagOrder as number[]).map((i) => (clubs as GameClub[])[i]);
let club: GameClub = initialClub;
const handed = opts.left ? "left" : "right";
const stopAfterSeconds = opts.seconds ? Number(opts.seconds) : null;

// ─── Instrumentation: wrap the Web Bluetooth objects so every GATT operation is logged ────────────

const decodeText = (dv: DataView) => new TextDecoder().decode(dv).replace(/\0+$/, "");
let lastFrame: Uint8Array | null = null, lastFrameAt = 0;
let heartbeatWaiter: ((b: Uint8Array) => void) | null = null;

function onRawNotification(event: Event) {
  const dv = (event.target as any).value as DataView;
  const bytes = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
  const now = performance.now();
  const duplicate = lastFrame && bytes.length === lastFrame.length && bytes.every((v, i) => v === lastFrame![i]) && now - lastFrameAt < 1500;
  lastFrame = bytes; lastFrameAt = now;
  if (bytes[0] === 0x11 && bytes[1] === 0x03 && heartbeatWaiter) { const w = heartbeatWaiter; heartbeatWaiter = null; w(bytes); }
  if (duplicate) return received(dim("(repeat of the previous frame — the Omni sends some frames twice; ignored)"), bytes);
  received(describeNotification(bytes), bytes);
}

function wrapCharacteristic(ch: any, uuid: string) {
  const name = CHARACTERISTIC_NAMES[uuid] ?? uuid;
  if (uuid === UUID.events) ch.addEventListener("characteristicvaluechanged", onRawNotification);
  return new Proxy(ch, {
    get(target, prop) {
      if (prop === "readValue") return async () => {
        const dv: DataView = await target.readValue();
        info(`Read ${name}: ${bold(JSON.stringify(decodeText(dv)))}`);
        return dv;
      };
      if (prop === "writeValueWithResponse" || prop === "writeValue") return async (value: Uint8Array) => {
        sent(describeCommand(value), value);
        return target[prop](value);
      };
      if (prop === "startNotifications") return async () => {
        await target.startNotifications();
        info(`Subscribed to the ${name}`);
        return target;
      };
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

function wrapService(service: any) {
  return new Proxy(service, {
    get(target, prop) {
      if (prop === "getCharacteristic") return async (uuid: string) => wrapCharacteristic(await target.getCharacteristic(uuid), uuid);
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

function wrapDevice(device: any) {
  device.addEventListener("gattserverdisconnected", () => info("Bluetooth link closed"));
  const gatt = new Proxy(device.gatt, {
    get(target, prop) {
      if (prop === "connect") return async () => {
        info("Opening Bluetooth connection…");
        const server = await target.connect();
        info("Bluetooth connected");
        return new Proxy(server, {
          get(s, p) {
            if (p === "getPrimaryService") return async (uuid: string) => {
              const service = await s.getPrimaryService(uuid);
              info("Found the Square Golf service");
              return wrapService(service);
            };
            const v = Reflect.get(s, p, s);
            return typeof v === "function" ? v.bind(s) : v;
          },
        });
      };
      if (prop === "disconnect") return () => { info("Closing Bluetooth connection"); return target.disconnect(); };
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return new Proxy(device, {
    get(target, prop) {
      if (prop === "gatt") return gatt;
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

// ─── Finding the device ──────────────────────────────────────────────────────────────────────────

async function findOmni(): Promise<any> {
  if (opts.replay) {
    const { replayDevice } = await import("./replay.ts");
    info("Replay mode: using frames captured from a real Omni (no Bluetooth needed)");
    return replayDevice();
  }
  const { findDevice } = await import("./noble-adapter.ts");
  info("Scanning for a device named SquareGolf(…) for up to 20 s — make sure the Omni is on and nearby");
  try {
    return await findDevice("SquareGolf", 20_000, (d) => {
      // The Omni advertises company ID 0xFFFF followed by an ASCII model code, e.g. "0300A".
      const m = d.manufacturerData;
      const model = m && m.length > 2 ? new TextDecoder().decode(m.subarray(2)).replace(/[^\x20-\x7e]/g, "") : "";
      info(`Found ${bold(d.name)} · signal ${d.rssi} dBm${model ? ` · model code ${bold(model)}` : ""} ${dim(d.id)}`);
    });
  } catch (e: any) {
    fail(`No Omni found: ${e?.message ?? e}`);
    console.log(dim("  Is it switched on and within a few metres? Is another app (the Square app, the game in Chrome) connected to it?"));
    console.log(dim("  On macOS, check System Settings → Privacy & Security → Bluetooth for your terminal app."));
    process.exit(1);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────────────────────────

console.log(bold("Square Golf Omni — debug console"));
console.log(dim(`Club: ${club.name} · ${handed}-handed · ${stopAfterSeconds ? `stops after ${stopAfterSeconds}s` : "q or Ctrl+C to stop"}${process.stdin.isTTY ? " · ↑/↓ switch clubs" : ""}`));
console.log(dim(`Legend: ${cyan("→")} sent to device   ${magenta("←")} received from device   ● status light (as shown in the game)   · info\n`));

const omni = new SquareOmni({ getClub: () => club, handed });

let lastLink = "", lastLight = "";
omni.addEventListener("status", ({ detail: s }: any) => {
  if (s.link !== lastLink) {
    lastLink = s.link;
    const extra = s.link === "connected" ? ` · ${s.deviceName} · hw ${s.hardware || "?"} · lm fw ${s.firmware?.lm ?? "?"} · treated as ${s.profile === "omni" ? "Omni" : "original Square"}` : s.error ? ` · ${s.error}` : "";
    info(`Connection: ${bold(s.link)}${extra}`);
  }
  const { light, text } = lightFor(s, true);
  const key = `${light}|${text}`;
  if (key === lastLight) return;
  lastLight = key;
  const paintLight = light === "green" ? green : light === "yellow" ? yellow : red;
  say(paintLight("●"), paintLight(bold(light.toUpperCase().padEnd(6))) + " " + text);
});

omni.addEventListener("shot", ({ detail: { launchData: d, metrics: m, club: c } }: any) => {
  console.log("");
  say(green("◆"), green(bold(`SHOT #${omni.status.shots}`)) + dim("  (game conventions: + = right, sidespin + = curves right)"));
  const row = (label: string, value: string) => console.log(`${" ".repeat(13)}${label.padEnd(18)}${value}`);
  row("Ball speed", num(m.ballSpeedMph, 1, " mph"));
  row("Launch angle", num(m.launch, 1, "°"));
  row("Direction", side(m.direction));
  row("Total spin", `${m.totalSpin} rpm`);
  row("Backspin", `${m.backspin} rpm`);
  row("Sidespin", `${m.sideSpin} rpm`);
  row("Spin axis", num(m.spinAxis, 1, "°"));
  if (c && c.mask) {
    row("Club speed", num(m.clubSpeedMph, 1, " mph"));
    row("Smash factor", num(m.smash, 2));
    row("Club path", num(m.path, 1, "°"));
    row("Face angle", num(m.face, 1, "°"));
    row("Face to path", Number.isFinite(m.face) && Number.isFinite(m.path) ? num(m.face - m.path, 1, "°") : "—");
    row("Attack angle", num(m.attack, 1, "°"));
    row("Dynamic loft", num(m.dynamicLoft, 1, "°"));
    row("Impact (raw)", `${num(m.impactH, 1)} / ${num(m.impactV, 1)} mm ${dim("(not sent to the game: uncalibrated)")}`);
  } else row("Club data", dim("not tracked"));
  console.log(dim(`${" ".repeat(13)}Sent to the game: ${JSON.stringify(d, (_, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v))}`));
  console.log("");
});

omni.addEventListener("discard", ({ detail: { metrics: m } }: any) =>
  warn(`Ignored a ${num(m.ballSpeedMph, 0)} mph shot that read zero spin with the ${club.name} selected (ball too far forward?). The game drops these too — re-hit.`));

let stopping = false;
async function stop(reason: string) {
  if (stopping) return;
  stopping = true;
  console.log("");
  info(`${reason} — switching ball detection off and disconnecting`);
  await omni.disconnect().catch(() => {});
  info(`Done. ${omni.status.shots} shot(s) received.`);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(0);
}
process.on("SIGINT", () => stop("Ctrl+C"));

// ─── Keyboard: ↑/↓ switch clubs ──────────────────────────────────────────────────────────────────
// The session code polls getClub() and sends ClubSelect when it changes; syncClub() sends it right away.
function switchClub(step: number) {
  const i = bag.indexOf(club), next = bag[Math.max(0, Math.min(bag.length - 1, i + step))];
  if (next === club) return info(dim(`Already at the ${step < 0 ? "longest" : "shortest"} club (${club.name})`));
  club = next;
  info(`Club → ${bold(club.name)}${club.type === "putter" ? " (the Omni's putting mode)" : ""}  ${dim(bag.map((c) => (c === club ? `[${c.abbr}]` : c.abbr)).join(" "))}`);
  if (omni.connected) omni.syncClub().catch((e: any) => fail(`Club select failed: ${e?.message ?? e}`));
}
// ─── Club verification ──────────────────────────────────────────────────────────────────────────
// Sends every club code, then a heartbeat, and records the heartbeat reply. The reply's bytes 4–5 are
// not documented anywhere; if they change with the club, the Omni is telling us what it selected.
// Also tries the codes where our two sources disagree (driver 01 00 vs 02 00) and the original
// Square's putter code, as controls.
let verifying = false;
async function verifyClubs() {
  if (verifying || !omni.connected) return;
  verifying = true;
  const p = omni.status.profile, seq = () => omni.nextSeq();
  const candidates: { label: string; code: [number, number] }[] = [
    ...bag.map((c) => ({ label: c.name, code: clubCode(c, "omni").code as [number, number] })),
    { label: "Driver, alt code (brentyates rule)", code: [2, 0] },
    { label: "Putter, original-Square code", code: [1, 7] },
  ];
  console.log("");
  info(bold(`Club verification: ${candidates.length} codes, ~1.5 s each. Keep the ball off the mat.`));
  const rows: string[] = [];
  for (const { label, code } of candidates) {
    if (stopping || !omni.connected) { verifying = false; return; }
    await omni.send(commands.clubSelect(seq(), code, handed, p));
    await new Promise((r) => setTimeout(r, 600));
    const reply = new Promise<Uint8Array | null>((resolve) => {
      heartbeatWaiter = resolve;
      setTimeout(() => { if (heartbeatWaiter === resolve) { heartbeatWaiter = null; resolve(null); } }, 2000);
    });
    await omni.send(commands.heartbeat(seq(), p));
    const ack = await reply;
    const code2 = code.map((x) => x.toString(16).padStart(2, "0")).join(" ");
    rows.push(`${label.padEnd(36)}sent ${code2}   →   reply bytes 3–8: ${ack ? hex(ack.subarray(3, 9)) : "no reply"}`);
  }
  await omni.syncClub(true); // put the device back on the club you had selected
  console.log("");
  info(bold("Club verification results") + dim("  (byte 3 = device state; watch whether bytes 4–5 track the code sent)"));
  for (const r of rows) console.log(`${" ".repeat(13)}${r}`);
  console.log("");
  verifying = false;
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (buf: Buffer) => {
    const key = buf.toString();
    if (key === "\u001b[A" || key === "k") switchClub(-1);
    else if (key === "\u001b[B" || key === "j") switchClub(+1);
    else if (key === "v") verifyClubs();
    else if (key === "q" || key === "\u0003") stop(key === "q" ? "q pressed" : "Ctrl+C"); // raw mode swallows SIGINT
  });
}
if (opts.replay && !stopAfterSeconds && !opts["verify-clubs"]) setTimeout(() => stop("Replay finished"), 10_000);
if (stopAfterSeconds) setTimeout(() => stop(`${stopAfterSeconds}s elapsed`), stopAfterSeconds * 1000);

const device = await findOmni();
try {
  await omni.attach(wrapDevice(device));
} catch (e: any) {
  fail(`Could not set up the session: ${e?.message ?? e}`);
  process.exit(1);
}
info(`Armed with the ${bold(club.name)}. ${club.type === "putter" ? "Putter selected = the Omni's putting mode. " : ""}Place a ball in the hitting zone.`);
if (opts["verify-clubs"]) { await verifyClubs(); await stop("Club verification finished"); }
