import assert from "node:assert/strict";
import { colorOf, KIND_ALERTS, KIND_DEPARTURES, LINE_COLORS, parseAlerts, parsePayload, PAYLOAD_VERSION } from "../src/shared/parse.js";

// The script contract: one versioned JSON object on stdout.
const PAYLOAD = {
  v: PAYLOAD_VERSION,
  kind: KIND_DEPARTURES,
  title: { line: "OR", mins: "3m" },
  note: "",
  fetchedAt: 1772197342000,
  arriveAt: 1772199480000,
  lines: ["OR", "SV"],
  platform: [
    { wait: "3m", eta: 3, line: "OR", group: "1", terminus: "New Carrollton", mine: true },
    { wait: "1m", eta: 1, line: "BL", group: "1", terminus: "Downtown Largo", mine: false },
    { wait: "--", eta: null, line: "SV", group: "2", terminus: "Ashburn", mine: false },
  ],
};

// The `--alerts` run: a separate invocation sharing the same envelope.
const ALERTS = {
  v: PAYLOAD_VERSION,
  kind: KIND_ALERTS,
  lines: ["OR", "SV"],
  checkedAt: 1772197380000,
  alerts: [{ id: "b", lines: ["OR"], type: "alert", description: "single tracking", updatedAt: "2026-08-27T09:07:00" }],
};

const board = parsePayload(JSON.stringify(PAYLOAD));
assert.deepEqual(board.title, { mins: "3m", line: "OR", color: "orange" });
assert.equal(board.fetchedAt, PAYLOAD.fetchedAt);
assert.equal(board.arriveAt, PAYLOAD.arriveAt);
assert.deepEqual(board.lines, ["OR", "SV"]);
assert.deepEqual(board.platform, PAYLOAD.platform);

// Exit 0 with nothing (or with prose) on stdout is a failure, not "no trains" -
// treating it as success blanks the menu bar and says nothing. An empty board is
// still a payload, with a placeholder wait and the reason as a note.
assert.throws(() => parsePayload(""), /produced no output/);
assert.throws(() => parsePayload("\n\n"), /produced no output/);
assert.throws(() => parsePayload("No WMATA API key"), /produced no output/);
assert.throws(() => parsePayload(JSON.stringify({ ...PAYLOAD, title: {} })), /produced no output/);
const empty = parsePayload(JSON.stringify({ ...PAYLOAD, title: { mins: "--" }, note: "no trains to X", platform: [] }));
assert.equal(empty.title.mins, "--");
assert.equal(empty.title.color, "", "an empty board carries no line colour");
assert.equal(empty.note, "no trains to X");

// A mismatched contract fails loudly rather than rendering half a board.
assert.throws(() => parsePayload(JSON.stringify({ ...PAYLOAD, v: 2 })), /v2 - expected v1/);
assert.throws(() => parsePayload(JSON.stringify({ title: { mins: "3m" } })), /vundefined/);
// Both runs share a version, so `v` alone cannot tell them apart: each payload
// names itself, and a crossed pair fails loudly instead of coercing to defaults.
assert.throws(() => parsePayload(JSON.stringify(ALERTS)), /expected a "departures" payload, got "alerts"/);
assert.throws(() => parseAlerts(JSON.stringify(PAYLOAD)), /expected an? "alerts" payload, got "departures"/);
assert.throws(() => parsePayload(JSON.stringify({ ...PAYLOAD, kind: undefined })), /got "none"/);

// Everything above is a trust boundary: in dev TRAIN_MENU_SCRIPT can point at any
// script, so a wrong type must coerce rather than reach the renderer.
const junk = parsePayload(
  JSON.stringify({
    v: PAYLOAD_VERSION,
    kind: KIND_DEPARTURES,
    title: { line: 7, mins: " 4m " },
    fetchedAt: "soon",
    lines: ["OR", 5, null],
    platform: [{ wait: 3, eta: "3", line: "OR", mine: "yes" }, null],
  }),
);
assert.deepEqual(junk.title, { mins: "4m", line: "", color: "" });
assert.equal(junk.fetchedAt, 0, "an unusable stamp reads as absent, not as NaN");
assert.deepEqual(junk.lines, ["OR"]);
assert.deepEqual(junk.platform, [
  { wait: "", eta: null, line: "OR", group: "", terminus: "", mine: true },
  { wait: "", eta: null, line: "", group: "", terminus: "", mine: false },
]);
assert.deepEqual(parsePayload(JSON.stringify({ ...PAYLOAD, platform: "all of them" })).platform, []);

// The alerts run shares the envelope and reports the lines it filtered on, so the
// "watching" chips can never disagree with the fetch behind them.
const checked = parseAlerts(JSON.stringify(ALERTS));
assert.deepEqual(checked.lines, ["OR", "SV"]);
assert.equal(checked.checkedAt, 1772197380000);
assert.deepEqual(checked.alerts, [
  { id: "b", lines: ["OR"], type: "alert", description: "single tracking", updatedAt: "2026-08-27T09:07:00" },
]);
// A clear check is a real result, not a missing one.
assert.deepEqual(parseAlerts(JSON.stringify({ ...ALERTS, alerts: [] })).alerts, []);
assert.throws(() => parseAlerts(""), /produced no output/);

