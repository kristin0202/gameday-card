# GameDay Card

Lovelace card for the [espn_gameday](https://github.com/kristin0202/ESPN-College-GameDay-Home-Assistant-Integration) integration. Renders one of four states automatically — offseason countdown, host-site announcement, live show, final picks — plus conditional full-palette takeovers (Washington purple/gold 🐾, Michigan maize/blue 〽️) and a fresh-announcement pulse.

## Install (HACS 2.x)
1. Sidebar → **HACS** → ⋮ (top-right, next to search) → **Custom repositories** → add this repo URL, type **Dashboard**.
2. Install **GameDay Card**. HACS registers the resource automatically; if installing manually, add:
   `Settings → Dashboards → Resources → /hacsfiles/gameday-card/gameday-card.js (JavaScript module)`

## Use
```yaml
type: custom:gameday-card
```
That's it. Options:
```yaml
type: custom:gameday-card
prefix: gameday        # entity prefix (matches integration defaults)
show_odds: true        # hide the Line / O/U chips with false
palettes:              # pin any school's colors/badge (else ESPN's official hexes are used)
  washington:
    badge: "🐾 GO DAWGS"
  lsu:
    primary: "#461D7C"
    alternate: "#FDD023"
    badge: "GEAUX"
```

## Theming
Every announced week paints the card in the **host school's official colors** (from ESPN data) through a contrast engine — LSU week is purple/gold, Texas week is burnt orange, automatically. Curated pins (Washington 🐾, Michigan 〽️) outrank ESPN hexes. ESPN red/black appears only when no host site is known. Light/dark follows your HA theme (`hass.themes.darkMode`, tracks the device on Auto).

## State logic
| Shown | When |
|---|---|
| Countdown | No host site known (offseason / early week) |
| Announced | `sensor.gameday_location` has a school |
| ON AIR | Now inside Sat 9am–12pm ET show window |
| Final Picks | Post-show Sat/Sun and `sensor.gameday_final_picks` = `available` |
| Flair takeover | `binary_sensor.gameday_flair_week` on — palette per `flair_team` |
| NEW pulse | `binary_sensor.gameday_new_announcement` on (~30 min) |
