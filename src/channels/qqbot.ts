import type { QQBotChannelConfig, IChannel, ChannelCallbacks } from "./types.js";
import { readChannelConfig, updateChannelConfig } from "./config.js";
import { logger } from "../logger.js";
import { sanitizeUserText } from "../message.js";
import type { AgentStreamEvent } from "../web/agent-stream.js";
import { handleCommand } from "./commands.js";
import WebSocket from "ws";

const QQ_OAUTH_URL = "https://bots.qq.com/app/getAppAccessToken";
const QQ_GATEWAY_URL = "https://api.sgroup.qq.com/gateway";
const QQ_BASE_API = "https://api.sgroup.qq.com";
const QQ_C2C_STREAM_INTERVAL_MS = 500;
const QQ_C2C_STREAM_INPUT_STATE_GENERATING = 1;
const QQ_C2C_STREAM_INPUT_STATE_DONE = 10;
const QQ_STREAM_MIN_CHARS = 120;
const QQ_STREAM_MAX_CHARS = 1200;
const QQ_STREAM_MIN_INTERVAL_MS = 1500;

type QQStreamResponse = {
  id?: string;
  [key: string]: unknown;
};

function markdownToPlainText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/```[\w-]*\n([\s\S]*?)```/g, (_match, code: string) => code.trim())
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!\[([^\]]*)]\(([^)\n]+)\)/g, (_match, alt: string, url: string) => alt || url)
    .replace(/\[([^\]]+)]\(([^)\n]+)\)/g, (_match, label: string, url: string) => {
      const trimmedLabel = label.trim();
      const trimmedUrl = url.trim();
      return trimmedLabel && trimmedLabel !== trimmedUrl ? `${trimmedLabel} (${trimmedUrl})` : trimmedUrl;
    })
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "- ")
    .replace(/^\s*\d+\.\s+/gm, (match) => match.trimStart())
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function mergeStreamedAndFinalText(streamed: string, finalText: string): string {
  const streamedTrimmed = streamed.trim();
  const finalTrimmed = finalText.trim();

  if (!streamedTrimmed) return finalText;
  if (!finalTrimmed) return streamed;
  if (streamedTrimmed === finalTrimmed) return finalText;
  if (finalText.startsWith(streamed) || finalText.includes(streamed)) return finalText;
  if (streamed.endsWith(finalText) || streamed.includes(finalText)) return streamed;

  return `${streamed.replace(/\s+$/, "")}\n\n${finalText.trimStart()}`;
}

function takeStreamChunk(buffer: string, force = false): { chunk: string; rest: string } | null {
  if (!buffer.trim()) return null;
  if (!force && buffer.length < QQ_STREAM_MIN_CHARS) return null;

  const maxCut = Math.min(buffer.length, QQ_STREAM_MAX_CHARS);
  let cut = force ? buffer.length : -1;
  if (!force) {
    const search = buffer.slice(0, maxCut);
    const boundaryCandidates = [
      search.lastIndexOf("\n\n") + 2,
      search.lastIndexOf("\n") + 1,
      Math.max(
        search.lastIndexOf("。") + 1,
        search.lastIndexOf("！") + 1,
        search.lastIndexOf("？") + 1,
        search.lastIndexOf(". ") + 2,
        search.lastIndexOf("! ") + 2,
        search.lastIndexOf("? ") + 2,
      ),
    ];
    cut = boundaryCandidates.find((candidate) => candidate >= QQ_STREAM_MIN_CHARS) || -1;
    if (cut < QQ_STREAM_MIN_CHARS) {
      if (buffer.length < QQ_STREAM_MAX_CHARS) return null;
      cut = maxCut;
    }
  }

  const chunk = buffer.slice(0, cut).trim();
  const rest = buffer.slice(cut).trimStart();
  return chunk ? { chunk, rest } : null;
}

export class QQBotChannel implements IChannel {
  readonly type = "qqbot";

