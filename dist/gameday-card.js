/**
 * gameday-card — ESPN College GameDay card for Home Assistant
 * Pairs with the espn_gameday custom integration.
 *
 * Vanilla custom element: no build step, no dependencies.
 * States: offseason | announced | live | picks  (+ flair takeover, fresh pulse)
 *
 * Minimal config:
 *   type: custom:gameday-card
 * Options:
 *   prefix: gameday          # entity prefix
 *   show_odds: true
 *   palettes:                # optional overrides/additions, keyed by flair team
 *     washington: { primary: "#4B2E83", ... }
 */

const DEFAULT_PALETTES = {
  washington: {
    bg: "#2b1b4d", headGrad: "linear-gradient(90deg,#4B2E83,#32205c)",
    chipBg: "#3a2769", chipBorder: "#54408c",
    text: "#f3ecd4", subtext: "#bfa9e8", label: "#c9b98a",
    badgeBg: "#B7A57A", badgeText: "#2b1b4d", badge: "\u{1F43E} MONTLAKE",
    wordmark: "#e8d9a0",
  },
  michigan: {
    bg: "#001a33", headGrad: "linear-gradient(90deg,#00274C,#001a33)",
    chipBg: "#0a2f52", chipBorder: "#1b4470",
    text: "#fff8dc", subtext: "#8fb3d9", label: "#d9b504",
    badgeBg: "#FFCB05", badgeText: "#00274C", badge: "\u{3030}\u{FE0F} ANN ARBOR",
    wordmark: "#FFCB05",
  },
};

const BASE = {
  bg: "#111", headGrad: "linear-gradient(90deg,#cc0000,#8f0000)",
  chipBg: "#1d1d1d", chipBorder: "#2c2c2c",
  text: "#ffffff", subtext: "#aaaaaa", label: "#999999",
  badgeBg: "#000000", badgeText: "#ffffff", badge: "ESPN",
  wordmark: "#ffffff",
};

class GameDayCard extends HTMLElement {
  static getStubConfig() {
    return { prefix: "gameday", show_odds: true };
  }

  setConfig(config) {
    this._config = {
      prefix: "gameday",
      show_odds: true,
      ...config,
    };
    this._palettes = { ...DEFAULT_PALETTES, ...(config.palettes || {}) };
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
    this._manageTicker();
  }

  getCardSize() {
    return 4;
  }

  disconnectedCallback() {
    this._stopTicker();
  }

  // ------------------------------------------------------------------
  _entity(suffix, domain = "sensor") {
    return this._hass?.states?.[`${domain}.${this._config.prefix}_${suffix}`];
  }

  _collect() {
    const nextShow = this._entity("next_show");
    const location = this._entity("location");
    const picker = this._entity("guest_picker");
    const game = this._entity("featured_game");
    const picks = this._entity("final_picks");
    const flair = this._entity("flair_week", "binary_sensor");
    const fresh = this._entity("new_announcement", "binary_sensor");
    return { nextShow, location, picker, game, picks, flair, fresh };
  }

  _phase(d) {
    if (!d.nextShow) return "unavailable";
    const now = Date.now();
    const showStart = Date.parse(d.nextShow.state);
    const showEnd = Date.parse(d.nextShow.attributes.show_end || "");
    const hasLocation = d.location && d.location.state !== "TBA" &&
      d.location.state !== "unavailable" && d.location.state !== "unknown";
    const havePicks = d.picks && d.picks.state === "available";

    if (!Number.isNaN(showStart) && !Number.isNaN(showEnd) &&
        now >= showStart && now < showEnd && hasLocation) return "live";
    if (havePicks && !Number.isNaN(showEnd) && now >= showEnd &&
        this._sameLocalDayOrSunday(showEnd)) return "picks";
    if (hasLocation) return "announced";
    return "offseason";
  }

  _sameLocalDayOrSunday(showEndMs) {
    const end = new Date(showEndMs);
    const now = new Date();
    const day = now.getDay(); // 0 Sun, 6 Sat
    return (day === 6 && now.toDateString() === end.toDateString()) || day === 0;
  }

  _palette(d) {
    const flairOn = d.flair && d.flair.state === "on";
    const team = flairOn ? (d.flair.attributes.flair_team || "") : "";
    return this._palettes[team] || BASE;
  }

