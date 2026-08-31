import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, powerMonitor, screen, Tray } from "electron";
import { popoverBounds } from "./bounds.js";
import { isConfigured, readConfig, writeConfig } from "./config.js";
import { INK_DARK, INK_LIGHT, renderTray } from "./tray-image.js";
import { relativeAge } from "../shared/alerts.js";
import { parseAlerts, parsePayload } from "../shared/parse.js";
import { rulerModel } from "../shared/ruler.js";
import { listStations } from "../shared/stations.js";
import { walkModel, walkTitle } from "../shared/walk.js";

const DEFAULT_SCRIPT = join(import.meta.dirname, "..", "departures", "index.js");
// Dev-only override. In a packaged build this is an env var any local process can
// set (`launchctl setenv` reaches every GUI app), and runScript execs a non-.js
// value directly with the full parent env - a persistent scheduler for someone
// else's binary, handed the API key and whatever else is in the environment.
const SCRIPT = (!app.isPackaged && process.env.TRAIN_MENU_SCRIPT) || DEFAULT_SCRIPT;
const SCRIPT_TIMEOUT_MS = 15_000;
// Incidents change on the scale of hours, not seconds, and the endpoint is not on
// the departure path - so its own slow timer rather than a rider on the 30s one.
const ALERTS_MS = 5 * 60 * 1000;
const TRAY_ASSETS = join(import.meta.dirname, "..", "..", "assets", "tray");
const MARK_PNG = join(TRAY_ASSETS, "train_menuTemplate.png");
// The plain digits the `flash` style sets, one glyph per cell (see
// scripts/make-glyph-atlas.mjs). Rasterized at build time so the main process
// never needs an offscreen window to draw text.
const GLYPHS_PNG = join(TRAY_ASSETS, "glyphsTemplate.png");
// One representation per menu bar scale factor. The mark PNG ships at all three.
const TRAY_SCALES = [1, 2, 3];

const POPOVER_WIDTH = 360;
const MIN_POPOVER_HEIGHT = 160;

let tray;
let popover;
let config;
let configPath;
let timer;
let alertTimer;
let generation = 0; // bumped per refresh; a superseded run must not publish
let nextAt = 0; // epoch ms of the next scheduled fetch, 0 when nothing is scheduled
let lastGood = null;
// The last completed alert check: { lines, alerts, checkedAt }. Null until one
// lands, and the popover shows no alerts block at all until then - an empty
// block would claim a clear feed we have not looked at.
let lastAlerts = null;
let watching = []; // the lines the running or last-attempted check was armed with
let stale = false;
let error = "";
let popoverHeight = 240;
// Both template sheets as bitmaps per scale, read once at startup.
let marks = new Map();
let glyphs = new Map();

function runScript(scriptArgs, parse) {
  // A .js script runs on Electron's own bundled node: a GUI-launched app inherits
  // a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), so a `#!/usr/bin/env node`
  // shebang would fail for anyone without node in a system dir.
  const js = SCRIPT.endsWith(".js");
  const [file, args] = js ? [process.execPath, [SCRIPT]] : [SCRIPT, []];
  return new Promise((resolve, reject) => {
    // The script gets the stations as argv; only it knows the agency's naming.
    // The API key goes in the env, not argv - argv is visible to any local `ps`.
    execFile(
      file,
      [...args, ...scriptArgs],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        killSignal: "SIGKILL",
        env: {
          ...process.env,
          // Trust the macOS keychain roots on top of Node's bundled list. A
          // network that terminates TLS (corporate inspection proxies do) signs
          // with a root that only the keychain knows, so without this every
          // fetch fails with "fetch failed" - and only in a Finder launch, since
          // a shell often exports NODE_EXTRA_CA_CERTS and hides it in dev.
          ...(js ? { ELECTRON_RUN_AS_NODE: "1", NODE_USE_SYSTEM_CA: "1" } : {}),
          ...(config.apiKey ? { WMATA_API_KEY: config.apiKey } : {}),
          TRAIN_MENU_CACHE: app.getPath("userData"),
        },
      },
      (err, stdout, stderr) => {
        // The script's own stderr is written for a human; execFile's "Command
        // failed: ..." wrapper is not, so prefer stderr for the tooltip.
        if (err) return reject(new Error(err.killed ? "script timed out" : stderr.trim() || err.message));
        // An empty board still prints a `--` title, so no payload at all means
        // the script never really ran. Exit 0 with no output is a failure, not
        // "no trains" - treating it as success blanks the menu bar and says
        // nothing. parse throws for that, and for a contract mismatch.
        try {
          resolve(parse(stdout));
        } catch (parseErr) {
          reject(new Error(stderr.trim() || parseErr.message));
        }
      },
    );
  });
}

