import {
  Button,
  Card,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  Kbd,
  KbdGroup,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  ScrollArea,
  Separator,
  Slider,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@kevinschaich/components"
import { ArrowUp, CircleHelp, Search, SlidersHorizontal } from "lucide-react"
import { run, useHud } from "./use-hud"

const one = (v: number | readonly number[]) => (typeof v === "number" ? v : v[0])

function Settings() {
  const h = useHud()
  return (
    <Popover open={h.settingsOpen} onOpenChange={(o) => run("settings", o)}>
      <PopoverTrigger render={<Button variant="ghost" size="icon" aria-label="Appearance and conditions" />}>
        <SlidersHorizontal />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <ScrollArea className="max-h-[75vh]">
          <div className="flex flex-col gap-4 p-4">
            <PopoverHeader>
              <PopoverTitle>Appearance</PopoverTitle>
              <PopoverDescription>The sun follows the course's latitude and the date. Time of day is in the shot card.</PopoverDescription>
            </PopoverHeader>
            <Tabs value={h.visual} onValueChange={(v) => run("setVisual", v)}>
              <TabsList className="w-full">
                <TabsTrigger value="natural">Natural</TabsTrigger>
                <TabsTrigger value="stylized">Field study</TabsTrigger>
              </TabsList>
            </Tabs>
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="sunDate">Date</FieldLabel>
                <Input id="sunDate" type="date" value={h.lighting.date} onChange={(e) => run("setDate", e.target.value)} />
              </Field>
              <Field>
                <FieldLabel>
                  Cloud cover <span className="ml-auto text-muted-foreground tabular-nums">{Math.round(h.lighting.clouds * 100)}%</span>
                </FieldLabel>
                <Slider aria-label="Cloud cover" min={0} max={0.8} step={0.01} value={h.lighting.clouds} onValueChange={(v) => run("setClouds", one(v))} />
              </Field>
            </FieldGroup>
            <Separator />
            <PopoverHeader>
              <PopoverTitle>Ball physics and conditions</PopoverTitle>
              <PopoverDescription>Green speed is the dry Stimpmeter reading; dampness changes how surfaces respond.</PopoverDescription>
            </PopoverHeader>
            <FieldGroup className="gap-4">
              {(h.conditions || []).map((c: { k: string; label: string; step: number; min: number; max: number; value: number; text: string }) => (
                <Field key={c.k}>
                  <FieldLabel>
                    {c.label} <span className="ml-auto text-muted-foreground tabular-nums">{c.text}</span>
                  </FieldLabel>
                  <Slider aria-label={c.label} min={c.min} max={c.max} step={c.step} value={c.value} onValueChange={(v) => run("setCondition", c.k, one(v))} />
                </Field>
              ))}
            </FieldGroup>
            <Button variant="outline" onClick={() => run("launchInput")}>
              Enter launch data
            </Button>
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}

/** Search, settings and help in the top right, with the wind under them. */
export function TopBar() {
  const h = useHud()
  return (
    <div className="pointer-events-none fixed top-4 right-4 flex flex-col items-end gap-3 max-sm:top-auto max-sm:bottom-4">
      <Card glass size="sm" className="pointer-events-auto flex-row items-center gap-1 px-1.5 py-1.5">
        <Button variant="ghost" className="gap-2 text-muted-foreground" onClick={() => run("openSearch")}>
          <Search />
          Find a course
          <KbdGroup className="ml-4">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        </Button>
        <Settings />
        <Button variant="ghost" size="icon" aria-label="How to play" onClick={() => run("help")}>
          <CircleHelp />
        </Button>
      </Card>
      {h.wind.speed && h.mode === "play" && !h.overview && (
        <Card glass size="sm" className="pointer-events-auto flex-row items-center gap-3 px-3 py-2" aria-label={`Wind ${h.wind.speed} mph, ${h.wind.text}`} title="Simulated wind, relative to your aim">
          <ArrowUp className="size-5 transition-transform" style={{ transform: `rotate(${h.wind.angle}deg)` }} />
          <div className="leading-tight">
            <div className="font-semibold tabular-nums">
              {h.wind.speed} <span className="text-xs text-muted-foreground">mph</span>
            </div>
            <div className="text-xs text-muted-foreground">{h.wind.text}</div>
          </div>
        </Card>
      )}
    </div>
  )
}
