import { Badge, Button, Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle, Stat, Card, Collapsible, CollapsibleContent, CollapsibleTrigger, Label, NativeSelect, NativeSelectOption, Separator, Switch } from "@kevinschaich/components"
import { ArrowUpRight, ChevronDown } from "lucide-react"
import { cn } from "@/lib/cn"
import { run, useHud } from "./use-hud"

const LIGHT: Record<string, string> = { red: "bg-red-500", yellow: "bg-amber-400", green: "bg-emerald-500" }
const Light = ({ light, className }: { light: string; className?: string }) => (
  <span className={cn("inline-block size-2 shrink-0 rounded-full", LIGHT[light] || LIGHT.red, className)} aria-hidden />
)

function LaunchMonitor() {
  const { lm, shotPanel: p } = useHud()
  return (
    <Card glass size="sm" className="pointer-events-auto ml-16 w-[34rem] max-w-[calc(100vw-6rem)] gap-3">
      <Item variant="muted" size="sm" className="mx-3">
        <ItemMedia>
          <Light light={lm.light} />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle>
            Square Omni <span className="font-normal text-muted-foreground">{lm.meta}</span>
          </ItemTitle>
          <ItemDescription role="status" aria-live="polite" className="truncate">
            {lm.status}
          </ItemDescription>
          {lm.last && <ItemDescription className="truncate">{lm.last}</ItemDescription>}
        </ItemContent>
        <ItemActions>
          <NativeSelect size="sm" aria-label="Handedness" title="Handedness sent to the launch monitor" value={lm.handed} onChange={(e) => run("setHanded", e.target.value)}>
            <NativeSelectOption value="right">RH</NativeSelectOption>
            <NativeSelectOption value="left">LH</NativeSelectOption>
          </NativeSelect>
          {lm.showAll && (
            <Button variant="link" size="sm" className="px-0" title="Omni not listed? Show every nearby Bluetooth device" onClick={() => run("lmShowAll")}>
              Not listed?
            </Button>
          )}
          <Button size="sm" disabled={!lm.supported} onClick={() => run("lmConnect")}>
            {lm.label}
          </Button>
        </ItemActions>
      </Item>
      <div className="grid grid-cols-4 gap-x-4 gap-y-3 px-3">
        {p.metrics.map((m: { label: string; value: number | string | null; unit: string; dp: number }) => (
          <Stat key={m.label} label={m.label} value={m.value == null ? null : typeof m.value === "string" ? m.value : m.value.toFixed(m.dp)} unit={m.unit} />
        ))}
      </div>
      <Separator />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 text-xs text-muted-foreground">
        <Button variant="link" size="sm" className="h-auto px-0 text-xs text-muted-foreground" disabled={!p.canSave} onClick={() => run("saveShot")}>
          Save shot details
        </Button>
        {p.updateReady && (
          <Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={() => run("reload")}>
            Update ready · Reload
          </Button>
        )}
      </div>
    </Card>
  )
}

/** Bottom-left dock: the launch monitor panel, loading details and the cache/HDR switches. */
export function Dock() {
  const h = useHud()
  const d = h.dock || {}
  return (
    <Collapsible open={h.shotPanel.open} onOpenChange={(o) => run("shotPanelOpen", o)} className="pointer-events-none fixed bottom-4 left-4 flex flex-col items-start gap-3 max-sm:hidden">
      <CollapsibleContent>
        <LaunchMonitor />
      </CollapsibleContent>
      <Card glass size="sm" className="pointer-events-auto flex-row flex-wrap items-center gap-1 px-1.5 py-1.5">
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
          <Light light={h.lm.light} />
          Launch monitor
          {h.shotPanel.label && <Badge variant="secondary">{h.shotPanel.label}</Badge>}
          <ChevronDown className={cn("transition-transform", h.shotPanel.open && "rotate-180")} />
        </CollapsibleTrigger>
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => run("diagnostics")}>
          {/fail|incomplete|issue|timed out|unavailable/i.test(h.diagnostic) ? "Something didn't load · retry" : /ready/i.test(h.diagnostic) ? "Loading details" : "Loading course…"}
          <ArrowUpRight />
        </Button>
        <Label className="gap-2 px-2 text-xs text-muted-foreground" title="Start on the tee from the browser cache: skips the build animation and course rebuilding">
          <Switch size="sm" defaultChecked={d.cache} onCheckedChange={(on) => run("setCache", on)} />
          Use cache
        </Label>
        <Label className="gap-2 px-2 text-xs text-muted-foreground" title={`16-bit HDR output: highlights brighter than SDR white on HDR displays${d.hdrOK ? "" : " (this display does not report HDR support)"}`}>
          <Switch size="sm" defaultChecked={d.hdr} onCheckedChange={(on) => run("setHdr", on)} />
          HDR
        </Label>
        {import.meta.env.DEV && d.dev && (
          <>
            <Button variant="ghost" size="sm" className="text-muted-foreground" title="Reload all code, workers and shaders and return to this view. Alt-click: swap only the WebGPU engine." onClick={(e) => run("hotReload", e.altKey)}>
              Hot reload
            </Button>
            <Button variant="ghost" size="sm" className="text-muted-foreground" title="Heightmap, surface masks and foliage of this hole for the Unreal Engine prototype" onClick={() => run("exportUnreal")}>
              Export for Unreal
            </Button>
          </>
        )}
      </Card>
    </Collapsible>
  )
}
