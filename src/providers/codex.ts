import {
  Codex,
  type Input,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type Usage,
} from "@openai/codex-sdk";
import type {
  IProvider,
  ProviderCapabilities,
  ProviderModel,
  ProviderContextUsage,
  RunOptions,
  RunResult,
} from "./types.js";
import {
  sanitizeAgentText,
  type ClaudeAgentStreamEvent,
} from "./claude-code-agent-events.js";
import { logger } from "../logger.js";

export class ProviderTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider 执行超时（${Math.round(timeoutMs / 1000)}s）`);
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderProcessError extends Error {
  constructor(exitCode: number | null, output: string) {
    const code = exitCode ?? "unknown";
    const preview = output.slice(0, 300);
    super(`Provider 进程异常退出（状态码 ${code}）：${preview}`);
    this.name = "ProviderProcessError";
  }
}

export class ProviderEmptyOutputError extends Error {
  constructor() {
    super("Provider 返回了空内容");
    this.name = "ProviderEmptyOutputError";
  }
}

export class ProviderParseError extends Error {
  constructor(stdout: string) {
    const preview = stdout.slice(0, 300);
    super(`无法从 Provider 输出中解析有效消息：${preview}`);
    this.name = "ProviderParseError";
  }
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CODEX_CONTEXT_WINDOW = 258000;

type StreamHandler = (event: ClaudeAgentStreamEvent) => void | Promise<void>;

type ToolState = {
  startedAt: number;
};

type ToolOutput = {
  stdout?: string;
  stderr?: string;
  text?: string;
};

function buildInput(prompt: string, imagePaths: string[]): Input {
  if (imagePaths.length === 0) return prompt;

  return [
    { type: "text", text: prompt },
    ...imagePaths.map((imagePath) => ({
      type: "local_image" as const,
      path: imagePath,
    })),
  ];
}

function formatJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return sanitizeAgentText(JSON.stringify(value, null, 2));
  } catch {
    return sanitizeAgentText(value);
  }
}

function mapFileEvent(kind: "add" | "delete" | "update"): "add" | "unlink" | "change" {
  if (kind === "add") return "add";
  if (kind === "delete") return "unlink";
  return "change";
}

function summarizeItem(item: ThreadItem): string {
  switch (item.type) {
    case "command_execution":
      return item.command;
    case "file_change":
      return item.changes.map((change) => change.path).join(", ");
    case "mcp_tool_call":
      return `${item.server}/${item.tool}`;
    case "web_search":
      return item.query;
    default:
      return "";
  }
}

function buildToolName(item: ThreadItem): string {
  switch (item.type) {
    case "command_execution":
      return "Bash";
    case "file_change":
      return "Edit";
    case "mcp_tool_call":
      return item.tool;
    case "web_search":
      return "WebSearch";
    default:
      return item.type;
  }
}

function buildToolTitle(item: ThreadItem, summary: string): string {
  const name = buildToolName(item);
  return summary ? `${name} · ${summary}` : name;
}

function extractToolOutput(item: ThreadItem): ToolOutput | undefined {
  switch (item.type) {
    case "command_execution":
      return item.aggregated_output
        ? { stdout: sanitizeAgentText(item.aggregated_output) }
        : undefined;
    case "mcp_tool_call": {
      if (item.error?.message) return { stderr: sanitizeAgentText(item.error.message) };
      const content = item.result?.content
        ?.map((entry) => {
          if ("text" in entry && typeof entry.text === "string") return entry.text;
          return formatJson(entry);
        })
        .filter(Boolean)
        .join("\n");
      return content ? { text: sanitizeAgentText(content) } : undefined;
    }
    case "error":
      return { stderr: sanitizeAgentText(item.message) };
    default:
      return undefined;
  }
}

function itemStatus(item: ThreadItem): "running" | "success" | "failed" {
  switch (item.type) {
    case "command_execution":
      if (item.status === "failed") return "failed";
      if (item.status === "completed") return item.exit_code === 0 ? "success" : "failed";
      return "running";
    case "file_change":
      return item.status === "failed" ? "failed" : item.status === "completed" ? "success" : "running";
    case "mcp_tool_call":
      if (item.status === "failed") return "failed";
      return item.status === "completed" ? "success" : "running";
    default:
      return "success";
  }
}

function extractContextUsage(usage: Usage | null): ProviderContextUsage | undefined {
  if (!usage) return undefined;
  const usedTokens = usage.input_tokens + usage.cached_input_tokens;
  if (!usedTokens) return undefined;
  const usedPercentage = Math.min(
    100,
    Math.round((usedTokens / DEFAULT_CODEX_CONTEXT_WINDOW) * 1000) / 10,
  );
  return {
    usedTokens,
    maxTokens: DEFAULT_CODEX_CONTEXT_WINDOW,
    usedPercentage,
    remainingPercentage: Math.max(0, Math.round((100 - usedPercentage) * 10) / 10),
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cached_input_tokens,
    source: "codex",
  };
}

function isToolItem(item: ThreadItem): boolean {
  return (
    item.type === "command_execution" ||
    item.type === "file_change" ||
    item.type === "mcp_tool_call" ||
    item.type === "web_search"
  );
}

export class CodexProvider implements IProvider {
  readonly type = "codex";
  readonly displayName = "Codex CLI";
  readonly capabilities: ProviderCapabilities = {
    sessionResume: true,
    imageInput: true,
    sandbox: true,
  };

  private readonly bin: string;
  private readonly codex: Codex;

  constructor(opts?: { bin?: string }) {
    this.bin = opts?.bin ?? "codex";
    this.codex = new Codex({
      codexPathOverride: this.bin,
    });
  }

  listModels(): ProviderModel[] {
    return [
      { id: "gpt-5.5", name: "GPT-5.5", description: "最新通用模型" },
      { id: "gpt-5.4", name: "GPT-5.4", description: "通用模型" },
      { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", description: "轻量快速模型" },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", description: "编程模型" },
      { id: "gpt-5.2", name: "GPT-5.2", description: "稳定通用模型" },
    ];
  }

  async run(opts: RunOptions): Promise<RunResult> {
    return this.execute(opts);
  }

  async runWithEvents(
    opts: RunOptions & {
      onEvent: StreamHandler;
    },
  ): Promise<RunResult> {
    return this.execute(opts, opts.onEvent);
  }

  private async execute(opts: RunOptions, onEvent?: StreamHandler): Promise<RunResult> {
    const {
      workdir,
      prompt,
      model,
      imagePaths = [],
      sessionId,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    } = opts;
    const sandbox = opts.sandbox ?? process.env.CODEX_SANDBOX ?? "read-only";
    const startedAt = Date.now();
    const abortController = new AbortController();
    const toolStateById = new Map<string, ToolState>();
    const textByAgentMessageId = new Map<string, string>();

    let timedOut = false;
    let providerSessionId = sessionId || null;
    let responseText = "";
    let usage: Usage | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, timeoutMs);

    logger.info("provider.exec.start", {
      provider: this.type,
      bin: this.bin,
      workdir,
      sandbox,
      model: model || null,
      sessionId: sessionId || null,
      imageCount: imagePaths.length,
      promptChars: prompt.length,
      timeoutMs,
    });

    try {
      await onEvent?.({
        type: "agent_status",
        status: "started",
        message: "Codex Agent 已启动",
      });

      const threadOptions: ThreadOptions = {
        workingDirectory: workdir,
        skipGitRepoCheck: true,
        sandboxMode: sandbox as ThreadOptions["sandboxMode"],
        model: model || undefined,
      };
      const thread = sessionId
        ? this.codex.resumeThread(sessionId, threadOptions)
        : this.codex.startThread(threadOptions);
      const { events } = await thread.runStreamed(buildInput(prompt, imagePaths), {
        signal: abortController.signal,
      });

      for await (const event of events) {
        if (event.type === "thread.started") {
          providerSessionId = event.thread_id;
        } else if (event.type === "turn.started") {
          await onEvent?.({
            type: "agent_status",
            status: "running",
            message: "Codex Agent 正在处理",
          });
        } else if (event.type === "turn.completed") {
          usage = event.usage;
        } else if (event.type === "turn.failed") {
          throw new ProviderProcessError(1, event.error.message);
        } else if (event.type === "error") {
          throw new ProviderProcessError(1, event.message);
        }

        if ("item" in event) {
          const text = await this.handleItemEvent(
            event,
            toolStateById,
            textByAgentMessageId,
            onEvent,
          );
          if (text !== null) responseText = text;
        }
      }

      clearTimeout(timer);

      if (timedOut) {
        throw new ProviderTimeoutError(timeoutMs);
      }

      const finalText = responseText.trim();
      if (!finalText) {
        logger.error("provider.exec.empty_response", {
          provider: this.type,
          workdir,
          sandbox,
          durationMs: Date.now() - startedAt,
          sessionId: providerSessionId,
        });
        throw new ProviderEmptyOutputError();
      }

      const contextUsage = extractContextUsage(usage);

      logger.info("provider.exec.success", {
        provider: this.type,
        workdir,
        sandbox,
        durationMs: Date.now() - startedAt,
        replyChars: finalText.length,
        sessionId: providerSessionId,
        usage,
      });

      await onEvent?.({
        type: "agent_status",
        status: "completed",
        message: "Codex Agent 已完成",
        sessionId: providerSessionId || undefined,
        durationMs: Date.now() - startedAt,
      });

      return {
        text: finalText,
        sessionId: providerSessionId,
        contextUsage,
      };
    } catch (error) {
      clearTimeout(timer);

      if (timedOut) {
        logger.warn("provider.exec.timeout", {
          provider: this.type,
          workdir,
          sandbox,
          durationMs: Date.now() - startedAt,
        });
        await onEvent?.({
          type: "agent_status",
          status: "failed",
          message: `Codex Agent 执行超时（${Math.round(timeoutMs / 1000)}s）`,
          durationMs: Date.now() - startedAt,
        });
        throw new ProviderTimeoutError(timeoutMs);
      }

      logger.error("provider.exec.error", {
        provider: this.type,
        workdir,
        sandbox,
        durationMs: Date.now() - startedAt,
        error,
      });
      await onEvent?.({
        type: "agent_status",
        status: "failed",
        message: error instanceof Error ? error.message : "Codex Agent 执行失败",
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  private async handleItemEvent(
    event: Extract<ThreadEvent, { item: ThreadItem }>,
    toolStateById: Map<string, ToolState>,
    textByAgentMessageId: Map<string, string>,
    onEvent?: StreamHandler,
  ): Promise<string | null> {
    const { item } = event;

    if (item.type === "agent_message") {
      const previous = textByAgentMessageId.get(item.id) || "";
      const next = sanitizeAgentText(item.text || "");
      if (onEvent && next.length > previous.length) {
        await onEvent({ type: "answer_delta", text: next.slice(previous.length) });
      }
      textByAgentMessageId.set(item.id, next);
      return event.type === "item.completed" ? next : null;
    }

    if (item.type === "reasoning" && item.text) {
      await onEvent?.({ type: "answer_delta", text: sanitizeAgentText(item.text) });
      return null;
    }

    if (item.type === "todo_list" && event.type === "item.completed") {
      const summary = item.items
        .map((todo) => `${todo.completed ? "[x]" : "[ ]"} ${todo.text}`)
        .join("\n");
      if (summary) await onEvent?.({ type: "answer_delta", text: `${summary}\n` });
      return null;
    }

    if (!isToolItem(item)) {
      return null;
    }

    if (!toolStateById.has(item.id)) {
      const summary = sanitizeAgentText(summarizeItem(item));
      toolStateById.set(item.id, {
        startedAt: Date.now(),
      });
      await onEvent?.({
        type: "tool_start",
        tool: {
          id: item.id,
          name: buildToolName(item),
          title: sanitizeAgentText(buildToolTitle(item, summary)),
          summary,
          input: item.type === "mcp_tool_call" ? formatJson(item.arguments) : undefined,
          startedAt: Date.now(),
          status: "running",
        },
      });
    }

    if (item.type === "file_change" && event.type === "item.completed") {
      for (const change of item.changes) {
        await onEvent?.({
          type: "file_change",
          path: change.path,
          event: mapFileEvent(change.kind),
        });
      }
    }

    if (event.type !== "item.completed") {
      return null;
    }

    const state = toolStateById.get(item.id);
    const status = itemStatus(item);
    await onEvent?.({
      type: "tool_end",
      toolId: item.id,
      status: status === "running" ? "success" : status,
      durationMs: state ? Date.now() - state.startedAt : undefined,
      output: extractToolOutput(item),
      error:
        item.type === "mcp_tool_call" && item.error?.message
          ? sanitizeAgentText(item.error.message)
          : undefined,
      files: item.type === "file_change" ? item.changes.map((change) => change.path) : undefined,
    });

    return null;
  }
}
