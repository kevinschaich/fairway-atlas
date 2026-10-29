import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Label, Separator, Slider, Switch } from "@kevinschaich/components"
import { Download, FileText, PencilLine } from "lucide-react"
import { run, useHud } from "./use-hud"

const NAMES: Record<string, string> = { routing: "Routing & hole labels" }
const one = (v: number | readonly number[]) => (typeof v === "number" ? v : v[0])

/** The course map's inspector: layers, overlay opacity, aerial comparison and the mapping notes. */
export function MapPanel() {
  const h = useHud()
  const m = h.mapping
  if (h.mode !== "map") return null
  return (
    <Card id="mappingPanel" glass size="sm" className="pointer-events-auto w-72 shrink-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Course overlay <Badge variant="secondary">Beta</Badge>
        </CardTitle>
        <CardDescription>Same terrain. Fade the map from 100% to 0%.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          {Object.entries(m.layers || {}).map(([k, on]) => (
            <Label key={k} className="justify-between font-normal">
              <span className="flex items-center gap-2">
                <span className="size-3 rounded-sm" style={{ background: m.colors?.[k] || "#9da889" }} />
                {NAMES[k] || k[0].toUpperCase() + k.slice(1)}
              </span>
              <Switch size="sm" checked={!!on} onCheckedChange={(v) => run("setLayer", k, v)} />
            </Label>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <Label className="justify-between">
            Map overlay <span className="text-muted-foreground tabular-nums">{m.opacity}%</span>
          </Label>
          <Slider aria-label="Map overlay opacity" min={0} max={100} value={m.opacity} onValueChange={(v) => run("setOpacity", one(v))} />
        </div>
        <Separator />
        <div className="flex flex-col gap-2 text-sm">
          <div className="font-medium">Source comparison</div>
          <p className="text-xs text-muted-foreground">NAIP aerial photography, at matching orientation and scale, for U.S. courses where the service has coverage.</p>
          <Button variant="outline" size="sm" disabled={m.imageryBusy} onClick={() => run("loadImagery")}>
            Load aerial imagery
          </Button>
          <p className="text-xs text-muted-foreground">{m.imageryStatus}</p>
        </div>
        {m.quality && (
          <div className="flex flex-col gap-1 text-xs">
            {m.quality.title && <div className="font-medium">{m.quality.title}</div>}
            <p className="text-muted-foreground">{m.quality.text}</p>
            {m.quality.warn && <p className="text-amber-400">{m.quality.warn}</p>}
          </div>
        )}
        <div className="flex flex-col gap-1">
          <Button variant="ghost" size="sm" className="justify-start" onClick={() => run("editMap")}>
            <PencilLine /> Edit local mapping
          </Button>
          <Button variant="ghost" size="sm" className="justify-start" onClick={() => run("exportMap")}>
            <Download /> Export course GeoJSON
          </Button>
          <Button variant="ghost" size="sm" className="justify-start" onClick={() => run("sources")}>
            <FileText /> Sources & limitations
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
