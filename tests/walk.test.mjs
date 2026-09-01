// The walk shadow. Every number the mock draws is reproduced here: a 5 minute
// walk over trains at 3m (OR, yours), 6m (SV, yours) and 1m (BL, wrong branch)
// makes the 3m train gone, the 6m train the target, and "leave in 1m" the answer.
import assert from "node:assert/strict";
import { walkModel, walkTitle } from "../src/shared/walk.js";

const t = (eta, line, mine, wait = `${eta}m`) => ({ eta, wait, line, mine });
const board = () => [t(1, "BL", false), t(3, "OR", true), t(6, "SV", true)];
const FALLBACK = { mins: "3m", line: "OR", color: "orange" };

const walk = walkModel(board(), 5);
assert.equal(walk.leaveIn, 1, "Min - walk, on the first train you can reach");
assert.equal(walk.target.line, "SV");
assert.deepEqual(
  walk.trains.map((train) => [train.line, train.missed, train.target]),
  [
    ["BL", false, false],
    ["OR", true, false],
    ["SV", false, true],
  ],
  "the 3m train is gone; the wrong-branch train is neither gone nor yours",
);
// The menu bar shows the train you can catch, not the soonest one, or the two
// surfaces disagree about which train the user is walking to.
assert.deepEqual(walkTitle(walk, FALLBACK), { mins: "6m", line: "SV", color: "silver" });

// A train exactly on the walk is reachable - you arrive as it does.
assert.equal(walkModel(board(), 6).leaveIn, 0, "a walk equal to the wait means leave now, not gone");
assert.equal(walkModel(board(), 3).target.line, "OR");

// The whole feature is additive or it is absent: no walk means no flags, no
// target, and the title the script produced.
const off = walkModel(board(), 0);
assert.equal(off.leaveIn, null);
assert.equal(off.target, null);
assert.deepEqual(off.trains.map((train) => train.missed), [false, false, false]);
assert.deepEqual(walkTitle(off, FALLBACK), FALLBACK);
// A garbage value from a hand-edited config reads as off rather than as a shadow
// over the whole board.
for (const bad of [undefined, null, NaN, -5, "5"]) {
  assert.equal(walkModel(board(), bad).leaveIn, null, `walk ${String(bad)} is off`);
}

// A walk longer than every train the feed named: nothing is catchable, so there
// is no target and no leave-in. The board falls back to reporting, and every
// train of yours is honestly marked gone.
const beyond = walkModel(board(), 30);
assert.equal(beyond.target, null);
assert.equal(beyond.leaveIn, null);
assert.deepEqual(beyond.trains.map((train) => train.missed), [false, true, true]);
assert.deepEqual(walkTitle(beyond, FALLBACK), FALLBACK, "no catchable train falls back to the next one");

// BRD and ARR are eta 0: real trains, on the platform now, and gone the moment a
// walk exists. "---" and a missing Min have no eta at all, so they can no more
// carry a verdict than they can take a position in a list sorted by minute.
const edge = walkModel([t(0, "OR", true, "BRD"), { eta: null, wait: "--", line: "SV", mine: true }, t(9, "OR", true)], 5);
assert.deepEqual(
  edge.trains.map((train) => [train.wait, train.missed, train.target]),
  [
    ["BRD", true, false],
    ["--", false, false],
    ["9m", false, true],
  ],
);

// The rows are copies: a walk must never mutate the payload the tray, the hero
// and the departure list all read.
const rows = board();
walkModel(rows, 5);
assert.deepEqual(rows, board(), "walkModel does not touch its input");

console.log("ok walk");
