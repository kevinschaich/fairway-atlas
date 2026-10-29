import { useSyncExternalStore } from "react"
import { act as gameAct, hud } from "../game/hud.js"

// The game (plain JS) owns the state's shape; components read it loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Hud = Record<string, any>
export const useHud = () => useSyncExternalStore(hud.subscribe, hud.get) as Hud
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const act = gameAct as Record<string, (...args: any[]) => any>
/** Call a game action if the game has registered it yet. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const run = (name: string, ...args: any[]) => act[name]?.(...args)
