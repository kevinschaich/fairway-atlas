import { DataSources as SharedDataSources, type DataSource } from "@kevinschaich/components"

// Where everything in the game comes from. Keep in step with the README's Data sources table.
const SOURCES: DataSource[] = [
  { what: "Courses, holes, surfaces, buildings", from: "OpenStreetMap contributors", href: "https://www.openstreetmap.org/copyright", license: "ODbL" },
  { what: "Elevation", from: "Mapterhorn", href: "https://mapterhorn.com/attribution/", license: "Per source" },
  { what: "Tree cover", from: "ESA WorldCover 2021", href: "https://doi.org/10.5281/zenodo.7254221", license: "CC BY 4.0" },
  { what: "Aerial photos (course map, U.S.)", from: "USGS NAIP", href: "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer", license: "Public domain" },
  { what: "Sound effects and ambience", from: "Freesound recordings", href: "https://github.com/kevinschaich/fairway-atlas/blob/main/CREDITS.md", license: "CC0, CC BY, CC BY-NC" },
  { what: "Bunker soil texture", from: "Unsplash photo", href: "https://unsplash.com/photos/rEIDzqczN7s", license: "Unsplash License" },
  { what: "Commentary voices", from: "ElevenLabs", href: "https://elevenlabs.io", license: "ElevenLabs terms" },
]

/** The (i) at the bottom of the camera tools. */
export function DataSources() {
  return <SharedDataSources sources={SOURCES} />
}
