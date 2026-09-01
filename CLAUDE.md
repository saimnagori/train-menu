# Train Menu

macOS menu bar app for the next WMATA train home. Electron. See README.md for
architecture and the script contract.

## Workflow

- **UI changes: mock first.** Standalone HTML mock in `mocks/`, show it, get
  sign-off, then touch `src/renderer/`.
- **Verify the popover in Chrome, not by inspection.** Serve it and open it:
  `python3 -m http.server 8080` (or `npx serve`) from repo root, then
  `http://localhost:8080/src/renderer/popover.html` (or the mock). Screenshot it.
- **Ground backend/poll decisions in real WMATA data.** Before changing polling,
  filtering, or parsing, fetch live output first and reason from it, never from
  assumed shape:
  ```sh
  WMATA_API_KEY=... node src/departures/index.js Rosslyn "New Carrollton"
  WMATA_API_KEY=... node src/departures/index.js --alerts OR,SV
  ```
  Key lives in `~/Library/Application Support/train-menu/config.json`.
- **Run the real app** with `pnpm dev` before reporting done.
- **`pnpm dist:mac`** to regenerate binaries (`release/`).
- `pnpm test` - node assert, no framework. Keep it green.