// The walk applied to the last good board. Computed in one place because three
// surfaces read it - the menu bar, the hero and the station list - and they must
// not be able to disagree about which train is yours.
const walked = () => walkModel(lastGood?.platform ?? [], config.walkMin);

// The script's arrival clock is for the soonest train that serves the trip, and
// the walk can move you to a later one. The ride between the two stations is the
// same either way, so shifting the clock by the difference in wait is exact - no
// second estimate stacked on the first.
function arriveAt(target) {
  const base = lastGood?.arriveAt ?? 0;
  const next = lastGood?.platform.find((train) => train.mine);
  if (!base || !target || !Number.isFinite(target.eta) || !Number.isFinite(next?.eta)) return base;
  return base + (target.eta - next.eta) * 60_000;
}

function snapshot() {
  const walk = walked();
  return {
    configured: isConfigured(config),
    config,
    title: walkTitle(walk, lastGood?.title ?? { line: "", color: "", mins: "" }),
    note: lastGood?.note ?? "",
    // Every revenue train at the platform, each flagged whether it serves the
    // trip and whether the walk has already taken it. The ruler and the station
    // list are two readings of this one list.
    platform: walk.trains,
    // Minutes until you have to move for the train the title names. Null when no
    // walk is set, and when the walk is longer than every train in the feed - the
    // popover then falls back to reporting the next train.
    leaveIn: walk.leaveIn,
    // Placement is computed here rather than in the renderer: the renderer is a
    // plain script with no bundler, so it cannot import the tested module.
    ruler: rulerModel(walk.trains, walk.walk),
    fetchedAt: lastGood?.fetchedAt ?? 0,
    arriveAt: arriveAt(walk.target),
    // The chips report the lines the check actually ran against, so the filter
    // stays inspectable even in the seconds after a route change.
    watching,
    // Age is stamped at snapshot time, so it is at most one refresh out of date.
    // An incident is "still active" because it is in the feed at all, so this is
    // its age, never its staleness.
    alerts: (lastAlerts?.alerts ?? []).map((alert) => ({ ...alert, age: relativeAge(alert.updatedAt) })),
    checkedAt: lastAlerts?.checkedAt ?? 0,
    stale,
    error,
    nextAt,
  };
}

// A template PNG as raw bitmaps, one per scale. Only the alpha survives into the
// readout, so both the mark and the digits can be repainted for the current menu
// bar. Keyed by scale, since a representation has to be composed at its own size.
function loadBitmaps(path) {
  const image = nativeImage.createFromPath(path);
  const { width, height } = image.getSize();
  return new Map(
    TRAY_SCALES.map((scale) => [
      scale,
      {
        scale,
        width: Math.round(width * scale),
        height: Math.round(height * scale),
        buffer: image.toBitmap({ scaleFactor: scale }),
      },
    ]),
  );
}

// The payload gives "4m" / "BRD" / "--"; renderTray keeps only the glyphs it
// knows, so the unit drops out on its own. Unconfigured shows the mark alone.
//
// With a walk set this is the wait for the train you can catch, not the soonest
// one - the same quantity as before, on the train the popover's hero names. It is
// deliberately not the leave-in number: in the menu bar there is no room for the
// word "leave", and a bare "1" that means something other than minutes-to-train
// is a misread waiting to happen.
const trayTitle = () => walkTitle(walked(), lastGood?.title ?? { line: "", color: "", mins: "" });
const readoutText = () => (lastGood ? trayTitle().mins : isConfigured(config) ? "--" : "");

