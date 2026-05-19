import {
  query,
  type Options,
  type PermissionMode,
  type SDKMessage,
  type SDKControlGetContextUsageResponse,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ProviderCancelledError } from "./types.js";
import type {
  IProvider,
  RunOptions,
  RunResult,
  ProviderModel,
  ProviderCapabilities,
  ProviderContextUsage,
} from "./types.js";
import {
  ProviderTimeoutError,
  ProviderProcessError,
  ProviderEmptyOutputError,
} from "./codex.js";
import {
  createFileChangeEvent,
  createToolEndEvent,
  createToolProgressEvent,
  createToolStartEvent,
  extractAssistantTextDelta,
  type ClaudeAgentStreamEvent,
} from "./claude-code-agent-events.js";
import { logger } from "../logger.js";
import type { SandboxMode } from "../types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const WORKDIR_SAFETY_PROMPT = [
  "## 工作目录规则",
  "- 在进行任何文件操作之前，先使用 `pwd` 确认当前处于正确目录",
  "- 未经用户明确确认，绝不要使用 `git reset --hard` 或 `git clean -fd`",
  "- 对关键操作使用绝对路径",
].join("\n");

const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "LS"];
const WORKSPACE_WRITE_TOOLS = [
  "Bash",
  "Read",
  "Grep",
  "Glob",
  "LS",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
];

function isSdkResultMessage(message: SDKMessage): message is SDKResultMessage {
  return message.type === "result";
}

function mapSandboxToPermissionMode(sandbox: SandboxMode): PermissionMode {
  switch (sandbox) {
    case "danger-full-access":
      return "bypassPermissions";
    case "workspace-write":
      return "acceptEdits";
    case "read-only":
    default:
      return "dontAsk";
  }
}

function buildSandboxOptions(sandbox: SandboxMode, workdir: string): Options["sandbox"] {
  if (sandbox === "danger-full-access") {
    return { enabled: false };
  }

  return {
    enabled: true,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: sandbox === "workspace-write",
    filesystem: {
      allowRead: [workdir],
      allowWrite: sandbox === "workspace-write" ? [workdir] : [],
    },
  };
}

function buildAllowedTools(sandbox: SandboxMode): string[] | undefined {
  if (sandbox === "danger-full-access") {
    return undefined;
  }

  return sandbox === "workspace-write" ? WORKSPACE_WRITE_TOOLS : READ_ONLY_TOOLS;
}

