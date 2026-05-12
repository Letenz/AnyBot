import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { IProvider } from "./types.js";
import { CodexProvider } from "./codex.js";
import { GeminiCliProvider } from "./gemini-cli.js";
import { CursorCliProvider } from "./cursor-cli.js";
import { QoderCliProvider } from "./qoder-cli.js";
import { ClaudeCodeProvider } from "./claude-code.js";

type ProviderFactory = (config?: Record<string, unknown>) => IProvider;

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

export function createProvider(type: string, config?: Record<string, unknown>): IProvider {
  const normalizedType = normalizeProviderType(type);
  const factory = providerFactories[normalizedType];
  if (!factory) {
    throw new Error(
      `不支持的 Provider: ${type}。可用: ${Object.keys(providerFactories).join(", ")}`,
    );
  }
  return factory(config);
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
