#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function copyDir(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

copyDir(
  path.join(root, "src", "web", "public"),
  path.join(root, "dist", "web", "public"),
);

copyDir(
  path.join(root, "src", "agent", "md_files"),
  path.join(root, "dist", "agent", "md_files"),
);
