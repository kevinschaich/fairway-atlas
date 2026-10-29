// HUD state the game publishes for the React UI (src/hud/). The game writes plain data here and registers its
// actions on `act`; components read it with useSyncExternalStore and call the actions. No DOM in here.
const listeners = new Set();
let state = {
  ready: false,
  mode: "play",
  tool: "play",
  overview: false,
  follow: true,
  visual: "natural",
  course: { name: "", location: "", routingName: "", sourceStatus: "" },
  hole: { number: 0, par: null, parEstimated: false, yards: 0 },
  holes: [],
  strokeTrack: [],
  strokeLabel: "",
  distance: "—",
  elevation: "—",
  lie: "",
  lieQuality: "",
  club: { abbr: "", name: "", loft: 0, range: "", thumb: "" },
  clubs: [],
  aim: 0,
  power: 80,
  suggested: 80,
  powerYards: 0,
  wind: { speed: "", bearing: "", angle: 0, text: "" },
  swing: { label: "Take your shot", disabled: true, preciseDisabled: true, metering: false, help: "" },
  restartDisabled: true,
  advice: "",
  lastShot: null,
  toast: null,
  loading: null,
  build: null,
  diagnostic: "Loading details",
  timings: "",
  cameraHint: "",
  crosshair: true,
  mapping: { layers: {}, opacity: 50, quality: null, imageryStatus: "Imagery has not been loaded.", imageryBusy: false },
  dialog: null,
  search: { open: false, query: "", items: [], selected: 0, status: "", requestedHole: null },
  settingsOpen: false,
  lighting: { date: "", clouds: 0 },
  conditions: null,
  time: { hour: 15.5, min: 6, max: 18, title: "", label: "" },
  shotPanel: { open: true, label: "", metrics: [], note: "", canSave: false, updateReady: false },
  lm: { light: "red", status: "", meta: "", label: "Connect", supported: false, showAll: false, last: "" },
  impact: { open: true, club: "", source: "", sourceKind: "", svg: "", caption: "", rows: [] },
  freeHelp: false,
  launchInput: null,
};
export const hud = {
  get: () => state,
  set(patch) {
    state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
    for (const f of listeners) f();
  },
  subscribe(f) {
    listeners.add(f);
    return () => listeners.delete(f);
  },
};
// Actions the UI calls; the game fills these in as it installs.
export const act = {};
