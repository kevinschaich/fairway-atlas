import { Alert, AlertDescription, DialogDescription, DialogHeader, DialogTitle } from "@kevinschaich/components"
import type { ReactNode } from "react"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type D = Record<string, any>
const A = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noopener" className="underline underline-offset-4 hover:text-foreground">
    {children}
  </a>
)
const H = ({ children }: { children: ReactNode }) => <h3 className="mt-2 font-heading text-sm font-semibold text-foreground">{children}</h3>

/** What's observed, what's inferred, and where every source comes from, for the open course and hole. */
export function Sources({ d }: { d: D }) {
  return (
    <>
      <DialogHeader>
        <DialogDescription className="text-xs tracking-wider uppercase">Open data · honest limits</DialogDescription>
        <DialogTitle>A real place, reconstructed</DialogTitle>
      </DialogHeader>
      <Alert>
        <AlertDescription>
          This is an experimental playable reconstruction. Worldwide coverage, surveyed green contours, course-specific rules and photorealism are not established capabilities.
        </AlertDescription>
      </Alert>
      <div className="flex flex-col gap-2 text-sm text-muted-foreground">
        <H>This course</H>
        <p>
          {d.course.name} · {d.course.location}. OSM {d.course.sourceId} · snapshot {d.course.date}. {d.course.holes} individually mapped holes. Hole {d.hole.number} uses OSM way{" "}
          {d.hole.id}. Route endpoints define the starting tee and a simulated pin inside the mapped green.
        </p>
        <H>What is observed?</H>
        <p>
          OpenStreetMap feature boundaries and routing; public elevation raster samples. Their resolution and age vary. Shapes have no independently measured horizontal error estimate.{" "}
          {d.warnings.join(" ")}
        </p>
        <H>What is inferred or generated?</H>
        <p>
          Unmapped ground is treated as rough. Water takes precedence over green, tee, bunker and fairway, in that order; the same surface classifier drives collisions. Coastal water is
          inferred from the ocean side of mapped OSM coastlines, with ocean height simulated at 0.65 m. Measured land elevations are never replaced by a coastal flattening rule. Greens
          with a typical source slope above 7% get an estimated putting-surface correction: median altitude preserved, relief reduced toward a 2.5% maximum slope, and an 8 m collar
          blending into the surrounding terrain. Missing par is estimated from route yardage (up to 250 yd → 3, 470 yd → 4, 690 yd → 5, longer → 6); mapped par takes precedence, and
          estimates are marked EST. Tree shapes, mowing stripes, lighting and wind are procedural. Tree placement follows OSM woodland and ESA WorldCover 2021 tree cover; positions,
          heights and species are procedural, and missing coverage never invents scenic groves. Building footprints are mapped; untagged heights and materials are inferred. Water
          depth for wave shading is inferred from shoreline distance, not surveyed. The pin is simulated. Named tee sets are not verified.
        </p>
        <H>Source licenses and access</H>
        <p>
          <A href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors · ODbL</A>. Downloaded snapshots and adapted GeoJSON remain under ODbL.{" "}
          <A href="https://dev.overpass-api.de/overpass-doc/en/preface/commons.html">Overpass</A> is best-effort community infrastructure; no account or key. Course search uses a
          downloaded index; bounded course queries run on demand, and their failures appear in Loading details. Your browser tries Overpass, Geofabrik Postpass and the OSM editing
          API in the order chosen there, aborting each after five seconds. The core OSM API is intended for editing; broader public distribution needs a suitable provider or explicit
          permission.
        </p>
        <p>
          <A href="https://mapterhorn.com/attribution/">Mapterhorn terrain tiles</A> load per hole at native 512 px resolution, zoom 16, decoded before interpolation at 1× vertical
          scale. Regional context comes from <A href="https://registry.opendata.aws/terrain-tiles/">Mapzen Terrain Tiles / AWS Open Data</A> (USGS 3DEP, SRTM and GMTED2010; NOAA
          ETOPO1; <A href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">full attribution</A>). Your browser fetches terrain directly; there is no server proxy.
        </p>
        <p>
          <A href="https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer">USGS NAIP imagery</A> is requested on demand for matching bounds; coverage is
          U.S.-focused and dates vary. © ESA WorldCover project 2021 / contains modified Copernicus Sentinel data (2021) processed by the ESA WorldCover consortium,{" "}
          <A href="https://doi.org/10.5281/zenodo.7254221">WorldCover v200 · CC BY 4.0</A>. Esri World Imagery was considered but not adopted: viewing access doesn't grant rights for
          extraction, caching or redistribution.
        </p>
        <H>Ball physics</H>
        <p>
          Club–ball impact, measured launch input, air-relative drag and spin lift, terrain contact, skid, rolling resistance and rim/cup collisions share one SI solver.{" "}
          <A href="https://github.com/kevinschaich/fairway-atlas/blob/main/docs.md#ball-physics">How the ball moves</A>. Aerodynamic coefficient forms are adapted from{" "}
          <A href="https://github.com/digitalhand/openfairway">OpenFairway</A> (<A href="./vendor/LICENSE-openfairway.txt">MIT</A>).
        </p>
        <H>Playing assumptions</H>
        <p>
          Mapped water is treated as an inferred penalty area and the mapped course boundary as an inferred out-of-bounds line. Both cost one stroke and replay from the previous
          position (stroke and distance). Lateral, back-on-line and free relief, provisional balls and detailed competition rules are not implemented.{" "}
          <A href="https://www.usga.org/rules-hub.html">USGA Rules 17 and 18</A>.
        </p>
      </div>
    </>
  )
}
