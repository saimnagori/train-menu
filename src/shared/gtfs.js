// The static timetable, used only past the live window. GetPrediction names about
// three trains per platform group, so once the walk shadow has eaten those the
// board goes quiet with no way to tell when the next catchable train is. This
// fills that stretch from WMATA's GTFS static feed.
//
// Pure logic only - the download and the unzip live in departures/index.js, the
// same split alerts.js already follows. Nothing here decides what the live window
// shows: a scheduled row can only ever sit past the last train the feed named.
import { matchStation } from "./stations.js";

const DAY = 86400;

// GTFS names lines in full; the rest of the app speaks WMATA's two-letter codes.
// A literal map, because there are six of them and there will be six of them next
// year - a route that is not in here is not a revenue line we show.
const ROUTE_LINES = {
  RED: "RD",
  ORANGE: "OR",
  BLUE: "BL",
  GREEN: "GR",
  YELLOW: "YL",
  SILVER: "SV",
};

/**
 * Quote-aware CSV, for stops.txt and trips.txt: both quote fields containing a
 * comma ("Vienna, Orange Line Center Platform"), and a naive split shifts every
 * later field and silently yields zero matches. stop_times.txt has no quoted
 * fields at all, so its 352k-row scan stays a plain split - see extractTrips.
 */
export function parseCsv(text) {
  const lines = text.split("\n");
  const head = lines[0].trim().split(",");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cells = [];
    let cur = "";
    let quoted = false;
    for (const ch of lines[i]) {
      if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    rows.push(Object.fromEntries(head.map((key, j) => [key, (cells[j] ?? "").trim()])));
  }
  return rows;
}

/**
 * "25:52:00" is 93120, not a bug: GTFS times are service-day relative, so a train
 * past midnight is expressed as hour 24 or 25 on the day its service started.
 */
export function gtfsSeconds(time) {
  const [h, m, s] = String(time ?? "").split(":");
  const secs = Number(h) * 3600 + Number(m) * 60 + Number(s);
  return Number.isFinite(secs) ? secs : null;
}

/**
 * Platform stop id -> the station codes it belongs to, e.g.
 *   PF_C05_1  parent_station=STN_C05      -> ["C05"]
 *   PF_C01_C  parent_station=STN_A01_C01  -> ["A01", "C01"]
 * which is exactly the plural `codes` array the station list already carries, so
 * no name matching is involved anywhere in the stop lookup. Only location_type
 * "0" rows are real platforms; the STN_* parents never appear in stop_times.
 */
export function platformCodes(stopsRows) {
  const byStop = new Map();
  for (const stop of stopsRows) {
    if (stop.location_type !== "0") continue;
    if (!stop.parent_station?.startsWith("STN_")) continue;
    byStop.set(stop.stop_id, stop.parent_station.slice(4).split("_"));
  }
  return byStop;
}

const platformsFor = (byStop, codes) =>
  new Set([...byStop].filter(([, own]) => own.some((code) => codes.includes(code))).map(([id]) => id));

/**
 * Every scheduled trip from `originCodes` that later calls at `destCodes`, grouped
 * by service_id: `{ "40_R": [{ dep, line, terminus }, ...] }`, each list sorted.
 *
 * `stopTimes` is the raw file, not parsed rows: it is 352k lines and the scan is
 * the whole cost of this, so it splits on commas directly.
 *
 * No attempt is made to pick the right platform. Matching by station code picks up
 * both directions at the origin, and the `destSeq > originSeq` test drops the
 * wrong-direction trip on its own - the same "does this train actually get me
 * there" question jPath answers for the live feed.
 */
export function extractTrips({ stops, trips, stopTimes }, originCodes, destCodes, list = null) {
  const byStop = platformCodes(stops);
  const originPf = platformsFor(byStop, originCodes);
  const destPf = platformsFor(byStop, destCodes);
  if (!originPf.size || !destPf.size) return {};

  const lines = stopTimes.split("\n");
  const head = lines[0].trim().split(",");
  const iTrip = head.indexOf("trip_id");
  const iDep = head.indexOf("departure_time");
  const iStop = head.indexOf("stop_id");
  const iSeq = head.indexOf("stop_sequence");
  if ([iTrip, iDep, iStop, iSeq].some((i) => i < 0)) return {};

  const touched = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const stopId = cells[iStop];
    if (!stopId) continue;
    const atOrigin = originPf.has(stopId);
    if (!atOrigin && !destPf.has(stopId)) continue;
    const entry = touched.get(cells[iTrip]) ?? {};
    if (atOrigin) {
      entry.originSeq = Number(cells[iSeq]);
      entry.dep = gtfsSeconds(cells[iDep]);
    } else entry.destSeq = Number(cells[iSeq]);
    touched.set(cells[iTrip], entry);
  }

  const meta = new Map(trips.map((trip) => [trip.trip_id, trip]));
  const bySvc = {};
  for (const [tripId, entry] of touched) {
    if (entry.originSeq === undefined || entry.destSeq === undefined) continue;
    if (!(entry.destSeq > entry.originSeq) || entry.dep === null) continue;
    const trip = meta.get(tripId);
    const line = ROUTE_LINES[trip?.route_id];
    if (!line) continue; // non-revenue, or a route this app does not draw
    // trip_headsign is a clean station name, so it goes through the same matcher
    // the live feed's DestinationName does - and falls back to itself.
    const named = list ? matchStation(list, trip.trip_headsign) : null;
    (bySvc[trip.service_id] ??= []).push({
      dep: entry.dep,
      line,
      terminus: named?.name ?? trip.trip_headsign,
    });
  }
  for (const departures of Object.values(bySvc)) departures.sort((a, b) => a.dep - b.dep);
  return bySvc;
}

