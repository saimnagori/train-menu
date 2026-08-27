// Rail incidents, filtered to the lines that carry the user's trip.
//
// The live records carry PassengerDelay: 0 and DelaySeverity: null, so there is
// nothing to build a severity ladder or a "12 min delay" badge out of. One flat
// attention state is the honest maximum, and that is all this layer reports.
//
// There is no end date either: WMATA drops an incident from the feed once it
// clears, so presence *is* "still active". DateUpdated is therefore reported as
// an age, not as staleness - the live Red Line record is a fortnight old and
// still genuinely in force.

/** LinesAffected is a semicolon-delimited string, and "RD;" is a single line. */
export const parseLinesAffected = (affected) =>
  String(affected ?? "")
    .split(";")
    .map((line) => line.trim().toUpperCase())
    .filter(Boolean);

export const normalizeIncidents = (rows) =>
  (rows ?? []).map((row) => ({
    id: row.IncidentID,
    lines: parseLinesAffected(row.LinesAffected),
    // IncidentType is the agency's own word for it ("Alert", "Delay"), used as
    // the card's label rather than a severity we would have to invent.
    type: (row.IncidentType ?? "Alert").toLowerCase(),
    description: (row.Description ?? "").trim(),
    updatedAt: row.DateUpdated ?? null,
  }));

/**
 * `lines` are the lines whose trains actually serve the trip, not the lines the
 * origin and destination stations are registered for: New Carrollton is listed
 * as Orange-only yet Silver trains run there, so a station-list intersection
 * would hide a real Silver alert.
 */
export function alertsForLines(incidents, lines) {
  const watched = new Set(lines);
  return incidents.filter((incident) => incident.lines.some((line) => watched.has(line)));
}

export function relativeAge(updatedAt, now = Date.now()) {
  // DateUpdated has no zone ("2026-08-11T12:36:17"), which Date.parse reads as
  // local time - the same clock the popover shows, and what WMATA means by it.
  const then = Date.parse(updatedAt);
  if (!Number.isFinite(then)) return "";
  const min = Math.floor((now - then) / 60_000);
  if (min < 1) return "just now"; // also covers a record stamped ahead of us
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const days = Math.floor(hr / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
