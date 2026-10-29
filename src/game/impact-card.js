// Impact card: a clubface diagram showing where the ball met the face, plus every shot metric, stacked under the
// right-hand club/swing HUD card (#sidebar .hud-shot). Drawn face-on, as the ball sees it: for a right-hander the
// toe is on the left and the heel/hosel on the right. Updated once per shot by shot-panel.js.
//
// Where the impact point comes from, in order:
//  1. A measured impact the game actually used (manual shot-input dialog, club-delivery mode).
//  2. The Square Omni's raw reading. The game doesn't feed it to the physics (flighthook found a centred strike
//     reads off-centre, and no calibration is published), so it is drawn but labelled uncalibrated.
//  3. Nothing measured: the simulated swing assumes a centred strike, drawn as a hollow marker.
import { clubs } from "./engine.js";
import { hud, act } from "./hud.js";

// Approximate face dimensions (mm): width heel-to-toe along the grooves, height at the toe.
const FACE = {
  driver: { w: 118, h: 58 },
  wood: { w: 96, h: 40 },
  hybrid: { w: 86, h: 40 },
  iron: { w: 76, h: 48 },
  wedge: { w: 78, h: 54 },
  putter: { w: 104, h: 26 },
};
const HISTORY = 12;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (v, dp) => (Number.isFinite(v) ? v.toFixed(dp) : null);
const handed = () => {
  try {
    return localStorage.getItem("fairway-lm-handed") === "left" ? "left" : "right";
  } catch {
    return "right";
  }
};

// Face outline, centred on the sweet spot, in SVG units (1 unit = 1 mm; +x = screen right, +y = screen down).
// heel = +1 when the heel is on the right of the drawing (right-handed), -1 when on the left.
function facePath(type, { w, h }, heel) {
  const L = -w / 2,
    R = w / 2,
    T = -h / 2,
    B = h / 2,
    s = heel;
  if (type === "putter")
    return `M${L} ${T + 3}Q${L} ${T} ${L + 3} ${T}H${R - 3}Q${R} ${T} ${R} ${T + 3}V${B - 3}Q${R} ${B} ${R - 3} ${B}H${L + 3}Q${L} ${B} ${L} ${B - 3}Z`;
  if (type === "iron" || type === "wedge") {
    // Blade: low at the heel, rising to a rounded toe.
    const toe = (-s * w) / 2,
      hl = (s * w) / 2,
      heelTop = T + h * 0.34;
    return `M${hl} ${B - 4}Q${hl} ${B} ${hl - s * 5} ${B}L${toe + s * 10} ${B}Q${toe} ${B} ${toe} ${B - 9}L${toe} ${T + 12}Q${toe} ${T} ${toe + s * 14} ${T}L${hl - s * 4} ${heelTop}Q${hl} ${heelTop + 1} ${hl} ${heelTop + 5}Z`;
  }
  // Woods, hybrids, driver: rounded face, flatter at the sole, fuller crown at the toe.
  const rx = w * (type === "driver" ? 0.3 : 0.26),
    ry = h * 0.5;
  return `M${L + rx} ${T}H${R - rx}A${rx} ${ry} 0 0 1 ${R} ${T + ry}A${rx} ${ry * 0.9} 0 0 1 ${R - rx} ${B}H${L + rx}A${rx} ${ry * 0.9} 0 0 1 ${L} ${T + ry}A${rx} ${ry} 0 0 1 ${L + rx} ${T}Z`;
}
function grooves(type, { w, h }) {
  if (type === "putter") return `<line class="icSight" x1="0" y1="${-h / 2 + 4}" x2="0" y2="${h / 2 - 4}"/>`;
  const n = type === "driver" || type === "wood" || type === "hybrid" ? 0 : type === "wedge" ? 12 : 10,
    out = [];
  for (let i = 1; i <= n; i++) {
    const y = -h / 2 + h * (0.2 + (0.72 * i) / (n + 1));
    out.push(`<line class="icGroove" x1="${-w * 0.32}" y1="${y.toFixed(1)}" x2="${w * 0.32}" y2="${y.toFixed(1)}"/>`);
  }
  if (!n)
    for (const f of [-0.25, 0, 0.25])
      out.push(
        `<line class="icGroove" x1="${w * f}" y1="${-h * 0.28}" x2="${w * f}" y2="${h * 0.28}"/>`,
        `<line class="icGroove" x1="${-w * 0.3}" y1="${h * f * 0.9}" x2="${w * 0.3}" y2="${h * f * 0.9}"/>`,
      );
  return out.join("");
}
function hosel(type, { w, h }, heel) {
  const x = (heel * w) / 2,
    y = type === "iron" || type === "wedge" ? -h / 2 + h * 0.34 : type === "putter" ? -h / 2 : -h * 0.1;
  return type === "putter"
    ? `<path class="icHosel" d="M${x * 0.55} ${y + 4} l${heel * 5} -18" />`
    : `<path class="icHosel" d="M${x - heel * 2} ${y + 4} q${heel * 9} -6 ${heel * 12} -22" />`;
}

