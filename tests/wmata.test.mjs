// WMATA data-layer tests: the station list and the departures script.
// test.mjs covers the UI-facing pieces (parse, config, bounds).
import assert from "node:assert/strict";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePayload } from "../src/shared/parse.js";
import { rulerModel } from "../src/shared/ruler.js";
import { listStations, matchStation, normalizeStations, resolveCodes } from "../src/shared/stations.js";
import {
  alerts,
  etaOf,
  fetchStations,
  fmtMin,
  isDirty,
  pathSeq,
  payload,
  platformTrains,
  railTime,
  rankOf,
  saveCache,
  serves,
  setFetch,
  stationList,
  upcoming,
} from "../src/departures/index.js";

// --- stations ---

// WMATA returns one row per platform; the picker wants one row per station.
const RAW = [
  { Code: "A01", Name: "Metro Center", StationTogether1: "C01", LineCode1: "RD" },
  { Code: "C01", Name: "Metro Center", StationTogether1: "A01", LineCode1: "BL", LineCode2: "OR", LineCode3: "SV" },
  { Code: "C05", Name: "Rosslyn", StationTogether1: "", LineCode1: "BL", LineCode2: "OR", LineCode3: "SV" },
  { Code: "D13", Name: "New Carrollton", StationTogether1: "", LineCode1: "OR" },
  { Code: "G05", Name: "Downtown Largo", StationTogether1: "", LineCode1: "BL", LineCode2: "SV" },
  { Code: "K08", Name: "Vienna/Fairfax-GMU", StationTogether1: "", LineCode1: "OR" },
  { Code: "F11", Name: "Archives-Navy Memorial-Penn Quarter", StationTogether1: "", LineCode1: "GR" },
];
const list = { fetchedAt: "2026-01-01T00:00:00.000Z", stations: normalizeStations(RAW) };

assert.deepEqual(
  list.stations.map((s) => s.name).slice(0, 3),
  ["Archives-Navy Memorial-Penn Quarter", "Downtown Largo", "Metro Center"],
  "folded by name, sorted for the picker",
);
assert.deepEqual(list.stations.find((s) => s.name === "Metro Center"), {
  name: "Metro Center",
  codes: ["A01", "C01"],
  lines: ["BL", "OR", "RD", "SV"],
});

// Both platform codes must come back, or half the predictions go missing.
assert.deepEqual(resolveCodes(list, "Metro Center"), ["A01", "C01"]);
assert.deepEqual(resolveCodes(list, "  rosslyn "), ["C05"], "trims and ignores case");
assert.deepEqual(resolveCodes(list, "c05"), ["C05"], "a raw code still resolves");
assert.throws(() => resolveCodes(list, "Rosslyne"), /Unknown station "Rosslyne"/, "a typo is rejected, not guessed");
assert.throws(() => resolveCodes(list, "carroll"), /did you mean: New Carrollton/, "partial match suggests");

// A refreshed copy in the cache wins over the bundled file.
assert.equal((await listStations({ stations: list })).stations.length, list.stations.length);

// Abbreviation matching. Half of all live predictions carry a null
// DestinationCode and only an abbreviated name, so these are load-bearing.
// Every case here is a string observed in real GetPrediction/All output.
for (const [abbrev, expected] of [
  ["New Carrollton", "New Carrollton"], // exact
  ["NewCrlton", "New Carrollton"],
  ["New Crlton", "New Carrollton"],
  ["NEW CARROLLTON", "New Carrollton"], // WMATA sometimes shouts
  ["Largo", "Downtown Largo"],
  ["Vienna", "Vienna/Fairfax-GMU"],
  ["VIENNA", "Vienna/Fairfax-GMU"],
]) {
  assert.equal(matchStation(list, abbrev)?.name, expected, `${abbrev} -> ${expected}`);
}
// Plain subsequence matching would tie "Vienna" with
// "Archives-Navy Memorial-Penn Quarter" (v-i-e-n-n-a all appear in order);
// anchoring on the first letter is what breaks the tie.
assert.equal(matchStation(list, "Archives")?.name, "Archives-Navy Memorial-Penn Quarter");
assert.equal(matchStation(list, "Nowhere"), null, "no match is null, never a guess");
assert.equal(matchStation(list, ""), null);

// A genuine tie must resolve to null rather than picking one at random.
const twins = { stations: normalizeStations([
  { Code: "X01", Name: "Court House", StationTogether1: "", LineCode1: "OR" },
  { Code: "X02", Name: "Courthouse Square", StationTogether1: "", LineCode1: "OR" },
]) };
assert.equal(matchStation(twins, "Courths"), null, "ambiguous abbreviation is not guessed");

