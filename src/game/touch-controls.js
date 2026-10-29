// Touch play (phones/tablets): a drag is the desktop mouse movement (mouse-look), a tap anywhere is Space — the first
// tap starts the power meter, the next strikes. A two-finger drag is WASD: fingers moved up/down/left/right from where
// they landed hold W/S/A/D (diagonals hold two), exactly as the keyboard does (it enters the free camera the same way).
// Taps on buttons, sliders, links and other controls keep their own action; three or more fingers cancel everything.
import { MathUtils } from "./core/index.js";
const TAP_PX = 10,
  TAP_MS = 400,
  LOOK = 0.003,
  DEAD = 18; // LOOK: rad per CSS px, as desktop mouse-look; DEAD: two-finger dead zone (px)
export function installTouchControls(renderer, swing) {
  const active = new Map(),
    held = new Set();
  let gesture = null,
    two = null;
  const pts = () => [...active.values()],
    cx = () => pts().reduce((a, p) => a + p.x, 0) / active.size,
    cy = () => pts().reduce((a, p) => a + p.y, 0) / active.size;
  const key = (type, code, repeat = false) =>
    window.dispatchEvent(
      new KeyboardEvent(type, { code, key: code.slice(3).toLowerCase(), repeat, bubbles: true, cancelable: true }),
    );
  // a held physical key auto-repeats; the first press only switches into the free camera, the repeats then move it
  setInterval(() => {
    for (const k of held) if (!renderer.freeCamera?.keys?.has(k)) key("keydown", k, true);
  }, 90);
  const release = () => {
    for (const k of held) key("keyup", k);
    held.clear();
  };
  const onCourse = (e) =>
    e.pointerType === "touch" &&
    !e.target.closest?.(
      "button,a,input,select,textarea,label,summary,[role=button],[role=slider],[role=dialog],[data-slot=card],[data-slot=popover-content],#fxPanel",
    );
  const lookable = () =>
    ["shot", "free"].includes(renderer.cameraType) &&
    !renderer.shot &&
    !renderer.cameraMotion?.active &&
    !(renderer.cameraType === "free" && renderer.freeCamera?.frozen);
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (!onCourse(e)) return;
      active.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (active.size === 2) {
        gesture = null;
        two = { x: cx(), y: cy() };
        return;
      }
      if (active.size > 2) {
        gesture = null;
        release();
        two = null;
        return;
      }
      gesture = {
        id: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        x: e.clientX,
        y: e.clientY,
        t: performance.now(),
        moved: 0,
      };
    },
    { passive: true },
  );
  window.addEventListener(
    "pointermove",
    (e) => {
      if (active.has(e.pointerId)) active.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (two && active.size === 2) {
        const dx = cx() - two.x,
          dy = cy() - two.y,
          want = new Set();
        if (dy < -DEAD) want.add("KeyW");
        if (dy > DEAD) want.add("KeyS");
        if (dx < -DEAD) want.add("KeyA");
        if (dx > DEAD) want.add("KeyD");
        for (const k of held)
          if (!want.has(k)) {
            held.delete(k);
            key("keyup", k);
          }
        for (const k of want)
          if (!held.has(k)) {
            held.add(k);
            key("keydown", k);
          }
        return;
      }
      const g = gesture;
      if (!g || e.pointerId !== g.id) return;
      const dx = e.clientX - g.x,
        dy = e.clientY - g.y;
      g.x = e.clientX;
      g.y = e.clientY;
      g.moved = Math.max(g.moved, Math.hypot(e.clientX - g.x0, e.clientY - g.y0));
      if (g.moved < TAP_PX || !lookable()) return;
      const pose = renderer.cameraType === "free" ? renderer.freeCamera : renderer;
      // exactly the desktop mouse-look (renderer.js pointermove): same pose, same direction, same sensitivity
      pose.yaw += dx * LOOK;
      pose.pitch = MathUtils.clamp(pose.pitch - dy * LOOK, -1.48, 1.48);
      pose.look();
    },
    { passive: true },
  );
  const end = (e) => {
    active.delete(e.pointerId);
    if (two && active.size < 2) {
      two = null;
      release();
    }
    const g = gesture;
    if (!g || e.pointerId !== g.id) return;
    gesture = null;
    if (
      e.type === "pointerup" &&
      g.moved < TAP_PX &&
      performance.now() - g.t < TAP_MS &&
      ["shot", "free"].includes(renderer.cameraType)
    )
      swing();
  };
  window.addEventListener("pointerup", end, { passive: true });
  window.addEventListener("pointercancel", end, { passive: true });
}
