[![Fairway Atlas by kevinschaich](https://kevinschaich.com/og/fairway-atlas.png)](https://kevinschaich.com/project/fairway-atlas/)

# Fairway Atlas

Play any real golf course, right in your browser

**[Try it →](https://kevinschaich.com/project/fairway-atlas/)**

## How it works

- **Any course.** Search the named golf courses in OpenStreetMap and tee off on any hole. The course is rebuilt in
  your browser from its mapped greens, tees, fairways, bunkers, water, buildings and trees, on real elevation.
- **Drawn by its own engine.** A custom WebGPU renderer: streamed CDLOD terrain, real grass blades,
  procedural trees, an FFT ocean with surf, a physical sky with volumetric clouds, soft shadows and temporal
  upscaling. It needs a browser with WebGPU (current Chrome, Edge or Safari).
- **Real ball physics.** Club impact, spin, drag and lift, wind, bounce, skid, roll and a regulation cup, all in one
  solver. A Square Golf Omni launch monitor can play shots over Bluetooth in desktop Chrome.
- **Nothing to install, no server.** Everything loads straight from open data into your browser.

How it all works, in detail: [docs.md](docs.md).

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
