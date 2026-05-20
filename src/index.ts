import { applyProxy } from "./proxy.js";
import { getConfiguredWebPort } from "./app-settings.js";
import { createApp } from "./web/server.js";

import {
  initProvider,
  getProviderConfig,
  getRegisteredProviderTypes,
  normalizeProviderType,
} from "./providers/index.js";
import {
  includeContentInLogs,
  includePromptInLogs,
  logger,
} from "./logger.js";
import {
  getCurrentModel,
  readPersistedProviderType,
  readModelConfig,
  setCurrentProvider,
  setCurrentModel,
  getProviderTypes,
} from "./web/model-config.js";
import { startAllChannels } from "./channels/index.js";
import type { ChannelCallbacks } from "./channels/index.js";
import {
  getWorkdir,
  getSandbox,
} from "./shared.js";
import {
  createActiveAgentStream,
  emitAgentStream,
  finishAgentStream,
  hasActiveAgentStream,
  type AgentStreamEvent,
} from "./web/agent-stream.js";
import {
  canStreamPreparedChatTurn,
  getOrCreateChannelSession,
  prepareChatTurn,
  resetChannelSession,
  runPreparedChatTurn,
} from "./chat-runner.js";

function resolveInitialProviderType(): string {
  const persisted = readPersistedProviderType();
  if (persisted) return persisted;

  const requested = normalizeProviderType(process.env.PROVIDER || "codex");
  if (getRegisteredProviderTypes().includes(requested)) return requested;

  logger.warn("provider.initial_unsupported", {
    provider: requested,
    fallback: "codex",
    available: getRegisteredProviderTypes(),
  });
  return "codex";
}

const providerType = resolveInitialProviderType();

const provider = initProvider(providerType, getProviderConfig(providerType));

// --- Core logic ---

async function generateReply(
  chatId: string,
  userText: string,
  imagePaths: string[] = [],
  source: string = "unknown",
): Promise<string> {
  const dbSession = getOrCreateChannelSession(source, chatId);
  const prepared = prepareChatTurn({
    session: dbSession,
    userText,
    storedUserContent: userText,
    imagePaths,
    workdir: getWorkdir(),
  });
  const active = canStreamPreparedChatTurn(prepared) && !hasActiveAgentStream(dbSession.id)
    ? createActiveAgentStream(dbSession.id)
    : null;
  const emit = active
    ? (event: AgentStreamEvent) => emitAgentStream(active, event)
    : undefined;

  try {
    const result = await runPreparedChatTurn(prepared, {
      stream: emit ? { emit } : undefined,
      logPrefix: "reply.generate",
      logFields: { chatId, source, dbSessionId: dbSession.id },
    });
    return result.content;
  } finally {
    if (active) {
      finishAgentStream(dbSession.id, active);
    }
  }
}

// --- Channel callbacks ---

function listProviders() {
  const config = readModelConfig();
  return getProviderTypes().map((p) => ({
    type: p.type,
    displayName: p.displayName,
    isCurrent: p.type === config.provider,
  }));
}

function handleSwitchProvider(providerType: string) {
  try {
    const config = setCurrentProvider(providerType, getProviderConfig(providerType));
    return {
      success: true,
      message: `已切换到 ${providerType}，当前模型: ${config.currentModel}`,
    };
  } catch (e: any) {
    return { success: false, message: e.message || "切换供应商失败" };
  }
}

function listModels() {
  const config = readModelConfig();
  return config.models.map((m) => ({
    ...m,
    isCurrent: m.id === config.currentModel,
  }));
}

function handleSwitchModel(modelId: string) {
  try {
    const config = setCurrentModel(modelId);
    return {
      success: true,
      message: `已切换到模型: ${config.currentModel}`,
    };
  } catch (e: any) {
    return { success: false, message: e.message || "切换模型失败" };
  }
}

const channelCallbacks: ChannelCallbacks = {
  generateReply: (chatId, userText, imagePaths, source) =>
    generateReply(chatId, userText, imagePaths, source),
  resetSession: resetChannelSession,
  listProviders,
  switchProvider: handleSwitchProvider,
  listModels,
  switchModel: handleSwitchModel,
};

// --- Startup ---

const WEB_PORT = getConfiguredWebPort();

function exitWhenDesktopParentDies(): void {
  const parentPid = Number.parseInt(process.env.ANYBOT_DESKTOP_PARENT_PID || "", 10);
  if (!Number.isFinite(parentPid) || parentPid <= 0) {
    return;
  }

  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      logger.warn("desktop.parent_gone");
      process.exit(0);
    }
  }, 5000);

  timer.unref();
}

async function main(): Promise<void> {
  exitWhenDesktopParentDies();

  try {
    applyProxy();
  } catch (error) {
    logger.warn("proxy.init_failed", { error });
  }

  logger.info("service.starting", {
    provider: provider.type,
    providerDisplayName: provider.displayName,
    model: getCurrentModel(),
    workdir: getWorkdir(),
    sandbox: getSandbox(),
    logIncludeContent: includeContentInLogs(),
    logIncludePrompt: includePromptInLogs(),
    webPort: WEB_PORT,
  });

  const webApp = createApp();
  webApp.listen(WEB_PORT, () => {
    logger.info("web.started", { port: WEB_PORT });
    console.log(`AnyBot Web UI: http://localhost:${WEB_PORT}`);
  });

  const channels = await startAllChannels(channelCallbacks);
  logger.info("service.started", {
    activeChannels: channels.map((c) => c.type),
  });
}

main().catch((error) => {
  logger.error("service.start_failed", { error });
  process.exit(1);
});
