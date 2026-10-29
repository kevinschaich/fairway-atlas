import { Badge, Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@kevinschaich/components"
import { Flag } from "lucide-react"
import { run, useHud } from "./use-hud"

type Course = { id: string; name: string; location: string; note: string; holes: number[] }

/** Course search: the game filters its 31k-course index; the list just shows the matches. */
export function Search() {
  const { search: s } = useHud()
  return (
    <CommandDialog open={s.open} onOpenChange={(o) => !o && run("closeSearch")} title="Find a course" description="Search the worldwide OpenStreetMap course index" className="sm:max-w-xl">
      <Command shouldFilter={false}>
      <CommandInput placeholder="Course name, or Torrey Pines hole 3…" value={s.query} onValueChange={(q) => run("searchQuery", q)} />
      <CommandList className="max-h-[60vh]">
        <CommandEmpty>{s.empty}</CommandEmpty>
        <CommandGroup>
          {s.items.map((c: Course) => (
            <CommandItem key={c.id} value={c.id} onSelect={() => run("openCourse", c.id)} className="items-start gap-3">
              <Flag className="mt-0.5" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{c.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {[c.location, c.note].filter(Boolean).join(" · ")}
                </span>
              </div>
              {s.requestedHole && <Badge variant="secondary">Hole {s.requestedHole}</Badge>}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
      </Command>
    </CommandDialog>
  )
}
