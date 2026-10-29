// Connect UI for the Square Golf Omni, living inside the dock's "Launch monitor" panel.
// A status light sits in the dock summary (always visible); the connect row sits at the top of the
// panel's metrics popover. Shots go through the same contract as the manual shot-input dialog.
import { SquareOmni, lightFor } from "./square-omni.js";
import { hud, act } from "./hud.js";
const LS_HAND = "fairway-lm-handed";
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};
const fmt = (v, dp = 1) => (Number.isFinite(v) ? v.toFixed(dp) : "—");
export function installLaunchMonitorConnect() {
  const supported = SquareOmni.supported();
  const omni = new SquareOmni({
    getClub: () => window.fairwayLaunchMonitor?.getClub?.() ?? null,
    handed: store.get(LS_HAND) === "left" ? "left" : "right",
  });
  const lm = (p) => hud.set((h) => ({ lm: { ...h.lm, ...p } }));
  lm({ supported, handed: omni.handed });
  act.setHanded = (v) => {
    store.set(LS_HAND, v);
    omni.setHanded(v);
    lm({ handed: v });
  };
  let note = "",
    noteTimer = 0,
    shown = "";
  const flash = (text, ms = 6000) => {
    note = text;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      note = "";
      render();
    }, ms);
    render();
  };
  function render() {
    const s = omni.status,
      { light: l, text } = lightFor(s, supported);
    const battery =
      s.battery != null && s.link === "connected"
        ? ` · ${s.battery}% battery${s.charging === "charging" ? " (charging)" : ""}`
        : "";
    const status =
      (!supported
        ? typeof isSecureContext !== "undefined" && !isSecureContext
          ? "Needs HTTPS or localhost for Web Bluetooth"
          : "Web Bluetooth unavailable · use desktop Chrome"
        : note || text) + battery;
    const meta =
      s.link === "connected"
        ? [s.deviceName, s.firmware?.lm ? "fw " + s.firmware.lm : "", s.club].filter(Boolean).join(" · ")
        : "";
    const label =
      s.link === "idle" || (s.link === "error" && !omni.device)
        ? "Connect"
        : s.link === "error"
          ? "Reconnect"
          : s.link === "connecting"
            ? "Cancel"
            : "Disconnect";
    const key = [l, status, meta, label].join("|");
    if (key === shown) return;
    shown = key; // sensor frames stream at ~10 Hz: touch the DOM only on change
    lm({ light: l, status, meta, label, showAll: supported && label === "Connect" });
  }
  omni.addEventListener("status", render);
  omni.addEventListener("shot", ({ detail: { launchData, metrics: m } }) => {
    lm({ last:
      `Last: ${fmt(m.ballSpeedMph)} mph · ${fmt(m.launch)}° launch · ${fmt(m.direction)}° dir · ${Math.round(m.totalSpin)} rpm (axis ${fmt(m.spinAxis)}°)` +
      (Number.isFinite(m.clubSpeedMph) ? ` · club ${fmt(m.clubSpeedMph)} mph` : "") +
      (Number.isFinite(m.impactH) ? ` · impact raw ${fmt(m.impactH)}/${fmt(m.impactV)}` : "") });
    const api = window.fairwayLaunchMonitor;
    if (!api) {
      flash("Shot measured, but the game is still loading");
      return;
    }
    // Announce first: the impact card pairs the Omni's raw face reading with the shot the game is about to play.
    window.dispatchEvent(
      new CustomEvent("fairway-launch-monitor-shot", { detail: { device: "square-omni", launchData, metrics: m } }),
    );
    try {
      api.submit(launchData);
      flash("Shot received");
    } catch (e) {
      flash("Shot measured but not played: " + (e.message || e));
    }
  });
  omni.addEventListener("discard", ({ detail: { metrics: m } }) =>
    flash(`Ignored a ${fmt(m.ballSpeedMph, 0)} mph shot that read zero spin (ball too far forward?) · re-hit`, 9000),
  );
  act.lmShowAll = async () => {
    try {
      await omni.connect({ showAll: true });
    } catch (e) {
      if (e?.name !== "NotFoundError") flash(e.message || String(e), 8000);
      render();
    }
  };
  act.lmConnect = async () => {
    const s = omni.status;
    try {
      if (s.link === "connected" || s.link === "reconnecting" || s.link === "connecting") await omni.disconnect();
      else if (s.link === "error" && omni.device) await omni.reconnect();
      else await omni.connect();
    } catch (e) {
      if (e?.name === "NotFoundError") {
        render();
        return;
      } // chooser dismissed
      flash(e.message || String(e), 8000);
    }
  };
  render();
  // Chrome's getDevices() (permissions backend flag) lets a previously approved Omni reconnect without the chooser.
  if (supported && navigator.bluetooth.getDevices)
    navigator.bluetooth
      .getDevices()
      .then(async (list) => {
        const d = list.find((x) => /^SquareGolf/.test(x.name || ""));
        if (!d || omni.device) return;
        if (d.watchAdvertisements) {
          const ac = new AbortController();
          const seen = new Promise((r) => d.addEventListener("advertisementreceived", r, { once: true }));
          try {
            await d.watchAdvertisements({ signal: ac.signal });
            await Promise.race([seen, new Promise((_, j) => setTimeout(() => j(Error("not in range")), 8000))]);
          } catch {
            return;
          } finally {
            ac.abort();
          }
        }
        if (!omni.device) await omni.attach(d);
      })
      .catch(() => {
        if (omni.status.link !== "connected") omni.set({ link: "idle", error: "" });
      });
  window.fairwaySquareOmni = omni; // console/debug handle
  return { omni };
}
