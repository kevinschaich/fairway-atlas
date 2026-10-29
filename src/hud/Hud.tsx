import { Toaster, TooltipProvider } from "@kevinschaich/components"
import { CourseCard } from "./CourseCard"
import { GameDialog, LaunchInput } from "./Dialogs"
import { Dock } from "./Dock"
import { ImpactCard } from "./ImpactCard"
import { MapPanel } from "./MapPanel"
import { BuildStatus, FreeHelp, GameToasts, Loading, SceneMarkers } from "./Overlays"
import { Search } from "./Search"
import { ShotCard } from "./ShotCard"
import { Tools } from "./Tools"
import { TopBar } from "./TopBar"

/** The whole game page: the WebGPU view, and the HUD over it. */
export function Hud() {
  return (
    <TooltipProvider delay={300}>
      <Toaster>
        <div id="scene" className="fixed inset-0" />
        <SceneMarkers />
        <div className="pointer-events-none fixed inset-0 z-20">
          <CourseCard />
          <Tools />
          <TopBar />
          <div className="fixed top-36 right-4 flex max-h-[calc(100vh-15rem)] flex-col items-end gap-3 overflow-y-auto [scrollbar-width:none] max-sm:hidden">
            <ShotCard />
            <ImpactCard />
            <MapPanel />
          </div>
          <Loading />
          <BuildStatus />
          <FreeHelp />
          <Dock />
        </div>
        <Search />
        <GameDialog />
        <LaunchInput />
        <GameToasts />
      </Toaster>
    </TooltipProvider>
  )
}