// The readout is a drawn image because `setTitle` can only render monochrome
// system text, and both the line bullet and the flash chip need color. The `dot`
// style is the one exception: it wants the menu bar's own face for the digits, so
// its image stops at the bullet and the number goes in the title.
function trayImage() {
  const readout = {
    text: readoutText(),
    color: lastGood ? trayTitle().color : "",
    stale,
    style: config.style,
    ink: nativeTheme.shouldUseDarkColors ? INK_DARK : INK_LIGHT,
  };
  let image = null;
  for (const [scale, mark] of marks) {
    const rep = renderTray({ ...readout, scale, mark, atlas: glyphs.get(scale) });
    const options = { width: rep.width, height: rep.height, scaleFactor: scale };
    if (image) image.addRepresentation({ ...options, buffer: rep.buffer });
    else image = nativeImage.createFromBuffer(rep.buffer, options);
  }
  return image;
}

function publish() {
  tray.setImage(trayImage());
  // Beside a train mark and a line bullet, a bare number is already minutes, so
  // the unit is a glyph of menu bar width spent on nothing. Monospaced digits so
  // the readout does not shift as the wait ticks down.
  const title = config.style === "dot" ? readoutText().replace(/m$/, "") : "";
  tray.setTitle(title, { fontType: "monospacedDigit" });
  tray.setToolTip(error || (lastGood ? `${trayTitle().mins} to ${config.to}` : "Train Menu"));
  popover?.webContents.send("state", snapshot());
}

// Which lines to watch comes from the trains that passed the jPath check, so the
// first successful refresh arms this, and a route change re-arms it. A failure is
// swallowed: alerts must never break or delay a departure.
async function checkAlerts() {
  clearTimeout(alertTimer);
  alertTimer = setTimeout(checkAlerts, ALERTS_MS);
  const lines = lastGood?.lines ?? [];
  if (!lines.length) return;
  // Recorded before the fetch, not after: a check that keeps failing must not
  // make every 30s refresh look like a route change and retry on that cadence.
  watching = lines;
  try {
    const next = await runScript(["--alerts", lines.join(",")], parseAlerts);
    // Newest wins, keyed on the lines rather than on refresh's generation: that
    // counter bumps every 30s while this fetch has a 15s budget, so it would drop
    // good results. A superseded run is one whose lines are no longer watched -
    // which also covers refresh clearing watching for an unconfigured route,
    // where landing late would otherwise resurrect alerts for a deleted trip.
    if (lines.join() !== watching.join()) return;
    lastAlerts = next;
    publish();
  } catch {
    // The last check stays on screen with its own timestamp, which is the whole
    // point of showing when it happened.
  }
}

async function refresh() {
  if (!isConfigured(config)) {
    // Bump the generation too: clearing the timers does nothing to a run that is
    // already in flight, and without this it still passed the gen check on
    // return, restored lastGood and re-armed the timer just cleared - the app
    // went on polling and showing departures for a route the user had deleted.
    generation++;
    error = "";
    // stale is a claim about lastGood, so it has to go with it: a route deleted
    // while an error was showing otherwise left the tray in its stale style with
    // nothing behind it.
    stale = false;
    clearTimeout(timer);
    clearTimeout(alertTimer);
    lastGood = null;
    lastAlerts = null;
    watching = [];
    nextAt = 0;
    publish();
    return;
  }
  // Six call sites (timer, tray click, manual refresh, config save, resume,
  // startup) can overlap. Newest wins: a run that has been superseded drops its
  // result, so a slow failure can no longer overwrite fresh data, and saving new
  // stations cannot be undone by the old station's reply landing late.
  const gen = ++generation;
  try {
    const next = await runScript([config.from, config.to], parsePayload);
    if (gen !== generation) return;
    lastGood = next;
    stale = false;
    error = "";
  } catch (err) {
    if (gen !== generation) return;
    // Keep the last known departures visible but marked stale - a blank menu bar
    // on every transient network blip is worse than a slightly old number.
    stale = Boolean(lastGood);
    error = err.message;
  }
  // Re-armed before publishing so the snapshot carries the new deadline.
  schedule();
  publish();
  // Only when the watched lines have changed - otherwise the 5 minute timer owns
  // the cadence, not the 30 second one.
  const lines = lastGood?.lines ?? [];
  if (lines.length && lines.join() !== watching.join()) checkAlerts();
}