console.log("ok stations");

// --- departures ---

const PATHS = {
  // Rosslyn -> New Carrollton (Orange), -> Largo (Silver), -> Vienna (westbound)
  "C05>D13": ["C05", "C01", "D01", "D04", "D13"],
  "C05>G05": ["C05", "C01", "D01", "G05"],
  "C05>K08": ["C05", "K01", "K08"],
};
// Shapes copied from real GetPrediction/C05 output, including the two quirks that
// live data exposed: a revenue train with a null DestinationCode and only an
// abbreviated name, and non-revenue rows where "No Passenger" is truncated across
// Line and Destination.
// Group is 1 eastbound and 2 westbound at Rosslyn, as the live feed reports it.
const TRAINS = [
  { Line: "SV", Min: "4", Group: "1", LocationCode: "C05", DestinationCode: "G05", DestinationName: "Downtown Largo" },
  { Line: "OR", Min: "9", Group: "1", LocationCode: "C05", DestinationCode: "D13", DestinationName: "New Carrollton" },
  { Line: "OR", Min: "BRD", Group: "1", LocationCode: "C05", DestinationCode: null, DestinationName: "NewCrlton" },
  { Line: "SV", Min: "6", Group: "1", LocationCode: "C05", DestinationCode: null, DestinationName: "New Crlton" },
  { Line: "OR", Min: "2", Group: "2", LocationCode: "C05", DestinationCode: "K08", DestinationName: "Vienna/Fairfax-GMU" },
  { Line: "No", Min: "1", Group: "1", LocationCode: "C05", DestinationCode: null, DestinationName: "No Passenger" },
  { Line: "--", Min: "1", Group: "1", LocationCode: "C05", DestinationCode: null, DestinationName: "Train" },
];

// One live incident, Red Line - the real state of the feed today, and the reason
// a Rosslyn -> New Carrollton trip must come back clear.
const INCIDENTS = [
  {
    IncidentID: "650de57b",
    Description: "Thru Sept 6th, shuttle buses replace trains between North Bethesda and Friendship Heights.",
    PassengerDelay: 0,
    DelaySeverity: null,
    IncidentType: "Alert",
    LinesAffected: "RD;",
    DateUpdated: "2026-08-11T12:36:17",
  },
];

let calls = [];
setFetch(async (path, params) => {
  calls.push(path);
  if (path.includes("jPath")) {
    const seq = PATHS[`${params.FromStationCode}>${params.ToStationCode}`] ?? [];
    return { Path: seq.map((StationCode, SeqNum) => ({ StationCode, SeqNum })) };
  }
  if (path.includes("jSrcStationToDstStationInfo")) {
    // The live figure for C05 -> D13. Anything else is a pair we never ask for.
    const time = `${params.FromStationCode}>${params.ToStationCode}` === "C05>D13" ? 35 : 0;
    return { StationToStationInfos: [{ RailTime: time }] };
  }
  if (path.includes("Incidents")) return { Incidents: INCIDENTS };
  return { Trains: TRAINS };
});

// The crux: a prediction gives the train's terminus, not its stop list.
const seen = {};
assert.equal(await serves(seen, "C05", ["D13"], "D13"), true, "Orange/Silver to New Carrollton counts");
assert.equal(await serves(seen, "C05", ["D13"], "G05"), false, "Silver to Largo must NOT count");
assert.equal(await serves(seen, "C05", ["D13"], "K08"), false, "westbound must not count");
assert.equal(await serves(seen, "C05", ["D13"], "Z99"), false, "unknown terminus must not count");
assert.equal(await serves(seen, "C05", ["D04"], "D13"), true, "a mid-route destination counts");

// Min is a string: never a fake number, never a crash.
assert.deepEqual(["BRD", "ARR", "7", "---", "", null].map(etaOf), [0, 0, 7, null, null, null]);
assert.ok(rankOf("BRD") < rankOf("ARR") && rankOf("ARR") < rankOf("1") && rankOf("1") < rankOf("12"));
assert.ok(rankOf("12") < rankOf("---"), "unparseable sinks to the bottom");
assert.deepEqual(["BRD", "ARR", "7", "---", ""].map(fmtMin), ["BRD", "ARR", "7m", "--", "--"]);

const warm = {};
let trains = await upcoming(warm, ["C05"], ["D13"], list);
assert.deepEqual(
  trains.map((t) => `${t.line} ${t.min} ${t.terminus}`),
  ["OR BRD New Carrollton", "SV 6 New Carrollton", "OR 9 New Carrollton"],
  "null-code trains kept and named; Largo, westbound and non-revenue dropped",
);

