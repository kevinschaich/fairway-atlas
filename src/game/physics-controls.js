import { conditions, CONDITION_LIMITS } from "./physics-conditions.js";
import { HEADS, normalizeLaunchData } from "./launch-input.js";
import { hud, act } from "./hud.js";
export function readConditions(url, saved = {}) {
  const p = new URL(url).searchParams,
    out = { ...saved };
  for (const k of Object.keys(CONDITION_LIMITS)) {
    const value = p.get("physics_" + k);
    if (value !== null && value.trim() !== "" && Number.isFinite(Number(value))) out[k] = Number(value);
  }
  return conditions(out);
}
export function installPhysicsControls({ onChange, getClub, onShot }) {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem("fairway-physics-v2")) || {};
  } catch {}
  let current = readConditions(location.href, stored),
    timer;
  const fields = [
    ["dampness", "Surface dampness", 0.05, (v) => Math.round(v * 100) + "%"],
    ["stimp", "Green speed", 0.5, (v) => v.toFixed(1) + " ft"],
    ["temperature", "Air temperature", 1, (v) => v + " °C"],
    ["humidity", "Relative humidity", 5, (v) => v + "%"],
    ["windSpeed", "Wind speed", 0.5, (v) => v.toFixed(1) + " mph"],
    ["windDirection", "Wind blows toward", 5, (v) => v + "° (north = 0)"],
  ];
  const publish = () =>
    hud.set({
      conditions: fields.map(([k, label, step, format]) => ({
        k,
        label,
        step,
        min: CONDITION_LIMITS[k][0],
        max: CONDITION_LIMITS[k][1],
        value: current[k],
        text: format(current[k]),
      })),
    });
  publish();
  act.setCondition = (k, value) => {
    current = conditions({ ...current, [k]: value });
    publish();
    clearTimeout(timer);
    timer = setTimeout(() => {
      const url = new URL(location.href);
      for (const [key, v] of Object.entries(current)) url.searchParams.set("physics_" + key, v);
      history.replaceState(history.state, "", url);
      try {
        localStorage.setItem("fairway-physics-v2", JSON.stringify(current));
      } catch {}
      onChange(current);
    }, 120);
  };
  // Launch data form: ball measurements drive flight directly; club delivery predicts missing ball values.
  const inputs = [
    ["ballSpeed", "Ball speed (mph)", 100, 0, 250],
    ["ballDirection", "Ball direction (°)", 0, -90, 90],
    ["ballElevation", "Ball elevation (°)", 20, -30, 90],
    ["backspin", "Backspin (RPM)", 5000, -20000, 20000],
    ["sideSpin", "Side spin (RPM)", 0, -20000, 20000],
    ["pathAngle", "Path angle (°)", 0, -90, 90],
    ["attackAngle", "Attack angle (°)", -4, -60, 60],
    ["faceAngle", "Face angle (°)", 0, -90, 90],
    ["dynamicLoft", "Dynamic loft (°)", 30, -15, 90],
    ["clubSpeed", "Club speed (mph)", 80, 0, 180],
    ["impactX", "Impact X (mm)", 0, -60, 60],
    ["impactY", "Impact Y (mm)", 0, -60, 60],
  ];
  const openInput = () => {
    const values = Object.fromEntries(inputs.map(([name, , value]) => [name, String(value)]));
    const club = getClub();
    if (club) {
      const h = HEADS[club.type];
      values.clubSpeed = (club.speed / (club.type === "putter" ? 1.56 : club.smash) / 0.44704).toFixed(1);
      values.dynamicLoft = String(h.loft);
      values.attackAngle = String(h.attack);
      values.ballSpeed = (club.speed / 0.44704).toFixed(1);
      values.ballElevation = String(club.angle);
      values.backspin = String(club.spin);
    }
    hud.set({ launchInput: { id: performance.now(), mode: "ball", values, error: "", fields: inputs.map(([name, label, , min, max], i) => ({ name, label, min, max, ball: i < 5 })) } });
  };
  act.closeLaunchInput = () => hud.set({ launchInput: null });
  act.submitLaunch = ({ mode, values }) => {
    try {
      const data = { units: "mph-deg-rpm-mm" },
        ball = mode === "ball";
      inputs.forEach(([name], i) => {
        const disabled = !ball && i < 5;
        if (!disabled && values[name] !== "" && !name.startsWith("impact")) data[name] = Number(values[name]);
      });
      if (values.impactX !== "" && values.impactY !== "") data.impactPoint = { x: Number(values.impactX), y: Number(values.impactY) };
      onShot(normalizeLaunchData(data));
      hud.set({ launchInput: null, settingsOpen: false });
    } catch (e) {
      hud.set((h) => ({ launchInput: h.launchInput && { ...h.launchInput, mode, values, error: e.message } }));
    }
  };
  // A transport adapter can call this on the same page after explicit connection.
  // No external messages, sockets, device discovery or server forwarding here.
  // getClub lets a connected monitor (square-omni.js) keep the device's club selection in step with the game.
  window.fairwayLaunchMonitor = Object.freeze({
    schema: "fairway-launch-v1",
    submit: (data) => onShot(normalizeLaunchData(data)),
    getClub: () => getClub(),
  });
  window.addEventListener("popstate", () => {
    current = readConditions(location.href);
    publish();
    onChange(current);
  });
  return {
    get value() {
      return current;
    },
    open: openInput,
  };
}
