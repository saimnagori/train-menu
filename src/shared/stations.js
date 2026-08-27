// The station list is bundled with the app so the setup form can offer a picker
// before the user has an API key. It changes maybe once a decade, so a stale
// bundled copy is a far better failure than an empty form.
//
// Canonical shape, used by both the picker and the departures script:
//   { name, codes: ["C05"], lines: ["OR", "SV", "BL"] }
//
// `codes` is plural because a transfer station has one code per platform (Metro
// Center is A01 *and* C01) and predictions live under each separately.
import { readFile } from "node:fs/promises";

const BUNDLED = new URL("./stations.json", import.meta.url);

// WMATA returns one row per platform, so the same station name appears more than
// once. The picker wants names, so fold the platforms back together.
export function normalizeStations(rows) {
  const byName = new Map();
  for (const row of rows) {
    const entry = byName.get(row.Name) ?? { name: row.Name, codes: [], lines: [] };
    for (const code of [row.Code, row.StationTogether1, row.StationTogether2]) {
      if (code && !entry.codes.includes(code)) entry.codes.push(code);
    }
    for (const line of [row.LineCode1, row.LineCode2, row.LineCode3, row.LineCode4]) {
      if (line && !entry.lines.includes(line)) entry.lines.push(line);
    }
    byName.set(row.Name, entry);
  }
  return [...byName.values()]
    .map((e) => ({ ...e, codes: e.codes.sort(), lines: e.lines.sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function bundledStations() {
  return JSON.parse(await readFile(BUNDLED, "utf8"));
}

/**
 * The list to show and resolve against: a refreshed copy from the cache if the
 * user has supplied a key, otherwise the bundled one.
 */
export async function listStations(cache) {
  if (cache?.stations?.stations?.length) return cache.stations;
  return bundledStations();
}

const norm = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Vowel-dropping abbreviation, e.g. "NewCrlton" -> "New Carrollton".
const isSubsequence = (needle, haystack) => {
  let i = 0;
  for (const ch of haystack) if (ch === needle[i]) i++;
  return i === needle.length;
};

/**
 * Resolve a name WMATA gave us to a station. Half of all live predictions carry a
 * null DestinationCode, and their DestinationName degrades to an abbreviation
 * ("NewCrlton", "Frndshp H", "Shady Grv"), so an exact lookup is not enough.
 *
 * Tiers, most trustworthy first. Anchoring on the first letter matters: plain
 * subsequence matching makes "Vienna" ambiguous with
 * "Archives-Navy Memorial-Penn Quarter". Returns null when nothing is unique -
 * never a guess.
 */
export function matchStation(list, name) {
  const q = norm(name);
  if (!q) return null;
  const tiers = [
    (s) => norm(s.name) === q,
    (s) => norm(s.name)[0] === q[0] && isSubsequence(q, norm(s.name)),
    (s) => isSubsequence(q, norm(s.name)),
  ];
  for (const test of tiers) {
    const hits = list.stations.filter(test);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null; // ambiguous is not a match
  }
  return null;
}

export function resolveCodes(list, query) {
  const q = query.trim().toLowerCase();
  const hit =
    list.stations.find((s) => s.name.toLowerCase() === q) ??
    list.stations.find((s) => s.codes.some((c) => c.toLowerCase() === q));
  if (!hit) {
    const near = list.stations.filter((s) => s.name.toLowerCase().includes(q)).map((s) => s.name);
    throw new Error(`Unknown station "${query.trim()}"` + (near.length ? `; did you mean: ${near.join(", ")}` : ""));
  }
  return hit.codes;
}
