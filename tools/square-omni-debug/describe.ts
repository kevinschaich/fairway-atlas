/** Shared terminal output and plain-English decoding for the Omni debug console and emulator. */
import { UUID, CMD, parseNotification, clubCode, MPS_TO_MPH } from "../../src/game/square-omni.js";
import { clubs } from "../../src/game/engine.js";

export type GameClub = { name: string; abbr: string; type: string; loft: number };

// ─── Output helpers ──────────────────────────────────────────────────────────────────────────────

export const color = process.stdout.isTTY && !process.env.NO_COLOR;
export const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = paint("2"), bold = paint("1"), red = paint("31"), green = paint("32"), yellow = paint("33"), cyan = paint("36"), magenta = paint("35");

export const startedAt = performance.now();
export const clock = () => dim(`${((performance.now() - startedAt) / 1000).toFixed(3).padStart(8)}s`);
export const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");

/** One line per event: time, a direction/kind marker, the plain-English description, the raw bytes. */
export function say(marker: string, text: string, raw?: Uint8Array) {
  console.log(`${clock()}  ${marker}  ${text}${raw ? "   " + dim(`[${hex(raw)}]`) : ""}`);
}
export const info = (text: string) => say(dim("·"), text);
export const sent = (text: string, raw: Uint8Array) => say(cyan("→"), text, raw);
export const received = (text: string, raw: Uint8Array) => say(magenta("←"), text, raw);
export const warn = (text: string) => say(yellow("!"), yellow(text));
export const fail = (text: string) => say(red("✗"), red(text));

export const num = (v: number | undefined | null, dp = 1, unit = "") => (Number.isFinite(v) ? `${(v as number).toFixed(dp)}${unit}` : "—");
export const side = (deg: number) => (deg > 0 ? `${num(deg)}° right` : deg < 0 ? `${num(-deg)}° left` : "0.0°");

// ─── Decoding for display ────────────────────────────────────────────────────────────────────────

export const CHARACTERISTIC_NAMES: Record<string, string> = {
  [UUID.deviceId]: "serial number",
  [UUID.hardware]: "hardware version",
  [UUID.firmware]: "firmware versions",
  [UUID.command]: "command channel",
  [UUID.events]: "event channel",
};

export const CATEGORY: Record<number, string> = { 0: "driver", 1: "wood/hybrid", 2: "iron/wedge", 3: "putter" };

export const STATE_MEANING: Record<string, string> = {
  none: "no state yet",
  idle: "idle, detection off",
  initialising: "starting up",
  detecting: "looking for a ball",
  ready: "ball in position, ready to hit",
  shot: "shot in progress",
  done: "shot processed",
};

/** Club name for a (number, category) pair, via the same table the game uses. */
export function clubForCode(number: number, category: number): string {
  const match = (clubs as GameClub[]).find((c) => {
    const { code } = clubCode(c, "omni");
    return code[0] === number && code[1] === category;
  });
  return match ? match.name : "unknown club";
}

