import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Request, Response } from "express";
import { createProvider, getProvider, getRegisteredProviderTypes } from "../providers/index.js";
import { logger } from "../logger.js";
import { getLogDir } from "../logger.js";
import { getDataDir, readAppSettings, updateAppSettings, writeAppSettings, type AppSettings } from "../app-settings.js";
import { openDirectory } from "../utils/open-directory.js";
import * as db from "./db.js";
import {
  readModelConfig,
  readModelConfigForProvider,
  writeModelConfig,
  getModelForProvider,
  setCurrentModel,
  setModelForProvider,
  setCurrentProvider,
  getProviderTypes,
} from "./model-config.js";
import { readSandboxConfig, sandboxModeOptions, setDefaultSandbox } from "../sandbox-config.js";
import {
  readChannelsConfig,
  writeChannelsConfig,
  updateChannelConfig,
  getRegisteredChannelTypes,
  channelManager,
} from "../channels/index.js";
import { getWeixinLoginStatus } from "../channels/weixin.js";
import { listSkills, toggleSkill, deleteSkill, openSkillsFolder } from "./skills.js";
import { readProxyConfig, writeProxyConfig, getProxyUrl, type ProxyConfig } from "./proxy-config.js";
import { applyProxy } from "../proxy.js";
import {
  approveChangeReview,
  collectChangeReview,
  createChangeSnapshot,
  getChangeReview,
  revertChangeReview,
  type PublicChangeReview,
} from "./change-review.js";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import {
  buildFirstTurnPrompt,
  buildResumePrompt,
  generateId,
  generateTitle,
  getWorkdir,
  getSandbox,
} from "../shared.js";
import type { ClaudeAgentStreamEvent } from "../providers/claude-code-agent-events.js";
import type { IProvider } from "../providers/index.js";
import {
  attachAgentStreamClient,
  buildAssistantMetadata,
  compactAgentEvents,
  createActiveAgentStream,
  emitAgentStream,
  finishAgentStream,
  getActiveAgentStreamInfo,
  hasActiveAgentStream,
  type AgentStreamEvent,
} from "./agent-stream.js";

const execFile = promisify(execFileCallback);
const DEFAULT_SESSION_MESSAGE_LIMIT = 40;
const MESSAGE_PREVIEW_CHARS = 20000;

// 图片扩展名集合
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico", ".tiff", ".tif", ".heic", ".heif", ".avif"]);

function isImageFile(filePath: string): boolean {
  return IMAGE_EXTS.has(path.extname(filePath).toLowerCase());
}

function getUploadDir(): string {
  return path.join(getWorkdir(), "tmp", "uploads");
}

function isStreamingProvider(
  provider: ReturnType<typeof getProvider>,
): provider is IProvider & Required<Pick<IProvider, "runWithEvents">> {
  return typeof provider.runWithEvents === "function";
}

function getSessionProvider(session: Pick<db.ChatSession, "provider">): IProvider {
  const currentProvider = getProvider();
  const providerType = session.provider || currentProvider.type;
  if (providerType === currentProvider.type) return currentProvider;
  return createProvider(providerType);
}

function bindSessionProvider(session: Pick<db.ChatSession, "provider">): string {
  if (session.provider) return session.provider;
  session.provider = getProvider().type;
  return session.provider;
}

function readMessagePageQuery(req: Request): { beforeId: number | null; limit: number } {
  const beforeRaw = Array.isArray(req.query.before) ? req.query.before[0] : req.query.before;
  const limitRaw = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
  const before = beforeRaw ? Number(beforeRaw) : null;
  const limit = limitRaw ? Number(limitRaw) : DEFAULT_SESSION_MESSAGE_LIMIT;
  return {
    beforeId: before && Number.isFinite(before) && before > 0 ? Math.floor(before) : null,
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_SESSION_MESSAGE_LIMIT,
  };
}

type ClientChatMessage = db.ChatMessage & {
  contentTruncated?: boolean;
  contentChars?: number;
};

