// The static timetable. Every fixture below is the real feed's shape: PF_* stop
// ids under STN_* parents, a transfer station with two codes, a quoted comma in
// stops.txt and trips.txt but never in stop_times.txt, full route names, and
// departure times past 24:00:00.
import assert from "node:assert/strict";
import {
  extractTrips,
  gtfsSeconds,
  HORIZON_MIN,
  liveSeam,
  nextScheduled,
  parseCsv,
  platformCodes,
  serviceDate,
  serviceIdsFor,
} from "../src/shared/gtfs.js";

// --- CSV ---
// stops.txt and trips.txt quote any field containing a comma. A naive split shifts
// every later field, which reads as a feed with no matching platforms at all.
const quoted = parseCsv(
  ['stop_id,stop_name,location_type,parent_station', 'PF_K01_1,"Vienna, Orange Line Center Platform",0,STN_K01'].join("\n"),
);
assert.deepEqual(quoted, [
  { stop_id: "PF_K01_1", stop_name: "Vienna, Orange Line Center Platform", location_type: "0", parent_station: "STN_K01" },
]);
assert.deepEqual(parseCsv("a,b\n\n1,2\n").length, 1, "blank lines are not rows");
assert.equal(parseCsv("a,b\n1").b, undefined, "a short row does not throw");

// --- times ---
// A departure past midnight is expressed on the service day it started, so 25:52
// is a real time and not a parse error.
assert.equal(gtfsSeconds("25:52:00"), 93120);
assert.equal(gtfsSeconds("00:00:00"), 0);
assert.equal(gtfsSeconds("09:07:30"), 32850);
assert.equal(gtfsSeconds(""), null);
assert.equal(gtfsSeconds(undefined), null);

// --- platforms ---
// parent_station carries exactly the plural `codes` array the station list uses,
// so nothing here matches on a station name.
const STOPS = parseCsv(
  [
    "stop_id,location_type,parent_station",
    "PF_C05_1,0,STN_C05",
    "PF_C05_2,0,STN_C05",
    "PF_C01_C,0,STN_A01_C01",
    "PF_D13_1,0,STN_D13",
    "STN_C05,1,",
    "PF_X99_1,0,",
  ].join("\n"),
);
const codes = platformCodes(STOPS);
assert.deepEqual(codes.get("PF_C01_C"), ["A01", "C01"], "a transfer station yields both codes");
assert.deepEqual(codes.get("PF_C05_1"), ["C05"]);
assert.equal(codes.has("STN_C05"), false, "only location_type 0 rows are platforms stop_times can use");
assert.equal(codes.has("PF_X99_1"), false, "a platform with no parent station is not placeable");

// --- extraction ---
// Matching by station code picks up both directions at the origin on purpose. The
// wrong one is discarded because its destination stop comes earlier in the trip,
// which is the same question jPath answers for the live feed.
const TRIPS = parseCsv(
  [
    "trip_id,service_id,route_id,trip_headsign",
    "east,40_R,ORANGE,New Carrollton",
    "west,40_R,ORANGE,Vienna",
    "late,40_R,SILVER,New Carrollton",
    "other,39_R,ORANGE,New Carrollton",
    "bus,40_R,REX,New Carrollton",
    'quotes,40_R,BLUE,"Largo, Maryland"',
  ].join("\n"),
);
const STOP_TIMES = [
  "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
  "east,09:00:00,09:01:00,PF_C05_1,4",
  "east,09:20:00,09:21:00,PF_D13_1,12",
  // The westbound train calls at both stations too, in the other order.
  "west,09:05:00,09:06:00,PF_D13_1,2",
  "west,09:30:00,09:31:00,PF_C05_2,9",
  "late,25:50:00,25:52:00,PF_C05_1,4",
  "late,26:10:00,26:11:00,PF_D13_1,12",
  "other,05:20:00,05:21:00,PF_C05_1,4",
  "other,05:40:00,05:41:00,PF_D13_1,12",
  "bus,09:10:00,09:11:00,PF_C05_1,4",
  "bus,09:30:00,09:31:00,PF_D13_1,12",
  // Never reaches the destination.
  "short,09:15:00,09:16:00,PF_C05_1,4",
].join("\n");

