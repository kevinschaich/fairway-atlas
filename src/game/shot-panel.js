import { PHYSICS_VERSION } from "./physics-version.js";
import { clubs, YARD, FT } from "./engine.js";
import { installLaunchMonitorConnect } from "./launch-monitor-panel.js";
import { installImpactCard } from "./impact-card.js";
import { hud, act } from "./hud.js";
const rpm = 30 / Math.PI;
export function shotMetrics(shot) {
  const s = shot?.stats || {},
    hit = shot?.contacts?.find((c) => c.kind === "ground"),
    v = hit?.velocityBefore,
    w = hit?.spinBefore;
  const speed = v ? Math.hypot(v.x, v.y, v.z) : null,
    az = v ? Math.atan2(v.x, -v.z) : 0;
  const landingSpin = w ? (w.x * Math.cos(az) + w.z * Math.sin(az)) * rpm : null;
  const descent = v ? (Math.atan2(-v.y, Math.hypot(v.x, v.z)) * 180) / Math.PI : null;
  return [
    ["Ball speed", s.ballSpeed, "mph", 1],
    ["Launch angle", s.launch, "°", 1],
    ["Backspin", s.spin, "rpm", 0],
    ["Landing spin", landingSpin, "rpm", 0],
    ["Descent angle", descent, "°", 1],
    ["Carry", shot ? shot.carry / YARD : null, "yd", 1],
    ["Total distance", shot ? shot.total / YARD : null, "yd", 1],
    ["Peak height", shot ? shot.apex / FT : null, "ft", 1],
    ["Club speed", s.clubSpeed, "mph", 1],
    ["Smash factor", s.clubSpeed > 0 ? s.ballSpeed / s.clubSpeed : null, "", 2],
    ["Side angle", s.direction, "°", 1],
    ["Side spin", s.sideSpin, "rpm", 0],
    ["Club path", s.pathAngle, "°", 1],
    [
      "Face to path",
      Number.isFinite(s.faceAngle) && Number.isFinite(s.pathAngle) ? s.faceAngle - s.pathAngle : null,
      "°",
      1,
    ],
    ["Face to target", s.faceAngle, "°", 1],
    [
      "Rollout",
      shot && hit ? ((shot.end.x - hit.x) * Math.sin(az) - (shot.end.z - hit.z) * Math.cos(az)) / YARD : null,
      "yd",
      1,
    ],
    ["Attack angle", s.attack, "°", 1],
    ["Dynamic loft", s.dynamicLoft, "°", 1],
    ["Spin axis", s.axis, "°", 1],
    ["Impact X / Y", s.impactPoint ? `${s.impactPoint.x.toFixed(1)} / ${s.impactPoint.y.toFixed(1)}` : null, "mm", 0],
  ];
}
export function installShotPanel() {
  let open = true;
  try {
    open = localStorage.getItem("fairway-shot-panel") !== "closed";
  } catch {}
  const panel = (p) => hud.set((h) => ({ shotPanel: { ...h.shotPanel, ...p } }));
  panel({ open, note: "Calculated shot results · no launch monitor connected", physics: PHYSICS_VERSION });
  act.shotPanelOpen = (o) => {
    panel({ open: o });
    try {
      localStorage.setItem("fairway-shot-panel", o ? "open" : "closed");
    } catch {}
  };
  installLaunchMonitorConnect();
  const impact = installImpactCard();
  let currentShot = null;
  act.saveShot = () => {
    if (!currentShot) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ page: location.href, shot: currentShot }, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "fairway-shot-details.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  act.reload = () => location.reload();
  let checking = false;
  const check = async () => {
    if (checking || document.hidden) return;
    checking = true;
    try {
      const r = await fetch("version.json", { cache: "no-store" });
      if (r.ok && (await r.json()).physics !== PHYSICS_VERSION) panel({ updateReady: true });
    } catch {
    } finally {
      checking = false;
    }
  };
  document.addEventListener("visibilitychange", check);
  setInterval(check, 60000);
  check();
  let last = Symbol();
  return {
    update(shot) {
      if (last === shot) return;
      last = shot;
      currentShot = shot;
      const rows = shotMetrics(shot);
      let note =
        shot?.stats?.source === "measured ball"
          ? "Measured ball launch · trajectory and landing calculated · missing club data estimated"
          : "Simulated club impact · rollout is signed from first landing (+ forward, − back)";
      if (shot)
        note += ` · ${shot.input.lie} lie · dampness ${Math.round(shot.conditions.dampness * 100)}% · Stimp ${shot.conditions.stimp} · landed on ${shot.contacts.find((c) => c.kind === "ground")?.surface || "—"}`;
      panel({
        canSave: !!shot,
        label: shot ? `${Math.round((shot.carry || 0) / 0.9144)} yd carry` : "",
        metrics: rows.map(([label, value, unit, dp]) => ({ label, value: typeof value === "string" || Number.isFinite(value) ? value : null, unit, dp })),
        note,
        shotId: shot ? performance.now() : 0,
      });
      impact.update(shot, rows);
    },
  };
}
