// The departure list: the trains leaving your platform in the near term, live and
// scheduled in one column of minutes, soonest first.
//
// This replaced the minute ruler. The ruler was accurate and cost a translation on
// every read - a position had to be turned into a minute, then matched against the
// same train in the list below it. A list is the order you leave the house in.
//
// Nothing here fetches, predicts or re-derives. It takes the rows walkModel already
// flagged and decides which of them belong on the board, in what order.

// The near term. Long enough to cover a missed train and the one after it, short
// enough that the board is a decision rather than a timetable.
export const WINDOW_MIN = 30;

// Unplaceable waits ("---", "", a missing Min) sort last: they are real trains at
// the platform, but nothing about them can be compared with a minute.
const at = (train) => (Number.isFinite(train.eta) ? train.eta : Infinity);

/**
 * `trains` are the platform rows from walkModel: { eta, wait, line, group, terminus,
 * mine, missed, target, source }. Returns the rows to draw, in draw order.
 *
 * Only trains that reach your destination are shown. Same direction is not the same
 * question: off one Rosslyn platform a Blue train to Largo leaves the way you are
 * going and never gets you to New Carrollton, so it is not a departure you can use.
 * `mine` is already the flag for "this train serves the trip", so it is the filter.
 */
export function boardList(trains, window = WINDOW_MIN) {
  const mine = trains.filter((train) => train.mine);
  // No train of ours in the feed is not an error: at 01:00, or on a branch the feed
  // has nothing for, every train at the platform is somebody else's. Showing them
  // all beats showing an empty board.
  const ours = mine.length ? mine : trains;
  const sorted = [...ours].sort((a, b) => at(a) - at(b));
  // The soonest train that serves the trip - with a walk set, the soonest one you
  // can reach. Both stay on the board past the window, or the list contradicts the
  // verdict printed on it.
  const named = new Set([sorted.find((train) => train.mine), sorted.find((train) => train.target)].filter(Boolean));
  // An unplaceable wait is a train standing at the platform whose minute the feed
  // would not give. It cannot be outside the window because it is not anywhere on a
  // minute axis, so it stays - the same rule the station list has always had.
  const rows = sorted.filter((train) => !Number.isFinite(train.eta) || train.eta <= window || named.has(train));
  // No seam. A predicted and a scheduled row differ by one tilde on the minute and
  // one step of ink; a heading between them said the same thing a second time, and
  // invited reading one list as two tables with two orders.
  return { rows, window };
}
