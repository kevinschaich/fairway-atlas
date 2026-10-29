import { Button, Card, Field, FieldLabel, Kbd, KbdGroup, Separator, Slider, Stat } from "@kevinschaich/components"
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Crosshair } from "lucide-react"
import { run, useHud } from "./use-hud"

const one = (v: number | readonly number[]) => (typeof v === "number" ? v : v[0])
/** The club, the lie, power and aim, the swing, and time of day: everything for the next shot. */
export function ShotCard() {
  const h = useHud()
  if (h.mode !== "play" || h.overview || !h.club.abbr) return null
  return (
    <Card glass size="sm" className="pointer-events-auto w-64 shrink-0 gap-0 py-0">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <Button variant="ghost" size="icon-sm" aria-label="Previous club" onClick={() => run("prevClub")}>
          <ChevronLeft />
        </Button>
        <Button variant="ghost" className="h-auto min-w-0 flex-1 justify-start gap-2 px-1" title={h.club.range} onClick={() => run("nextClub")}>
          <span className="font-heading text-2xl font-semibold">{h.club.abbr}</span>
          <span className="truncate text-xs text-muted-foreground">
            {h.club.name} · {h.club.loft}°
          </span>
          {h.club.thumb && <img src={h.club.thumb} alt="" width={56} height={36} className="ml-auto" />}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Next club" onClick={() => run("nextClub")}>
          <ChevronRight />
        </Button>
      </div>
      <Separator />
      <div className="grid grid-cols-2 gap-3 px-3 py-2.5">
        <Stat label="Lie" size="sm" value={h.lie || null} sub={h.lieQuality} />
        <Stat
          label="To pin"
          size="sm"
          align="end"
          value={h.distance}
          unit="yds"
          sub={
            h.elevation ? (
              <span className="flex items-center gap-0.5">
                {h.elevation.up ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
                {h.elevation.ft} ft
              </span>
            ) : (
              "flat preview"
            )
          }
        />
      </div>
      <Separator />
      <div className="flex flex-col gap-3 px-3 py-2.5">
        <Field>
        <FieldLabel>
          Power
          <KbdGroup className="ml-auto">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
          </KbdGroup>
        </FieldLabel>
        <div className="flex items-baseline justify-between">
          <span className="text-lg font-semibold tabular-nums">{h.powerYards} yds</span>
          <span className="text-sm text-muted-foreground tabular-nums">{Math.round(h.power)}%</span>
        </div>
        <div className="relative">
          <Slider
            aria-label="Shot power"
            min={1}
            max={110}
            step={1}
            value={Math.round(h.power)}
            onValueChange={(v) => run("setPower", one(v))}
            title={`Stock clubhead speed × ${Math.round(h.power)}%. Partial swings normally generate less spin.`}
          />
          <span
            className="pointer-events-none absolute -top-1.5 h-4 w-px bg-muted-foreground/60"
            style={{ left: `${(h.suggested / 110) * 100}%` }}
            title={`Suggested ${h.suggested}%`}
          />
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-muted" hidden={!h.swing.metering}>
          <div id="swingMeterFill" className="h-full w-0 bg-primary" />
        </div>
        </Field>
        <Field>
        <FieldLabel>
          Aim <span className="text-muted-foreground tabular-nums">{h.aim.toFixed(1)}°</span>
          <KbdGroup className="ml-auto">
            <Kbd>←</Kbd>
            <Kbd>→</Kbd>
          </KbdGroup>
        </FieldLabel>
        <div className="flex items-center gap-2">
          <Slider
            aria-label="Aim angle"
            min={-180}
            max={180}
            step={0.5}
            value={h.aim}
            onValueChange={(v) => run("setAim", one(v), false)}
            onValueCommitted={(v) => run("setAim", one(v), true)}
          />
          <Button variant="ghost" size="icon-sm" title="Caddie line" aria-label="Caddie line" onClick={() => run("caddieAim")}>
            <Crosshair />
          </Button>
        </div>
        </Field>
        <div className="flex flex-col gap-1">
          <Button disabled={h.swing.disabled} onClick={() => run("swing")}>
            {h.swing.label}
            <Kbd className="ml-auto">Space</Kbd>
          </Button>
          <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={h.swing.preciseDisabled} title="Play at the slider power without timing" onClick={() => run("preciseShot")}>
            Play at set power
          </Button>
        </div>
      </div>
      <Separator />
      <Field className="px-3 py-2.5">
        <FieldLabel>
          Time of day <span className="ml-auto text-muted-foreground tabular-nums">{h.time.label}</span>
        </FieldLabel>
        <Slider
          aria-label="Time of day"
          title={h.time.title}
          min={h.time.min}
          max={h.time.max}
          step={0.01}
          value={Math.max(h.time.min, Math.min(h.time.max, h.time.hour))}
          onValueChange={(v) => run("setHour", one(v))}
        />
      </Field>
    </Card>
  )
}
