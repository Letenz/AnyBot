import { randomUUID } from "node:crypto";

import { applyProxy } from "./proxy.js";
import { getConfiguredWebPort } from "./app-settings.js";
import { createApp } from "./web/server.js";

import {
  initProvider,
  getProvider,
  getProviderConfig,
  createProvider,
  normalizeProviderType,
  ProviderTimeoutError,
  ProviderProcessError,
  ProviderEmptyOutputError,
} from "./providers/index.js";
import type { IProvider } from "./providers/index.js";
import {
  includeContentInLogs,
  includePromptInLogs,
  logger,
  rawLogString,
} from "./logger.js";
import {
  getCurrentModel,
  getModelForProvider,
  readPersistedProviderType,
  readModelConfig,
  setCurrentProvider,
  setCurrentModel,
  getProviderTypes,
} from "./web/model-config.js";
import { startAllChannels } from "./channels/index.js";
import type { ChannelCallbacks } from "./channels/index.js";
import * as db from "./web/db.js";
import {
  buildFirstTurnPrompt,
  buildResumePrompt,
  generateId,
  generateTitle,
  getWorkdir,
  getSandbox,
} from "./shared.js";
import type { ClaudeAgentStreamEvent } from "./providers/claude-code-agent-events.js";
import {
  buildAssistantMetadata,
  createActiveAgentStream,
  emitAgentStream,
  finishAgentStream,
  hasActiveAgentStream,
  type AgentStreamEvent,
} from "./web/agent-stream.js";
import {
  collectChangeReview,
  createChangeSnapshot,
  type PublicChangeReview,
} from "./web/change-review.js";

const providerType = readPersistedProviderType() || normalizeProviderType(process.env.PROVIDER || "codex");

const provider = initProvider(providerType, getProviderConfig(providerType));

// --- State with bounded memory ---

const MAX_CHAT_SESSIONS = 200;

class LRUMap<K, V> {
  private map = new Map<K, V>();
  constructor(private capacity: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): void {
    this.map.delete(key);
  }
}

const sessionIdByChat = new LRUMap<string, string>(MAX_CHAT_SESSIONS);
const sessionGenerationByChat = new Map<string, number>();

// --- Core logic ---

function getChatSessionKey(source: string | undefined, chatId: string): string {
  return `${source || "unknown"}:${chatId}`;
}

function getSessionGeneration(sessionKey: string): number {
  return sessionGenerationByChat.get(sessionKey) || 0;
}

function resetChatSession(chatId: string, source?: string): void {
  const sessionKey = getChatSessionKey(source, chatId);
  sessionIdByChat.delete(sessionKey);
  sessionGenerationByChat.set(sessionKey, getSessionGeneration(sessionKey) + 1);
  logger.info("chat.session.reset", {
    chatId,
    source: source || "unknown",
    sessionKey,
    generation: getSessionGeneration(sessionKey),
  });
  if (source) {
    db.detachChatId(source, chatId);
  }
}

function formatProviderError(error: unknown): string {
  if (error instanceof ProviderTimeoutError) {
    return "处理超时了，可能是问题太复杂。试试简化一下？";
  }
  if (error instanceof ProviderProcessError) {
    return "内部处理出错了，请稍后再试。";
  }
  if (error instanceof ProviderEmptyOutputError) {
    return "没有生成有效回复，请换个方式描述试试。";
  }
  return "处理消息时出错了，请稍后再试。";
}

