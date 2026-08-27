#!/usr/bin/env node
// WMATA departures for train-menu. Prints the script contract from parse.js: one
// versioned JSON object on stdout, carrying the user's trains, every other train
// at their platform, and the arrival estimate.
//
//   WMATA_API_KEY=... node src/departures/index.js Rosslyn "New Carrollton"
//   WMATA_API_KEY=... node src/departures/index.js --alerts OR,SV
//
// A prediction only tells you a train's *terminus*, not whether it stops where you
// are going. Rosslyn sends Orange, Blue and Silver toward DC, and Silver alternates
// between Largo and New Carrollton, so filtering on line would put you on the wrong
// train. jPath resolves it: see `serves`.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { alertsForLines, normalizeIncidents } from "../shared/alerts.js";
import { KIND_ALERTS, KIND_DEPARTURES, PAYLOAD_VERSION } from "../shared/parse.js";
import { listStations, matchStation, normalizeStations, resolveCodes } from "../shared/stations.js";

const API = "https://api.wmata.com";
// New stations open about once a decade, so the bundled list is refreshed lazily
// and only once the user has a key - never on the critical path of a refresh.
const STATIONS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HTTP_TIMEOUT_MS = 10_000;

const cacheFile = () =>
  join(process.env.TRAIN_MENU_CACHE || join(homedir(), ".cache"), "train-menu-wmata.json");

