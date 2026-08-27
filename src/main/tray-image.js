// The menu bar readout, drawn as a raw BGRA bitmap.
//
// Three styles, picked in Settings:
//   dot   - colored line bullet, the wait in the system face
//   pixel - the bullet plus the wait in 3x5 dots, as the PIDS boards draw it
//   flash - the wait in the plain shipped face, dimmed over ten minutes and
//           inverted into a solid line-colored chip at four and under
//
// `tray.setTitle` renders plain monochrome system text, so anything with color
// has to be an image. Everything here is rectangles and one circle, which is why
// this is arithmetic rather than a canvas: no hidden BrowserWindow alive for the
// life of the app, and every coordinate is testable.
//
// Coordinates are logical points at menu bar scale (the bar is 22 tall) and are
// multiplied by `scale` for the @2x / @3x representations.

import {
  GLYPH_ADVANCE,
  GLYPH_BASELINE,
  GLYPH_CELL,
  GLYPH_INK_HEIGHT,
  GLYPH_ORDER,
} from "./glyph-metrics.js";

export const TRAY_HEIGHT = 22;

// The shipped track mark is 22 wide; its ink ends at ~16, so the readout starts
// just clear of it.
const MARK_W = 19;
const BULLET_R = 3;
const BULLET_GAP = 6;
// The mark has 12pt of ink (36/66 of the 22pt bar), so the dots are sized to sit
// in that same band rather than towering over it: 5 rows of 2 with 1pt gaps is
// 14, centered on the mark's own ink center.
const DOT = 2;
const GAP = 1;
const CELL = DOT + GAP;
const GLYPH_W = 3 * CELL; // 3 dots wide
const GLYPH_GAP = CELL;
// The mark's ink runs from 48/66 - 36/66 to 48/66 of the bar; this is its middle.
const MARK_INK_CENTER = TRAY_HEIGHT * (48 / 66) - (TRAY_HEIGHT * (36 / 66)) / 2;

// Only the glyphs a wait can contain: digits, BRD, ARR, and the `--` placeholder.
export const MATRIX = {
  0: "111101101101111",
  1: "010110010010111",
  2: "111001111100111",
  3: "111001111001111",
  4: "101101111001001",
  5: "111100111001111",
  6: "111100111101111",
  7: "111001001001001",
  8: "111101111101111",
  9: "111101111001111",
  A: "111101111101101",
  B: "110101110101110",
  D: "110101101101110",
  R: "111101110101101",
  "-": "000000111000000",
};

// The chip `flash` inverts into, centered on the digits' own ink so it
// does not sit low against the mark, with the digits knocked out of it.
const CHIP_H = 16;
const GLYPH_INK_CENTER = GLYPH_BASELINE - GLYPH_INK_HEIGHT / 2;
const CHIP_R = 3;
const CHIP_PAD = 4;
// At or under this many minutes the readout inverts - past four you are running.
const HOT_MINS = 4;

// `dot` hands the digits to `tray.setTitle`, so its image is the mark and the
// bullet alone; `DRAWN_TEXT` is which styles draw their own glyphs.
export const TRAY_STYLES = ["dot", "pixel", "flash"];
export const DEFAULT_TRAY_STYLE = "dot";
const DRAWN_TEXT = { dot: false, pixel: true, flash: true };

export const LINE_HEX = {
  red: [0xbf, 0x0d, 0x3e],
  orange: [0xed, 0x8b, 0x00],
  blue: [0x00, 0x9c, 0xde],
  green: [0x00, 0xb1, 0x40],
  yellow: [0xff, 0xd1, 0x00],
  silver: [0x91, 0x9d, 0x9d],
};

// A drawn image cannot be a macOS template image, so the ink does not adapt on
// its own - the caller passes the menu bar's appearance and we pick.
export const INK_DARK = [0xff, 0xff, 0xff, 0.92];
export const INK_LIGHT = [0x00, 0x00, 0x00, 0.85];

const glyphsOf = (text) => [...text].filter((ch) => ch in MATRIX);
const glyphsWidth = (n) => n * (GLYPH_W + GLYPH_GAP) - GLYPH_GAP;
// The plain face is set from the shipped atlas, so its width is the sum of the
// measured advances rather than a grid.
const setWidth = (glyphs) => Math.ceil(glyphs.reduce((w, ch) => w + (GLYPH_ADVANCE[ch] ?? 0), 0));

