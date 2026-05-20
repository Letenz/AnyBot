import crypto from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleCommand } from "./commands.js";
import { readChannelConfig, updateChannelConfig } from "./config.js";
import type { ChannelCallbacks, IChannel, WeixinChannelConfig } from "./types.js";
import { logger } from "../logger.js";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const FIXED_LOGIN_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_BOT_TYPE = "3";
const DEFAULT_BOT_AGENT = "AnyBot/0.1.0";
const CHANNEL_VERSION = "2.4.3";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION);
const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 8 * 60_000;
const SESSION_EXPIRED_ERRCODE = -14;
const dataDir = process.env.DATA_DIR || process.env.CODEX_DATA_DIR || path.resolve(__dirname, "../../.data");
const SYNC_PATH = path.join(dataDir, "weixin-sync.json");

const MessageItemType = {
  TEXT: 1,
  VOICE: 3,
} as const;

const MessageType = {
  USER: 1,
  BOT: 2,
} as const;

const MessageState = {
  FINISH: 2,
} as const;

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

type QRStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

interface StatusResponse {
  status: QRStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
}

interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

interface LoginResult {
  accountId: string;
  token: string;
  baseUrl: string;
  ownerChatId?: string;
}

export interface WeixinLoginStatus {
  state: "idle" | "pending" | "scanned" | "waiting_code" | "confirmed" | "failed";
  message: string;
  qrcodeUrl?: string;
  qrcodeDataUrl?: string;
  startedAt?: number;
  updatedAt?: number;
}

let loginStatus: WeixinLoginStatus = {
  state: "idle",
  message: "微信频道未开始登录",
};

export function getWeixinLoginStatus(): WeixinLoginStatus {
  return loginStatus;
}

export class WeixinChannel implements IChannel {
  readonly type = "weixin";

  private config: WeixinChannelConfig | null = null;
  private callbacks: ChannelCallbacks | null = null;
  private stopped = true;
  private pollAbort: AbortController | null = null;
  private contextTokens = new Map<string, string>();
  private getUpdatesBuf = "";

  async start(callbacks: ChannelCallbacks): Promise<boolean> {
    const config = readChannelConfig<WeixinChannelConfig>("weixin");
    if (!config?.enabled) {
      logger.info("weixin.skipped", { reason: "disabled or missing config" });
      return false;
    }

    this.callbacks = callbacks;
    this.config = normalizeConfig(config);
    this.stopped = false;
    this.getUpdatesBuf = loadSyncBuf();

    if (!this.config.token?.trim() || !this.config.accountId?.trim()) {
      logger.warn("weixin.login_required", {
        message: "微信频道未绑定，正在输出二维码，请用个人微信扫码确认",
      });
      const login = await this.loginWithQr();
      this.config = {
        ...this.config,
        accountId: login.accountId,
        token: login.token,
        baseUrl: login.baseUrl || this.config.baseUrl || DEFAULT_BASE_URL,
        ownerChatId: this.config.ownerChatId || login.ownerChatId || "",
      };
      updateChannelConfig("weixin", {
        accountId: this.config.accountId,
        token: this.config.token,
        baseUrl: this.config.baseUrl,
        ownerChatId: this.config.ownerChatId,
      });
      logger.info("weixin.login_saved", {
        accountId: this.config.accountId,
        ownerChatId: this.config.ownerChatId,
      });
    }

    await this.notifyStart();
    void this.pollLoop();
    logger.info("weixin.started", {
      accountId: this.config.accountId,
      ownerChatId: this.config.ownerChatId,
    });
    return true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pollAbort?.abort();
    this.pollAbort = null;
    await this.notifyStop();
    logger.info("weixin.stopped");
  }

