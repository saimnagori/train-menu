// Dev harness: a stand-in for src/departures/index.js that emits canned payloads
// instead of calling WMATA. Speaks the same v1 contract, so the main process and
// the renderer cannot tell the difference.
//
//   TRAIN_MENU_SCRIPT=scripts/fixture-departures.js TRAIN_MENU_FIXTURE=alert pnpm dev
//
// Why this exists: the live feed will not produce a boarding train, a three-train
// label collision and an active alert on your lines on demand - and those are
// exactly the states the option 08 layout can break in. Waiting for rush hour to
// see whether a label overlaps is not a test.
//
// Must stay `.js`: app.js routes only a .js script through Electron's bundled
// node, and a GUI launch inherits too bare a PATH for a shebang to resolve.
// Imported rather than duplicated: hand-copied envelope fields and wait
// formatting silently drifted out of the contract once already, which made every
// fixture fail the `kind` check the moment it was added.
import { PAYLOAD_VERSION, KIND_DEPARTURES, KIND_ALERTS } from "../src/shared/parse.js";
import { fmtMin } from "../src/departures/index.js";

const now = Date.now();
const min = (n) => now + n * 60_000;

// A 300+ character description, which is the real length WMATA returns - the
// clamp and the READ ALL affordance are only exercised by prose this long.
const LONG = [
  "Thru Sept 6th, shuttle buses replace trains between North Bethesda and Shady Grove",
  "for platform reconstruction. Trains single track between Twinbrook and Rockville.",
  "Expect delays of 20 minutes or more in both directions. Shuttle buses depart from",
  "the bus bays at each station every 10 minutes and are accessible. Allow at least",
  "45 additional minutes for your trip. Use Metrorail trip planner for alternates.",
].join(" ");

const train = (wait, line, terminus, mine, group = "1") => ({
  wait: fmtMin(wait),
  eta: /^\d+$/.test(wait) ? Number(wait) : 0,
  line,
  group,
  terminus,
  mine,
});

// Trains toward the destination, other trains on the same platform, and the
// opposite direction - the three things the station list has to keep separate.
const PLATFORM = [
  train("3", "OR", "New Carrollton", true),
  train("1", "BL", "Downtown Largo", false),
  train("6", "SV", "New Carrollton", true),
  train("9", "OR", "New Carrollton", true),
  train("4", "SV", "Ashburn", false, "2"),
  train("11", "OR", "Vienna", false, "2"),
];

const board = (over) => ({
  v: PAYLOAD_VERSION,
  kind: KIND_DEPARTURES,
  title: { mins: "3m", line: "OR" },
  note: "",
  fetchedAt: now,
  arriveAt: min(35),
  lines: ["OR", "SV"],
  platform: PLATFORM,
  ...over,
});

const alerts = (rows) => ({
  v: PAYLOAD_VERSION,
  kind: KIND_ALERTS,
  lines: ["OR", "SV"],
  checkedAt: now,
  alerts: rows,
});

const ALERT = {
  id: "650de57b-fixture",
  lines: ["OR"],
  type: "Alert",
  description: LONG,
  // 16 days old and still in force: age is not staleness, so the relative-age
  // label must read as information rather than as a stale-data warning.
  updatedAt: new Date(now - 16 * 864e5).toISOString(),
};

const FIXTURES = {
  // The design's happy path: full board, one alert on a line you actually ride.
  alert: { board: board(), alerts: alerts([ALERT]) },
  // No alerts. The block should be absent, not an empty frame.
  clear: { board: board(), alerts: alerts([]) },
  // BRD and ARR are not minutes - both pin to the left edge, tinted, labelled
  // as themselves, and must not be placed as though they were minute 0.
  boarding: {
    board: board({
      title: { mins: "BRD", line: "OR" },
      platform: [train("BRD", "OR", "New Carrollton", true), train("ARR", "SV", "New Carrollton", true), ...PLATFORM],
    }),
    alerts: alerts([]),
  },
  // Three trains inside four minutes: the label-collision case the `lift` class
  // exists for. Stems must still land on the true minute.
  crowded: {
    board: board({
      platform: [
        train("3", "OR", "New Carrollton", true),
        train("4", "SV", "New Carrollton", true),
        train("5", "OR", "New Carrollton", true),
        train("6", "BL", "Downtown Largo", false),
      ],
    }),
    alerts: alerts([ALERT]),
  },
  // One train, so there is no second train to bracket a gap. Nothing on the
  // ruler may imply a wait beyond it.
  single: {
    board: board({ title: { mins: "7m", line: "OR" }, platform: [train("7", "OR", "New Carrollton", true)] }),
    alerts: alerts([]),
  },
  // Genuinely empty board: a title placeholder plus the reason, which belongs in
  // the hero rather than as a giant word in the wait column.
  empty: {
    board: board({ title: { mins: "--", line: "" }, note: "no trains to New Carrollton", platform: [], arriveAt: 0 }),
    alerts: alerts([]),
  },
  // Late-horizon board: the axis rounds up to the next 5, so 23m gives a 25m span.
  horizon: {
    board: board({
      title: { mins: "12m", line: "OR" },
      platform: [train("12", "OR", "New Carrollton", true), train("23", "SV", "New Carrollton", true)],
    }),
    alerts: alerts([]),
  },
};

// Failure paths, which are the ones a mock HTML page cannot show at all: the
// popover has to keep last-good data visible and flag it, not blank itself.
const FAILURES = {
  fail: "WMATA rejected the API key",
  // Exit 0 with empty stdout - the regression that silently blanked the menu bar.
  silent: null,
};

const name = process.env.TRAIN_MENU_FIXTURE || "alert";

if (name in FAILURES) {
  const message = FAILURES[name];
  if (message === null) process.exit(0); // no output at all, on purpose
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const fixture = FIXTURES[name];
if (!fixture) {
  process.stderr.write(`unknown fixture "${name}" - try: ${Object.keys({ ...FIXTURES, ...FAILURES }).join(", ")}\n`);
  process.exit(1);
}

// Same argv shape as the real script: `--alerts <lines>` or `<from> <to>`.
const payload = process.argv[2] === "--alerts" ? fixture.alerts : fixture.board;
process.stdout.write(`${JSON.stringify(payload)}\n`);