// "4m" -> 4, "BRD" / "--" -> null. The chip and the dim ladder key off the number.
const minutesOf = (text) => (/^\d+/.test(text) ? Number.parseInt(text, 10) : null);
const isHot = (text) => {
  const mins = minutesOf(text);
  return mins === null ? Boolean(glyphsOf(text).length) && text !== "--" : mins <= HOT_MINS;
};

/** Logical width of the readout for `text` in `style`, mark included. */
export function trayWidth(text, style = DEFAULT_TRAY_STYLE) {
  const glyphs = glyphsOf(text);
  const bullet = BULLET_R * 2 + BULLET_GAP;
  if (!DRAWN_TEXT[style]) return MARK_W + (glyphs.length ? bullet - BULLET_GAP + 3 : 0);
  if (!glyphs.length) return MARK_W;
  if (style === "flash") {
    return isHot(text)
      ? MARK_W + setWidth(glyphs) + CHIP_PAD * 2
      : MARK_W + bullet + setWidth(glyphs) + 1;
  }
  return MARK_W + bullet + glyphsWidth(glyphs.length) + 1;
}

/**
 * Compose the tray bitmap.
 *
 * `mark` is the shipped template PNG as a bitmap at the same scale, and `atlas`
 * the glyph sheet the same way; only their alpha is used, so both pick up the
 * current ink color. Returns the shape nativeImage.createFromBuffer wants.
 */
