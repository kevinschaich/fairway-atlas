import { Button, Card, Spinner, toast as toasts } from "@kevinschaich/components"
import { ArrowDown, ArrowUp, Check, Flag } from "lucide-react"
import { useEffect } from "react"
import { cn } from "@/lib/cn"
import { run, useHud } from "./use-hud"

/** Opening a course: what's loading, with Cancel. */
export function Loading() {
  const { loading } = useHud()
  if (!loading) return null
  return (
    <Card glass size="sm" className="pointer-events-auto fixed top-4 left-1/2 w-72 -translate-x-1/2" role="status">
      <div className="flex items-center gap-2 px-3">
        <Spinner />
        <span className="font-medium">{loading.title}</span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => run("cancelLoad")}>
          Cancel
        </Button>
      </div>
    </Card>
  )
}

/** The build pill: "Mowing fairways…", "Shaping greens…" while a hole assembles. */
export function BuildStatus() {
  const { build, loading } = useHud()
  if (!build || loading) return null
  return (
    <Card glass size="sm" className="fixed top-4 left-1/2 -translate-x-1/2 flex-row items-center gap-2 rounded-full px-4 py-2 text-sm" role="status">
      {build.done ? <Check className="size-4" /> : <Spinner />}
      <span>{build.text}</span>
    </Card>
  )
}

/** The game's messages, as toasts (with Undo where the game offers it). */
export function GameToasts() {
  const { toast } = useHud()
  useEffect(() => {
    if (!toast) return
    const id = toasts.add({
      description: toast.msg,
      timeout: toast.undo ? 8000 : 4500,
      actionProps: toast.undo ? { children: "Undo", onClick: toast.undo } : undefined,
    })
    return () => toasts.close(id)
  }, [toast])
  return null
}

/** Free camera help, with shortcuts back to the action. */
export function FreeHelp() {
  const { freeHelp } = useHud()
  if (!freeHelp) return null
  return (
    <Card glass size="sm" className="pointer-events-auto fixed bottom-4 left-1/2 -translate-x-1/2 flex-row items-center gap-3 px-3 py-2 text-sm max-sm:hidden">
      <span>
        <span className="font-medium">Explore freely</span>
        <span className="text-muted-foreground"> · drag to look · WASD move · Q/E down/up · Shift faster</span>
      </span>
      <Button variant="outline" size="sm" onClick={() => run("greenOverlook")}>
        Green overlook
      </Button>
      <Button size="sm" onClick={() => run("exitFree")}>
        Return to ball
      </Button>
    </Card>
  )
}

/** Things pinned to the 3D view. The game positions them every frame (by id), so React only fills them. */
export function SceneMarkers() {
  const h = useHud()
  return (
    <>
      <div
        id="flagLabel"
        className="pointer-events-none fixed z-10 hidden -translate-x-1/2 -translate-y-full pb-2 text-center text-sm font-semibold text-white [text-shadow:0_1px_4px_rgb(0_0_0/0.6)]"
      >
        <span className="flex items-center gap-1">
          <Flag className="size-3.5" /> {h.flag ? `${h.flag.yds} yds` : "—"}
        </span>
        {h.flag && (
          <span className="flex items-center justify-center gap-0.5 text-[10px] font-medium text-white/80">
            {h.flag.up ? <ArrowUp className="size-2.5" /> : <ArrowDown className="size-2.5" />}
            {h.flag.ft} ft
          </span>
        )}
      </div>
      <div id="carryMarker" aria-hidden className="pointer-events-none fixed z-10 hidden size-3 -translate-1/2 rounded-full border-2 border-white/90 shadow" />
      <div
        id="holeMarkers"
        className="pointer-events-none fixed inset-0 z-10 hidden [&>button]:pointer-events-auto [&>button]:absolute [&>button]:top-0 [&>button]:left-0 [&>button]:flex [&>button]:size-7 [&>button]:items-center [&>button]:justify-center [&>button]:rounded-full [&>button]:border [&>button]:bg-card/80 [&>button]:text-xs [&>button]:font-semibold [&>button]:backdrop-blur [&>button.current]:bg-primary [&>button.current]:text-primary-foreground"
      />
      <div
        aria-hidden
        className={cn("pointer-events-none fixed top-1/2 left-1/2 size-1.5 -translate-1/2 rounded-full bg-white/70", (!h.crosshair || h.mode !== "play" || h.overview) && "hidden")}
      />
    </>
  )
}
