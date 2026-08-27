// Renders the tray mark to template PNGs at every menu-bar scale.
// Run with: <electron> scripts/make-tray-icon.mjs
//
// Chromium is already in the process, so the canvas is the whole toolchain - no
// image dependency, no design app. Output is black-on-transparent because a
// macOS template image uses only the alpha channel; the system paints it.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { TRACK_SOURCE } from "./track-glyph.mjs";

const OUT_DIR = join(import.meta.dirname, "..", "assets", "tray");
const NAME = "train_menu";
const SCALES = [
  ["Template.png", 22],
  ["Template@1x.png", 22],
  ["Template@2x.png", 44],
  ["Template@3x.png", 66],
];

// The mark is drawn in 22-unit space by scripts/track-glyph.mjs, so all four
// scales are one drawing under a different transform.
const page = (size) => `<!doctype html><canvas id="c"></canvas><script>
  const size = ${size};
  const c = document.getElementById("c");
  c.width = size; c.height = size;
  const ctx = c.getContext("2d");

  ${TRACK_SOURCE}

  ctx.scale(size / 22, size / 22);
  // Alpha only, since a template image is a stencil: the ties are drawn lighter
  // than the rails, and the system reads that as coverage when it repaints the
  // mark for the current menu bar.
  drawTrack(ctx, (alpha) => \`rgba(0,0,0,\${alpha})\`);

  window.result = c.toDataURL("image/png");
</script>`;

app.whenReady().then(async () => {
  await mkdir(OUT_DIR, { recursive: true });
  const window = new BrowserWindow({ show: false, width: 100, height: 100 });

  for (const [suffix, size] of SCALES) {
    await window.loadURL(`data:text/html,${encodeURIComponent(page(size))}`);
    const dataUrl = await window.webContents.executeJavaScript("window.result");
    const file = join(OUT_DIR, `${NAME}${suffix}`);
    await writeFile(file, Buffer.from(dataUrl.split(",")[1], "base64"));
    console.log(`${file} (${size}px)`);
  }
  app.quit();
});
