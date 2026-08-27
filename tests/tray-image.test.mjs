// The menu bar readout is drawn by hand, so the dots are worth asserting: a
// wrong bit here is a wrong number in the menu bar, and nothing else catches it.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { GLYPH_ADVANCE, GLYPH_CELL, GLYPH_ORDER } from "../src/main/glyph-metrics.js";
import { INK_DARK, INK_LIGHT, LINE_HEX, MATRIX, TRAY_HEIGHT, TRAY_STYLES, renderTray, trayWidth } from "../src/main/tray-image.js";

// Every glyph is exactly 3x5, or the rows walk off the grid.
for (const [ch, bits] of Object.entries(MATRIX)) {
  assert.equal(bits.length, 15, `${ch} must be 3x5`);
  assert.match(bits, /^[01]{15}$/, `${ch} must be bits`);
}

// The dot-matrix style, which most of the geometry below is about. `dot` is the
// default, so it has to be asked for by name.
const pixel = (options) => renderTray({ style: "pixel", ...options });
const pixelWidth = (text) => trayWidth(text, "pixel");

// --- geometry ---

// Nothing to show is the mark alone: no bullet, no dots, no stray width.
assert.equal(pixelWidth(""), 19);
assert.ok(pixelWidth("3") < pixelWidth("12"), "a second digit is wider");
assert.equal(pixelWidth("12"), pixelWidth("BR") + 0, "width is per glyph, not per kind");
assert.ok(pixelWidth("BRD") > pixelWidth("12"), "three glyphs are wider than two");

const one = pixel({ text: "3", color: "orange", scale: 1 });
assert.equal(one.height, TRAY_HEIGHT);
assert.equal(one.width, pixelWidth("3"));
assert.equal(one.buffer.length, one.width * one.height * 4);

// Retina reps are the same drawing at scale, not a stretched 1x.
const three = pixel({ text: "3", color: "orange", scale: 3 });
assert.equal(three.height, TRAY_HEIGHT * 3);
assert.equal(three.width, pixelWidth("3") * 3);

// --- the dots actually spell the number ---

const alphaAt = (img, x, y) => img.buffer[(y * img.width + x) * 4 + 3];

// Layout: mark 19 + bullet 6 + gap 6 = dots start at x=31; the 14pt matrix is
// centered on the mark's ink center (y=10) so rows start at y=3, cell is 3.
// "3" is 111/001/111/001/111, so row 0 column 0 is lit and row 1 column 0 dark.
const dot = (img, col, row) => alphaAt(img, 31 + col * 3, 3 + row * 3);
assert.ok(dot(one, 0, 0) > 200, "3: top-left dot is lit");
assert.equal(dot(one, 0, 1), 0, "3: middle-left dot is unlit");
assert.ok(dot(one, 2, 1) > 200, "3: middle-right dot is lit");
assert.ok(dot(one, 0, 4) > 200, "3: bottom-left dot is lit");

// A different digit must light a different pattern, or the font is being ignored.
const seven = pixel({ text: "7", scale: 1 });
assert.equal(dot(seven, 0, 4), 0, "7: bottom-left dot is unlit");

// The second glyph sits one glyph plus one gap further along.
const twelve = pixel({ text: "12", scale: 1 });
assert.ok(alphaAt(twelve, 31 + 12, 3) > 200, "second glyph is drawn");

// The readout must not tower over the mark, which has 12pt of ink: the matrix is
// 14 of the 22pt bar and shares the mark's own ink center (y=10).
const litRows = [];
for (let y = 0; y < one.height; y++) {
  if (alphaAt(one, 31, y) > 0 || alphaAt(one, 31 + 4, y) > 0) litRows.push(y);
}
assert.equal(litRows[0], 3, "dots start below the top of the bar");
assert.equal(litRows[litRows.length - 1], 16, "and end level with the mark");
assert.ok(litRows[litRows.length - 1] - litRows[0] + 1 <= 14, "matrix is at most 14pt tall");

// --- color and state ---