export function describeCommand(b: Uint8Array): string {
  const seq = `#${b[2]}`;
  switch (b[1]) {
    case CMD.query: return `Query device ${dim(seq)}`;
    case CMD.heartbeat: return `Heartbeat ${dim(seq)}`;
    case CMD.clubSelect:
      if (b[3] === 0x00 && b[4] === 0x63) return `Set handedness: ${bold(b[5] ? "left" : "right")} ${dim("(club code 00 63 — not a club)")} ${dim(seq)}`;
      return `Select club: ${bold(clubForCode(b[3], b[4]))} (code ${b[3]}/${b[4]}, category ${CATEGORY[b[4]] ?? `0x${b[4].toString(16)}`}), ${b[5] ? "left" : "right"}-handed ${dim(seq)}`;
    case 0x85: return `Alignment ${b[3] ? "confirm" : "start/cancel"} ${dim(seq)}`;
    case 0x88: return `Set display units: speed ${["m/s", "mph"][b[3]] ?? b[3]}, distance ${["metres", "yards/feet", "yards"][b[5] || b[4]] ?? `${b[4]}/${b[5]}`} ${dim(seq)}`;
    case 0x89: return `Set green speed: stimp ${8 + b[3]} ${dim(seq)}`;
    case 0x8a: return `Set carry adjustment: ${b[3] - 100 >= 0 ? "+" : ""}${b[3] - 100}% ${dim(`(raw ${b[3]})`)} ${dim(seq)}`;
    case 0x92: return `Get OS version ${dim(seq)}`;
    case CMD.detectBall: return `Ball detection ${b[3] === 1 ? bold("ON") : b[3] === 0 ? bold("OFF") : `mode ${b[3]}`}, ${b[4] === 0x11 ? "advanced" : "standard"} spin ${dim(seq)}`;
    case CMD.requestClubMetrics: return `Request club data for the last shot ${dim(seq)}`;
    default: return `Command 0x${b[1].toString(16)} ${dim(seq)}`;
  }
}

export function describeNotification(b: Uint8Array): string {
  const n = parseNotification(b);
  if (!n) return `Unrecognised or truncated frame (${b.length} bytes)`;
  switch (n.kind) {
    case "disconnect": return "Empty frame: the device is closing the link";
    case "query": return "Query reply";
    case "heartbeat": return `Heartbeat reply · device state: ${bold(n.state)} (${STATE_MEANING[n.state] ?? "unknown"}) ${dim(`· club category: ${CATEGORY[b[5]] ?? `0x${b[5]?.toString(16)}`} · bytes 4–5: ${hex(b.subarray(4, 6))}`)}`;
    case "battery": return `Battery ${bold(`${n.percent}%`)} · ${n.charging}`;
    case "clock": {
      // 0x71 carries the device clock as a big-endian u64 in bytes 1–8 (seconds since power-on unless set).
      let seconds = 0n;
      for (let i = 1; i < 9 && i < b.length; i++) seconds = (seconds << 8n) | BigInt(b[i]);
      return dim(`Clock tick · device clock ${seconds}s`);
    }
    case "sensor": {
      const ball = !n.detected ? "no ball" : n.ready ? green(bold("ball detected · READY")) : yellow("ball detected · settling");
      const pos = n.position && n.detected ? dim(` · position ${n.position.join(", ")}`) : "";
      return `Ball sensor · ${ball}${pos}`;
    }
    case "ball":
      return bold("BALL DATA") + ` · ${num(n.speed * MPS_TO_MPH, 1, " mph")} · launch ${num(n.launch, 1, "°")} · direction ${side(n.direction)}` +
        ` · spin ${n.totalSpin} rpm (back ${n.backspin}, side ${n.sideSpin}, axis ${num(n.spinAxis, 1, "°")} — device signs)`;
    case "club": {
      if (!n.mask) return bold("CLUB DATA") + " · nothing tracked (no club sticker seen, or a putt)";
      const parts = [
        n.clubSpeed != null && `club speed ${num(n.clubSpeed * MPS_TO_MPH, 1, " mph")}`,
        n.smash != null && `smash ${num(n.smash, 2)}`,
        n.path != null && `path ${num(n.path, 1, "°")}`,
        n.face != null && `face ${num(n.face, 1, "°")}`,
        n.attack != null && `attack ${num(n.attack, 1, "°")}`,
        n.loft != null && `dynamic loft ${num(n.loft, 1, "°")}`,
        n.impactH != null && `impact ${num(n.impactH, 1)}/${num(n.impactV, 1)} mm (raw, uncalibrated)`,
      ].filter(Boolean);
      return bold("CLUB DATA") + ` · ${parts.join(" · ")} ${dim(`mask 0x${n.mask.toString(16)}`)}`;
    }
    case "alignment": return `Alignment · aim ${num(n.aim, 2, "°")}`;
    default: return `Unknown message type 0x${b[1]?.toString(16)} (${b.length} bytes)`;
  }
}

