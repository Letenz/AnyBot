import os from "node:os";
import { spawn } from "node:child_process";

export function openDirectory(dir: string): void {
  const platform = os.platform();
  if (platform === "darwin") {
    spawn("open", [dir], { detached: true, stdio: "ignore" }).unref();
  } else if (platform === "win32") {
    spawn("explorer.exe", [dir], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("sh", [
      "-c",
      "nautilus \"$1\" 2>/dev/null || thunar \"$1\" 2>/dev/null || dolphin \"$1\" 2>/dev/null || xdg-open \"$1\"",
      "sh",
      dir,
    ], { detached: true, stdio: "ignore" }).unref();
  }
}
