import path from "node:path"
import { rm } from "node:fs/promises"
import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// Dev-only endpoints the game's tools call: frame capture (window.__capture) and the Audio lab API, which also
// rebuilds public/audio/manifest.json when the game asks for it.
const devTools = (): Plugin => ({
  name: "fairway-dev-tools",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url ?? "/", "http://localhost")
      if (url.pathname === "/audio/manifest.json") await (await import("./scripts/audio-manifest.mjs")).buildAudioManifest()
      if (url.pathname.startsWith("/__")) {
        const { audioLab } = await import("./scripts/audio-lab-api.mjs")
        if (await audioLab(req, res, url)) return
      }
      next()
    })
  },
})

// The Audio lab page is a dev tool; it never ships.
const dropDevPages = (): Plugin => ({
  name: "fairway-drop-dev-pages",
  apply: "build",
  async closeBundle() {
    await rm(path.resolve(import.meta.dirname, "dist/audio-lab.html"), { force: true })
    await rm(path.resolve(import.meta.dirname, "dist/audio/reviewed.json"), { force: true })
  },
})

// Relative asset paths, so the build works at its own vercel.app URL and under kevinschaich.com/project/<slug>/.
export default defineConfig(({ command }) => ({
  base: "./",
  plugins: [react(), tailwindcss(), devTools(), dropDevPages()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  // The game gates its dev tools (hot reload, ?debug, frame capture, Unreal export) on __FA_DEV__ !== false.
  define: command === "build" ? { "globalThis.__FA_DEV__": "false" } : {},
  worker: { format: "es" },
  // The audio manifest and credits are rewritten whenever the game asks for the manifest; reloading on that loops.
  server: { watch: { ignored: ["**/public/audio/manifest.json", "**/CREDITS.md", "**/.captures/**", "**/audio-trash/**"] } },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 2000 },
}))