// Codes are two chars and no value may be an emoji - the menu bar is type-only.
assert.equal(Object.keys(LINE_COLORS).length, 6);
for (const [code, color] of Object.entries(LINE_COLORS)) {
  assert.match(code, /^[A-Z]{2}$/, `${color} must have a two-letter code`);
  assert.equal(colorOf(code), color);
}
assert.equal(colorOf("No"), "", "a non-revenue line has no colour");
assert.equal(colorOf(undefined), "");

console.log("ok");

// --- config ---
import { normalizeConfig, isConfigured, DEFAULT_REFRESH_SEC, MIN_REFRESH_SEC, MAX_REFRESH_SEC, DEFAULT_BRIGHTNESS } from "../src/main/config.js";
import { DEFAULT_TRAY_STYLE } from "../src/main/tray-image.js";

assert.deepEqual(normalizeConfig({ from: " Central ", to: "Airport", refreshSec: "45", apiKey: " k " }), {
  from: "Central",
  to: "Airport",
  apiKey: "k",
  refreshSec: 45,
  style: DEFAULT_TRAY_STYLE,
  brightness: DEFAULT_BRIGHTNESS,
});
// The menu bar style comes from the same hand-editable file: an unknown value
// would render no readout at all, so it falls back instead.
assert.equal(normalizeConfig({ style: "flash" }).style, "flash", "a known style is kept");
assert.equal(normalizeConfig({ style: "neon" }).style, DEFAULT_TRAY_STYLE, "an unknown one falls back");
assert.equal(normalizeConfig({}).refreshSec, DEFAULT_REFRESH_SEC);
// Number("") is 0, so a cleared field must default rather than clamp - clamping
// silently tripled the request rate against a rate-limited key.
assert.equal(normalizeConfig({ refreshSec: 0 }).refreshSec, DEFAULT_REFRESH_SEC, "a 0s timer defaults");
assert.equal(normalizeConfig({ refreshSec: "" }).refreshSec, DEFAULT_REFRESH_SEC, "a cleared field defaults");
assert.equal(normalizeConfig({ refreshSec: -5 }).refreshSec, DEFAULT_REFRESH_SEC, "a negative timer defaults");
assert.equal(normalizeConfig({ refreshSec: 5 }).refreshSec, MIN_REFRESH_SEC, "a real low value still clamps");
assert.equal(normalizeConfig({ refreshSec: 999999 }).refreshSec, MAX_REFRESH_SEC);
assert.equal(normalizeConfig({ refreshSec: "abc" }).refreshSec, DEFAULT_REFRESH_SEC);
// Brightness is a percentage from a slider and from the same hand-editable file.
// 0 is a real setting here (today's board exactly), so unlike refreshSec it must
// survive rather than fall back - only an absent or unusable value defaults.
assert.equal(normalizeConfig({}).brightness, DEFAULT_BRIGHTNESS);
assert.equal(normalizeConfig({ brightness: 0 }).brightness, 0, "0 is a choice, not a missing field");
assert.equal(normalizeConfig({ brightness: "75" }).brightness, 75);
assert.equal(normalizeConfig({ brightness: 33.7 }).brightness, 34);
assert.equal(normalizeConfig({ brightness: -20 }).brightness, 0, "below range clamps, never defaults");
assert.equal(normalizeConfig({ brightness: 400 }).brightness, 100);
assert.equal(normalizeConfig({ brightness: "" }).brightness, DEFAULT_BRIGHTNESS, "a cleared field defaults");
assert.equal(normalizeConfig({ brightness: "bright" }).brightness, DEFAULT_BRIGHTNESS);
assert.equal(normalizeConfig({ brightness: null }).brightness, DEFAULT_BRIGHTNESS);

assert.equal(isConfigured(normalizeConfig({ from: "A", to: "B" })), true);
assert.equal(isConfigured(normalizeConfig({ from: "A", to: "  " })), false, "blank station is not configured");

console.log("ok config");

// --- bounds ---
import { popoverBounds } from "../src/main/bounds.js";

const screen1 = { x: 0, y: 0, width: 1440, height: 900 };
const size = { width: 340, height: 424 };

// Centred under the icon, 8px below the menu bar.
assert.deepEqual(popoverBounds({ x: 1000, y: 0, width: 30, height: 24 }, screen1, size), {
  x: 845,
  y: 32,
  ...size,
});
// Icon near the right edge: clamped inside the work area, never off-screen.
assert.equal(popoverBounds({ x: 1430, y: 0, width: 30, height: 24 }, screen1, size).x, 1092);
// Too short to fit below: flips above the icon.
const short = { x: 0, y: 0, width: 1440, height: 300 };
assert.equal(popoverBounds({ x: 700, y: 270, width: 30, height: 24 }, short, size).y < 270, true);
// Second display with a negative origin keeps the window on that display.
assert.equal(popoverBounds({ x: -900, y: -1080, width: 30, height: 24 }, { x: -1920, y: -1080, width: 1920, height: 1080 }, size).x, -1055);

console.log("ok bounds");
