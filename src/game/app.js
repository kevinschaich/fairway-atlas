import { hud, act } from "./hud.js";
import "./net-cache.js";
import { GAME_NAME, PAGE_TITLE } from "./brand.js";
import { courseTeeYards, TEE_COLORS } from "./tee-sets.js";
document.title = PAGE_TITLE;
import { fastLoad } from "./fast-load.js";
import { clubThumb } from "./club-thumbs.js";
import { installAudio, shotEvents } from "./audio.js";
import { installCommentary } from "./commentary.js";
import { bagOrder } from "./engine.js";
import { installShotPanel } from "./shot-panel.js";
import { installPhysicsControls } from "./physics-controls.js";
import { windRelative } from "./physics-conditions.js";
import { installTouchControls } from "./touch-controls.js";
import { exportUnreal, saveExport } from "./unreal-export.js";
import { withEstimatedPar } from "./par-estimate.js";
import { fetchCanopy } from "./canopy-data.js";
import { readShareState, updateShareURL } from "./share-state.js";
import { installSceneSettings } from "./scene-settings.js";
import { installPerfPanel } from "./perf-panel.js";
import { PROVIDERS, getProviderOrder, setProviderOrder, providerAttempts } from "./data-sources.js";
import { fetchHoleTerrain, fetchCourseTerrain } from "./terrain.js";
import { coastalWater } from "./coast.js";
import {
  diagnostics,
  record,
  readIndex,
  searchIndex,
  normalize,
  parseRouting,
  featuresFrom,
  requestScenery,
  requestStage,
  requestBoundary,
  joinRings,
} from "./course-data.js";
import { CourseRenderer } from "./renderer.js";
import {
  clubs,
  makeWorld,
  simulate,
  applyResult,
  suggest,
  distance,
  pointIn,
  polygonValid,
  YARD,
  FT,
  caddieTarget,
} from "./engine.js";
const $ = (s) => document.getElementById(s),
  escapeHTML = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const catalog = [
  {
    id: "pebble",
    sourceId: "relation/3741806",
    name: "Pebble Beach Golf Links",
    facility: "Pebble Beach Resorts",
    location: "Pebble Beach, California",
    holes: 18,
  },
  {
    id: "raccoon",
    sourceId: "way/42120656",
    name: "Raccoon Creek",
    facility: "Raccoon Creek Golf Course",
    location: "Littleton, Colorado",
    holes: 18,
  },
];
let globalIndex = [],
  indexError = null,
  loadController = null,
  loadSequence = 0,
  loadingCourse = false,
  lastLoadFailure = null;
const indexReady = readIndex()
  .then((items) => {
    globalIndex = items;
    return items;
  })
  .catch((e) => {
    indexError = e.message;
    record("index", e.message);
    return [];
  });
const cache = new Map();
let course,
  world,
  hole,
  round,
  club = 4,
  aim = 0,
  power = 80,
  mode = "play",
  visual = "natural",
  busy = false,
  meter = null,
  selected = 0,
  searchItems = catalog,
  imagery = null,
  imageryToken = 0,
  suggested = 80,
  toastTimer;
let saved = { rounds: {}, last: null, edits: {}, routing: {} };
try {
  saved = { ...saved, ...JSON.parse(localStorage.getItem("fairway-atlas-v1") || "{}") };
} catch {}
if (saved.last?.clubSchema !== 2 && saved.last) {
  saved.last.club = [0, 1, 3, 3, 4, 4, 4, 5][saved.last.club] ?? 4;
}
let pendingRefresh = null,
  autoPowerOnTerrain = false;
