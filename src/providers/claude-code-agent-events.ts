import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type {
  HookInput,
  SDKMessage,
  SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ProviderContextUsage } from "./types.js";

const execFileAsync = promisify(execFile);

export type ClaudeAgentToolStatus = "running" | "success" | "failed";

export type ClaudeAgentDiff = {
  path: string;
  diff: string;
};

export type ClaudeAgentStreamEvent =
  | {
      type: "agent_status";
      status: "started" | "running" | "completed" | "failed";
      message?: string;
      sessionId?: string;
      durationMs?: number;
    }
  | { type: "answer_delta"; text: string }
  | {
      type: "tool_start";
      tool: {
        id: string;
        name: string;
        title: string;
        summary: string;
        input?: string;
        startedAt: number;
        status: "running";
      };
    }
  | {
      type: "tool_progress";
      toolId: string;
      elapsedMs: number;
    }
  | {
      type: "tool_end";
      toolId: string;
      status: Exclude<ClaudeAgentToolStatus, "running">;
      durationMs?: number;
      output?: {
        stdout?: string;
        stderr?: string;
        text?: string;
      };
      error?: string;
      files?: string[];
      diffs?: ClaudeAgentDiff[];
    }
  | {
      type: "file_change";
      path: string;
      event: "change" | "add" | "unlink";
      diff?: string;
    }
  | { type: "context_usage"; usage: ProviderContextUsage };

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{12,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
];

