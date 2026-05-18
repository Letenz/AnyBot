import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { IProvider } from "./types.js";
import { CodexProvider } from "./codex.js";
import { GeminiCliProvider } from "./gemini-cli.js";
import { CursorCliProvider } from "./cursor-cli.js";
import { QoderCliProvider } from "./qoder-cli.js";
import { ClaudeCodeProvider } from "./claude-code.js";
import { resolveExecutable } from "../utils/process.js";

type ProviderFactory = (config?: Record<string, unknown>) => IProvider;

export interface ProviderInstallationStatus {
  installed: boolean;
  bin: string;
  executablePath: string | null;
  installHint: string;
}

function dropUndefined(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined),
  );
}

export function getProviderConfig(type: string): Record<string, unknown> {
  switch (normalizeProviderType(type)) {
    case "codex":
      return dropUndefined({ bin: process.env.CODEX_BIN });
    case "gemini-cli":
      return dropUndefined({
        bin: process.env.GEMINI_CLI_BIN,
        approvalMode: process.env.GEMINI_CLI_APPROVAL_MODE || "yolo",
      });
    case "cursor-cli":
      return dropUndefined({
        bin: process.env.CURSOR_CLI_BIN,
        workspace: process.env.CURSOR_CLI_WORKSPACE,
        apiKey: process.env.CURSOR_API_KEY,
      });
    case "qoder-cli":
      return dropUndefined({
        bin: process.env.QODER_CLI_BIN,
        maxTurns: process.env.QODER_CLI_MAX_TURNS
          ? parseInt(process.env.QODER_CLI_MAX_TURNS, 10)
          : undefined,
      });
    case "claude-code":
      return dropUndefined({
        pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_BIN,
        defaultModel: process.env.CLAUDE_AGENT_MODEL,
        maxTurns: process.env.CLAUDE_AGENT_MAX_TURNS
          ? parseInt(process.env.CLAUDE_AGENT_MAX_TURNS, 10)
          : undefined,
        permissionMode: process.env.CLAUDE_AGENT_PERMISSION_MODE,
      });
    default:
      return {};
  }
}

const providerFactories: Record<string, ProviderFactory> = {
  codex: (config) => new CodexProvider({ bin: config?.bin as string | undefined }),
  "claude-code": (config) =>
    new ClaudeCodeProvider({
      pathToClaudeCodeExecutable: config?.pathToClaudeCodeExecutable as string | undefined,
      maxTurns: config?.maxTurns as number | undefined,
      permissionMode: config?.permissionMode as PermissionMode | undefined,
      defaultModel: config?.defaultModel as string | undefined,
    }),
  "gemini-cli": (config) =>
    new GeminiCliProvider({
      bin: config?.bin as string | undefined,
      approvalMode: config?.approvalMode as string | undefined,
    }),
  "cursor-cli": (config) =>
    new CursorCliProvider({
      bin: config?.bin as string | undefined,
      workspace: config?.workspace as string | undefined,
      apiKey: config?.apiKey as string | undefined,
    }),
  "qoder-cli": (config) =>
    new QoderCliProvider({
      bin: config?.bin as string | undefined,
      maxTurns: config?.maxTurns as number | undefined,
    }),
};

export function normalizeProviderType(type: string): string {
  return type === "claude-agent" ? "claude-code" : type;
}

export function getRegisteredProviderTypes(): string[] {
  return Object.keys(providerFactories);
}

function getProviderBin(type: string, config: Record<string, unknown>): string {
  switch (normalizeProviderType(type)) {
    case "codex":
      return (config.bin as string | undefined) || "codex";
    case "gemini-cli":
      return (config.bin as string | undefined) || "gemini";
    case "cursor-cli":
      return (config.bin as string | undefined) || "agent";
    case "qoder-cli":
      return (config.bin as string | undefined) || "qodercli";
    case "claude-code":
      return (config.pathToClaudeCodeExecutable as string | undefined) || "bundled Claude Code";
    default:
      return type;
  }
}

function getProviderInstallHint(type: string): string {
  switch (normalizeProviderType(type)) {
    case "codex":
      return "npm install -g @openai/codex";
    case "gemini-cli":
      return "详见 https://github.com/google-gemini/gemini-cli";
    case "cursor-cli":
      return "详见 https://docs.cursor.com/cli";
    case "qoder-cli":
      return "详见 https://docs.qoder.com";
    case "claude-code":
      return "使用随 @anthropic-ai/claude-agent-sdk 安装的 Claude Code native binary；如需指定外部 CLI，可设置 CLAUDE_CODE_BIN";
    default:
      return "";
  }
}

export function getProviderInstallationStatus(type: string): ProviderInstallationStatus {
  const normalizedType = normalizeProviderType(type);
  const config = getProviderConfig(normalizedType);
  const bin = getProviderBin(normalizedType, config);
  if (normalizedType === "claude-code" && !config.pathToClaudeCodeExecutable) {
    return {
      installed: true,
      bin,
      executablePath: null,
      installHint: getProviderInstallHint(normalizedType),
    };
  }
  const executablePath = resolveExecutable(bin);
  return {
    installed: executablePath !== null,
    bin,
    executablePath,
    installHint: getProviderInstallHint(normalizedType),
  };
}

export function createProvider(type: string, config?: Record<string, unknown>): IProvider {
  const normalizedType = normalizeProviderType(type);
  const factory = providerFactories[normalizedType];
  if (!factory) {
    throw new Error(
      `不支持的 Provider: ${type}。可用: ${Object.keys(providerFactories).join(", ")}`,
    );
  }
  const mergedConfig = {
    ...getProviderConfig(normalizedType),
    ...dropUndefined(config || {}),
  };
  return factory(mergedConfig);
}

let currentProvider: IProvider | null = null;

export function getProvider(): IProvider {
  if (!currentProvider) {
    throw new Error("Provider 尚未初始化");
  }
  return currentProvider;
}

export function initProvider(type: string, config?: Record<string, unknown>): IProvider {
  currentProvider = createProvider(type, config);
  return currentProvider;
}

export function switchProvider(type: string, config?: Record<string, unknown>): IProvider {
  currentProvider = createProvider(type, config);
  return currentProvider;
}

export type {
  IProvider,
  RunOptions,
  RunResult,
  ProviderModel,
  ProviderCapabilities,
  ProviderConfig,
} from "./types.js";
export { CodexProvider } from "./codex.js";
export { GeminiCliProvider } from "./gemini-cli.js";
export { CursorCliProvider } from "./cursor-cli.js";
export { QoderCliProvider } from "./qoder-cli.js";
export { ClaudeCodeProvider } from "./claude-code.js";
export {
  ProviderTimeoutError,
  ProviderProcessError,
  ProviderEmptyOutputError,
  ProviderParseError,
} from "./codex.js";
