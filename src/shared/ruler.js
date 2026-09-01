// The minute ruler under the hero: the user's trains above the axis, every other
// train at their platform below it. Placement is the whole job, so every mark
// sits at the Min the feed gave, verbatim - no interpolation, no smoothing, no
// train the feed did not name.
//
// Nothing here reports a gap. A gap can only be stated when a train brackets it
// on both sides, and the feed names about three trains per platform group, so
// the stretch past the last one is unknown rather than empty. The axis stops at
// the last train the feed named and the scale labels carry that on their own.
export const STEP_MIN = 5;
// A fixed 5 minute step printed ten labels on a 45 minute axis, which only never
// happened because the live feed cannot reach past about 15 minutes. Scheduled
// departures can, so the step opens up instead: never more than about seven labels.
export const scaleStep = (span) => (span <= 15 ? 5 : span <= 30 ? 10 : 15);
// Two labels closer together than this overlap on a 360px popover, so a run of
// them alternates rows while each stem stays on its true minute. Above the line
// the label is two rows tall and wants real clearance; below it a line code over
// a wait in 10px caps only touches when two trains share a minute, which the
// live feed does produce - two 9m trains to different termini.
const COLLIDE_MIN = 4;
const COLLIDE_MIN_OTHER = 2;

// A run of labels too close together reads high-low-high, starting lifted. The
// stem never moves: only the label does, so the mark still names its true minute.
function alternate(marks, threshold) {
  for (const [i, mark] of marks.entries()) {
    const prev = marks[i - 1];
    const next = marks[i + 1];
    mark.lift =
      prev && mark.eta - prev.eta < threshold ? !prev.lift : Boolean(next && next.eta - mark.eta < threshold);
  }
}

/**
 * The axis end: the last train drawn, rounded up to the next step. It must land on
 * a whole number of steps - the renderer spaces the scale labels evenly and puts a
 * tick under each, so a span the step does not divide would print ticks that lie.
 */
export function rulerSpan(etas) {
  const last = Math.max(0, ...etas.filter((eta) => Number.isFinite(eta)));
  const step = scaleStep(Math.ceil(last / STEP_MIN) * STEP_MIN);
  return Math.max(step, Math.ceil(last / step) * step);
}

/**
 * `trains` are the platform rows: { eta, wait, line, mine }. `eta` is null for
 * BRD-adjacent junk ("---", "", missing), which cannot be placed on an axis and
 * so is not drawn - it still appears in the station list, which claims no
 * position. BRD and ARR are eta 0: the left edge, labelled as themselves.
 */
export function rulerModel(trains, walk = 0) {
  const drawn = trains.filter((train) => Number.isFinite(train.eta));
  const span = rulerSpan(drawn.map((train) => train.eta));
  const marks = drawn
    .map((train) => ({
      eta: train.eta,
      pct: (train.eta / span) * 100,
      wait: train.wait,
      line: train.line,
      mine: Boolean(train.mine),
      // Set by walkModel: this train leaves before you can reach the platform.
      // The ruler dims it where it stands rather than moving or hiding it.
      missed: Boolean(train.missed),
      // From the static timetable rather than the prediction feed: drawn hollow,
      // because it is a scheduled minute and not a train anyone has seen yet.
      sched: train.source === "sched",
      now: train.eta === 0,
      lift: false,
    }))
    .sort((a, b) => a.eta - b.eta);

  // Collision is a pixel problem on a fixed-width axis, but the thresholds are in
  // minutes, so they have to grow with the span or a 45 minute axis staggers labels
  // that are inches apart. At span 10 this is exactly the tuning the mock fixed.
  const perMin = span / 10;
  // Each side of the axis alternates within its own run: the two sides never
  // collide with each other, and mine wants more clearance than other.
  alternate(marks.filter((mark) => mark.mine), COLLIDE_MIN * perMin);
  alternate(marks.filter((mark) => !mark.mine), COLLIDE_MIN_OTHER * perMin);

  const scale = [];
  for (let at = 0; at <= span; at += scaleStep(span)) scale.push(at === 0 ? "now" : `${at}m`);
  // The walk as a share of the axis - the same arithmetic as every mark's
  // position, so the shadow's edge and a mark on that minute land together. A
  // walk longer than the axis covers the whole band, which is the honest reading:
  // nothing the feed has named is reachable.
  const shadowPct = walk > 0 ? Math.min(walk / span, 1) * 100 : 0;
  return { span, scale, marks, shadowPct };
}
