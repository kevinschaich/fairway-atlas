import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  Kbd,
  KbdGroup,
  NativeSelect,
  NativeSelectOption,
  ScrollArea,
  Stat,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@kevinschaich/components"
import { ArrowUpRight } from "lucide-react"
import { useState, type ReactNode } from "react"
import { cn } from "@/lib/cn"
import { Sources } from "./Sources"
import { run, useHud } from "./use-hud"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type D = Record<string, any>

const Metrics = ({ items }: { items: [string | number, string][] }) => (
  <div className="grid grid-cols-3 gap-3">
    {items.map(([v, l]) => (
      <Stat key={l} boxed label={l} value={v} />
    ))}
  </div>
)

function Complete({ d }: { d: D }) {
  return (
    <>
      <DialogHeader>
        <DialogDescription className="text-xs tracking-wider uppercase">Hole {d.hole} complete</DialogDescription>
        <DialogTitle className="text-2xl">{d.title}</DialogTitle>
      </DialogHeader>
      <div className="py-2 text-center font-heading text-6xl font-semibold">{d.strokes}</div>
      <p className="text-center text-sm text-muted-foreground">
        {d.delta > 0 ? "+" : ""}
        {d.delta} to par · {d.shots} shots · {d.penalties} penalty strokes
      </p>
      <DialogFooter>
        <Button onClick={d.next}>Next mapped hole</Button>
      </DialogFooter>
    </>
  )
}

const SCORE: Record<string, string> = {
  eagle: "rounded-full bg-amber-400/30 ring-2 ring-amber-400/60",
  birdie: "rounded-full ring-1 ring-foreground/60",
  bogey: "rounded-sm ring-1 ring-foreground/40",
  double: "rounded-sm ring-2 ring-foreground/40",
}
type HoleRow = { n: number; par: number | null; parEstimated: boolean; score: number | null; inProgress: number | null; penalties: number }

function Nine({ holes, tees, current, label }: { holes: HoleRow[]; tees: D[]; current: number; label: string }) {
  if (!holes.length) return null
  const done = holes.filter((h) => h.score != null)
  const par = holes.reduce((s, h) => s + (h.par || 0), 0)
  const cls = (h: HoleRow) => {
    if (h.score == null || h.par == null) return ""
    const d = h.score - h.par
    return d <= -2 ? SCORE.eagle : d === -1 ? SCORE.birdie : d === 0 ? "" : d === 1 ? SCORE.bogey : SCORE.double
  }
  return (
    <Table className="text-center tabular-nums">
      <TableHeader>
        <TableRow>
          <TableHead className="text-left">Hole</TableHead>
          {holes.map((h) => (
            <TableHead key={h.n} className={cn("text-center", h.n === current && "text-foreground")}>
              {h.n}
            </TableHead>
          ))}
          <TableHead className="text-center">{label}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tees.map((t) => (
          <TableRow key={t.name} className="text-muted-foreground">
            <TableCell className="text-left">
              <span className="mr-1.5 inline-block size-2 rounded-full" style={{ background: t.color }} />
              {t.name[0].toUpperCase() + t.name.slice(1)}
            </TableCell>
            {holes.map((h) => (
              <TableCell key={h.n}>{t.yards[h.n] ?? "—"}</TableCell>
            ))}
            <TableCell>{holes.reduce((s, h) => s + (t.yards[h.n] || 0), 0) || "—"}</TableCell>
          </TableRow>
        ))}
        <TableRow>
          <TableCell className="text-left">Par</TableCell>
          {holes.map((h) => (
            <TableCell key={h.n}>
              {h.par ?? "—"}
              {h.parEstimated ? "*" : ""}
            </TableCell>
          ))}
          <TableCell>{par}</TableCell>
        </TableRow>
        <TableRow className="font-semibold">
          <TableCell className="text-left">Score</TableCell>
          {holes.map((h) => (
            <TableCell key={h.n} className={cn(h.n === current && "bg-muted/50")}>
              <span className={cn("inline-flex size-6 items-center justify-center", cls(h))}>
                {h.score ?? (h.inProgress ? <em className="font-normal text-muted-foreground">{h.inProgress}</em> : "·")}
              </span>
              {h.penalties > 0 && <sup className="text-destructive">{"•".repeat(Math.min(3, h.penalties))}</sup>}
            </TableCell>
          ))}
          <TableCell>{done.length ? done.reduce((s, h) => s + (h.score || 0), 0) : "—"}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  )
}