// The station list and the ruler show every train at the platform, so the filter
// is a flag rather than a drop - the wrong-branch Silver to Largo and the
// westbound Orange to Vienna are what the greyed rows and the marks below the
// axis are made of. Non-revenue trains are still dropped: they carry no passengers.
const board = await platformTrains(warm, ["C05"], ["D13"], list);
assert.deepEqual(
  board.map((t) => [t.wait, t.line, t.terminus, t.group, t.mine]),
  [
    ["BRD", "OR", "New Carrollton", "1", true],
    ["2m", "OR", "Vienna/Fairfax-GMU", "2", false],
    ["4m", "SV", "Downtown Largo", "1", false],
    ["6m", "SV", "New Carrollton", "1", true],
    ["9m", "OR", "New Carrollton", "1", true],
  ],
  "one row per revenue train, sorted by wait, flagged not filtered",
);

// The cost argument: once warm, a refresh is exactly ONE call.
calls = [];
trains = await upcoming(warm, ["C05"], ["D13"], list);
assert.deepEqual(calls, ["/StationPrediction.svc/json/GetPrediction/C05"], "paths are cached, not refetched");

// --- the arrival estimate ---

// RailTime is a scheduled average, so it is fetched once per station pair and
// cached forever, and the popover prints it with a tilde.
calls = [];
assert.equal(await railTime(warm, "C05", ["D13"]), 35);
assert.equal(await railTime(warm, "C05", ["D13"]), 35);
assert.deepEqual(calls, ["/Rail.svc/json/jSrcStationToDstStationInfo"], "cached per pair, forever");
// A zero is not a ride time. Caching it would pin the arrival clock to "now"
// forever, since this cache never expires.
const badRide = {};
assert.equal(await railTime(badRide, "C05", ["Z99"]), null);
assert.deepEqual(badRide.railTimes, {});

// An empty path must NOT be cached: this cache never expires, so one bad response
// would drop that terminus forever, fixable only by deleting the file by hand.
const hiccup = {};
calls = [];
assert.deepEqual(await pathSeq(hiccup, "C05", "Z99"), {});
assert.deepEqual(await pathSeq(hiccup, "C05", "Z99"), {});
assert.equal(calls.length, 2, "an empty path is retried, not remembered");
assert.deepEqual(hiccup.paths, {}, "and nothing empty is persisted");

// Writes only when something actually changed - a warm refresh mutates nothing,
// and rewriting the whole cache file every 30s for that is pure churn.
process.env.TRAIN_MENU_CACHE = await mkdtemp(join(tmpdir(), "train-menu-cache-"));
await saveCache(warm);
assert.equal(isDirty(), false, "a write clears the dirty flag");
await upcoming(warm, ["C05"], ["D13"], list);
assert.equal(isDirty(), false, "a warm refresh changes nothing");
await pathSeq({}, "C05", "D13");
assert.equal(isDirty(), true, "a newly fetched path marks the cache dirty");

// An unwritable cache must not throw: it runs after the predictions call, so a
// throw here would discard a board that was already fetched and turn it into a
// hard error. The dirty flag survives so the next run retries the write.
const readonly = await mkdtemp(join(tmpdir(), "train-menu-ro-"));
await chmod(readonly, 0o500);
process.env.TRAIN_MENU_CACHE = readonly;
await saveCache(warm); // must not reject
assert.equal(isDirty(), true, "a failed write leaves the cache dirty");
await chmod(readonly, 0o700); // so the tmpdir can be cleaned up

// A cache with no fetchedAt must read as stale: Date.parse gives NaN, and NaN
// fails every comparison, which pinned the bundled list as current forever.
process.env.WMATA_API_KEY = "test-key";
let asked = 0;
setFetch(async (path) => {
  asked++;
  assert.equal(path, "/Rail.svc/json/jStations");
  return { Stations: RAW };
});
const undated = { stations: { stations: list.stations } }; // no fetchedAt
await stationList(undated);
assert.equal(asked, 1, "a missing fetchedAt refreshes");
assert.ok(undated.stations.fetchedAt, "and records when it did");
await stationList(undated);
assert.equal(asked, 1, "a fresh list is not refetched");
await stationList({ stations: { stations: list.stations, fetchedAt: "not a date" } });
assert.equal(asked, 2, "an unparseable fetchedAt refreshes too");
delete process.env.WMATA_API_KEY;

