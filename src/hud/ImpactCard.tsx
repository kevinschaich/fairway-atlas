import { Badge, Card, Stat, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@kevinschaich/components"
import "./impact-face.css"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/cn"
import { run, useHud } from "./use-hud"

/** Where the ball met the clubface, plus every shot metric. The face is a custom SVG diagram (impact-card.js). */
export function ImpactCard() {
  const h = useHud()
  const c = h.impact
  if (h.mode !== "play" || h.overview) return null
  return (
    <Collapsible open={c.open} onOpenChange={(o) => run("impactOpen", o)} render={<Card glass size="sm" className="pointer-events-auto w-64 shrink-0 gap-2 py-2" />}>
      <CollapsibleTrigger className="flex items-center gap-2 px-3 text-left">
        <span className="text-xs font-medium">Impact</span>
        <span className="truncate text-xs">{c.club}</span>
        {c.source && <Badge variant={c.sourceKind === "measured" ? "default" : "secondary"}>{c.source}</Badge>}
        <ChevronDown className={cn("ml-auto size-4 text-muted-foreground transition-transform", c.open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2">
        <figure className="px-3">
          <svg
            viewBox={c.viewBox}
            role="img"
            aria-label="Clubface impact location"
            className="impact-face mx-auto h-24 w-full"
            dangerouslySetInnerHTML={{ __html: c.svg }}
          />
          <figcaption className="text-center text-xs font-medium">
            {c.caption}
            {c.captionSub && <span className="block font-normal text-muted-foreground">{c.captionSub}</span>}
          </figcaption>
        </figure>
        <div className="grid max-h-[40vh] grid-cols-2 gap-x-3 gap-y-2 overflow-y-auto border-t px-3 pt-2">
          {c.rows.map((r: { label: string; value: string | null; unit: string }) => (
            <Stat key={r.label} label={r.label} value={r.value} unit={r.unit} size="sm" />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
