[![Fairway Atlas by kevinschaich](https://kevinschaich.com/og/fairway-atlas.png)](https://kevinschaich.com/project/fairway-atlas/)

# Fairway Atlas

Play any real golf course, right in your browser

**[Try it →](https://kevinschaich.com/project/fairway-atlas/)**

## How it works

- Search 31,518 real courses and tee off on any hole. The course is rebuilt from OpenStreetMap's mapped greens,
  fairways, bunkers and water, on real elevation.
- A WebGPU engine draws it: terrain, grass, trees, ocean, clouds and shadows, at a steady frame rate.
- One physics model handles the ball's flight, spin, bounce and roll. A Square Golf Omni launch monitor can drive
  it over Web Bluetooth (desktop Chrome).
- Everything loads in your browser, straight from open data. There's no server.

Controls, the launch monitor, how a course is built and how the ball moves: [docs.md](docs.md).

## Data sources

| What | Where it's from | License |
|---|---|---|
| Courses, holes, surfaces, buildings | [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, via Overpass, Geofabrik Postpass and the OSM API | ODbL |
| Elevation | [Mapterhorn](https://mapterhorn.com/attribution/) | Per source, see link |
| Tree cover | [ESA WorldCover 2021](https://doi.org/10.5281/zenodo.7254221), via Microsoft Planetary Computer | CC BY 4.0 |
| Aerial imagery (mapping view, U.S.) | [USGS NAIP](https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer) | Public domain |
| Sound effects and ambience | [Freesound](https://freesound.org) recordings, listed in [CREDITS.md](CREDITS.md) | CC0, CC BY, CC BY-NC |
| Bunker soil texture | [Unsplash photo](https://unsplash.com/photos/rEIDzqczN7s) | Unsplash License |
| Commentary voices | Generated with [ElevenLabs](https://elevenlabs.io) | ElevenLabs terms |

## Run locally

```bash
bun install
bun run dev
```
