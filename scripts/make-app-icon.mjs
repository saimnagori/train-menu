// Renders assets/app-icon.icns from the same mark as the tray glyph.
// Run with: <electron> scripts/make-app-icon.mjs
//
// Same toolchain as make-tray-icon.mjs (Chromium canvas, no image dependency)
// and the same geometry out of scripts/track-glyph.mjs, but a Finder icon is not
// a template image: it needs real colour, so the mark is drawn in ink white on
// the Monochrome Lab stage inside a rounded square.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { TRACK_SOURCE } from "./track-glyph.mjs";

const OUT = join(import.meta.dirname, "..", "assets", "app-icon.icns");

// The names iconutil expects. Each entry is [filename, pixel size].
const ICONSET = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

const page = (size) => `<!doctype html><canvas id="c"></canvas><script>
  const size = ${size};
  const c = document.getElementById("c");
  c.width = size; c.height = size;
  const ctx = c.getContext("2d");
  const at = (n) => size * n;

  // macOS icons leave a transparent margin and round their corners at roughly
  // 22% of the tile, which is what makes them sit level with system icons.
  const inset = at(0.086);
  const box = size - inset * 2;
  ctx.fillStyle = "#0B0B0C";
  ctx.beginPath();
  ctx.roundRect(inset, inset, box, box, box * 0.225);
  ctx.fill();

  // A hairline rim: the stage colour is near-black, so without it the tile
  // dissolves into a dark Dock or a dark Finder sidebar.
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = Math.max(1, box * 0.004);
  ctx.stroke();

  ${TRACK_SOURCE}

  // The mark fills 78% of the tile. Its ink is not centred in the 22-unit box it
  // is drawn in (x 0.3-15.7, y 4.8-16.8), so the transform centres the ink
  // rather than the box - otherwise the track sits low and left on the tile.
  const scale = box * 0.78 / 22;
  ctx.save();
  ctx.translate(size / 2 - 8 * scale, size / 2 - 10.8 * scale);
  ctx.scale(scale, scale);
  ctx.lineJoin = "round";
  drawTrack(ctx, (alpha) => \`rgba(245,245,246,\${alpha})\`);
  ctx.restore();

  window.result = c.toDataURL("image/png");
</script>`;

app.whenReady().then(async () => {
  if (process.platform !== "darwin") {
    console.error("iconutil is macOS-only.");
    app.exit(1);
    return;
  }
  const iconset = join(await mkdtemp(join(tmpdir(), "train-menu-icon-")), "icon.iconset");
  await mkdir(iconset, { recursive: true });
  const window = new BrowserWindow({ show: false, width: 100, height: 100 });

  for (const [name, size] of ICONSET) {
    await window.loadURL(`data:text/html,${encodeURIComponent(page(size))}`);
    const dataUrl = await window.webContents.executeJavaScript("window.result");
    await writeFile(join(iconset, name), Buffer.from(dataUrl.split(",")[1], "base64"));
  }

  const result = spawnSync("iconutil", ["-c", "icns", iconset, "-o", OUT], { stdio: "inherit" });
  console.log(result.status === 0 ? OUT : "iconutil failed");
  app.exit(result.status ?? 1);
});