  // ------------------------------------------------------------------
  _render() {
    if (!this._hass || !this._config || !this.shadowRoot) return;
    const d = this._collect();
    const phase = this._phase(d);
    this._currentPhase = phase;
    const p = this._palette(d);
    const freshOn = d.fresh && d.fresh.state === "on";

    let body;
    if (phase === "unavailable") body = this._viewUnavailable();
    else if (phase === "offseason") body = this._viewOffseason(d, p);
    else if (phase === "live") body = this._viewLive(d, p);
    else if (phase === "picks") body = this._viewPicks(d, p);
    else body = this._viewAnnounced(d, p, freshOn);

    const onAir = phase === "live";
    const badgeHtml = freshOn && phase === "announced"
      ? `<span class="badge" style="background:#fff;color:#cc0000;">NEW</span>`
      : `<span class="badge" style="background:${p.badgeBg};color:${p.badgeText};">${p.badge}</span>`;

    this.shadowRoot.innerHTML = `
      <style>${this._css(p, freshOn && phase === "announced")}</style>
      <ha-card class="${freshOn && phase === "announced" ? "fresh" : ""}">
        <div class="head" style="${onAir ? "background:#cc0000;" : `background:${p.headGrad};`}">
          <span class="wordmark" style="color:${p.wordmark};">
            ${onAir ? '<span class="dot"></span>ON AIR' : "COLLEGE GAMEDAY"}
          </span>
          ${badgeHtml}
        </div>
        <div class="body">${body}</div>
      </ha-card>`;
  }

  _css(p, fresh) {
    return `
      ha-card { background:${p.bg}; color:${p.text}; overflow:hidden; border-radius:16px; }
      .head { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; }
      .wordmark { font-weight:900; font-style:italic; letter-spacing:.5px; font-size:15px; }
      .badge { font-weight:800; font-size:10px; padding:3px 7px; border-radius:4px; letter-spacing:1px; }
      .body { padding:16px; }
      .label { font-size:10px; letter-spacing:2px; color:${p.label}; font-weight:700; text-transform:uppercase; }
      .hero { font-size:24px; font-weight:900; margin-top:2px; }
      .sub { font-size:13px; color:${p.subtext}; }
      .matchup { margin-top:12px; font-size:15px; font-weight:700; }
      .strip { display:flex; gap:8px; margin-top:14px; }
      .chip { flex:1; background:${p.chipBg}; border:1px solid ${p.chipBorder}; border-radius:10px; padding:8px 4px; text-align:center; }
      .chip .v { font-size:14px; font-weight:800; }
      .chip .k { font-size:9px; letter-spacing:1.5px; color:${p.label}; margin-top:2px; text-transform:uppercase; }
      .picker { display:flex; align-items:center; gap:10px; margin-top:14px; background:${p.chipBg}; border:1px solid ${p.chipBorder}; border-radius:10px; padding:10px 12px; }
      .avatar { width:34px; height:34px; border-radius:50%; background:${p.badgeBg}; color:${p.badgeText}; display:flex; align-items:center; justify-content:center; font-size:16px; flex:none; }
      .cd { flex:1; background:${p.chipBg}; border:1px solid ${p.chipBorder}; border-radius:12px; padding:12px 4px; text-align:center; }
      .cd .n { font-size:26px; font-weight:900; color:#ff2e2e; font-variant-numeric:tabular-nums; }
      .cd .u { font-size:9px; letter-spacing:2px; color:${p.label}; text-transform:uppercase; margin-top:2px; }
      .pickrow { display:flex; align-items:center; justify-content:space-between; padding:9px 12px; background:${p.chipBg}; border:1px solid ${p.chipBorder}; border-radius:10px; margin-top:8px; }
      .pickrow .who { font-weight:700; font-size:13px; }
      .pickchip { font-weight:900; font-size:13px; padding:4px 10px; border-radius:6px; background:rgba(255,255,255,.08); }
      .pickrow.guest { border-color:#cc0000; }
      .foot { margin-top:12px; font-size:11px; color:${p.label}; }
      .foot a { color:${p.subtext}; }
      @keyframes gd-pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
      .dot { width:9px; height:9px; border-radius:50%; background:#fff; animation:gd-pulse 1.2s infinite; display:inline-block; margin-right:6px; }
      @keyframes gd-fresh { 0%{box-shadow:0 0 0 0 rgba(255,46,46,.6)} 100%{box-shadow:0 0 0 14px rgba(255,46,46,0)} }
      ${fresh ? "ha-card.fresh { animation:gd-fresh 1.6s ease-out infinite; }" : ""}
      @media (prefers-reduced-motion: reduce) { .dot, ha-card.fresh { animation:none; } }
    `;
  }

  // --- Views ---------------------------------------------------------
  _viewUnavailable() {
    return `<div class="label">ESPN GameDay</div>
      <div class="sub" style="margin-top:6px;">Integration data unavailable — check the espn_gameday integration.</div>`;
  }

  _viewOffseason(d, p) {
    const target = Date.parse(d.nextShow.state);
    const cd = this._countdown(target);
    const when = Number.isNaN(target)
      ? "Premiere date TBA"
      : new Date(target).toLocaleString([], {
          weekday: "long", month: "short", day: "numeric",
          hour: "numeric", minute: "2-digit",
        });
    return `
      <div class="label">Season Premiere</div>
      <div style="font-size:17px; font-weight:800; margin-top:4px;">${when}</div>
      ${cd ? `<div class="strip" style="margin-top:16px;">
        <div class="cd"><div class="n">${cd.d}</div><div class="u">Days</div></div>
        <div class="cd"><div class="n">${cd.h}</div><div class="u">Hours</div></div>
        <div class="cd"><div class="n">${cd.m}</div><div class="u">Min</div></div>
      </div>` : ""}
      <div class="foot">Location: <b>TBA</b> · announced week of premiere</div>`;
  }