function Scorecard({ d }: { d: D }) {
  const holes: HoleRow[] = d.holes
  const done = holes.filter((h) => h.score != null)
  const total = done.reduce((s, h) => s + (h.score || 0), 0)
  const par = done.reduce((s, h) => s + (h.par || 0), 0)
  const front = holes.slice(0, 9),
    back = holes.slice(9)
  return (
    <>
      <DialogHeader>
        <DialogDescription className="text-xs tracking-wider uppercase">Saved on this device</DialogDescription>
        <DialogTitle>Your round at {d.courseName}</DialogTitle>
      </DialogHeader>
      <Metrics
        items={[
          [`${done.length}/${holes.length}`, "Holes completed"],
          [total || "—", "Completed strokes"],
          [done.length ? (total - par > 0 ? "+" : "") + (total - par) : "—", "To par"],
        ]}
      />
      <div className="overflow-x-auto">
        <Nine holes={front} tees={d.tees} current={d.current} label={back.length ? "Out" : "Tot"} />
        <Nine holes={back} tees={d.tees} current={d.current} label="In" />
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        {[
          ["birdie", "Birdie"],
          ["eagle", "Eagle"],
          ["bogey", "Bogey"],
          ["double", "Double+"],
        ].map(([k, l]) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={cn("inline-block size-3", SCORE[k])} />
            {l}
          </span>
        ))}
        <span>
          <sup className="text-destructive">•</sup> Penalty
        </span>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => run("restartHole")}>
          Restart this hole
        </Button>
        <Button variant="outline" onClick={() => run("downloadRound")}>
          Export shot history
        </Button>
      </DialogFooter>
    </>
  )
}

function Shot({ d }: { d: D }) {
  return (
    <>
      <DialogHeader>
        <DialogDescription className="text-xs tracking-wider uppercase">{d.measured ? "Measured ball launch" : "Simulated club impact"}</DialogDescription>
        <DialogTitle>The story of your shot</DialogTitle>
      </DialogHeader>
      <Metrics items={d.metrics} />
      <p className="text-sm text-muted-foreground">
        Result: <span className="font-medium text-foreground">{d.outcome}</span>
      </p>
      <DialogFooter>
        <Button variant="ghost" render={<a href="https://github.com/kevinschaich/fairway-atlas/blob/main/docs.md#ball-physics" target="_blank" rel="noopener" />}>
          How the ball moves <ArrowUpRight />
        </Button>
        <Button onClick={() => run("launchInput")}>Enter launch data</Button>
      </DialogFooter>
    </>
  )
}

