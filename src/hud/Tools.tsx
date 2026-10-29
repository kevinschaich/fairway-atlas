import { Button, ButtonGroup, ButtonGroupSeparator, Card, Tooltip, TooltipContent, TooltipTrigger } from "@kevinschaich/components"
import { Expand, LocateFixed, Map, Minus, Move3d, Plane, Plus, RotateCcw, ScanEye, Target } from "lucide-react"
import type { ReactNode } from "react"
import { DataSources } from "../DataSources"
import { run, useHud } from "./use-hud"

function Tool({ label, keys, active, disabled, onClick, children }: { label: string; keys?: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant={active ? "secondary" : "ghost"} size="icon" aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick} />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="right">
        {label}
        {keys && <span className="ml-1.5 text-muted-foreground">{keys}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

/** Camera and view tools down the left edge, with the Data sources (i) at the bottom. */
export function Tools() {
  const h = useHud()
  const t = h.tool
  return (
    <Card glass size="sm" className="pointer-events-auto fixed top-48 left-4 w-auto px-1.5 py-1.5 max-sm:top-auto max-sm:bottom-24">
      <ButtonGroup orientation="vertical" aria-label="Camera and view">
      <Tool label="Restart hole" disabled={h.restartDisabled} onClick={() => run("restart")}>
        <RotateCcw />
      </Tool>
      <ButtonGroupSeparator orientation="horizontal" />
      <Tool label="Play" keys="1" active={t === "play"} onClick={() => run("camera", "shot")}>
        <Target />
      </Tool>
      <Tool label="Course map" keys="2" active={t === "map" || t === "overview"} onClick={() => run("camera", "plan")}>
        <Map />
      </Tool>
      <Tool label="Drone flyover" keys="3" active={t === "fly"} onClick={() => run("camera", "fly")}>
        <Plane />
      </Tool>
      <Tool label="Explore freely" keys="5" active={t === "free"} onClick={() => run("camera", "free")}>
        <Move3d />
      </Tool>
      <Tool label={h.follow ? "Follow ball flight: on" : "Follow ball flight: off"} keys="4" active={h.follow} onClick={() => run("toggleFollow")}>
        <ScanEye />
      </Tool>
      <ButtonGroupSeparator orientation="horizontal" />
      <Tool label="Zoom in" onClick={() => run("zoom", -5)}>
        <Plus />
      </Tool>
      <Tool label="Zoom out" onClick={() => run("zoom", 5)}>
        <Minus />
      </Tool>
      <Tool label="Return to ball" onClick={() => run("camera", "shot")}>
        <LocateFixed />
      </Tool>
      <Tool label="Full screen" onClick={() => run("fullScreen")}>
        <Expand />
      </Tool>
      <ButtonGroupSeparator orientation="horizontal" />
      <DataSources />
      </ButtonGroup>
    </Card>
  )
}
