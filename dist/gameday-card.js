/**
 * gameday-card v0.2.0 — ESPN College GameDay card for Home Assistant
 * Pairs with the espn_gameday integration (>= 0.2.0).
 *
 * Theming: every announced week is painted in the HOST SCHOOL's official
 * colors (from ESPN's team color fields), run through a contrast engine
 * that derives readable surfaces for both dark and light modes. Curated
 * flair entries (UW 🐾, Michigan 〽️) pin hand-tuned hexes + badges.
 * Dark/light follows hass.themes.darkMode (falls back to the OS setting).
 *
 * Config:
 *   type: custom:gameday-card
 *   prefix: gameday
 *   show_odds: true
 *   palettes:                # optional per-school pins, lowercase keys
 *     lsu: { primary: "#461D7C", alternate: "#FDD023", badge: "GEAUX" }
 */

const FLAIR = {
  washington: { primary: "#4B2E83", alternate: "#B7A57A", badge: "\u{1F43E} MONTLAKE" },
  michigan: { primary: "#00274C", alternate: "#FFCB05", badge: "\u{3030}\u{FE0F} ANN ARBOR" },
};

const ESPN_BRAND = { primary: "#cc0000", alternate: "#1a1a1a", badge: "ESPN" };

// ---------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------
function normHex(h) {
  if (!h || typeof h !== "string") return null;
  let s = h.trim().replace("#", "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  return /^[0-9a-fA-F]{6}$/.test(s) ? `#${s.toLowerCase()}` : null;
}
function rgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lum(h) {
  const a = rgb(h).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
function contrast(c1, c2) {
  const l1 = lum(c1), l2 = lum(c2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
function mix(c1, c2, t) {
  const a = rgb(c1), b = rgb(c2);
  return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
function bestText(bg) {
  return contrast(bg, "#ffffff") >= contrast(bg, "#141414") ? "#ffffff" : "#141414";
}
/** Nudge `color` toward `toward` until it clears `ratio` against `bg`. */
function ensureContrast(color, bg, toward, ratio = 3) {
  let c = color;
  for (let i = 0; i < 10 && contrast(c, bg) < ratio; i++) c = mix(c, toward, 0.15);
  return c;
}

/** Full surface set from two brand hexes. */
function buildPalette(primaryIn, alternateIn, badge, dark) {
  let primary = normHex(primaryIn) || ESPN_BRAND.primary;
  let alternate = normHex(alternateIn) || mix(primary, dark ? "#ffffff" : "#000000", 0.4);
  // A near-white/near-black "primary" makes terrible surfaces — swap.
  const L = lum(primary);
  if ((L > 0.82 || L < 0.02) && normHex(alternateIn)) {
    [primary, alternate] = [alternate, primary];
  }
  if (dark) {
    const bg = mix(primary, "#0b0b0d", 0.78);
    const chipBg = mix(primary, "#0b0b0d", 0.6);
    const head1 = mix(primary, "#000000", 0.12);
    const text = bestText(bg);
    const badgeBg = ensureContrast(alternate, head1, bestText(head1) === "#ffffff" ? "#ffffff" : "#141414", 1.6);
    return {
      bg, chipBg,
      chipBorder: mix(primary, "#0b0b0d", 0.42),
      headGrad: `linear-gradient(90deg,${head1},${mix(primary, "#000000", 0.45)})`,
      headSolid: head1,
      text,
      subtext: mix(text, bg, 0.42),
      label: mix(text, bg, 0.55),
      badgeBg, badgeText: bestText(badgeBg),
      wordmark: bestText(head1),
      accent: ensureContrast(alternate, chipBg, text, 3),
      badge,
    };
  }
  const bg = mix(primary, "#ffffff", 0.93);
  const chipBg = mix(primary, "#ffffff", 0.86);
  const head1 = primary;
  const text = ensureContrast(mix(primary, "#141414", 0.82), bg, "#141414", 6);
  const badgeBg = ensureContrast(alternate, head1, bestText(head1) === "#ffffff" ? "#ffffff" : "#141414", 1.6);
  return {
    bg, chipBg,
    chipBorder: mix(primary, "#ffffff", 0.72),
    headGrad: `linear-gradient(90deg,${head1},${mix(primary, "#000000", 0.25)})`,
    headSolid: head1,
    text,
    subtext: mix(text, bg, 0.4),
    label: mix(text, bg, 0.5),
    badgeBg, badgeText: bestText(badgeBg),
    wordmark: bestText(head1),
    accent: ensureContrast(primary, chipBg, text, 3),
    badge,
  };
}

// ---------------------------------------------------------------------
class GameDayCard extends HTMLElement {
  static getStubConfig() {
    return { prefix: "gameday", show_odds: true };
  }

  setConfig(config) {
    this._config = { prefix: "gameday", show_odds: true, ...config };
    this._pins = { ...FLAIR };
    for (const [key, val] of Object.entries(config.palettes || {})) {
      this._pins[key.toLowerCase()] = { ...this._pins[key.toLowerCase()], ...val };
    }
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
    this._manageTicker();
  }

  getCardSize() { return 4; }
  disconnectedCallback() {
    this._stopTicker();
    if (this._freshTimer) { clearTimeout(this._freshTimer); this._freshTimer = null; }
  }

  _freshActive(d) {
    if (d.fresh?.state !== "on") return false;
    const until = Date.parse(d.nextShow?.attributes?.fresh_until || "");
    if (Number.isNaN(until)) return true; // no timestamp: trust the sensor
    if (Date.now() >= until) return false;
    if (!this._freshTimer) {
      // Re-render at expiry so the pulse stops even between integration polls.
      const delay = Math.min(Math.max(until - Date.now(), 1000), 31 * 60 * 1000);
      this._freshTimer = setTimeout(() => { this._freshTimer = null; this._render(); }, delay);
    }
    return true;
  }

  // ------------------------------------------------------------------
  _entity(suffix, domain = "sensor") {
    return this._hass?.states?.[`${domain}.${this._config.prefix}_${suffix}`];
  }

  _collect() {
    return {
      nextShow: this._entity("next_show"),
      location: this._entity("location"),
      picker: this._entity("guest_picker"),
      game: this._entity("featured_game"),
      picks: this._entity("final_picks"),
      upcoming: this._entity("upcoming"),
      flair: this._entity("flair_week", "binary_sensor"),
      fresh: this._entity("new_announcement", "binary_sensor"),
    };
  }

  _dark() {
    if (this._hass?.themes && typeof this._hass.themes.darkMode === "boolean") {
      return this._hass.themes.darkMode;
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
  }

  _phase(d) {
    if (!d.nextShow) return "unavailable";
    const now = Date.now();
    const showStart = Date.parse(d.nextShow.state);
    const showEnd = Date.parse(d.nextShow.attributes.show_end || "");
    const hasLocation = d.location && !["TBA", "unavailable", "unknown"].includes(d.location.state);
    const havePicks = d.picks && d.picks.state === "available";
    if (!Number.isNaN(showStart) && !Number.isNaN(showEnd) &&
        now >= showStart && now < showEnd && hasLocation) return "live";
    if (havePicks && !Number.isNaN(showEnd) && now >= showEnd &&
        this._postShowWindow(showEnd)) return "picks";
    if (hasLocation) return "announced";
    return "offseason";
  }

  _postShowWindow(showEndMs) {
    const end = new Date(showEndMs);
    const now = new Date();
    const day = now.getDay();
    return (day === 6 && now.toDateString() === end.toDateString()) || day === 0;
  }

  _palette(d, phase) {
    const dark = this._dark();
    if (phase === "offseason" || phase === "unavailable") {
      return buildPalette(ESPN_BRAND.primary, ESPN_BRAND.alternate, ESPN_BRAND.badge, dark);
    }
    // 1) curated/user pin — by flair team, then by school name
    const flairTeam = d.flair?.state === "on" ? (d.flair.attributes.flair_team || "") : "";
    const school = (d.location?.state || "").toLowerCase();
    const pin = this._pins[flairTeam] ||
      Object.entries(this._pins).find(([k]) => school.includes(k) || k.includes(school))?.[1];
    if (pin) {
      return buildPalette(pin.primary, pin.alternate, pin.badge || (d.game?.attributes?.home?.abbr ?? "ESPN"), dark);
    }
    // 2) ESPN host-school colors
    const home = d.game?.attributes?.home || {};
    if (normHex(home.color)) {
      return buildPalette(home.color, home.alt_color, home.abbr || "HOME", dark);
    }
    // 3) fallback: GameDay brand
    return buildPalette(ESPN_BRAND.primary, ESPN_BRAND.alternate, ESPN_BRAND.badge, dark);
  }

  // ------------------------------------------------------------------
  _render() {
    if (!this._hass || !this._config || !this.shadowRoot) return;
    const d = this._collect();
    const phase = this._phase(d);
    this._currentPhase = phase;
    const p = this._palette(d, phase);
    const freshOn = phase === "announced" && this._freshActive(d);

    let body;
    if (phase === "unavailable") body = this._viewUnavailable();
    else if (phase === "offseason") body = this._viewOffseason(d, p);
    else if (phase === "live") body = this._viewLive(d, p);
    else if (phase === "picks") body = this._viewPicks(d, p);
    else body = this._viewAnnounced(d, p);

    const onAir = phase === "live";
    const badgeHtml = freshOn
      ? `<span class="badge" style="background:#fff;color:#cc0000;">NEW</span>`
      : `<span class="badge" style="background:${p.badgeBg};color:${p.badgeText};">${p.badge}</span>`;

    this.shadowRoot.innerHTML = `
      <style>${this._css(p, freshOn)}</style>
      <ha-card class="${freshOn ? "fresh" : ""}">
        <div class="head" style="${onAir ? "background:#cc0000;" : `background:${p.headGrad};`}">
          <span class="wordmark" style="${onAir ? "color:#fff;" : `color:${p.wordmark};`}">
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
      .cd .n { font-size:26px; font-weight:900; color:${p.accent}; font-variant-numeric:tabular-nums; }
      .cd .u { font-size:9px; letter-spacing:2px; color:${p.label}; text-transform:uppercase; margin-top:2px; }
      .pickrow { display:flex; align-items:center; justify-content:space-between; padding:9px 12px; background:${p.chipBg}; border:1px solid ${p.chipBorder}; border-radius:10px; margin-top:8px; }
      .pickrow .who { font-weight:700; font-size:13px; }
      .pickchip { font-weight:900; font-size:13px; padding:4px 10px; border-radius:6px; background:${p.chipBorder}; }
      .pickrow.guest { border-color:${p.accent}; }
      .uprow { display:flex; align-items:center; gap:10px; padding:8px 12px; background:${p.chipBg}; border:1px solid ${p.chipBorder}; border-radius:10px; margin-top:8px; font-size:13px; }
      .upwk { font-weight:900; font-size:11px; letter-spacing:1px; color:${p.accent}; flex:none; }
      .upschool { font-weight:800; flex:none; }
      .upmatch { color:${p.subtext}; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
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

  _upNext(d) {
    const rows = (d.upcoming?.attributes?.schedule || []).slice(0, 3).map((e) => {
      const place = e.city ? `${e.city}${e.state ? ", " + e.state : ""}` : (e.school || "");
      return `
      <div class="uprow">
        <span class="upwk">WK ${e.week}</span>
        <span class="upschool">${place}</span>
        <span class="upmatch">${e.matchup || ""}</span>
      </div>`;
    }).join("");
    return rows ? `<div class="label" style="margin-top:14px;">Up Next</div>${rows}` : "";
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
      <div class="foot">Location: <b>TBA</b> · announced week of premiere</div>
      ${this._upNext(d)}`;
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

  _pickerRow(d, p) {
    const name = d.picker?.state && !["TBA", "unknown", "unavailable"].includes(d.picker.state)
      ? d.picker.state : null;
    return `<div class="picker">
      <div class="avatar">${name ? "\u{1F3A4}" : "\u2753"}</div>
      <div><div class="label">Guest Picker</div>
      <div style="font-weight:800;${name ? "" : `color:${p.subtext};`}">${name || "TBA"}</div></div>
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

  _viewAnnounced(d, p) {
    return `
      ${this._locationHero(d, "GameDay is headed to")}
      ${this._gameStrip(d)}
      ${this._pickerRow(d, p)}
      ${this._upNext(d)}`;
  }

  _viewLive(d, p) {
    const end = Date.parse(d.nextShow.attributes.show_end || "");
    const endStr = Number.isNaN(end) ? "" :
      ` \u00B7 show ends ${new Date(end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    return `
      ${this._locationHero(d, "Live from")}
      <div class="sub" style="margin-top:4px;">Picks in the final segment${endStr}</div>
      ${this._gameStrip(d)}
      ${this._pickerRow(d, p)}`;
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
      <div class="foot">${consensus ? `Consensus: ${consensus[0]} ${consensus[1]}\u2013${Object.values(picks).length - consensus[1]}` : ""}${src}</div>
      ${this._upNext(d)}`;
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
      if (!this._ticker) this._ticker = setInterval(() => this._render(), 30000);
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
  description: "ESPN College GameDay: countdown, host site (school-themed), picker, final picks, up-next queue.",
});

console.info("%c GAMEDAY-CARD %c 0.2.1 ", "background:#cc0000;color:#fff;font-weight:700;", "background:#111;color:#fff;");
