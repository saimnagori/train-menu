// The walk shadow. The feed's minutes are half the decision; the other half is
// how long it takes you to reach the platform. One subtraction against a number
// the user sets once, applied to the trains the feed already named.
//
// Nothing here is fetched, predicted or smoothed. A train inside the shadow is
// still a real train at its real minute - it is flagged, never dropped, because
// whether you sprint for it is the user's call and not this app's.
import { LINE_COLORS } from "./parse.js";

/**
 * `trains` are the platform rows: { eta, wait, line, mine }. `walk` is minutes,
 * already clamped by normalizeConfig. Returns the same rows with two flags, plus
 * the one number the hero and the menu bar both read.
 *
 * `walk = 0` is off: no flags, no target, and every caller falls back to the
 * next train - today's behaviour exactly.
 */
export function walkModel(trains, walk = 0) {
  const minutes = Number.isFinite(walk) && walk > 0 ? walk : 0;
  // eta is null for "---", "" and a missing Min. Those cannot be compared with a
  // walk any more than they can be placed on an axis, so they are neither missed
  // nor catchable - they stay in the station list carrying no verdict.
  const reachable = (train) => train.mine && Number.isFinite(train.eta) && train.eta >= minutes;
  const rows = trains.map((train) => ({
    ...train,
    missed: minutes > 0 && train.mine && Number.isFinite(train.eta) && train.eta < minutes,
    target: false,
  }));
  // The soonest train you can actually reach, not the soonest train. This is the
  // whole option, and it is the one place it can put someone on the wrong
  // platform - which is why every surface that shows it also names it.
  const target = minutes > 0 ? rows.find(reachable) : null;
  if (target) target.target = true;
  return {
    walk: minutes,
    trains: rows,
    target: target ?? null,
    // Minutes until you have to move. 0 is "now" and never renders as "0m".
    leaveIn: target ? target.eta - minutes : null,
  };
}

/**
 * What the menu bar and the hero agree on. With a walk set this is the train you
 * can catch rather than the soonest one, so the two surfaces cannot disagree;
 * with no walk, or with nothing catchable in the feed, it is `fallback` - the
 * title the script produced from the next train.
 */
export function walkTitle(model, fallback) {
  const { target } = model;
  if (!target) return fallback;
  return { mins: target.wait, line: target.line, color: LINE_COLORS[target.line] ?? "" };
}