function Edit({ d }: { d: D }) {
  const [feature, setFeature] = useState(d.features[0]?.id ?? "")
  const [dx, setDx] = useState("0")
  const [dz, setDz] = useState("0")
  const [routing, setRouting] = useState(d.routing)
  return (
    <>
      <DialogHeader>
        <DialogDescription className="text-xs tracking-wider uppercase">Local corrections</DialogDescription>
        <DialogTitle>Refine the evidence</DialogTitle>
        <DialogDescription>
          Shift a mapped feature in metres or reorder the hole references. Corrections stay on this device, are marked as user-edited and never change OpenStreetMap. Editing is
          available before a hole's first shot.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="editFeature">Feature</FieldLabel>
          <NativeSelect id="editFeature" value={feature} onChange={(e) => setFeature(e.target.value)}>
            {d.features.map((f: D) => (
              <NativeSelectOption key={f.id} value={f.id}>
                {f.kind} · {f.id}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field>
            <FieldLabel htmlFor="editX">Move east (m)</FieldLabel>
            <Input id="editX" type="number" min={-50} max={50} step={0.5} value={dx} onChange={(e) => setDx(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="editZ">Move south (m)</FieldLabel>
            <Input id="editZ" type="number" min={-50} max={50} step={0.5} value={dz} onChange={(e) => setDz(e.target.value)} />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="editRouting">Routing order</FieldLabel>
          <Input id="editRouting" value={routing} onChange={(e) => setRouting(e.target.value)} />
        </Field>
        {d.message && <FieldError>{d.message}</FieldError>}
      </FieldGroup>
      <DialogFooter>
        <Button variant="outline" onClick={() => run("clearEdits")}>
          Reset local corrections
        </Button>
        <Button onClick={() => run("saveEdits", { feature, dx: +dx, dz: +dz, routing })}>Save corrections</Button>
      </DialogFooter>
    </>
  )
}

const KEYS: [string, string, ReactNode][] = [
  ["Shot", "Aim", ["←", "→"]],
  ["Shot", "Carry", ["↑", "↓"]],
  ["Shot", "Start meter · strike", ["Space"]],
  ["Shot", "Next · previous club", ["−", "+"]],
  ["Camera", "Play view", ["1"]],
  ["Camera", "Course map", ["2"]],
  ["Camera", "Drone flyover", ["3"]],
  ["Camera", "Free camera", ["5"]],
  ["Camera", "Look · field of view", ["Drag", "Scroll"]],
  ["Camera", "Move · down · up", ["W A S D", "Q", "E"]],
  ["Camera", "Move faster", ["Shift"]],
  ["Camera", "Pivot ↔ mouse-look", ["Middle click"]],
  ["Camera", "Hold camera · back to ball", ["Esc"]],
  ["Camera", "Course search", ["⌘ K"]],
  ["Camera", "Sound on / off", ["M"]],
  ["Camera", "Green grid on / off", ["G"]],
] as never
function Help() {
  return (
    <>
      <DialogHeader>
        <DialogDescription className="text-xs tracking-wider uppercase">A quick walkthrough</DialogDescription>
        <DialogTitle>One shot at a time</DialogTitle>
      </DialogHeader>
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
        <li>
          <span className="font-medium">Read your shot.</span> <span className="text-muted-foreground">Pick a club, set your aim and carry, and check the suggested power.</span>
        </li>
        <li>
          <span className="font-medium">Find your tempo.</span>{" "}
          <span className="text-muted-foreground">Press Space to start the meter, then again at your chosen power. The flight plays in real time.</span>
        </li>
        <li>
          <span className="font-medium">Finish the hole.</span> <span className="text-muted-foreground">On the green, use the putter and less power. Your round saves on this device.</span>
        </li>
      </ol>
      {["Shot", "Camera"].map((g) => (
        <div key={g} className="flex flex-col gap-1">
          <div className="text-xs font-medium tracking-wider text-muted-foreground uppercase">{g}</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
            {KEYS.filter((k) => k[0] === g).map(([, label, keys]) => (
              <div key={label} className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{label}</span>
                <KbdGroup>
                  {(keys as string[]).map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </KbdGroup>
              </div>
            ))}
          </div>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        The sliders button opens appearance and ball-physics conditions. Click the course card for the scorecard. The course map overlays mapped boundaries on the same terrain.
      </p>
    </>
  )
}

function Diagnostics({ d }: { d: D }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Loading details</DialogTitle>
        <DialogDescription>What happened while this course loaded. If something failed, retry or try another map server.</DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor="providerOrder">Map servers, in the order tried</FieldLabel>
        <NativeSelect id="providerOrder" value={d.order} onChange={(e) => run("setProviderOrder", e.target.value)}>
          {d.orders.map(([v, label]: [string, string]) => (
            <NativeSelectOption key={v} value={v}>
              {label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <ScrollArea className="h-64 rounded-lg border">
        <pre className="p-3 font-mono text-xs whitespace-pre-wrap">{d.log}</pre>
      </ScrollArea>
      <DialogFooter>
        <Button onClick={() => run("retryLoad")}>Retry selected course</Button>
      </DialogFooter>
    </>
  )
}

function ErrorBody({ d }: { d: D }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Couldn't open this course</DialogTitle>
        <DialogDescription>Your current round is saved. Try again, or pick another course.</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button onClick={d.retry}>Retry this course</Button>
      </DialogFooter>
    </>
  )
}

const BODIES: Record<string, (p: { d: D }) => ReactNode> = {
  complete: Complete,
  scorecard: Scorecard,
  shot: Shot,
  sources: Sources,
  edit: Edit,
  help: Help,
  diagnostics: Diagnostics,
  error: ErrorBody,
}
const WIDE = new Set(["scorecard", "sources", "help"])

/** Every game dialog, one at a time, from the game's `dialog` state. */
export function GameDialog() {
  const { dialog } = useHud()
  const Body = dialog && BODIES[dialog.kind]
  return (
    <Dialog open={!!Body} onOpenChange={(o) => !o && run("closeDialog")}>
      <DialogContent className={cn("max-h-[85vh] overflow-y-auto", WIDE.has(dialog?.kind) ? "sm:max-w-3xl" : "sm:max-w-lg")}>{Body && <Body d={dialog} />}</DialogContent>
    </Dialog>
  )
}

function LaunchForm({ li }: { li: D }) {
  const [values, setValues] = useState<Record<string, string>>(li.values)
  const [mode, setMode] = useState<string>(li.mode)
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        run("submitLaunch", { mode, values })
      }}
    >
      <Tabs value={mode} onValueChange={(v) => setMode(v as string)}>
        <TabsList className="w-full">
          <TabsTrigger value="ball">Measured ball launch</TabsTrigger>
          <TabsTrigger value="club">Predict from club delivery</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="grid grid-cols-2 gap-3">
        {li.fields.map((f: D) => {
          const disabled = mode === "club" && f.ball
          return (
            <Field key={f.name} data-disabled={disabled || undefined}>
              <FieldLabel htmlFor={`li-${f.name}`}>{f.label}</FieldLabel>
              <Input
                id={`li-${f.name}`}
                type="number"
                step="any"
                min={f.min}
                max={f.max}
                disabled={disabled}
                required={mode === "ball" ? f.ball : !f.ball && !f.name.startsWith("impact")}
                value={values[f.name] ?? ""}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
              />
            </Field>
          )
        })}
      </div>
      {li.error && <FieldError>{li.error}</FieldError>}
      <DialogFooter>
        <Button type="submit">Play this shot</Button>
      </DialogFooter>
    </form>
  )
}

/** Launch data entry: measured ball launch, or club delivery that predicts the ball. */
export function LaunchInput() {
  const { launchInput: li } = useHud()
  return (
    <Dialog open={!!li} onOpenChange={(o) => !o && run("closeLaunchInput")}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogDescription className="text-xs tracking-wider uppercase">Launch data</DialogDescription>
          <DialogTitle>Play the measured shot</DialogTitle>
          <DialogDescription>
            Ball measurements drive flight directly. Club delivery predicts missing ball values. To stream shots from a Square Omni, use Connect in the launch monitor panel.
          </DialogDescription>
        </DialogHeader>
        {li && <LaunchForm key={li.id} li={li} />}
      </DialogContent>
    </Dialog>
  )
}
