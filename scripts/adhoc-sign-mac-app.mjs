// Ad-hoc signs a packaged .app. An arm64 binary must carry *some* signature to launch at all, and repacking the
// bundle invalidates Electron's own, so every Mach-O gets re-signed inside-out
// before the bundle itself.
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const appPath = process.argv[2];
if (!appPath) {
  console.error("Usage: node scripts/adhoc-sign-mac-app.mjs <app-path>");
  process.exit(1);
}

if (process.platform !== "darwin") {
  console.log("Skipping ad-hoc signing because this host is not macOS.");
  process.exit(0);
}

if (!existsSync(appPath)) {
  console.error(`Cannot sign missing app bundle: ${appPath}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}

// Deepest first: a nested framework must be signed before the bundle that seals it.
const candidates = filesUnder(appPath).sort(
  (left, right) => right.split("/").length - left.split("/").length,
);

for (const candidate of candidates) {
  const fileType = spawnSync("file", ["-b", candidate], { encoding: "utf8" });
  if (fileType.status !== 0) process.exit(fileType.status ?? 1);
  if (fileType.stdout.includes("Mach-O")) run("codesign", ["--force", "--sign", "-", candidate]);
}

run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
