# GameDay Card

Lovelace card for the [espn_gameday](https://github.com/kristin0202/ESPN-College-GameDay-Home-Assistant-Integration) integration (requires **≥ 0.4.0** for school-name and poll-ranked matchup strings). Renders one of four states automatically — offseason countdown, host-site announcement, live show, final picks — plus host-school color theming, conditional flair takeovers (Washington purple/gold 🐾, Michigan maize/blue 〽️), guest-picker portraits, and an up-next queue.

## Install (HACS 2.x)
1. Sidebar → **HACS** → ⋮ (top-right, next to search) → **Custom repositories** → add this repo URL, type **Dashboard**.
2. Install **GameDay Card**. HACS registers the resource automatically; if installing manually, add
   `Settings → Dashboards → Resources → /hacsfiles/gameday-card/gameday-card.js` (JavaScript module).
3. Hard-refresh the browser (or reset the companion app's frontend cache) after every update.

## Use
```yaml
type: custom:gameday-card
```
Options:
```yaml
type: custom:gameday-card
prefix: gameday          # entity prefix
show_odds: true          # false hides the Line / O/U chips
palettes:                # pin a school's colors/badge (else ESPN's official hexes are used)
  washington:
    badge: "🐾 GO DAWGS"
  lsu:
    primary: "#461D7C"
    alternate: "#FDD023"
    badge: "GEAUX"
picker_images:           # pin a guest-picker portrait (else Wikipedia is tried)
  "pat mcafee": "https://example.com/mcafee.jpg"
```

## State logic
| Shown | When |
|---|---|
| Countdown (3 tiles) | No host site known |
| Announced | `sensor.gameday_location` has a school; header shows a compact d/h/m countdown to showtime |
| ON AIR | Now inside the Sat 9am–12pm ET show window |
| Final Picks | Post-show Sat/Sun and `sensor.gameday_final_picks` = `available` |
| Flair takeover | `binary_sensor.gameday_flair_week` on — palette per `flair_team` |
| NEW pulse | `binary_sensor.gameday_new_announcement` on (~30 min, parsed announcements only) |

## Theming
Every announced week paints the card in the **host school's official colors** (from ESPN team data) through a contrast engine that derives readable surfaces in both modes — LSU week is purple/gold, Texas week is burnt orange, automatically. Curated pins outrank ESPN hexes; ESPN red/black appears only when no host site is known. Light/dark follows your HA theme (`hass.themes.darkMode`, which tracks the device when the theme is set to Auto).

## Guest-picker portraits
Resolution order: config pin → Wikipedia thumbnail → 🎤 avatar. Lookups are cached at module scope (including misses, so a picker with no article doesn't refetch on every tick), and a pinned URL that fails to load falls through to the lookup rather than leaving a broken tile.

## Layout
The card uses container queries on its own width, not the viewport — under 320px the hero and picker tile stack and the countdown's minutes segment drops. Correct behavior inside a narrow sections-grid column.

## Repo conventions
**The served file is `gameday-card.js` in the repo root.** Do not add a `dist/` directory — HACS searches `dist/` *before* the root, so a stale copy there silently shadows the real card. Keep exactly one card file, and keep integration files (`coordinator.py`, `manifest.json`) out of this repo.

Edit **either** in the GitHub web editor **or** by bulk upload — never both on the same file. Bulk uploads silently overwrite web edits.