  async sendToOwner(text: string): Promise<void> {
    if (!this.config?.token) {
      throw new Error("Weixin channel is not started");
    }
    const ownerChatId = this.config.ownerChatId?.trim();
    if (!ownerChatId) {
      throw new Error("微信 ownerChatId 未设置，请先给 AnyBot 发一条微信消息");
    }
    await this.sendText(ownerChatId, text, this.contextTokens.get(ownerChatId));
  }

  private async loginWithQr(): Promise<LoginResult> {
    const botType = this.config?.botType || DEFAULT_BOT_TYPE;
    let qr: QRCodeResponse;
    let qrcodeDataUrl: string | undefined;
    try {
      qr = await this.fetchQRCode(botType);
      qrcodeDataUrl = await generateQRCodeDataUrl(qr.qrcode_img_content);
    } catch (error) {
      const message = `微信二维码生成失败：${error instanceof Error ? error.message : String(error)}`;
      setWeixinLoginStatus({ state: "failed", message });
      throw error;
    }
    setWeixinLoginStatus({
      state: "pending",
      message: "请用个人微信扫码绑定 AnyBot",
      qrcodeUrl: qr.qrcode_img_content,
      qrcodeDataUrl,
      startedAt: Date.now(),
    });
    logger.info("weixin.login.qr_url", { url: qr.qrcode_img_content });
    console.log("\n[AnyBot 微信] 请用个人微信扫描以下二维码完成绑定：\n");
    displayQRCode(qr.qrcode_img_content);
    console.log("\n如果终端二维码不可用，请打开这个链接：");
    console.log(qr.qrcode_img_content);

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let currentBaseUrl = FIXED_LOGIN_BASE_URL;
    let verifyCode: string | undefined;
    let scannedPrinted = false;

    while (Date.now() < deadline && !this.stopped) {
      const status = await this.pollQRStatus(currentBaseUrl, qr.qrcode, verifyCode);
      switch (status.status) {
        case "wait":
          break;
        case "scaned":
          verifyCode = undefined;
          if (!scannedPrinted) {
            setWeixinLoginStatus({
              state: "scanned",
              message: "已扫码，请在手机微信上确认",
            });
            console.log("[AnyBot 微信] 已扫码，等待手机确认...");
            scannedPrinted = true;
          }
          break;
        case "need_verifycode":
          setWeixinLoginStatus({
            state: "waiting_code",
            message: "手机微信要求输入数字验证码，请在终端输入",
          });
          verifyCode = await readVerifyCodeFromStdin(
            verifyCode ? "验证码不匹配，请重新输入手机微信显示的数字：" : "请输入手机微信显示的数字：",
          );
          break;
        case "scaned_but_redirect":
          if (status.redirect_host) {
            currentBaseUrl = `https://${status.redirect_host}`;
            logger.info("weixin.login.redirect", { host: status.redirect_host });
          }
          break;
        case "verify_code_blocked":
          setWeixinLoginStatus({ state: "failed", message: "微信扫码验证码多次错误，请稍后重试" });
          throw new Error("微信扫码验证码多次错误，请稍后重试");
        case "expired":
          setWeixinLoginStatus({ state: "failed", message: "微信登录二维码已过期，请重启 AnyBot 后重新扫码" });
          throw new Error("微信登录二维码已过期，请重启 AnyBot 后重新扫码");
        case "binded_redirect":
          setWeixinLoginStatus({
            state: "failed",
            message: "此微信已绑定过，但本地没有可用 token，请重新发起绑定或清理旧绑定后再试",
          });
          throw new Error("此微信已绑定过，但本地没有可用 token，请重新发起绑定或清理旧绑定后再试");
        case "confirmed":
          if (!status.bot_token || !status.ilink_bot_id) {
            setWeixinLoginStatus({
              state: "failed",
              message: "微信登录成功但服务端未返回 bot_token 或 ilink_bot_id",
            });
            throw new Error("微信登录成功但服务端未返回 bot_token 或 ilink_bot_id");
          }
          setWeixinLoginStatus({
            state: "confirmed",
            message: "微信绑定成功",
          });
          console.log("[AnyBot 微信] 绑定成功。");
          return {
            accountId: status.ilink_bot_id,
            token: status.bot_token,
            baseUrl: status.baseurl || currentBaseUrl || DEFAULT_BASE_URL,
            ownerChatId: status.ilink_user_id,
          };
      }
      await sleep(1000);
    }

    setWeixinLoginStatus({ state: "failed", message: "微信登录超时，请重启 AnyBot 后重新扫码" });
    throw new Error("微信登录超时，请重启 AnyBot 后重新扫码");
  }

