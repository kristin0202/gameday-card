# GameDay Card

Lovelace card for the [`espn_gameday`](../ha-espn-gameday) integration. Renders one of four states automatically — offseason countdown, host-site announcement, live show, final picks — plus conditional full-palette takeovers (Washington purple/gold 🐾, Michigan maize/blue 〽️) and a fresh-announcement pulse.

## Install (HACS)
1. HACS → Frontend → ⋮ → **Custom repositories** → add this repo URL, category **Dashboard** (Plugin).
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
palettes:              # add/override flair palettes
  washington:
    badge: "🐾 GO DAWGS"
```

## State logic
| Shown | When |
|---|---|
| Countdown | No host site known (offseason / early week) |
| Announced | `sensor.gameday_location` has a school |
| ON AIR | Now inside Sat 9am–12pm ET show window |
| Final Picks | Post-show Sat/Sun and `sensor.gameday_final_picks` = `available` |
| Flair takeover | `binary_sensor.gameday_flair_week` on — palette per `flair_team` |
| NEW pulse | `binary_sensor.gameday_new_announcement` on (~30 min) |
