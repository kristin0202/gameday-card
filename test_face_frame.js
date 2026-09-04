/**
 * Tests for guest-picker portrait framing.
 *
 * The card is a plain browser script with no exports, so the browser globals
 * it touches are stubbed and the file is eval'd; `faceFrame` is lifted to
 * module scope by appending an assignment to the source (consts declared
 * inside eval are not reachable from outside it).
 *
 * Run:  node test_face_frame.js
 */
const fs = require("fs");

// --- Load the card ----------------------------------------------------
global.HTMLElement = class { attachShadow() { return {}; } };
global.customElements = { define() {} };
global.window = { customCards: [], matchMedia: () => ({ matches: true }) };
global.console.info = () => {};
// Never let a test reach the network; wikiThumb() calls fetch().
global.fetch = () => new Promise(() => {});

const src = fs.readFileSync("gameday-card.js", "utf8");
eval(src + "\nglobal.__faceFrame = typeof faceFrame === 'function' ? faceFrame : null;"
         + "\nglobal.__upgradeThumb = typeof upgradeThumb === 'function' ? upgradeThumb : null;"
         + "\nglobal.__PICKER_SMALLER = typeof PICKER_SMALLER !== 'undefined' ? PICKER_SMALLER : null;"
         + "\nglobal.__PICKER_IMAGES = typeof PICKER_IMAGES !== 'undefined' ? PICKER_IMAGES : null;"
         + "\nglobal.__GameDayCard = typeof GameDayCard !== 'undefined' ? GameDayCard : null;");
// NB: must not be named `faceFrame` — sloppy-mode eval shares this scope,
// so a same-named const here shadows the lookup inside eval while in TDZ.
const frameOf = global.__faceFrame;
const PICKER_IMAGES_SET = (k, v) => global.__PICKER_IMAGES.set(k, v);

// --- Real image dimensions, from the Wikipedia REST summaries ----------
// faceY measured by inspection of each photo.
const SAMPLES = [
  { who: "Lainey Wilson (full body, seated)", w: 3936, h: 5904, faceY: 0.29 },
  { who: "Peyton Manning (tight bust)",       w: 2000, h: 3000, faceY: 0.27 },
  { who: "Serena Williams (full body)",       w: 2000, h: 3279, faceY: 0.23 },
  { who: "Nick Saban (three-quarter)",        w: 1800, h: 2609, faceY: 0.26 },
  { who: "Kirk Herbstreit (square)",          w: 1000, h: 1000, faceY: 0.26 },
];

const BOX = 56; // .pavatar is 56x56
const failures = [];

