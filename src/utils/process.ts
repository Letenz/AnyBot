import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

const isWindows = process.platform === "win32";

function isPathLike(command: string): boolean {
  return path.isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function executableCandidates(command: string): string[] {
  if (!isWindows || path.extname(command)) return [command];

  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  return [command, ...extensions.map((ext) => `${command}${ext}`)];
}

function canRun(filePath: string): boolean {
  try {
    accessSync(filePath, isWindows ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveExecutable(command: string): string | null {
  if (isPathLike(command)) {
    for (const candidate of executableCandidates(command)) {
      if (canRun(candidate)) return candidate;
    }
    return null;
  }

  const pathDirs = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);

  for (const dir of pathDirs) {
    for (const candidate of executableCandidates(path.join(dir, command))) {
      if (canRun(candidate)) return candidate;
    }
  }

  return null;
}

export function spawnCommand(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
  const resolvedCommand = isWindows ? resolveExecutable(command) || command : command;
  const extension = path.extname(resolvedCommand).toLowerCase();
  const needsShell = isWindows && (extension === ".cmd" || extension === ".bat");

  return spawn(resolvedCommand, args, {
    ...options,
    shell: needsShell,
    detached: isWindows ? false : options.detached,
  });
}

export function runCommandSync(
  command: string,
  args: string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding" | "shell"> = {},
): string {
  const resolvedCommand = isWindows ? resolveExecutable(command) || command : command;
  const extension = path.extname(resolvedCommand).toLowerCase();
  const needsShell = isWindows && (extension === ".cmd" || extension === ".bat");

  const result = spawnSync(resolvedCommand, args, {
    ...options,
    encoding: "utf8",
    shell: needsShell,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = result.stderr || result.stdout || `${command} exited with ${result.status}`;
    throw new Error(message.trim());
  }

  return result.stdout;
}

export function killProcessTree(
  child: Pick<ChildProcessWithoutNullStreams, "pid" | "kill" | "killed">,
  signal: NodeJS.Signals,
): void {
  if (!child.pid) return;

  if (isWindows) {
    const forceArgs = signal === "SIGKILL" ? ["/F"] : [];
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", ...forceArgs], {
      stdio: "ignore",
    });
    if (result.status !== 0 && !child.killed) {
      child.kill(signal);
    }
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