function getOrCreateChannelSession(
  source: string,
  chatId: string,
): db.ChatSession {
  const existing = db.findSessionBySourceChat(source, chatId);
  if (existing) return existing;

  const session: db.ChatSession = {
    id: generateId(),
    title: "新对话",
    sessionId: null,
    provider: getProvider().type,
    source,
    chatId,
    projectId: null,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  db.createSession(session);
  return session;
}

function getSessionProvider(session: db.ChatSession) {
  if (!session.provider) {
    session.provider = getProvider().type;
  }
  const currentProvider = getProvider();
  return session.provider === currentProvider.type
    ? currentProvider
    : createProvider(session.provider, getProviderConfig(session.provider));
}

function isStreamingProvider(
  provider: IProvider,
): provider is IProvider & Required<Pick<IProvider, "runWithEvents">> {
  return typeof provider.runWithEvents === "function";
}

async function safeCreateChangeSnapshotForWorkdir(
  workdir: string,
): Promise<Awaited<ReturnType<typeof createChangeSnapshot>>> {
  try {
    return await createChangeSnapshot(workdir);
  } catch (error) {
    logger.warn("change_review.snapshot_failed", { error });
    return null;
  }
}

async function safeCollectChangeReview(
  snapshot: Awaited<ReturnType<typeof createChangeSnapshot>>,
): Promise<PublicChangeReview | null> {
  try {
    return await collectChangeReview(snapshot);
  } catch (error) {
    logger.warn("change_review.collect_failed", { error });
    return null;
  }
}

async function generateReply(
  chatId: string,
  userText: string,
  imagePaths: string[] = [],
  source: string = "unknown",
): Promise<string> {
  const sessionKey = getChatSessionKey(source, chatId);
  const dbSession = getOrCreateChannelSession(source, chatId);
  const provider = getSessionProvider(dbSession);
  const sessionId = sessionIdByChat.get(sessionKey) || dbSession.sessionId;
  const sessionGeneration = getSessionGeneration(sessionKey);
  const prompt = sessionId
    ? buildResumePrompt(userText, source)
    : buildFirstTurnPrompt(userText, source);

  db.addMessage(dbSession.id, "user", userText);

  if (dbSession.messages.length <= 1) {
    dbSession.title = generateTitle(userText);
  }
  db.updateSession({
    id: dbSession.id,
    title: dbSession.title,
    sessionId: dbSession.sessionId,
    provider: dbSession.provider,
    updatedAt: Date.now(),
  });

  logger.info("reply.generate.start", {
    chatId,
    source,
    provider: provider.type,
    mode: sessionId ? "resume" : "new",
    sessionId: sessionId || null,
    dbSessionId: dbSession.id,
    userTextChars: userText.length,
    imageCount: imagePaths.length,
    promptChars: prompt.length,
    ...(includeContentInLogs() ? { userText: rawLogString(userText) } : {}),
    ...(includePromptInLogs() ? { prompt: rawLogString(prompt) } : {}),
  });

  const workdir = getWorkdir();
  const sandbox = getSandbox();
  const runOptions = {
    workdir,
    sandbox,
    model: getModelForProvider(provider.type),
    prompt,
    imagePaths,
    sessionId: sessionId || undefined,
    newSessionId: sessionId ? undefined : randomUUID(),
  };
  const agentEvents: ClaudeAgentStreamEvent[] = [];
  const active = isStreamingProvider(provider) && !hasActiveAgentStream(dbSession.id)
    ? createActiveAgentStream(dbSession.id)
    : null;

  try {
    const changeSnapshot = active ? await safeCreateChangeSnapshotForWorkdir(workdir) : null;
    const emit = active
      ? (event: AgentStreamEvent) => {
          if (
            event.type !== "result" &&
            event.type !== "error" &&
            event.type !== "cancelled" &&
            event.type !== "done"
          ) {
            agentEvents.push(event);
          }
          emitAgentStream(active, event);
        }
      : null;

    const result = emit && isStreamingProvider(provider)
      ? await provider.runWithEvents({ ...runOptions, onEvent: emit })
      : await provider.run(runOptions);

    const changeReview = active ? await safeCollectChangeReview(changeSnapshot) : null;

    if (result.contextUsage && emit) {
      emit({
        type: "context_usage",
        usage: result.contextUsage,
      });
    }

    if (result.sessionId && sessionGeneration === getSessionGeneration(sessionKey)) {
      sessionIdByChat.set(sessionKey, result.sessionId);
    }

    db.addMessage(
      dbSession.id,
      "assistant",
      result.text,
      active
        ? buildAssistantMetadata({
            provider: provider.type,
            events: agentEvents,
            changeReview,
          })
        : JSON.stringify({ provider: provider.type }),
    );
    db.updateSession({
      id: dbSession.id,
      title: dbSession.title,
      sessionId: result.sessionId || dbSession.sessionId,
      provider: dbSession.provider,
      updatedAt: Date.now(),
    });

    if (emit) {
      emit({
        type: "result",
        content: result.text,
        title: dbSession.title,
        sessionId: result.sessionId || dbSession.sessionId,
        provider: provider.type,
        changeReview,
        contextUsage: result.contextUsage,
      });
    }

    logger.info("reply.generate.success", {
      chatId,
      source,
      provider: provider.type,
      sessionId: result.sessionId,
      dbSessionId: dbSession.id,
      replyChars: result.text.length,
      streamedToWeb: !!active,
      ...(includeContentInLogs() ? { replyText: rawLogString(result.text) } : {}),
    });

    return result.text;
  } catch (error) {
    if (active) {
      emitAgentStream(active, {
        type: "error",
        error: error instanceof Error ? error.message : "处理消息时出错了，请稍后再试。",
      });
    }
    throw error;
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
  resetSession: resetChatSession,
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

  db.detachAllChannelSessions();
  logger.info("service.channel_sessions_detached");

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