  private config: QQBotChannelConfig | null = null;
  private callbacks: ChannelCallbacks | null = null;
  private ws: WebSocket | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private stopping = false;
  private lastSeq: number | null = null;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private queueByChat = new Map<string, Promise<void>>();

  async start(callbacks: ChannelCallbacks): Promise<boolean> {
    const config = readChannelConfig<QQBotChannelConfig>("qqbot");
    if (!config || !config.enabled) {
      logger.info("qqbot.skipped", { reason: "disabled or missing config" });
      return false;
    }
    if (!config.appId || !config.appSecret) {
      logger.warn("qqbot.skipped", { reason: "missing appId or appSecret" });
      return false;
    }

    this.config = config;
    this.callbacks = callbacks;
    this.stopping = false;
    this.reconnectAttempts = 0;
    
    try {
      await this.connect();
      return true;
    } catch (e) {
      logger.error("qqbot.start_failed", { error: e });
      return false;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch (error) {
        logger.warn("qqbot.ws_close_failed", { error });
      }
      this.ws = null;
    }
    this.callbacks = null;
    this.config = null;
    logger.info("qqbot.stopped");
  }

  private clearHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopping || !this.config || !this.callbacks || this.reconnectTimer) return;

    const attempt = this.reconnectAttempts + 1;
    const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectAttempts = attempt;
    logger.warn("qqbot.reconnect_scheduled", { attempt, delayMs });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopping || !this.config || !this.callbacks) return;

      this.connect().catch((error) => {
        logger.error("qqbot.reconnect_failed", { attempt, error });
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private async getValidToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 5 * 60 * 1000) {
      return this.accessToken;
    }
    
    logger.info("qqbot.fetching_token", { appId: this.config!.appId });
    const response = await fetch(QQ_OAUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        appId: this.config!.appId, 
        clientSecret: this.config!.appSecret 
      })
    });
    
    if (!response.ok) {
        throw new Error(`Failed to fetch AccessToken: HTTP ${response.status}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    if (!data.access_token) {
      throw new Error(`Failed to get access_token: body is missing token`);
    }

    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in * 1000);
    logger.info("qqbot.token_fetched");
    return this.accessToken;
  }

  private async connect(): Promise<void> {
    const token = await this.getValidToken();

    const gwRes = await fetch(QQ_GATEWAY_URL, {
      headers: { "Authorization": `QQBot ${token}` }
    });
    
    if (!gwRes.ok) {
        throw new Error(`Failed to fetch gateway: HTTP ${gwRes.status}`);
    }
    
    const gwData = await gwRes.json() as { url: string };
    const wsUrl = gwData.url;

    logger.info("qqbot.ws_connecting", { url: wsUrl });

    this.clearHeartbeat();
    const socket = new WebSocket(wsUrl);
    this.ws = socket;

    socket.on("open", () => {
      logger.info("qqbot.ws_opened");
    });

    socket.on("message", (data: any) => {
      const payloadString = data.toString();
      let payload: any;
      try {
          payload = JSON.parse(payloadString);
      } catch (e) {
          return;
      }
      
      if (payload.s) {
          this.lastSeq = payload.s;
      }

      const op = payload.op;
      const t = payload.t;

      if (op === 10) {
        // Hello
        const interval = payload.d.heartbeat_interval;
        logger.info("qqbot.ws_hello", { heartbeatInterval: interval });
        
        // 发送 Identify, 请求公域与频道的普通消息以及私信
        socket.send(JSON.stringify({
          op: 2,
          d: {
            token: `QQBot ${this.accessToken}`,
            intents: (1 << 30) | (1 << 12) | (1 << 25), // PUBLIC_GUILD_MESSAGES, DIRECT_MESSAGE, GROUP_AND_C2C
            shard: [0, 1]
          }
        }));

        this.heartbeatInterval = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ op: 1, d: this.lastSeq }));
          }
        }, interval);
      } else if (op === 0 && t === "READY") {
        this.reconnectAttempts = 0;
        logger.info("qqbot.started", { user: payload.d.user });
      } else if (op === 0 && (t === "DIRECT_MESSAGE_CREATE" || t === "AT_MESSAGE_CREATE" || t === "GROUP_AT_MESSAGE_CREATE" || t === "C2C_MESSAGE_CREATE")) {
        // 处理消息事件
        this.handleMessage(payload.d, t);
      } else if (op === 9) {
        logger.error("qqbot.ws_invalid_session");
        socket.close();
      }
    });

    socket.on("close", (code: number, reason: Buffer) => {
      logger.warn("qqbot.ws_closed", { code, reason: reason.toString() });
      if (this.ws === socket) {
        this.ws = null;
      }
      this.clearHeartbeat();
      this.scheduleReconnect();
    });
    
    socket.on("error", (error: Error) => {
      logger.error("qqbot.ws_error", { error });
    });
  }

  async sendToOwner(text: string): Promise<void> {
    if (!this.config) {
      throw new Error("QQBot channel is not started");
    }
    const ownerChatId = this.config.ownerChatId;
    if (!ownerChatId) {
      throw new Error("QQBot ownerChatId 未配置，请先私聊机器人一次（会自动记录），或在设置中手动填写");
    }
    try {
      const token = await this.getValidToken();
      const url = `${QQ_BASE_API}/v2/users/${ownerChatId}/messages`;
      const body = { content: text, msg_type: 0 };

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `QQBot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const responseData = await res.json();
        logger.error("qqbot.send_to_owner.failed", { status: res.status, response: responseData });
        throw new Error(`QQ send failed: HTTP ${res.status}`);
      }
      logger.info("qqbot.send_to_owner.success", { ownerChatId });
    } catch (e) {
      logger.error("qqbot.send_to_owner.error", { error: e });
      throw e;
    }
  }

  private async handleMessage(message: any, eventType: string): Promise<void> {
    // 频道和单聊里的作者ID是不一样的字段结构
    let chatId = message.guild_id || message.channel_id || message.author?.id;

    if (eventType === "C2C_MESSAGE_CREATE" && message.author?.user_openid) {
      chatId = message.author.user_openid;
    }
    
    // 群聊（新版群助手）
    if (message.group_openid) {
        chatId = message.group_openid;
    }
    
    if (!chatId) {
        logger.warn("qqbot.message.no_chat_id", { message });
        return;
    }

    if (eventType === "C2C_MESSAGE_CREATE" && !this.config!.ownerChatId) {
      const userId = message.author?.user_openid || chatId;
      this.config!.ownerChatId = userId;
      updateChannelConfig("qqbot", { ownerChatId: userId });
      logger.info("qqbot.owner_auto_saved", { chatId: userId });
    }

    logger.info("qqbot.message.received", {
      messageId: message.id,
      chatId,
      eventType
    });

    const rawText = message.content || "";
    // 如果是频道被@或者是群里被@的消息，最好能过滤掉类似 `<@!1234>` 的本身
    const userText = sanitizeUserText(rawText).replace(/<@!\d+>/g, "").trim();

    if (!userText) {
      return;
    }

    this.enqueueChatTask(chatId, async () => {
      const cmd = handleCommand(userText, chatId, "qqbot", this.callbacks!);
      if (cmd.handled) {
        if (cmd.reply) await this.sendText(chatId, message.id, cmd.reply, eventType);
        return;
      }

      try {
        await this.generateAndSendReply(chatId, message.id, userText, eventType);
      } catch (error) {
        logger.error("qqbot.text.failed", {
          messageId: message.id,
          chatId: chatId,
          error,
        });
        await this.sendText(chatId, message.id, "处理消息时出错了，请稍后再试。", eventType);
      }
    });
  }

  private enqueueChatTask(chatId: string, task: () => Promise<void>): void {
    const previous = this.queueByChat.get(chatId) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (this.queueByChat.get(chatId) === next) {
          this.queueByChat.delete(chatId);
        }
      });
    this.queueByChat.set(chatId, next);
  }

  private async generateAndSendReply(
    chatId: string,
    msgId: string,
    userText: string,
    eventType: string,
  ): Promise<void> {
    const generateReplyStream = this.callbacks?.generateReplyStream;
    if (!generateReplyStream) {
      const reply = await this.callbacks!.generateReply(chatId, userText, undefined, "qqbot");
      await this.sendText(chatId, msgId, reply, eventType);
      return;
    }

    if (eventType === "C2C_MESSAGE_CREATE") {
      const result = await this.generateAndSendC2cStreamReply(
        chatId,
        msgId,
        userText,
        generateReplyStream,
      );
      if (result.handled) return;
      if (result.reply) {
        await this.sendText(chatId, msgId, result.reply, eventType);
        return;
      }
    }

    await this.generateAndSendChunkedReply(chatId, msgId, userText, eventType, generateReplyStream);
  }

  private async generateAndSendC2cStreamReply(
    chatId: string,
    msgId: string,
    userText: string,
    generateReplyStream: NonNullable<ChannelCallbacks["generateReplyStream"]>,
  ): Promise<{ handled: boolean; reply?: string }> {
    let fullText = "";
    let streamMsgId: string | undefined;
    let sentAnyStream = false;
    let streamFailed = false;
    let lastSentText = "";
    let lastFlushAt = 0;
    let streamIndex = 0;
    const msgSeq = 1;
    let flushTimer: NodeJS.Timeout | null = null;
    let sendQueue = Promise.resolve();

    const clearFlushTimer = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
    };

    const sendStreamUpdate = async (inputState: number): Promise<void> => {
      if (streamFailed) return;
      const content = fullText;
      if (!content.trim()) return;
      if (
        inputState === QQ_C2C_STREAM_INPUT_STATE_GENERATING &&
        sentAnyStream &&
        content === lastSentText
      ) {
        return;
      }

      const response = await this.sendC2cStreamMessage({
        chatId,
        msgId,
        msgSeq,
        index: streamIndex++,
        streamMsgId,
        inputState,
        content,
      });
      if (!streamMsgId && typeof response.id === "string") {
        streamMsgId = response.id;
      }
      sentAnyStream = true;
      lastSentText = content;
      lastFlushAt = Date.now();
    };

    const queueStreamUpdate = (inputState: number): Promise<void> => {
      sendQueue = sendQueue
        .then(() => sendStreamUpdate(inputState))
        .catch((error) => {
          streamFailed = true;
          logger.warn("qqbot.stream.c2c_update_failed", {
            messageId: msgId,
            chatId,
            sentAnyStream,
            error,
          });
        });
      return sendQueue;
    };

    const requestGeneratingUpdate = (): Promise<void> | void => {
      if (!fullText.trim() || streamFailed) return;
      const now = Date.now();
      if (!sentAnyStream || now - lastFlushAt >= QQ_C2C_STREAM_INTERVAL_MS) {
        clearFlushTimer();
        return queueStreamUpdate(QQ_C2C_STREAM_INPUT_STATE_GENERATING);
      }
      if (!flushTimer) {
        const delayMs = Math.max(0, QQ_C2C_STREAM_INTERVAL_MS - (now - lastFlushAt));
        flushTimer = setTimeout(() => {
          flushTimer = null;
          void queueStreamUpdate(QQ_C2C_STREAM_INPUT_STATE_GENERATING);
        }, delayMs);
      }
    };

    const onEvent = (event: AgentStreamEvent): Promise<void> | void => {
      if (event.type !== "answer_delta" || !event.text) return;
      fullText += event.text;
      return requestGeneratingUpdate();
    };

    let reply: string;
    try {
      reply = await generateReplyStream(
        chatId,
        userText,
        undefined,
        "qqbot",
        onEvent,
      );
    } catch (error) {
      clearFlushTimer();
      await sendQueue;
      if (sentAnyStream && !streamFailed) {
        fullText = `${fullText.replace(/\s+$/, "")}\n\n处理消息时出错了，请稍后再试。`;
        await queueStreamUpdate(QQ_C2C_STREAM_INPUT_STATE_DONE);
        await sendQueue;
        return { handled: true, reply: fullText };
      }
      throw error;
    }
    clearFlushTimer();
    await sendQueue;

    fullText = mergeStreamedAndFinalText(fullText, reply);
    if (!fullText.trim()) return { handled: false, reply };
    if (streamFailed && !sentAnyStream) return { handled: false, reply: fullText };

    if (!sentAnyStream) {
      await queueStreamUpdate(QQ_C2C_STREAM_INPUT_STATE_GENERATING);
      await sendQueue;
    }
    if (streamFailed && !sentAnyStream) return { handled: false, reply: fullText };
    if (!streamFailed) {
      await queueStreamUpdate(QQ_C2C_STREAM_INPUT_STATE_DONE);
      await sendQueue;
    }

    return { handled: sentAnyStream, reply: fullText };
  }

  private async generateAndSendChunkedReply(
    chatId: string,
    msgId: string,
    userText: string,
    eventType: string,
    generateReplyStream: NonNullable<ChannelCallbacks["generateReplyStream"]>,
  ): Promise<void> {
    let buffer = "";
    let streamedText = "";
    let sentAnyChunk = false;
    let msgSeq = 1;
    let lastFlushAt = Date.now();
    let sendQueue = Promise.resolve();

    const queueChunk = (chunk: string) => {
      const seq = msgSeq++;
      sentAnyChunk = true;
      lastFlushAt = Date.now();
      sendQueue = sendQueue.then(() => this.sendText(chatId, msgId, chunk, eventType, seq));
    };

    const flush = (force = false) => {
      const picked = takeStreamChunk(buffer, force);
      if (!picked) return;
      buffer = picked.rest;
      queueChunk(picked.chunk);
    };

    const onEvent = (event: AgentStreamEvent) => {
      if (event.type !== "answer_delta" || !event.text) return;
      streamedText += event.text;
      buffer += event.text;

      const shouldFlush =
        buffer.length >= QQ_STREAM_MAX_CHARS ||
        (buffer.length >= QQ_STREAM_MIN_CHARS && Date.now() - lastFlushAt >= QQ_STREAM_MIN_INTERVAL_MS);
      if (shouldFlush) flush(false);
    };

    const reply = await generateReplyStream(chatId, userText, undefined, "qqbot", onEvent);
    const finalText = mergeStreamedAndFinalText(streamedText, reply);
    if (finalText && finalText.startsWith(streamedText)) {
      buffer += finalText.slice(streamedText.length);
    } else if (!sentAnyChunk && reply) {
      buffer += finalText;
    } else if (finalText && finalText !== streamedText) {
      buffer += `\n\n${finalText}`;
    }
    flush(true);
    await sendQueue;
  }

  private async sendC2cStreamMessage(opts: {
    chatId: string;
    msgId: string;
    msgSeq: number;
    index: number;
    streamMsgId?: string;
    inputState: number;
    content: string;
  }): Promise<QQStreamResponse> {
    const url = `${QQ_BASE_API}/v2/users/${opts.chatId}/stream_messages`;
    const body = {
      input_mode: "replace",
      input_state: opts.inputState,
      content_type: "markdown",
      content_raw: opts.content,
      event_id: opts.msgId,
      msg_id: opts.msgId,
      msg_seq: opts.msgSeq,
      index: opts.index,
      ...(opts.streamMsgId ? { stream_msg_id: opts.streamMsgId } : {}),
    };

    const post = async (token: string) => {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `QQBot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const responseText = await res.text();
      let responseData: unknown = responseText;
      try {
        responseData = responseText ? JSON.parse(responseText) : null;
      } catch {
        // Keep raw response text for diagnostics.
      }
      return { res, responseData };
    };

    let { res, responseData } = await post(await this.getValidToken());
    if (res.status === 401) {
      this.accessToken = null;
      this.tokenExpiresAt = 0;
      ({ res, responseData } = await post(await this.getValidToken()));
    }

    if (!res.ok) {
      logger.warn("qqbot.stream.c2c_failed_http", {
        status: res.status,
        response: responseData,
        messageId: opts.msgId,
        index: opts.index,
        inputState: opts.inputState,
      });
      throw new Error(`QQ C2C stream failed: HTTP ${res.status}`);
    }

    logger.info("qqbot.stream.c2c_success", {
      chatId: opts.chatId,
      messageId: opts.msgId,
      index: opts.index,
      inputState: opts.inputState,
    });
    return (responseData && typeof responseData === "object" ? responseData : {}) as QQStreamResponse;
  }

  private async sendText(
    chatId: string,
    msgId: string,
    text: string,
    eventType: string,
    msgSeq = 1,
  ): Promise<void> {
    try {
      const token = await this.getValidToken();
      let url = "";

      // 新版直接发群聊
      if (eventType === "GROUP_AT_MESSAGE_CREATE") {
          url = `${QQ_BASE_API}/v2/groups/${chatId}/messages`;
      } 
      // 新版直接发C2C（好友）
      else if (eventType === "C2C_MESSAGE_CREATE") {
          url = `${QQ_BASE_API}/v2/users/${chatId}/messages`;
      } 
      // 频道私信
      else if (eventType === "DIRECT_MESSAGE_CREATE") {
          // 这里如果是频道主动发起的私信，chatId通常是 guild_id 或者发过来的 dm_channelId
          // 为了简化，目前依然用 /dms 或者 /channels/${chatId}/messages 如果chatId是频道的channel
          url = `${QQ_BASE_API}/dms/${chatId}/messages`; 
          // 实际上如果创建了DM频道，chatId就是dm频道的id
      }
      // 频道被艾特
      else {
          url = `${QQ_BASE_API}/channels/${chatId}/messages`;
      }

      logger.info("qqbot.send_text.start", { chatId, url });

      const usesV2MessageApi =
        eventType === "GROUP_AT_MESSAGE_CREATE" || eventType === "C2C_MESSAGE_CREATE";
      const markdownBody = usesV2MessageApi
        ? {
            msg_type: 2,
            markdown: { content: text },
            msg_id: msgId,
            msg_seq: msgSeq,
          }
        : {
            markdown: { content: text },
            msg_id: msgId,
          };
      const textBody = usesV2MessageApi
        ? {
            msg_type: 0,
            content: markdownToPlainText(text),
            msg_id: msgId,
            msg_seq: msgSeq,
          }
        : {
            content: markdownToPlainText(text),
            msg_id: msgId,
          };

      const postBody = async (body: object) => {
        const res = await fetch(url, {
          method: "POST",
          headers: {
              "Authorization": `QQBot ${token}`,
              "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });
        const responseText = await res.text();
        let responseData: unknown = responseText;
        try {
          responseData = responseText ? JSON.parse(responseText) : null;
        } catch {
          // Keep the raw text response for logging.
        }
        return { res, responseData };
      };
      
      let { res, responseData } = await postBody(markdownBody);
      if (!res.ok) {
          logger.warn("qqbot.send_text.markdown_failed_http", { status: res.status, response: responseData });
          ({ res, responseData } = await postBody(textBody));
      }

      if (!res.ok) {
          logger.error("qqbot.send_text.failed_http", { status: res.status, response: responseData });
          
          // 如果返回不支持，并且是频道，回退到 postDirectMessage
          if (res.status === 404 || res.status === 400) {
              // 你可能需要先调用 /users/@me/dms 创建会话
              // 这里简化处理为记录报错
          }
      } else {
          logger.info("qqbot.send_text.success", { chatId });
      }
    } catch (e) {
      logger.error("qqbot.send_text.failed", { error: e });
    }
  }
}
