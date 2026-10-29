import { readShareState, updateShareURL, validDate } from "./share-state.js";
import { DEFAULT_LIGHTING } from "./lighting-settings.js";
import { hud, act } from "./hud.js";
export function installSceneSettings(renderer) {
  let shareTimer;
  const share = () => {
    clearTimeout(shareTimer);
    shareTimer = setTimeout(() => updateShareURL({ settings: renderer.lighting, effects: renderer.userEffects }), 150);
  };
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem("fairway-lighting-v1"));
  } catch {}
  if (saved) {
    const limits = { hour: [0, 24], clouds: [0, 0.8], fill: [0.05, 0.8], haze: [0, 1], exposure: [-1.5, 1.5] };
    const clean = {};
    for (const [k, [min, max]] of Object.entries(limits))
      if (Number.isFinite(saved[k])) clean[k] = Math.max(min, Math.min(max, saved[k]));
    if (validDate(saved.date)) clean.date = saved.date;
    renderer.setLighting(clean);
  }
  function refresh() {
    const s = renderer.lighting;
    hud.set({ lighting: { date: s.date, clouds: s.clouds } });
  }
  function apply(value) {
    renderer.setLighting(value);
    refresh();
    share();
    try {
      localStorage.setItem("fairway-lighting-v1", JSON.stringify(renderer.lighting));
    } catch {}
  }
  act.setDate = (date) => {
    if (validDate(date)) apply({ date });
  };
  act.setClouds = (clouds) => apply({ clouds });
  act.settings = (open) => hud.set((h) => ({ settingsOpen: open ?? !h.settingsOpen }));
  refresh();
  function applyURL() {
    const parsed = readShareState(location.href),
      { resolution: scale, ...light } = parsed.settings;
    renderer.setEffects(parsed.effects);
    renderer.setLighting(light);
    refresh();
  }
  applyURL();
  return { applyURL };
}
