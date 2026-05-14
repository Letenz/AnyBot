import {
  query,
  type Options,
  type PermissionMode,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  IProvider,
  RunOptions,
  RunResult,
  ProviderModel,
  ProviderCapabilities,
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
const DEFAULT_CLAUDE_CODE_BIN = "claude";

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
    this.pathToClaudeCodeExecutable =
      opts?.pathToClaudeCodeExecutable || DEFAULT_CLAUDE_CODE_BIN;
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
      prompt,
      model,
      sessionId,
      newSessionId,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    } = opts;
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

      for await (const message of stream) {
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
      };
    } catch (err) {
      clearTimeout(timer);

      if (timedOut) {
        logger.warn("provider.exec.timeout", {
          provider: this.type,
          workdir,
          sandbox,
          durationMs: Date.now() - startedAt,
        });
        throw new ProviderTimeoutError(timeoutMs);
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
    }
  }
}
