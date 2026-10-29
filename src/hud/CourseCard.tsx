import { Byline, Card, Stat, ToggleGroup, ToggleGroupItem } from "@kevinschaich/components"
import { MapPin } from "lucide-react"
import { useEffect, useRef } from "react"
import { cn } from "@/lib/cn"
import { run, useHud } from "./use-hud"

/** Course name, location, the hole strip and this hole's strokes. Click it for the scorecard. */
export function CourseCard() {
  const h = useHud()
  const strip = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const a = strip.current?.querySelector<HTMLElement>("[data-pressed]")
    a?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" })
  }, [h.hole.number, h.holes.length])
  if (!h.course.name) return null
  return (
    <Card
      glass
      size="sm"
      className="pointer-events-auto fixed top-4 left-4 w-72 cursor-pointer gap-3 select-none max-sm:right-4 max-sm:w-auto"
      onClick={(e) => !(e.target as HTMLElement).closest("button,a,[role=group]") && !h.roundDisabled && run("scorecard")}
    >
      <div className="px-3">
        <div className="truncate font-heading text-base font-semibold">{h.course.name}</div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground uppercase">
          <MapPin className="size-3" />
          <span className="truncate">{h.course.location}</span>
        </div>
      </div>
      <div className="grid grid-cols-2 border-t">
        <Stat
          className="border-r px-3 pt-2"
          label="Hole"
          value={
            h.holes.length ? (
              <div ref={strip} className="overflow-x-auto [scrollbar-width:none]">
                <ToggleGroup
                  size="sm"
                  spacing={0}
                  value={[String(h.hole.number)]}
                  onValueChange={([v]) => v && run("loadHole", +v)}
                  aria-label="Hole"
                >
                  {h.holes.map((x: { n: number; par: number; active: boolean; completed: boolean }) => (
                    <ToggleGroupItem
                      key={x.n}
                      value={String(x.n)}
                      aria-label={`Hole ${x.n}, par ${x.par}`}
                      className={cn("text-base tabular-nums", !x.active && !x.completed && "text-muted-foreground/60")}
                    >
                      {x.n}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            ) : (
              h.hole.number || null
            )
          }
        />
        <Stat
          className="px-3 pt-2"
          label={h.hole.par ? `Par ${h.hole.par}${h.hole.parEstimated ? "*" : ""}` : "Stroke"}
          value={
            <span className="flex gap-1.5 text-lg">
              {h.strokeTrack.map((s: { k: number; state: string; over: boolean }) => (
                <span
                  key={s.k}
                  className={cn("text-muted-foreground/50", s.state === "done" && "text-muted-foreground", s.state === "now" && "text-foreground", s.over && "text-destructive/80")}
                >
                  {s.k}
                </span>
              ))}
            </span>
          }
        />
      </div>
      <div className="border-t px-3 pt-2 text-xs text-muted-foreground">
        <Byline repo="kevinschaich/fairway-atlas" />
      </div>
    </Card>
  )
}
