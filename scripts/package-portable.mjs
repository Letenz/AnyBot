#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const platform = process.platform;
const arch = process.arch;

const platformName =
  platform === "win32" ? "win" :
  platform === "darwin" ? "mac" :
  platform;

const packageName = `AnyBot-${platformName}-${arch}`;
const packagingDir = path.join(root, ".packaging");
const releaseDir = path.join(packagingDir, packageName);

function copy(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function copyFileIfExists(source, target) {
  if (fs.existsSync(source)) copy(source, target);
}

function writeFile(target, content, mode) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  if (mode !== undefined) fs.chmodSync(target, mode);
}

function ensureBuilt() {
  const required = [
    path.join(root, "dist", "index.js"),
    path.join(root, "dist", "web", "public", "index.html"),
    path.join(root, "node_modules"),
  ];

  for (const item of required) {
    if (!fs.existsSync(item)) {
      throw new Error(`Missing release input: ${item}`);
    }
  }
}

function copyNodeRuntime() {
  const nodeDir = path.join(releaseDir, "node");
  fs.mkdirSync(nodeDir, { recursive: true });

  if (platform === "win32") {
    copy(process.execPath, path.join(nodeDir, "node.exe"));
  } else {
    const target = path.join(nodeDir, "node");
    copy(process.execPath, target);
    fs.chmodSync(target, 0o755);
  }
}

function writeWindowsLaunchers() {
  writeFile(path.join(releaseDir, "start-anybot.cmd"), `@echo off
setlocal
cd /d "%~dp0"

if not exist ".env" copy ".env.example" ".env" >nul
if not exist ".data" mkdir ".data"
if not exist ".run" mkdir ".run"

if exist "resources\\md_files" (
  for %%F in (AGENTS.md MEMORY.md PROFILE.md BOOTSTRAP.md) do (
    if not exist "%%F" copy "resources\\md_files\\%%F" "%%F" >nul
  )
)

echo AnyBot Web UI: http://localhost:19981
echo.
"%~dp0node\\node.exe" "%~dp0dist\\index.js"
pause
`, 0o755);

  writeFile(path.join(releaseDir, "start-anybot.ps1"), `$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
}

New-Item -ItemType Directory -Force -Path ".data", ".run" | Out-Null

if (Test-Path "resources\\md_files") {
  foreach ($file in "AGENTS.md", "MEMORY.md", "PROFILE.md", "BOOTSTRAP.md") {
    if (-not (Test-Path $file)) {
      Copy-Item (Join-Path "resources\\md_files" $file) $file
    }
  }
}

Write-Host "AnyBot Web UI: http://localhost:19981"
& "$PSScriptRoot\\node\\node.exe" "$PSScriptRoot\\dist\\index.js"
`, 0o755);
}

function writeMacLaunchers() {
  writeFile(path.join(releaseDir, "start-anybot.command"), `#!/bin/sh
set -eu
DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ ! -f ".env" ]; then
  cp ".env.example" ".env"
fi

mkdir -p ".data" ".run"

if [ -d "resources/md_files" ]; then
  for f in AGENTS.md MEMORY.md PROFILE.md BOOTSTRAP.md; do
    if [ ! -f "$f" ]; then
      cp "resources/md_files/$f" "$f"
    fi
  done
fi

echo "AnyBot Web UI: http://localhost:19981"
exec "$DIR/node/node" "$DIR/dist/index.js"
`, 0o755);

  writeFile(path.join(releaseDir, "start-anybot.sh"), `#!/bin/sh
exec "$(dirname "$0")/start-anybot.command"
`, 0o755);
}

function writeReadme() {
  const providerNote = [
    "Provider CLIs such as codex/gemini/claude/cursor/qoder are not bundled.",
    "Install and login to the Provider CLI you want to use, then make sure it is available in PATH.",
  ].join("\n");

  const startCommand = platform === "win32"
    ? "Double-click start-anybot.cmd"
    : "Double-click start-anybot.command";

  writeFile(path.join(releaseDir, "README-PACKAGE.txt"), `AnyBot Portable Package

Start:
  ${startCommand}
  Open http://localhost:19981

Configure:
  Edit .env in this folder.
  Runtime data is stored in .data and logs are stored in .run.

${providerNote}

Platform:
  ${platform} ${arch}
Node:
  ${process.version}
Host:
  ${os.platform()} ${os.arch()}
`);
}

ensureBuilt();

fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });

copy(path.join(root, "dist"), path.join(releaseDir, "dist"));
copy(path.join(root, "node_modules"), path.join(releaseDir, "node_modules"));
copy(path.join(root, "package.json"), path.join(releaseDir, "package.json"));
copy(path.join(root, "package-lock.json"), path.join(releaseDir, "package-lock.json"));
copyFileIfExists(path.join(root, ".env.example"), path.join(releaseDir, ".env.example"));
copyFileIfExists(path.join(root, "README.md"), path.join(releaseDir, "README.md"));
copyFileIfExists(path.join(root, "README_EN.md"), path.join(releaseDir, "README_EN.md"));

copyNodeRuntime();
copy(path.join(root, "dist", "agent", "md_files"), path.join(releaseDir, "resources", "md_files"));

if (platform === "win32") {
  writeWindowsLaunchers();
} else if (platform === "darwin") {
  writeMacLaunchers();
} else {
  writeMacLaunchers();
}

writeReadme();

console.log(releaseDir);