export function renderTray({
  text = "",
  color = "",
  stale = false,
  ink = INK_DARK,
  scale = 1,
  mark = null,
  atlas = null,
  style = DEFAULT_TRAY_STYLE,
} = {}) {
  const s = scale;
  const width = Math.round(trayWidth(text, style) * s);
  const height = Math.round(TRAY_HEIGHT * s);
  const buffer = Buffer.alloc(width * height * 4);

  // Premultiplied BGRA: the alpha carries the ink's own opacity as well as any
  // edge coverage, so nothing here needs a compositing step.
  const put = (x, y, [r, g, b], alpha) => {
    if (alpha <= 0 || x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    const a = Math.min(1, alpha);
    buffer[i] = Math.round(b * a);
    buffer[i + 1] = Math.round(g * a);
    buffer[i + 2] = Math.round(r * a);
    buffer[i + 3] = Math.round(255 * a);
  };

  // Overwrites rather than paints, so the flash chip can be cut back to
  // nothing where a glyph covers it. `put` skips alpha 0, which is what makes it
  // safe everywhere else.
  const punch = (x, y, rgb, alpha) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    if (alpha > 0) return put(x, y, rgb, alpha);
    buffer.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 4);
  };

  const fill = (x, y, w, h, rgb, alpha) => {
    const x0 = Math.round(x * s);
    const y0 = Math.round(y * s);
    for (let dy = 0; dy < Math.round(h * s); dy++) {
      for (let dx = 0; dx < Math.round(w * s); dx++) put(x0 + dx, y0 + dy, rgb, alpha);
    }
  };


  const inkRgb = [ink[0], ink[1], ink[2]];
  const inkA = ink[3] * (stale ? 0.48 : 1);

  // The mark: alpha-only source, repainted in the current ink.
  if (mark?.buffer) {
    for (let y = 0; y < Math.min(mark.height, height); y++) {
      for (let x = 0; x < Math.min(mark.width, width); x++) {
        const a = mark.buffer[(y * mark.width + x) * 4 + 3] / 255;
        if (a > 0) put(x, y, inkRgb, a * ink[3]);
      }
    }
  }

  const glyphs = glyphsOf(text);
  if (!glyphs.length) return { buffer, width, height };

  const rgb = LINE_HEX[color];
  const hot = style === "flash" && isHot(text);

  // The flash chip: a solid line-colored slab with the digits knocked back out
  // of it, so the readout reads as inverted rather than as colored digits.
  if (hot) {
    const chipW = setWidth(glyphs) + CHIP_PAD * 2;
    const top = GLYPH_INK_CENTER - CHIP_H / 2;
    for (let dy = 0; dy < Math.round(CHIP_H * s); dy++) {
      for (let dx = 0; dx < Math.round(chipW * s); dx++) {
        // Square off the corners by the radius, which at 22pt is all a rounded
        // rect amounts to.
        const ix = Math.min(dx, Math.round(chipW * s) - 1 - dx) / s;
        const iy = Math.min(dy, Math.round(CHIP_H * s) - 1 - dy) / s;
        if (ix < CHIP_R && iy < CHIP_R && (CHIP_R - ix) ** 2 + (CHIP_R - iy) ** 2 > CHIP_R ** 2) continue;
        put(Math.round(MARK_W * s) + dx, Math.round(top * s) + dy, rgb ?? inkRgb, stale ? 0.48 : 1);
      }
    }
  }

  // The line bullet, supersampled 3x3 so the circle does not look chipped. Drawn
  // only for a known line: the placeholder board carries no line, and an ink-white
  // dot beside the mark reads as a bug rather than as "no data". The chip carries
  // the color itself, so it takes the bullet's place.
  const cx = (MARK_W + BULLET_R) * s;
  const cy = MARK_INK_CENTER * s;
  const r = BULLET_R * s;
  for (let y = rgb && !hot ? Math.floor(cy - r) - 1 : Infinity; y <= Math.ceil(cy + r) + 1; y++) {
    for (let x = Math.floor(cx - r) - 1; x <= Math.ceil(cx + r) + 1; x++) {
      let hits = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const px = x + (sx + 0.5) / 3;
          const py = y + (sy + 0.5) / 3;
          if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) hits++;
        }
      }
      if (hits) put(x, y, rgb, (hits / 9) * (stale ? 0.48 : 1));
    }
  }

  // `dot` stops here: its digits are system text, set by the caller
  // through tray.setTitle, which is what gives them the menu bar's own face.
  if (!DRAWN_TEXT[style]) return { buffer, width, height };

  let x = hot ? MARK_W + CHIP_PAD : MARK_W + BULLET_R * 2 + BULLET_GAP;
  // `flash` dims a wait you have time for and leaves a near one at full ink.
  const far = style === "flash" && !hot && (minutesOf(text) ?? 0) >= 10;
  const alpha = inkA * (far ? 0.55 : 1);

  // `flash` sets its digits in the shipped plain face: one cell per glyph out of
  // the atlas, alpha only, so they take the ink color - or clear it, where the
  // chip has them knocked out of itself.
  if (style === "flash") {
    const chipRgb = rgb ?? inkRgb;
    const chipA = stale ? 0.48 : 1;
    for (const ch of glyphs) {
      const cell = GLYPH_ORDER.indexOf(ch);
      const sx = Math.round(cell * GLYPH_CELL * s);
      const dx0 = Math.round(x * s);
      const cellW = Math.round(GLYPH_CELL * s);
      for (let y = 0; cell >= 0 && atlas?.buffer && y < Math.min(atlas.height, height); y++) {
        for (let dx = 0; dx < cellW && sx + dx < atlas.width; dx++) {
          const a = atlas.buffer[(y * atlas.width + sx + dx) * 4 + 3] / 255;
          if (a <= 0) continue;
          // Knocked out by repainting the chip at the inverse coverage, so an
          // antialiased edge stays smooth instead of turning into a hole. Full
          // coverage clears outright - `put` treats alpha 0 as nothing to do.
          if (hot) punch(dx0 + dx, y, chipRgb, (1 - a) * chipA);
          else put(dx0 + dx, y, inkRgb, a * alpha);
        }
      }
      x += GLYPH_ADVANCE[ch] ?? 0;
    }
    return { buffer, width, height };
  }

  // The dots, centered on the mark's ink center (its baseline is at 48/66 of the
  // bar and it rises 36/66), not on the bar - the mark hangs slightly high.
  const top = MARK_INK_CENTER - (5 * CELL - GAP) / 2;
  for (const ch of glyphs) {
    const bits = MATRIX[ch];
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (bits[row * 3 + col] === "1") fill(x + col * CELL, top + row * CELL, DOT, DOT, inkRgb, alpha);
      }
    }
    x += GLYPH_W + GLYPH_GAP;
  }

  return { buffer, width, height };
}