/**
 * Which service_ids run on a date. WMATA's feed ships no calendar.txt at all -
 * every day is spelled out in calendar_dates.txt, and only as exception_type 1
 * (added). A type 2 (removed) row would still be honoured by the filter.
 */
export function serviceIdsFor(calendarDates, yyyymmdd) {
  const ids = new Set();
  for (const row of calendarDates ?? []) {
    if (row.date === yyyymmdd && row.exception_type === "1") ids.add(row.service_id);
  }
  return ids;
}

// Local time, not UTC: a service day is the agency's calendar day, and the popover
// clock is the user's.
export const serviceDate = (date) =>
  `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;

const secondsInto = (date) => date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();

// Past this the answer stops being useful. At 01:00 the next train is genuinely
// hours away, and the honest reading of that is the quiet board, not a row that
// says 4h12m. The board's own window is shorter still - this is the outer bound on
// what the timetable will even offer it.
export const HORIZON_MIN = 90;

/**
 * Where the platform sign stops speaking: the last live minute in our direction,
 * or null when it named nothing at all.
 *
 * Deliberately not the last train of *ours* on the sign. A prediction can run ahead
 * of the published time - a Silver train called 1m out is the timetable's 3m train
 * - and a seam at that train's live minute lets its own scheduled copy through, so
 * the board prints one train twice. The sign truncates by count rather than by
 * time, so a scheduled train inside its horizon that it does not name is one it is
 * contradicting, and the sign is the more accurate of the two.
 *
 * `group` is the direction, learned from the live feed. Without it every live train
 * counts: the opposite platform then drags the seam out, which errs toward saying
 * less rather than toward disagreeing with the sign.
 */
export function liveSeam(trains, group = "") {
  const ours = group ? trains.filter((train) => train.group === group) : trains;
  const etas = ours.map((train) => train.eta).filter((eta) => Number.isFinite(eta));
  return etas.length ? Math.max(...etas) : null;
}

/** Every departure this trip has left today, soonest first, as minutes from now. */
function candidates(schedule, now) {
  const secs = secondsInto(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const rows = [];
  // [service day, seconds to subtract because that day started earlier]
  for (const [day, shift] of [[now, 0], [yesterday, DAY]]) {
    for (const svc of serviceIdsFor(schedule.dates, serviceDate(day))) {
      for (const trip of schedule.trips[svc] ?? []) {
        const eta = Math.round((trip.dep - shift - secs) / 60);
        if (eta >= 0) rows.push({ eta, line: trip.line, terminus: trip.terminus });
      }
    }
  }
  return rows.sort((a, b) => a.eta - b.eta);
}

/**
 * The next scheduled departures, as extra platform rows past what the sign shows.
 *
 * `trains` is the live board. The prediction feed is the more accurate of the two
 * and wins wherever they overlap, which takes both of these to enforce, because
 * either alone leaks a duplicate:
 *
 *  - Order. The trains of ours the sign names ARE the timetable's next departures
 *    on those lines, so each one consumes the next scheduled trip of its line. This
 *    is what catches a train running ahead of its published time - a Silver called
 *    6m out that the timetable puts at 7m - which no cut on time can catch, since
 *    that train is the very thing that sets where the live window ends.
 *  - The window. Past the consumed ones, anything still inside the sign's own
 *    horizon is a train the sign had room for and did not name, so the sign is
 *    contradicting it and the sign wins.
 *
 * Two service days are considered. A departure at 25:52 belongs to yesterday's
 * service day, so at 01:30 today the catchable train is in yesterday's list.
 *
 * ponytail: order-matching is per line and assumes the sign names our trains in
 * timetable order, which a train late enough to be overtaken by the next one of its
 * own line would break. GTFS-RT trip ids are the real fix if that ever shows up.
 */
export function nextScheduled(schedule, trains = [], now = new Date(), limit = 2) {
  const cap = Math.max(0, limit);
  if (!schedule?.trips || !cap) return [];
  const group = schedule.group ?? "";
  const ours = group ? trains.filter((train) => train.group === group) : trains;
  const seam = liveSeam(trains, group);
  // How many departures of each line the sign has already spoken for. A train of
  // ours with no usable minute ("---") still counts: it is on the sign.
  const named = {};
  for (const train of ours) if (train.mine) named[train.line] = (named[train.line] ?? 0) + 1;

  const rows = [];
  for (const trip of candidates(schedule, now)) {
    if (named[trip.line] > 0) {
      named[trip.line]--; // the sign is already showing this one, in its own words
      continue;
    }
    if (seam !== null && trip.eta <= seam) continue;
    if (trip.eta > HORIZON_MIN) break;
    rows.push({
      wait: `~${trip.eta}m`,
      eta: trip.eta,
      line: trip.line,
      // Learned from the live feed: GTFS track numbers are not WMATA's
      // prediction Group, and the popover splits directions by Group.
      group,
      terminus: trip.terminus,
      mine: true,
      source: "sched",
    });
    if (rows.length === cap) break;
  }
  return rows;
}