const timings = { discovery: 0, map: 0, terrain: 0, playable: 0 };
const layers = { green: true, tee: true, fairway: true, bunker: true, water: true, routing: true };
let opacity = 0.5;
const renderer = new CourseRenderer($("scene"), (r, now) => {
  stepHeld(now);
  syncTools(r);
  if (r.reveal && world && course) {
    const v = r.reveal,
      w = v.want;
    if (!w.elev && world.terrainReady) {
      w.elev = true;
      buildStage("Raising terrain…");
    }
    const now = performance.now();
    if (
      w.elev &&
      v.p.elev >= 1 &&
      v.course < COURSE_STEPS.length &&
      now >= v.courseAt &&
      (course.stage === "complete" || !buildPending)
    ) {
      const [kind, label] = COURSE_STEPS[v.course++];
      v.courseAt = now + (v.fast ? 180 : 950);
      crossfade();
      r.revealHide?.delete(kind);
      r.repaintBase?.();
      buildStage(label);
    }
    if (
      w.elev &&
      v.p.elev >= 1 &&
      v.course >= COURSE_STEPS.length &&
      now >= v.courseAt &&
      !w.buildings &&
      (course.sceneryUpdated || !buildPending)
    ) {
      w.buildings = true;
      buildStage("Adding buildings…");
    }
    if (w.buildings && v.p.buildings >= 1 && !w.trees && (course.canopy || !buildPending)) {
      w.trees = true;
      buildStage("Planting foliage…");
    }
    if (!buildPending && !world.terrainReady) {
      w.elev = w.buildings = w.trees = true;
      if (v.course < COURSE_STEPS.length) {
        v.course = COURSE_STEPS.length;
        r.revealHide = null;
        r.repaintBase?.();
      }
    }
    if (r.revealDone() && r.revealHide) {
      r.revealHide = null;
    }
    v.finishing = !buildPending;
  }
  if (!buildPending && buildReadyAt === Infinity && r.revealDone()) buildReadyAt = performance.now() + 400;
  if (
    r.autoPlan &&
    world?.terrainReady &&
    !buildPending &&
    r.revealDone() &&
    performance.now() >= buildReadyAt &&
    r.cameraType === "plan" &&
    mode === "play" &&
    !busy &&
    !meter &&
    !r.overview &&
    !r.cameraMotion.active
  ) {
    r.autoPlan = false;
    r.setCamera("shot", round.ball);
    if (r.cameraMotion.active) r.cameraMotion.active.duration = 2.6;
  }
  if (!world || renderer.overview) return;
  if (Math.floor(now / 1000) !== window.lastFpsSecond) {
    hud.set({ fps: r.fps });
    window.lastFpsSecond = Math.floor(now / 1000);
  }
  renderer.onHoleMarkers?.();
  const p = r.flagScreen();
  {
    const c = r.carryScreen?.(),
      el = $("carryMarker");
    el.style.display = mode === "play" && c?.visible && !meter && !busy ? "block" : "none";
    if (c) {
      el.style.left = c.x + "px";
      el.style.top = c.y + "px";
    }
  }
  $("flagLabel").style.display = mode === "play" && p?.visible ? "block" : "none";
  if (p) {
    $("flagLabel").style.left = p.x + "px";
    $("flagLabel").style.top = p.y + "px";
  }
  if (meter) {
    power = Math.min(110, ((now - meter.start) / 1000) * 68);
    r.setSwing(power / 110);
    const fill = $("swingMeterFill");
    if (fill) fill.style.width = (power / 110) * 100 + "%";
    hud.set({ power });
    if (power >= 110) strike();
  }
});
if (new URLSearchParams(location.search).has("debug")) window.fairway = renderer;
const shotPanel = installShotPanel();
const sceneSettings = installSceneSettings(renderer);
const audio = installAudio({ renderer, getWorld: () => world });
try {
  renderer.showPuttGrid = localStorage.getItem("fairway-putt-grid") !== "off";
} catch {} // green-reading grid, G toggles
window.addEventListener("keydown", (e) => {
  if (
    e.key.toLowerCase() !== "g" ||
    e.metaKey ||
    e.ctrlKey ||
    e.altKey ||
    /input|textarea|select/i.test(e.target?.tagName || "")
  )
    return;
  renderer.showPuttGrid = renderer.showPuttGrid === false;
  try {
    localStorage.setItem("fairway-putt-grid", renderer.showPuttGrid ? "on" : "off");
  } catch {}
  toast(renderer.showPuttGrid ? "Green grid on" : "Green grid off");
});
const booth = installCommentary({ audio, renderer, state: () => ({ world, hole, round, course, mode, busy }) });
let linkAtTee = false;
const physicsControls = installPhysicsControls({
  getClub: () => clubs[club],
  onChange: (c) => {
    if (world) {
      world.physicsConditions = c;
      if (!busy) {
        calcSuggested();
        renderControls();
      }
    }
  },
  onShot: (launchData) => {
    if (
      !world ||
      busy ||
      meter ||
      round.complete ||
      !world.terrainReady ||
      !world.playable ||
      course.stage !== "complete"
    )
      throw Error("Wait for a playable hole, then try again.");
    meter = {};
    strike(launchData);
    return true;
  },
});
renderer.followEnabled = true;
hud.set({ follow: true });
renderer.onDetail = () => record("render", "Vegetation and surface detail ready.");
renderer.onOverviewError = (message) => record("overview", message);
function toast(msg, undo = null, ms = 4500) {
  hud.set({ toast: { id: performance.now(), msg, undo } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hud.set({ toast: null }), ms);
}
function persist() {
  if (!course || !hole) return;
  updateShareURL({
    course: course.id,
    hole: hole.number,
    settings: renderer.lighting,
    effects: renderer.userEffects ?? renderer.effects,
  });
  if (!linkAtTee || round.strokes > 0)
    saved.rounds[course.id + ":" + hole.number] = {
      ...round,
      last: round.last ? { ...round.last, path: undefined } : null,
    };
  saved.last = { course: course.id, hole: hole.number, club, aim, power, visual, clubSchema: 2 };
  try {
    localStorage.setItem("fairway-atlas-v1", JSON.stringify(saved));
  } catch {
    toast("Device storage is full. Export your round to keep it.");
  }
}
function openDialog(kind, data = {}) {
  hud.set({ dialog: { kind, ...data } });
}
function closeDialog() {
  hud.set({ dialog: null });
}
act.closeDialog = closeDialog;
function safeLoadState(key) {
  const s = saved.rounds[key];
  return s && Number.isFinite(s.ball?.x) && Number.isFinite(s.ball?.z) && Array.isArray(s.shots) && s.strokes >= 0
    ? s
    : null;
}
function needsUpdate(d) {
  return d.id.includes("/") && d.detailVersion !== 4;
}
function startOverview(item, n, signal, start) {
  document.body.classList.add("is-overview");
  mode = "map";
  hud.set((h) => ({
    mode,
    overview: true,
    roundDisabled: true,
    timings: "Building this course on demand…",
    course: { ...h.course, name: item.name, location: item.location },
    hole: { number: n || 0, par: null, parEstimated: false, yards: 0 },
    holes: [],
    mapping: { ...h.mapping, quality: null },
    crosshair: false,
    loading: null,
    diagnostic: "Building holes…",
    cameraHint: "Drag to orbit · Scroll to zoom · Hole geometry follows",
  }));
  const flagEl = $("flagLabel");
  if (flagEl) flagEl.style.display = "none";
  renderer.showOverview(item, signal, (stage) => {
    if (!signal.aborted && renderer.overview) {
      record(stage, item.name, start);
      hud.set({ timings: stage + " " + Math.round(performance.now() - start) + " ms · hole geometry loading" });
    }
  });
}
// Drone hop: start from where the camera was on the previous hole (re-projected into this
// hole's coordinates) and fly, high and eased, to the new tee shot pose.
function droneTo(f) {
  const p = world.toLocal(f.geo),
    start = renderer.camera.position.clone().set(p.x, world.elevation(p.x, p.z) + f.agl, p.z),
    d = start.distanceTo(renderer.camera.position);
  renderer.cameraMotion.toCurrent(
    { position: start, quaternion: f.quaternion, fov: f.fov, near: renderer.camera.near },
    Math.min(5, Math.max(2.2, 1.6 + d / 180)),
    Math.min(90, Math.max(15, d * 0.18)),
  );
}
let fastPill = false,
  buildPending = false,
  buildReadyAt = 0;
const COURSE_STEPS = [
  ["fairway", "Mowing fairways…"],
  ["green", "Shaping greens…"],
  ["tee", "Cutting tee boxes…"],
  ["bunker", "Raking bunkers…"],
];
const buildUI = (() => {
  let queue = [],
    showing = null,
    until = 0,
    timer = 0,
    hideT = 0;
  const pump = () => {
    clearTimeout(timer);
    if (!queue.length) return;
    const wait = until - performance.now();
    if (wait > 0) {
      timer = setTimeout(pump, wait);
      return;
    }
    const next = queue.shift();
    showing = next.text;
    hud.set({ build: { text: next.text, done: !!next.done } });
    until = performance.now() + (next.done ? 900 : fastPill ? 160 : 650);
    if (next.done) {
      clearTimeout(hideT);
      hideT = setTimeout(() => {
        if (!buildPending) hud.set({ build: null });
      }, 1500);
    }
    if (queue.length) timer = setTimeout(pump, until - performance.now());
  };
  return {
    stage(t, done = false) {
      if (showing === t && !queue.length) return;
      if (queue.at(-1)?.text === t) return;
      queue = queue.filter((q) => !q.done);
      queue.push({ text: t, done });
      clearTimeout(hideT);
      pump();
    },
    lastDue: () => Math.max(until, performance.now()) + queue.length * (fastPill ? 160 : 650),
  };
})();
window.__tl = window.__tl || [];
function buildStage(t) {
  window.__tl.push([Math.round(performance.now()), t]);
  buildUI.stage(t);
}
renderer.onBuildStep = (s) => {
  if (buildPending && s === "stripes") buildStage("Mowing fairways…");
};
function saveHotView() {
  const r = renderer,
    c = r.camera;
  const v = {
    type: r.cameraType,
    fov: c.fov,
    yaw: r.cameraType === "free" ? r.freeCamera.yaw : r.yaw,
    pitch: r.cameraType === "free" ? r.freeCamera.pitch : r.pitch,
    position: c.position.toArray(),
    target: r.controls.target.toArray(),
    debugPose: r.gpu?.debugPose || null,
    course: course?.id,
    hole: hole?.number,
  };
  try {
    sessionStorage.setItem("fa-hot-view", JSON.stringify(v));
  } catch {}
}
function restoreHotView() {
  let v;
  try {
    v = JSON.parse(sessionStorage.getItem("fa-hot-view") || "null");
    sessionStorage.removeItem("fa-hot-view");
  } catch {}
  if (!v || v.course !== course?.id || v.hole !== hole?.number) return;
  const r = renderer;
  if (v.debugPose && r.gpu && window.__look) {
    window.__look(v.debugPose.eye, v.debugPose.target, 2);
    return;
  }
  r.setCamera(v.type === "fly" ? "shot" : v.type, round.ball, false);
  if (v.type === "shot") {
    r.yaw = v.yaw;
    r.pitch = v.pitch;
    r.look(true);
  } else {
    r.camera.position.fromArray(v.position);
    r.controls.target.fromArray(v.target);
    if (v.type === "free") {
      r.camera.fov = v.fov;
      r.camera.updateProjectionMatrix();
      r.freeCamera.yaw = v.yaw;
      r.freeCamera.pitch = v.pitch;
      r.freeCamera.look();
    }
  }
}
if (globalThis.__FA_DEV__ !== false)
  window.__reloadAll = () => {
    saveHotView();
    fastLoad.setEnabled(true);
    location.reload();
  };
function trackFastLoad(sequence) {
  const t0 = performance.now();
  let detail = false;
  const prev = renderer.onDetail;
  renderer.onDetail = (...a) => {
    detail = true;
    renderer.onDetail = prev;
    prev?.(...a);
  };
  const frames0 = () => renderer.gpu?.frameCount ?? 0;
  let f0 = null;
  fastLoad
    .track([
      { label: "Course data", done: () => !!course && cache.has(course.id) },
      { label: "Terrain & world", done: () => world?.terrainReady },
      { label: "GPU engine", done: () => !!renderer.gpu?.ready },
      {
        label: "Hole geometry & surfaces",
        done: () => course?.stage === "complete" && world?.playable !== false && !busy,
      },
      { label: "Grass & detail", done: () => detail || performance.now() - t0 > 8000 },
      {
        label: "First frames",
        done: () => {
          if (!renderer.gpu) return false;
          const f = renderer.gpu ? (renderer.gpu.frameCount ?? 0) : 1;
          f0 ??= f;
          return !renderer.gpu || f - f0 >= 3;
        },
      },
    ])
    .then((ms) => {
      if (sequence === loadSequence) {
        hud.set({ timings: `Cached start · playable in ${Math.round(ms ?? 0)} ms` });
        try {
          restoreHotView();
        } catch (e) {
          console.warn("view restore", e);
        }
      }
    });
}
function finishBuild() {
  if (!buildPending) return;
  buildPending = false;
  buildReadyAt = renderer.reveal ? Infinity : buildUI.lastDue() + 250;
  const done = () => {
    if (renderer.revealDone()) {
      buildUI.stage("Course ready", true);
    } else setTimeout(done, 200);
  };
  done();
}
function crossfade() {
  const src = renderer.canvas,
    host = $("scene");
  if (!src || !host || !src.width) return;
  let c = $("buildFade");
  if (!c) {
    c = document.createElement("canvas");
    c.id = "buildFade";
    host.append(c);
  }
  try {
    renderer.tick?.(performance.now());
    c.width = src.width;
    c.height = src.height;
    c.getContext("2d").drawImage(src, 0, 0);
    c.style.transition = "none";
    c.style.opacity = "1";
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        c.style.transition = "opacity .9s cubic-bezier(.4,0,.2,1)";
        c.style.opacity = "0";
      }),
    );
  } catch {}
}
async function loadCourse(id, n = 1, { fromLink = false } = {}) {
  if (busy && !loadingCourse) return;
  const prefs = !fromLink && saved.last?.course === id && saved.last?.hole === n ? { ...saved.last } : null;
  pendingRefresh = null;
  autoPowerOnTerrain = !prefs;
  loadController?.abort();
  loadController = new AbortController();
  const signal = loadController.signal,
    sequence = ++loadSequence;
  let overviewTerrain = null,
    courseTerrainLoading = false;
  lastLoadFailure = null;
  loadingCourse = true;
  busy = true;
  updateSwing();
  const start = performance.now();
  hud.set({ loading: { title: "Opening course" } });
  try {
    let item =
      catalog.find((c) => c.id === id) || globalIndex.find((c) => c.id === id) || searchItems.find((c) => c.id === id);
    let d = cache.get(id);
    const fast = fastLoad.enabled() && mode === "play";
    if (!d && fast) {
      d = await fastLoad.getCourse(id);
      if (d) cache.set(id, d);
    }
    if (sequence !== loadSequence) return;
    if (!d && item?.live) startOverview(item, n, signal, start);
    if (sequence !== loadSequence) return;
    if (!d) {
      if (!item && id.includes("/")) {
        await indexReady;
        item = globalIndex.find((c) => c.id === id);
        if (item?.live) startOverview(item, n, signal, start);
      }
      if (item?.source?.type === "node" && !item.routingFile)
        throw Error(
          "LOCATION_ONLY: this entry is a mapped point, not a course boundary. Select a matching course polygon to load its holes.",
        );
      if (item?.routingFile) {
        const r = await fetch("./data/" + item.routingFile, { signal });
        if (!r.ok) throw Error("Routing snapshot HTTP " + r.status);
        d = await r.json();
      } else if (item?.live) {
        const boundary = await requestBoundary(item, signal);
        signal.throwIfAborted();
        const rings = joinRings(
          boundary.data.elements.find((e) => e.type === item.source.type && e.id === item.source.id),
        );
        renderer.setOverviewBoundary(rings);
        renderer.setOverviewOpacity(opacity);
        record("boundary overlay", item.name, start);
        hud.set({ diagnostic: "Boundary ready · building holes…" });
        courseTerrainLoading = true;
        fetchCourseTerrain(rings, signal)
          .then((t) => {
            courseTerrainLoading = false;
            if (signal.aborted) return;
            overviewTerrain = t;
            renderer.sculptOverview(t);
            record("course elevation", "Native course terrain ready", start);
            if (d) {
              d.terrainRequestPending = false;
              d.terrain = t;
              refreshWorld(d, sequence);
            }
          })
          .catch((e) => {
            courseTerrainLoading = false;
            if (d) d.terrainRequestPending = false;
            if (!signal.aborted) record("course elevation", e.message);
          });
        const response = await requestStage(item, "routing", signal, { bbox: boundary.bbox, facility: boundary.data });
        d = parseRouting(item, response);
        if (d.routingNote) record("routing selection", d.routingNote);
        d.stage = response.complete ? "complete" : "routing";
        d.detailVersion = response.complete ? 4 : 0;
        d.requestBounds = boundary.bbox;
        d.facilityData = boundary.data;
        d.terrain = overviewTerrain;
        d.terrainRequestPending = courseTerrainLoading;
        d.features.push(...coastalWater(d.features, d.center || item.center));
        d.loadedAt = Date.now();
      } else {
        const res = await fetch("./data/" + id + ".json", { signal });
        if (!res.ok) throw Error("Course snapshot is unavailable.");
        d = await res.json();
        d.stage = "complete";
      }
    }
    if (sequence !== loadSequence) return;
    d.holes = d.holes.map(withEstimatedPar);
    cache.set(id, d);
    timings.map = performance.now() - start;
    const nextCourse = structuredClone(d);
    const nextHole = n == null ? nextCourse.holes[0] : nextCourse.holes.find((h) => h.number === n);
    if (!nextHole)
      throw Error(
        "Hole " +
          n +
          " is not mapped in this facility. Available holes: " +
          nextCourse.holes.map((h) => h.number).join(", "),
      );
    const wt = performance.now();
    const nextWorld = makeWorld(nextCourse, nextHole, saved.edits[id] || {});
    timings.terrain = performance.now() - wt;
    const flyFrom =
      course?.id === id && world && mode === "play" && !renderer.overview
        ? {
            geo: world.toGeo({ x: renderer.camera.position.x, z: renderer.camera.position.z }),
            agl: Math.max(
              2,
              renderer.camera.position.y - world.elevation(renderer.camera.position.x, renderer.camera.position.z),
            ),
            quaternion: renderer.camera.quaternion.clone(),
            fov: renderer.camera.fov,
          }
        : null;
    renderer.allowFlatShot = !!flyFrom;
    const nextRound = (!fromLink && safeLoadState(id + ":" + nextHole.number)) || {
      ball: { ...nextWorld.tee },
      strokes: 0,
      complete: false,
      shots: [],
      last: null,
    };
    course = nextCourse;
    hole = nextHole;
    world = nextWorld;
    world.physicsConditions = physicsControls.value;
    round = nextRound;
    linkAtTee = fromLink;
    imagery = null;
    imageryToken++;
    renderer.planInGame = mode === "play";
    crossfade();
    renderer.load(world, (mode === "map" || !world.terrainReady) && !renderer.planInGame);
    document.body.classList.remove("is-overview");
    renderer.setMode(visual);
    renderer.setBall(round.ball);
    chooseClub();
    if (prefs) {
      if (Number.isInteger(prefs.club) && prefs.club >= 0 && prefs.club < clubs.length) club = prefs.club;
      if (Number.isFinite(prefs.aim)) aim = prefs.aim;
      if (Number.isFinite(prefs.power)) power = Math.max(1, Math.min(110, prefs.power));
      visual = "natural";
      renderer.setMode(visual);
      calcSuggested();
    }
    const building = !flyFrom && mode === "play" && !(fast && d.stage === "complete" && world.terrainReady);
    if (fast && !building) trackFastLoad(sequence);
    renderer.setCamera(
      flyFrom && mode !== "map" ? "shot" : building ? "plan" : world.terrainReady && mode !== "map" ? "shot" : "plan",
      round.ball,
    );
    if (building) {
      renderer.revealHide = new Set(COURSE_STEPS.map((c) => c[0]));
      renderer.repaintBase?.();
      fastPill = false;
      renderer.reveal = {
        fast: false,
        want: { elev: false, buildings: false, trees: false },
        p: { elev: 0, buildings: 0, trees: 0 },
        course: 0,
        courseAt: 0,
      };
      renderer.autoPlan = true;
      buildPending = true;
      buildReadyAt = Infinity;
      buildStage("Laying out the course…");
    }
    if (flyFrom) droneTo(flyFrom);
    hud.set({ mode, overview: false, crosshair: mode !== "map", roundDisabled: false });
    renderer.courseHoles = course.holes;
    timings.playable = performance.now() - start;
    render();
    persist();
    hud.set({ visual });
    record(
      "first frame",
      `${course.name} · hole ${hole.number} · ${d.terrain ? "regional terrain" : "flat preview"}${d.stage !== "complete" ? " · loading detail" : ""}`,
      start,
    );
    if (mode === "map") drawMap();
    hud.set({ diagnostic: d.stage === "complete" ? "Mapping ready · details ↗" : "Routing preview · detail loading…" });
    // A newly selected hole becomes visible before nonessential scenery/elevation work.
    const needsRefine =
      d.stage !== "complete" || !d.terrainByHole?.[hole.number] || needsUpdate(d) || !d.sceneryUpdated || !d.canopy;
    if (!needsRefine) {
      if (renderer.reveal) renderer.reveal.fast = true;
      fastPill = true;
      setTimeout(() => {
        if (sequence === loadSequence) finishBuild();
      }, 60);
    }
    if (needsRefine) {
      item ??= {
        id: d.id,
        name: d.name,
        center: d.center,
        source: { type: d.id.split("/")[0], id: +d.id.split("/")[1] },
      };
      refineCourse(d, item, signal, sequence, hole.number)
        .finally(() => {
          if (sequence === loadSequence) finishBuild();
          if (!signal.aborted) fastLoad.putCourse(d);
        })
        .catch((e) => {
          if (e.name !== "AbortError") {
            record("background", e.message);
            hud.set({ diagnostic: "Detail failed · retry ↗" });
            toast("Detail load failed. Open Loading details for the reason and retry.");
          }
        });
    }
  } catch (e) {
    if (e.name !== "AbortError" && sequence === loadSequence) {
      lastLoadFailure = { id, n, error: e.message };
      record("load failure", e.message, start);
      hud.set({ diagnostic: /Timed out after/.test(e.message)
        ? "Requests timed out · retry ↗"
        : "Mapping issue · details ↗" });
      hud.set((h) => ({ timings: h.timings.replace("hole geometry loading", "hole geometry unavailable") }));
      if (renderer.overview) {
        toast("The map is ready, but course data could not load. Provider errors are shown in Loading details.");
        act.diagnostics();
      } else {
        openDialog("error", {
          message: e.message,
          retry: () => {
            closeDialog();
            loadCourse(id, n);
          },
        });
      }
    }
  } finally {
    if (sequence === loadSequence) {
      busy = false;
      loadingCourse = false;
      hud.set({ loading: null });
      if (pendingRefresh) refreshWorld(pendingRefresh.d, pendingRefresh.sequence);
      updateSwing();
    }
  }
}
async function refineCourse(d, item, signal, sequence, holeNumber) {
  const detail = async () => {
    if (d.stage !== "complete" || needsUpdate(d)) {
      const response = await requestStage(item, "features", signal, {
        bbox: d.requestBounds,
        facility: d.facilityData,
      });
      signal.throwIfAborted();
      const fresh = parseRouting(item, response);
      d.boundary = fresh.boundary;
      d.holes = fresh.holes;
      d.date = fresh.date;
      d.features = featuresFrom(response.elements);
      d.features.push(...coastalWater(d.features, d.center || item.center));
      d.stage = "complete";
      d.detailVersion = 4;
      cache.set(d.id, d);
      refreshWorld(d, sequence);
    }
  };
  const scenery = async () => {
    if (d.sceneryUpdated || d.id.includes("/") || !d.sourceId) return;
    const [type, id] = d.sourceId.split("/"),
      points = d.boundary.flat(),
      bbox = [
        Math.min(...points.map((p) => p[0])) - 0.001,
        Math.min(...points.map((p) => p[1])) - 0.001,
        Math.max(...points.map((p) => p[0])) + 0.001,
        Math.max(...points.map((p) => p[1])) + 0.001,
      ];
    const sourceItem = { ...item, id: d.sourceId, source: { type, id: Number(id) } };
    const response = await requestScenery(sourceItem, bbox, signal);
    signal.throwIfAborted();
    const existing = new Set(d.features.map((f) => f.id)),
      sceneryKinds = ["tree", "wood", "scrub", "building", "bare_rock"];
    const additions = featuresFrom(response.elements).filter(
      (f) => sceneryKinds.includes(f.kind) && !existing.has(f.id),
    );
    d.features.push(...additions);
    d.sceneryUpdated = true;
    record("scenery", `${additions.length} surrounding features added directly from OSM`);
    cache.set(d.id, d);
    refreshWorld(d, sequence);
  };
  const terrain = async () => {
    const h = d.holes.find((h) => h.number === holeNumber);
    if (!h || d.terrainByHole?.[holeNumber]) return;
    const start = performance.now();
    record("elevation", "Loading native-resolution terrain for this hole…");
    d.terrainErrors ??= {};
    delete d.terrainErrors[holeNumber];
    let value;
    try {
      value = await fetchHoleTerrain(d, h, signal, (message) => record("elevation fallback", message));
    } catch (e) {
      if (!signal.aborted) {
        d.terrainErrors[holeNumber] = e.message;
        cache.set(d.id, d);
        refreshWorld(d, sequence);
      }
      throw e;
    }
    signal.throwIfAborted();
    d.terrainByHole ??= {};
    d.terrainByHole[holeNumber] = value;
    cache.set(d.id, d);
    record(
      "elevation",
      `Mapterhorn z${value.zoom} · ${value.spacing.toFixed(2)} m tile pixels · no coarse resampling`,
      start,
    );
    refreshWorld(d, sequence);
  };
  const contextTerrain = async () => {
    if (d.terrain?.pixelOrigin || d.terrainRequestPending) return;
    const value = await fetchCourseTerrain(d.boundary, signal);
    signal.throwIfAborted();
    d.terrain = value;
    cache.set(d.id, d);
    refreshWorld(d, sequence);
  };
  const canopy = async () => {
    if (d.canopy) return;
    const start = performance.now();
    record("satellite cover", "Reading native 10 m tree-cover pixels directly in your browser…");
    d.canopy = await fetchCanopy(d.boundary, signal);
    signal.throwIfAborted();
    cache.set(d.id, d);
    record(
      "satellite cover",
      "ESA WorldCover 2021 · 10 m grassland/tree/shrub coverage · procedural individual trees",
      start,
    );
    if (sequence === loadSequence && course.id === d.id) {
      course.canopy = d.canopy;
      world.canopy = d.canopy;
      renderer.addTrees();
      renderer.turfWorker?.postMessage({ type: "cover", canopy: d.canopy, focus: renderer.grassOrigin || world.tee });
      renderer.setupLighting();
    }
  };
  const results = await Promise.allSettled([detail(), terrain(), contextTerrain(), scenery(), canopy()]);
  if (signal.aborted) return;
  const errors = results.filter((x) => x.status === "rejected");
  for (const e of errors) record("background", e.reason.message);
  validateBackground(d, sequence);
  if (sequence === loadSequence) {
    const sceneryOnly = results.slice(0, 3).every((r) => r.status === "fulfilled") && results[3].status === "rejected";
    hud.set({ diagnostic: errors.length
      ? sceneryOnly
        ? "Scenery unavailable · details ↗"
        : "Detail incomplete · retry ↗"
      : "Mapping ready · details ↗" });
    if (errors.length && !world.terrainReady)
      toast("Elevation could not load. The flat overview remains available; open details to retry.");
  }
  record(
    "validation",
    `${d.holes.length} distinct holes · ${d.features.length} mapped features · ${d.holes.filter((h) => h.parEstimated).length} yardage-estimated par values.`,
  );
}
function validateBackground(d, sequence) {
  const worker = new Worker(new URL("./validate-worker.js", import.meta.url), { type: "module" }),
    start = performance.now();
  worker.onmessage = ({ data }) => {
    worker.terminate();
    record(
      "geometry validation",
      `${data.checked} closed features checked; ${data.invalid.length} invalid polygons excluded.`,
      start,
    );
    if (data.invalid.length) {
      d.features = d.features.filter((f) => !data.invalid.includes(f.id));
      refreshWorld(d, sequence);
    }
  };
  worker.onerror = () => {
    worker.terminate();
    record("geometry validation", "Background validator unavailable; geometry remains unverified.");
  };
  worker.postMessage({ features: d.features });
}
function refreshWorld(d, sequence) {
  if (sequence !== loadSequence || course.id !== d.id) return;
  if (busy || meter) {
    pendingRefresh = { d, sequence };
    return;
  }
  pendingRefresh = null;
  const inFlight = renderer.cameraMotion.active
    ? {
        pose: {
          position: renderer.camera.position.clone(),
          quaternion: renderer.camera.quaternion.clone(),
          fov: renderer.camera.fov,
          near: renderer.camera.near,
        },
        left: renderer.cameraMotion.active.duration - renderer.cameraMotion.active.elapsed,
        lift: renderer.cameraMotion.active.lift * 0.5,
      }
    : null;
  const becameReady = !world.terrainReady && !!d.terrainByHole?.[hole.number];
  const view = {
    droneElapsed: renderer.droneElapsed,
    type: renderer.cameraType,
    fov: renderer.camera.fov,
    yaw: renderer.cameraType === "free" ? renderer.freeCamera.yaw : renderer.yaw,
    pitch: renderer.cameraType === "free" ? renderer.freeCamera.pitch : renderer.pitch,
    position: renderer.camera.position.clone(),
    target: renderer.controls.target.clone(),
  };
  const updatedHole = d.holes.find((h) => h.number === hole.number);
  if (!updatedHole) {
    record(
      "validation",
      "The refreshed source no longer includes the current hole. Keeping the active scene until another hole is chosen.",
    );
    return;
  }
  course = structuredClone(d);
  hole = course.holes.find((h) => h.number === updatedHole.number);
  world = makeWorld(course, hole, saved.edits[d.id] || {});
  world.physicsConditions = physicsControls.value;
  crossfade();
  renderer.load(world, view.type === "plan" && !renderer.planInGame);
  renderer.courseHoles = course.holes;
  renderer.setBall(round.ball);
  calcSuggested();
  if (becameReady && autoPowerOnTerrain) power = suggested;
  render();
  renderer.setCamera(
    becameReady && mode === "play" && !buildPending && !renderer.autoPlan ? "shot" : view.type,
    round.ball,
    false,
  );
  if (view.type === "fly" && renderer.droneFlight) renderer.droneElapsed = view.droneElapsed || 0;
  if (becameReady && mode === "play") {
    renderControls();
  } else if (view.type === "shot") {
    renderer.yaw = view.yaw;
    renderer.pitch = view.pitch;
    renderer.look(true);
  } else {
    renderer.camera.position.copy(view.position);
    renderer.controls.target.copy(view.target);
    if (view.type === "free") {
      renderer.camera.fov = view.fov;
      renderer.camera.updateProjectionMatrix();
      renderer.freeCamera.yaw = view.yaw;
      renderer.freeCamera.pitch = view.pitch;
      renderer.freeCamera.look();
    }
  }
  persist();
  if (mode === "map") drawMap();
  if (inFlight && mode === "play")
    renderer.cameraMotion.toCurrent(inFlight.pose, Math.max(0.8, inFlight.left), inFlight.lift);
  if (world.terrainReady) renderer.allowFlatShot = false;
}