export function installImpactCard() {
  let open = true;
  try {
    open = localStorage.getItem("fairway-impact-card") !== "closed";
  } catch {}
  const card = (p) => hud.set((h) => ({ impact: { ...h.impact, ...p } }));
  card({ open });
  act.impactOpen = (o) => {
    card({ open: o });
    try {
      localStorage.setItem("fairway-impact-card", o ? "open" : "closed");
    } catch {}
  };
  // The Omni's raw reading arrives just before the game plays the shot (launch-monitor-panel.js).
  let pendingDevice = null;
  const history = [];
  addEventListener("fairway-launch-monitor-shot", (e) => {
    pendingDevice = { ...e.detail, at: performance.now() };
  });

  function draw(type, point, kind) {
    const f = FACE[type] || FACE.iron,
      heel = handed() === "left" ? -1 : 1,
      pad = 16,
      W = f.w + pad * 2,
      H = f.h + pad * 2 + 10;
    const viewBox = `${-W / 2} ${-H / 2 - 4} ${W} ${H}`;
    const clamp = (v, m) => Math.max(-m, Math.min(m, v));
    // Face-on view: target-right (+x) is the viewer's left.
    const dot = (p) => ({
      cx: clamp(-p.x, f.w / 2 + 6),
      cy: clamp(-p.y, f.h / 2 + 6),
      off: Math.abs(p.x) > f.w / 2 || Math.abs(p.y) > f.h / 2,
    });
    const past = history
      .slice(0, -1)
      .map((p) => {
        const d = dot(p);
        return `<circle class="icPast" cx="${d.cx.toFixed(1)}" cy="${d.cy.toFixed(1)}" r="2.4"/>`;
      })
      .join("");
    let mark = "";
    if (point) {
      const d = dot(point),
        cls = kind === "assumed" ? "icDot icAssumed" : "icDot";
      mark = `<circle class="icRing" cx="${d.cx.toFixed(1)}" cy="${d.cy.toFixed(1)}" r="4.2"/><circle class="${cls}" cx="${d.cx.toFixed(1)}" cy="${d.cy.toFixed(1)}" r="4.2"/>`;
    }
    return { viewBox, svg: `<defs><linearGradient id="icMetal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".16"/><stop offset=".55" stop-color="#ffffff" stop-opacity=".07"/><stop offset="1" stop-color="#ffffff" stop-opacity=".12"/></linearGradient><clipPath id="icClip"><path d="${facePath(type, f, heel)}"/></clipPath></defs>
   ${hosel(type, f, heel)}<path class="icFaceShape" d="${facePath(type, f, heel)}"/>
   <g clip-path="url(#icClip)">${grooves(type, f)}</g>
   <circle class="icSweet" r="${type === "putter" ? 5 : 8}"/><line class="icCross" x1="-3" x2="3"/><line class="icCross" y1="-3" y2="3"/>
   <text class="icSide" x="${-heel * (f.w / 2)}" y="${f.h / 2 + 12}" text-anchor="${heel > 0 ? "start" : "end"}">TOE</text><text class="icSide" x="${heel * (f.w / 2)}" y="${f.h / 2 + 12}" text-anchor="${heel > 0 ? "end" : "start"}">HEEL</text>
   ${past}${mark}` };
  }

  function update(shot, rows) {
    const club = clubs[shot?.input?.club],
      type = club?.type || "iron",
      s = shot?.stats || {};
    const clubText = club ? `${club.name}${club.loft != null ? ` · ${club.loft}°` : ""}` : "";
    const measured = s.source === "measured ball";
    // Device reading for this shot: same ball speed, within a few seconds.
    let device = null;
    if (
      shot &&
      measured &&
      pendingDevice &&
      performance.now() - pendingDevice.at < 5000 &&
      Math.abs((pendingDevice.launchData?.ballSpeed ?? -1) - s.ballSpeed) < 0.2
    )
      device = pendingDevice;
    pendingDevice = null;
    const source = !shot ? "" : device ? "Omni" : measured ? "Measured" : "Simulated",
      sourceKind = !shot ? "" : device || measured ? "measured" : "simulated";
    let point = null,
      kind = "none",
      text = "No shot yet",
      sub = "";
    const used = Array.isArray(s.measuredFields) && s.measuredFields.includes("impactPoint") && s.impactPoint;
    const m = device?.metrics;
    if (used) {
      point = s.impactPoint;
      kind = "measured";
    } else if (m && Number.isFinite(m.impactH) && Number.isFinite(m.impactV)) {
      point = { x: handed() === "left" ? m.impactH : -m.impactH, y: m.impactV };
      kind = "raw";
    } else if (shot) {
      point = { x: 0, y: 0 };
      kind = "assumed";
    }
    if (point && kind !== "assumed") {
      history.push(point);
      if (history.length > HISTORY) history.shift();
    }
    const face = draw(type, point, kind);
    if (point && kind !== "assumed") {
      const toe = point.x,
        hi = point.y,
        h = Math.abs(toe) < 0.5 ? "centre" : `${fmt(Math.abs(toe), 1)} mm ${toe > 0 ? "toe" : "heel"}`,
        v = Math.abs(hi) < 0.5 ? "centre" : `${fmt(Math.abs(hi), 1)} mm ${hi > 0 ? "high" : "low"}`;
      text = `${h} · ${v}`;
      if (kind === "raw") sub = "Omni raw reading · uncalibrated";
    } else if (kind === "assumed")
      [text, sub] = device
        ? ["Club not tracked on this shot", "no club sticker seen, or a putt"]
        : measured
          ? ["No face reading for this shot", "centred strike assumed"]
          : ["Centred strike assumed", "no face measurement for simulated swings"];
    card({
      club: clubText,
      source,
      sourceKind,
      ...face,
      caption: text,
      captionSub: sub,
      rows: (rows || [])
        .filter(([label]) => label !== "Impact X / Y")
        .map(([label, value, unit, dp]) => ({
          label,
          value: typeof value === "string" ? value : Number.isFinite(value) ? value.toFixed(dp) : null,
          unit,
        })),
    });
  }
  card({ ...draw("iron", null, "none"), caption: "No shot yet", captionSub: "" });
  return { update };
}
