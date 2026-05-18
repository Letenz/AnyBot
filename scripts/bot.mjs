#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, "..");
const runDir = path.join(projectDir, ".run");
const tmpDir = path.join(runDir, "tmp");
const pidFile = path.join(runDir, "bot.pid");
const logFile = path.join(runDir, "bot.runner.log");
const isWindows = process.platform === "win32";

function readPid() {
  try {
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removePidFile() {
  try {
    fs.rmSync(pidFile, { force: true });
  } catch {}
}

function killTree(pid, force = false) {
  if (isWindows) {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    spawnSync("taskkill", args, { stdio: "ignore" });
    return;
  }

  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch {}
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function start() {
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const existingPid = readPid();
  if (existingPid && isRunning(existingPid)) {
    console.log(`机器人已在运行（pid ${existingPid}）`);
    return;
  }
  removePidFile();

  const tsxPackage = path.join(projectDir, "node_modules", "tsx", "package.json");
  if (!fs.existsSync(tsxPackage)) {
    console.error("未找到 tsx，请先运行 npm install");
    process.exitCode = 1;
    return;
  }

  const out = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: projectDir,
    env: {
      ...process.env,
      TMPDIR: tmpDir,
      TMP: tmpDir,
      TEMP: tmpDir,
    },
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });

  child.unref();
  fs.writeFileSync(pidFile, String(child.pid), "utf8");
  await delay(500);
  if (!isRunning(child.pid)) {
    removePidFile();
    console.error(`机器人启动失败，详情见日志：${logFile}`);
    process.exitCode = 1;
    return;
  }
  console.log(`机器人已启动（pid ${child.pid}）`);
  console.log(`日志目录：${runDir}`);
}

async function stop() {
  const pid = readPid();
  if (!pid) {
    console.log("机器人未运行");
    return;
  }

  if (isRunning(pid)) {
    killTree(pid, false);
    await delay(1000);
    if (isRunning(pid)) {
      killTree(pid, true);
    }
    console.log(`机器人已停止（pid ${pid}）`);
  } else {
    console.log("未找到机器人进程，正在清理过期的 pid 文件");
  }

  removePidFile();
}

function status() {
  const pid = readPid();
  if (!pid) {
    console.log("机器人未运行");
    return;
  }

  if (isRunning(pid)) {
    console.log(`机器人运行中（pid ${pid}）`);
  } else {
    console.log("机器人未运行，但存在过期的 pid 文件");
    process.exitCode = 1;
  }
}

const command = process.argv[2];
if (command === "start") {
  await start();
} else if (command === "stop") {
  await stop();
} else if (command === "status") {
  status();
} else {
  console.error("用法：node scripts/bot.mjs <start|stop|status>");
  process.exitCode = 1;
}