function lie() {
  if (round.strokes === 0) return "tee";
  return world.surface(round.ball.x, round.ball.z);
}
function chooseClub() {
  const d = distance(round.ball, world.pin) / YARD;
  const options = bagOrder.filter((i) => clubs[i].type !== "putter").sort((a, b) => clubs[a].carry - clubs[b].carry);
  club = lie() === "green" ? 5 : (options.find((i) => clubs[i].carry >= d) ?? 0);
  setCaddieAim(false);
  calcSuggested();
  power = suggested;
}
function setCaddieAim(recalc = true) {
  const target = caddieTarget(world, round.ball, club);
  aim = (Math.atan2(target.x - round.ball.x, -(target.z - round.ball.z)) * 180) / Math.PI;
  if (recalc) {
    calcSuggested();
    renderControls();
    toast("Aim follows the mapped route. Check hazards before playing.");
  }
}
function calcSuggested() {
  if (!world.terrainReady || !world.playable || course.stage !== "complete") {
    suggested = 70;
    return;
  }
  const s = suggest(world, round.ball, club, aim, lie());
  suggested = Math.round(s.power);
}
function render() {
  if (!world) return;
  const routeLength = world.route.slice(1).reduce((s, p, i) => s + distance(p, world.route[i]), 0),
    toPin = distance(round.ball, world.pin),
    elev = (world.elevation(world.pin.x, world.pin.z) - world.elevation(round.ball.x, round.ball.z)) / FT,
    flat = !course.terrain?.pixelOrigin && !course.terrainByHole?.[hole.number],
    flagFt =
      ((world.pin.y ?? world.elevation(world.pin.x, world.pin.z)) -
        (round.ball.y ?? world.elevation(round.ball.x, round.ball.z))) *
      3.28084,
    par = hole.par || 4,
    cur = round.complete ? round.strokes : round.strokes + 1,
    l = lie(),
    plugged = round.strokes && (round.ball.depth || 0) > 0.0107 && l !== "green",
    lieName =
      { tee: "Teeing area", fairway: "Fairway", green: "Putting green", rough: "Rough", bunker: "Bunker", water: "Water", sand: "Sand" }[l] || l,
    tb = course.terrainByHole?.[hole.number];
  hud.set((h) => ({
    course: {
      name: course.name,
      location: course.location,
      routingName: course.id === "pebble" ? "Pebble Beach" : course.name,
      sourceStatus: world.greenAdjustment
        ? "Estimated green contours · 1× terrain"
        : tb
          ? tb.fallback
            ? "Available terrain z" + tb.zoom + " · 1× elevation"
            : "Native terrain · 1× elevation"
          : course.terrain?.pixelOrigin
            ? "Regional terrain"
            : "Terrain loading · flat preview",
    },
    hole: { number: hole.number, par: hole.par ?? null, parEstimated: !!hole.parEstimated, yards: Math.round(routeLength / YARD) },
    distance: toPin < 9 ? (toPin / YARD).toFixed(1) : String(Math.round(toPin / YARD)),
    elevation: flat ? null : { up: elev >= 0, ft: Math.abs(elev).toFixed(0) },
    flag: { yds: Math.round(toPin / YARD), up: flagFt >= 0, ft: Math.abs(flagFt).toFixed(0) },
    strokeTrack: Array.from({ length: Math.max(par, cur) }, (_, i) => {
      const k = i + 1;
      return { k, state: k === cur && !round.complete ? "now" : k < cur || (round.complete && k <= cur) ? "done" : "", over: k > par };
    }),
    strokeLabel: round.complete ? "Holed · " + round.strokes : "Stroke " + (round.strokes + 1),
    lie: lieName + (plugged ? " · plugged" : ""),
    lieQuality: (plugged ? "42%" : { rough: "80%", bunker: "60%", sand: "63%" }[l] || "100%") + " lie",
    holes: course.holes.map((x) => {
      const r = saved.rounds[course.id + ":" + x.number];
      return { n: x.number, par: x.par, parEstimated: !!x.parEstimated, active: x.number === hole.number, completed: !!r?.complete, strokes: r?.strokes };
    }),
    mapping: {
      ...h.mapping,
      quality: {
        title: "",
        text: course.terrainErrors?.[hole.number] ? "Elevation didn't load for this hole. Retry from Loading details." : "",
        warn: world.warnings[0] || "",
      },
    },
    timings: `Map ${timings.map.toFixed(0)} ms · Terrain ${timings.terrain.toFixed(0)} ms · First view ${timings.playable.toFixed(0)} ms`,
    lastShot: round.last
      ? {
          carry: Math.round(round.last.carry / YARD),
          total: Math.round(round.last.total / YARD),
          penalty: round.last.outcome === "water" || round.last.outcome === "out of bounds",
        }
      : null,
  }));
  renderControls();
  updateSwing();
}
// The HUD wind arrow is shot-relative: straight up = blowing toward the target (helping), down = into the golfer.
function updateWindHud() {
  const c = physicsControls?.value;
  if (!c) return;
  const r = windRelative(c, aim),
    mph = (v) => Math.abs(v / 0.44704).toFixed(0),
    along = Math.abs(r.along) < 0.2 ? "" : r.along > 0 ? mph(r.along) + " helping" : mph(r.along) + " into",
    cross = Math.abs(r.cross) < 0.2 ? "" : mph(r.cross) + (r.cross > 0 ? " L→R" : " R→L"),
    text = [along, cross].filter(Boolean).join(" · ") || "calm";
  hud.set({ wind: { speed: c.windSpeed.toFixed(1), bearing: c.windDirection, angle: r.angle, text } });
}
function renderControls() {
  if (!world) return;
  shotPanel.update(round.last);
  renderer.setClub(club);
  const c = clubs[club];
  hud.set({
    club: { abbr: c.abbr, name: c.name, loft: c.loft, range: c.carry + " yd nominal range", thumb: clubThumb(club) || "" },
    clubs: bagOrder.map((i) => ({ i, abbr: clubs[i].abbr, title: clubs[i].name + " · " + clubs[i].loft + "°", active: club === i })),
    aim,
    power,
    suggested,
    powerYards: Math.round((c.carry * power) / 100),
  });
  renderer.setAim(round.ball, aim, (c.carry * YARD * power) / 100);
  updateWindHud();
  const d = distance(round.ball, world.pin) / YARD,
    elev = world.elevation(world.pin.x, world.pin.z) - world.elevation(round.ball.x, round.ball.z);
  hud.set({
    advice:
      lie() === "green"
        ? "Read the slope, then roll it home. The power marker accounts for the regional terrain; fine green contours are not surveyed."
        : d > c.carry * 1.2
          ? "A longer hole rewards a patient approach. Follow the mapped dogleg and inspect the landing area in planning view."
          : `Play ${elev < -2 ? "less club into this downhill approach" : elev > 2 ? "extra club for the climb" : "to the center of the mapped green"}. ${lie() === "bunker" ? "Sand reduces ball speed to 60%." : lie() === "rough" ? "The rough takes 20% off ball speed." : `A simulated ${physicsControls.value.windSpeed.toFixed(1)} mph breeze affects the flight.`} Check the caddie line for hazards.`,
  });
}
function selectClub(i) {
  if (busy || meter) return;
  autoPowerOnTerrain = false;
  club = (i + clubs.length) % clubs.length;
  calcSuggested();
  renderControls();
  persist();
}
function updateSwing() {
  const restartDisabled = busy || !!meter || !!renderer.overview || !world;
  if (!world) {
    hud.set({ restartDisabled, swing: { label: "Take your shot", disabled: true, preciseDisabled: true, metering: false } });
    return;
  }
  hud.set({
    restartDisabled,
    swing: {
      disabled: busy || !world.terrainReady || !world.playable || course.stage !== "complete" || !hole.par,
      preciseDisabled:
        busy || !world.playable || round.complete || !world.terrainReady || course.stage !== "complete" || !hole.par,
      metering: !!meter,
      label: round.complete
        ? "View hole result"
        : meter
          ? "Strike now"
          : busy
            ? loadingCourse
              ? "Opening course…"
              : "Ball in motion…"
            : !world.terrainReady
              ? course.terrainErrors?.[hole.number]
                ? "Elevation unavailable · retry in details"
                : "Sculpting terrain…"
              : course.stage !== "complete"
                ? "Mapping detail…"
                : !hole.par
                  ? "Par unverified"
                  : "Take your shot",
    },
  });
}
function swing() {
  if (renderer.cameraType === "free" && !meter && !busy && mode === "play") {
    act.camera("shot");
  }
  if (
    ["free", "fly"].includes(renderer.cameraType) ||
    renderer.overview ||
    mode !== "play" ||
    busy ||
    !world.terrainReady ||
    !world.playable ||
    course.stage !== "complete" ||
    !hole.par
  )
    return;
  if (round.complete) return completion();
  if (meter) return strike();
  meter = { start: performance.now(), set: power };
  updateSwing();
}
function strike(launchData) {
  if (!meter || busy) return;
  const setPower = meter.set;
  meter = null;
  power = Math.max(1, Math.min(110, power));
  const fill = $("swingMeterFill");
  if (fill) fill.style.width = "0%";
  busy = true;
  updateSwing();
  const result = simulate(world, { ball: round.ball, club, power, aim, lie: lie(), launchData });
  round = applyResult(round, result);
  power = setPower ?? power;
  shotPanel.update(result);
  persist();
  renderer.animateShot(result, () => {
    busy = false;
    if (pendingRefresh) refreshWorld(pendingRefresh.d, pendingRefresh.sequence);
    renderer.setBall(round.ball);
    renderer.ball.visible = !result.holed;
    renderer.setCamera("shot", round.ball);
    chooseClub();
    render();
    persist();
    if (result.holed) completion();
    else if (result.outcome === "water" || result.outcome === "out of bounds")
      toast(
        `${result.outcome === "water" ? "Water penalty" : "Outside inferred course boundary"}: +1 stroke. Replay from your previous position.`,
      );
    else
      toast(
        `${Math.round(result.carry / YARD)} yd carry · ${Math.round(distance(round.ball, world.pin) / YARD)} yd to pin`,
      );
  });
  audio.swing(
    clubs[club].type,
    (result.input?.power ?? power) / 100,
    renderer.shot?.start ?? performance.now(),
    renderer.ball ? renderer.camera.position.distanceTo(renderer.ball.position) : 3,
  );
  booth.shot({
    result,
    start: result.input?.ball || round.ball,
    pin: world.pin,
    surfaceAt: (x, z) => world.surface(x, z),
    club: clubs[result.input?.club ?? club],
    power: result.input?.power ?? power,
    strokes: round.strokes,
    par: hole.par,
    impactAt: renderer.shot?.start ?? performance.now(),
  });
  {
    const cam = renderer.camera.position.clone(),
      follow = renderer.followEnabled !== false;
    audio.ballSounds(
      shotEvents(result.path || [], (x, z) => world.surface(x, z), result.outcome),
      renderer.shot?.start ?? performance.now(),
      (ev) => (follow ? 0.85 : Math.max(0.08, Math.min(1, 14 / Math.hypot(ev.x - cam.x, ev.z - cam.z)))),
    );
  }
}
function completion() {
  const delta = round.strokes - hole.par;
  openDialog("complete", {
    hole: hole.number,
    title: delta === 0 ? "A well-earned par." : delta === -1 ? "A beautiful birdie." : delta <= -2 ? "That’s one to remember." : "Another hole in the book.",
    strokes: round.strokes,
    delta,
    shots: round.shots.length,
    penalties: round.shots.reduce((s, x) => s + x.penalty, 0),
    next: () => {
      closeDialog();
      const i = course.holes.indexOf(hole);
      loadCourse(course.id, course.holes[(i + 1) % course.holes.length].number);
    },
  });
}
function setMode(m) {
  document.body.classList.toggle("is-overview", renderer.overview);
  if (meter || (busy && !loadingCourse)) {
    toast("Finish your shot first.");
    return;
  }
  mode = m;
  hud.set({
    mode: m,
    overview: !!renderer.overview,
    crosshair: m !== "map",
    cameraHint:
      m === "map"
        ? "Drag to orbit · Scroll to zoom · Overlay fades to 0%"
        : "Drag to look · 1 Lie · 2 Overhead · 3 Flyover · 4 Follow · 5 Explore",
  });
  const flagEl = $("flagLabel");
  if (flagEl) flagEl.style.display = m === "play" ? "block" : "none";
  renderer.autoPlan = false;
  renderer.planInGame = m === "play";
  if (!renderer.overview) renderer.setCamera(m === "map" ? "plan" : "shot", round.ball);
  drawMap();
}
function mapBounds() {
  const b = world.courseBBox,
    w = innerWidth || 800,
    h = innerHeight || 550,
    ratio = w / h,
    midX = (b.minX + b.maxX) / 2,
    midZ = (b.minZ + b.maxZ) / 2;
  let width = b.maxX - b.minX,
    height = b.maxZ - b.minZ;
  if (width / height < ratio) width = height * ratio;
  else height = width / ratio;
  return { x: midX - width / 2, z: midZ - height / 2, w: width, h: height };
}
const layerColors = {
  green: "#bed393",
  tee: "#cdd6a1",
  fairway: "#96b378",
  bunker: "#e4cd9c",
  water: "#7eb9bb",
  rough: "#acb997",
};
function drawMap() {
  if (renderer.overview) {
    renderer.setOverviewOpacity(opacity);
    return;
  }
  if (!world || renderer.overview) return;
  renderer.courseHoles = course.holes;
  renderer.setMapping(mode === "map", layers, opacity, imagery);
}
async function loadImagery() {
  const token = ++imageryToken,
    b = mapBounds();
  hud.set((h) => ({ mapping: { ...h.mapping, imageryStatus: "Requesting USGS NAIP aerial imagery…", imageryBusy: true } }));
  const sw = world.toGeo({ x: b.x, z: b.z + b.h }),
    ne = world.toGeo({ x: b.x + b.w, z: b.z });
  const url =
    "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?" +
    new URLSearchParams({
      bbox: [...sw, ...ne].join(","),
      bboxSR: "4326",
      imageSR: "4326",
      size: "1200," + Math.round((1200 * b.h) / b.w),
      format: "jpg",
      f: "image",
      adjustAspectRatio: "false",
    });
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    if (token !== imageryToken) return;
    imagery = { url, b, image: img };
    hud.set((h) => ({ mapping: { ...h.mapping, imageryStatus: "USGS NAIP · acquisition dates vary; seasonal validation not performed.", imageryBusy: false } }));
    drawMap();
  };
  img.onerror = () => {
    if (token !== imageryToken) return;
    hud.set((h) => ({ mapping: { ...h.mapping, imageryStatus: "Imagery unavailable. Geometry is still usable; click to retry.", imageryBusy: false } }));
  };
  img.src = url;
}
function openSearch() {
  if (meter || (busy && !loadingCourse)) return;
  searchItems = catalog;
  hud.set((h) => ({ search: { ...h.search, open: true, query: "" } }));
  renderSearch();
  indexReady.then(() => {
    if (hud.get().search.open) renderSearch();
  });
}
function renderSearch() {
  const query = hud.get().search.query,
    target = query.match(/(?:\bhole\s*|#)(\d{1,2})\s*$/i),
    requestedHole = target ? Number(target[1]) : null,
    q = target ? query.slice(0, target.index).trim() : query;
  window.requestedSearchHole = requestedHole;
  const local = catalog.map((c) => ({ ...c, search: normalize(c.name + " " + c.location) }));
  const candidates = [...local, ...globalIndex.filter((c) => !local.some((l) => l.sourceId === c.id))];
  const items = q.trim() ? searchIndex(candidates, q, 35) : local;
  searchItems = items;
  window.visibleCourses = items;
  hud.set((h) => ({
    search: {
      ...h.search,
      requestedHole,
      items: items.map((c) => ({
        id: c.id,
        name: c.name,
        location: c.location,
        note: c.id.startsWith("node/") ? "No course map yet" : "",
        holes: (cache.get(c.id)?.holes || Array.from({ length: c.holes || 0 }, (_, n) => ({ number: n + 1 }))).map((x) => x.number),
      })),
      empty: globalIndex.length
        ? "No courses match. Try a shorter name or a nearby town."
        : indexError
          ? "Couldn't load the course list."
          : "Loading courses…",
    },
  }));
}
act.searchQuery = (query) => {
  hud.set((h) => ({ search: { ...h.search, query } }));
  renderSearch();
};
act.closeSearch = () => hud.set((h) => ({ search: { ...h.search, open: false } }));
act.openCourse = (id, n) => {
  act.closeSearch();
  loadCourse(id, n ?? hud.get().search.requestedHole ?? null);
};
async function globalSearch() {
  const start = performance.now();
  await indexReady;
  renderSearch();
  record("search", `${searchItems.length} matches from the local index`, start);
}
function restartCurrentHole() {
  if (!course || renderer.overview || busy || meter) return;
  const key = course.id + ":" + hole.number,
    previous = structuredClone(round);
  round = { ball: { ...world.tee }, strokes: 0, complete: false, shots: [], last: null };
  saved.rounds[key] = round;
  renderer.setBall(round.ball);
  renderer.setCamera("shot", round.ball);
  mode = "play";
  setMode("play");
  chooseClub();
  render();
  persist();
  toast(
    "Hole " + hole.number + " restarted.",
    () => {
      if (course.id + ":" + hole.number !== key || busy || meter || round.strokes) return;
      round = previous;
      renderer.setBall(round.ball);
      chooseClub();
      render();
      persist();
      hud.set({ toast: null });
    },
    8000,
  );
}
function scorecard() {
  const teeYds = courseTeeYards(course);
  openDialog("scorecard", {
    courseName: course.name,
    current: hole.number,
    tees: ["blue", "white", "red"]
      .filter((c) => course.holes.some((h) => teeYds[h.number]?.[c]))
      .map((c) => ({ name: c, color: TEE_COLORS[c], yards: Object.fromEntries(course.holes.map((h) => [h.number, teeYds[h.number]?.[c] ?? null])) })),
    holes: course.holes.map((h) => {
      const r = saved.rounds[course.id + ":" + h.number];
      return {
        n: h.number,
        par: h.par ?? null,
        parEstimated: !!h.parEstimated,
        score: r?.complete ? r.strokes : null,
        inProgress: !r?.complete && r?.strokes ? r.strokes : null,
        penalties: r?.shots?.reduce((s, x) => s + (x.penalty || 0), 0) || 0,
      };
    }),
  });
}
act.scorecard = scorecard;
act.downloadRound = () => download("fairway-atlas-round.json", JSON.stringify(saved, null, 2), "application/json");
act.restartHole = () => {
  closeDialog();
  restartCurrentHole();
};

function shotData() {
  const s = round.last;
  if (!s) {
    physicsControls.open();
    return;
  }
  const x = s.stats,
    fmt = (v) => (Number.isFinite(v) ? v.toFixed(1) : "—");
  openDialog("shot", {
    measured: x.source === "measured ball",
    outcome: s.outcome,
    metrics: [
      [fmt(x.clubSpeed), "Club speed · mph"],
      [fmt(x.ballSpeed), "Ball speed · mph"],
      [fmt(x.launch) + "°", "Ball elevation"],
      [fmt(x.direction) + "°", "Ball direction"],
      [fmt(x.attack) + "°", "Attack angle"],
      [Math.round(x.spin), "Backspin · rpm"],
      [Math.round(x.sideSpin || 0), "Side spin · rpm"],
      [fmt(x.axis) + "°", "Spin axis"],
      [fmt(x.pathAngle) + "°", "Club path"],
      [fmt(x.faceAngle) + "°", "Face angle"],
      [fmt(x.dynamicLoft) + "°", "Dynamic loft"],
      [x.impactPoint ? fmt(x.impactPoint.x) + ", " + fmt(x.impactPoint.y) : "—", "Impact x, y · mm"],
      [fmt(s.carry / YARD), "Carry · yards"],
      [fmt(s.total / YARD), "Total · yards"],
      [fmt(s.duration), "Shot time · sec"],
    ],
  });
}
act.shotData = shotData;
act.launchInput = () => {
  closeDialog();
  physicsControls.open();
};

function sources() {
  openDialog("sources", {
    course: { name: course.name, location: course.location, sourceId: course.sourceId, date: course.date, holes: course.holes.length },
    hole: { number: hole.number, id: hole.id },
    warnings: world.warnings,
    gameName: GAME_NAME,
    fps: renderer.fps,
    resolution: [renderer.gpu?.w ?? 0, renderer.gpu?.h ?? 0],
    timings: { ...timings },
  });
}
act.sources = sources;
function editMap() {
  const nearby = world.surfaces.filter((f) =>
    f.points.some(
      (p) => p[0] > world.bbox.minX && p[0] < world.bbox.maxX && p[1] > world.bbox.minZ && p[1] < world.bbox.maxZ,
    ),
  );
  openDialog("edit", { features: nearby.map((f) => ({ id: f.id, kind: f.kind })), routing: course.holes.map((h) => h.number).join(", "), message: "" });
}
act.editMap = editMap;
const editMessage = (message) => hud.set((h) => ({ dialog: h.dialog && { ...h.dialog, message } }));
act.saveEdits = ({ feature, dx, dz, routing }) => {
  if (round.strokes) return editMessage("Restart the hole before changing its geometry.");
  const order = routing.split(",").map((x) => Number(x.trim())),
    refs = course.holes.map((h) => h.number);
  if (order.length !== refs.length || new Set(order).size !== refs.length || order.some((x) => !refs.includes(x)))
    return editMessage("Include every mapped hole number exactly once.");
  if (!Number.isFinite(dx) || !Number.isFinite(dz) || Math.abs(dx) > 50 || Math.abs(dz) > 50)
    return editMessage("Offsets must be between −50 and +50 metres.");
  saved.edits[course.id] ??= {};
  saved.edits[course.id][feature] = { dx, dz, evidence: "user-edited", date: new Date().toISOString() };
  saved.routing[course.id] = order;
  persist();
  closeDialog();
  loadCourse(course.id, hole.number);
};
act.clearEdits = () => {
  if (round.strokes) return editMessage("Restart the hole before changing its geometry.");
  delete saved.edits[course.id];
  delete saved.routing[course.id];
  course.holes.sort((a, b) => a.number - b.number);
  persist();
  closeDialog();
  loadCourse(course.id, hole.number);
};
function download(name, data, type) {
  const a = document.createElement("a"),
    url = URL.createObjectURL(new Blob([data], { type }));
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportMap() {
  const features = world.features.map((f) => ({
    type: "Feature",
    geometry: {
      type: f.closed ? "Polygon" : "LineString",
      coordinates: f.closed ? [(f.sourcePoints || f.points).map((p) => world.toGeo({ x: p[0], z: p[1] }))] : f.coords,
    },
    properties: {
      id: f.id,
      kind: f.kind,
      source: f.source,
      evidence: saved.edits[course.id]?.[f.id] ? "user-edited" : f.evidence,
      license: "ODbL-1.0",
    },
  }));
  download(
    course.id.replace("/", "-") + "-features.geojson",
    JSON.stringify({ type: "FeatureCollection", attribution: "© OpenStreetMap contributors, ODbL", features }, null, 2),
    "application/geo+json",
  );
}
function help() {
  openDialog("help");
}
act.toggleFollow = () => {
  renderer.followEnabled = !renderer.followEnabled;
  saved.followCamera = renderer.followEnabled;
  persist();
  hud.set({ follow: renderer.followEnabled });
  toast(
    renderer.followEnabled ? "Follow camera on · tracks flight and landing" : "Follow camera off · watch from your lie",
  );
};
act.restart = restartCurrentHole;
act.setMode = setMode;
act.openSearch = openSearch;
act.help = help;
act.exportMap = exportMap;
act.loadImagery = loadImagery;
act.swing = swing;
act.preciseShot = () => {
  if (
    busy ||
    meter ||
    round.complete ||
    mode !== "play" ||
    ["free", "fly"].includes(renderer.cameraType) ||
    course.stage !== "complete" ||
    !hole.par ||
    !world.terrainReady ||
    !world.playable
  )
    return;
  meter = {};
  strike();
};
act.selectClub = selectClub;
act.nextClub = () => selectClub(bagOrder[(bagOrder.indexOf(club) + 1) % bagOrder.length]);
act.prevClub = () => selectClub(bagOrder[(bagOrder.indexOf(club) - 1 + bagOrder.length) % bagOrder.length]);
act.caddieAim = () => {
  if (!busy && !meter) setCaddieAim();
};
act.setAim = (v, done) => {
  if (busy || meter) return;
  aim = v;
  renderControls();
  if (done) {
    calcSuggested();
    renderControls();
    persist();
  }
};
act.setPower = (v) => {
  if (busy || meter) return;
  autoPowerOnTerrain = false;
  power = v;
  renderControls();
  persist();
};
act.setOpacity = (v) => {
  opacity = v / 100;
  hud.set((h) => ({ mapping: { ...h.mapping, opacity: v } }));
  drawMap();
};
act.setLayer = (k, on) => {
  layers[k] = on;
  hud.set((h) => ({ mapping: { ...h.mapping, layers: { ...layers } } }));
  drawMap();
};
hud.set((h) => ({ mapping: { ...h.mapping, layers: { ...layers }, colors: layerColors, opacity: Math.round(opacity * 100) } }));
act.camera = (type) => {
  if (renderer.overview || busy || meter) return;
  if (type === "plan") {
    setMode(mode === "map" ? "play" : "map");
    return;
  }
  renderer.autoPlan = false;
  buildReadyAt = 0;
  if (mode === "map" && type === "free") setMode("play");
  if (mode === "map" && type === "shot") {
    setMode("play");
    return;
  }
  renderer.setCamera(type, round.ball);
  hud.set({ tool: { shot: "play", fly: "fly", free: "free" }[type] || "play" });
};
act.zoom = (d) => renderer.zoom(d);
act.fullScreen = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
};
act.setVisual = (m) => {
  visual = m;
  renderer.setMode(m);
  hud.set({ visual });
  persist();
};
act.loadHole = (n) => loadCourse(course.id, n);
act.greenOverlook = () => renderer.freeCamera.overlook();
act.exitFree = () => act.camera("shot");
act.setCache = (on) => {
  fastLoad.setEnabled(on);
  toast(on ? "Courses you've played open on the tee" : "Courses build from scratch each time");
};
{
  let on = false;
  try {
    on = localStorage.getItem("fa-hdr") === "1";
  } catch {}
  const hdrOK = typeof matchMedia === "function" && matchMedia("(dynamic-range: high)").matches;
  hud.set({ dock: { cache: fastLoad.enabled(), hdr: on, hdrOK, dev: globalThis.__FA_DEV__ !== false } });
  act.setHdr = (on) => {
    try {
      localStorage.setItem("fa-hdr", on ? "1" : "0");
    } catch {}
    const g = renderer.gpu;
    if (g?.setHDR) {
      g.setHDR(on);
      toast(
        on
          ? hdrOK
            ? "HDR on"
            : "HDR on, but this display may not support it"
          : "HDR off",
      );
    }
  };
}
if (globalThis.__FA_DEV__ !== false) {
  window.__hot = () => fastLoad.hotReload(renderer);
  window.__fastLoad = fastLoad;
  act.hotReload = async (engineOnly) => {
    if (!engineOnly) {
      window.__reloadAll();
      return;
    }
    try {
      const r = await window.__hot();
      toast(r.errors ? "Reloaded with errors: " + r.errors : "Engine reloaded in " + r.ms + " ms");
    } catch (err) {
      toast("Hot reload failed: " + err.message);
      console.error(err);
    }
  };
}
renderer.onFreeRequest = () => {
  if (renderer.overview || busy || meter || renderer.cameraType === "fly" || renderer.shot) return false;
  act.camera("free");
  return renderer.cameraType === "free";
};
// Hole numbers floating over the course map; positioned every frame, so written straight to the DOM.
{
  let built = "";
  renderer.onHoleMarkers = () => {
    const hm = $("holeMarkers");
    if (!hm) return;
    const on = mode === "map" && !renderer.overview;
    hm.style.display = on ? "block" : "none";
    if (!on) return;
    const list = renderer.holeScreens();
    const key = list.map((o) => o.n).join() + "|" + hole?.number;
    if (key !== built) {
      built = key;
      hm.innerHTML = list
        .map(
          (o) =>
            `<button data-n="${o.n}" class="${o.n === hole?.number ? "current" : ""}" aria-label="Go to hole ${o.n}">${o.n}</button>`,
        )
        .join("");
      hm.querySelectorAll("button").forEach(
        (b) =>
          (b.onclick = () => {
            setMode("play");
            loadCourse(course.id, +b.dataset.n);
          }),
      );
    }
    const els = hm.children;
    list.forEach((o, i) => {
      const e = els[i];
      if (!e) return;
      e.style.display = o.visible ? "flex" : "none";
      e.style.transform = `translate(${o.x}px,${o.y}px) translate(-50%,-50%)`;
    });
  };
}

const held = new Set();
let heldT = 0,
  heldLast = 0;
function pressArrow(k) {
  if (held.has(k)) return;
  held.add(k);
  heldT = -0.28;
  if (k === "ArrowLeft" || k === "ArrowRight")
    aim = Math.max(-180, Math.min(180, aim + (k === "ArrowLeft" ? -0.5 : 0.5)));
  else power = Math.max(1, Math.min(110, Math.round(power) + (k === "ArrowUp" ? 1 : -1)));
  queueControls(false);
}
function releaseArrow(k) {
  if (!held.delete(k)) return;
  if (k === "ArrowUp" || k === "ArrowDown") {
    power = Math.round(power);
    queueControls(false);
  }
}
window.addEventListener("keyup", (e) => releaseArrow(e.key));
window.addEventListener("blur", () => {
  held.clear();
  power = Math.round(power);
});
function stepHeld(now) {
  const dt = Math.min(0.1, (now - (heldLast || now)) / 1000);
  heldLast = now;
  if (!held.size || mode !== "play" || busy || meter) return;
  heldT += dt;
  if (heldT <= 0) return;
  const acc = 1 + Math.min(4, heldT * 2.2),
    da = (held.has("ArrowRight") ? 1 : 0) - (held.has("ArrowLeft") ? 1 : 0),
    dp = (held.has("ArrowUp") ? 1 : 0) - (held.has("ArrowDown") ? 1 : 0);
  if (da) aim = Math.max(-180, Math.min(180, aim + da * 6 * acc * dt));
  if (dp) power = Math.max(1, Math.min(110, power + dp * 10 * acc * dt));
  if (da || dp) queueControls(false);
}
let toolState = "";
function syncTools(r) {
  const t = r.overview ? "overview" : mode === "map" ? "map" : r.cameraType === "fly" ? "fly" : r.cameraType === "free" ? "free" : "play";
  if (t !== toolState) hud.set({ tool: t, freeHelp: t === "free" });
  toolState = t;
}
let ctlFrame = 0,
  ctlIdle = 0,
  ctlSuggest = false;
function queueControls(suggest) {
  ctlSuggest ||= suggest;
  if (!ctlFrame)
    ctlFrame = requestAnimationFrame(() => {
      ctlFrame = 0;
      renderControls();
    });
  clearTimeout(ctlIdle);
  ctlIdle = setTimeout(() => {
    if (ctlSuggest) {
      ctlSuggest = false;
      calcSuggested();
      renderControls();
    }
    persist();
  }, 250);
}
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openSearch();
    return;
  }
  const ui = hud.get();
  if (ui.search.open || ui.dialog || ui.launchInput) return;
  if (renderer.overview || ui.settingsOpen) return;
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName) || document.activeElement.closest?.("[role=slider],[role=dialog]"))
    return;
  if (renderer.cameraType === "free" && e.key === "5") return;
  if (e.key === "Escape" && mode === "play" && !busy && !meter && !renderer.overview) {
    /* Esc #1 in free camera: hold it where it is; Esc #2: back to the ball; at the ball Esc just resets the view */ if (
      renderer.cameraType === "free" &&
      !renderer.freeCamera.frozen
    ) {
      renderer.freeCamera.setFrozen(true);
      return;
    }
    renderer.freeCamera.setFrozen(false);
    act.camera("shot");
    renderer.yaw = renderer.aim;
    renderer.look(true);
    return;
  }
  if (e.code === "Space") {
    e.preventDefault();
    if (renderer.cameraType === "fly") {
      act.camera("shot");
      return;
    }
    if (!e.repeat) swing();
    return;
  }
  if (mode !== "play" || busy || meter) return;
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
    e.preventDefault();
    if (!e.repeat) pressArrow(e.key);
  }
  if (e.key === "-" || e.key === "_" || e.key.toLowerCase() === "c")
    selectClub(bagOrder[(bagOrder.indexOf(club) + 1) % bagOrder.length]);
  if (e.key === "+" || e.key === "=")
    selectClub(bagOrder[(bagOrder.indexOf(club) - 1 + bagOrder.length) % bagOrder.length]);
  if (["1", "2", "3", "5"].includes(e.key))
    act.camera({ 1: "shot", 2: "plan", 3: "fly", 5: "free" }[e.key]);
});
window.addEventListener("resize", () => {
  if (mode === "map") drawMap();
});
// Feature-detected agent interface. These tools call the same actions as visible controls.
if (document.modelContext?.registerTool) {
  const life = new AbortController();
  const register = (t) =>
    Promise.resolve(document.modelContext.registerTool(t, { signal: life.signal })).catch(() => {});
  register({
    name: "read_golf_state",
    description: "Read current course, hole, shot state and mapping warnings.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: async () => ({
      course: renderer.overview ? renderer.overviewItem?.name : course?.name,
      hole: renderer.overview ? null : hole?.number,
      loading: loadingCourse,
      overview: renderer.overview,
      providerOrder: getProviderOrder(),
      providerAttempts: providerAttempts.slice(-12),
      ball: round?.ball,
      strokes: round?.strokes,
      complete: round?.complete,
      club: clubs[club].abbr,
      power,
      aim,
      warnings: world?.warnings,
      view: renderer.cameraType,
      cameraTransition: !!renderer.cameraMotion.active,
      droneProgress: renderer.droneFlight ? renderer.droneElapsed / renderer.droneFlight.duration : null,
      lighting: {
        ...renderer.lighting,
        altitude: renderer.sunState.altitude,
        azimuth: renderer.sunState.azimuth,
        terrainShadows: renderer.userEffects.terrainShadows !== false,
      },
      graphics: {
        ...renderer.renderStats(),
        fps: renderer.fps,
        internalResolution: renderer.gpu ? [renderer.gpu.w, renderer.gpu.h] : null,
      },
      followCamera: renderer.followEnabled,
      cameraPosition: renderer.camera.position.toArray(),
      ballHeight: renderer.ball.position.y,
      shotInMotion: !!renderer.shot,
      mappingOpacity: opacity,
      mappingVisible: !!renderer.mappingMesh?.visible,
      sceneScope: renderer.courseView ? "course" : "hole",
      mappedHoles: course?.holes.length,
      courseBounds: world?.courseBBox,
      renderedBounds: renderer.terrainBox,
      terrain: world
        ? {
            tee: world.elevation(world.tee.x, world.tee.z),
            pin: world.elevation(world.pin.x, world.pin.z),
            spacing: world.terrainSpacing,
            source: course.terrainByHole?.[hole.number]?.source || course.terrain?.source,
          }
        : null,
    }),
  });
  register({
    name: "open_mapped_hole",
    description: "Open a cached course and mapped hole; preserve saved progress.",
    inputSchema: {
      type: "object",
      properties: {
        course: { type: "string", enum: ["pebble", "raccoon"] },
        hole: { type: "integer", minimum: 1, maximum: 18 },
      },
      required: ["course", "hole"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    execute: async (input) => {
      if (
        !catalog.some((c) => c.id === input.course) ||
        !Number.isInteger(input.hole) ||
        input.hole < 1 ||
        input.hole > 18
      )
        throw Error("Invalid cached course or hole");
      if (busy || meter) throw Error("A shot or course load is active");
      await loadCourse(input.course, input.hole);
      return { course: course.name, hole: hole.number };
    },
  });
}

act.cancelLoad = () => {
  loadController?.abort();
  loadSequence++;
  busy = false;
  loadingCourse = false;
  hud.set({ loading: null });
  if (renderer.overview && world) {
    renderer.load(world);
    render();
    hud.set({ roundDisabled: false });
    setMode(mode);
  }
  record("load", "Cancelled by player");
  updateSwing();
};
function renderDiagnostics() {
  if (hud.get().dialog?.kind !== "diagnostics") return;
  hud.set((h) => ({
    dialog: {
      ...h.dialog,
      log: diagnostics.map((r) => `${r.time}  ${r.stage}${r.ms !== undefined ? " · " + r.ms + " ms" : ""}\n${r.message}`).join("\n\n"),
    },
  }));
}
act.diagnostics = () => {
  openDialog("diagnostics", {
    order: getProviderOrder().join(","),
    orders: [
      ["editing", "postpass", "overpass"],
      ["editing", "overpass", "postpass"],
      ["postpass", "editing", "overpass"],
      ["postpass", "overpass", "editing"],
      ["overpass", "editing", "postpass"],
      ["overpass", "postpass", "editing"],
    ].map((keys) => [keys.join(","), keys.map((k) => PROVIDERS[k].name).join(" → ")]),
    log: "",
  });
  renderDiagnostics();
};
act.setProviderOrder = (v) => {
  setProviderOrder(v.split(","));
  hud.set((h) => ({ dialog: h.dialog && { ...h.dialog, order: v } }));
};
act.retryLoad = () => {
  closeDialog();
  if (lastLoadFailure) {
    loadCourse(lastLoadFailure.id, lastLoadFailure.n);
    return;
  }
  if (course) {
    if (course.id.includes("/")) cache.delete(course.id);
    loadCourse(course.id, hole.number);
  }
};
document.addEventListener("data-progress", renderDiagnostics);
document.addEventListener("data-progress", ({ detail: { stage, message } }) => {
  if (!buildPending || renderer.reveal?.want.elev) return;
  const m = String(message);
  const t =
    stage === "elevation" || stage === "course elevation"
      ? /Loading|Reading|request/i.test(m)
        ? "Calculating elevation…"
        : "Sculpting terrain…"
      : stage === "satellite cover"
        ? /Reading/i.test(m)
          ? "Fetching satellite…"
          : "Calculating foliage…"
        : stage === "scenery"
          ? /added/i.test(m)
            ? "Mapping buildings…"
            : "Finding surroundings…"
          : ["features", "routing", "boundary"].includes(stage)
            ? "Finding boundaries…"
            : null;
  if (t) buildStage(t);
});

const initialLink = readShareState(location.href);
await loadCourse(
  initialLink.course || (initialLink.hasRoute ? "pebble" : saved.last?.course) || "pebble",
  initialLink.hole || (initialLink.hasRoute ? 1 : saved.last?.hole) || 7,
  { fromLink: initialLink.hasRoute },
);
window.addEventListener("popstate", () => {
  const link = readShareState(location.href);
  sceneSettings.applyURL();
  if (link.hasRoute) loadCourse(link.course || "pebble", link.hole || 1, { fromLink: true });
});

// Performance overlay: press ` (backquote) to toggle. Real frame rate from rAF spacing, CPU time per
// tick, and (Detailed timing) GPU timestamps per engine pass.
// Frame-rate card (bottom right) opens the Performance & effects panel: switches + live GPU timing per feature.
installPerfPanel(renderer);
renderer.onMouseLook = (on) => toast(on ? "Mouse look on" : "Mouse look paused · middle-click to resume");
// Debug helpers (only with ?debug): drive frames while the tab is hidden and pose the GPU camera.
if (globalThis.__FA_DEV__ !== false && /[?&]debug\b/.test(location.search)) {
  window.__settle = async (ms = 38000) => {
    const R = renderer;
    let t = performance.now();
    const t0 = t;
    while (performance.now() - t0 < ms) {
      if (document.visibilityState === "hidden") {
        t = Math.max(t + 16, performance.now());
        R.tick(t);
      }
      if (R.cameraType === "shot" && !R.cameraMotion.active && R.camera.position.y < 100 && R.gpu !== undefined)
        return true;
      await new Promise((r) => setTimeout(r, document.visibilityState === "hidden" ? 0 : 100));
    }
    return false;
  };
  import("./debug-tools.js");
  window.__world = () => world;
  window.__r = renderer;
  window.__capture = async (name = "frame", n = 6) => {
    const R = renderer;
    const was = R.manual;
    R.manual = true;
    let t = performance.now();
    for (let i = 0; i < n; i++) {
      t += 16;
      R.tick(t);
    }
    const blob = await new Promise((r) => R.canvas.toBlob(r, "image/png"));
    R.manual = was;
    if (!was) R.tick(performance.now());
    const r = await fetch("/__audio/capture?name=" + encodeURIComponent(name), { method: "POST", body: blob });
    return r.ok ? blob.size : "fail";
  };
  window.__look = (eye, target, n = 24) => {
    const R = renderer;
    if (R.gpu) R.gpu.debugPose = eye ? { eye, target } : null;
    R.manual = !!eye;
    let t = performance.now();
    for (let i = 0; i < n; i++) {
      t += 16;
      R.tick(t);
    }
    if (!eye) {
      R.manual = false;
      R.tick(performance.now());
    }
  };
}

// ---- Time of day: slider ends follow the sun, sunrise+20 min .. sunset-20 min (renderer.sunWindow)
{
  const fmt = (x) => {
    const H = Math.floor(x),
      M = Math.round((x - H) * 60) % 60;
    return `${((H + 11) % 12) + 1}:${String(M).padStart(2, "0")} ${H < 12 ? "AM" : "PM"}`;
  };
  const sync = () => {
    const W = renderer.sunWindow,
      hour = renderer.lighting?.hour ?? 15.5;
    hud.set({
      time: {
        hour,
        label: fmt(hour),
        min: W ? +W.start.toFixed(3) : 6,
        max: W ? +W.end.toFixed(3) : 18,
        title: W ? `Sunrise ${fmt(W.rise)} · sunset ${fmt(W.set)} (local solar time)` : "",
      },
    });
  };
  let raf = 0;
  act.setHour = (hour) => {
    hud.set((h) => ({ time: { ...h.time, hour, label: fmt(hour) } }));
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      renderer.setLighting({ hour });
      const u = new URL(location.href);
      u.searchParams.set("time", (+hour).toFixed(2));
      history.replaceState(null, "", u);
    });
  };
  renderer.grassMode = "blades";
  renderer.canopyStyle = +(new URLSearchParams(location.search).get("canopy") || 0);
  sync();
  setTimeout(sync, 1500);
  let last = "";
  setInterval(() => {
    const W = renderer.sunWindow,
      k = W ? W.start + "|" + W.end : "";
    if (k !== last) {
      last = k;
      sync();
    }
  }, 1000);
}
installTouchControls(renderer, () => swing());
// Export the current hole for the Unreal Engine prototype (fairway-atlas-unreal): heightmap, surface masks, foliage, metadata.
// internal tool (Unreal prototype): dev builds only
if (globalThis.__FA_DEV__ !== false) {
  window.fairwayExportUnreal = async () => {
    if (!world?.terrainReady) throw Error("Wait for the hole to finish building.");
    const w = Object.assign(Object.create(world), {
      hole: { number: hole?.number, par: hole?.par },
      courseName: course?.name,
    });
    const out = await exportUnreal(w, renderer, { onProgress: (m) => toast("Unreal export: " + m) });
    const where = await saveExport(out);
    toast(
      `Unreal export saved to ${where} (${out.meta.heightmap.resolution}² @ ${out.meta.heightmap.spacing_m} m, ${out.meta.foliage.count} plants)`,
    );
    return out.meta;
  };
  act.exportUnreal = () => window.fairwayExportUnreal().catch((e) => toast(e.message));
}
