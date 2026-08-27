import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BRIGHTNESS, readConfig, writeConfig } from "../src/main/config.js";

const dir = await mkdtemp(join(tmpdir(), "train-menu-config-"));
const path = join(dir, "config.json");

const written = await writeConfig(path, { from: "Rosslyn", to: "Vienna", apiKey: "secret", refreshSec: 45 });
assert.deepEqual(written, { from: "Rosslyn", to: "Vienna", apiKey: "secret", refreshSec: 45, style: "dot", brightness: DEFAULT_BRIGHTNESS });
assert.deepEqual(await readConfig(path), written, "round-trips");

// The file holds an API key, so it must not be world-readable.
assert.equal((await stat(path)).mode & 0o777, 0o600);

// Overwriting an existing file keeps the tight mode and leaves no .tmp behind.
await writeConfig(path, { ...written, apiKey: "rotated" });
assert.equal((await stat(path)).mode & 0o777, 0o600);
assert.deepEqual(await readdir(dir), ["config.json"], "rename, not truncate-in-place");
assert.match(await readFile(path, "utf8"), /rotated/);

console.log("config ok");