// A timeout re-armed by every refresh, not a fixed interval: the countdown the
// popover shows is then the real deadline, including after a manual refresh.
function schedule() {
  clearTimeout(timer);
  nextAt = Date.now() + config.refreshSec * 1000;
  timer = setTimeout(refresh, config.refreshSec * 1000);
}

function positionPopover() {
  const trayBounds = tray.getBounds();
  const { workArea } = screen.getDisplayMatching(trayBounds);
  const height = Math.min(Math.max(popoverHeight, MIN_POPOVER_HEIGHT), workArea.height - 16);
  popover.setBounds(popoverBounds(trayBounds, workArea, { width: POPOVER_WIDTH, height }));
}

function createPopover() {
  popover = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: popoverHeight,
    show: false, // positioned under the tray icon before the first paint
    frame: false,
    // Sized from the rendered content, so the window must accept setBounds.
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    roundedCorners: true,
    backgroundColor: "#0B0B0C",
    webPreferences: { preload: join(import.meta.dirname, "..", "preload", "index.cjs") },
  });
  popover.loadFile(join(import.meta.dirname, "..", "renderer", "popover.html"));
  popover.on("blur", () => popover.hide());
}

function togglePopover() {
  if (popover.isVisible()) {
    popover.hide();
    return;
  }
  positionPopover();
  popover.show();
  if (isConfigured(config)) refresh();
}

// Chromium otherwise asks for Keychain access the first time a packaged build
// runs - an alarming prompt for an app that keeps nothing secret there. Must be
// set before readiness.
app.commandLine.appendSwitch("use-mock-keychain");

// userData defaults to app.getName(), which is the package name in dev but
// CFBundleName ("Train Menu") once packaged - so the packaged app read an empty
// config dir and sat unconfigured while the real config stayed in the dev one.
// Pinned so both launch modes share one config, cache and station list.
app.setPath("userData", join(app.getPath("appData"), "train-menu"));

app.whenReady().then(async () => {
  app.dock.hide();
  configPath = join(app.getPath("userData"), "config.json");
  config = await readConfig(configPath);

  ipcMain.handle("state:get", snapshot);
  // The departures script keeps a refreshed copy in its cache once a key exists;
  // fall back to the bundled list so the picker is never empty.
  ipcMain.handle("stations:list", async () => {
    let cache = null;
    try {
      cache = JSON.parse(await readFile(join(app.getPath("userData"), "train-menu-wmata.json"), "utf8"));
    } catch {
      // No refreshed copy yet - the bundled list is the expected first-run path.
    }
    try {
      return (await listStations(cache)).stations;
    } catch {
      // An empty picker degrades to free-text entry rather than breaking setup.
      return [];
    }
  });
  ipcMain.handle("config:save", async (_event, raw) => {
    config = await writeConfig(configPath, raw);
    // Drawn before the fetch: anything cosmetic (the menu bar style) is already
    // decided, and refresh() can spend up to the script timeout before it
    // publishes - long enough that a new style looks like it did not save.
    publish();
    await refresh();
    return snapshot();
  });
  ipcMain.on("data:refresh", refresh);
  ipcMain.on("app:quit", () => app.quit());
  ipcMain.on("ui:resize", (_event, height) => {
    if (!Number.isFinite(height) || height === popoverHeight) return;
    popoverHeight = height;
    if (popover.isVisible()) positionPopover();
  });

  marks = loadBitmaps(MARK_PNG);
  glyphs = loadBitmaps(GLYPHS_PNG);
  tray = new Tray(trayImage());
  // No context menu: both clicks open the popover, which owns every control.
  tray.on("click", togglePopover);
  tray.on("right-click", togglePopover);
  // A drawn image is not a template image, so nothing repaints it for us when the
  // menu bar switches between light and dark.
  nativeTheme.on("updated", () => publish());

  createPopover();
  await refresh();
  // setTimeout does not fire while asleep; without this the menu bar shows an
  // hour-old departure the moment the lid opens.
  powerMonitor.on("resume", refresh);

  // First run has nothing to show but the setup form.
  popover.once("ready-to-show", () => {
    if (!isConfigured(config)) togglePopover();
  });
});

// Hiding the popover must not quit a menu-bar app.
app.on("window-all-closed", () => {});