function getUsageNumber(usage: unknown, key: string): number {
  if (!usage || typeof usage !== "object") return 0;
  const value = (usage as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function extractContextUsage(result: SDKResultMessage): ProviderContextUsage | undefined {
  const inputTokens = getUsageNumber(result.usage, "input_tokens");
  const outputTokens = getUsageNumber(result.usage, "output_tokens");
  const cacheCreationInputTokens = getUsageNumber(result.usage, "cache_creation_input_tokens");
  const cacheReadInputTokens = getUsageNumber(result.usage, "cache_read_input_tokens");
  const usedTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  const modelUsages = Object.values(result.modelUsage || {});
  const maxTokens = modelUsages.find((entry) => entry.contextWindow > 0)?.contextWindow;

  if (!usedTokens || !maxTokens) return undefined;

  const usedPercentage = Math.min(100, Math.round((usedTokens / maxTokens) * 1000) / 10);
  return {
    usedTokens,
    maxTokens,
    usedPercentage,
    remainingPercentage: Math.max(0, Math.round((100 - usedPercentage) * 10) / 10),
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    source: "claude-code",
  };
}

function extractContextUsageFromBreakdown(
  breakdown: SDKControlGetContextUsageResponse | null,
): ProviderContextUsage | undefined {
  if (!breakdown || !breakdown.totalTokens || !breakdown.maxTokens) return undefined;

  const usedPercentage =
    typeof breakdown.percentage === "number" && Number.isFinite(breakdown.percentage)
      ? Math.min(100, Math.round(breakdown.percentage * 10) / 10)
      : Math.min(100, Math.round((breakdown.totalTokens / breakdown.maxTokens) * 1000) / 10);
  const apiUsage = breakdown.apiUsage;

  return {
    usedTokens: breakdown.totalTokens,
    maxTokens: breakdown.maxTokens,
    usedPercentage,
    remainingPercentage: Math.max(0, Math.round((100 - usedPercentage) * 10) / 10),
    inputTokens: apiUsage?.input_tokens,
    outputTokens: apiUsage?.output_tokens,
    cacheCreationInputTokens: apiUsage?.cache_creation_input_tokens,
    cacheReadInputTokens: apiUsage?.cache_read_input_tokens,
    source: "claude-code",
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`等待 Claude Code context usage 分类超时（${timeoutMs}ms）`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class ClaudeCodeProvider implements IProvider {
  readonly type = "claude-code";
  readonly displayName = "Claude Code";
  readonly capabilities: ProviderCapabilities = {
    sessionResume: true,
    imageInput: false,
    sandbox: true,
  };

  private readonly pathToClaudeCodeExecutable: string | undefined;
  private readonly maxTurns: number | undefined;
  private readonly permissionMode: PermissionMode | undefined;
  private readonly defaultModel: string | undefined;

  constructor(opts?: {
    pathToClaudeCodeExecutable?: string;
    maxTurns?: number;
    permissionMode?: PermissionMode;
    defaultModel?: string;
  }) {
    this.pathToClaudeCodeExecutable = opts?.pathToClaudeCodeExecutable;
    this.maxTurns = opts?.maxTurns;
    this.permissionMode = opts?.permissionMode;
    this.defaultModel = opts?.defaultModel;
  }

  listModels(): ProviderModel[] {
    return [
      { id: "auto", name: "Auto", description: "使用 Claude Code 默认模型" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", description: "默认推荐，均衡能力与速度" },
      { id: "claude-opus-4-7", name: "Claude Opus 4.7", description: "最强复杂任务模型" },
    ];
  }

  async run(opts: RunOptions): Promise<RunResult> {
    return this.execute(opts);
  }

  async runWithEvents(
    opts: RunOptions & {
      onEvent: (event: ClaudeAgentStreamEvent) => void | Promise<void>;
    },
  ): Promise<RunResult> {
    return this.execute(opts, opts.onEvent);
  }

  private async execute(
    opts: RunOptions,
    onEvent?: (event: ClaudeAgentStreamEvent) => void | Promise<void>,
  ): Promise<RunResult> {
    const {
      workdir,
      model,
      sessionId,
      newSessionId,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      signal,
    } = opts;
    const prompt = `${WORKDIR_SAFETY_PROMPT}\n\n${opts.prompt}`;
    const sandbox = opts.sandbox ?? "read-only";
    const startedAt = Date.now();
    const abortController = new AbortController();
    const permissionMode = this.permissionMode ?? mapSandboxToPermissionMode(sandbox);
    const resultModel = model && model !== "auto" ? model : this.defaultModel;

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, timeoutMs);
    const abortFromSignal = () => abortController.abort(signal?.reason);
    if (signal?.aborted) {
      abortFromSignal();
    } else {
      signal?.addEventListener("abort", abortFromSignal, { once: true });
    }

    logger.info("provider.exec.start", {
      provider: this.type,
      bin: this.pathToClaudeCodeExecutable,
      workdir,
      sandbox,
      model: resultModel || null,
      sessionId: sessionId || null,
      newSessionId: sessionId ? null : newSessionId || null,
      promptChars: prompt.length,
      timeoutMs,
      permissionMode,
    });

    try {
      let resultMessage: SDKResultMessage | null = null;
      let contextUsageBreakdown: SDKControlGetContextUsageResponse | null = null;
      let contextUsageBreakdownPromise: Promise<SDKControlGetContextUsageResponse | null> | null =
        null;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: process.env.CLAUDE_AGENT_SDK_CLIENT_APP || "anybot/0.1.0",
      };

      if (!env.ANTHROPIC_API_KEY) {
        delete env.ANTHROPIC_API_KEY;
      }

      await onEvent?.({
        type: "agent_status",
        status: "started",
        message: "Claude Code Agent 已启动",
      });

      const hooks: Options["hooks"] | undefined = onEvent
        ? {
            PreToolUse: [
              {
                hooks: [
                  async (input) => {
                    const event = createToolStartEvent(input);
                    if (event) await onEvent(event);
                    return {};
                  },
                ],
              },
            ],
            PostToolUse: [
              {
                hooks: [
                  async (input) => {
                    const event = await createToolEndEvent(input, workdir);
                    if (event) await onEvent(event);
                    return {};
                  },
                ],
              },
            ],
            PostToolUseFailure: [
              {
                hooks: [
                  async (input) => {
                    const event = await createToolEndEvent(input, workdir);
                    if (event) await onEvent(event);
                    return {};
                  },
                ],
              },
            ],
            FileChanged: [
              {
                hooks: [
                  async (input) => {
                    const event = await createFileChangeEvent(input, workdir);
                    if (event) await onEvent(event);
                    return {};
                  },
                ],
              },
            ],
          }
        : undefined;

      const stream = query({
        prompt,
        options: {
          abortController,
          cwd: workdir,
          model: resultModel,
          resume: sessionId,
          sessionId: sessionId ? undefined : newSessionId,
          pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable,
          maxTurns: this.maxTurns,
          permissionMode,
          allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
          allowedTools: buildAllowedTools(sandbox),
          sandbox: buildSandboxOptions(sandbox, workdir),
          includePartialMessages: !!onEvent,
          hooks,
          env,
        },
      });

      const requestContextUsageBreakdown = () => {
        if (contextUsageBreakdownPromise) return;
        contextUsageBreakdownPromise = withTimeout(stream.getContextUsage(), 5000)
          .then((breakdown) => {
            contextUsageBreakdown = breakdown;
            return breakdown;
          })
          .catch(() => null);
      };

      for await (const message of stream) {
        if (message.type === "assistant") {
          requestContextUsageBreakdown();
        }

        if (onEvent) {
          const delta = extractAssistantTextDelta(message);
          if (delta) {
            await onEvent({ type: "answer_delta", text: delta });
          }

          const progress = createToolProgressEvent(message);
          if (progress) {
            await onEvent(progress);
          }
        }

        if (isSdkResultMessage(message)) {
          resultMessage = message;
        }
      }

      if (contextUsageBreakdownPromise) {
        contextUsageBreakdown = await contextUsageBreakdownPromise;
      }

      clearTimeout(timer);

      if (timedOut) {
        throw new ProviderTimeoutError(timeoutMs);
      }

      if (!resultMessage) {
        logger.error("provider.exec.empty_response", {
          provider: this.type,
          workdir,
          sandbox,
          durationMs: Date.now() - startedAt,
        });
        throw new ProviderEmptyOutputError();
      }

      if (resultMessage.subtype !== "success") {
        const output = resultMessage.errors.join("\n") || resultMessage.subtype;
        logger.error("provider.exec.api_error", {
          provider: this.type,
          workdir,
          sandbox,
          durationMs: Date.now() - startedAt,
          subtype: resultMessage.subtype,
          errors: resultMessage.errors.slice(0, 5),
          sessionId: resultMessage.session_id,
        });
        throw new ProviderProcessError(1, output);
      }

      const responseText = resultMessage.result.trim();
      if (!responseText) {
        logger.error("provider.exec.empty_response", {
          provider: this.type,
          workdir,
          sandbox,
          durationMs: Date.now() - startedAt,
          sessionId: resultMessage.session_id,
        });
        throw new ProviderEmptyOutputError();
      }

      const contextUsage =
        extractContextUsageFromBreakdown(contextUsageBreakdown) || extractContextUsage(resultMessage);

      logger.info("provider.exec.success", {
        provider: this.type,
        workdir,
        sandbox,
        durationMs: Date.now() - startedAt,
        replyChars: responseText.length,
        sessionId: resultMessage.session_id,
        totalCostUsd: resultMessage.total_cost_usd,
      });

      await onEvent?.({
        type: "agent_status",
        status: "completed",
        message: "Claude Code Agent 已完成",
        sessionId: resultMessage.session_id,
        durationMs: Date.now() - startedAt,
      });

      return {
        text: responseText,
        sessionId: resultMessage.session_id,
        contextUsage,
      };
    } catch (err) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromSignal);

      if (timedOut) {
        logger.warn("provider.exec.timeout", {
          provider: this.type,
          workdir,
          sandbox,
          durationMs: Date.now() - startedAt,
        });
        throw new ProviderTimeoutError(timeoutMs);
      }

      if (signal?.aborted) {
        logger.info("provider.exec.cancelled", {
          provider: this.type,
          workdir,
          sandbox,
          durationMs: Date.now() - startedAt,
        });
        await onEvent?.({
          type: "agent_status",
          status: "failed",
          message: "Claude Code Agent 已中断",
          durationMs: Date.now() - startedAt,
        });
        throw new ProviderCancelledError();
      }

      logger.error("provider.exec.error", {
        provider: this.type,
        workdir,
        sandbox,
        durationMs: Date.now() - startedAt,
        error: err,
      });
      await onEvent?.({
        type: "agent_status",
        status: "failed",
        message: err instanceof Error ? err.message : "Claude Code Agent 执行失败",
        durationMs: Date.now() - startedAt,
      });
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromSignal);
    }
  }
}
