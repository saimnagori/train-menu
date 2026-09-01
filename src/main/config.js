import { readFile, rename, writeFile } from "node:fs/promises";
import { DEFAULT_TRAY_STYLE, TRAY_STYLES } from "./tray-image.js";

// Above the host's 15s script timeout, so the timer alone can never fire a second
// fetch while the first is still running.
export const MIN_REFRESH_SEC = 20;
export const MAX_REFRESH_SEC = 3600;
export const DEFAULT_REFRESH_SEC = 30;

// How much white to lift the dimmer text steps by, 0-100. 0 is the original
// scale; the renderer turns this into an exponent over the six ink text tokens.
export const DEFAULT_BRIGHTNESS = 50;

// The popover's base type size in px, and how far it may be moved. 14 is the size
// the tokens were drawn at; two steps either way is enough to fix a display without
// letting the 360px window's columns collapse.
export const DEFAULT_TEXT_PX = 14;
export const MIN_TEXT_PX = 12;
export const MAX_TEXT_PX = 16;

// How opaque the popover's ground is, 0-100. 100 is the original flat panel; below
// it the desktop shows through the window's blur. 0 is legal and leaves the frame,
// the hairlines and the text over whatever happens to be behind them.
export const DEFAULT_OPACITY = 90;

// Minutes from wherever you are to the platform. 0 is the default and means the
// whole walk shadow is off - the board reports the next train, as it always has.
// Past an hour the shadow would swallow every train the feed names, so the value
// stops being a walk and starts being a bug.
export const MAX_WALK_MIN = 60;

// Trust boundary: this comes from a form and from a hand-editable JSON file, so
// clamp the interval rather than letting a typo hammer the transit API (or set a
// timer of 0). Stations are free text - only the host script knows what is valid.
export function normalizeConfig(raw) {
  const from = String(raw?.from ?? "").trim();
  const to = String(raw?.to ?? "").trim();
  const apiKey = String(raw?.apiKey ?? "").trim();
  const parsed = Number(raw?.refreshSec);
  // `parsed > 0` matters because Number("") is 0: clearing the field must fall
  // back to the default, not clamp to the fastest allowed interval.
  const refreshSec = Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.max(Math.round(parsed), MIN_REFRESH_SEC), MAX_REFRESH_SEC)
    : DEFAULT_REFRESH_SEC;
  // An unknown style would leave the menu bar with no readout at all, so it falls
  // back here rather than reaching renderTray.
  const style = TRAY_STYLES.includes(raw?.style) ? raw.style : DEFAULT_TRAY_STYLE;
  // Unlike refreshSec, 0 is a legitimate setting here (the original scale), so an
  // absent field is told apart from a zero one rather than clamped up.
  const lift = raw?.brightness == null || raw.brightness === "" ? NaN : Number(raw.brightness);
  const brightness = Number.isFinite(lift) ? Math.min(Math.max(Math.round(lift), 0), 100) : DEFAULT_BRIGHTNESS;
  // 0 is both the default and "off", so unlike brightness an absent field and a
  // zero one mean the same thing and need no telling apart.
  const walk = Number(raw?.walkMin);
  const walkMin = Number.isFinite(walk) ? Math.min(Math.max(Math.round(walk), 0), MAX_WALK_MIN) : 0;
  // Like brightness, both of these have a meaningful 0 or near-0 end, and both are
  // read by the renderer as a CSS value - so a blank or a bad field has to land on
  // the default rather than on the bottom of the range.
  const text = raw?.textPx == null || raw.textPx === "" ? NaN : Number(raw.textPx);
  const textPx = Number.isFinite(text) ? Math.min(Math.max(Math.round(text), MIN_TEXT_PX), MAX_TEXT_PX) : DEFAULT_TEXT_PX;
  const alpha = raw?.opacity == null || raw.opacity === "" ? NaN : Number(raw.opacity);
  const opacity = Number.isFinite(alpha) ? Math.min(Math.max(Math.round(alpha), 0), 100) : DEFAULT_OPACITY;
  return { from, to, apiKey, refreshSec, style, brightness, walkMin, textPx, opacity };
}

export function isConfigured(config) {
  return Boolean(config.from && config.to);
}

export async function readConfig(path) {
  try {
    return normalizeConfig(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return normalizeConfig({});
  }
}

// Write to a sibling temp file and rename over the target: a truncate-in-place
// interrupted by a crash leaves 0 bytes, and readConfig's catch turns that into
// a silent reset to first-run setup - stations and key gone with no error. 0600
// because the file holds the user's API key.
export async function writeConfig(path, raw) {
  const config = normalizeConfig(raw);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  return config;
}
