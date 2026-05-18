#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const bin = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-builder.cmd" : "electron-builder",
);
const args = process.argv.slice(2);

if (!args.some((arg) => arg === "--publish" || arg.startsWith("--publish="))) {
  args.push("--publish", "never");
}

const result = spawnSync(bin, args, {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    ELECTRON_BUILDER_CACHE:
      process.env.ELECTRON_BUILDER_CACHE || path.join(root, ".electron-builder-cache"),
  },
});

process.exit(result.status ?? 1);
