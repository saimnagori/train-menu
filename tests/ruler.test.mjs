// The minute ruler. Every number the mock draws is reproduced here, because the
// mock is the visual contract: trains at 3m/6m above the line and 1m/4m below it
// sit at 30/60/10/40 percent of a 10 minute axis.
import assert from "node:assert/strict";
import { rulerModel, rulerSpan, scaleStep, STEP_MIN } from "../src/shared/ruler.js";

const t = (eta, line, mine, wait = eta === 0 ? "BRD" : `${eta}m`) => ({ eta, wait, line, mine });

// The axis ends at the last train the feed named, rounded up to the next 5.
assert.equal(rulerSpan([3, 6]), 10);
assert.equal(rulerSpan([1, 4, 5]), 5, "a train exactly on a step does not push the axis out");
assert.equal(rulerSpan([11]), 15);
assert.equal(rulerSpan([0]), STEP_MIN, "a boarding train still needs an axis to sit on");
assert.equal(rulerSpan([]), STEP_MIN);
assert.equal(rulerSpan([null, NaN, 6]), 10, "unplaceable waits do not stretch the axis");

const model = rulerModel([t(3, "OR", true), t(6, "SV", true), t(1, "BL", false), t(4, "BL", false)]);
assert.equal(model.span, 10);
assert.deepEqual(model.scale, ["now", "5m", "10m"]);
assert.deepEqual(
  model.marks.map((m) => [m.wait, m.line, m.mine, m.pct]),
  [
    ["1m", "BL", false, 10],
    ["3m", "OR", true, 30],
    ["4m", "BL", false, 40],
    ["6m", "SV", true, 60],
  ],
  "placed at Min verbatim, ordered by wait",
);

// Two labels a few minutes apart overlap, so the run alternates rows while every
// stem still lands on its true minute. Only the marks above the line lift.
assert.deepEqual(
  model.marks.filter((m) => m.mine).map((m) => m.lift),
  [true, false],
);
// Below the line the labels are 10px caps, so 1m and 4m are already clear of
// each other - as the mock draws them.
assert.deepEqual(model.marks.filter((m) => !m.mine).map((m) => m.lift), [false, false]);
// Two trains on the same minute to different termini is a real feed state, and
// it is the one case where the labels below the line do collide.
assert.deepEqual(
  rulerModel([t(9, "SV", false), t(9, "OR", false), t(3, "OR", true)]).marks.map((m) => [m.line, m.pct, m.lift]),
  [
    ["OR", 30, false],
    ["SV", 90, true],
    ["OR", 90, false],
  ],
  "same-minute marks below the line stagger instead of printing on top of each other",
);
assert.deepEqual(rulerModel([t(3, "OR", true)]).marks.map((m) => m.lift), [false], "a lone label never lifts");
assert.deepEqual(
  rulerModel([t(1, "OR", true), t(9, "SV", true)]).marks.map((m) => m.lift),
  [false, false],
  "labels that cannot collide stay on one row",
);
assert.deepEqual(
  rulerModel([t(1, "OR", true), t(2, "SV", true), t(3, "OR", true)]).marks.map((m) => m.lift),
  [true, false, true],
  "a run of three alternates rather than stacking two labels",
);

// BRD and ARR are not minutes. They take the left edge and are labelled as
// themselves, never rewritten as "0m".
const boarding = rulerModel([t(0, "OR", true), t(0, "BL", false, "ARR"), t(6, "SV", true)]);
assert.deepEqual(
  boarding.marks.map((m) => [m.wait, m.pct, m.now]),
  [
    ["BRD", 0, true],
    ["ARR", 0, true],
    ["6m", 60, false],
  ],
);

// "---", "" and a missing Min cannot be placed on an axis, so they are not drawn.
// They still appear in the station list, which does not claim a position.
const junk = rulerModel([{ eta: null, wait: "--", line: "OR", mine: true }, t(4, "SV", true)]);
assert.deepEqual(junk.marks.map((m) => m.wait), ["4m"]);
assert.deepEqual(rulerModel([]).marks, [], "an empty feed draws no marks");

// The walk shadow is the same arithmetic as a mark's position, so its edge and a
// mark on that minute land on the same pixel: 5 minutes of a 10 minute axis is
// half the band, where the 6m train sits at 60% and is still outside it.
const shaded = rulerModel(
  [{ ...t(3, "OR", true), missed: true }, t(6, "SV", true), t(1, "BL", false)],
  5,
);
assert.equal(shaded.shadowPct, 50);
assert.deepEqual(shaded.marks.map((m) => [m.wait, m.missed]), [["1m", false], ["3m", true], ["6m", false]]);
assert.equal(rulerModel([t(3, "OR", true)]).shadowPct, 0, "no walk draws no shadow");
// A walk past the last train the feed named covers the whole band rather than
// running off the end of it - nothing here is reachable, and that is the reading.
assert.equal(rulerModel([t(3, "OR", true)], 30).shadowPct, 100);

// Never state a gap unless a train brackets it on both sides. With two trains at
// 3m and 6m there is no third train, so there is nothing to say - the model
// offers no gap, no horizon and no commentary to render.
for (const key of ["gap", "gaps", "horizon", "next", "predicted"]) {
  assert.equal(key in model, false, `the ruler must not publish "${key}"`);
}
assert.equal(model.marks.length, 4, "exactly the trains the feed named, nothing interpolated");
// The axis never runs more than one step past the last train, so no long stretch
// of empty track is drawn for the eye to read as a gap.
assert.ok(model.span - Math.max(...model.marks.map((m) => m.eta)) < STEP_MIN);

// --- the long axis ---
// Scheduled departures reach far past the live feed's ~15 minutes, so the step
// opens up rather than printing ten labels across 360px. Every span must be a
// whole number of steps: the renderer spaces the labels evenly and puts a tick
// under each, so a span the step does not divide would draw ticks that lie.
assert.equal(scaleStep(10), 5);
assert.equal(scaleStep(20), 10);
assert.equal(scaleStep(45), 15);
for (const last of [1, 4, 7, 12, 15, 16, 22, 29, 31, 44, 60]) {
  const span = rulerSpan([last]);
  assert.ok(span >= last, `axis ${span} must reach the ${last}m train`);
  assert.equal(span % scaleStep(span), 0, `span ${span} is not a whole number of ${scaleStep(span)}m steps`);
  assert.ok(span / scaleStep(span) + 1 <= 7, `span ${span} prints too many labels`);
}
assert.deepEqual(rulerModel([t(18, "OR", true)]).scale, ["now", "10m", "20m"]);
assert.deepEqual(rulerModel([t(42, "OR", true)]).scale, ["now", "15m", "30m", "45m"]);

// Collision is a pixel problem but the thresholds are minutes, so they have to
// scale with the span. The tuning at span 10 is untouched (the mock's numbers,
// asserted above); the same 4 minutes is a third of the pixels on a 45 minute
// axis, so a pair that cleared each other on a short board now collides.
assert.deepEqual(
  rulerModel([t(3, "OR", true), t(9, "SV", true)]).marks.map((m) => m.lift),
  [false, false],
  "6 minutes of a 10 minute axis is more than half its width",
);
assert.deepEqual(
  rulerModel([t(3, "OR", true), t(9, "SV", true), t(40, "OR", true)]).marks.map((m) => m.lift),
  [true, false, false],
  "the same 6 minutes is an eighth of a 45 minute axis, so the labels stagger",
);

console.log("ok ruler");