async function prepareMessagesForClient(
  messages: db.ChatMessage[],
): Promise<ClientChatMessage[]> {
  const hydrated = await hydrateChangeReviewMetadata(messages);
  return hydrated.map((message) => {
    let metadata = message.metadata;
    if (metadata) {
      try {
        const parsed = JSON.parse(metadata) as Record<string, unknown>;
        const loop = parsed.claudeAgentLoop as { events?: ClaudeAgentStreamEvent[] } | undefined;
        if (loop && Array.isArray(loop.events)) {
          parsed.claudeAgentLoop = {
            ...loop,
            events: compactAgentEvents(loop.events),
          };
          metadata = JSON.stringify(parsed);
        }
      } catch {
        metadata = message.metadata;
      }
    }

    if (message.content.length <= MESSAGE_PREVIEW_CHARS) {
      return { ...message, metadata };
    }

    return {
      ...message,
      metadata,
      content: `${message.content.slice(0, MESSAGE_PREVIEW_CHARS)}\n\n...[内容较长，已折叠]`,
      contentTruncated: true,
      contentChars: message.content.length,
    };
  });
}

async function hydrateChangeReviewMetadata(
  messages: db.ChatSession["messages"],
): Promise<db.ChatSession["messages"]> {
  return Promise.all(
    messages.map(async (message) => {
      if (!message.metadata) return message;
      try {
        const metadata = JSON.parse(message.metadata) as Record<string, unknown>;
        const existing = metadata.changeReview as { id?: string } | undefined;
        if (!existing?.id) return message;
        const hydrated = await getChangeReview(existing.id);
        if (!hydrated) return message;
        return {
          ...message,
          metadata: JSON.stringify({ ...metadata, changeReview: hydrated }),
        };
      } catch {
        return message;
      }
    }),
  );
}

async function safeCreateChangeSnapshotForWorkdir(workdir: string): Promise<Awaited<ReturnType<typeof createChangeSnapshot>>> {
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

function normalizeProjectPath(inputPath: string): string {
  if (!inputPath || typeof inputPath !== "string") {
    throw new Error("缺少项目路径");
  }
  const resolved = fs.realpathSync(path.resolve(inputPath));
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error("项目路径必须是文件夹");
  }
  return resolved;
}

function createOrTouchProject(projectPath: string): db.Project {
  const normalizedPath = normalizeProjectPath(projectPath);
  const existing = db.findProjectByPath(normalizedPath);
  if (existing) {
    db.touchProject(existing.id, Date.now());
    return { ...existing, updatedAt: Date.now() };
  }
  const now = Date.now();
  const project: db.Project = {
    id: generateId(),
    name: path.basename(normalizedPath) || normalizedPath,
    path: normalizedPath,
    createdAt: now,
    updatedAt: now,
  };
  db.createProject(project);
  return project;
}

function isFolderPickerCanceled(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; stderr?: unknown };
  const text = `${String(candidate.message || "")}\n${String(candidate.stderr || "")}`;
  return candidate.code === 2 || text.includes("(-128)") || text.includes("用户已取消") || text.includes("User canceled") || text.includes("User cancelled");
}

async function pickProjectFolder(): Promise<string | null> {
  let stdout = "";

  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = '选择项目文件夹'",
      "$dialog.ShowNewFolderButton = $true",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
      "  [Console]::Out.WriteLine($dialog.SelectedPath)",
      "  exit 0",
      "}",
      "exit 2",
    ].join("\n");
    try {
      const result = await execFile("powershell.exe", [
        "-NoProfile",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ]);
      stdout = result.stdout;
    } catch (error) {
      if (isFolderPickerCanceled(error)) {
        return null;
      }
      throw error;
    }
    return stdout.trim();
  }

  if (process.platform !== "darwin") {
    throw new Error("当前系统暂不支持从浏览器唤起本地文件夹选择器");
  }

  try {
    const result = await execFile("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "选择项目文件夹")',
    ]);
    stdout = result.stdout;
  } catch (error) {
    if (isFolderPickerCanceled(error)) {
      return null;
    }
    throw error;
  }
  return stdout.trim();
}

function ensurePathInsideProject(projectPath: string, relativePath: string): string {
  const root = normalizeProjectPath(projectPath);
  const target = path.resolve(root, relativePath || ".");
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("目录路径越界");
  }
  return target;
}