  _gameStrip(d) {
    const a = d.game?.attributes || {};
    if (!a.matchup) return "";
    const kickoff = a.kickoff
      ? new Date(a.kickoff).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : "TBA";
    const chips = [
      `<div class="chip"><div class="v">${kickoff}</div><div class="k">Kickoff</div></div>`,
      a.tv ? `<div class="chip"><div class="v">${a.tv}</div><div class="k">TV</div></div>` : "",
      this._config.show_odds && a.spread
        ? `<div class="chip"><div class="v">${a.spread}</div><div class="k">Line</div></div>` : "",
      this._config.show_odds && a.over_under
        ? `<div class="chip"><div class="v">O/U ${a.over_under}</div><div class="k">Total</div></div>` : "",
    ].join("");
    return `<div class="matchup">${a.matchup}</div><div class="strip">${chips}</div>`;
  }

  _pickerRow(d) {
    const name = d.picker?.state && !["TBA", "unknown", "unavailable"].includes(d.picker.state)
      ? d.picker.state : null;
    return `<div class="picker">
      <div class="avatar">${name ? "\u{1F3A4}" : "\u2753"}</div>
      <div><div class="label">Guest Picker</div>
      <div style="font-weight:800;${name ? "" : "color:" + "#999" + ";"}">${name || "TBA"}</div></div>
    </div>`;
  }

  _locationHero(d, verb) {
    const school = d.location.state;
    const a = d.location.attributes || {};
    const cityLine = [a.city, a.state].filter(Boolean).join(", ");
    return `
      <div class="label">${verb}</div>
      <div class="hero">${(cityLine || school).toUpperCase()}</div>
      <div class="sub">${[a.venue, school].filter(Boolean).join(" \u00B7 ")}</div>`;
  }

  _viewAnnounced(d, p, fresh) {
    return `
      ${this._locationHero(d, "GameDay is headed to")}
      ${this._gameStrip(d)}
      ${this._pickerRow(d)}`;
  }

  _viewLive(d, p) {
    const end = Date.parse(d.nextShow.attributes.show_end || "");
    const endStr = Number.isNaN(end) ? "" :
      ` \u00B7 show ends ${new Date(end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    return `
      ${this._locationHero(d, "Live from")}
      <div class="sub" style="margin-top:4px;">Picks in the final segment${endStr}</div>
      ${this._gameStrip(d)}
      ${this._pickerRow(d)}`;
  }

  _viewPicks(d, p) {
    const attrs = d.picks?.attributes || {};
    const picks = attrs.picks || {};
    const pickerName = d.picker?.state;
    const rows = Object.entries(picks).map(([who, team]) => {
      const guest = pickerName && who.toLowerCase().includes(pickerName.toLowerCase().split(" ")[0]);
      return `<div class="pickrow ${guest ? "guest" : ""}">
        <div class="who">${guest ? "\u{1F3A4} " : ""}${who}</div>
        <div class="pickchip">${String(team).toUpperCase()}</div></div>`;
    }).join("");
    const counts = {};
    Object.values(picks).forEach((t) => { counts[t] = (counts[t] || 0) + 1; });
    const consensus = Object.entries(counts).sort((x, y) => y[1] - x[1])[0];
    const src = attrs.source_url
      ? ` \u00B7 <a href="${attrs.source_url}" target="_blank" rel="noreferrer">source</a>` : "";
    return `
      <div class="label">Final Picks \u00B7 ${d.location?.state || ""}</div>
      <div style="font-size:16px; font-weight:800; margin-top:2px;">${d.game?.attributes?.matchup || ""}</div>
      ${rows}
      <div class="foot">${consensus ? `Consensus: ${consensus[0]} ${consensus[1]}\u2013${Object.values(picks).length - consensus[1]}` : ""}${src}</div>`;
  }

  // --- Countdown ticker ---------------------------------------------
  _countdown(targetMs) {
    if (Number.isNaN(targetMs)) return null;
    let diff = Math.max(0, targetMs - Date.now());
    const d = Math.floor(diff / 86400000); diff -= d * 86400000;
    const h = Math.floor(diff / 3600000); diff -= h * 3600000;
    const m = Math.floor(diff / 60000);
    return { d, h, m };
  }

  _manageTicker() {
    if (this._currentPhase === "offseason") {
      if (!this._ticker) {
        this._ticker = setInterval(() => this._render(), 30000);
      }
    } else {
      this._stopTicker();
    }
  }

  _stopTicker() {
    if (this._ticker) {
      clearInterval(this._ticker);
      this._ticker = null;
    }
  }
}

customElements.define("gameday-card", GameDayCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "gameday-card",
  name: "GameDay Card",
  description: "ESPN College GameDay: countdown, host site, guest picker, final picks.",
});

console.info("%c GAMEDAY-CARD %c 0.1.0 ", "background:#cc0000;color:#fff;font-weight:700;", "background:#111;color:#fff;");
