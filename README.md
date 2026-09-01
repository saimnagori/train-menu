# Train Menu

Next train home, in the macOS menu bar. Pick a boarding station and a destination;
the menu bar shows the wait for the next train that actually stops where you are
going.

```
OR · 4m
```

Click and the popover is the departure list: one row per train leaving your
platform in the next 30 minutes, soonest first, live and scheduled in one column
of minutes, with rail incidents for your lines underneath.

**The walk shadow.** Set how many minutes you are from the platform and the app
answers "do I need to move" instead of "what is the next train". Trains inside
the shadow are flagged as missed, never dropped - whether you sprint is your
call - and the menu bar switches to the wait for the first train you can actually
catch. `0` (default) turns the whole thing off.

**Past the live window.** The prediction feed names about three trains per
platform group, so with a walk set the board could go quiet with nothing to say.
WMATA's GTFS *static* timetable fills that stretch: scheduled rows carry a tilde
on the minute (`~14m`) and a lighter ink, and are mine-only. Same list, same
order, no second table.

The popover also tunes menu bar style, brightness, text size (12-16px) and
background opacity.

## Setup

Needs a free [WMATA developer key](https://developer.wmata.com/). Launch, click
the tray icon, pick your stations and paste the key.

```sh
pnpm install
pnpm dev             # run from source
pnpm test            # node's assert, no framework
pnpm dist:mac        # ad-hoc signed .app + .dmg in release/
pnpm stations        # regenerate the bundled station list (needs a key)
```

## Why not just "filter by line"

A prediction gives a train's *terminus*, not whether it stops at your
destination - Rosslyn sends OR/BL/SV toward DC, and SV alternates between Largo
and New Carrollton. `serves()` answers it from the timetable: your destination is
ahead of you on this train iff riding **via** it costs no more than riding
straight to the terminus, within two minutes of slack. Rosslyn to Clarendon on a
New Carrollton train is 5 + 40 against 35 straight through, so it is rejected;
the Vienna train is 5 + 17 against 22, so it is kept. Going back for a station
costs twice the backtrack, and a wrong branch or a transfer costs more still -
across 36 live pairs the true cases all came out at 0 and the nearest false one
at 6. RailTime is timetable geometry, so pairs are cached permanently.

Not `jPath`, which despite the name is not a path. For Rosslyn -> New Carrollton
it returns all 26 Orange stations - the Virginia branch *behind* Rosslyn included
- numbered straight through, so a `SeqNum` comparison put Clarendon after Rosslyn
on an eastbound train and marked it as one to catch. It under-reports too: Court
House -> New Carrollton omits Rosslyn and the whole DC trunk the train runs
through. All it is read for now is "these two are on one line", which is how an
unsupported transfer trip is still detected.

Same-line trips only; a trip needing a transfer is reported as unsupported.

## How it works

```
tray icon ──> app.js ──(execFile, every 30s)──> departures/index.js ──> api.wmata.com
   │             │                                            │
   │             │  <────────────── stdout ───────────────────┘
   │             │
   └── popover.html <──(IPC "state")── snapshot()
```

`src/main/app.js` is the Electron main process - tray, popover, config, refresh
timer. It knows nothing about trains. `src/departures/index.js` is a standalone
Node script that talks to WMATA and prints the board:

```sh
WMATA_API_KEY=... node src/departures/index.js Rosslyn "New Carrollton"
WMATA_API_KEY=... node src/departures/index.js --alerts OR,SV   # incidents, 5m timer
WMATA_API_KEY=... node src/departures/index.js --schedule Rosslyn "New Carrollton"
```

The two halves are joined only by that stdout format - the **script contract** in
`src/shared/parse.js`: one versioned JSON object, `title` for the menu bar,
`platform` for the popover, one row per revenue train flagged `mine` when it
serves the trip and `source` `live` or `sched`. Every field is coerced on the way
in. Point
`TRAIN_MENU_SCRIPT` at your own script (dev builds only) and this becomes a menu
bar for any agency.

Design notes worth knowing:

- Spawned per refresh, not resident: `SIGKILL` at 15s, so a hung call cannot
  wedge the UI and a crash costs one tick. Stations go in argv, the key in env
  (argv is visible to local `ps`).
- A failed refresh keeps the last departures and marks them stale (`4m?`) instead
  of blanking. Refresh has six triggers, so each run carries a generation token
  and a superseded run drops its result.
- 30s / 5m intervals are fixed: 30s is above the 15s timeout, so the timer can
  never overlap two fetches. The popover's refresh button fetches now.
- `--schedule` is a third invocation on a 12 hour timer, fully off the departure
  path: it downloads the 3.65 MB GTFS zip (`If-Modified-Since`, so most runs are
  a 304), extracts four members with `/usr/bin/unzip`, and leaves a cache file
  the next departure refresh reads. Every failure there is silent and the board
  is exactly what it was without the feature.

### Files

| Path | |
|---|---|
| `src/main/app.js` | tray, popover, scheduler, IPC |
| `src/main/config.js`, `bounds.js` | config + input clamping, popover placement |
| `src/departures/index.js` | WMATA client - predictions, incidents, GTFS download |
| `src/shared/parse.js` | the script contract |
| `src/shared/board.js` | which departures the list draws, in what order |
| `src/shared/alerts.js` | incident parsing, line filter, relative age |
| `src/shared/walk.js`, `gtfs.js` | walk shadow, static timetable past the live window |
| `src/shared/stations.js`, `stations.json` | name matching, bundled list (works with no key) |
| `src/renderer/popover.html` | the popover, one file |
| `src/preload/index.cjs` | the IPC surface exposed to the renderer |

State on disk, under `~/Library/Application Support/train-menu/`:

- `config.json` - stations, walk minutes, menu bar style, brightness, text size,
  opacity, API key. `0600`, written atomically.
- `train-menu-wmata.json` - cached station list (30-day TTL), path sequences,
  ride times.
- `train-menu-schedule.json` + `train-menu-gtfs.zip` - the extracted timetable
  for the current trip, and the feed it came from. Own file on purpose: the
  schedule run and a departure refresh are separate processes.

All three caches are safe to delete; they refill.

## Limits

- macOS only, arm64, ad-hoc signed (no notarization - expect a Gatekeeper prompt).
- WMATA rail only. Same-line trips only, no transfers.
- The prediction feed returns ~3 trains per platform group. Past those the board
  is the *published* timetable, not realtime - a scheduled row can be wrong by
  whatever the service is doing. GTFS-realtime would close the gap.
- A walk longer than every train the feed names turns the shadow off for that
  refresh: the board falls back to reporting the next train.
