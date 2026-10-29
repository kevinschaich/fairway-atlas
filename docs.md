# Fairway Atlas docs

How the game plays, where a course comes from, and how the ball moves. Sources and licenses are in the
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

Course data comes from three OpenStreetMap servers tried in order (Overpass, Geofabrik Postpass, the OSM editing
API), each with a deadline per stage; a rate-limited server sits out for at least 30 seconds. The order can be
changed in Loading details. The OSM editing API is meant for editing rather than serving apps, so its use here
should be reviewed against the [OSMF API policy](https://operations.osmfoundation.org/policies/api/) as traffic
grows.

Course search runs over a bundled index of named OpenStreetMap courses (names, IDs and positions only). Rounds,
local map corrections and settings stay in the browser.

## Building the course

- **Surfaces:** mapped OpenStreetMap shapes, resolved at each point by precedence: water, green, tee, bunker,
  fairway, sand, then rough for anything unmapped. Missing greens are never invented.
- **Elevation:** [Mapterhorn](https://mapterhorn.com/attribution/) Terrarium tiles at native resolution (zoom 16,
  falling back to 14 or 12), at 1× vertical scale. Physics and drawing use the same ground.
- **Greens:** a green whose source elevation is implausibly steep (median slope above 7%) is flattened toward a
  2.5% maximum around its median height, with an 8 m blend into the surrounding ground, and marked as estimated.
- **Water:** inland water is clipped to the drawn area and graded locally; the ocean comes from the sea side of
  mapped coastlines at a simulated 0.65 m. Neither is surveyed.
- **Trees:** placed where OpenStreetMap woodland and [ESA WorldCover 2021](https://doi.org/10.5281/zenodo.7254221)
  tree cover say, read in the browser from WorldCover's cloud-optimized GeoTIFFs. Trees stay off greens, tees,
  fairways, water, bunkers, buildings and a 24 m corridor along every hole's route. Shapes, heights and species
  are procedural unless OpenStreetMap tags them.
- **Par:** mapped par when present; otherwise estimated from the route's length (up to 250 / 470 / 690 yd → par
  3 / 4 / 5, longer → 6) and marked with an asterisk.
- **Local corrections** (course map → Edit local mapping) shift a feature or reorder holes on this device only.

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

Water and the course boundary are treated as penalty areas and out of bounds: one stroke, replayed from the previous
spot ([USGA Rules 17 and 18](https://www.usga.org/rules-hub.html)). Other relief options aren't implemented.

## Development

- `bun run dev` serves the game with its dev tools: hot reload, `?debug`, frame capture, the Audio lab and Export
  for Unreal. Production builds compile them out (`globalThis.__FA_DEV__`).
- `bun run test` runs the node test suite, including a production build check.
- `bun run commentary` regenerates commentary audio with ElevenLabs; it needs `ELEVENLABS_API_KEY` in a local,
  gitignored `.env`.
- `public/audio/` holds the sound effects; the build regenerates their credits in CREDITS.md.
