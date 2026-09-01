import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BRIGHTNESS,
  DEFAULT_OPACITY,
  DEFAULT_TEXT_PX,
  MAX_TEXT_PX,
  MAX_WALK_MIN,
  MIN_TEXT_PX,
  normalizeConfig,
  readConfig,
  writeConfig,
} from "../src/main/config.js";

const dir = await mkdtemp(join(tmpdir(), "train-menu-config-"));
const path = join(dir, "config.json");

const written = await writeConfig(path, { from: "Rosslyn", to: "Vienna", apiKey: "secret", refreshSec: 45 });
assert.deepEqual(written, {
  from: "Rosslyn",
  to: "Vienna",
  apiKey: "secret",
  refreshSec: 45,
  style: "dot",
  brightness: DEFAULT_BRIGHTNESS,
  walkMin: 0,
  textPx: DEFAULT_TEXT_PX,
  opacity: DEFAULT_OPACITY,
});
assert.deepEqual(await readConfig(path), written, "round-trips");

// The file holds an API key, so it must not be world-readable.
assert.equal((await stat(path)).mode & 0o777, 0o600);

// Overwriting an existing file keeps the tight mode and leaves no .tmp behind.
await writeConfig(path, { ...written, apiKey: "rotated" });
assert.equal((await stat(path)).mode & 0o777, 0o600);
assert.deepEqual(await readdir(dir), ["config.json"], "rename, not truncate-in-place");
assert.match(await readFile(path, "utf8"), /rotated/);

// The walk is a trust boundary like every other field: it comes from a form and
// from a hand-editable file. 0 is off and is also the default, so an absent field
// and a zero one mean the same thing.
const walkOf = (walkMin) => normalizeConfig({ walkMin }).walkMin;
assert.equal(walkOf(5), 5);
assert.equal(walkOf("7"), 7, "the form hands over strings");
assert.equal(walkOf(4.6), 5, "rounded, never fractional minutes");
assert.equal(walkOf(undefined), 0);
assert.equal(walkOf(""), 0, "clearing the field turns the walk off");
assert.equal(walkOf("nonsense"), 0);
assert.equal(walkOf(-3), 0, "a negative walk cannot push a train into the future");
assert.equal(walkOf(9999), MAX_WALK_MIN, "clamped, so a typo cannot shadow every train forever");

// Type size and opacity are read straight into CSS, so a bad value has to land on
// the default rather than on an end of the range: 12px of hero is a squint and a
// 0px one is an invisible board.
const textOf = (textPx) => normalizeConfig({ textPx }).textPx;
assert.equal(textOf(16), MAX_TEXT_PX);
assert.equal(textOf("13"), 13, "the form hands over strings");
assert.equal(textOf(undefined), DEFAULT_TEXT_PX);
assert.equal(textOf(""), DEFAULT_TEXT_PX, "a cleared field is the default, not the smallest type");
assert.equal(textOf(0), MIN_TEXT_PX);
assert.equal(textOf(99), MAX_TEXT_PX);

const opacityOf = (opacity) => normalizeConfig({ opacity }).opacity;
assert.equal(opacityOf(0), 0, "0 is a real setting - the ground goes, the text stays");
assert.equal(opacityOf("75"), 75);
assert.equal(opacityOf(undefined), DEFAULT_OPACITY);
assert.equal(opacityOf(""), DEFAULT_OPACITY);
assert.equal(opacityOf(-10), 0);
assert.equal(opacityOf(140), 100);

console.log("config ok");