  private async pollLoop(): Promise<void> {
    let consecutiveFailures = 0;
    let nextTimeoutMs = LONG_POLL_TIMEOUT_MS;

    while (!this.stopped && this.config?.token) {
      this.pollAbort = new AbortController();
      try {
        const resp = await this.getUpdates(nextTimeoutMs, this.pollAbort.signal);
        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
          nextTimeoutMs = resp.longpolling_timeout_ms;
        }

        const failed =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0);
        if (failed) {
          consecutiveFailures += 1;
          logger.warn("weixin.getupdates.failed", {
            ret: resp.ret,
            errcode: resp.errcode,
            errmsg: resp.errmsg,
            consecutiveFailures,
          });
          if (resp.ret === SESSION_EXPIRED_ERRCODE || resp.errcode === SESSION_EXPIRED_ERRCODE) {
            logger.error("weixin.session_expired", {
              message: "微信登录态已失效，请清空 token 后重启并重新扫码",
            });
            await sleep(60_000);
          } else {
            await sleep(consecutiveFailures >= 3 ? 30_000 : 2_000);
          }
          continue;
        }

        consecutiveFailures = 0;
        if (resp.get_updates_buf) {
          this.getUpdatesBuf = resp.get_updates_buf;
          saveSyncBuf(this.getUpdatesBuf);
        }

        for (const msg of resp.msgs ?? []) {
          await this.handleMessage(msg);
        }
      } catch (error) {
        if (this.stopped) return;
        if (error instanceof Error && error.name === "AbortError") {
          continue;
        }
        consecutiveFailures += 1;
        logger.error("weixin.poll.error", { error, consecutiveFailures });
        await sleep(consecutiveFailures >= 3 ? 30_000 : 2_000);
      } finally {
        this.pollAbort = null;
      }
    }
  }

  private async handleMessage(message: WeixinMessage): Promise<void> {
    if (!this.callbacks || !this.config) return;
    if (message.message_type === MessageType.BOT) return;

    const chatId = message.from_user_id?.trim();
    if (!chatId) {
      logger.warn("weixin.message.no_chat_id", { messageId: message.message_id });
      return;
    }

    if (message.context_token) {
      this.contextTokens.set(chatId, message.context_token);
    }

    if (!this.config.ownerChatId) {
      this.config.ownerChatId = chatId;
      updateChannelConfig("weixin", { ownerChatId: chatId });
      logger.info("weixin.owner_auto_saved", { chatId });
    }

    const userText = extractText(message).trim();
    logger.info("weixin.message.received", {
      chatId,
      messageId: message.message_id,
      textChars: userText.length,
    });

    if (!userText) {
      await this.sendText(chatId, "当前微信频道暂只支持文本消息。", message.context_token);
      return;
    }

    const cmd = handleCommand(userText, chatId, "weixin", this.callbacks);
    if (cmd.handled) {
      if (cmd.reply) await this.sendText(chatId, cmd.reply, message.context_token);
      return;
    }

    try {
      const reply = await this.callbacks.generateReply(chatId, userText, undefined, "weixin");
      await this.sendText(chatId, reply, message.context_token);
    } catch (error) {
      logger.error("weixin.text.failed", { chatId, error });
      await this.sendText(chatId, `处理失败：${error instanceof Error ? error.message : String(error)}`, message.context_token);
    }
  }

  private async fetchQRCode(botType: string): Promise<QRCodeResponse> {
    const raw = await apiPost({
      baseUrl: FIXED_LOGIN_BASE_URL,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      body: { local_token_list: [] },
      botAgent: this.config?.botAgent,
      label: "weixin.fetch_qrcode",
      timeoutMs: API_TIMEOUT_MS,
    });
    return JSON.parse(raw) as QRCodeResponse;
  }

  private async pollQRStatus(
    baseUrl: string,
    qrcode: string,
    verifyCode?: string,
  ): Promise<StatusResponse> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    try {
      const raw = await apiGet({
        baseUrl,
        endpoint,
        label: "weixin.poll_qr",
        timeoutMs: LONG_POLL_TIMEOUT_MS,
      });
      return JSON.parse(raw) as StatusResponse;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { status: "wait" };
      }
      logger.warn("weixin.poll_qr.retry", { error });
      return { status: "wait" };
    }
  }

  private async getUpdates(timeoutMs: number, signal: AbortSignal): Promise<GetUpdatesResp> {
    const raw = await apiPost({
      baseUrl: this.config!.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: {
        get_updates_buf: this.getUpdatesBuf,
        base_info: buildBaseInfo(this.config?.botAgent),
      },
      token: this.config!.token,
      botAgent: this.config?.botAgent,
      label: "weixin.getupdates",
      timeoutMs,
      signal,
    });
    return JSON.parse(raw) as GetUpdatesResp;
  }

  private async sendText(to: string, text: string, contextToken?: string): Promise<void> {
    if (!this.config?.token) {
      throw new Error("Weixin channel is not started");
    }
    const clientId = `anybot-weixin:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    await apiPost({
      baseUrl: this.config.baseUrl,
      endpoint: "ilink/bot/sendmessage",
      body: {
        msg: {
          from_user_id: "",
          to_user_id: to,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: text
            ? [{ type: MessageItemType.TEXT, text_item: { text } }]
            : undefined,
          context_token: contextToken || this.contextTokens.get(to) || undefined,
        },
        base_info: buildBaseInfo(this.config.botAgent),
      },
      token: this.config.token,
      botAgent: this.config.botAgent,
      label: "weixin.sendmessage",
      timeoutMs: API_TIMEOUT_MS,
    });
    logger.info("weixin.send_text.success", { to, clientId });
  }

  private async notifyStart(): Promise<void> {
    if (!this.config?.token) return;
    try {
      await apiPost({
        baseUrl: this.config.baseUrl,
        endpoint: "ilink/bot/msg/notifystart",
        body: { base_info: buildBaseInfo(this.config.botAgent) },
        token: this.config.token,
        botAgent: this.config.botAgent,
        label: "weixin.notifystart",
        timeoutMs: 10_000,
      });
    } catch (error) {
      logger.warn("weixin.notifystart.failed", { error });
    }
  }

  private async notifyStop(): Promise<void> {
    if (!this.config?.token) return;
    try {
      await apiPost({
        baseUrl: this.config.baseUrl,
        endpoint: "ilink/bot/msg/notifystop",
        body: { base_info: buildBaseInfo(this.config.botAgent) },
        token: this.config.token,
        botAgent: this.config.botAgent,
        label: "weixin.notifystop",
        timeoutMs: 10_000,
      });
    } catch (error) {
      logger.warn("weixin.notifystop.failed", { error });
    }
  }
}

function normalizeConfig(config: WeixinChannelConfig): WeixinChannelConfig {
  return {
    ...config,
    baseUrl: config.baseUrl?.trim() || DEFAULT_BASE_URL,
    botType: config.botType?.trim() || DEFAULT_BOT_TYPE,
    botAgent: config.botAgent?.trim() || DEFAULT_BOT_AGENT,
    accountId: config.accountId?.trim() || "",
    token: config.token?.trim() || "",
    ownerChatId: config.ownerChatId?.trim() || "",
  };
}

async function apiGet(params: {
  baseUrl: string;
  endpoint: string;
  timeoutMs: number;
  label: string;
}): Promise<string> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(new URL(params.endpoint, ensureTrailingSlash(params.baseUrl)), {
      method: "GET",
      headers: buildCommonHeaders(),
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`${params.label} ${res.status}: ${raw}`);
    return raw;
  } finally {
    clearTimeout(t);
  }
}

async function apiPost(params: {
  baseUrl: string;
  endpoint: string;
  body: unknown;
  token?: string;
  botAgent?: string;
  timeoutMs: number;
  label: string;
  signal?: AbortSignal;
}): Promise<string> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (params.signal?.aborted) controller.abort();
  params.signal?.addEventListener("abort", abortFromParent, { once: true });
  const t = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(new URL(params.endpoint, ensureTrailingSlash(params.baseUrl)), {
      method: "POST",
      headers: buildHeaders(params.token),
      body: JSON.stringify(params.body),
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`${params.label} ${res.status}: ${raw}`);
    return raw;
  } finally {
    clearTimeout(t);
    params.signal?.removeEventListener("abort", abortFromParent);
  }
}

function buildHeaders(token?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(),
    ...(token?.trim() ? { Authorization: `Bearer ${token.trim()}` } : {}),
  };
}

function buildCommonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
}

function buildBaseInfo(botAgent?: string): Record<string, string> {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: sanitizeBotAgent(botAgent),
  };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildClientVersion(version: string): number {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function sanitizeBotAgent(raw?: string): string {
  const value = raw?.trim() || DEFAULT_BOT_AGENT;
  return /^[\x20-\x7E]{1,256}$/.test(value) ? value : DEFAULT_BOT_AGENT;
}

function extractText(message: WeixinMessage): string {
  const parts: string[] = [];
  for (const item of message.item_list ?? []) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      parts.push(item.text_item.text);
    } else if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      parts.push(item.voice_item.text);
    }
  }
  return parts.join("\n");
}

function displayQRCode(qrcodeUrl: string): void {
  try {
    const qrterm = require("qrcode-terminal") as {
      generate: (input: string, opts?: { small?: boolean }) => void;
    };
    qrterm.generate(qrcodeUrl, { small: true });
  } catch {
    // The URL is printed by the caller as a fallback.
  }
}

async function generateQRCodeDataUrl(qrcodeUrl: string): Promise<string | undefined> {
  try {
    const qrcode = require("qrcode") as {
      toDataURL: (input: string, opts?: Record<string, unknown>) => Promise<string>;
    };
    return await qrcode.toDataURL(qrcodeUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 260,
      color: { dark: "#111827", light: "#ffffff" },
    });
  } catch (error) {
    logger.warn("weixin.qrcode_data_url.failed", { error });
    return undefined;
  }
}

function setWeixinLoginStatus(next: Partial<WeixinLoginStatus>): void {
  loginStatus = {
    ...loginStatus,
    ...next,
    updatedAt: Date.now(),
  };
}

async function readVerifyCodeFromStdin(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let input = "";
    const onData = (chunk: Buffer | string) => {
      input += chunk.toString();
      if (input.includes("\n")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(input.trim());
      }
    };
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", onData);
  });
}

function loadSyncBuf(): string {
  try {
    if (!existsSync(SYNC_PATH)) return "";
    const parsed = JSON.parse(readFileSync(SYNC_PATH, "utf-8")) as { get_updates_buf?: string };
    return typeof parsed.get_updates_buf === "string" ? parsed.get_updates_buf : "";
  } catch {
    return "";
  }
}

function saveSyncBuf(getUpdatesBuf: string): void {
  mkdirSync(path.dirname(SYNC_PATH), { recursive: true });
  writeFileSync(SYNC_PATH, JSON.stringify({ get_updates_buf: getUpdatesBuf }, null, 0), "utf-8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