const trips = extractTrips({ stops: STOPS, trips: TRIPS, stopTimes: STOP_TIMES }, ["C05"], ["D13"]);
assert.deepEqual(Object.keys(trips).sort(), ["39_R", "40_R"]);
assert.deepEqual(trips["40_R"], [
  { dep: 32460, line: "OR", terminus: "New Carrollton" },
  { dep: 93120, line: "SV", terminus: "New Carrollton" },
], "eastbound only, sorted, after-midnight departure kept as a service-day time");
assert.deepEqual(trips["39_R"].map((t) => t.dep), [19260]);
// A route this app does not draw is not a train it can put on the board.
assert.equal(JSON.stringify(trips).includes("REX"), false);
// Degradation is total, never partial: an unknown station pair yields nothing.
assert.deepEqual(extractTrips({ stops: STOPS, trips: TRIPS, stopTimes: STOP_TIMES }, ["Z99"], ["D13"]), {});
assert.deepEqual(extractTrips({ stops: STOPS, trips: TRIPS, stopTimes: "nonsense\n" }, ["C05"], ["D13"]), {});

// trip_headsign goes through the same matcher the live feed's DestinationName does.
const LIST = { stations: [{ name: "New Carrollton", codes: ["D13"], lines: ["OR"] }] };
const named = extractTrips({ stops: STOPS, trips: TRIPS, stopTimes: STOP_TIMES }, ["C05"], ["D13"], LIST);
assert.equal(named["40_R"][0].terminus, "New Carrollton");

// --- calendar ---
// WMATA ships no calendar.txt at all: every day is spelled out here.
const DATES = parseCsv(
  [
    "service_id,date,exception_type",
    "40_R,20260831,1",
    "39_R,20260831,1",
    "40_R,20260901,1",
    "38_R,20260901,2",
  ].join("\n"),
);
assert.deepEqual([...serviceIdsFor(DATES, "20260831")].sort(), ["39_R", "40_R"]);
assert.deepEqual([...serviceIdsFor(DATES, "20260901")], ["40_R"], "a removed service does not run");
assert.deepEqual([...serviceIdsFor(DATES, "20270704")], [], "a date past the feed has no service");
assert.deepEqual([...serviceIdsFor(undefined, "20260831")], []);
assert.equal(serviceDate(new Date(2026, 7, 31, 23, 59)), "20260831", "the service day is the local calendar day");

// --- where the sign stops speaking ---
const SIGN = [
  { eta: 0, group: "2", line: "BL", mine: false }, // the other direction
  { eta: 1, group: "1", line: "SV", mine: true },
  { eta: 5, group: "2", line: "OR", mine: false },
  { eta: 7, group: "1", line: "BL", mine: false },
  { eta: 10, group: "1", line: "SV", mine: false },
];
assert.equal(liveSeam(SIGN, "1"), 10, "the horizon is the last live minute in our direction");
assert.equal(liveSeam(SIGN, ""), 10, "with no learned group every live train counts");
// The opposite platform cannot drag our horizon out past its own last train.
assert.equal(liveSeam([{ eta: 2, group: "1" }, { eta: 30, group: "2" }], "1"), 2);
assert.equal(liveSeam([], "1"), null, "a feed that named nothing seams nowhere");
assert.equal(liveSeam([{ eta: null, group: "1" }, { eta: NaN, group: "1" }], "1"), null, "an unplaceable wait is not a horizon");

// --- projection ---
const SCHEDULE = { trips, dates: DATES, group: "1" };
const at = (h, m) => new Date(2026, 7, 31, h, m, 0);

// A quiet board: the feed named nothing, so the tail starts from now.
assert.deepEqual(nextScheduled(SCHEDULE, [], at(8, 45), 2), [
  { wait: "~16m", eta: 16, line: "OR", group: "1", terminus: "New Carrollton", mine: true, source: "sched" },
]);

// Two rows at most: this answers "when is the next one I can catch", not "print
// the timetable" - and a longer tail would stretch the axis for no gain.
const many = {
  group: "1",
  dates: DATES,
  trips: { "40_R": [10, 20, 30, 40].map((m) => ({ dep: 32400 + m * 60, line: "OR", terminus: "X" })) },
};
assert.deepEqual(nextScheduled(many, [], at(9, 0), 2).map((r) => r.eta), [10, 20]);
assert.equal(nextScheduled(many, [], at(9, 0), 0).length, 0);