const bgra = (img, x, y) => [...img.buffer.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

// The bullet carries the line color; the dots stay ink.
const [b, g, r] = bgra(one, 22, 10);
const [wantR, wantG, wantB] = LINE_HEX.orange;
assert.ok(Math.abs(r - wantR) < 3 && Math.abs(g - wantG) < 3 && Math.abs(b - wantB) < 3, "bullet is line orange");
assert.equal(bgra(one, 31, 3)[0], bgra(one, 31, 3)[2], "a lit dot is neutral ink, not tinted");

// No line, no bullet: the placeholder board ("--") carries no line, and an
// ink-colored dot beside the mark reads as a bug rather than as "no data".
assert.equal(alphaAt(pixel({ text: "--" }), 22, 10), 0, "no line draws no bullet");
assert.equal(alphaAt(pixel({ text: "3", color: "purple" }), 22, 10), 0, "nor does an unknown one");
assert.ok(alphaAt(pixel({ text: "--" }), 31, 9) > 200, "but the dashes are still drawn");

// Stale data is dimmed, not hidden or recolored.
const fresh = pixel({ text: "3", color: "orange" });
const old = pixel({ text: "3", color: "orange", stale: true });
assert.ok(alphaAt(old, 32, 3) > 0, "stale keeps the number visible");
assert.ok(alphaAt(old, 32, 3) < alphaAt(fresh, 32, 3) * 0.6, "stale is visibly dimmer");

// Light menu bar: the ink flips, since a drawn image is not a template image.
const light = pixel({ text: "3", ink: INK_LIGHT });
assert.equal(bgra(light, 32, 3)[0], 0, "light-bar ink is black");
assert.ok(bgra(pixel({ text: "3", ink: INK_DARK }), 32, 3)[0] > 200, "dark-bar ink is white");

// --- the mark ---

// Only the mark's alpha is used, so it takes the current ink color.
const mark = { width: 4, height: 4, buffer: Buffer.alloc(4 * 4 * 4) };
mark.buffer[(1 * 4 + 1) * 4 + 3] = 255; // one opaque pixel at (1,1)
const withMark = pixel({ text: "3", ink: INK_LIGHT, mark });
assert.ok(alphaAt(withMark, 1, 1) > 200, "the mark is blitted");
assert.equal(bgra(withMark, 1, 1)[0], 0, "and repainted in ink, not left black-on-black");
assert.equal(alphaAt(pixel({ text: "3" }), 1, 1), 0, "no mark, no pixels");

// A mark larger than the image must clip instead of overflowing the buffer.
const big = { width: 200, height: 200, buffer: Buffer.alloc(200 * 200 * 4, 0xff) };
assert.doesNotThrow(() => pixel({ text: "3", mark: big }), "oversized mark is clipped");

// --- styles ---

// `dot` hands the digits to tray.setTitle, so the image is mark + bullet and
// nothing where the dots would be - otherwise the number is drawn twice.
const bullet = renderTray({ text: "3", color: "orange", style: "dot" });
assert.ok(bullet.width < pixelWidth("3"), "dot is narrower: no drawn digits");
assert.ok(alphaAt(bullet, 22, 10) > 200, "dot keeps the line bullet");
assert.equal(trayWidth("", "dot"), 19, "and nothing to show is the mark alone");

// Same wait, three styles, three different images - a picker that draws the same
// thing three times is not a picker.
const styled = TRAY_STYLES.map((style) => renderTray({ text: "3", color: "orange", style }).buffer.toString("hex"));
assert.equal(new Set(styled).size, TRAY_STYLES.length, "every style draws differently");

// --- flash, which sets its digits from the shipped glyph atlas ---

// The atlas ships beside the mark and is generated by `pnpm icon`; without it the
// `flash` style has no digits at all.
assert.ok(existsSync(new URL("../assets/tray/glyphsTemplate.png", import.meta.url)), "the glyph atlas ships");
assert.ok(existsSync(new URL("../assets/tray/glyphsTemplate@3x.png", import.meta.url)), "at every menu bar scale");
assert.equal(GLYPH_ORDER.length, Object.keys(GLYPH_ADVANCE).length, "every glyph has a measured advance");
for (const ch of Object.keys(MATRIX)) assert.ok(GLYPH_ORDER.includes(ch), `${ch} must be in the atlas too`);

// A stand-in atlas: every cell solid, so a blit is visible wherever it lands and
// the cell a glyph came from can be read back out of the pixels.
const cellPixels = (ch) => {
  const buffer = Buffer.alloc(GLYPH_ORDER.length * GLYPH_CELL * TRAY_HEIGHT * 4);
  const width = GLYPH_ORDER.length * GLYPH_CELL;
  const col = GLYPH_ORDER.indexOf(ch) * GLYPH_CELL;
  // One opaque column per glyph, at the cell's left edge.
  for (let y = 4; y < 16; y++) buffer[(y * width + col) * 4 + 3] = 255;
  return { width, height: TRAY_HEIGHT, buffer };
};
const atlas = cellPixels("3");

// Cold: the glyph is painted in ink beside the bullet, out of the cell it belongs
// to - a wrong cell here sets the wrong digit in the menu bar.
const cold = renderTray({ text: "7m", color: "orange", style: "flash", atlas: cellPixels("7") });
assert.ok(alphaAt(cold, 31, 8) > 200, "the atlas glyph is set beside the bullet");
assert.equal(bgra(cold, 31, 8)[0], bgra(cold, 31, 8)[2], "in neutral ink, not tinted");
assert.ok(alphaAt(cold, 22, 10) > 200, "and the line bullet is still there");
assert.equal(alphaAt(renderTray({ text: "7m", style: "flash", atlas }), 31, 8), 0, "a mismatched cell sets nothing");
// Widths come from the measured advances, so "1" is narrower than "8".
assert.ok(trayWidth("1m", "flash") < trayWidth("8m", "flash"), "the plain face is not a grid");

// Hot: a solid line-colored chip, the glyph knocked back out of it.
const hot = renderTray({ text: "3m", color: "orange", style: "flash", atlas });
const chip = bgra(hot, 20, 10);
assert.ok(Math.abs(chip[2] - LINE_HEX.orange[0]) < 3 && chip[3] > 200, "hot chip is filled with the line color");
assert.equal(alphaAt(hot, 19 + 4, 8), 0, "the digits are knocked out of the chip");
assert.equal(alphaAt(hot, 19 + 4, 2), 0, "and the knockout is the glyph, not the whole column");
assert.equal(alphaAt(hot, 0, 0), 0, "corners are rounded off");
assert.ok(alphaAt(hot, 22, 3) > 200, "the chip is taller than the bullet it replaces");

// Above four the wait is plain digits, dimmed once it passes ten minutes.
const warm = renderTray({ text: "7m", color: "orange", style: "flash", atlas: cellPixels("7") });
const far = renderTray({ text: "17m", color: "orange", style: "flash", atlas: cellPixels("1") });
assert.ok(alphaAt(warm, 31, 8) > 200, "a near wait is full ink");
assert.ok(alphaAt(far, 31, 8) < alphaAt(warm, 31, 8) * 0.7, "a far one is dimmed");
assert.ok(alphaAt(far, 22, 10) > 200, "and still carries its line bullet");

// BRD is the most urgent thing the board can say, so it inverts too; the
// placeholder is not a wait at all and must not.
const brd = renderTray({ text: "BRD", color: "orange", style: "flash", atlas });
assert.equal(bgra(brd, 20, 10)[3], 255, "BRD is hot");
const dashes = renderTray({ text: "--", color: "orange", style: "flash", atlas });
assert.equal(alphaAt(dashes, 20, 3), 0, "-- is not a wait, so it gets no chip");
assert.ok(alphaAt(dashes, 22, 10) > 200, "just the bullet");

// A missing atlas must not take the whole menu bar down with it: the mark, the
// bullet and the chip are all still drawn.
assert.doesNotThrow(() => renderTray({ text: "3m", color: "orange", style: "flash" }), "no atlas, no crash");

console.log("ok tray image");