function readProjectTree(project: db.Project, relativePath: string): Array<{
  name: string;
  path: string;
  type: "directory" | "file";
}> {
  const target = ensurePathInsideProject(project.path, relativePath);
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    throw new Error("目标路径不是文件夹");
  }

  return fs.readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.name !== "node_modules" && entry.name !== ".git")
    .slice(0, 200)
    .map((entry) => ({
      name: entry.name,
      path: path.relative(project.path, path.join(target, entry.name)),
      type: entry.isDirectory() ? "directory" as const : "file" as const,
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function getSessionWorkdir(session: Pick<db.ChatSession, "projectId">): string {
  if (!session.projectId) return getWorkdir();
  const project = db.getProject(session.projectId);
  if (!project) {
    throw new Error("项目不存在");
  }
  return normalizeProjectPath(project.path);
}

// multer 配置：保留原始扩展名
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    // 每次上传时确保目录存在（防止运行中被删除）
    const uploadDir = getUploadDir();
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, "_");
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    cb(null, `${base}-${unique}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB 上限

export function chatRouter(): Router {
  const router = Router();

  router.get("/projects", (_req: Request, res: Response) => {
    res.json(db.listProjects());
  });

  router.post("/projects", (req: Request, res: Response) => {
    const { path: projectPath } = req.body as { path?: string };
    try {
      const project = createOrTouchProject(projectPath || "");
      res.json(project);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "添加项目失败" });
    }
  });

  router.post("/projects/pick", async (_req: Request, res: Response) => {
    try {
      const projectPath = await pickProjectFolder();
      if (!projectPath) {
        res.json({ canceled: true });
        return;
      }
      const project = createOrTouchProject(projectPath);
      res.json(project);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "选择项目失败" });
    }
  });

  router.get("/projects/:id/tree", (req: Request, res: Response) => {
    const project = db.getProject(req.params.id as string);
    if (!project) {
      res.status(404).json({ error: "项目不存在" });
      return;
    }

    try {
      const relativePath = typeof req.query.path === "string" ? req.query.path : "";
      res.json({
        projectId: project.id,
        path: relativePath,
        children: readProjectTree(project, relativePath),
      });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "读取目录失败" });
    }
  });

  router.get("/sessions", (_req: Request, res: Response) => {
    const list = db.listSessions();
    res.json(list);
  });

  router.post("/sessions", (req: Request, res: Response) => {
    const { projectId } = req.body as { projectId?: string | null };
    if (projectId && !db.getProject(projectId)) {
      res.status(404).json({ error: "项目不存在" });
      return;
    }

    const session: db.ChatSession = {
      id: generateId(),
      title: "新对话",
      sessionId: null,
      provider: getProvider().type,
      source: "web",
      chatId: null,
      projectId: projectId || null,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    db.createSession(session);
    res.json({ id: session.id, title: session.title, projectId: session.projectId, provider: session.provider });
  });

  router.get("/sessions/:id", async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const session = db.getSessionMetadata(id);
    if (!session) {
      res.status(404).json({ error: "会话不存在" });
      return;
    }
    const page = db.getMessagesPage(id, readMessagePageQuery(req));
    res.json({
      id: session.id,
      title: session.title,
      provider: session.provider,
      projectId: session.projectId,
      messages: await prepareMessagesForClient(page.messages),
      hasMoreMessages: page.hasMore,
      activeStream: getActiveAgentStreamInfo(session.id),
    });
  });

  router.get("/sessions/:id/messages", async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const session = db.getSessionMetadata(id);
    if (!session) {
      res.status(404).json({ error: "会话不存在" });
      return;
    }
    const page = db.getMessagesPage(id, readMessagePageQuery(req));
    res.json({
      messages: await prepareMessagesForClient(page.messages),
      hasMoreMessages: page.hasMore,
    });
  });

  router.get("/sessions/:id/messages/:messageId/content", (req: Request, res: Response) => {
    const id = req.params.id as string;
    const messageId = Number(req.params.messageId);
    if (!Number.isFinite(messageId) || messageId <= 0) {
      res.status(400).json({ error: "消息 ID 无效" });
      return;
    }
    const session = db.getSessionMetadata(id);
    if (!session) {
      res.status(404).json({ error: "会话不存在" });
      return;
    }
    const content = db.getMessageContent(id, Math.floor(messageId));
    if (content == null) {
      res.status(404).json({ error: "消息不存在" });
      return;
    }
    res.json({ content });
  });

  router.delete("/sessions/:id", (req: Request, res: Response) => {
    const id = req.params.id as string;
    db.deleteSession(id);
    res.json({ ok: true });
  });

  // --- App settings ---

  router.get("/app-settings", (_req: Request, res: Response) => {
    try {
      res.json({
        settings: readAppSettings(),
        effective: {
          dataDir: getDataDir(),
          logDir: getLogDir(),
          workdir: getWorkdir(),
          uploadDir: getUploadDir(),
        },
      });
    } catch (error) {
      res.status(500).json({ error: "读取设置失败" });
    }
  });

  router.put("/app-settings", (req: Request, res: Response) => {
    try {
      const settings = req.body as Partial<AppSettings>;
      if (settings.workspace?.defaultWorkdir) {
        settings.workspace.defaultWorkdir = normalizeProjectPath(settings.workspace.defaultWorkdir);
      }
      const next = updateAppSettings(settings);
      logger.info("app_settings.updated");
      res.json({
        settings: next,
        effective: {
          dataDir: getDataDir(),
          logDir: getLogDir(),
          workdir: getWorkdir(),
          uploadDir: getUploadDir(),
        },
      });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "保存设置失败" });
    }
  });

  router.post("/app-settings/default-workdir/pick", async (_req: Request, res: Response) => {
    try {
      const selected = await pickProjectFolder();
      if (!selected) {
        res.json({ canceled: true });
        return;
      }
      res.json({ path: normalizeProjectPath(selected) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "选择默认工作目录失败" });
    }
  });

  // --- Model & Provider config ---

  router.get("/model-config", (req: Request, res: Response) => {
    try {
      const provider = typeof req.query.provider === "string" ? req.query.provider : "";
      res.json(provider ? readModelConfigForProvider(provider) : readModelConfig());
    } catch (error) {
      res.status(500).json({ error: "读取模型配置失败" });
    }
  });

  router.put("/model-config", (req: Request, res: Response) => {
    const { modelId, provider } = req.body as { modelId?: string; provider?: string };
    if (!modelId) {
      res.status(400).json({ error: "缺少 modelId" });
      return;
    }
    try {
      const config = provider ? setModelForProvider(provider, modelId) : setCurrentModel(modelId);
      logger.info("model.switched", { modelId, provider: provider || config.provider });
      res.json(config);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "切换模型失败";
      res.status(400).json({ error: msg });
    }
  });

  router.get("/providers", (_req: Request, res: Response) => {
    try {
      const providers = getProviderTypes();
      const current = getProvider().type;
      res.json({ current, providers });
    } catch (error) {
      res.status(500).json({ error: "读取 Provider 列表失败" });
    }
  });

  router.put("/providers/current", (req: Request, res: Response) => {
    const { provider } = req.body as { provider?: string };
    if (!provider) {
      res.status(400).json({ error: "缺少 provider" });
      return;
    }
    try {
      const config = setCurrentProvider(provider);
      logger.info("provider.switched", { provider });
      res.json(config);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "切换 Provider 失败";
      res.status(400).json({ error: msg });
    }
  });

  router.get("/sandbox-config", (_req: Request, res: Response) => {
    try {
      res.json({
        ...readSandboxConfig(),
        modes: sandboxModeOptions,
      });
    } catch (error) {
      res.status(500).json({ error: "读取权限配置失败" });
    }
  });

  router.put("/sandbox-config", (req: Request, res: Response) => {
    const { defaultSandbox } = req.body as { defaultSandbox?: string };
    if (!defaultSandbox) {
      res.status(400).json({ error: "缺少 defaultSandbox" });
      return;
    }
    try {
      const config = setDefaultSandbox(defaultSandbox);
      logger.info("sandbox.switched", { sandbox: config.defaultSandbox });
      res.json({
        ...config,
        modes: sandboxModeOptions,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "保存权限配置失败";
      res.status(400).json({ error: msg });
    }
  });

  // --- Channels ---

  router.get("/channels", (_req: Request, res: Response) => {
    try {
      const config = readChannelsConfig();
      const registered = getRegisteredChannelTypes();
      res.json({ registered, config });
    } catch (error) {
      res.status(500).json({ error: "读取频道配置失败" });
    }
  });

  router.put("/channels/:type", (req: Request, res: Response) => {
    const channelType = req.params.type as string;
    const registered = getRegisteredChannelTypes();
    if (!registered.includes(channelType)) {
      res.status(400).json({ error: `不支持的频道类型: ${channelType}` });
      return;
    }
    try {
      const config = updateChannelConfig(channelType, req.body);
      logger.info("channel.config.updated", { channelType });
      res.json(config);

      channelManager.restartChannel(channelType).catch((error) => {
        logger.error("channel.restart_after_save_failed", { channelType, error });
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "更新频道配置失败";
      res.status(400).json({ error: msg });
    }
  });

  router.get("/channels/weixin/login-status", (_req: Request, res: Response) => {
    res.json(getWeixinLoginStatus());
  });

  // --- Skills ---

  router.get("/skills", (_req: Request, res: Response) => {
    try {
      res.json(listSkills());
    } catch (error) {
      res.status(500).json({ error: "读取技能列表失败" });
    }
  });

  router.put("/skills/:id/toggle", (req: Request, res: Response) => {
    const id = decodeURIComponent(req.params.id as string);
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "缺少 enabled 参数" });
      return;
    }
    try {
      const result = toggleSkill(id, enabled);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      logger.info("skill.toggled", { id, enabled });
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "切换技能状态失败" });
    }
  });

  router.delete("/skills/:id", (req: Request, res: Response) => {
    const id = decodeURIComponent(req.params.id as string);
    const result = deleteSkill(id);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    logger.info("skill.deleted", { id });
    res.json({ ok: true });
  });

  router.post("/skills/open-folder", (req: Request, res: Response) => {
    try {
      const skillPath = req.body?.path as string | undefined;
      openSkillsFolder(skillPath);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "打开文件夹失败" });
    }
  });

  // --- Proxy ---

  router.get("/proxy", (_req: Request, res: Response) => {
    try {
      res.json(readProxyConfig());
    } catch (error) {
      res.status(500).json({ error: "读取代理配置失败" });
    }
  });

  router.put("/proxy", (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<ProxyConfig>;
      const current = readProxyConfig();
      const config: ProxyConfig = {
        enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
        protocol: body.protocol === "socks5" ? "socks5" : "http",
        host: typeof body.host === "string" ? body.host.trim() : current.host,
        port: typeof body.port === "number" && body.port > 0 ? body.port : current.port,
        username: typeof body.username === "string" ? body.username : current.username,
        password: typeof body.password === "string" ? body.password : current.password,
      };
      writeProxyConfig(config);
      applyProxy(config);
      logger.info("proxy.config.updated", {
        enabled: config.enabled,
        protocol: config.protocol,
        host: config.host,
        port: config.port,
      });
      res.json(config);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "更新代理配置失败";
      res.status(400).json({ error: msg });
    }
  });

  router.post("/proxy/test", async (req: Request, res: Response) => {
    const body = req.body as Partial<ProxyConfig> | undefined;
    const testConfig: ProxyConfig = {
      enabled: true,
      protocol: body?.protocol === "socks5" ? "socks5" : "http",
      host: (typeof body?.host === "string" && body.host.trim()) || "127.0.0.1",
      port: (typeof body?.port === "number" && body.port > 0) ? body.port : 7890,
    };
    if (body?.username) testConfig.username = body.username;
    if (body?.password) testConfig.password = body.password;

    const proxyUrl = getProxyUrl(testConfig);
    if (!proxyUrl) {
      res.json({ ok: false, error: "代理地址无效" });
      return;
    }

    let agent: ProxyAgent | null = null;
    try {
      agent = new ProxyAgent(proxyUrl);
      const testUrl = "https://www.google.com/generate_204";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const start = Date.now();
      const response = await undiciFetch(testUrl, {
        dispatcher: agent,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const latency = Date.now() - start;
      res.json({ ok: response.ok || response.status === 204, latency, status: response.status });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "连接失败";
      res.json({ ok: false, error: msg });
    } finally {
      agent?.close();
    }
  });

  // --- Logs & data ---

  router.post("/logs/open", (_req: Request, res: Response) => {
    try {
      fs.mkdirSync(getLogDir(), { recursive: true });
      openDirectory(getLogDir());
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "打开日志目录失败" });
    }
  });

  router.delete("/logs", (_req: Request, res: Response) => {
    try {
      fs.rmSync(getLogDir(), { recursive: true, force: true });
      fs.mkdirSync(getLogDir(), { recursive: true });
      logger.info("logs.cleared");
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "清空日志失败" });
    }
  });

  router.post("/data/open", (_req: Request, res: Response) => {
    try {
      fs.mkdirSync(getDataDir(), { recursive: true });
      openDirectory(getDataDir());
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "打开数据目录失败" });
    }
  });

  router.delete("/data/uploads", (_req: Request, res: Response) => {
    try {
      fs.rmSync(getUploadDir(), { recursive: true, force: true });
      fs.mkdirSync(getUploadDir(), { recursive: true });
      logger.info("uploads.cleared");
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "清理上传文件失败" });
    }
  });

  router.delete("/data/history", (_req: Request, res: Response) => {
    try {
      db.deleteAllSessions();
      logger.info("history.cleared");
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "清空历史失败" });
    }
  });

  router.get("/data/export", (_req: Request, res: Response) => {
    try {
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        appSettings: readAppSettings(),
        modelConfig: readModelConfig(),
        sandboxConfig: readSandboxConfig(),
        proxyConfig: readProxyConfig(),
        channelsConfig: readChannelsConfig(),
      };
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="anybot-config-${Date.now()}.json"`);
      res.send(JSON.stringify(payload, null, 2));
    } catch (error) {
      res.status(500).json({ error: "导出配置失败" });
    }
  });

  router.put("/data/import", (req: Request, res: Response) => {
    try {
      const payload = req.body as {
        appSettings?: AppSettings;
        modelConfig?: ReturnType<typeof readModelConfig>;
        sandboxConfig?: ReturnType<typeof readSandboxConfig>;
        proxyConfig?: ProxyConfig;
        channelsConfig?: ReturnType<typeof readChannelsConfig>;
      };
      if (payload.appSettings) writeAppSettings(payload.appSettings);
      if (payload.modelConfig) writeModelConfig(payload.modelConfig);
      if (payload.sandboxConfig?.defaultSandbox) setDefaultSandbox(payload.sandboxConfig.defaultSandbox);
      if (payload.proxyConfig) {
        writeProxyConfig(payload.proxyConfig);
        applyProxy(payload.proxyConfig);
      }
      if (payload.channelsConfig) writeChannelsConfig(payload.channelsConfig);
      logger.info("data.imported");
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "导入配置失败" });
    }
  });

  // --- Change review actions ---

  router.post("/change-reviews/:id/approve", async (req: Request, res: Response) => {
    try {
      const review = await approveChangeReview(req.params.id as string);
      res.json({ ok: true, review });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "审核失败";
      res.status(404).json({ error: msg });
    }
  });

  router.post("/change-reviews/:id/revert", async (req: Request, res: Response) => {
    try {
      const review = await revertChangeReview(req.params.id as string);
      if (review.status !== "reverted") {
        res.status(409).json({ ok: false, review, error: review.error || "无法安全撤销" });
        return;
      }
      res.json({ ok: true, review });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "撤销失败";
      res.status(404).json({ error: msg });
    }
  });

  // --- Send message to owner via channel bot ---

  router.post("/send", async (req: Request, res: Response) => {
    const { channel, message } = req.body as {
      channel?: string;
      message?: string;
    };

    if (!channel) {
      res.status(400).json({ error: "缺少 channel 参数（feishu / telegram / qqbot / weixin）" });
      return;
    }
    if (!message?.trim()) {
      res.status(400).json({ error: "缺少 message 参数" });
      return;
    }

    const registered = getRegisteredChannelTypes();
    if (!registered.includes(channel)) {
      res.status(400).json({ error: `不支持的频道类型: ${channel}，可选: ${registered.join(", ")}` });
      return;
    }

    const ch = channelManager.getChannel(channel);
    if (!ch) {
      const running = channelManager.getRunningChannelTypes();
      res.status(400).json({
        error: `频道 ${channel} 未启动，当前运行中: ${running.length ? running.join(", ") : "无"}`,
      });
      return;
    }

    try {
      await ch.sendToOwner(message.trim());
      logger.info("api.send.success", { channel, messageChars: message.trim().length });
      res.json({ ok: true });
    } catch (error) {
      logger.error("api.send.failed", { channel, error });
      const msg = error instanceof Error ? error.message : "发送消息失败";
      res.status(500).json({ error: msg });
    }
  });

  // --- 文件上传 ---

  router.post("/upload", upload.single("file"), (req: Request, res: Response) => {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ error: "未收到文件" });
      return;
    }
    const absPath = path.resolve(file.path);
    logger.info("web.upload.success", { name: file.originalname, path: absPath, size: file.size });
    res.json({
      path: absPath,
      name: file.originalname,
      size: file.size,
      isImage: isImageFile(file.originalname),
    });
  });

  // --- 本地文件代理（让浏览器能访问本地图片） ---

  router.get("/local-file", (req: Request, res: Response) => {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: "缺少 path 参数" });
      return;
    }
    if (!isImageFile(filePath)) {
      res.status(403).json({ error: "只允许访问图片文件" });
      return;
    }
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      res.status(404).json({ error: "文件不存在" });
      return;
    }
    res.sendFile(resolved);
  });

  // --- Chat messages ---

  router.get("/sessions/:id/messages/stream", (req: Request, res: Response) => {
    const id = req.params.id as string;
    const session = db.getSessionMetadata(id);
    if (!session) {
      res.status(404).json({ error: "会话不存在" });
      return;
    }

    if (!attachAgentStreamClient(id, res)) {
      res.status(404).json({ error: "当前会话没有正在进行的流式响应" });
      return;
    }
  });

  router.post("/sessions/:id/messages/stream", async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const session = db.getSessionMetadata(id);
    if (!session) {
      res.status(404).json({ error: "会话不存在" });
      return;
    }

    if (hasActiveAgentStream(id)) {
      res.status(423).json({ error: "当前会话正在处理中，请稍后再发送新消息" });
      return;
    }

    const { content, attachments } = req.body as {
      content?: string;
      attachments?: { path: string; name: string }[];
    };
    if (!content?.trim() && (!attachments || attachments.length === 0)) {
      res.status(400).json({ error: "消息不能为空" });
      return;
    }

    bindSessionProvider(session);
    const provider = getSessionProvider(session);
    if (!isStreamingProvider(provider)) {
      res.status(409).json({ error: "当前会话或 Provider 不支持 Agent 流式展示" });
      return;
    }

    let sessionWorkdir: string;
    try {
      sessionWorkdir = getSessionWorkdir(session);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "项目目录不可用" });
      return;
    }

    let userText = (content || "").trim();
    const imagePaths: string[] = [];
    const filePaths: { path: string; name: string }[] = [];

    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        if (isImageFile(att.name)) {
          imagePaths.push(att.path);
        } else {
          filePaths.push(att);
        }
      }
      if (filePaths.length > 0) {
        const fileList = filePaths.map(f => `- ${f.name}: ${f.path}`).join("\n");
        userText = `${userText}\n\n用户附带了以下文件，请读取并处理：\n${fileList}`;
      }
      if (imagePaths.length > 0) {
        const imgList = imagePaths.map(p => `- ${path.basename(p)}: ${p}`).join("\n");
        userText = `${userText}\n\n用户附带了以下图片：\n${imgList}`;
      }
    }

    const attachmentInfo = (attachments || []).map(a => ({ name: a.name, path: a.path }));
    const metadata = attachmentInfo.length > 0 ? JSON.stringify({ attachments: attachmentInfo }) : null;

    db.addMessage(id, "user", content?.trim() || "[附件]", metadata);

    if (db.countMessages(id) <= 1) {
      session.title = generateTitle(content?.trim() || "文件分析");
    }
    db.updateSession({
      id,
      title: session.title,
      sessionId: session.sessionId,
      provider: session.provider,
      updatedAt: Date.now(),
    });

    const prompt = session.sessionId
      ? buildResumePrompt(userText, session.source || "web")
      : buildFirstTurnPrompt(userText, session.source || "web", {
          workdir: sessionWorkdir,
          sandbox: getSandbox(),
          includeWorkspaceMemory: !session.projectId,
        });

    const active = createActiveAgentStream(id);
    attachAgentStreamClient(id, res);

    const agentEvents: ClaudeAgentStreamEvent[] = [];
    const emit = (event: AgentStreamEvent) => {
      if (event.type !== "result" && event.type !== "error" && event.type !== "done") {
        agentEvents.push(event);
      }
      emitAgentStream(active, event);
    };

    void (async () => {
      try {
        logger.info("web.chat.stream.start", {
          sessionId: session.id,
          providerSessionId: session.sessionId,
          provider: provider.type,
          workdir: sessionWorkdir,
          userTextChars: userText.length,
          imageCount: imagePaths.length,
          fileCount: filePaths.length,
        });

        const changeSnapshot = await safeCreateChangeSnapshotForWorkdir(sessionWorkdir);
        const result = await provider.runWithEvents({
          workdir: sessionWorkdir,
          sandbox: getSandbox(),
          model: getModelForProvider(provider.type),
          prompt,
          imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
          sessionId: session.sessionId || undefined,
          newSessionId: session.sessionId ? undefined : randomUUID(),
          onEvent: emit,
        });

        const providerSessionId = result.sessionId || session.sessionId;
        const changeReview = await safeCollectChangeReview(changeSnapshot);
        if (result.contextUsage) {
          emit({
            type: "context_usage",
            usage: result.contextUsage,
          });
        }

        db.addMessage(
          id,
          "assistant",
          result.text,
          buildAssistantMetadata({
            provider: provider.type,
            events: agentEvents,
            changeReview,
          }),
        );
        db.updateSession({
          id,
          title: session.title,
          sessionId: providerSessionId,
          provider: session.provider,
          updatedAt: Date.now(),
        });

        emit({
          type: "result",
          content: result.text,
          title: session.title,
          sessionId: providerSessionId,
          provider: provider.type,
          changeReview,
          contextUsage: result.contextUsage,
        });

        logger.info("web.chat.stream.success", {
          sessionId: session.id,
          providerSessionId,
          provider: provider.type,
          replyChars: result.text.length,
        });
      } catch (error) {
        logger.error("web.chat.stream.failed", {
          sessionId: session.id,
          error,
        });
        emit({
          type: "error",
          error: error instanceof Error ? error.message : "处理消息时出错了，请稍后再试。",
        });
      } finally {
        finishAgentStream(id, active);
      }
    })();
  });

  router.post("/sessions/:id/messages", async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const session = db.getSessionMetadata(id);
    if (!session) {
      res.status(404).json({ error: "会话不存在" });
      return;
    }

    if (hasActiveAgentStream(id)) {
      res.status(423).json({ error: "当前会话正在处理中，请稍后再发送新消息" });
      return;
    }

    const { content, attachments } = req.body as {
      content?: string;
      attachments?: { path: string; name: string }[];
    };
    if (!content?.trim() && (!attachments || attachments.length === 0)) {
      res.status(400).json({ error: "消息不能为空" });
      return;
    }

    let sessionWorkdir: string;
    try {
      sessionWorkdir = getSessionWorkdir(session);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "项目目录不可用" });
      return;
    }

    // 构建包含附件信息的用户文本
    let userText = (content || "").trim();
    const imagePaths: string[] = [];
    const filePaths: { path: string; name: string }[] = [];

    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        if (isImageFile(att.name)) {
          imagePaths.push(att.path);
        } else {
          filePaths.push(att);
        }
      }
      // 非图片文件信息拼接到 prompt
      if (filePaths.length > 0) {
        const fileList = filePaths.map(f => `- ${f.name}: ${f.path}`).join("\n");
        userText = `${userText}\n\n用户附带了以下文件，请读取并处理：\n${fileList}`;
      }
      // 图片文件也补充提示
      if (imagePaths.length > 0) {
        const imgList = imagePaths.map(p => `- ${path.basename(p)}: ${p}`).join("\n");
        userText = `${userText}\n\n用户附带了以下图片：\n${imgList}`;
      }
    }

    // 构建 metadata（附件信息：名称 + 路径）
    const attachmentInfo = (attachments || []).map(a => ({ name: a.name, path: a.path }));
    const metadata = attachmentInfo.length > 0 ? JSON.stringify({ attachments: attachmentInfo }) : null;

    db.addMessage(id, "user", content?.trim() || "[附件]", metadata);

    if (db.countMessages(id) <= 1) {
      session.title = generateTitle(content?.trim() || "文件分析");
    }

    bindSessionProvider(session);

    const prompt = session.sessionId
      ? buildResumePrompt(userText, session.source || "web")
      : buildFirstTurnPrompt(userText, session.source || "web", {
          workdir: sessionWorkdir,
          sandbox: getSandbox(),
          includeWorkspaceMemory: !session.projectId,
        });

    try {
      const provider = getSessionProvider(session);
      logger.info("web.chat.start", {
        sessionId: session.id,
        providerSessionId: session.sessionId,
        provider: provider.type,
        workdir: sessionWorkdir,
        userTextChars: userText.length,
        imageCount: imagePaths.length,
        fileCount: filePaths.length,
      });

      const changeSnapshot = await safeCreateChangeSnapshotForWorkdir(sessionWorkdir);
      const result = await provider.run({
        workdir: sessionWorkdir,
        sandbox: getSandbox(),
        model: getModelForProvider(provider.type),
        prompt,
        imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
        sessionId: session.sessionId || undefined,
        newSessionId: session.sessionId ? undefined : randomUUID(),
      });

      const providerSessionId = result.sessionId || session.sessionId;
      const changeReview = await safeCollectChangeReview(changeSnapshot);
      db.addMessage(
        id,
        "assistant",
        result.text,
        buildAssistantMetadata({ provider: provider.type, changeReview }),
      );
      db.updateSession({
        id,
        title: session.title,
        sessionId: providerSessionId,
        provider: session.provider,
        updatedAt: Date.now(),
      });

      logger.info("web.chat.success", {
        sessionId: session.id,
        providerSessionId,
        provider: provider.type,
        replyChars: result.text.length,
      });

      res.json({
        role: "assistant",
        content: result.text,
        title: session.title,
        provider: provider.type,
        changeReview,
        contextUsage: result.contextUsage,
      });
    } catch (error) {
      logger.error("web.chat.failed", {
        sessionId: session.id,
        error,
      });

      const errorMessage =
        error instanceof Error ? error.message : "处理消息时出错了，请稍后再试。";
      res.status(500).json({ error: errorMessage });
    }
  });

  return router;
}