function check(name, fn) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (err) { failures.push(`${name}: ${err.message}`); console.log(`FAIL ${name}\n     ${err.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** Where the subject's face lands in the tile, as a fraction of tile height. */
function facePos(frame, faceY) {
  return (faceY * frame.h + frame.top) / BOX;
}

// --- Tests ------------------------------------------------------------
check("faceFrame is exported by the card", () => {
  assert(typeof faceFrame === "function", "faceFrame not found in gameday-card.js");
});

check("every sample lands the face inside the visible tile band", () => {
  for (const s of SAMPLES) {
    const f = frameOf(BOX, s.w, s.h);
    const pos = facePos(f, s.faceY);
    assert(pos >= 0.35 && pos <= 0.62,
      `${s.who}: face at ${(pos * 100).toFixed(1)}% of tile, want 35-62%`);
  }
});

check("center-crop baseline really is worse (guards against a no-op change)", () => {
  // Plain object-fit:cover, centered — what the card did before.
  const s = SAMPLES[0];
  const coverH = BOX / (s.w / s.h);
  const centeredPos = (s.faceY * coverH - (coverH - BOX) / 2) / BOX;
  assert(centeredPos < 0.25,
    `baseline should bury the face near the top edge, got ${(centeredPos * 100).toFixed(1)}%`);
});

check("the tile is always fully covered — no background gap", () => {
  for (const s of SAMPLES) {
    const f = frameOf(BOX, s.w, s.h);
    assert(f.w >= BOX - 0.01, `${s.who}: width ${f.w} < tile`);
    assert(f.h >= BOX - 0.01, `${s.who}: height ${f.h} < tile`);
    assert(f.top <= 0.01 && f.top >= BOX - f.h - 0.01, `${s.who}: top ${f.top} exposes a gap`);
    assert(f.left <= 0.01 && f.left >= BOX - f.w - 0.01, `${s.who}: left ${f.left} exposes a gap`);
  }
});

check("the face is magnified versus a plain cover crop", () => {
  for (const s of SAMPLES) {
    const a = s.w / s.h;
    const coverH = a < 1 ? BOX / a : BOX;
    const f = frameOf(BOX, s.w, s.h);
    assert(f.h > coverH * 1.2, `${s.who}: h ${f.h.toFixed(1)} not zoomed past cover ${coverH.toFixed(1)}`);
  }
});

check("landscape images still cover the tile", () => {
  const f = frameOf(BOX, 1600, 900);
  assert(f.w >= BOX && f.h >= BOX, `landscape not covering: ${JSON.stringify(f)}`);
});

check("degenerate dimensions return null instead of NaN", () => {
  for (const args of [[BOX, 0, 0], [BOX, 100, 0], [0, 100, 100]]) {
    assert(frameOf(...args) === null, `expected null for ${JSON.stringify(args)}`);
  }
});

// --- The wiring that actually applies the geometry --------------------
// faceFrame() being right is worthless if _framePortrait never sets the style.
function fakeImg(natW, natH, box = BOX) {
  return { naturalWidth: natW, naturalHeight: natH, complete: true,
           parentElement: { clientHeight: box }, style: {} };
}

check("_framePortrait writes the computed geometry onto the element", () => {
  const card = new global.__GameDayCard();
  const img = fakeImg(3936, 5904); // Lainey Wilson's actual dimensions
  card._framePortrait(img);
  const want = frameOf(BOX, 3936, 5904);
  for (const k of ["width", "height", "top", "left"]) {
    const key = k;
    const got = img.style[key];
    assert(got !== undefined, `style.${key} was never set`);
    const num = parseFloat(got);
    const expect = k === "width" ? want.w : k === "height" ? want.h : want[k];
    assert(Math.abs(num - expect) < 0.01, `style.${key}=${got}, want ${expect}px`);
    assert(String(got).endsWith("px"), `style.${key}=${got} is missing units`);
  }
});

check("_framePortrait moves the portrait off the centred default", () => {
  const card = new global.__GameDayCard();
  const img = fakeImg(3936, 5904);
  card._framePortrait(img);
  // A no-op change would leave the element at the CSS default of 56x56 at 0,0.
  assert(parseFloat(img.style.height) > BOX * 1.5,
    `height ${img.style.height} suggests the framing never applied`);
});

check("_framePortrait is inert when the tile has no layout yet", () => {
  const card = new global.__GameDayCard();
  const img = fakeImg(3936, 5904, 0); // clientHeight 0 -> not laid out
  card._framePortrait(img);
  assert(Object.keys(img.style).length === 0,
    `wrote styles from an unmeasurable tile: ${JSON.stringify(img.style)}`);
});

// --- End to end: a real render must reach the framing -----------------
// Geometry + wiring can both be correct while _render never calls them, which
// looks exactly like "the photo did not change". This pins that path down.
function stubCard() {
  const card = new global.__GameDayCard();
  const img = fakeImg(3936, 5904);
  img.dataset = { src: "https://upload.wikimedia.org/x/500px-Lainey.jpg" };
  img.addEventListener = () => {};
  card.shadowRoot = { set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
                      querySelector: (sel) => (sel === ".pavatar img" ? img : null) };
  card._config = { prefix: "gameday", show_odds: true };
  card._pins = {}; card._pickerPins = {};
  // "announced" phase: a show in the future with a known host site.
  const soon = new Date(Date.now() + 36e5).toISOString();
  const end = new Date(Date.now() + 72e5).toISOString();
  card._hass = { themes: { darkMode: true }, states: {
    "sensor.gameday_next_show": { state: soon, attributes: { show_end: end } },
    "sensor.gameday_location": { state: "LSU", attributes: { city: "Baton Rouge", state: "LA", venue: "Tiger Stadium (LA)" } },
    "sensor.gameday_guest_picker": { state: "Lainey Wilson", attributes: {} },
    "sensor.gameday_featured_game": { state: "Clemson at #11 LSU", attributes: { home: { color: "#461d76", alt_color: "#fdd023", abbr: "LSU" }, away: {} } },
    "sensor.gameday_upcoming": { state: "0", attributes: { items: [] } },
    "binary_sensor.gameday_flair_week": { state: "off", attributes: {} },
    "binary_sensor.gameday_new_announcement": { state: "off", attributes: {} },
  } };
  return { card, img };
}

check("a full render frames the portrait", () => {
  const { card, img } = stubCard();
  card._render();
  assert(card.shadowRoot.innerHTML.includes('class="pavatar"'), "picker tile never rendered");
  assert(img.style.height !== undefined,
    "_render did not apply framing — the portrait would use the centred default");
  assert(parseFloat(img.style.height) > BOX * 1.5,
    `framing applied but wrong: height ${img.style.height}`);
});

// --- Portrait source precedence ---------------------------------------
const DEEZER = "https://cdn-images.dzcdn.net/images/artist/abc/1000x1000-000000-80-0-0.jpg";

function bareCard() {
  const card = new global.__GameDayCard();
  card._pickerPins = {};
  return card;
}

check("an integration-supplied headshot beats the Wikipedia lookup", () => {
  const got = bareCard()._pickerPortrait("Lainey Wilson", DEEZER);
  assert(got === DEEZER, `got ${got!==undefined?got:"undefined"}`);
});

check("a config pin still outranks the supplied headshot", () => {
  const card = bareCard();
  card._pickerPins = { "lainey wilson": "https://pinned.test/x.jpg" };
  assert(card._pickerPortrait("Lainey Wilson", DEEZER) === "https://pinned.test/x.jpg");
});

check("no supplied headshot still falls back to Wikipedia", () => {
  const got = bareCard()._pickerPortrait("Nobody Known", null);
  assert(got === null, `expected the Wikipedia path, got ${got}`);
});

check("a supplied headshot is marked so it is not re-cropped", () => {
  const card = bareCard();
  const html = card._pickerTile(
    { picker: { state: "Lainey Wilson", attributes: { image: DEEZER } } },
    { subtext: "#888" });
  assert(html.includes('data-headshot="1"'), "supplied headshot not marked");
  assert(html.includes(DEEZER), "supplied headshot not used");
});

check("a Wikipedia fallback is NOT marked, so it still gets face framing", () => {
  const card = bareCard();
  PICKER_IMAGES_SET("someone else", "https://upload.wikimedia.org/x/500px-A.jpg");
  const html = card._pickerTile(
    { picker: { state: "Someone Else", attributes: {} } }, { subtext: "#888" });
  assert(!html.includes('data-headshot="1"'), "wikipedia image wrongly marked as a headshot");
});

// --- Thumbnail width upgrade ------------------------------------------
const upgrade = global.__upgradeThumb;
const SMALLER = global.__PICKER_SMALLER;
const API_URL =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/f/fc/Lainey_Wilson_2024.jpg/330px-Lainey_Wilson_2024.jpg";

check("upgradeThumb widens the API's default thumbnail", () => {
  const out = upgrade(API_URL);
  assert(out.includes("/500px-"), `not widened: ${out}`);
  assert(!out.includes("/330px-"), `old width survived: ${out}`);
});

check("upgradeThumb records the original so a rejected width can degrade", () => {
  const out = upgrade(API_URL);
  assert(SMALLER.get(out) === API_URL, `fallback not recorded for ${out}`);
});

check("upgradeThumb passes through a null lookup", () => {
  assert(upgrade(null) === null, "null should stay null");
});

check("upgradeThumb leaves a non-thumbnail URL alone", () => {
  const direct = "https://example.test/portrait.jpg";
  assert(upgrade(direct) === direct, "unexpectedly rewrote a non-thumb URL");
  assert(!SMALLER.has(direct), "should not register a fallback it did not change");
});

check("only Wikimedia-approved widths are requested", () => {
  // Arbitrary widths return HTTP 400 from Wikimedia's thumbnailer.
  const ALLOWED = [320, 400, 500, 640, 800, 1024, 1280];
  const w = Number(upgrade(API_URL).match(/\/(\d+)px-/)[1]);
  assert(ALLOWED.includes(w), `${w}px is not an approved thumbnail width`);
});

console.log();
if (failures.length) { console.log(`${failures.length} FAILED`); process.exit(1); }
console.log("all passed");