async function fetchJson(path, params) {
  const url = new URL(API + path);
  if (params) url.search = new URLSearchParams(params).toString();
  const res = await fetch(url, {
    headers: { api_key: process.env.WMATA_API_KEY ?? "" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  // 401 means a bad key. Never echo the key itself into an error the UI will show.
  if (!res.ok) throw new Error(res.status === 401 ? "WMATA rejected the API key" : `WMATA HTTP ${res.status}`);
  return res.json();
}

let http = fetchJson; // swapped in tests
export const setFetch = (fn) => (http = fn);

// Every list off the WMATA response goes through this. The agency omits these
// keys outright during an outage and a captive portal can return anything that
// parses, so `?? []` is not enough - a non-array would still throw at the
// for..of or the .map. An absent list is an empty board, not a crash.
const arr = (value) => (Array.isArray(value) ? value : []);

export async function loadCache() {
  try {
    return JSON.parse(await readFile(cacheFile(), "utf8"));
  } catch {
    return {};
  }
}

// Set wherever the cache is mutated, cleared on write: a warm refresh changes
// nothing, so without this it rewrote the whole file every 30s for no reason.
let dirty = false;
export const isDirty = () => dirty;

// Never throws. The cache is an optimization, not the result: a full disk or an
// unwritable userData must not discard predictions that were already fetched and
// turn a working board into a hard error. `dirty` stays set so the next run
// retries the write.
export async function saveCache(cache) {
  try {
    const file = cacheFile();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(cache));
    dirty = false;
  } catch {
    // Nothing to report to: stderr is the host's error channel for the board.
  }
}

// --- station list ---

/** Fetch the authoritative list. Used to generate the bundled file and to refresh it. */
export async function fetchStations(now = Date.now()) {
  const { Stations } = await http("/Rail.svc/json/jStations");
  return { fetchedAt: new Date(now).toISOString(), stations: normalizeStations(arr(Stations)) };
}

// Read-through: the bundled list works with no key at all. Only once a key exists
// and the copy is a month old does this spend a call to refresh it.
export async function stationList(cache, now = Date.now()) {
  // An unparseable or missing fetchedAt must read as stale, not as fresh: NaN
  // fails every comparison, which pinned the list as current forever.
  const fetchedAt = Date.parse(cache.stations?.fetchedAt);
  const stale = !cache.stations || !Number.isFinite(fetchedAt) || now - fetchedAt > STATIONS_TTL_MS;
  if (stale && process.env.WMATA_API_KEY) {
    try {
      cache.stations = await fetchStations(now);
      dirty = true;
    } catch {
      // A refresh failure must never block departures - the bundled list is fine.
    }
  }
  return listStations(cache);
}

// {stationCode: SeqNum} along one line. Cached forever - track geometry does not change.
export async function pathSeq(cache, origin, terminus) {
  const paths = (cache.paths ??= {});
  const key = `${origin}>${terminus}`;
  if (key in paths) return paths[key];
  const { Path } = await http("/Rail.svc/json/jPath", { FromStationCode: origin, ToStationCode: terminus });
  const seq = Object.fromEntries(arr(Path).map((p) => [p.StationCode, p.SeqNum]));
  // Only a real path is cached. An empty one means either a cross-line trip or a
  // bad response, and this cache never expires - one hiccup would otherwise drop
  // that terminus forever, fixable only by deleting the file by hand.
  if (Object.keys(seq).length) {
    paths[key] = seq;
    dirty = true;
  }
  return seq;
}

/** Does a train on platform `origin` bound for `terminus` stop at one of `dests`, later on? */
export async function serves(cache, origin, dests, terminus) {
  const seq = await pathSeq(cache, origin, terminus);
  const here = seq[origin];
  return here !== undefined && dests.some((d) => seq[d] !== undefined && seq[d] > here);
}

// jPath is same-line only, so an empty path for every origin platform means the
// trip needs a transfer - worth saying out loud instead of showing "no trains" forever.
export async function sameLine(cache, originCodes, destCodes) {
  for (const o of originCodes) {
    for (const d of destCodes) if (Object.keys(await pathSeq(cache, o, d)).length) return true;
  }
  return false;
}

// --- predictions: the one call per refresh ---

// Min is a string: digits, "ARR", "BRD", "---", or empty. Never parseInt it blind.
export const etaOf = (min) => {
  const m = (min ?? "").trim().toUpperCase();
  if (m === "BRD" || m === "ARR") return 0;
  return /^\d+$/.test(m) ? Number(m) : null;
};

export const rankOf = (min) => {
  const m = (min ?? "").trim().toUpperCase();
  if (m === "BRD") return -1;
  if (m === "ARR") return -0.5;
  return /^\d+$/.test(m) ? Number(m) : Infinity;
};

export const fmtMin = (min) => {
  const m = (min ?? "").trim().toUpperCase();
  return /^\d+$/.test(m) ? `${Number(m)}m` : m === "BRD" || m === "ARR" ? m : "--";
};

// Non-revenue trains are marked by a Line that is not a real line: live data shows
// `Line: "--"` with destination "Train", and `Line: "No"` / "ssenger" where WMATA
// truncates "No Passenger" across two fields. A blank-Line test misses both.
export const LINES = new Set(["RD", "BL", "YL", "OR", "GR", "SV"]);

/**
 * The train's terminus as station codes. About half of live predictions carry a
 * null DestinationCode, so fall back to matching the (abbreviated) name. Plural
 * because a terminus at a transfer station has one code per platform.
 */
function terminusCodes(list, train) {
  if (train.DestinationCode) return [train.DestinationCode];
  return matchStation(list, train.DestinationName)?.codes ?? [];
}

// ponytail: WMATA's prediction feed returns only about three trains per platform
// group, so a second wait for your route shows up only when both land inside that
// window - often you get one. A longer horizon needs the GTFS-realtime TripUpdates
// feed (protobuf, so a parser dependency) or the static GTFS timetable as a filler.
/**
 * Every revenue train the feed names at these platforms, each flagged `mine`
 * when it actually serves the destination. The station list shows all of them
 * and the ruler draws all of them, so the filter is a flag rather than a drop -
 * the wrong-branch train below the axis is the whole point of the ruler.
 */
export async function platformTrains(cache, originCodes, destCodes, list) {
  const { Trains } = await http(`/StationPrediction.svc/json/GetPrediction/${originCodes.join(",")}`);
  const rows = [];
  for (const t of arr(Trains)) {
    if (!LINES.has(t.Line)) continue;
    let mine = false;
    for (const terminus of terminusCodes(list, t)) {
      // Only the terminus code on this platform's line yields a path, so try each.
      if (await serves(cache, t.LocationCode, destCodes, terminus)) {
        mine = true;
        break;
      }
    }
    // Prefer our full station name over WMATA's abbreviation for display.
    const named = matchStation(list, t.DestinationName);
    rows.push({
      min: t.Min,
      wait: fmtMin(t.Min),
      eta: etaOf(t.Min),
      line: t.Line,
      // Group is 1 or 2, and which is which is per-station, so it is carried as
      // the agency gives it: the popover only uses it to split the two
      // directions apart, never to name a platform or a track.
      group: t.Group ?? "",
      at: t.LocationCode, // which of the origin's platform codes, for the ride time
      terminus: named?.name ?? t.DestinationName,
      mine,
    });
  }
  return rows.sort((a, b) => rankOf(a.min) - rankOf(b.min));
}

export const upcoming = async (...args) => (await platformTrains(...args)).filter((t) => t.mine);

// Scheduled average minutes between two stations. Cached per pair forever: it is
// timetable geometry, not a live figure, which is exactly why the popover shows
// the arrival as "~09:50" and never styles it as precise.
export async function railTime(cache, origin, destCodes) {
  const times = (cache.railTimes ??= {});
  for (const dest of destCodes) {
    const key = `${origin}>${dest}`;
    if (!(key in times)) {
      const { StationToStationInfos } = await http("/Rail.svc/json/jSrcStationToDstStationInfo", {
        FromStationCode: origin,
        ToStationCode: dest,
      });
      const mins = StationToStationInfos?.[0]?.RailTime;
      // Only a real figure is cached - this cache never expires, so a zero from
      // one bad response would pin the arrival clock to "now" forever.
      if (Number.isFinite(mins) && mins > 0) {
        times[key] = mins;
        dirty = true;
      }
    }
    if (times[key]) return times[key];
  }
  return null;
}

/**
 * The versioned payload. `title` is what the menu bar reads; everything else is
 * the popover's. An empty board is still a payload: a placeholder wait plus the
 * reason as a note, because exit 0 with no stdout means the script never ran.
 */
export function payload({ trains, destination, fetchedAt, minsToArrival }) {
  const [next] = trains.filter((t) => t.mine);
  return {
    v: PAYLOAD_VERSION,
    kind: KIND_DEPARTURES,
    title: { line: next?.line ?? "", mins: next ? next.wait : "--" },
    note: next ? "" : `no trains to ${destination}`,
    fetchedAt,
    // Only from the next train's own wait: no arrival clock for a board with
    // nothing on it, and none for a wait that is not a number.
    arriveAt: Number.isFinite(minsToArrival) ? fetchedAt + minsToArrival * 60_000 : 0,
    // The lines that actually carry the trip, from trains that passed `serves`.
    // Not the origin and destination station line lists: New Carrollton is
    // registered Orange-only yet Silver trains run there, so intersecting the
    // stations would hide a real Silver alert.
    lines: [...new Set(trains.filter((t) => t.mine).map((t) => t.line))].sort(),
    platform: trains.map(({ wait, eta, line, group, terminus, mine }) => ({
      wait,
      eta,
      line,
      group,
      terminus,
      mine,
    })),
  };
}

// The alerts run: its own invocation on its own 5 minute timer, so a failure here
// can neither break nor delay a departure refresh.
export async function alerts(lines) {
  const { Incidents } = await http("/Incidents.svc/json/Incidents");
  return alertsForLines(normalizeIncidents(arr(Incidents)), lines);
}

const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

async function main([from, to]) {
  // Regenerate the bundled station list: `WMATA_API_KEY=... node src/departures/index.js --stations > src/shared/stations.json`
  if (from === "--stations") {
    if (!process.env.WMATA_API_KEY) throw new Error("WMATA_API_KEY is required to fetch the station list");
    process.stdout.write(`${JSON.stringify(await fetchStations(), null, 2)}\n`);
    return;
  }
  // The alerts side of the contract, invoked on its own timer with the lines the
  // last departures payload said actually carry the trip.
  if (from === "--alerts") {
    if (!process.env.WMATA_API_KEY) throw new Error("No WMATA API key - add one in Settings");
    const lines = (to ?? "").split(",").filter(Boolean);
    print({ v: PAYLOAD_VERSION, kind: KIND_ALERTS, lines, checkedAt: Date.now(), alerts: await alerts(lines) });
    return;
  }
  if (!from || !to) throw new Error("usage: departures.js <boarding station> <destination station>");
  if (!process.env.WMATA_API_KEY) throw new Error("No WMATA API key - add one in Settings");

  const cache = await loadCache();
  const list = await stationList(cache);
  // Saved before anything that can throw, and again at the end: the host kills
  // this process with SIGKILL on timeout, so there is no cleanup hook, and a
  // rejected trip or a slow prediction call would otherwise throw away the
  // ~200KB station list already paid for - which made a cold start and an
  // unsupported destination alike re-fetch the whole list every refresh, forever.
  if (dirty) await saveCache(cache);
  const originCodes = resolveCodes(list, from);
  const destCodes = resolveCodes(list, to);
  if (!(await sameLine(cache, originCodes, destCodes))) {
    await saveCache(cache); // keep the jPath results that proved it, or we re-prove it every 30s
    throw new Error(`${from} to ${to} needs a transfer - not supported`);
  }
  if (dirty) await saveCache(cache);
  const trains = await platformTrains(cache, originCodes, destCodes, list);
  const fetchedAt = Date.now();
  const [next] = trains.filter((t) => t.mine);
  // One cached call per station pair, ever - and only once a train exists to
  // count from, so an empty board spends nothing.
  const ride = next && Number.isFinite(next.eta) ? await railTime(cache, next.at, destCodes) : null;
  if (dirty) await saveCache(cache);
  print(payload({
    trains,
    destination: to,
    fetchedAt,
    minsToArrival: ride === null ? null : next.eta + ride,
  }));
}

// pathToFileURL, not `file://${argv[1]}`: the packaged path contains a space
// ("Train Menu.app"), which import.meta.url percent-encodes and a raw template
// does not - the guard was silently false in every packaged build.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
