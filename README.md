# Train Menu

Next train home, in the macOS menu bar. Pick a boarding station and a destination,
and the menu bar shows the wait for the next train that actually stops where you
are going.

```
OR · 4m
```

Click for a popover with the following departures, one row per line + destination
with the next two waits.

## Why it is not just "filter by line"

A WMATA prediction tells you a train's *terminus*, not whether it stops at your
destination. Rosslyn sends Orange, Blue and Silver toward DC; Silver alternates
between Largo and New Carrollton. Filtering on line puts you on the wrong train.

`serves()` resolves it with the `jPath` endpoint: fetch the station sequence for
`origin -> terminus`, keep the train only if your destination appears *later* in
that sequence than where you are standing. Track geometry never changes, so paths
are cached permanently.

Same-line trips only. A trip needing a transfer is reported as unsupported rather
than shown as an empty board forever.

## How it works

```
tray icon ──> app.js ──(execFile, every 30s)──> departures/index.js ──> api.wmata.com
   │             │                                            │
   │             │  <────────────── stdout ───────────────────┘
   │             │
   └── popover.html <──(IPC "state")── snapshot()
```

`src/main/app.js` is the Electron main process: tray, popover window, config, and
a timer that shells out for fresh departures. It knows nothing about trains.

`src/departures/index.js` is a standalone Node script that talks to WMATA and
prints the board. Run it on its own:

```sh
WMATA_API_KEY=... node src/departures/index.js Rosslyn "New Carrollton"
```
```json
{
  "v": 1,
  "title": { "line": "OR", "mins": "4m" },
  "fetchedAt": 1787855160006,
  "arriveAt": 1787857500006,
  "lines": ["OR", "SV"],
  "platform": [
    { "wait": "4m", "eta": 4, "line": "OR", "group": "1", "terminus": "New Carrollton", "mine": true },
    { "wait": "6m", "eta": 6, "line": "BL", "group": "1", "terminus": "Downtown Largo", "mine": false }
  ]
}
```

The two halves are joined only by that stdout format - the **script contract** in
`src/shared/parse.js`: one versioned JSON object, `title` for the menu bar and
`platform` for the popover, one row per revenue train at the station flagged
`mine` when it actually serves the trip. Every field is coerced on the way in.
Point `TRAIN_MENU_SCRIPT` at your own script (dev builds only) and this becomes a
menu bar for any transit agency, or anything else that prints a wait and a label.

Rail incidents are a second, separate invocation on a 5 minute timer, filtered to
the lines the last payload said carry the trip. A failure there can neither break
nor delay a departure refresh:

```sh
WMATA_API_KEY=... node src/departures/index.js --alerts OR,SV
```

The script is spawned per refresh rather than kept resident: a hung network call
is killed by `SIGKILL` at 15s and cannot wedge the UI, and a crash costs one tick.
Stations go in argv; the API key goes in the env, because argv is visible to any
local `ps`.

### State

Every refresh publishes a snapshot to the popover. A failure keeps the last known
departures visible and marks them stale (`4m?`) rather than blanking the menu bar
on a transient blip. Refresh is reachable from six places (timer, tray click,
manual refresh, config save, wake-from-sleep, startup), so each run carries a
generation token - a superseded run drops its result instead of overwriting fresh
data.

### Files

| Path | |
|---|---|
| `src/main/app.js` | tray, popover, scheduler, IPC |
| `src/main/config.js` | config read/write, input clamping |
| `src/main/bounds.js` | popover placement under the tray icon |
| `src/departures/index.js` | WMATA client, predictions and incidents |
| `src/shared/parse.js` | the script contract |
| `src/shared/board.js` | which departures the list draws, and in what order |
| `src/shared/alerts.js` | incident parsing, line filter, relative age |
| `src/shared/stations.js` | station name/code matching |
| `src/shared/stations.json` | bundled station list, so setup works with no key |
| `src/renderer/popover.html` | the popover, one file |
| `src/preload/index.cjs` | the IPC surface exposed to the renderer |

Two files on disk, both under `~/Library/Application Support/train-menu/`:

- `config.json` - stations, menu bar style, API key. Written `0600`, atomically.
- `train-menu-wmata.json` - cached station list (30-day TTL), path sequences
  and station-pair ride times. Safe to delete; it refills.

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

Departures refresh every 30s, incidents every 5 minutes. Neither is configurable:
30s is comfortably above the 15s script timeout, so the timer alone can never
overlap two fetches, and a shorter interval would only spend API calls on a feed
that updates about that often anyway. The popover's refresh button fetches now.

## Limits

- macOS only, arm64, ad-hoc signed (no notarization - expect a Gatekeeper prompt).
- WMATA rail only.
- Same-line trips only, no transfers.
- The prediction feed returns ~3 trains per platform group, so a second wait for
  your route often is not there. A longer horizon needs the GTFS-realtime feed.
