import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import "./theme.css"
import { App } from "./App"

// Render the page synchronously, then start the game. It draws into #scene and publishes its state to the HUD
// (game/hud.js).
const root = createRoot(document.getElementById("root")!)
flushSync(() =>
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
)
await import("./game/app.js")