const SECRET_PREFIX_PATTERNS: RegExp[] = [
  /\b((?:api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"'`]+)/gi,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
];

export function sanitizeAgentText(value: unknown): string {
  let text = stringifyForDisplay(value);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[REDACTED]");
  }
  for (const pattern of SECRET_PREFIX_PATTERNS) {
    text = text.replace(pattern, (_match, prefix) => `${prefix}[REDACTED]`);
  }
  return text;
}

export function extractAssistantTextDelta(message: SDKMessage): string | null {
  if (message.type !== "stream_event") return null;
  const partial = message as SDKPartialAssistantMessage;
  const event = partial.event as {
    type?: string;
    delta?: { type?: string; text?: string };
  };
  if (event.type !== "content_block_delta") return null;
  if (event.delta?.type !== "text_delta") return null;
  return event.delta.text ? sanitizeAgentText(event.delta.text) : null;
}

export function createToolStartEvent(input: HookInput): ClaudeAgentStreamEvent | null {
  if (input.hook_event_name !== "PreToolUse") return null;
  const toolInput = input.tool_input;
  const summary = summarizeToolInput(input.tool_name, toolInput);
  return {
    type: "tool_start",
    tool: {
      id: input.tool_use_id,
      name: input.tool_name,
      title: buildToolTitle(input.tool_name, summary),
      summary,
      input: summarizeRawToolInput(input.tool_name, toolInput),
      startedAt: Date.now(),
      status: "running",
    },
  };
}

export async function createToolEndEvent(
  input: HookInput,
  workdir: string,
): Promise<ClaudeAgentStreamEvent | null> {
  if (input.hook_event_name !== "PostToolUse" && input.hook_event_name !== "PostToolUseFailure") {
    return null;
  }

  const files = extractFilePaths(input.tool_name, input.tool_input);
  const diffs = await collectDiffs(workdir, files);

  if (input.hook_event_name === "PostToolUseFailure") {
    return {
      type: "tool_end",
      toolId: input.tool_use_id,
      status: "failed",
      durationMs: input.duration_ms,
      output: extractToolOutput(null),
      error: sanitizeAgentText(input.error),
      files,
      diffs,
    };
  }

  return {
    type: "tool_end",
    toolId: input.tool_use_id,
    status: "success",
    durationMs: input.duration_ms,
    output: extractToolOutput(input.tool_response),
    files,
    diffs,
  };
}

export async function createFileChangeEvent(
  input: HookInput,
  workdir: string,
): Promise<ClaudeAgentStreamEvent | null> {
  if (input.hook_event_name !== "FileChanged") return null;
  const diff = await collectDiff(workdir, input.file_path);
  return {
    type: "file_change",
    path: normalizeDisplayPath(input.file_path, workdir),
    event: input.event,
    diff,
  };
}

export function createToolProgressEvent(message: SDKMessage): ClaudeAgentStreamEvent | null {
  if (message.type !== "tool_progress") return null;
  return {
    type: "tool_progress",
    toolId: message.tool_use_id,
    elapsedMs: Math.round(message.elapsed_time_seconds * 1000),
  };
}

function buildToolTitle(toolName: string, summary: string): string {
  return summary ? `${toolName} · ${summary}` : toolName;
}

function summarizeToolInput(toolName: string, input: unknown): string {
  const obj = isRecord(input) ? input : {};
  const readPath = getString(obj, "file_path") || getString(obj, "path");
  switch (toolName) {
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return readPath ? path.basename(readPath) : "";
    case "Grep":
      return getString(obj, "pattern") || "";
    case "Glob":
      return getString(obj, "pattern") || "";
    case "LS":
      return readPath || "";
    case "Bash":
      return truncateOneLine(getString(obj, "command") || "", 96);
    case "Agent":
      return getString(obj, "description") || getString(obj, "subagent_type") || "";
    default:
      return readPath || getString(obj, "command") || getString(obj, "pattern") || "";
  }
}

function summarizeRawToolInput(toolName: string, input: unknown): string {
  const obj = isRecord(input) ? input : input;
  if (toolName === "Write" && isRecord(obj) && typeof obj.content === "string") {
    return sanitizeAgentText({ ...obj, content: `[${obj.content.length} chars]` });
  }
  if ((toolName === "Edit" || toolName === "MultiEdit") && isRecord(obj)) {
    const compact = { ...obj };
    if (typeof compact.old_string === "string") compact.old_string = `[${compact.old_string.length} chars]`;
    if (typeof compact.new_string === "string") compact.new_string = `[${compact.new_string.length} chars]`;
    return sanitizeAgentText(compact);
  }
  return sanitizeAgentText(obj);
}

function extractToolOutput(response: unknown): { stdout?: string; stderr?: string; text?: string } | undefined {
  if (response == null) return undefined;
  if (isRecord(response)) {
    const stdout = getString(response, "stdout");
    const stderr = getString(response, "stderr");
    if (stdout || stderr) {
      return {
        stdout: stdout ? sanitizeAgentText(stdout) : undefined,
        stderr: stderr ? sanitizeAgentText(stderr) : undefined,
      };
    }
  }

  const text = sanitizeAgentText(response);
  return text ? { text } : undefined;
}

function extractFilePaths(toolName: string, input: unknown): string[] {
  const obj = isRecord(input) ? input : {};
  const paths = new Set<string>();
  const filePath = getString(obj, "file_path");
  const pathValue = getString(obj, "path");
  if (filePath) paths.add(filePath);
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName) && pathValue) {
    paths.add(pathValue);
  }
  return [...paths];
}

async function collectDiffs(workdir: string, files: string[]): Promise<ClaudeAgentDiff[]> {
  const diffs: ClaudeAgentDiff[] = [];
  for (const file of files) {
    const diff = await collectDiff(workdir, file);
    if (diff) {
      diffs.push({ path: normalizeDisplayPath(file, workdir), diff });
    }
  }
  return diffs;
}

async function collectDiff(workdir: string, file: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--no-color", "--", file],
      { cwd: workdir, maxBuffer: 1024 * 1024 },
    );
    const diff = sanitizeAgentText(stdout).trimEnd();
    return diff || undefined;
  } catch {
    return undefined;
  }
}

function normalizeDisplayPath(file: string, workdir: string): string {
  const resolved = path.resolve(workdir, file);
  const relative = path.relative(workdir, resolved);
  return relative && !relative.startsWith("..") ? relative : file;
}

function truncateOneLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function stringifyForDisplay(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) || "";
  } catch {
    return String(value);
  }
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
