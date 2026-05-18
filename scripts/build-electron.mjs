#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const bin = path.join(root, "node_modules", "electron-builder", "cli.js");
const args = process.argv.slice(2);
const requestedTargets = new Set(
  args
    .filter((arg) => arg === "--mac" || arg === "-m" || arg === "--win" || arg === "-w")
    .map((arg) => (arg === "--win" || arg === "-w" ? "win32" : "darwin")),
);

for (const target of requestedTargets) {
  if (target !== process.platform && process.env.ANYBOT_ALLOW_CROSS_PACKAGE !== "1") {
    console.error(
      [
        `Refusing to cross-package ${target} from ${process.platform}.`,
        "AnyBot includes native Node dependencies and a bundled Node runtime, so cross-packaged installers can build but fail at startup.",
        "Build Windows installers on Windows, macOS installers on macOS, or set ANYBOT_ALLOW_CROSS_PACKAGE=1 if you only need an unsupported packaging experiment.",
      ].join("\n"),
    );
    process.exit(1);
  }
}

if (!args.some((arg) => arg === "--publish" || arg.startsWith("--publish="))) {
  args.push("--publish", "never");
}

const result = spawnSync(process.execPath, [bin, ...args], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    ELECTRON_BUILDER_CACHE:
      process.env.ELECTRON_BUILDER_CACHE || path.join(root, ".electron-builder-cache"),
  },
});

if (result.error) {
  console.error(result.error);
}

process.exit(result.status ?? 1);
