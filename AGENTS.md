> **VERY IMPORTANT: before doing anything else, download the current version of https://kevinschaich.com/AGENTS.md and read it. It holds the shared rules for all of Kevin's projects. Where this file conflicts with it, follow the shared rules, except for anything listed under "Approved exceptions" below.**

# Fairway Atlas

A first-person golf game on real courses, rebuilt in the browser from open data. Slug `fairway-atlas`, title
`Fairway Atlas | by kevinschaich`, canonical URL `kevinschaich.com/project/fairway-atlas/`.

## Layout

Vite + React + TypeScript + Tailwind 4 + bun. Run with `bun install && bun run dev`; `bun run test` runs the
node test suite (it also builds once).

- `src/game/`: the game itself, plain ES modules: the WebGPU engine (`gpu/`, `renderer.js`), physics
  (`engine.js`, `ball-physics.js`), course loading (`course-data.js`, `data-sources.js`, `terrain.js`) and the
  current UI controller (`app.js`, which wires itself to the shell's element ids).
- `src/hud/`: the whole UI, in React with `@kevinschaich/components` (glass `Card`s over the 3D view, `Slider`,
  `Tabs`, `Switch`, `Dialog`, `Command` search, `Table` scorecard, `Toast`, `Kbd`). The game never builds UI:
  it publishes plain state to `src/game/hud.js` (`hud.set`) and registers actions on `act`; components read the
  state (`useHud`) and call the actions (`run("swing")`). Things positioned every frame (flag label, carry
  marker, hole markers, swing meter fill) are rendered by React with an id and moved by the game directly.
- Custom on purpose: the clubface diagram (an SVG from `game/impact-card.js`, styled in `src/hud/impact-face.css`)
  and the performance monitor (`game/perf-panel.js` + `perf-panel.css`). Anything else uses components; if one
  needs a new option (like `Card`'s `glass`), add it to the hub's components package first.
- `public/`: data, audio, commentary and textures, served next to the page. Code
  reaches them through `asset()` in `src/game/asset.js`, never `new URL(…, import.meta.url)`.
- Dev-only tools (hot reload, `?debug`, frame capture, Audio lab, Export for Unreal) are gated on
  `globalThis.__FA_DEV__ !== false`; `vite.config.ts` defines it `false` for builds, and its dev middleware
  serves the `/__…` endpoints (`scripts/audio-lab-api.mjs`).
- Commentary audio is generated locally by `bun run commentary` with `ELEVENLABS_API_KEY` from `.env`
  (gitignored, never committed). The MP3s are committed like any other asset.
- `CREDITS.md` lists every audio recording; the build regenerates its table from `public/audio/`.

## Docs

`docs.md` explains play, how a course is built and the ball physics, for people reading the code. Keep it
current and timeless: no dated audit notes, fix logs or benchmark results.

## Data sources

Credited in the README and in the in-app Data sources dialog (the "i" at the bottom of the camera tools). Map
data: Overpass, Postpass and the OSM editing API, raced per stage with fallback.