// --- the live feed wins wherever the two overlap ---
// Both rules are needed, and this board needs both. Verbatim from the live feed:
// the sign names one train of ours, a Silver at 1m, and reaches 10m in our
// direction. The timetable has that same Silver at 3m - the prediction is running
// two minutes ahead of the published time - then an Orange at 9m and the next
// Orange at 19m.
const AHEAD = {
  group: "1",
  dates: DATES,
  trips: {
    "40_R": [
      { dep: 32580, line: "SV", terminus: "New Carrollton" }, // 09:03, the live 1m train
      { dep: 32940, line: "OR", terminus: "New Carrollton" }, // 09:09, never named by the sign
      { dep: 33540, line: "OR", terminus: "New Carrollton" }, // 09:19
      { dep: 34140, line: "SV", terminus: "New Carrollton" }, // 09:29
    ],
  },
};
assert.deepEqual(
  nextScheduled(AHEAD, SIGN, at(9, 0), 2).map((r) => r.wait),
  ["~19m", "~29m"],
  "the sign's Silver is not repeated as a scheduled row, and neither is a train the sign skipped",
);
// Order is what catches the early runner: it is the very train that sets the
// horizon, so no cut on time can ever reach it.
assert.deepEqual(
  nextScheduled(AHEAD, [{ eta: 1, group: "1", line: "SV", mine: true }], at(9, 0), 3).map((r) => r.wait),
  ["~9m", "~19m", "~29m"],
  "one Silver on the sign consumes exactly one scheduled Silver, and no Orange",
);
// The window is what catches the skipped one: the sign truncates by count, so a
// train it had room for and did not name is one it is contradicting.
assert.deepEqual(
  nextScheduled(AHEAD, [{ eta: 10, group: "1", line: "BL", mine: false }], at(9, 0), 3).map((r) => r.wait),
  ["~19m", "~29m"],
  "nothing of ours on the sign still means the sign owns everything inside its horizon",
);
// A train of ours the sign cannot put a minute on is still on the sign.
assert.deepEqual(
  nextScheduled(AHEAD, [{ eta: null, group: "1", line: "SV", mine: true }], at(9, 0), 2).map((r) => r.wait),
  ["~9m", "~19m"],
);
// The opposite platform is not our sign and consumes nothing of ours.
assert.deepEqual(
  nextScheduled(AHEAD, [{ eta: 40, group: "2", line: "SV", mine: true }], at(9, 0), 2).map((r) => r.wait),
  ["~3m", "~9m"],
);

// After midnight the catchable train is in *yesterday's* service day: 25:52 on the
// 31st is 01:52 on the 1st, and the 1st's own service does not start until 05:21.
const early = nextScheduled(SCHEDULE, [], new Date(2026, 8, 1, 1, 30), 2);
assert.deepEqual(early.map((r) => [r.eta, r.line]), [[22, "SV"]], "yesterday's after-midnight tail is today's next train");
// The same 25:52 read at 00:45, an hour and seven minutes before it leaves.
assert.deepEqual(nextScheduled(SCHEDULE, [], new Date(2026, 8, 1, 0, 45), 2).map((r) => r.eta), [67]);

// Past the horizon the honest reading is a quiet board, not a mark hours out. At
// 23:00 the 25:52 departure is nearly three hours away, and saying so on a 172
// minute axis would be worse than saying nothing.
assert.equal(HORIZON_MIN, 90);
assert.deepEqual(nextScheduled(SCHEDULE, [], at(23, 0), 2), []);
assert.deepEqual(nextScheduled(SCHEDULE, [], new Date(2026, 8, 1, 3, 0), 2), [], "nothing runs at 3am and nothing is claimed");

// Degradation is silent and total.
assert.deepEqual(nextScheduled(null, [], at(9, 0), 2), []);
assert.deepEqual(nextScheduled({ dates: DATES }, [], at(9, 0), 2), []);
assert.deepEqual(nextScheduled({ trips, dates: [] }, [], at(9, 0), 2), [], "no service_id for today means no rows");
// Every scheduled row is one of the user's, flagged as scheduled, and carries the
// group learned from the live feed - the popover splits directions by it.
for (const row of nextScheduled(SCHEDULE, [], at(8, 0), 2)) {
  assert.equal(row.mine, true);
  assert.equal(row.source, "sched");
  assert.equal(row.group, "1");
  assert.match(row.wait, /^~\d+m$/, "the tilde is the estimate, and the renderer does not add it");
}
assert.equal(nextScheduled({ ...SCHEDULE, group: undefined }, [], at(8, 0), 2)[0].group, "", "an unlearned group is absent, not guessed");

console.log("ok gtfs");
