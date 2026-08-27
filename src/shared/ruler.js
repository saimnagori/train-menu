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

/** The axis end: the last train the feed named, rounded up to the next step. */
export function rulerSpan(etas) {
  const last = Math.max(0, ...etas.filter((eta) => Number.isFinite(eta)));
  return Math.max(STEP_MIN, Math.ceil(last / STEP_MIN) * STEP_MIN);
}

/**
 * `trains` are the platform rows: { eta, wait, line, mine }. `eta` is null for
 * BRD-adjacent junk ("---", "", missing), which cannot be placed on an axis and
 * so is not drawn - it still appears in the station list, which claims no
 * position. BRD and ARR are eta 0: the left edge, labelled as themselves.
 */
export function rulerModel(trains) {
  const drawn = trains.filter((train) => Number.isFinite(train.eta));
  const span = rulerSpan(drawn.map((train) => train.eta));
  const marks = drawn
    .map((train) => ({
      eta: train.eta,
      pct: (train.eta / span) * 100,
      wait: train.wait,
      line: train.line,
      mine: Boolean(train.mine),
      now: train.eta === 0,
      lift: false,
    }))
    .sort((a, b) => a.eta - b.eta);

  // Each side of the axis alternates within its own run: the two sides never
  // collide with each other, and mine wants more clearance than other.
  alternate(marks.filter((mark) => mark.mine), COLLIDE_MIN);
  alternate(marks.filter((mark) => !mark.mine), COLLIDE_MIN_OTHER);

  const scale = [];
  for (let at = 0; at <= span; at += STEP_MIN) scale.push(at === 0 ? "now" : `${at}m`);
  return { span, scale, marks };
}
