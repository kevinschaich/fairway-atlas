// Frame-rate card (bottom right) and the Performance & effects control panel it opens.
// The card shows fps, frame time and a live frame-time graph. The panel lists every rendering feature with its on/off
// switch and the GPU time it costs this frame (per-pass timestamps from gpu/timing.js, grouped by feature). Numbers and
// bars refresh every 0.25 s; every 3 s the rows slide into order of cost. Core systems that cannot be switched off are
// listed too, so the rows add up to the whole GPU frame. CPU sections and GPU memory sit below.
import { EFFECTS } from "./render-effects.js";
import { updateShareURL } from "./share-state.js";

const CORE = [
  ["ground", "Terrain", "Depth prepass, base material G-buffer and lighting of the ground"],
  ["sand", "Bunkers", "Bunker sand strip material and the soil lip walls"],
  ["objects", "Objects", "Ball, club, flag and other small scene objects (buildings join them when on)"],
  ["sky", "Sky", "Atmosphere lookup and sky dome"],
  ["post", "Post & upscaling", "Temporal upscale, exposure, tone map, grade, sharpen"],
  ["monitor", "Performance monitor", "This panel and the fps card: refresh, layout, graph (CPU per frame)"],
  ["other", "Other GPU work", "Passes not attributed to a feature"],
];
// GPU pass label -> owning row. `split`: time is shared evenly between the owners that are on; otherwise the first owner
// that is on takes all of it.
const OWNERS = [
  [/^sun shadows \(ground\)/, ["shadows"]],
  [/^terrain shadows \(ground\)/, ["terrainShadows"]],
  [/^cloud shadows \(ground\)/, ["clouds"]],
  [/^ambient occlusion \(ground\)/, ["ao"]],
  [/^ground detail/, ["surfaceDetail"]],
  [/^haze \(ground\)/, ["atmosphere"]],
  [/^bunker sand/, ["sand"]],
  [/^terrain material|^lighting \(ground\)|^terrain: depth prepass/, ["ground"]],
  [/^grass scatter|^main: turf shells|^main: grass blades/, ["grass"]],
  [/^maps: relief AO/, ["ao"]],
  [/^maps: relief/, ["surfaceDetail"]],
  [/^shadow map cascade/, ["shadows"]],
  [/^maps: terrain shadow/, ["terrainShadows"]],
  [/^maps: cloud shadow/, ["clouds"]],
  [/^volumetrics: clouds/, ["clouds", "atmosphere"], true],
  [/^volumetrics: composite|^volumetrics: filter/, ["atmosphere"]],
  [/^bloom/, ["bloom"]],
  [/^ocean/, ["water"]],
  [/^main: trees/, ["trees"]],
  [/^main: objects/, ["buildings", "objects"]],
  [/^main: bunker/, ["sand"]],
  [/^main: ground|^main: map view|^terrain:/, ["ground"]],
  [/^sky LUT|^main: sky/, ["sky"]],
  [/^TAAU|^local exposure|^post/, ["post"]],
  [/ballast/, []],
  [/^probe:/, []],
];
const NOTES = {
  surfaceDetail: "Shaded inside the terrain pass",
  tracer: "Drawn with the objects pass",
  buildings: "Drawn in the objects pass",
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (v) => (v >= 10 ? v.toFixed(1) : v.toFixed(2));

export function installPerfPanel(renderer) {
  // ---------- frame sampling (independent of the renderer so it measures what the display actually gets)
  // the monitor's own main-thread cost, measured so it can be listed as a row (layout is forced inside the timed region)
  const self = { update: 0, tick: 0, graph: 0, frames: 0 },
    selfAvg = { update: 0, tick: 0, graph: 0 };
  const gaps = [];
  let last = performance.now();
  // graph history: one point per 100 ms (mean frame time in that window), 64 points = 6.4 s on screen
  const BUCKET = 100,
    hist = new Float32Array(64);
  let hn = 0,
    bAcc = 0,
    bN = 0,
    bT = performance.now();
  const loop = (t) => {
    const d = t - last;
    last = t;
    if (d > 0 && d < 1000) {
      gaps.push(d);
      if (gaps.length > 120) gaps.shift();
      bAcc += d;
      bN++;
    }
    if (t - bT >= BUCKET && bN) {
      hist[hn % hist.length] = bAcc / bN;
      hn++;
      bAcc = 0;
      bN = 0;
      bT = t;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  const frameStats = () => {
    if (!gaps.length) return { avg: 0, p95: 0, fps: 0 };
    const s = [...gaps].sort((a, b) => a - b),
      avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    return { avg, p95: s[Math.floor(s.length * 0.95)] || avg, fps: 1000 / avg };
  };

  // ---------- the card
  const card = document.createElement("button");
  card.id = "fpsCard";
  card.type = "button";
  card.setAttribute("aria-expanded", "false");
  card.setAttribute("aria-controls", "fxPanel");
  card.title = "Performance & effects (`)";
  card.innerHTML =
    '<span class="fc-fps"><b>--</b><small>fps</small></span><canvas class="fc-graph" aria-hidden="true"></canvas><span class="fc-frame">frame <b>--</b> ms</span>';
  document.body.append(card);
  const cv = card.querySelector("canvas"),
    cx = cv.getContext("2d"),
    fpsEl = card.querySelector(".fc-fps b"),
    frameEl = card.querySelector(".fc-frame b");
  let yMax = 125,
    lastDraw = 0;
  const drawGraph = (now) => {
    if (now - lastDraw < 33) return;
    lastDraw = now;
    const dpr = Math.min(2, devicePixelRatio || 1),
      w = cv.clientWidth,
      h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, w, h);
    const n = Math.min(hn, hist.length);
    if (n < 2) return;
    let top1 = 0;
    for (let i = 0; i < n; i++) top1 = Math.max(top1, 1000 / Math.max(hist[i], 1));
    yMax += (Math.max(125, top1 * 1.06) - yMax) * 0.1; // fps scale from 0: drops read as dips, the 120 target sits near the top
    const pad = 3,
      top = 4,
      bot = h - 3,
      y = (v) => bot - (Math.min(v, yMax) / yMax) * (bot - top),
      sc = Math.min(1, (now - bT) / BUCKET),
      x = (i) => pad + (w - pad * 2 - 4) * ((i - sc) / (hist.length - 1)); // sc: sub-bucket offset so the trace scrolls continuously
    const H = (i) => 1000 / Math.max(hist[(hn - n + Math.max(0, Math.min(n - 1, i))) % hist.length], 1);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const v = (H(i - 2) + H(i - 1) * 2 + H(i) * 3 + H(i + 1) * 2 + H(i + 2)) / 9;
      pts.push([x(hist.length - n + i), y(v)]);
    } // 5-tap smoothing of frames per second: vsync jitter reads as a line, drops still dip
    // target line: 120 fps
    cx.setLineDash([2, 3]);
    cx.strokeStyle = "rgba(219,234,180,.28)";
    cx.lineWidth = 1;
    cx.beginPath();
    const ty = Math.round(y(120)) + 0.5;
    cx.moveTo(pad, ty);
    cx.lineTo(w - pad, ty);
    cx.stroke();
    cx.setLineDash([]);
    const g = cx.createLinearGradient(0, top, 0, bot);
    g.addColorStop(0, "rgba(219,234,180,.24)");
    g.addColorStop(1, "rgba(219,234,180,0)");
    cx.beginPath();
    cx.moveTo(pts[0][0], bot);
    for (const p of pts) cx.lineTo(p[0], p[1]);
    cx.lineTo(pts.at(-1)[0], bot);
    cx.closePath();
    cx.fillStyle = g;
    cx.fill();
    cx.beginPath();
    pts.forEach((p, i) => (i ? cx.lineTo(p[0], p[1]) : cx.moveTo(p[0], p[1])));
    cx.strokeStyle = "#dbeab4";
    cx.lineWidth = 1.4;
    cx.lineJoin = "round";
    cx.stroke();
    const e = pts.at(-1);
    cx.fillStyle = "rgba(219,234,180,.25)";
    cx.beginPath();
    cx.arc(e[0], e[1], 4, 0, 7);
    cx.fill();
    cx.fillStyle = "#eef6d6";
    cx.beginPath();
    cx.arc(e[0], e[1], 2, 0, 7);
    cx.fill();
  };
  const gl = (t) => {
    if (!document.hidden && !card.hidden) {
      const t0 = performance.now();
      drawGraph(t);
      self.graph += performance.now() - t0;
    }
    self.frames++;
    requestAnimationFrame(gl);
  };
  requestAnimationFrame(gl);

  // ---------- the panel
  const panel = document.createElement("section");
  panel.id = "fxPanel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Performance and effects");
  const rows = [
    ...EFFECTS.map(([key, label, help, parent]) => ({ key, label, help, parent, toggle: true })),
    ...CORE.map(([key, label, help]) => ({ key, label, help, toggle: false })),
  ];
  panel.innerHTML = `<div class="fx-head"><div><small>RENDERING</small><h2>Performance &amp; effects</h2></div><button type="button" class="fx-close" aria-label="Close">×</button></div>
 <div class="fx-tiles">
  <div class="fx-tile"><small>Frame rate</small><b data-s="fps">--</b><span data-s="fpsSub">--</span></div>
  <div class="fx-tile"><small>GPU</small><b data-s="gpu">--</b><span data-s="gpuSub">measuring…</span></div>
  <div class="fx-tile"><small>CPU tick</small><b data-s="cpu">--</b><span data-s="cpuSub">--</span></div>
 </div>
 <div class="fx-meta" data-s="meta"></div>
 <div class="fx-scroll"><div class="fx-label"><span>GPU time by feature</span><span>ms · share of frame</span></div>
 <ol class="fx-list">${rows
   .map(
     (r) => `<li class="fx-row${r.toggle ? "" : " is-core"}" data-row="${r.key}">
  <div class="fx-top"><div class="fx-name"><b>${esc(r.label)}</b><small>${esc(r.help)}</small></div>
   <div class="fx-ms"><b>--</b><small>ms</small><em>--</em></div>
   ${r.toggle ? `<label class="fx-switch"><input type="checkbox" role="switch" data-effect="${r.key}" aria-label="${esc(r.label)}"><span></span></label>` : '<span class="fx-core">Core</span>'}</div>
  <div class="fx-bar"><i></i></div><div class="fx-passes"></div></li>`,
   )
   .join("")}</ol>
 <details class="fx-more" data-more="cpu"><summary><span>CPU · main thread</span><em data-s="cpuTotal"></em></summary><div class="fx-sub" data-s="cpuRows"></div></details>
 <details class="fx-more" data-more="mem"><summary><span>GPU memory</span><em data-s="memTotal"></em></summary><div class="fx-sub" data-s="memRows"></div></details>
 <p class="fx-note">GPU timestamps per pass, attributed exclusively and smoothed. Switching a feature off releases its work; keep the camera still for a fair comparison.</p></div>`;
  document.body.append(panel);
  const S = (k) => panel.querySelector(`[data-s="${k}"]`),
    rowEl = Object.fromEntries(rows.map((r) => [r.key, panel.querySelector(`[data-row="${r.key}"]`)]));
  const list = panel.querySelector(".fx-list");

  // switches
  const syncSwitches = () => {
    const u = renderer.userEffects || {};
    for (const r of rows) {
      if (!r.toggle) continue;
      const el = rowEl[r.key],
        inp = el.querySelector("input");
      inp.checked = u[r.key] !== false;
      inp.disabled = !!r.parent && u[r.parent] === false;
      el.classList.toggle("is-off", u[r.key] === false);
    }
  };
  let shareT;
  panel.addEventListener("change", (e) => {
    const inp = e.target.closest("input[data-effect]");
    if (!inp) return;
    renderer.setEffects({ [inp.dataset.effect]: inp.checked });
    syncSwitches();
    clearTimeout(shareT);
    shareT = setTimeout(() => updateShareURL({ settings: renderer.lighting, effects: renderer.userEffects }), 150);
    try {
      localStorage.setItem("fairway-effects-v1", JSON.stringify(renderer.userEffects));
    } catch {}
  });

  // tweened numbers + bars
  const setNum = (el, v, f = fmt) => {
    const t = f(v);
    if (el.textContent !== t) el.textContent = t;
  }; // direct: per-frame text tweens repainted the panel every frame

  const attribute = (avg, u) => {
    const on = (k) => CORE.some((c) => c[0] === k) || u[k] !== false;
    const out = {};
    for (const r of rows) out[r.key] = { ms: 0, passes: [] };
    // merged terrain pass (material + ground detail + lighting in one): split it with the periodic no-detail probe
    {
      const all = avg["terrain: material + lighting"],
        base = avg["probe: terrain without ground detail"];
      if (all != null && base != null && u.surfaceDetail !== false) {
        const b = Math.min(base, all);
        avg = { ...avg, "terrain: material + lighting": b, "ground detail (in the terrain pass)": all - b };
      }
    }
    for (const [label, ms] of Object.entries(avg)) {
      const o = OWNERS.find(([re]) => re.test(label));
      let to = o ? o[1] : ["other"];
      if (!to.length) continue;
      const live = to.filter(on);
      if (o?.[2] && live.length > 1) {
        for (const k of live) {
          out[k].ms += ms / live.length;
          out[k].passes.push([label + " (shared)", ms / live.length]);
        }
        continue;
      }
      const k = live[0] ?? to[0];
      out[k].ms += ms;
      out[k].passes.push([label, ms]);
    }
    return out;
  };

  let order = rows.map((r) => r.key),
    lastSort = 0,
    lastData = null;
  const mb = (b) => (b / 1048576).toFixed(b > 1048576 * 10 ? 0 : 1) + " MB";
  // keyed sub-rows so their bars animate between refreshes instead of being rebuilt
  const subRows = (box, items) => {
    const have = new Map([...box.children].map((el) => [el.dataset.k, el]));
    const keep = new Set();
    items.forEach(([k, v, w, cls = ""], i) => {
      let el = have.get(k);
      if (!el) {
        el = document.createElement("div");
        el.dataset.k = k;
        el.innerHTML = "<span></span><i></i><b></b>";
        el.firstChild.textContent = k;
        el.style.setProperty("--w", 0);
      }
      el.className = "fx-pass " + cls;
      el.lastChild.textContent = v;
      if (w != null) requestAnimationFrame(() => el.style.setProperty("--w", Math.max(0, Math.min(1, w)).toFixed(4)));
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
      keep.add(k);
    });
    for (const [k, el] of have) if (!keep.has(k)) el.remove();
  };
  const update = () => {
    if (panel.hidden) return;
    const t0 = performance.now();
    {
      const n = Math.max(1, self.frames);
      for (const k of ["update", "tick", "graph"]) {
        selfAvg[k] = self[k] / n;
        self[k] = 0;
      }
      self.frames = 0;
    }
    syncSwitches();
    const R = renderer,
      g = R.gpu,
      u = R.userEffects || {},
      f = frameStats(),
      T = g?.timer;
    const avg = f.avg || 16.7;
    setNum(S("fps"), f.fps, (v) => Math.round(v) + "");
    S("fpsSub").textContent = `${f.avg.toFixed(1)} ms · p95 ${f.p95.toFixed(0)}`;
    if (T && Object.keys(T.avg).length) {
      setNum(S("gpu"), T.span, (v) => v.toFixed(1) + " ms");
      S("gpuSub").textContent = `${Object.keys(T.avg).length} passes`;
    } else {
      S("gpu").textContent = "--";
      S("gpuSub").textContent = g?.ready ? (T ? "measuring…" : "timestamps unavailable") : "engine starting…";
    }
    setNum(S("cpu"), R.cpuMs ?? 0, (v) => v.toFixed(2) + " ms");
    S("cpuSub").textContent = `engine ${(g?.cpuT?.total ?? 0).toFixed(2)} ms`;
    const st = g?.drawStats || {},
      mem = g?.mem?.total();
    S("meta").innerHTML = g?.ready
      ? [
          `${g.w}×${g.h}${g.ow && g.ow !== g.w ? ` → ${g.ow}×${g.oh}` : ""}`,
          g.taaOn ? "TAAU on" : "",
          `${st.draws ?? 0} draws`,
          `${((st.tris ?? 0) / 1e6).toFixed(2)}M tris`,
          g.useTerrain ? `terrain ${g.terrain.stats.nodes} nodes` : "",
          mem ? `${mb(mem.bytes)} GPU` : "",
        ]
          .filter(Boolean)
          .map((s) => `<span>${s}</span>`)
          .join("")
      : "";
    const data = T ? attribute(T.avg, u) : null;
    lastData = data;
    if (data)
      data.monitor = {
        ms: selfAvg.update + selfAvg.tick + selfAvg.graph,
        passes: [
          ["panel refresh (JS + layout, every 0.25 s)", selfAvg.update],
          ["fps graph", selfAvg.graph],
          ...(T ? [["GPU timestamp readback (panel open only)", g?.cpuT?.timing ?? 0]] : []),
        ].filter((p) => p[1] > 0),
      };
    for (const r of rows) {
      const el = rowEl[r.key],
        d = data?.[r.key],
        off = r.toggle && u[r.key] === false,
        ms = d?.ms ?? 0;
      const b = el.querySelector(".fx-ms b"),
        pc = el.querySelector(".fx-ms em");
      if (off) {
        b.textContent = "off";
        pc.textContent = "";
        el.querySelector(".fx-ms small").hidden = true;
      } else {
        el.querySelector(".fx-ms small").hidden = false;
        if (!data) {
          b.textContent = "--";
          pc.textContent = "";
        } else {
          setNum(b, ms);
          pc.textContent = Math.round((ms / avg) * 100) + "%";
        }
      }
      el.style.setProperty("--w", off || !data ? 0 : Math.min(1, ms / avg).toFixed(4));
      const ps = el.querySelector(".fx-passes");
      const passes = (d?.passes || []).sort((a, b) => b[1] - a[1]);
      subRows(
        ps,
        off
          ? []
          : passes.length
            ? passes.map(([k, v]) => [k, fmt(v), v / avg])
            : NOTES[r.key] && data
              ? [[NOTES[r.key], "", null, "is-note"]]
              : [],
      );
      el.classList.toggle("is-empty", r.key === "other" && !passes.length);
    }
    // CPU + memory
    const C = g?.cpuT || {};
    S("cpuTotal").textContent = (R.cpuMs ?? 0).toFixed(2) + " ms";
    subRows(S("cpuRows"), [
      ["renderer tick (total)", (R.cpuMs ?? 0).toFixed(2) + " ms", (R.cpuMs ?? 0) / avg, "is-head"],
      ...Object.entries(C)
        .filter(([k]) => k !== "total")
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, v.toFixed(2) + " ms", v / avg]),
    ]);
    if (g?.mem) {
      const t = g.mem.total();
      S("memTotal").textContent = mb(t.bytes);
      subRows(
        S("memRows"),
        g.mem
          .top(12)
          .map(([k, v]) => [k + (v.count > 1 ? " ×" + v.count : ""), mb(v.bytes), v.bytes / Math.max(t.bytes, 1)]),
      );
    }
    if (!lastSort || performance.now() - lastSort >= 3000) {
      lastSort = performance.now();
      resort();
    }
    panel.offsetHeight;
    self.update += performance.now() - t0;
  };

  const cost = (k) => {
    const r = rows.find((x) => x.key === k),
      u = renderer.userEffects || {};
    if (r.toggle && u[k] === false) return -1;
    return lastData?.[k]?.ms ?? 0;
  };
  const resort = () => {
    const next = [...order].sort((a, b) => cost(b) - cost(a) || order.indexOf(a) - order.indexOf(b));
    if (next.join() === order.join()) return;
    const before = new Map(next.map((k) => [k, rowEl[k].getBoundingClientRect().top]));
    order = next;
    for (const k of order) list.append(rowEl[k]);
    for (const k of order) {
      const el = rowEl[k],
        dy = before.get(k) - el.getBoundingClientRect().top;
      if (!dy) continue;
      el.style.transition = "none";
      el.style.transform = `translateY(${dy}px)`;
      el.classList.add("is-moving");
    }
    list.offsetHeight;
    for (const k of order) {
      const el = rowEl[k];
      if (!el.style.transform) continue;
      el.style.transition = "";
      el.style.transform = "";
      setTimeout(() => el.classList.remove("is-moving"), 650);
    }
  };

  let timer = null;
  const open = (v) => {
    panel.hidden = !v;
    card.classList.toggle("is-open", v);
    card.setAttribute("aria-expanded", String(v));
    if (renderer.gpu) renderer.gpu.timing = v;
    clearInterval(timer);
    if (v) {
      syncSwitches();
      lastSort = 0;
      update();
      timer = setInterval(() => {
        if (renderer.gpu) renderer.gpu.timing = true;
        update();
      }, 250);
    }
    try {
      localStorage.setItem("fa-fx-panel", v ? "1" : "0");
    } catch {}
  };
  card.addEventListener("click", () => open(panel.hidden));
  panel.querySelector(".fx-close").addEventListener("click", () => open(false));
  addEventListener(
    "keydown",
    (e) => {
      if (e.target.closest?.("input,textarea,select")) return;
      if (e.key === "`") {
        open(panel.hidden);
      } else if (e.key === "Escape" && !panel.hidden) {
        e.stopImmediatePropagation();
        open(false);
      }
    },
    true,
  );
  for (const d of panel.querySelectorAll("details[data-more]")) {
    try {
      d.open = localStorage.getItem("fa-fx-" + d.dataset.more) === "1";
    } catch {}
    d.addEventListener("toggle", () => {
      try {
        localStorage.setItem("fa-fx-" + d.dataset.more, d.open ? "1" : "0");
      } catch {}
    });
  }

  // card text, 4x a second
  // smoothed readout with hysteresis: the number only moves when the smoothed rate is clearly past the next integer,
  // so a steady 68.5 fps doesn't flicker 68/69
  let emaMs = 0,
    shown = 0;
  setInterval(() => {
    const f = frameStats();
    if (!f.avg) return;
    emaMs = emaMs ? emaMs * 0.6 + f.avg * 0.4 : f.avg;
    const fps = 1000 / emaMs;
    if (!shown || Math.abs(fps - shown) > 0.8) shown = Math.round(fps);
    fpsEl.textContent = shown;
    frameEl.textContent = (1000 / shown).toFixed(1);
    card.classList.toggle("is-slow", shown < 55);
  }, 250);
  let wasOpen = false;
  try {
    wasOpen = localStorage.getItem("fa-fx-panel") === "1";
  } catch {}
  if (wasOpen) open(true);
  // console API: the same numbers the panel shows, measured over a window (turns detailed GPU timing on while sampling)
  window.__perf = async (ms = 2000, opt = {}) => {
    const R = renderer,
      g = R.gpu;
    const was = g?.timing;
    if (g) g.timing = opt.timing !== false; // {timing:false}: fps as a player sees it (no GPU timestamps)
    const gaps0 = [];
    let last = performance.now();
    const n0 = g?.timer?.rawN ?? 0;
    await new Promise((res) => {
      const t0 = last;
      const f = (t) => {
        gaps0.push(t - last);
        last = t;
        if (t - t0 < ms) requestAnimationFrame(f);
        else res();
      };
      requestAnimationFrame(f);
    });
    gaps0.shift();
    if (g) g.timing = !!was || !panel.hidden;
    // robust per-pass numbers: medians of the raw (unsmoothed) samples taken inside this window; the smoothed average otherwise
    const Tm = g?.timer;
    let med = null,
      medSpan = null;
    if (Tm?.raw) {
      const k = Math.min(Tm.rawN - n0, Tm.raw.length),
        rs = Tm.raw.slice(Tm.raw.length - k);
      if (rs.length >= 3) {
        const md = (a) => {
          const q = [...a].sort((x, y) => x - y);
          return q[q.length >> 1];
        };
        const labs = new Set(rs.flatMap((r) => Object.keys(r.cur)));
        med = {};
        for (const l of labs) {
          if (l.startsWith("probe:")) continue;
          med[l] = md(rs.map((r) => r.cur[l] || 0));
        }
        if (
          Tm.avg["probe: terrain without ground detail"] != null &&
          rs.some((r) => r.cur["probe: terrain without ground detail"])
        )
          med["probe: terrain without ground detail"] = md(
            rs
              .filter((r) => r.cur["probe: terrain without ground detail"])
              .map((r) => r.cur["probe: terrain without ground detail"]),
          );
        medSpan = md(rs.map((r) => r.span));
      }
    }
    const s = [...gaps0].sort((a, b) => a - b),
      avg = gaps0.reduce((a, b) => a + b, 0) / Math.max(1, gaps0.length);
    const T = g?.timer;
    return {
      fps: +(1000 / avg).toFixed(1),
      frameMs: +avg.toFixed(2),
      p95: +(s[Math.floor(s.length * 0.95)] || 0).toFixed(2),
      missed: gaps0.filter((x) => x > (1000 / 120) * 1.5).length,
      frames: gaps0.length,
      gpuSpan: +(medSpan ?? T?.span ?? 0).toFixed(2),
      samples: med ? Object.keys(med).length && Math.min(Tm.rawN - n0, Tm.raw.length) : 0,
      systems: T
        ? Object.fromEntries(
            Object.entries(attribute({ ...(med || T.avg) }, R.userEffects || {}))
              .filter(([k, v]) => v.ms > 0)
              .sort((a, b) => b[1].ms - a[1].ms)
              .map(([k, v]) => [k, +v.ms.toFixed(3)]),
          )
        : null,
      gpuPasses: Object.fromEntries(
        Object.entries(med || T?.avg || {})
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => [k, +v.toFixed(2)]),
      ),
      cpuTickMs: +(R.cpuMs ?? 0).toFixed(2),
      res: g ? `${g.w}x${g.h} -> ${g.ow}x${g.oh}` : "",
      settings: {
        effects: { ...R.userEffects },
        dynRes: !g?.fixedRes,
        taa: !!g?.taaOn,
        fastLighting: !!g?.fastLighting,
        pxBudget: g?.pxBudget,
      },
    };
  };
  // per-system GPU cost (the panel's rows) over a window: {fps, frameMs, gpuSpan, systems:{key:ms}, settings}
  window.__sys = async (ms = 1500, opt = {}) => {
    const p = await window.__perf(ms, opt);
    const a = attribute(p.gpuPasses, renderer.userEffects || {});
    return {
      fps: p.fps,
      frameMs: p.frameMs,
      p95: p.p95,
      gpuSpan: p.gpuSpan,
      cpuTickMs: p.cpuTickMs,
      systems: Object.fromEntries(
        Object.entries(a)
          .filter(([, v]) => v.ms > 0)
          .sort((x, y) => y[1].ms - x[1].ms)
          .map(([k, v]) => [k, +v.ms.toFixed(3)]),
      ),
      passes: p.gpuPasses,
      settings: p.settings,
    };
  };
  return { open, card, panel, syncSwitches };
}
