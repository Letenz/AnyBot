#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";

const colors = {
  red: "\x1b[0;31m",
  green: "\x1b[0;32m",
  yellow: "\x1b[1;33m",
  cyan: "\x1b[0;36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function info(message) {
  console.log(`${colors.cyan}>${colors.reset} ${message}`);
}

function ok(message) {
  console.log(`${colors.green}OK${colors.reset} ${message}`);
}

function warn(message) {
  console.log(`${colors.yellow}WARN${colors.reset} ${message}`);
}

function fail(message) {
  console.error(`${colors.red}ERR${colors.reset} ${message}`);
  process.exit(1);
}

async function ask(question, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = await rl.question(`${colors.bold}${question}${suffix}: ${colors.reset}`);
  return answer.trim() || defaultValue;
}

async function confirm(question, defaultYes = false) {
  const suffix = defaultYes ? " [Y/n]: " : " [y/N]: ";
  const answer = (await rl.question(`${question}${suffix}`)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

function commandExists(command) {
  const result = spawnSync(isWindows ? "where" : "command", isWindows ? [command] : ["-v", command], {
    encoding: "utf8",
    shell: !isWindows,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function commandVersion(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    shell: isWindows,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : "已安装";
}

function expandHome(input) {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function writeEnvFile(values) {
  const envFile = path.join(projectDir, ".env");
  const content = `# Provider
# 可选: codex, gemini-cli, cursor-cli, qoder-cli, claude-code
PROVIDER=${values.provider}

# Codex CLI
CODEX_BIN=codex
CODEX_MODEL=
CODEX_SANDBOX=${values.codexSandbox}
CODEX_SYSTEM_PROMPT=
CODEX_WORKDIR=${values.workdir}

# Gemini CLI
GEMINI_CLI_BIN=gemini
GEMINI_CLI_MODEL=
GEMINI_CLI_APPROVAL_MODE=${values.geminiApprovalMode}

# Cursor CLI
CURSOR_CLI_BIN=agent
CURSOR_CLI_MODEL=
CURSOR_CLI_WORKSPACE=
CURSOR_API_KEY=

# Qoder CLI
QODER_CLI_BIN=qodercli
QODER_CLI_MAX_TURNS=

# Claude Code
CLAUDE_CODE_BIN=claude
# 可选：只在你想改用 API Key 认证时启用
# ANTHROPIC_API_KEY=
CLAUDE_AGENT_MODEL=
CLAUDE_AGENT_PERMISSION_MODE=
CLAUDE_AGENT_MAX_TURNS=

# Web
WEB_PORT=${values.webPort}

# 日志
LOG_LEVEL=info
LOG_INCLUDE_CONTENT=false
LOG_INCLUDE_PROMPT=false
`;

  fs.writeFileSync(envFile, content, "utf8");
  ok(`已生成 ${envFile}`);
}

function providerBin(provider) {
  switch (provider) {
    case "codex":
      return ["codex", "npm install -g @openai/codex"];
    case "gemini-cli":
      return ["gemini", "详见 https://github.com/google-gemini/gemini-cli"];
    case "cursor-cli":
      return ["agent", "详见 https://docs.cursor.com/cli"];
    case "qoder-cli":
      return ["qodercli", "详见 https://docs.qoder.com"];
    case "claude-code":
      return ["claude", "安装并登录 Claude Code CLI；或设置 CLAUDE_CODE_BIN 指向 claude 可执行文件"];
    default:
      return ["codex", "npm install -g @openai/codex"];
  }
}

async function main() {
  console.log("");
  console.log(`${colors.bold}AnyBot Setup Wizard${colors.reset}`);
  console.log("");

  const osName =
    process.platform === "darwin"
      ? "macOS"
      : process.platform === "win32"
        ? "Windows"
        : process.platform === "linux"
          ? "Linux"
          : process.platform;
  ok(`检测到操作系统: ${osName}`);

  info("正在检查基础依赖...");
  const missing = [];
  for (const command of ["node", "npm"]) {
    if (commandExists(command)) {
      ok(`${command} - ${commandVersion(command)}`);
    } else {
      warn(`${command} 未找到`);
      missing.push(command);
    }
  }

  if (missing.length > 0) {
    warn(`以下基础工具缺失: ${missing.join(", ")}`);
    if (isWindows) {
      info("Windows 推荐从 https://nodejs.org 下载并安装 Node.js LTS。");
    } else if (process.platform === "darwin") {
      info("macOS 可使用 Homebrew: brew install node");
    } else {
      info("Linux 可使用系统包管理器，或安装 nvm 后运行 nvm install --lts。");
    }
    if (!(await confirm("是否继续？缺失的工具需要后续手动安装"))) return;
  }

  console.log("");
  console.log(`${colors.bold}选择 Provider${colors.reset}`);
  console.log("  1) codex       - OpenAI Codex CLI");
  console.log("  2) gemini-cli  - Google Gemini CLI");
  console.log("  3) cursor-cli  - Cursor Agent CLI");
  console.log("  4) qoder-cli   - Qoder CLI");
  console.log("  5) claude-code - Claude Code");
  const providerChoice = await ask("请选择默认 Provider", "1");
  const provider = {
    "2": "gemini-cli",
    "3": "cursor-cli",
    "4": "qoder-cli",
    "5": "claude-code",
  }[providerChoice] || "codex";
  ok(`默认 Provider: ${provider}`);

  const [bin, installHint] = providerBin(provider);
  if (commandExists(bin)) {
    ok(`${bin} - ${commandVersion(bin)}`);
  } else {
    warn(`${bin} 未找到`);
    info(`安装提示: ${installHint}`);
    if (!(await confirm("是否继续？CLI 需要后续手动安装"))) return;
  }

  console.log("");
  console.log(`${colors.bold}工作区配置${colors.reset}`);
  info("工作区是 AI CLI 执行命令时的工作目录。");
  let workdir = expandHome(await ask("请输入工作目录", os.homedir()));
  workdir = path.resolve(workdir);
  if (!fs.existsSync(workdir)) {
    warn(`目录 ${workdir} 不存在`);
    if (await confirm("是否创建？")) {
      fs.mkdirSync(workdir, { recursive: true });
      ok(`已创建 ${workdir}`);
    } else {
      fail("工作目录不存在，已取消");
    }
  }
  ok(`工作目录: ${workdir}`);

  const mdSrc = path.join(projectDir, "src", "agent", "md_files");
  const copied = [];
  for (const file of ["AGENTS.md", "MEMORY.md", "PROFILE.md", "BOOTSTRAP.md"]) {
    const target = path.join(workdir, file);
    if (fs.existsSync(target)) {
      info(`${file} 已存在于工作目录，跳过`);
    } else {
      fs.copyFileSync(path.join(mdSrc, file), target);
      copied.push(file);
    }
  }
  if (copied.length > 0) ok(`已复制默认配置文件到工作目录: ${copied.join(", ")}`);

  let codexSandbox = "read-only";
  let geminiApprovalMode = "yolo";
  if (provider === "codex") {
    console.log("");
    console.log(`${colors.bold}安全模式${colors.reset}`);
    console.log("  1) read-only          - 只读（默认）");
    console.log("  2) workspace-write    - 可写工作目录");
    console.log("  3) danger-full-access - 完全访问（危险）");
    const choice = await ask("请选择", "1");
    codexSandbox = choice === "2" ? "workspace-write" : choice === "3" ? "danger-full-access" : "read-only";
    ok(`安全模式: ${codexSandbox}`);
  } else if (provider === "gemini-cli") {
    console.log("");
    console.log(`${colors.bold}Approval Mode${colors.reset}`);
    console.log("  1) yolo       - 自动批准所有操作（默认）");
    console.log("  2) auto-edit  - 自动批准文件编辑，其他需确认");
    console.log("  3) confirm    - 操作前确认");
    const choice = await ask("请选择", "1");
    geminiApprovalMode = choice === "2" ? "auto-edit" : choice === "3" ? "confirm" : "yolo";
    ok(`Approval Mode: ${geminiApprovalMode}`);
  }

  const webPort = await ask("Web UI 端口", "19981");
  const envFile = path.join(projectDir, ".env");
  if (fs.existsSync(envFile)) {
    warn("检测到已有 .env 文件");
    if (await confirm("是否覆盖？")) {
      writeEnvFile({ provider, workdir, codexSandbox, geminiApprovalMode, webPort });
    } else {
      ok("保留现有 .env，跳过写入");
    }
  } else {
    writeEnvFile({ provider, workdir, codexSandbox, geminiApprovalMode, webPort });
  }

  console.log("");
  console.log(`${colors.bold}安装依赖${colors.reset}`);
  if (fs.existsSync(path.join(projectDir, "node_modules"))) {
    info("node_modules 已存在，跳过安装（如需重装请删除 node_modules 后重新运行）");
  } else {
    info("正在安装 npm 依赖...");
    const result = spawnSync("npm", ["install"], {
      cwd: projectDir,
      stdio: "inherit",
      shell: isWindows,
    });
    if (result.status !== 0) fail("npm install 失败");
    ok("依赖安装完成");
  }

  console.log("");
  console.log(`${colors.bold}配置完成${colors.reset}`);
  info(`当前 Provider: ${provider}`);
  info("启动方式:");
  console.log("  前台运行:  npm start");
  console.log("  后台运行:  npm run bot:start");
  console.log("  查看状态:  npm run bot:status");
  console.log("  停止运行:  npm run bot:stop");
  info(`Web UI 地址: http://localhost:${webPort}`);
}

try {
  await main();
} finally {
  rl.close();
}
