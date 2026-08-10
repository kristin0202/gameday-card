"""DataUpdateCoordinator for ESPN College GameDay (v0.2 schedule model).

Core idea: announced sites live in a per-week ``schedule`` map. The
"current location" is a DERIVED VIEW — the schedule entry for the week
containing the next show — so promotion on week rollover is automatic.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util

from .api import EspnApiError, EspnClient
from .const import (
    CONF_FLAIR_TEAMS,
    DEFAULT_FLAIR_TEAMS,
    DOMAIN,
    EVENT_LOCATION,
    EVENT_PICKER,
    EVENT_PICKS,
    FRESH_WINDOW,
    INTERVAL_HOT,
    INTERVAL_IN_SEASON,
    INTERVAL_OFFSEASON,
    LOCAL_TZ,
    PHASE_IN_SEASON,
    PHASE_OFFSEASON,
    SHOW_END_HOUR_ET,
    SHOW_START_HOUR_ET,
    SHOW_TZ,
    STORAGE_KEY,
    STORAGE_VERSION,
)
from . import parser

_LOGGER = logging.getLogger(__name__)

ET = ZoneInfo(SHOW_TZ)
CT = ZoneInfo(LOCAL_TZ)

LOOKAHEAD_WEEKS = 2  # fetch current week + this many ahead


class GameDayCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Fetches ESPN data, maintains the per-week schedule, derives state."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=INTERVAL_IN_SEASON,
        )
        self.entry = entry
        self.client = EspnClient(async_get_clientsession(hass))
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        # schedule: {"<week>": {school, game_id, source_url, ...}}
        # overrides: {"location:<week>" | "picker" | "picks": {value, set_at}}
        self.state: dict[str, Any] = {
            "schedule": {},
            "picker": None,
            "picks": None,
            "overrides": {},
            "last_primary": None,
        }
        self.primary_week: int | None = None
        raw = entry.data.get(CONF_FLAIR_TEAMS, DEFAULT_FLAIR_TEAMS)
        self.flair_teams = [t.strip().lower() for t in raw.split(",") if t.strip()]

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------
    async def async_load_store(self) -> None:
        stored = await self._store.async_load()
        if stored:
            # v0.1 -> v0.2 migration: drop legacy single-slot keys.
            stored.pop("location", None)
            legacy = stored.get("overrides", {}).pop("location", None)
            if legacy:
                _LOGGER.info(
                    "Legacy single-slot location override dropped during "
                    "v0.2 migration; re-run espn_gameday.set_location with a week."
                )
            self.state.update({k: v for k, v in stored.items() if k in self.state})

    async def _async_save(self) -> None:
        await self._store.async_save(self.state)

    # ------------------------------------------------------------------
    # Override services
    # ------------------------------------------------------------------
    async def async_set_location(
        self, school: str, week: int | None = None, source_url: str = ""
    ) -> None:
        target = week or self.primary_week or 1
        self.state["overrides"][f"location:{target}"] = {
            "value": {"school": school, "source_url": source_url, "week": target},
            "set_at": dt_util.utcnow().isoformat(),
        }
        await self._async_save()
        await self.async_request_refresh()

    async def async_set_override(self, key: str, value: Any) -> None:
        self.state["overrides"][key] = {
            "value": value,
            "set_at": dt_util.utcnow().isoformat(),
        }
        await self._async_save()
        await self.async_request_refresh()

    async def async_clear_overrides(self) -> None:
        self.state["overrides"] = {}
        await self._async_save()
        await self.async_request_refresh()

    # ------------------------------------------------------------------
    # Update cycle
    # ------------------------------------------------------------------
    async def _async_update_data(self) -> dict[str, Any]:
        try:
            scoreboard = await self.client.get_scoreboard()
        except EspnApiError as err:
            raise UpdateFailed(str(err)) from err

        league = (scoreboard.get("leagues") or [{}])[0]
        season = league.get("season", {}) or {}
        season_start = _parse_iso(season.get("startDate"))
        season_end = _parse_iso(season.get("endDate"))
        season_year = season.get("year")
        base_week = (scoreboard.get("week") or {}).get("number")

        now = dt_util.utcnow()
        phase = (
            PHASE_IN_SEASON
            if season_start and season_end and season_start <= now <= season_end
            else PHASE_OFFSEASON
        )

        premiere = _premiere_from_calendar(league)
        next_show, show_end = _next_show_window(
            now, season_start, season_end, premiere
        )
        windows = _week_windows(league)
        self.primary_week = _week_of(next_show, windows) or base_week

        # --- Multi-week event fetch: primary week + lookahead ---
        events_by_week: dict[int, list[dict]] = {}
        if base_week is not None:
            events_by_week[base_week] = scoreboard.get("events") or []
        if self.primary_week is not None:
            for wk in range(self.primary_week, self.primary_week + LOOKAHEAD_WEEKS + 1):
                if wk in events_by_week or (windows and wk not in windows):
                    continue
                try:
                    board = await self.client.get_scoreboard(week=wk)
                    events_by_week[wk] = board.get("events") or []
                except EspnApiError as err:
                    _LOGGER.debug("Week %s scoreboard fetch failed: %s", wk, err)

        # --- News parsing: always on; early announcements age out fast ---
        articles: list[dict] = []
        try:
            articles = await self.client.get_news()
        except EspnApiError as err:
            _LOGGER.warning("News fetch failed (non-fatal): %s", err)

        games_by_week = {
            wk: parser.build_game_aliases(evs) for wk, evs in events_by_week.items()
        }
        for week, candidate in parser.find_locations(articles, games_by_week).items():
            self._reconcile_week(week, candidate)
        self._reconcile("picker", parser.find_picker(articles), EVENT_PICKER)
        if show_end is None or now >= show_end or _is_sunday_ct(now):
            self._reconcile("picks", parser.find_picks(articles), EVENT_PICKS)

        self._rollover()

        location = self._effective_location(self.primary_week)
        picker = self._effective("picker")
        picks = self._effective("picks")

        featured_game = None
        if location and self.primary_week is not None:
            featured_game = _enrich_featured_game(
                location, events_by_week.get(self.primary_week, [])
            )
        flair_team = _match_flair(location, featured_game, self.flair_teams)

        upcoming = self._build_upcoming(events_by_week)

        await self._async_save()
        self.update_interval = self._compute_interval(now, phase, next_show)

        return {
            "phase": phase,
            "season_year": season_year,
            "week_number": self.primary_week,
            "next_show": next_show,
            "show_end": show_end,
            "location": location,
            "picker": picker,
            "picks": picks,
            "featured_game": featured_game,
            "flair_team": flair_team,
            "upcoming": upcoming,
            "fresh_until": self._fresh_until(),
        }

    # ------------------------------------------------------------------
    # Schedule helpers
    # ------------------------------------------------------------------
    def _reconcile_week(self, week: int, parsed: dict) -> None:
        wk = str(week)
        if f"location:{week}" in self.state["overrides"]:
            return
        current = self.state["schedule"].get(wk)
        if current and current.get("school") == parsed.get("school"):
            return
        parsed["announced_at"] = dt_util.utcnow().isoformat()
        parsed["method"] = "parsed"
        parsed["week"] = week
        self.state["schedule"][wk] = parsed
        self.hass.bus.async_fire(EVENT_LOCATION, parsed)
        _LOGGER.info("GameDay week %s site: %s", week, parsed.get("school"))

    def _reconcile(self, key: str, parsed: dict | None, event: str) -> None:
        if parsed is None:
            return
        current = self.state.get(key)
        marker = parsed.get("name") or str(parsed.get("picks"))
        current_marker = None
        if current:
            current_marker = current.get("name") or str(current.get("picks"))
        if marker and marker != current_marker:
            parsed["announced_at"] = dt_util.utcnow().isoformat()
            parsed["method"] = "parsed"
            self.state[key] = parsed
            self.hass.bus.async_fire(event, parsed)
            _LOGGER.info("GameDay %s update: %s", key, marker)

    def _rollover(self) -> None:
        """Drop past weeks; clear week-scoped state when the week advances."""
        if self.primary_week is None:
            return
        last = self.state.get("last_primary")
        if last is not None and last != self.primary_week:
            # New show week: last week's picker/picks are stale.
            self.state["picker"] = None
            self.state["picks"] = None
            self.state["overrides"].pop("picker", None)
            self.state["overrides"].pop("picks", None)
        self.state["last_primary"] = self.primary_week
        self.state["schedule"] = {
            wk: entry
            for wk, entry in self.state["schedule"].items()
            if int(wk) >= self.primary_week
        }
        self.state["overrides"] = {
            key: val
            for key, val in self.state["overrides"].items()
            if not key.startswith("location:")
            or int(key.split(":")[1]) >= self.primary_week
        }

    def _effective_location(self, week: int | None) -> dict | None:
        if week is None:
            return None
        override = self.state["overrides"].get(f"location:{week}")
        if override:
            value = dict(override["value"])
            value["method"] = "manual"
            value["announced_at"] = override["set_at"]
            return value
        return self.state["schedule"].get(str(week))

    def _effective(self, key: str) -> dict | None:
        override = self.state["overrides"].get(key)
        if override:
            value = override["value"]
            base = dict(value) if isinstance(value, dict) else {"value": value}
            base["method"] = "manual"
            base["announced_at"] = override["set_at"]
            return base
        return self.state.get(key)

    def _build_upcoming(self, events_by_week: dict[int, list[dict]]) -> list[dict]:
        if self.primary_week is None:
            return []
        weeks: set[int] = {int(wk) for wk in self.state["schedule"]}
        for key in self.state["overrides"]:
            if key.startswith("location:"):
                weeks.add(int(key.split(":")[1]))
        out: list[dict] = []
        for wk in sorted(w for w in weeks if w > self.primary_week):
            entry = self._effective_location(wk)
            if not entry:
                continue
            item = {"week": wk, "school": entry.get("school")}
            game = _enrich_featured_game(entry, events_by_week.get(wk, []))
            if game:
                item["matchup"] = game.get("matchup")
                item["kickoff"] = game.get("kickoff")
                item["city"] = game.get("city")
                item["state"] = game.get("state")
            out.append(item)
        return out

    def _fresh_until(self) -> str | None:
        stamps = []
        location = self._effective_location(self.primary_week)
        for data in (location, self._effective("picker")):
            if data and data.get("method") == "manual":
                continue
            if data and data.get("announced_at"):
                parsed = _parse_iso(data["announced_at"])
                if parsed:
                    stamps.append(parsed)
        if not stamps:
            return None
        return (max(stamps) + FRESH_WINDOW).isoformat()

    @staticmethod
    def _compute_interval(
        now: datetime, phase: str, next_show: datetime | None
    ) -> timedelta:
        if phase == PHASE_OFFSEASON:
            if next_show and (next_show - now) <= timedelta(days=21):
                return INTERVAL_IN_SEASON
            return INTERVAL_OFFSEASON
        local = now.astimezone(CT)
        weekday, hour = local.weekday(), local.hour
        if weekday == 5 and 5 <= hour < 12:
            return INTERVAL_HOT
        if (weekday == 5 and hour >= 18) or weekday == 6:
            return INTERVAL_HOT
        return INTERVAL_IN_SEASON


# ----------------------------------------------------------------------
# Module-level pure helpers
# ----------------------------------------------------------------------
def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = dt_util.parse_datetime(value)
    except (ValueError, TypeError):
        return None
    if parsed and parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt_util.UTC)
    return parsed


def _week_windows(league: dict) -> dict[int, tuple[datetime, datetime]]:
    """{week_number: (start, end)} from the REGULAR season calendar block."""
    out: dict[int, tuple[datetime, datetime]] = {}
    for block in league.get("calendar") or []:
        if not isinstance(block, dict):
            return out
        label = (block.get("label") or "").lower()
        if "regular" not in label and str(block.get("value")) != "2":
            continue
        for entry in block.get("entries") or []:
            num: int | None = None
            try:
                num = int(entry.get("value"))
            except (TypeError, ValueError):
                match = re.search(r"(\d+)", entry.get("label") or "")
                num = int(match.group(1)) if match else None
            start = _parse_iso(entry.get("startDate"))
            end = _parse_iso(entry.get("endDate"))
            if num is not None and start and end:
                out[num] = (start, end)
    return out


def _week_of(
    moment: datetime | None, windows: dict[int, tuple[datetime, datetime]]
) -> int | None:
    if not moment:
        return None
    for num, (start, end) in windows.items():
        if start <= moment <= end:
            return num
    return None


def _premiere_from_calendar(league: dict) -> datetime | None:
    """Premiere Saturday derived from the regular-season Week 1 entry.

    ESPN usually folds Week 0 into its 'Week 1' entry, so anchor to the
    LAST Saturday on/before that entry's endDate, at 9:00 AM ET.
    """
    for block in league.get("calendar") or []:
        if not isinstance(block, dict):
            return None
        label = (block.get("label") or "").lower()
        if "regular" not in label and str(block.get("value")) != "2":
            continue
        entries = block.get("entries") or []
        if not entries:
            return None
        end = _parse_iso(entries[0].get("endDate"))
        if not end:
            return None
        local = end.astimezone(ET)
        days_back = (local.weekday() - 5) % 7
        saturday = (local - timedelta(days=days_back)).replace(
            hour=SHOW_START_HOUR_ET, minute=0, second=0, microsecond=0
        )
        return saturday.astimezone(dt_util.UTC)
    return None


def _next_show_window(
    now: datetime,
    season_start: datetime | None,
    season_end: datetime | None,
    premiere: datetime | None = None,
) -> tuple[datetime | None, datetime | None]:
    """Next Saturday 9:00-12:00 ET inside the season (premiere-anchored)."""
    if not season_start or not season_end:
        return None, None
    if premiere and now < premiere:
        end_et = premiere.astimezone(ET).replace(hour=SHOW_END_HOUR_ET)
        return premiere, end_et.astimezone(dt_util.UTC)
    cursor = max(now, season_start).astimezone(ET)
    for _ in range(0, 8):
        days_ahead = (5 - cursor.weekday()) % 7
        candidate = (cursor + timedelta(days=days_ahead)).replace(
            hour=SHOW_START_HOUR_ET, minute=0, second=0, microsecond=0
        )
        end = candidate.replace(hour=SHOW_END_HOUR_ET)
        if end <= now.astimezone(ET):
            cursor = candidate + timedelta(days=1)
            continue
        if candidate.astimezone(dt_util.UTC) > season_end:
            return None, None
        return candidate.astimezone(dt_util.UTC), end.astimezone(dt_util.UTC)
    return None, None


def _is_sunday_ct(now: datetime) -> bool:
    return now.astimezone(CT).weekday() == 6


def _hex(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip()
    return value if value.startswith("#") else f"#{value}"


def _enrich_featured_game(location: dict, events: list[dict]) -> dict | None:
    """Matchup/kickoff/TV/odds + host-team colors for the located game."""
    target = None
    game_id = location.get("game_id")
    school = (location.get("school") or "").lower()
    for ev in events:
        if game_id and str(ev.get("id")) == str(game_id):
            target = ev
            break
        comps = (ev.get("competitions") or [{}])[0]
        for comp in comps.get("competitors") or []:
            team = comp.get("team", {})
            names = {
                (team.get("location") or "").lower(),
                (team.get("displayName") or "").lower(),
            }
            if school and school in names and comp.get("homeAway") == "home":
                target = ev
                break
        if target:
            break
    if not target:
        return None

    comps = (target.get("competitions") or [{}])[0]
    competitors = comps.get("competitors") or []

    def _side(side: str) -> dict:
        comp = next((c for c in competitors if c.get("homeAway") == side), {})
        team = comp.get("team", {})
        rank = (comp.get("curatedRank") or {}).get("current")
        logos = team.get("logos") or []
        return {
            "name": team.get("displayName"),
            "abbr": team.get("abbreviation"),
            "rank": rank if rank and rank != 99 else None,
            "color": _hex(team.get("color")),
            "alt_color": _hex(team.get("alternateColor")),
            "logo": team.get("logo") or (logos[0].get("href") if logos else None),
        }

    home, away = _side("home"), _side("away")
    broadcast = ""
    broadcasts = comps.get("broadcasts") or []
    if broadcasts:
        names = broadcasts[0].get("names") or []
        broadcast = names[0] if names else ""
    odds = (comps.get("odds") or [{}])[0]
    venue = comps.get("venue", {}) or {}

    def _fmt(team: dict) -> str:
        prefix = f"#{team['rank']} " if team.get("rank") else ""
        return f"{prefix}{team.get('name') or '?'}"

    return {
        "matchup": f"{_fmt(away)} at {_fmt(home)}",
        "home": home,
        "away": away,
        "kickoff": target.get("date"),
        "tv": broadcast,
        "spread": odds.get("details"),
        "over_under": odds.get("overUnder"),
        "venue": venue.get("fullName"),
        "city": (venue.get("address", {}) or {}).get("city"),
        "state": (venue.get("address", {}) or {}).get("state"),
    }


def _match_flair(
    location: dict | None, featured_game: dict | None, flair_teams: list[str]
) -> str | None:
    candidates: set[str] = set()
    if location and location.get("school"):
        candidates.add(location["school"].lower())
    if featured_game:
        home = featured_game.get("home", {})
        for value in (home.get("name"), home.get("abbr")):
            if value:
                candidates.add(value.lower())
    for flair in flair_teams:
        for cand in candidates:
            if flair in cand or cand in flair:
                return flair
    return None
