// Incidents: the 5-minute call behind the alerts block. Every shape here comes
// from the live /Incidents.svc/json/Incidents response.
import assert from "node:assert/strict";
import { alertsForLines, normalizeIncidents, parseLinesAffected, relativeAge } from "../src/shared/alerts.js";

// LinesAffected is a semicolon-delimited string, and a single line still carries
// the separator ("RD;"), so a plain split leaves an empty entry behind.
assert.deepEqual(parseLinesAffected("RD;"), ["RD"]);
assert.deepEqual(parseLinesAffected("OR; SV;BL"), ["OR", "SV", "BL"]);
assert.deepEqual(parseLinesAffected("rd;"), ["RD"], "case is normalized");
assert.deepEqual(parseLinesAffected(""), []);
assert.deepEqual(parseLinesAffected(null), [], "a missing field is not a crash");
assert.deepEqual(parseLinesAffected(";;"), [], "separators alone name no line");

// The live record, verbatim.
const LIVE = {
  IncidentID: "650de57b-1194-406d-94ba-442fa6bb30aa",
  Description: "Thru Sept 6th, shuttle buses replace trains between North Bethesda and Friendship Heights.",
  StartLocationFullName: null,
  EndLocationFullName: null,
  PassengerDelay: 0,
  DelaySeverity: null,
  IncidentType: "Alert",
  EmergencyText: null,
  LinesAffected: "RD;",
  DateUpdated: "2026-08-11T12:36:17",
};

const [live] = normalizeIncidents([LIVE]);
assert.deepEqual(live, {
  id: "650de57b-1194-406d-94ba-442fa6bb30aa",
  lines: ["RD"],
  type: "alert",
  description: LIVE.Description,
  updatedAt: "2026-08-11T12:36:17",
});
// PassengerDelay is 0 and DelaySeverity is null on real records, so nothing may
// carry a severity or a delay figure out of this layer - one flat state only.
assert.equal("severity" in live, false);
assert.equal("delay" in live, false);

assert.deepEqual(normalizeIncidents(null), [], "a missing Incidents array is empty, not a throw");
assert.deepEqual(normalizeIncidents([{ IncidentID: "x" }]), [
  { id: "x", lines: [], type: "alert", description: "", updatedAt: null },
]);

// The filter: only the lines that actually carry the trip. Today's live feed has
// one Red Line incident, and a Rosslyn -> New Carrollton trip runs OR/SV, so the
// correct result is nothing at all.
const incidents = normalizeIncidents([
  LIVE,
  { IncidentID: "b", LinesAffected: "OR;SV;", Description: "single tracking", DateUpdated: "2026-08-27T09:07:00" },
  { IncidentID: "c", LinesAffected: "GR;", Description: "green", DateUpdated: "2026-08-27T09:07:00" },
]);
assert.deepEqual(alertsForLines(incidents, ["OR", "SV"]).map((a) => a.id), ["b"]);
assert.deepEqual(alertsForLines(incidents, ["RD"]).map((a) => a.id), [LIVE.IncidentID]);
assert.deepEqual(alertsForLines(incidents, []), [], "no watched lines matches nothing, never everything");
assert.deepEqual(alertsForLines(incidents, ["OR"]).map((a) => a.id), ["b"], "one watched line of several matches");
assert.deepEqual(alertsForLines(incidents, ["YL"]), []);

// "Still active" is presence in the feed - WMATA drops an incident once it
// clears - so age is reported, never staleness. The live record is 16 days old
// and genuinely still in force.
const at = (s) => Date.parse(s);
assert.equal(relativeAge("2026-08-27T09:13:00", at("2026-08-27T09:13:20")), "just now");
assert.equal(relativeAge("2026-08-27T09:07:00", at("2026-08-27T09:13:00")), "6 min ago");
assert.equal(relativeAge("2026-08-27T08:13:00", at("2026-08-27T09:13:00")), "1 hr ago");
assert.equal(relativeAge("2026-08-26T22:13:00", at("2026-08-27T09:13:00")), "11 hr ago");
assert.equal(relativeAge("2026-08-26T09:13:00", at("2026-08-27T09:13:00")), "1 day ago");
assert.equal(relativeAge("2026-08-11T12:36:17", at("2026-08-27T09:13:00")), "15 days ago");
// DateUpdated arrives with no zone, which is local time - the same clock the
// popover shows - so it must not be shifted.
assert.equal(relativeAge("2026-08-27T09:13:00", at("2026-08-27T09:13:00")), "just now");
// A clock ahead of the record must not print a negative age.
assert.equal(relativeAge("2026-08-27T09:20:00", at("2026-08-27T09:13:00")), "just now");
assert.equal(relativeAge(null, at("2026-08-27T09:13:00")), "", "an unusable stamp says nothing");
assert.equal(relativeAge("not a date", at("2026-08-27T09:13:00")), "");

console.log("ok alerts");
