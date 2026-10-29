# Game audio

Drop, rename, move or delete files here; the game picks them up from their **folder and file name** alone. The dev server
rebuilds `manifest.json` on every page load (and `npm run build` / `npm test` rebuild it too), so a reload is all it takes.

## File names

```
<folder>/<kind>--fs<freesound id>[-<nn>][--g<gain>][--<any note>].mp3
```

- `<kind>`: what the sound is (lists below). Everything before the first `--`.
- `fs<id>`: the Freesound recording it came from (the number in its URL). Credits come from this id via `sources.json`.
  Add a new recording's id, author, title, URL and licence to `sources.json` (or run `scripts/audio-sources.mjs <url>`).
- `-<nn>`: which hit/take of that recording (clips chopped from multi-hit recordings).
- `--g<gain>` (optional): level for this file, e.g. `--g0.6` (1 = default).
- `--<note>` (optional): anything, ignored.

Every file of the same kind is a random alternative (never the same one twice in a row).

## Folders and kinds

| Folder | Kinds | Played |
|---|---|---|
| `ambience/` | `birds`, `meadow`, `tropical`, `desert`, `mountain`, `night`, `surf`, `gulls`, `distant-sea`, `lake` | Looping beds, mixed by place: birds by day everywhere, surf/gulls near the ocean, lake near water, desert / tropical / mountain by region and elevation, night insects after dusk. One whole file per recording, loops seamlessly. |
| `whoosh/` | `whoosh` | The club through the air (not the putter). Its loudest point is lined up just before impact. |
| `impact/` | `driver`, `wood`, `hybrid`, `iron`, `wedge`, `putter` | Club face on ball. |
| `land/` | `fairway` (also tees), `rough`, `green`, `sand`, `water`, `cup` | Every bounce of the ball, by the surface it lands on; `water` for a ball in the water, `cup` when it drops. |
| `_unused/` | anything | Ignored. Parking spot for candidates. |

Keep impacts / landings short (a hit plus its natural ring-out) and starting on the hit (a few ms of lead-in at most).

## Listened marks

`reviewed.json` records which sounds you have dealt with in the Audio lab (relabel, volume, delete/restore, or "Mark listened"), keyed by file content, so marks survive renames and moves. Newly added sounds show up as **New** until you deal with them.
