// Line code -> colour name. The menu bar can only render type, but the tray
// readout tints its bullet and the popover tints its line dot, and both want a
// name rather than a hex.
export const LINE_COLORS = {
  RD: "red",
  OR: "orange",
  BL: "blue",
  GR: "green",
  YL: "yellow",
  SV: "silver",
};

export const colorOf = (line) => LINE_COLORS[line] ?? "";

// Script contract: ONE versioned JSON object on stdout, not the line-oriented
// text this file used to parse. Option 08 needs the user's trains, every other
// train at the platform, both directions, the arrival estimate and the alerts -
// a shape that a first-line-is-the-title format could only smuggle.
//
// The version is checked rather than assumed: in dev TRAIN_MENU_SCRIPT can point
// at any script, so everything below is a trust boundary and is coerced, not
// trusted. A mismatch fails loudly instead of rendering half a board.
export const PAYLOAD_VERSION = 1;

const str = (value) => (typeof value === "string" ? value : "");
const num = (value) => (Number.isFinite(value) ? value : 0);
const list = (value) => (Array.isArray(value) ? value : []);
const codes = (value) => list(value).filter((line) => typeof line === "string");

// The two runs - departures and `--alerts` - are separate invocations that share
// a version, so `v` alone cannot tell them apart. Each payload names itself, and
// the parser insists on the one it wants: a crossed pair now fails loudly instead
// of coercing into an all-defaults board that looks like a quiet morning.
export const KIND_DEPARTURES = "departures";
export const KIND_ALERTS = "alerts";
// The static timetable refresh: a third invocation on a 12 hour timer, whose only
// job is to leave a cache file behind. Nothing it prints reaches the board.
export const KIND_SCHEDULE = "schedule";

function envelope(stdout, kind) {
  let raw;
  try {
    raw = JSON.parse(stdout);
  } catch {
    // Exit 0 with nothing (or with prose) on stdout is a failure, not an empty
    // board: an empty board is still a payload with a "--" title.
    throw new Error("departures script produced no output");
  }
  if (raw?.v !== PAYLOAD_VERSION) {
    throw new Error(`departures script speaks contract v${raw?.v} - expected v${PAYLOAD_VERSION}`);
  }
  if (raw.kind !== kind) {
    throw new Error(`expected a "${kind}" payload, got "${str(raw.kind) || "none"}"`);
  }
  return raw;
}

export function parsePayload(stdout) {
  const raw = envelope(stdout, KIND_DEPARTURES);
  const mins = str(raw.title?.mins).trim();
  if (!mins) throw new Error("departures script produced no output");
  return {
    title: { mins, line: str(raw.title?.line), color: colorOf(raw.title?.line) },
    // Why the board is empty, when it is - reaches the hero in place of the
    // destination rather than as a giant word in the wait column.
    note: str(raw.note),
    // Wall-clock stamps as epoch ms, formatted in the renderer: the popover
    // shows when the response landed, which is the freshness proof.
    fetchedAt: num(raw.fetchedAt),
    arriveAt: num(raw.arriveAt),
    // The lines whose trains actually serve the trip - what the alerts filter on.
    lines: codes(raw.lines),
    platform: list(raw.platform).map((train) => ({
      wait: str(train?.wait),
      eta: Number.isFinite(train?.eta) ? train.eta : null,
      line: str(train?.line),
      group: str(train?.group),
      terminus: str(train?.terminus),
      mine: Boolean(train?.mine),
      // "live" (the prediction feed) or "sched" (the static timetable, past the
      // live window). Anything else coerces to "live" rather than reaching the
      // renderer, which styles a scheduled row as the estimate it is.
      source: str(train?.source) === "sched" ? "sched" : "live",
    })),
  };
}

/**
 * The `--schedule` run: same envelope, its own 12 hour cadence. The timetable
 * itself goes to its own cache file, which the departures run reads - this is only
 * the host's proof that the refresh happened, so `trips` is a count.
 */
export function parseSchedule(stdout) {
  const raw = envelope(stdout, KIND_SCHEDULE);
  return { from: str(raw.from), to: str(raw.to), trips: num(raw.trips), refreshedAt: num(raw.refreshedAt) };
}

/** The separate `--alerts` run: same envelope, its own cadence. */
export function parseAlerts(stdout) {
  const raw = envelope(stdout, KIND_ALERTS);
  return {
    lines: codes(raw.lines),
    checkedAt: num(raw.checkedAt),
    alerts: list(raw.alerts).map((alert) => ({
      id: str(alert?.id),
      lines: codes(alert?.lines),
      type: str(alert?.type) || "alert",
      description: str(alert?.description),
      updatedAt: str(alert?.updatedAt),
    })),
  };
}