// --- the payload: the script's stdout must survive the round trip ---

const FETCHED = Date.parse("2026-08-27T09:15:42");
const out = parsePayload(
  `${JSON.stringify(payload({ trains: board, destination: "New Carrollton", fetchedAt: FETCHED, minsToArrival: 35 }))}\n`,
);
assert.deepEqual(out.title, { mins: "BRD", line: "OR", color: "orange" });
assert.equal(out.note, "");
assert.equal(out.fetchedAt, FETCHED, "the stamp is when the response landed, not when it is drawn");
assert.equal(out.arriveAt, FETCHED + 35 * 60_000);
assert.deepEqual(out.lines, ["OR", "SV"], "the lines that actually carry the trip, and only those");
assert.equal(out.platform.length, 5, "every revenue train reaches the popover");
assert.deepEqual(out.platform[0], {
  wait: "BRD",
  eta: 0,
  line: "OR",
  group: "1",
  terminus: "New Carrollton",
  mine: true,
});
// Nothing the user rejected may reach the renderer, whatever the feed carries:
// no car count, no fare, no platform or track number.
for (const train of out.platform) {
  assert.deepEqual(Object.keys(train).sort(), ["eta", "group", "line", "mine", "terminus", "wait"]);
}

// An empty board must not parse as a departure - "no trains to X" in the wait
// column would put a giant "no" in the popover hero.
const nothing = parsePayload(
  JSON.stringify(payload({ trains: [], destination: "New Carrollton", fetchedAt: FETCHED, minsToArrival: null })),
);
assert.equal(nothing.title.mins, "--", "empty state shows a placeholder wait, not a word");
assert.equal(nothing.title.line, "", "empty state carries no line code");
assert.equal(nothing.note, "no trains to New Carrollton", "the reason reaches the hero line");
assert.equal(nothing.arriveAt, 0, "and there is nothing to arrive from");
assert.deepEqual(nothing.lines, [], "with no trains, no line is watched for alerts");

// A wait that is not a number cannot be counted from, so there is no clock.
const junk = payload({ trains: board, destination: "X", fetchedAt: FETCHED, minsToArrival: null });
assert.equal(junk.arriveAt, 0);

// The ruler reads the payload straight, so the round trip is what it draws: the
// two New Carrollton trains above the axis, the Largo and Vienna trains below.
const drawn = rulerModel(out.platform);
assert.equal(drawn.span, 10, "the axis ends at the last train the feed named, rounded up to the next 5");
assert.deepEqual(drawn.scale, ["now", "5m", "10m"]);
assert.deepEqual(
  drawn.marks.map((m) => [m.wait, m.mine, m.pct]),
  [
    ["BRD", true, 0],
    ["2m", false, 20],
    ["4m", false, 40],
    ["6m", true, 60],
    ["9m", true, 90],
  ],
);

console.log("ok payload");

// --- alerts ---

// Its own fetch: the station-list section above swapped in a jStations stub, and
// the alerts run is a separate invocation of this script anyway.
setFetch(async (path) => {
  assert.equal(path, "/Incidents.svc/json/Incidents");
  return { Incidents: INCIDENTS };
});
// Today's live feed carries one Red Line incident, so the correct answer for a
// Rosslyn -> New Carrollton trip is nothing at all.
assert.deepEqual(await alerts(out.lines), [], "a Red Line incident is not an Orange/Silver alert");
assert.deepEqual((await alerts(["RD"])).map((a) => a.id), ["650de57b"], "and the same feed does match a Red trip");

// Every list off the response is a trust boundary. WMATA drops these keys outright
// during an outage, and a captive portal returns whatever it likes, so a missing
// or wrong-typed list must read as an empty board - not a TypeError in the tray
// tooltip. `?? []` would not be enough: a non-array still throws at the for..of.
for (const bad of [undefined, null, "none", 42, { Trains: 1 }]) {
  setFetch(async () => ({ Trains: bad, Incidents: bad, Path: bad, Stations: bad }));
  assert.deepEqual(await platformTrains({ paths: {} }, ["C05"], ["D13"], list), [], `Trains: ${JSON.stringify(bad)}`);
  assert.deepEqual(await alerts(["OR"]), [], `Incidents: ${JSON.stringify(bad)}`);
  assert.deepEqual(await pathSeq({}, "C05", "D13"), {}, `Path: ${JSON.stringify(bad)}`);
  assert.deepEqual((await fetchStations()).stations, [], `Stations: ${JSON.stringify(bad)}`);
}

console.log("ok departures");
