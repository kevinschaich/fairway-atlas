# Fairway Atlas docs

How the game plays, where a course comes from, how it is drawn, and how the ball moves. Sources and licenses are in the
[README](README.md#data-sources) and [CREDITS.md](CREDITS.md).

## Playing

| | |
|---|---|
| Aim | ← → |
| Carry | ↑ ↓ |
| Start the meter, then strike | Space |
| Next / previous club | − / + |
| Play view · course map · flyover · free camera | 1 · 2 · 3 · 5 |
| Look · field of view | drag · scroll |
| Move (free camera) · down / up · faster | W A S D · Q / E · Shift |
| Hold the camera, then back to the ball | Esc, Esc |
| Find a course | ⌘ K |
| Sound on / off · green grid on / off | M · G |

"Play at set power" plays the shot at the slider's power without timing the meter.

### Square Golf Omni

Desktop Chrome, over Web Bluetooth (`localhost` or HTTPS only). Open the launch monitor panel at the bottom left,
press **Connect** and pick `SquareGolf(XXXX)`; don't pair it in the system's Bluetooth settings. The light is
red when disconnected, amber while connecting or waiting for a ball, and green when a ball is in place. Measured
ball launch drives the flight; club delivery and impact location show when the device tracks them. The game's club
and RH/LH setting are sent to the device. Protocol notes are in `src/game/square-omni.js`.

`bun run square-omni-debug` connects from a terminal with the same code and prints every event. Options:
`--club 7I`, `--left`, `--seconds 60`, `--replay` (no hardware). On macOS the terminal needs Bluetooth permission.

### Launch data

`window.fairwayLaunchMonitor.submit(data)` plays one shot from measured data, and the **Enter launch data**
dialog does the same by hand:

```js
{
  units: 'mph-deg-rpm-mm',
  ballSpeed: 150, ballDirection: 0, ballElevation: 13, backspin: 2800, sideSpin: 0,
  pathAngle: 0, attackAngle: 3, faceAngle: 0, dynamicLoft: 15, clubSpeed: 104,
  impactPoint: { x: 0, y: 0 },
}
```

Give all five ball values or all six club-delivery values; complete ball values win. Horizontal angles are
positive to the target's right whatever the golfer's hand; attack and elevation are positive upward; positive side
spin curves right. Zero is a reading, missing is not; invalid or out-of-range data is rejected before the shot.

## How a course loads

Everything is fetched by the player's browser; the site only serves static files.

1. The old scene clears into a blank map and the course's OpenStreetMap raster tiles draw as they arrive.
2. The course boundary loads and outlines the map.
3. Elevation loads for the course, then in finer detail for the hole.
4. Holes, greens, tees, fairways, bunkers, water, buildings and trees load and build the playable hole.

Course data comes from three OpenStreetMap servers, tried in order (`src/game/data-sources.js`, in its own worker):

- **Overpass** (`overpass-api.de`): bounded spatial queries and exact facility IDs.
- **Geofabrik Postpass**: indexed `osm_type`/`osm_id` boundary lookups and bounded SQL against the
  `postpass_pointlinepolygon` view; its GeoJSON is normalised into the same model, keeping multipart boundaries and
  line direction.
- **OSM editing API**: `way|relation/id/full.json` for the facility, then `map.json?bbox=…` around its polygon plus
  60 m. A full map response includes the scenery, so no second detail download follows.

Each server gets a deadline per stage, including downloading and decoding the response, and is aborted before the
next one starts. The first valid answer wins; invalid geometry, HTTP errors and network failures are recorded
separately and shown in Loading details, where the order can also be changed. A 429/509 response benches that
server for at least 30 seconds (or its `Retry-After`). Switching course aborts every request in flight. The OSM
editing API is meant for editing rather than serving apps, so its use here should be reviewed against the
[OSMF API policy](https://operations.osmfoundation.org/policies/api/) as traffic grows.

The raster tiles and the boundary arrive independently, so a slow raster never holds up a ready boundary. Missing
geometry leaves the map and terrain visible rather than substituting another course.

**Search** runs over a bundled index of named OpenStreetMap courses (`public/data/course-index.json`: names, IDs and
positions only, ODbL). A course is built on demand from live data; Pebble Beach and Raccoon Creek also ship as
snapshots (`public/data/`).

**Caching:** `src/game/net-cache.js` wraps `fetch` in the page and every worker with a 24-hour browser Cache Storage
cache, keyed by method, URL, byte range and body, so POSTed Overpass queries and GeoTIFF ranges cache too. With
"Use cache" on, `src/game/fast-load.js` also keeps built courses in IndexedDB so a replayed course opens on the tee.
Rounds, local map corrections and settings stay in the browser.

## Building the course

- **Surfaces:** mapped OpenStreetMap shapes, resolved at each point by precedence: water, green, tee, bunker,
  fairway, sand, then rough for anything unmapped. Missing greens are never invented.
- **Elevation:** [Mapterhorn](https://mapterhorn.com/attribution/) Terrarium tiles (`src/game/terrain.js`): native
  512 px tiles at zoom 16 (about 0.96 m per pixel at Pebble Beach), falling back to 14 or 12 when the tile budget or
  coverage requires it. Heights are decoded from RGB before any interpolation, keep Mercator pixel centres, and use a
  1× vertical scale. Outside coverage a sample clamps to the nearest valid pixel; missing data is never read as 0 m.
  The course box loads first for the overview, then the selected hole in finer detail.
- **Micro-relief** (`src/game/gpu/maps.js`): the ~1 m elevation is too smooth for golf ground, so a relief layer adds
  flashed bunker faces rising toward each trap, rolling mounds through the rough and gentle undulation in fairways.
  Tees and greens get none. Everything that samples the ground, physics included, sees the same relief.
- **Outlines** (`src/game/rounded-boundaries.js`): fairway, green, tee, bunker, sand, rough and inland water
  polygons get bounded corner rounding in metres, validated against self-intersection. Rendering, grass and lie
  classification share those outlines; GeoJSON export keeps the source polygon.
- **Greens, tees and fairways** (`src/game/green-terrain.js`): regional elevation is not a surveyed playing
  surface. An area whose median slope is implausibly steep gets a least-squares best-fit plane: its overall tilt is
  kept (clamped for greens and tees) and local relief around the plane is compressed, holding for a buffer past the
  edge and blending out over a collar so no cliff forms. Corrected greens are marked as estimated.
- **Water:** inland water is clipped to the loaded area before any elevation lookup (`water-geometry.js`); rivers keep
  a local grade, lakes use a lower-quartile shore estimate. The ocean is inferred from the sea side of mapped OSM
  coastlines (they run with land on the left; `coast.js` closes the clipped chains along the box edge), at a resting
  level of 0.65 m. Inland courses take the level of the most prominent pond near the tee (`water-level.js`). Depths
  for wave shading come from distance to shore, not bathymetry.
- **Trees:** placed where OpenStreetMap woodland and [ESA WorldCover 2021](https://doi.org/10.5281/zenodo.7254221)
  say. A worker (`canopy-worker.js`, with geotiff.js) reads only the local 10 m window of WorldCover's
  cloud-optimised GeoTIFFs over HTTP Range from Microsoft Planetary Computer's public mirror, using its public
  read-only token. Tree and shrub classes constrain placement and keep clearings; grassland becomes taller meadow
  rough, shrubland scrub. Trees stay off greens, tees, fairways, water, bunkers, buildings and a 24 m corridor along
  every hole's route, including tee carries and doglegs. OSM leaf-type and species tags win; otherwise high-latitude
  or high-altitude courses get conifers. Shapes, heights and positions are procedural.
- **Buildings** (`landscape-buildings.js`): OSM footprints extruded to their tagged height (feet converted), or an
  inferred one, with walls and roofs merged per 256 m cell into one mesh each.
- **Tee dressing** (`tee-dressing.js`): tee markers in each hole's set colours and decorative divots inside mapped
  tees. They don't affect the ball.
- **Par:** mapped par when present; otherwise estimated from the route's length (up to 250 / 470 / 690 yd → par
  3 / 4 / 5, longer → 6) and marked with an asterisk.
- **Local corrections** (course map → Edit local mapping) shift a feature or reorder holes on this device only.

## Graphics

Fairway Atlas draws with its own WebGPU engine and WGSL shaders. There is no three.js and no WebGL path, so it needs
a browser with WebGPU (current Chrome, Edge or Safari).

### Structure

- `src/game/core/`: the engine core. Math (vectors, quaternions, matrices, linear colour), centripetal Catmull-Rom
  curves, geometry builders (sphere, box, cylinder, tube, bevelled extrusion), earcut triangulation, the camera and
  the scene database: nodes with dirty-only world transforms and a per-node `worldVersion`, and an allocation-free
  `Scene.collect()` of visible drawables.
- `src/game/renderer.js`: owns the scene database (the ground heightfield used for the height bake and ball contact,
  the ball, club, flag and cup, buildings, tracer, map overlays and aim line), drives the cameras and hands the scene
  to the backend every frame. Terrain, turf, flora, water, sky and lighting belong to the engine itself.
- `src/game/gpu/backend.js`: the renderer backend. GPU buffers and instance transforms are re-uploaded only when a
  geometry version or a node's transform changes. Every pipeline reports its own creation error by name.

### A frame

Depth prepass → sun, terrain and cloud shadows and ambient occlusion as screen passes over the ground depth →
material G-buffer for the terrain, then the bunker-sand strip (depth-equal, so each visible pixel is shaded once) →
ground detail → lighting → haze. Then, forward: grass blades (drawn before the terrain lighting, which runs as a
depth-equal pass, so ground hidden under the sward is never shaded), trees, buildings, ball, club, flag, water,
volumetrics, tracer, TAAU, bloom and the colour grade.

Reverse-Z with an infinite far plane. The internal resolution scales dynamically (about 2.4 to 6.5 megapixels) to
hold the frame rate, and TAAU rebuilds the output resolution from the jittered samples. HDR output uses a 16-bit
canvas with extended tone mapping where the display supports it (the HDR switch).

### Terrain

- **CDLOD over a clipmap** (`gpu/terrain.js`): seven nested camera-centred windows (0.125 m to 8 m per texel) cache
  the finished ground height: bicubic elevation plus relief, minus bunker sink and seabed drop. They're stored
  toroidally, so moving the camera recomputes only the newly exposed rows and columns, and standing still recomputes
  nothing. Normals are central differences of the cached heights, read with one filtered tap.
- One shared patch is instanced over the quadtree nodes chosen for the view: fine near the camera, doubling in
  spacing with distance, frustum-culled against per-node height bounds and drawn front to back. Vertices geo-morph
  toward the next level before each boundary, so there are no cracks and no popping.
- **Material cache** (`gpu/matcache.js`), a runtime virtual texture as in Unreal and Far Cry: everything in the
  ground material that depends only on position (the painted surface map, aerial blend, collar and bunker-surround
  fixes, wet beach, the rough's matted patches, native cover and reflectance) is baked into another camera-centred
  clipmap, refreshed only where the camera reveals new ground. A ground pixel reads two textures and keeps only
  view-dependent terms (near fibre, haze tint, sand grain, sheen).
- Surface masks are reconstructed with a cubic B-spline, so boundaries come out as smooth curves, not texel facets.
  Around a hole a high-resolution detail mask takes over, cross-fading to the course-wide mask at its edge.

### Turf and grass

- **Mown turf** (`gpu/turf.js`): greens, tees and fairways are stacked shells over a camera-centred grid. Each shell
  cuts blade cross-sections from a jittered cell pattern, and the blades lean with the mowing direction, so the
  stripes come from geometry and view angle rather than paint. A fine ring (0.45 m quads, 90 m square) sits inside a
  coarse ring (1.8 m quads, 360 m). Blades retire one at a time as they become sub-pixel; up close a thatch layer
  sits under them.
- **Grass blades** (`gpu/grass.js`): compute-scattered real blades, placed in clumps after Ghost of Tsushima's
  approach (GDC 2021). Leaves are 2–5 mm wide and 6–18 cm tall in the rough, V-folded with a midrib, twisted and
  drooping, with sparse seed stalks. Three rings share one continuous density target, so there are no seams: an
  ultra-dense 4.5 m field (about 12,000 blades/m²), a dense near ring and a thinned far ring whose survivors widen
  to keep coverage. Draw lists use 16, 10 and 6 vertices by true 3D distance. Blades exist only where they read
  as blades (at least about 3 px tall, or on a silhouette against sky or sea); elsewhere the ground's sward material
  carries the look. Shading has midrib and vein detail, Kajiya-Kay sheen along the blade, translucency, canopy
  occlusion deepening toward the base, and sun shadows from terrain, objects and clouds.
- **Bunker lips** (`gpu/lip.js`): a real vertical soil wall along every bunker outline, from the turf down into the
  sunken sand, traced along the exact zero line of the bunker's signed-distance field (marching squares), so the
  wall, soil band, grass edge and sand edge share one watertight seam. The soil is a photographed dirt tile,
  de-tiled with a rotated second read and lit through its own relief.

### Trees and foliage

- **Procedural flora** (`gpu/flora.js`, `gpu/flora-shader.js`): each locale's species are built once into two LODs:
  near, perforated leaf cards on real branch structure; far, lumpy crown hulls. A painted 4×4 twig atlas
  (`gpu/foliage-atlas.js`) covers broadleaf, round, pine, cypress, blossom, sage and maple sprigs; leaves are painted
  neutral and tinted per species and per plant, blossoms keep their colour.
- Wind bends the upper parts. A depth-only shadow pass uses the same wind and leaf cut-outs. The near LOD has a
  depth prepass, so each visible leaf pixel is shaded once. Leaves shade as thin translucent canopy, bark as rough
  and opaque, with world-space fissures. Beyond about 90 m (trees) or 35 m (shrubs), plants switch to baked
  impostors across a dithered overlap band. Birds use the same pass.

### Water

- **Ocean** (`gpu/ocean.js`): a Tessendorf FFT ocean with a Phillips/JONSWAP-style spectrum in two 256² cascades,
  long swell (420 m tile) and chop (47 m), evolved every frame with shared-memory radix-2 inverse FFTs into
  displacement, Jacobian and slope textures. Capillary ripples are added up close.
- Drawn as instanced rings: inner rings all around, outer rings only across the view's sector. Quads outside the
  frustum or under land are dropped.
- **Surf**: waves shoal by Green's law as they reach shallow water, peak and pitch at about 7 m depth, then collapse
  into whitewater; foam is footprint-filtered so distant sea doesn't shimmer.
- Screen-space reflections march a quarter-resolution nearest-depth buffer and read a half-resolution colour copy.

### Light and sky

- **Sun position** (`src/game/lighting-settings.js`): NOAA's solar equations for the course's latitude and date,
  in local mean solar time at the course (longitude-based), not the viewer's time zone. The time-of-day slider runs
  from 20 minutes after sunrise to 20 minutes before sunset, so both ends are golden hour.
- **Sky** (`gpu/shaders-common.js`): a per-frame sky-view LUT after Hillaire (2020), with a limb-darkened sun disc
  and aureole. Irradiance is direct sun (terrain horizon × object × cloud shadow) plus the sky dome weighted by each
  point's own sky visibility, ground bounce and GGX specular with sky reflection. Vegetation canopies keep only a
  sliver of the sky reflection.
- **Shadows**: a two-cascade sun shadow map (the near cascade covers about 30 m) with 12-tap Poisson PCF and texel-
  snapped centres so edges don't crawl; the wide cascade re-renders only when its snapped view changes. Terrain
  self-shadowing marches toward the sun over a cached sun-visibility map, with a penumbra the size of the sun's
  disc, widened near the horizon so hills cast long soft shadows at dawn and dusk. Contact shadows march the shaped
  heightfield at half resolution for small features (bunker lips, mounds, swales).
- **Ambient occlusion**: a ground AO map (horizon-based sky visibility over the shaped ground, 8 directions × 5
  steps, plus convexity for drier crests) and near-field contact occlusion at half resolution with a depth-aware
  upsample.
- **Clouds** (`gpu/volumetrics.js`): a ray-marched cumulus deck at half resolution with Beer-powder self-shadowing
  and a dual-lobe phase function. Each frame marches one block in every 4×4 group and reprojects the rest, for a full
  refresh every 16 frames. Distant cloud fades into the same horizon sky drawn behind it, so the horizon doesn't
  flicker. Cloud shadows drift across the land.
- **Light shafts and haze**: sun in-scattering through the near air, shadowed by objects, terrain and the cloud
  deck, marched at half resolution and smoothed with a joint-bilateral filter. Distance haze is analytic exponential
  height fog (broad atmosphere plus a thin low mist) lit by the sky.

### Image

- **TAAU** (`gpu/taa.js`, after Karis 2014, Jimenez 2016 and Salvi 2016): Halton(2,3) jitter at the internal
  resolution; output pixels rebuilt from the 3×3 nearest jittered samples; history reprojected from depth with
  closest-depth dilation (so thin grass edges carry the right motion), fetched with 5-tap Catmull-Rom, and
  variance-clipped in YCoCg. Luma-weighted blending stops single sun glints from sparkling.
- **Bloom**: an HDR pyramid starting at quarter resolution, before tone mapping.
- **Grade** (`gpu/grade.js`): one parameter set keyframed over the playable day (golden hour at both ends, a midday
  grade at solar noon) and interpolated smoothly, with white balance blended in mireds. There is no automatic
  exposure; brightness is the keyframed EV.

### Objects

- **Ball** (`golf-ball.js`): about 332 spherical-cap dimples on a Fibonacci sphere, baked into an octahedral height
  map that also displaces the mesh, so the silhouette is dimpled. The game's name is printed onto that map and
  shares its normals.
- **Clubs** (`club-models.js`): a modern blacked-out bag (carbon-crown woods, black irons with curved hosels, satin
  wedges, a mallet putter), each face tangent to the ball at address.
- **Flagstick**: polished stick, ferrule and cap, with a cloth flag that turns downwind and waves; it's removed
  during play so it can't affect the cup.
- **Shot tracer** (`shot-tracer.js`): the physics path resampled along a centripetal spline, the rolling part lifted
  smoothly onto the drawn turf, drawn as a screen-space-widened ribbon with a white-hot core, revealed by physical
  time.

### Phones and tablets

`gpu/budget.js` detects phones and tablets (they share one memory pool with the page, and iOS kills a tab past
roughly 1–2 GB) and trims the grass, shadow map, bakes, textures, impostors and resolution budget to about a third.
Override with `?lowmem=1` or `?lowmem=0`.

### Performance tools

Press the fps card (bottom right) for the Performance & effects panel: every optional system (grass, ground detail,
AO, sun and terrain shadows, clouds, sky detail, bloom, water, trees, buildings, ball trail) can be switched off,
releasing its resources. Detailed timing shows per-pass GPU timestamps (attributed exclusively, since tile-based
GPUs overlap passes), CPU sections and GPU memory by allocation site (`gpu/timing.js`). Effect switches are saved
and shareable as `fx_<effect>=0|1` URL parameters.

## Ball physics

One SI solver drives flight, bounce, roll and the cup; there are no scripted arcs or carry tables.

- **Ball:** 45.93 g, 42.67 mm, uniform-sphere inertia. One generic ball, not a branded one.
- **Club impact:** a two-body contact impulse between the ball and a generic clubhead (200–350 g by club type),
  with friction-limited spin and gear effect for off-centre strikes. Fourteen clubs, driver to lob wedge plus a
  putter, with conventional lofts. Rough and sand take energy off simulated swings; measured ball data is never
  reduced.
- **Flight:** quadratic drag and Magnus lift from relative air speed, with coefficients from Bearman & Harvey's
  spin fits as quoted by [Penner (2003)](https://www.raypenner.com/golf-physics.pdf). Air density follows
  temperature, humidity and pressure; spin decays over time. Wind is the 10 m reading, scaled to the ball's height
  by a log wind profile over mown grass. Integrated with RK4 at 240 Hz.
- **Bounce and roll:** speed-dependent restitution from [Penner (2002)](https://www.raypenner.com/golf-run.pdf), a
  crater tilt fitted to [Biber, Hosseini & Sharpe (2023)](https://arxiv.org/abs/2302.02758), and Coulomb friction
  that turns skid into roll. Rough and sand dig a crater and plough the ball; a bunker can plug it. Greens roll to
  the Stimpmeter setting; dampness softens bounces and slows roll.
- **Cup:** regulation 107.95 mm × 101.6 mm, with a rim, wall and floor the ball actually collides with, so putts
  drop, lip out or rim around. Capture speeds follow Holmes / Penner.
- **Not modelled:** trees and buildings don't stop the ball, there's no grass grain or deformable soil, and
  mapped water ends the shot with a penalty.

### Details

**Units and conventions:** SI throughout. Launch data arrives in mph, degrees, rpm and mm and is converted at the
boundary. The integrator runs RK4 at 240 Hz regardless of frame rate; the moment of ground contact is bisected
within a step. The cup uses local steps of at least 2,000 Hz and at most 1 mm of travel.

**Impact** (`launch-input.js`): normal restitution plus a friction-limited 2-D tangential impulse between ball and
clubhead, using both bodies' inverse mass and inertia. Bounded tangential restitution (0.22 irons, 0.25 wedges)
approximates the cover's elastic recovery; normal restitution for iron and wedge heads is 0.83. An off-centre strike
changes the lever arm, head rotation and spin (gear effect). Clubhead masses: 200 / 215 / 235 / 270 / 300 / 350 g
for driver / wood / hybrid / iron / wedge / putter. Lofts: driver 10.5°, 3W 15°, 4H 21°, 4–9 irons
24/27/30/34/38/42°, PW 46°, GW 50°, SW 56°, LW 60°, putter 3°. Delivered loft is static loft minus 6.5° for irons
and 8° for wedges.

**Aerodynamics** (`ball-aerodynamics.js`): air-relative velocity u = v − wind; drag ½ρAC_D|u|² and Magnus lift
perpendicular to u and the spin axis. Lift C_L = 1.99S − 3.25S², held at its 0.305 peak above S ≈ 0.31; drag
C_D = 0.171 + 0.62S, softened to +0.20 per unit S above S = 0.15; a non-spinning ball below the drag crisis
(Re < 5×10⁴) rises to C_D 0.46. Viscosity follows Sutherland's law; density follows pressure, temperature and
humidity. Spin decays with a 24-second time constant. Wind follows the neutral surface-layer log profile
u(z) = u₁₀·ln(z/z₀)/ln(10/z₀) with z₀ = 3 cm, so the ball feels about 61% of the reported wind at 1 m and 119% at
30 m.

**Ground** (`ball-physics.js`, `ground-contact.js`): the physics reconstructs exactly the surface the GPU draws (the
same cubic B-spline over the baked height and relief maps), so the ball sits on what you see. Restitution follows
Penner's speed-dependent curve, 0.510 − 0.0375v + 0.000903v² up to 20 m/s, scaled per surface. The rebound plane
tilts back by a crater angle θ = min(0.40 rad, 0.0207 s/m · |v_t|), fitted to Biber et al.'s 1,000+ measured
bounces. Coulomb friction acts on linear and angular momentum together (effective inverse mass 3.5/m) until the
contact stops slipping; rolling uses 5/7 of tangential gravity. Greens decelerate at v_stimp²/(2·stimp distance)
projected onto the slope. Rough and sand dig an explicit crater (½mv_n² = πRP·d², with bearing pressure P) and
plough the ball with velocity-squared drag.

| Surface | Low-speed restitution | Friction μ | Rolling decel. (m/s²) | Bearing (kPa) | Plough (1/m) | Plugs at |
|---|---:|---:|---:|---:|---:|---:|
| Green | .51 | .40 | .549 at Stimp 10 | — | — | — |
| Tee | .43 | .33 | .75 | — | .01 | — |
| Fairway | .43 | .33 | .85 | — | .02 | — |
| Rough | .22 | .62 | 2.2 | 400 | .42 | never |
| Bunker | .10 | .75 | 4.5 | 150 | 1.3 | .72 R |
| Waste sand | .13 | .70 | 3.8 | 220 | 1.0 | .85 R |
| Rock | .78 | .32 | .35 | — | — | — |
| Path | .74 | .38 | .45 | — | — | — |

Dampness lowers restitution and grip and increases rolling resistance.

**Cup**: a regulation hole aligned to the local green normal, with near and far rims, a cylindrical wall and a
floor; the ball collides with all of them, testing wall and floor together. On a flat Stimp-10 green a centred ball
is captured up to about 1.55 m/s, falling to about 0.94 m/s at 80% of the hole's radius off centre; faster balls hit
the back rim and lip out. This tracks Holmes (1991) and [Penner (2002)](https://www.raypenner.com/golf-putting.pdf).

Aerodynamic coefficient forms are adapted from [OpenFairway](https://github.com/digitalhand/openfairway) (MIT,
`public/vendor/LICENSE-openfairway.txt`).

Water and the course boundary are treated as penalty areas and out of bounds: one stroke, replayed from the previous
spot ([USGA Rules 17 and 18](https://www.usga.org/rules-hub.html)). Other relief options aren't implemented.

## Sound

- **Ambience** (`audio.js`): looping field recordings (birds, meadow insects, tropical forest, desert wind, mountain
  wind, night insects, surf, gulls, distant sea, lake shore), mixed from where you are: latitude and climate,
  elevation, season, time of day, and distance to the mapped ocean and lakes. `ambienceMix()` is the pure mixing
  model, tested in node.
- **Shots**: every swing is a whoosh plus a club-face impact drawn at random from a pool per club type, then landing
  sounds for each surface the ball meets, and the cup.
- **Commentary** (`commentary.js`): a two-voice booth, Dale (calm American) and Darren "Dazza" Buckley (unhinged
  Australian). Lines live in `public/commentary/script.json`; the module decides what to say about each shot
  (`classifyShot`, tested) and plays exchanges with broadcast pacing (call, beat, response), ducking the ambience. One
  conversation at a time; a new event is skipped while the booth is talking.

## Cameras

- **Play** (1): behind the ball, aimed at the target. **Course map** (2): a plan view with the overlay inspector.
  **Drone flyover** (3): a terrain-clearing centripetal Catmull-Rom route from behind the tee toward the green, with
  quintic timing. **Free camera** (5): WASD, Q/E, Shift, independent of the ball; Esc holds it, Esc again returns.
- **Follow** (4): during flight a chase rig follows the ball, aimed at the green rather than the ball and lifted
  over the ground along its line of sight. Mode changes ease position, rotation and field of view along a
  ground-clearing arc.
- Exploring never changes the ball, lie, score or aim.

**Sharing:** the URL carries the course (`pebble`, `raccoon`, or an OSM `way/ID` / `relation/ID`), hole, time, date,
clouds and effect switches, and is updated as you play. A shared link opens a fresh tee.

## Development

- `bun run dev` serves the game with its dev tools: hot reload, `?debug`, frame capture, the Audio lab and Export
  for Unreal. Production builds compile them out (`globalThis.__FA_DEV__`).
- `bun run test` runs the node test suite, including a production build check.
- `bun run commentary` regenerates commentary audio with ElevenLabs; it needs `ELEVENLABS_API_KEY` in a local,
  gitignored `.env`.
- `public/audio/` holds the sound effects; the build regenerates their credits in CREDITS.md.
