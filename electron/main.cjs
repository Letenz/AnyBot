const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

let mainWindow = null;
let backendProcess = null;
let logStream = null;
let logFilePath = null;

const DEFAULT_WEB_PORT = 19981;

function getAppRoot() {
  return path.resolve(__dirname, "..");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function initLog() {
  const runDir = path.join(app.getPath("userData"), ".run");
  ensureDir(runDir);

  const logFile = path.join(runDir, "desktop.log");
  logFilePath = logFile;
  logStream = fs.createWriteStream(logFile, { flags: "a" });
  writeLog("main", `AnyBot desktop starting (${process.platform} ${process.arch})`);
}

function writeLog(tag, message) {
  const line = `[${new Date().toISOString()}] [${tag}] ${message}`;
  if (logStream) {
    logStream.write(`${line}\n`);
  }
  console.log(line);
}

function copyIfMissing(source, target) {
  if (!fs.existsSync(source) || fs.existsSync(target)) {
    return;
  }

  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
}

function prepareUserData() {
  const userData = app.getPath("userData");
  const appRoot = getAppRoot();

  ensureDir(userData);
  ensureDir(path.join(userData, ".data"));
  ensureDir(path.join(userData, ".run"));
  ensureDir(path.join(userData, "tmp", "uploads"));

  copyIfMissing(path.join(appRoot, ".env.example"), path.join(userData, ".env"));

  const mdSource = path.join(appRoot, "dist", "agent", "md_files");
  for (const file of ["AGENTS.md", "MEMORY.md", "PROFILE.md", "BOOTSTRAP.md"]) {
    copyIfMissing(path.join(mdSource, file), path.join(userData, file));
  }
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const result = {};
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function resolveWebPort() {
  const envFile = parseEnvFile(path.join(app.getPath("userData"), ".env"));
  const raw = process.env.WEB_PORT || envFile.WEB_PORT || String(DEFAULT_WEB_PORT);
  const port = Number.parseInt(raw, 10);
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_WEB_PORT;
}

function buildPathEnv(existingPath) {
  const entries = [];

  if (process.platform === "darwin") {
    entries.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin");
  } else if (process.platform === "win32") {
    entries.push(
      path.join(os.homedir(), "AppData", "Roaming", "npm"),
      path.join(os.homedir(), "AppData", "Local", "Programs", "nodejs"),
      "C:\\Program Files\\nodejs",
      "C:\\Program Files (x86)\\nodejs",
    );
  }

  if (existingPath) {
    entries.push(...existingPath.split(path.delimiter));
  }

  return [...new Set(entries.filter(Boolean))].join(path.delimiter);
}

function waitForServer(port, timeoutMs = 15000, getAbortMessage = () => null) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const check = () => {
      const abortMessage = getAbortMessage();
      if (abortMessage) {
        reject(new Error(abortMessage));
        return;
      }

      const req = http.get(`http://127.0.0.1:${port}`, (res) => {
        res.resume();
        resolve();
      });

      req.on("error", (error) => {
        if (Date.now() >= deadline) {
          reject(error);
          return;
        }
        setTimeout(check, 300);
      });

      req.setTimeout(1000, () => {
        req.destroy(new Error("Timed out waiting for AnyBot server"));
      });
    };

    check();
  });
}

function resolveNodeRuntime() {
  const bundledName = process.platform === "win32" ? "node.exe" : "node";
  const bundledNode = path.join(process.resourcesPath, "node", bundledName);

  if (app.isPackaged && fs.existsSync(bundledNode)) {
    return {
      execPath: bundledNode,
      runAsElectronNode: false,
    };
  }

  const devNode = process.env.ANYBOT_NODE_BIN || process.env.npm_node_execpath;
  if (devNode) {
    return {
      execPath: devNode,
      runAsElectronNode: false,
    };
  }

  return {
    execPath: process.execPath,
    runAsElectronNode: true,
  };
}

async function startBackend() {
  const appRoot = getAppRoot();
  const userData = app.getPath("userData");
  const dataDir = path.join(userData, ".data");
  const runDir = path.join(userData, ".run");
  const tmpDir = path.join(userData, "tmp");
  const entry = path.join(appRoot, "dist", "index.js");

  if (!fs.existsSync(entry)) {
    throw new Error(`Missing backend entry: ${entry}`);
  }

  const nodeRuntime = resolveNodeRuntime();
  let backendExitMessage = null;
  const backendEnv = {
    ...process.env,
    ANYBOT_DESKTOP: "1",
    ANYBOT_DESKTOP_PARENT_PID: String(process.pid),
    DATA_DIR: dataDir,
    CODEX_DATA_DIR: dataDir,
    LOG_DIR: runDir,
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    PATH: buildPathEnv(process.env.PATH),
  };

  if (nodeRuntime.runAsElectronNode) {
    backendEnv.ELECTRON_RUN_AS_NODE = "1";
  }

  backendProcess = spawn(nodeRuntime.execPath, [entry], {
    cwd: userData,
    env: backendEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  backendProcess.on("error", (error) => {
    backendExitMessage = `Backend failed to launch: ${error.message}`;
    writeLog("backend:error", error.stack || error.message);
  });
  backendProcess.stdout.on("data", (data) => writeLog("backend", data.toString().trim()));
  backendProcess.stderr.on("data", (data) => writeLog("backend:error", data.toString().trim()));
  backendProcess.on("exit", (code, signal) => {
    backendExitMessage = `Backend exited before the web server started (code=${code}, signal=${signal}).`;
    writeLog("backend", `exited code=${code} signal=${signal}`);
    backendProcess = null;
  });

  await waitForServer(resolveWebPort(), 15000, () => {
    if (!backendExitMessage) {
      return null;
    }

    return logFilePath
      ? `${backendExitMessage}\n\nLog file: ${logFilePath}`
      : backendExitMessage;
  });
}

function createMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const port = resolveWebPort();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: "AnyBot",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.once("ready-to-show", () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function stopBackend() {
  if (!backendProcess) {
    return;
  }

  backendProcess.kill("SIGTERM");
  backendProcess = null;
}

app.whenReady().then(async () => {
  try {
    initLog();
    prepareUserData();
    createMenu();
    await startBackend();
    createWindow();
  } catch (error) {
    writeLog("main:error", error.stack || error.message);
    dialog.showErrorBox("AnyBot failed to start", error.message || String(error));
    app.quit();
  }
});

app.on("window-all-closed", () => {
  stopBackend();
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && backendProcess) {
    createWindow();
  }
});

app.on("before-quit", () => {
  stopBackend();
});
