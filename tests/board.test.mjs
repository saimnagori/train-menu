// The departure list. Every row the Option 11 mock draws is reproduced here: at
// Rosslyn heading to New Carrollton, only trains that reach New Carrollton, live and
// scheduled in one list, sorted by the minute and nothing else.
import assert from "node:assert/strict";
import { boardList, WINDOW_MIN } from "../src/shared/board.js";

const t = (eta, line, mine, extra = {}) => ({
  eta,
  wait: `${eta}m`,
  line,
  group: "1",
  terminus: mine ? "New Carrollton" : "Largo",
  mine,
  ...extra,
});
const sched = (eta, line) => t(eta, line, true, { wait: `~${eta}m`, source: "sched" });

// The mock's board: three live trains that serve the trip, two scheduled past them,
// and one same-direction train that does not go where you are going.
const mock = [t(3, "OR", true, { missed: true }), t(6, "SV", true, { target: true }), t(8, "BL", false), t(14, "SV", true), sched(23, "OR"), sched(27, "SV")];

const board = boardList(mock);
assert.deepEqual(
  board.rows.map((row) => [row.wait, row.line]),
  [
    ["3m", "OR"],
    ["6m", "SV"],
    ["14m", "SV"],
    ["~23m", "OR"],
    ["~27m", "SV"],
  ],
  "one sort key: the minute. Live and scheduled interleave, they are not two stacked tables",
);
assert.equal(board.window, WINDOW_MIN);
assert.equal(board.seam, undefined, "no seam: the tilde on the minute is the whole distinction");

// A scheduled train sooner than a live one sits above it. It should never happen -
// nextScheduled dedupes against the sign - but if it does the list must show the
// order it will actually happen in.
assert.deepEqual(
  boardList([t(14, "SV", true), sched(9, "OR")]).rows.map((row) => row.wait),
  ["~9m", "14m"],
);

// Only trains that reach the destination. A Blue train off the same platform in the
// same direction leaves for Largo and is not a departure you can use, so it is not
// on the board - being in `group` "1" buys it nothing.
assert.deepEqual(
  boardList([t(3, "OR", true), t(2, "BL", false), { ...t(4, "SV", false), group: "2" }]).rows.map((row) => row.line),
  ["OR"],
);

// Nothing of ours in the feed - a branch the feed has nothing for, or the small
// hours. Every train at the platform beats an empty board.
assert.deepEqual(
  boardList([t(4, "BL", false), t(9, "YL", false)]).rows.map((row) => row.line),
  ["BL", "YL"],
);

// The window is a horizon, not a row count: rush hour fills it, midnight does not.
assert.deepEqual(
  boardList([t(4, "OR", true), t(31, "SV", true), t(44, "OR", true)]).rows.map((row) => row.eta),
  [4],
  "a horizon, not a row count: everything past 30 minutes goes",
);
assert.deepEqual(
  boardList([t(48, "SV", true)]).rows.map((row) => row.eta),
  [48],
  "except the soonest train of ours - the walk verdict names it, so the list must show it",
);
assert.deepEqual(
  boardList([t(2, "OR", true, { missed: true }), t(48, "SV", true, { target: true })]).rows.map((row) => row.eta),
  [2, 48],
  "and so does the train the walk picked, however far out it is",
);
assert.deepEqual(
  boardList([t(4, "OR", true), t(9, "SV", true)], 5).rows.map((row) => row.eta),
  [4],
  "the window is a parameter",
);

// BRD and ARR are eta 0 and belong at the top. "---" cannot be compared with a
// minute at all, so it sorts last rather than reading as an imminent train.
assert.deepEqual(
  boardList([{ ...t(0, "OR", true), eta: null, wait: "---" }, t(0, "SV", true, { wait: "BRD" }), t(4, "OR", true)]).rows.map(
    (row) => row.wait,
  ),
  ["BRD", "4m", "---"],
);

// No rows in, no rows out.
assert.deepEqual(boardList([]).rows, []);

// The rows are the payload's own objects passed through, but the array is ours: the
// board must not reorder the list the tray and the walk model read.
const input = [t(9, "SV", true), t(3, "OR", true)];
boardList(input);
assert.deepEqual(input.map((row) => row.eta), [9, 3], "boardList does not sort its input in place");

console.log("ok board");
