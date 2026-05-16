import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Request, Response } from "express";
import { getProvider, getRegisteredProviderTypes } from "../providers/index.js";
import { logger } from "../logger.js";
import * as db from "./db.js";
import {
  readModelConfig,
  getCurrentModel,
  setCurrentModel,
  setCurrentProvider,
  getProviderTypes,
} from "./model-config.js";
import {
  readChannelsConfig,
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

const execFile = promisify(execFileCallback);

// 图片扩展名集合
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico", ".tiff", ".tif", ".heic", ".heif", ".avif"]);

function isImageFile(filePath: string): boolean {
  return IMAGE_EXTS.has(path.extname(filePath).toLowerCase());
}

function writeSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function isStreamingProvider(
  provider: ReturnType<typeof getProvider>,
): provider is IProvider & Required<Pick<IProvider, "runWithEvents">> {
  return typeof provider.runWithEvents === "function";
}

function buildAssistantMetadata(opts: {
  provider?: string;
  events?: ClaudeAgentStreamEvent[];
  changeReview?: PublicChangeReview | null;
}): string | null {
  const metadata: Record<string, unknown> = {};
  if (opts.provider && opts.events) {
    metadata.claudeAgentLoop = {
      version: 1,
      provider: opts.provider,
      events: opts.events,
    };
  }
  if (opts.changeReview) {
    metadata.changeReview = opts.changeReview;
  }
  return Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
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

type AgentStreamEvent =
  | ClaudeAgentStreamEvent
  | {
      type: "result";
      content: string;
      title: string;
      sessionId: string | null;
      changeReview?: PublicChangeReview | null;
    }
  | { type: "error"; error: string }
  | { type: "done" };

type ActiveAgentStream = {
  events: AgentStreamEvent[];
  clients: Set<Response>;
  startedAt: number;
  done: boolean;
};

const activeAgentStreams = new Map<string, ActiveAgentStream>();

function emitAgentStream(active: ActiveAgentStream, event: AgentStreamEvent): void {
  active.events.push(event);
  for (const client of active.clients) {
    if (client.writableEnded) continue;
    writeSse(client, event.type, event);
  }
}

function attachAgentStreamClient(res: Response, active: ActiveAgentStream): void {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  active.clients.add(res);
  res.on("close", () => {
    active.clients.delete(res);
  });

  for (const event of active.events) {
    if (res.writableEnded) break;
    writeSse(res, event.type, event);
  }

  if (active.done && !res.writableEnded) {
    res.end();
  }
}

function finishAgentStream(sessionId: string, active: ActiveAgentStream): void {
  if (!active.done) {
    active.done = true;
    emitAgentStream(active, { type: "done" });
  }
  for (const client of active.clients) {
    if (!client.writableEnded) client.end();
  }
  active.clients.clear();
  activeAgentStreams.delete(sessionId);
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

async function pickProjectFolder(): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("当前系统暂不支持从浏览器唤起本地文件夹选择器");
  }
  const { stdout } = await execFile("osascript", [
    "-e",
    'POSIX path of (choose folder with prompt "选择项目文件夹")',
  ]);
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

function getSessionWorkdir(session: db.ChatSession): string {
  if (!session.projectId) return getWorkdir();
  const project = db.getProject(session.projectId);
  if (!project) {
    throw new Error("项目不存在");
  }
  return normalizeProjectPath(project.path);
}

// 上传目录：使用配置的工作目录
const UPLOAD_DIR = path.join(getWorkdir(), "tmp", "uploads");
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) {}

// multer 配置：保留原始扩展名
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    // 每次上传时确保目录存在（防止运行中被删除）
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
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
      source: "web",
      chatId: null,
      projectId: projectId || null,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    db.createSession(session);
    res.json({ id: session.id, title: session.title });
  });

  router.get("/sessions/:id", async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const session = db.getSession(id);
    if (!session) {
      res.status(404).json({ error: "会话不存在" });
      return;
    }
    res.json({
      id: session.id,
      title: session.title,
      projectId: session.projectId,
      messages: await hydrateChangeReviewMetadata(session.messages),
      activeStream: activeAgentStreams.has(session.id)
        ? { startedAt: activeAgentStreams.get(session.id)?.startedAt }
        : null,
    });
  });

  router.delete("/sessions/:id", (req: Request, res: Response) => {
    const id = req.params.id as string;
    db.deleteSession(id);
    res.json({ ok: true });
  });

  // --- Model & Provider config ---

  router.get("/model-config", (_req: Request, res: Response) => {
    try {
      res.json(readModelConfig());
    } catch (error) {
      res.status(500).json({ error: "读取模型配置失败" });
    }
  });

  router.put("/model-config", (req: Request, res: Response) => {
    const { modelId } = req.body as { modelId?: string };
    if (!modelId) {
      res.status(400).json({ error: "缺少 modelId" });
      return;
    }
    try {
      const config = setCurrentModel(modelId);
      logger.info("model.switched", { modelId });
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
    const session = db.getSession(id);
    if (!session) {
      res.status(404).json({ error: "会话不存在" });
      return;
    }

    const active = activeAgentStreams.get(id);
    if (!active) {
      res.status(404).json({ error: "当前会话没有正在进行的流式响应" });
      return;
    }

    attachAgentStreamClient(res, active);
  });

  router.post("/sessions/:id/messages/stream", async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const session = db.getSession(id);
    if (!session) {
      res.status(404).json({ error: "会话不存在" });
      return;
    }

    if (activeAgentStreams.has(id)) {
      res.status(423).json({ error: "当前会话正在处理中，请稍后再发送新消息" });
      return;
    }

    const provider = getProvider();
    if (session.source !== "web" || !isStreamingProvider(provider)) {
      res.status(409).json({ error: "当前会话或 Provider 不支持 Agent 流式展示" });
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

    if (session.messages.length <= 1) {
      session.title = generateTitle(content?.trim() || "文件分析");
    }
    db.updateSession({
      id,
      title: session.title,
      sessionId: session.sessionId,
      updatedAt: Date.now(),
    });

    const prompt = session.sessionId
      ? buildResumePrompt(userText)
      : buildFirstTurnPrompt(userText, "web", { workdir: sessionWorkdir, sandbox: getSandbox() });

    const active: ActiveAgentStream = {
      events: [],
      clients: new Set(),
      startedAt: Date.now(),
      done: false,
    };
    activeAgentStreams.set(id, active);
    attachAgentStreamClient(res, active);

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
          model: getCurrentModel(),
          prompt,
          imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
          sessionId: session.sessionId || undefined,
          newSessionId: session.sessionId ? undefined : randomUUID(),
          onEvent: emit,
        });

        const providerSessionId = result.sessionId || session.sessionId;
        const changeReview = await safeCollectChangeReview(changeSnapshot);
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
          updatedAt: Date.now(),
        });

        emit({
          type: "result",
          content: result.text,
          title: session.title,
          sessionId: providerSessionId,
          changeReview,
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
    const session = db.getSession(id);
    if (!session) {
      res.status(404).json({ error: "会话不存在" });
      return;
    }

    if (activeAgentStreams.has(id)) {
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

    if (session.messages.length <= 1) {
      session.title = generateTitle(content?.trim() || "文件分析");
    }

    const prompt = session.sessionId
      ? buildResumePrompt(userText)
      : buildFirstTurnPrompt(userText, "web", { workdir: sessionWorkdir, sandbox: getSandbox() });

    try {
      const provider = getProvider();
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
        model: getCurrentModel(),
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
        buildAssistantMetadata({ changeReview }),
      );
      db.updateSession({
        id,
        title: session.title,
        sessionId: providerSessionId,
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
        changeReview,
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
