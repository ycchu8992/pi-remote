/**
 * pi-remote — control this Pi session from Discord
 *
 * Connections are durable, expiring resources owned by a session.
 * /rc enable allocates; /rc connect binds/logs in; /rc disconnect retains;
 * /rc disable destroys the resource and permanently retires its channel.
 *
 * Bot permissions required:
 *   • Read/Send Messages, Add Reactions  (existing)
 *   • Manage Channels                    (new — for create + rename)
 *
 * Commands:
 *   /rc setup       — interactive setup (token, guildId, categoryId, allowed users)
 *   /rc enable  — allocate a connection (no channel)
 *   /rc connect — connect, creating a channel if unbound
 *   /rc disconnect — retain resource and binding, close transport
 *   /rc disable — destroy connection, preserve retired channel
 *   /rc status  — show connection state
 */

import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  Client,
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
} from "discord.js";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { loadConfig, saveConfig, toolMessageLevel, CONFIG_FILE } from "./config.js";
import { ConnectionStore, type Connection } from "./connections.js";
import type { Config } from "./config.js";
import {
  makeChannelName,
  sessionLabel,
  splitMessage,
  toolLabel,
  isAbortLikeError,
  sleep,
  withTimeout,
} from "./helpers.js";

// ─── Reconnection constants ──────────────────────────────────────────────────
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const RECONNECT_MAX_ATTEMPTS = 10;

// Built-in Pi commands that have stable ExtensionAPI equivalents. Other TUI-only
// built-ins intentionally remain unavailable over Discord.
const MAPPED_CORE_COMMANDS = [
  { name: "abort", description: "Abort the current Pi operation" },
  { name: "compact", description: "Compact the current session context" },
  { name: "model", description: "Choose a model from a menu" },
  { name: "thinking", description: "Choose a thinking level from a menu" },
  { name: "name", description: "Set the session display name" },
  { name: "session", description: "Show current session information" },
  { name: "new", description: "Start a new session" },
  { name: "resume", description: "Choose a saved session and transfer remote control to it" },
  { name: "fork", description: "Choose a user message to fork from" },
  { name: "clone", description: "Clone the current session position" },
  { name: "tree", description: "Navigate to a session entry ID" },
  { name: "reload", description: "Reload extensions and session resources" },
] as const;

// ─── Extension ────────────────────────────────────────────────────────────────

// A reload replaces extension closures. Preserve only the intent to reconnect;
// the old gateway is closed before the new runtime starts.
const reloadKey = Symbol.for("pi-remote.reload");
type ReloadState = { config: Config | null; cwd: string; enabled: boolean; connected: boolean;
  previousFile?: string; nextChannelId?: string; previousChannelId?: string; recovery?: boolean;
  remoteResume?: boolean; preparedDestination?: boolean };
const reloadSlot = globalThis as typeof globalThis & { [reloadKey]?: ReloadState };
const outcomeKey = Symbol.for("pi-remote.transition-outcome");
const outcomeSlot = globalThis as typeof globalThis & { [outcomeKey]?: { ok: boolean; channelId?: string; error?: string } };

export default function (pi: ExtensionAPI) {
  /** Mutable runtime state — never persisted to disk. */
  interface RuntimeState {
    /** The channel ID this session is listening on (created or fallback). */
    activeChannelId: string | null;
    /** Channel name at creation time (for display). */
    sessionChannelName: string | null;
  }

  let client: Client | null = null;
  let activeConfig: Config | null = null;
  const runtime: RuntimeState = { activeChannelId: null, sessionChannelName: null };
  let activeModelRegistry: any = null;
  let activeSessionManager: any = null;
  let activeCwd = "";
  let resumeTarget: { id: string; path: string } | undefined;
  let currentSessionId: string | null = null;
  let pendingNextChannelId: string | null = null;
  const connections = new ConnectionStore();
  const ownerId = randomUUID();
  let connection: Connection | undefined;
  let expiryTimer: ReturnType<typeof setInterval> | undefined;
  let maintenanceRunning = false;
  let rcCommandRunning = false;
  let transitionPending = false;
  let preparedChannel: any = null;
  let recovery: { token: string; saved: ReloadState; error: string } | undefined;
  let forceRecovery = false;
  let preparationTimer: ReturnType<typeof setTimeout> | undefined;

  async function discardPreparation(): Promise<void> {
    if (preparationTimer) clearTimeout(preparationTimer);
    preparationTimer = undefined;
    const orphan = preparedChannel;
    preparedChannel = null;
    pendingNextChannelId = null;
    transitionPending = false;
    if (orphan) await orphan.delete("Session transition cancelled").catch(() => {});
  }

  async function prepareReplacement(ctx: any, forkEntry?: string, resumeSessionId?: string): Promise<{ cancel: true } | undefined> {
    if (forceRecovery) return;
    if (connection) await maintainConnection();
    if (agentBusy || questionResolver || transitionPending || rcCommandRunning) {
      ctx.ui.notify("Cannot switch sessions while remote work or another transition is active.", "warning");
      return { cancel: true };
    }
    if (!client?.isReady() || remotelyPaused) {
      if (resumeSessionId) {
        ctx.ui.notify("Original connection is no longer available; resume cancelled.", "error");
        return { cancel: true };
      }
      return;
    }
    if (!ctx.sessionManager.getSessionFile() || !existsSync(ctx.sessionManager.getSessionFile())) {
      ctx.ui.notify("Save the original session before switching so rollback is possible.", "error");
      return { cancel: true };
    }
    transitionPending = true;
    try {
      if (!await maintainConnection(true)) throw new Error("Original connection is unavailable.");
      if (resumeSessionId) {
        const target = await connections.get(resumeSessionId);
        if (target?.owner) throw new Error("Target session is already connected in another Pi runtime.");
        if (target?.channelId) {
          const channel = await client!.channels.fetch(target.channelId);
          if (!channel?.isTextBased() || !("guildId" in channel) || channel.guildId !== activeConfig!.guildId) {
            throw new Error("Target session's bound channel is missing or inaccessible.");
          }
          pendingNextChannelId = target.channelId;
        }
      }
      if (forkEntry) {
        const currentChannel = await client!.channels.fetch(runtime.activeChannelId!);
        if (currentChannel && !currentChannel.isThread()) {
          const source = await findForkSource(forkEntry);
          if (!source.channel.isThread() && !source.hasThread) {
            preparedChannel = await source.startThread({ name: `Fork: ${source.content.replace(/\s+/g, " ").slice(0, 85) || forkEntry}` });
          }
        }
      }
      if (!preparedChannel && !pendingNextChannelId) {
        const guild = await client!.guilds.fetch(activeConfig!.guildId);
        preparedChannel = await guild.channels.create({ name: makeChannelName(ctx.cwd), type: ChannelType.GuildText,
          ...(activeConfig!.categoryId ? { parent: activeConfig!.categoryId } : {}), topic: "Pi session transition (preparing)" });
      }
      if (preparedChannel) pendingNextChannelId = preparedChannel.id;
      // Other extensions can veto after us. Reclaim preparation if shutdown never follows.
      preparationTimer = setTimeout(() => { void discardPreparation(); }, 60_000);
      preparationTimer.unref();
    } catch (error) {
      await discardPreparation();
      ctx.ui.notify(`Session switch cancelled; original session retained: ${String(error)}`, "error");
      await sendToChannel(runtime.activeChannelId!, `❌ Session switch failed; original session retained. ${String(error)}`);
      return { cancel: true };
    }
  }

  async function maintainConnection(activity = false): Promise<boolean> {
    if (!connection || !currentSessionId) return false;
    try {
      if (client) {
        connection = await connections.heartbeat(currentSessionId, connection.id, ownerId, agentBusy || !!questionResolver || transitionPending);
        if (activity) connection = await connections.touch(currentSessionId, connection.id, ownerId);
      } else {
        connection = await connections.get(currentSessionId);
      }
      return !!connection;
    } catch (error) {
      const channelId = runtime.activeChannelId;
      const token = activeConfig?.token;
      await disconnectRemote();
      connection = await connections.get(currentSessionId);
      connectNotify?.(`Remote connection unavailable: ${String(error)}`, "warning");
      if (!connection && channelId && token) {
        await sendMessageViaDiscordRest({ channelId, token,
          content: "⌛ Connection expired/disabled. This channel is permanently retired. Enable and connect from the Pi terminal to create a new connection and channel." }).catch(() => {});
      }
      return false;
    }
  }

  async function disconnectRemote(): Promise<void> {
    isShuttingDown = true;
    clearReconnectTimer();
    questionRejecter?.(new Error("Remote connection disconnected"));
    clearQuestionState();
    const oldClient = client;
    client = null;
    runtime.activeChannelId = null;
    runtime.sessionChannelName = null;
    pendingReplyChannelId = null;
    pendingReplyUserId = null;
    remotelyPaused = true;
    if (oldClient) await oldClient.destroy().catch(() => {});
    if (connection && currentSessionId) await connections.disconnect(currentSessionId, connection.id, ownerId);
    connectSetStatus?.("pi-remote", undefined);
  }

  async function disableRemote(): Promise<void> {
    if (connection && currentSessionId) await connections.destroy(currentSessionId, connection.id, ownerId);
    await disconnectRemote();
    connection = undefined;
  }

  function startMaintenance(): void {
    if (expiryTimer) clearInterval(expiryTimer);
    expiryTimer = setInterval(() => {
      if (maintenanceRunning) return;
      maintenanceRunning = true;
      void maintainConnection().catch(error => console.error("[pi-remote] Maintenance failed:", error))
        .finally(() => { maintenanceRunning = false; });
    }, 15_000);
    expiryTimer.unref();
  }
  let pendingSource: { messageId: string; channelId: string; entryCount: number; text: string } | null = null;
  const discordEntryType = "pi-remote-discord-source";
  type ForkMenu = { userId: string; channelId: string; sessionId: string; entries: Array<{ id: string; text: string }>; page: number; created: number };
  const forkMenus = new Map<string, ForkMenu>();
  type ChoiceMenu = { userId: string; channelId: string; sessionId: string; kind: "model" | "thinking" | "resume";
    entries: Array<{ label: string; value: string }>; page: number; created: number };
  const choiceMenus = new Map<string, ChoiceMenu>();
  const handledInteractions = new Map<string, number>();
  const FORK_PAGE_SIZE = 22;
  const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

  function choiceMenuView(menu: ChoiceMenu, token: string) {
    const pages = Math.ceil(menu.entries.length / FORK_PAGE_SIZE);
    const options = menu.entries.slice(menu.page * FORK_PAGE_SIZE, (menu.page + 1) * FORK_PAGE_SIZE)
      .map((entry, index) => ({ label: entry.label.slice(0, 100), value: String(menu.page * FORK_PAGE_SIZE + index) }));
    if (menu.page > 0) options.push({ label: "⬅️ Previous page", value: "__prev__" });
    if (menu.page + 1 < pages) options.push({ label: "➡️ Next page", value: "__next__" });
    options.push({ label: "Cancel", value: "__cancel__" });
    return {
      content: `Choose a ${menu.kind === "model" ? "model" : menu.kind === "resume" ? "session to resume" : "thinking level"} (page ${menu.page + 1}/${pages}).`,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(`pi-choice:${token}`).setPlaceholder(`Select ${menu.kind}`).addOptions(options),
      )],
    };
  }

  function sendCoreCommand(command: string, args: string, channelId: string, userId: string) {
    pendingReplyChannelId = channelId;
    pendingReplyUserId = userId;
    const payload = Buffer.from(JSON.stringify({ command, args })).toString("base64url");
    (pi.sendUserMessage as (text: string, options?: { expandPromptTemplates?: boolean }) => void)(
      `/discord-remote-core ${payload}`, { expandPromptTemplates: true },
    );
  }

  function forkMenuView(menu: ForkMenu, token: string) {
    const pages = Math.ceil(menu.entries.length / FORK_PAGE_SIZE);
    const entries = menu.entries.slice(menu.page * FORK_PAGE_SIZE, (menu.page + 1) * FORK_PAGE_SIZE);
    const options = entries.map((entry, index) => ({
      label: `${menu.page * FORK_PAGE_SIZE + index + 1}. ${entry.text.replace(/\s+/g, " ").slice(0, 85)}`.slice(0, 100),
      value: entry.id,
      description: `Entry ${entry.id}`.slice(0, 100),
    }));
    if (menu.page > 0) options.push({ label: "⬅️ Previous page", value: "__prev__", description: "Older messages" });
    if (menu.page + 1 < pages) options.push({ label: "➡️ Next page", value: "__next__", description: "More messages" });
    options.push({ label: "Cancel", value: "__cancel__", description: "Do not fork" });
    return {
      content: `Choose a user message to fork from (page ${menu.page + 1}/${pages}). Fork creates a new session from before that message.`,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(`pi-fork:${token}`).setPlaceholder("Select a message").addOptions(options),
      )],
    };
  }

  let agentBusy = false;
  let pendingReplyChannelId: string | null = null;
  let pendingReplyUserId: string | null = null;
  let collectedAssistantText: string[] = [];
  let postedThinkingNotice = false;
  let lastImageArtifactPath: string | null = null;

  // ── Reconnection state ────────────────────────────────────────────────
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let isShuttingDown = false;
  let reconnectFailed = false;
  let remotelyPaused = false;
  // Captured at connect time so reconnect can reuse them
  let connectNotify: ((msg: string, level: "success" | "error" | "warning" | "info") => void) | null = null;
  let connectSetStatus: ((key: string, val: string | undefined) => void) | null = null;

  // ── Question-answering state (for overriding ask_user_question) ────────
  let questionResolver: ((answer: string) => void) | null = null;
  let questionRejecter: ((reason: Error) => void) | null = null;
  let questionChannelId: string | null = null;
  let questionToken: string | null = null;
  let questionMessageId: string | null = null;
  let questionUserId: string | null = null;
  let questionValues: string[] = [];
  let questionTimeout: ReturnType<typeof setTimeout> | null = null;
  let questionAbortListener: (() => void) | null = null;
  let questionAbortSignal: AbortSignal | null = null;

  function clearQuestionState(): void {
    if (questionTimeout) {
      clearTimeout(questionTimeout);
      questionTimeout = null;
    }
    // Remove abort listener to prevent leak
    if (questionAbortListener && questionAbortSignal) {
      questionAbortSignal.removeEventListener("abort", questionAbortListener);
    }
    questionAbortListener = null;
    questionAbortSignal = null;
    questionResolver = null;
    questionRejecter = null;
    questionChannelId = null;
    questionToken = null;
    questionMessageId = null;
    questionUserId = null;
    questionValues = [];
  }

  // ── Shared send helpers ──────────────────────────────────────────────────

  async function sendToChannel(channelId: string, text: string): Promise<string | undefined> {
    if (!client || remotelyPaused || transitionPending || channelId !== runtime.activeChannelId) return;
    if (!await maintainConnection()) return;
    try {
      const channel = (await client!.channels.fetch(channelId)) as TextChannel | null;
      if (!channel?.isTextBased()) return;
      const sent = await (channel as TextChannel).send(text);
      await maintainConnection(true);
      return sent.id;
    } catch (err) {
      console.error("[pi-remote] Failed to send message:", err);
    }
  }

  async function sendToActiveChannel(text: string): Promise<void> {
    if (pendingReplyChannelId) await sendToChannel(pendingReplyChannelId, text);
  }

  function getTargetChannelId(overrideChannelId?: string): string | null {
    const override = overrideChannelId?.trim();
    return override || runtime.activeChannelId || null;
  }

  async function sendMessageViaDiscordRest(params: {
    channelId: string;
    token: string;
    content?: string;
    filename?: string;
    mediaType?: string;
    bytes?: Buffer;
  }): Promise<{ ok: boolean; error?: string }> {
    const url = `https://discord.com/api/v10/channels/${params.channelId}/messages`;
    const form = new FormData();

    if (params.bytes) {
      const fileName = params.filename ?? "image.png";
      const type = params.mediaType ?? "image/png";
      const payload = {
        content: params.content ?? "",
        attachments: [{ id: 0, filename: fileName }],
      };
      form.append("payload_json", JSON.stringify(payload));
      form.append("files[0]", new Blob([new Uint8Array(params.bytes)], { type }), fileName);
    } else {
      form.append("content", params.content ?? "");
    }

    const resp = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bot ${params.token}`,
        },
        body: form,
      }),
      20_000,
      "discord_rest_send",
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      if (resp.status === 404) return { ok: false, error: `unknown_channel:${params.channelId}` };
      return { ok: false, error: `discord_http_${resp.status}:${body.slice(0, 200)}` };
    }

    return { ok: true };
  }

  async function sendAttachmentToActiveChannel(params: {
    channelId?: string;
    path?: string;
    url?: string;
    base64?: string;
    mediaType?: string;
    filename?: string;
    caption?: string;
  }): Promise<{ ok: boolean; sentAs?: string; error?: string }> {
    const targetChannelId = getTargetChannelId(params.channelId);
    if (!client?.isReady()) {
      return { ok: false, error: "discord_not_connected" };
    }
    if (!targetChannelId) {
      return { ok: false, error: "no_active_channel" };
    }

    const sendOnce = async (): Promise<{ ok: boolean; sentAs?: string; error?: string }> => {
      if (transitionPending || remotelyPaused || targetChannelId !== runtime.activeChannelId || !await maintainConnection()) {
        return { ok: false, error: "channel_not_owned_or_disconnected" };
      }
      const channel = (await withTimeout(
        client!.channels.fetch(targetChannelId),
        15_000,
        "fetch_channel",
      )) as TextChannel | null;
      if (!channel?.isTextBased()) return { ok: false, error: "channel_unavailable" };
      if (activeConfig?.guildId && "guildId" in channel && channel.guildId !== activeConfig.guildId) {
        return { ok: false, error: `wrong_guild:${targetChannelId}` };
      }

      const content = params.caption?.trim() || undefined;
      const token = activeConfig?.token?.trim();
      if (!token) return { ok: false, error: "missing_bot_token" };

      if (params.path) {
        const filePath = params.path.trim();
        if (!existsSync(filePath)) return { ok: false, error: `file_not_found:${filePath}` };
        const buffer = await withTimeout(readFile(filePath), 5_000, "read_file");
        const name = params.filename?.trim() || basename(filePath);
        const sent = await sendMessageViaDiscordRest({
          channelId: targetChannelId,
          token,
          content,
          filename: name,
          mediaType: params.mediaType?.trim() || "application/octet-stream",
          bytes: buffer,
        });
        if (!sent.ok) return { ok: false, error: sent.error ?? "send_path_failed" };
        return { ok: true, sentAs: "path" };
      }

      if (params.url) {
        const body = content ? `${content}\n${params.url.trim()}` : params.url.trim();
        const sent = await sendMessageViaDiscordRest({
          channelId: targetChannelId,
          token,
          content: body,
        });
        if (!sent.ok) return { ok: false, error: sent.error ?? "send_url_failed" };
        return { ok: true, sentAs: "url" };
      }

      if (params.base64) {
        const mediaType = params.mediaType?.trim() || "image/png";
        const ext = mediaType.split("/")[1] ?? "png";
        const buffer = Buffer.from(params.base64.trim(), "base64");
        const name = params.filename?.trim() || `image.${ext}`;
        const sent = await sendMessageViaDiscordRest({
          channelId: targetChannelId,
          token,
          content,
          filename: name,
          mediaType,
          bytes: buffer,
        });
        if (!sent.ok) return { ok: false, error: sent.error ?? "send_base64_failed" };
        return { ok: true, sentAs: "base64" };
      }

      return { ok: false, error: "missing_source" };
    };

    const toError = (err: any): string => {
      const msg = String(err?.message ?? "send_failed");
      const code = String(err?.code ?? "");
      if (code === "10003" || msg.toLowerCase().includes("unknown channel")) {
        return `unknown_channel:${targetChannelId}`;
      }
      return msg;
    };

    try {
      const result = await sendOnce();
      if (result.ok) await maintainConnection(true);
      return result;
    } catch (err: any) {
      if (isAbortLikeError(err)) {
        try {
          await sleep(300);
          const result = await sendOnce();
          if (result.ok) await maintainConnection(true);
          return result;
        } catch (retryErr: any) {
          return { ok: false, error: toError(retryErr) };
        }
      }
      return { ok: false, error: toError(err) };
    }
  }

  // Locate the exact Discord message, never silently attach a fork to an ambiguous match.
  async function findForkSource(entryId: string): Promise<Message> {
    if (!client || !runtime.activeChannelId || !activeSessionManager) throw new Error("Discord is not connected.");
    const mappings = activeSessionManager.getEntries().filter((entry: any) =>
      entry.type === "custom" && entry.customType === discordEntryType && entry.data?.entryId === entryId);
    const mapping = mappings.at(-1)?.data;
    if (mapping) {
      const channel = await client.channels.fetch(mapping.channelId);
      if (!channel?.isTextBased() || !('messages' in channel)) throw new Error("Original Discord channel is unavailable.");
      return channel.messages.fetch(mapping.messageId);
    }
    const entry = activeSessionManager.getEntry(entryId);
    if (entry?.type !== "message" || entry.message.role !== "user") throw new Error("Selected entry is not a user message.");
    const content = entry.message.content;
    const text = typeof content === "string" ? content : content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
    const channel = await client.channels.fetch(runtime.activeChannelId);
    if (!channel?.isTextBased() || !('messages' in channel)) throw new Error("Active Discord channel is unavailable.");
    let before: string | undefined;
    let match: Message | undefined;
    // Old sessions predate source mapping; only match an unambiguous message in this channel.
    for (let page = 0; page < 20; page++) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (!batch.size) {
        if (match) return match;
        break;
      }
      for (const message of batch.values()) {
        const matches = message.author.id === client.user?.id
          ? message.content === `> ⌨️ Terminal: ${text}`
          : !message.author.bot && (!activeConfig?.allowedUserIds?.length || activeConfig.allowedUserIds.includes(message.author.id)) && message.content === text;
        if (matches) {
          if (match) throw new Error("Several Discord messages match this entry; cannot safely choose one.");
          match = message;
        }
      }
      before = batch.last()?.id;
      if (batch.size < 100) {
        if (!match) break;
        return match;
      }
    }
    if (match) throw new Error("History exceeds 2,000 messages; cannot verify the match is unique.");
    throw new Error("Could not identify the original Discord message (older history or attachment-only message).");
  }

  // ── Collect assistant output ──────────────────────────────────────────────

  // Mirror terminal prompts to the same channel as remote turns. Extension-origin
  // prompts are already present in Discord and must not be echoed back.
  pi.on("input", async (event) => {
    if (event.source !== "interactive" || !client?.isReady() || remotelyPaused || !runtime.activeChannelId) return;
    pendingReplyChannelId = runtime.activeChannelId;
    pendingReplyUserId = null;
    let firstMessageId: string | undefined;
    for (const chunk of splitMessage(`> ⌨️ Terminal: ${event.text}`)) {
      const id = await sendToChannel(runtime.activeChannelId, chunk);
      firstMessageId ??= id;
    }
    if (firstMessageId) pendingSource = { messageId: firstMessageId, channelId: runtime.activeChannelId,
      entryCount: activeSessionManager?.getEntries().length ?? 0, text: event.text };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("agent_start", async (_event: any) => {
    agentBusy = true;
    await maintainConnection();
    collectedAssistantText = [];
    postedThinkingNotice = false;
    lastImageArtifactPath = null;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("tool_result", async (event: any) => {
    // Capture latest browser image artifact path for follow-up discord_send_file calls.
    if (event.toolName === "agent_browser") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const artifacts: any[] = event.details?.artifacts ?? [];
      for (const artifact of artifacts) {
        if (artifact?.kind === "image") {
          const candidate = artifact.absolutePath ?? artifact.path;
          if (candidate && existsSync(candidate)) {
            lastImageArtifactPath = candidate;
          }
        }
      }
    }

    if (!pendingReplyChannelId) {
      return;
    }

    // Level 2 includes results; levels 0 and 1 do not.
    if (toolMessageLevel(activeConfig?.toolResponses) !== 2) return;

    // Build a label like "↩️ bash: ..." or "↩️ read: ..."
    const emoji = event.isError ? "❌" : "↩️";
    const detailLabel = event.content
      ?.filter((c: any) => c.type === "text")
      .map((c: any) => String(c.text ?? "").trim())
      .join("")
      .slice(0, 300) ?? "";

    // Send a compact summary line for each tool result
    const label = `${emoji} _${event.toolName}_`;
    if (detailLabel) {
      const truncated = detailLabel.length > 400 ? detailLabel.slice(0, 400) + "…" : detailLabel;
      await sendToActiveChannel(`${label}:\n\`\`\`\n${truncated}\n\`\`\``);
    } else {
      await sendToActiveChannel(label);
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("message_update", async (event: any) => {
    if (!pendingReplyChannelId || postedThinkingNotice) return;
    if (event.message.role !== "assistant") return;
    const hasThinking = (event.message.content as Array<{ type: string }>)
      .some((c) => c.type === "thinking");
    if (hasThinking) {
      postedThinkingNotice = true;
      await sendToActiveChannel("> 💭 _Thinking…_");
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("tool_execution_start", async (event: any) => {
    if (!pendingReplyChannelId) return;
    // discord_ask_user_question is handled by our tool (formatted output)
    if (event.toolName === "discord_ask_user_question") return;
    if (toolMessageLevel(activeConfig?.toolResponses) === 0) return;
    await sendToActiveChannel(toolLabel(event.toolName, event.args));
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("message_end", async (event: any) => {
    // Model errors may have no assistant text or pending reply (e.g. a terminal-initiated run).
    // Mirror them to the session channel regardless of the tool-message verbosity setting.
    if (event.message.role === "assistant" && event.message.stopReason === "error" && !remotelyPaused) {
      const channelId = pendingReplyChannelId ?? runtime.activeChannelId;
      if (channelId) {
        const error = String(event.message.errorMessage ?? "Unknown provider error");
        const label = /context.length|context.window|token.limit|too.many.tokens|maximum.*tokens|prompt.*too.long/i.test(error)
          ? "Context/token limit reached" : "Model error";
        await sendToChannel(channelId, `❌ ${label}: ${error.slice(0, 1200)}`);
      }
    }
    if (!pendingReplyChannelId) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = event.message.content as Array<any>;

    // Collect text from assistant messages
    if (event.message.role === "assistant") {
      const text = content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      if (text.trim()) collectedAssistantText.push(text);
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("agent_end", async (_event: any) => {
    try {
    if (pendingSource && activeSessionManager) {
      const source = pendingSource;
      pendingSource = null;
      const entry = activeSessionManager.getEntries().slice(source.entryCount).find((item: any) =>
        item.type === "message" && item.message.role === "user" &&
        (typeof item.message.content === "string" ? item.message.content :
          item.message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("")) === source.text,
      );
      if (entry) pi.appendEntry(discordEntryType, { entryId: entry.id, messageId: source.messageId, channelId: source.channelId });
    }

    if (!pendingReplyChannelId || !client) {
      pendingReplyChannelId = null;
      collectedAssistantText = [];
      return;
    }

    const text = collectedAssistantText.join("\n\n").trim();
    // Clear state before sending so sendToActiveChannel still sees the channel ID
    collectedAssistantText = [];
    // pendingReplyChannelId cleared after send below

    if (!text) {
      pendingReplyChannelId = null;
      pendingReplyUserId = null;
      return;
    }

    const chunks = splitMessage(text);
    // Prepend a mention to the last chunk so the sender is notified when work is done
    const mention = pendingReplyUserId ? `<@${pendingReplyUserId}> ` : "";
    const lastIdx = chunks.length - 1;
    chunks[lastIdx] = mention + chunks[lastIdx];

    for (const chunk of chunks) {
      await sendToActiveChannel(chunk);
    }
    pendingReplyChannelId = null;
    pendingReplyUserId = null;
    } finally {
      agentBusy = false;
      await maintainConnection();
    }
  });

  // ── Reconnect logic ────────────────────────────────────────────────────────

  function clearReconnectTimer(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (isShuttingDown || reconnectTimer || reconnectFailed) return;
    reconnectAttempt++;

    if (reconnectAttempt > RECONNECT_MAX_ATTEMPTS) {
      console.error(
        `[pi-remote] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached. Giving up.`,
      );
      reconnectFailed = true;
      if (!remotelyPaused) connectNotify?.(
        `❌ Discord reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts. Run /rc connect to retry.`,

        "error",
      );
      if (!remotelyPaused) connectSetStatus?.("pi-remote", "❌ Discord: reconnect failed");
      return;
    }

    // Exponential backoff with jitter: 2s, 4s, 8s, 16s, … up to 60s
    const baseDelay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempt - 1), RECONNECT_MAX_DELAY_MS);
    const jitter = Math.random() * 1_000;
    const delay = baseDelay + jitter;

    console.log(
      `[pi-remote] Reconnect attempt ${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS} in ${Math.round(delay)}ms`,
    );
    if (!remotelyPaused) connectSetStatus?.("pi-remote", `🔄 Discord: reconnecting (${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS})…`);

    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (isShuttingDown) return;
      await attemptReconnect();
    }, delay);
  }

  async function attemptReconnect(): Promise<void> {
    if (!activeConfig || !await maintainConnection()) return;

    // Destroy the old client if it still exists
    if (client) {
      const previous = client;
      client = null;
      await previous.destroy().catch(() => {});
    }

    const cfg = activeConfig;
    const notify = connectNotify ?? ((_m: string, _l: any) => {});
    const setStatus = connectSetStatus ?? ((_k: string, _v: any) => {});

    console.log("[pi-remote] Reconnecting to Discord…");

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    attachHandlers(client);
    client.on("error", (err) => {
      console.error("[pi-remote] Discord client error:", err);
      if (!remotelyPaused) setStatus("pi-remote", "⚠️ Discord: error");
    });
    const reconnectClient = client;
    reconnectClient.on("shardDisconnect", () => {
      if (isShuttingDown || client !== reconnectClient) return;
      console.error("[pi-remote] Discord WebSocket disconnected during reconnect, retrying…");
      if (!remotelyPaused) setStatus("pi-remote", "🔄 Discord: reconnecting…");
      scheduleReconnect();
    });

    // Install the ready listener before login (login may resolve after ready).
    let cancelReady = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reconnectClient.off("ready", onReady);
        reject(new Error("ready timeout"));
      }, 30_000);
      const onReady = () => { clearTimeout(timeout); resolve(); };
      cancelReady = () => { clearTimeout(timeout); reconnectClient.off("ready", onReady); };
      reconnectClient.once("ready", onReady);
    });
    // A failed login may settle before the ready timeout; keep the promise observed.
    void ready.catch(() => {});
    try {
      await reconnectClient.login(cfg.token);
      await ready;
      if (isShuttingDown || client !== reconnectClient) return;
      clearReconnectTimer();

      // Successfully reconnected — restore channel reference
      reconnectAttempt = 0;
      reconnectFailed = false;
      const channelLabel = runtime.sessionChannelName ?? runtime.activeChannelId ?? "unknown";
      console.log(`[pi-remote] Reconnected successfully → #${channelLabel}`);
      if (!remotelyPaused) notify(`✅ Discord reconnected → #${channelLabel}`, "success");
      setStatus("pi-remote", remotelyPaused ? undefined : `🔌 Discord: #${channelLabel}`);

      // Post a notice in the channel so the user knows we're back
      if (runtime.activeChannelId) {
        try {
          const ch = (await client.channels.fetch(runtime.activeChannelId)) as TextChannel | null;
          if (ch?.isTextBased() && !remotelyPaused) {
            await ch.send("🔌 _Reconnected — ready for commands._").catch(() => {});
          }
        } catch {
          // Channel may have been deleted — that's fine
        }
      }
    } catch (err: any) {
      if (isShuttingDown || client !== reconnectClient) return;
      console.error("[pi-remote] Reconnect failed:", err.message);
      scheduleReconnect();
    } finally {
      cancelReady();
    }
  }

  function attachHandlers(target: Client): void {
    const message = buildMessageHandler();
    const interaction = buildInteractionHandler();
    target.on("messageCreate", event => {
      if (client !== target || isShuttingDown) return;
      void message(event).catch(error => console.error("[pi-remote] Message handler failed:", error));
    });
    target.on("interactionCreate", event => {
      if (client !== target || isShuttingDown) return;
      void interaction(event).catch(error => console.error("[pi-remote] Interaction handler failed:", error));
    });
  }

  function buildInteractionHandler() {
    return async (interaction: any) => {
      // Ownership precedes authorization and EVERY acknowledgement, including /rc.
      if (transitionPending || remotelyPaused || !client?.isReady() ||
        interaction.channelId !== runtime.activeChannelId || !await maintainConnection()) return;
      if (interaction.id) {
        if (handledInteractions.has(interaction.id)) return;
        const now = Date.now();
        for (const [id, time] of handledInteractions) if (now - time > 15 * 60_000) handledInteractions.delete(id);
        handledInteractions.set(interaction.id, now);
      }
      if (interaction.isStringSelectMenu?.() && interaction.customId.startsWith("pi-choice:")) {
        const token = interaction.customId.slice("pi-choice:".length);
        const menu = choiceMenus.get(token);
        if (!menu) return;
        if (menu.userId !== interaction.user.id || menu.channelId !== interaction.channelId ||
          (activeConfig?.allowedUserIds?.length && !activeConfig.allowedUserIds.includes(interaction.user.id))) {
          await interaction.reply({ content: "This menu is unavailable to you.", ephemeral: true });
          return;
        }
        if (Date.now() - menu.created > 10 * 60_000 || remotelyPaused ||
          menu.channelId !== runtime.activeChannelId || menu.sessionId !== activeSessionManager?.getSessionId()) {
          choiceMenus.delete(token);
          await interaction.update({ content: `This menu has expired. Run /${menu.kind} again.`, components: [] });
          return;
        }
        const value = interaction.values[0];
        if (value === "__cancel__") {
          choiceMenus.delete(token);
          await interaction.update({ content: "Selection cancelled.", components: [] });
        } else if (value === "__prev__" || value === "__next__") {
          menu.page = Math.max(0, Math.min(Math.ceil(menu.entries.length / FORK_PAGE_SIZE) - 1,
            menu.page + (value === "__next__" ? 1 : -1)));
          await interaction.update(choiceMenuView(menu, token));
        } else {
          const index = Number(value);
          const selected = Number.isInteger(index) && String(index) === value ? menu.entries[index] : undefined;
          if (agentBusy || !selected) {
            await interaction.reply({ content: "Pi is busy or that option is unavailable. Try again when idle.", ephemeral: true });
            return;
          }
          choiceMenus.delete(token);
          await interaction.update({ content: menu.kind === "resume" ? `Resuming ${selected.label}…` : `Setting ${menu.kind} to ${selected.label}…`, components: [] });
          sendCoreCommand(menu.kind, selected.value, interaction.channelId, interaction.user.id);
        }
        return;
      }
      if (interaction.isStringSelectMenu?.() && interaction.customId.startsWith("pi-fork:")) {
        const token = interaction.customId.slice("pi-fork:".length);
        const menu = forkMenus.get(token);
        if (!menu) return;
        if (menu.userId !== interaction.user.id || menu.channelId !== interaction.channelId ||
          (activeConfig?.allowedUserIds?.length && !activeConfig.allowedUserIds.includes(interaction.user.id))) {
          await interaction.reply({ content: "This fork menu is unavailable to you.", ephemeral: true });
          return;
        }
        if (Date.now() - menu.created > 10 * 60_000 || remotelyPaused ||
          menu.channelId !== runtime.activeChannelId || menu.sessionId !== activeSessionManager?.getSessionId()) {
          forkMenus.delete(token);
          await interaction.update({ content: "This fork menu has expired. Run /fork again.", components: [] });
          return;
        }
        const value = interaction.values[0];
        if (value === "__cancel__") {
          forkMenus.delete(token);
          await interaction.update({ content: "Fork cancelled.", components: [] });
        } else if (value === "__prev__" || value === "__next__") {
          menu.page = Math.max(0, Math.min(Math.ceil(menu.entries.length / FORK_PAGE_SIZE) - 1,
            menu.page + (value === "__next__" ? 1 : -1)));
          await interaction.update(forkMenuView(menu, token));
        } else if (!agentBusy && menu.entries.some(entry => entry.id === value) && activeSessionManager.getEntry(value)) {
          forkMenus.delete(token);
          await interaction.update({ content: `Forking from entry ${value}…`, components: [] });
          pendingReplyChannelId = interaction.channelId;
          pendingReplyUserId = interaction.user.id;
          const payload = Buffer.from(JSON.stringify({ command: "fork", args: value })).toString("base64url");
          (pi.sendUserMessage as (text: string, options?: { expandPromptTemplates?: boolean }) => void)(
            `/discord-remote-core ${payload}`, { expandPromptTemplates: true },
          );
        } else {
          await interaction.reply({ content: "Pi is busy or the selected entry is unavailable. Try again when idle.", ephemeral: true });
        }
        return;
      }
      if (interaction.isStringSelectMenu?.() && interaction.customId.startsWith("pi-question:")) {
        if (interaction.customId !== `pi-question:${questionToken}` || interaction.message?.id !== questionMessageId) return;
        if (interaction.channelId !== questionChannelId || (questionUserId && interaction.user.id !== questionUserId) ||
          (activeConfig?.allowedUserIds?.length && !activeConfig.allowedUserIds.includes(interaction.user.id))) {
          await interaction.reply({ content: "You cannot answer this question.", ephemeral: true });
          return;
        }
        const values: string[] = interaction.values ?? [];
        if (!values.length || values.some(value => value !== "__other__" && !questionValues.includes(value))) return;
        await maintainConnection(true);
        const value = values[0];
        if (value === "__other__") {
          questionUserId ??= interaction.user.id;
          const modal = new ModalBuilder().setCustomId(`pi-question-other:${questionToken}`).setTitle("Custom answer");
          const input = new TextInputBuilder().setCustomId("answer").setLabel("Your answer").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
          modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
          await interaction.showModal(modal);
        } else if (questionResolver) {
          await interaction.deferUpdate();
          questionResolver(values.join("\n"));
        } else {
          await interaction.reply({ content: "This question is no longer active.", ephemeral: true });
        }
        return;
      }
      if (interaction.isModalSubmit?.() && interaction.customId.startsWith("pi-question-other:")) {
        if (interaction.customId !== `pi-question-other:${questionToken}`) return;
        if (interaction.channelId !== questionChannelId || (questionUserId && interaction.user.id !== questionUserId) ||
          (activeConfig?.allowedUserIds?.length && !activeConfig.allowedUserIds.includes(interaction.user.id))) {
          await interaction.reply({ content: "You cannot answer this question.", ephemeral: true });
          return;
        }
        await maintainConnection(true);
        const answer = interaction.fields.getTextInputValue("answer");
        await interaction.reply({ content: "Custom answer recorded.", ephemeral: true });
        questionResolver?.(answer);
        return;
      }
      if (!interaction.isChatInputCommand?.() || !activeConfig) return;
      if (MAPPED_CORE_COMMANDS.some(command => command.name === interaction.commandName)) {
        if (activeConfig.allowedUserIds?.length && !activeConfig.allowedUserIds.includes(interaction.user.id)) {
          await interaction.reply({ content: "❌ You are not on the allow-list.", ephemeral: true });
          return;
        }
        if (remotelyPaused || !client?.isReady() || interaction.channelId !== runtime.activeChannelId) {
          return; // Connection may have changed while awaiting ownership validation.
        }
        const coreCommand = interaction.commandName;
        await maintainConnection(true);
        let coreArgs = "";
        if (coreCommand === "name") coreArgs = interaction.options.getString("name", true);
        else if (coreCommand === "tree") coreArgs = interaction.options.getString("entry", true);
        if (agentBusy && coreCommand !== "abort") {
          await interaction.reply({ content: "⏳ Pi is processing. Only /abort can run right now.", ephemeral: true });
          return;
        }
        if (coreCommand === "resume") {
          await interaction.deferReply({ ephemeral: true });
          const sessions = await SessionManager.list(activeCwd, activeSessionManager.getSessionDir());
          const entries = sessions.filter(session => session.id !== currentSessionId)
            .sort((a, b) => b.modified.getTime() - a.modified.getTime())
            .map(session => ({ label: sessionLabel(session.name, session.firstMessage, session.id), value: session.path }));
          if (!entries.length) {
            await interaction.editReply({ content: "No other saved sessions in this working directory." });
            return;
          }
          for (const [key, menu] of choiceMenus) if (Date.now() - menu.created > 10 * 60_000) choiceMenus.delete(key);
          const token = randomUUID();
          const menu: ChoiceMenu = { userId: interaction.user.id, channelId: interaction.channelId,
            sessionId: currentSessionId!, kind: "resume", entries, page: 0, created: Date.now() };
          choiceMenus.set(token, menu);
          await interaction.editReply({ ...choiceMenuView(menu, token) });
          return;
        }
        if (coreCommand === "model" || coreCommand === "thinking") {
          // Acknowledge before looking up models to meet Discord's interaction deadline.
          await interaction.deferReply({ ephemeral: true });
          const entries = coreCommand === "model"
            ? (activeModelRegistry?.getAvailable?.() ?? []).map((model: any) => ({
              label: `${model.name} (${model.provider}/${model.id})`, value: `${model.provider}/${model.id}`,
            }))
            : THINKING_LEVELS.map(level => ({ label: level, value: level }));
          if (!entries.length) {
            await interaction.editReply({ content: "No available models found." });
            return;
          }
          for (const [key, menu] of choiceMenus) if (Date.now() - menu.created > 10 * 60_000) choiceMenus.delete(key);
          const token = randomUUID();
          const menu: ChoiceMenu = { userId: interaction.user.id, channelId: interaction.channelId,
            sessionId: activeSessionManager.getSessionId(), kind: coreCommand, entries, page: 0, created: Date.now() };
          choiceMenus.set(token, menu);
          await interaction.editReply(choiceMenuView(menu, token));
          return;
        }
        if (coreCommand === "fork") {
          const entries = (activeSessionManager?.getEntries() ?? [])
            .filter((entry: any) => entry.type === "message" && entry.message.role === "user")
            .map((entry: any) => ({ id: entry.id, text: typeof entry.message.content === "string"
              ? entry.message.content : (entry.message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("") }))
            .filter((entry: any) => entry.text.trim()).reverse();
          if (!entries.length) {
            await interaction.reply({ content: "No user messages to fork from yet.", ephemeral: true });
            return;
          }
          for (const [key, menu] of forkMenus) if (Date.now() - menu.created > 10 * 60_000) forkMenus.delete(key);
          const token = randomUUID();
          const menu: ForkMenu = { userId: interaction.user.id, channelId: interaction.channelId,
            sessionId: activeSessionManager.getSessionId(), entries, page: 0, created: Date.now() };
          forkMenus.set(token, menu);
          await interaction.reply({ ...forkMenuView(menu, token), ephemeral: true });
          return;
        }
        await interaction.reply({ content: `Running /${coreCommand}${coreArgs ? ` ${coreArgs}` : ""}…` });
        sendCoreCommand(coreCommand, coreArgs, interaction.channelId, interaction.user.id);
        return;
      }
      if (interaction.commandName !== "rc") return;
      if (activeConfig.allowedUserIds?.length && !activeConfig.allowedUserIds.includes(interaction.user.id)) {
        await interaction.reply({ content: "❌ You are not on the allow-list.", ephemeral: true });
        return;
      }
      const action = interaction.options.getSubcommand();
      if (action === "setup") {
        await interaction.reply({ content: "/rc setup is only available in the Pi terminal.", ephemeral: true });
        return;
      }
      if (action === "enable" || action === "connect") {
        await maintainConnection(true);
        await interaction.reply({ content: "This session is already enabled and connected.", ephemeral: true });
      } else if (action === "status") {
        await interaction.reply({ content: `Session: ${currentSessionId}\nConnection: ${connection?.id}\nState: connected\nChannel: ${runtime.activeChannelId}\nExpires: ${new Date(connection!.expiresAt).toISOString()}`, ephemeral: true });
      } else if (action === "disable" || action === "disconnect") {
        await interaction.deferReply({ ephemeral: true });
        try {
          if (action === "disable") await disableRemote();
          else await disconnectRemote();
          await interaction.editReply({ content: action === "disable"
            ? "Disabled: connection destroyed; channel retained permanently offline. Use the Pi terminal to enable a new connection."
            : "Disconnected: connection and binding retained. Run /rc connect in the Pi terminal to reconnect." });
        } catch (error) {
          await interaction.editReply({ content: `Remote operation failed: ${String(error)}` });
        }
      }
    };
  }

  function buildMessageHandler() {
    return async (message: Message) => {
      if (!activeConfig) return;
      if (message.author.bot) return;
      if (transitionPending || remotelyPaused || message.channelId !== runtime.activeChannelId || !await maintainConnection()) return;

      if (
        activeConfig.allowedUserIds?.length &&
        !activeConfig.allowedUserIds.includes(message.author.id)
      ) {
        await message.reply("❌ Your user ID is not on the allow-list.").catch(() => {});
        return;
      }

      // Cancellation is not an answer, and must stop the entire questionnaire.
      if (questionResolver && message.channelId === questionChannelId) {
        if (questionUserId && questionUserId !== message.author.id) return;
        await maintainConnection(true);
        if (/^(stop|cancel|停下|停止|取消|停+)[!！。\s]*$/i.test(message.content.trim())) {
          questionRejecter?.(new Error("Questionnaire cancelled by user"));
          clearQuestionState();
          await message.reply("Questionnaire cancelled.");
          return;
        }
        if (activeConfig.reactions !== false) {
          await message.react("✅").catch(() => {});
        }
        const resolve = questionResolver;
        resolve(message.content);
        return;
      }

      if (agentBusy) {
        await message.reply("⏳ Still processing the previous message — please wait.").catch(() => {});
        return;
      }

      if (activeConfig.reactions !== false) {
        await message.react("⏳").catch(() => {});
      }

      await maintainConnection(true);
      pendingSource = { messageId: message.id, channelId: message.channelId,
        entryCount: activeSessionManager?.getEntries().length ?? 0, text: "" };
      pendingReplyChannelId = message.channelId;
      pendingReplyUserId = message.author.id;
      collectedAssistantText = [];
      try {
        const parts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
        const files: string[] = [];
        for (const attachment of message.attachments.values()) {
          const url = new URL(attachment.url);
          if (url.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) {
            throw new Error("Attachment URL is not a Discord CDN URL.");
          }
          if (attachment.size > 20 * 1024 * 1024) throw new Error(`Attachment ${attachment.name} exceeds 20 MB.`);
          const response = await withTimeout(fetch(url), 20_000, "download_attachment");
          if (!response.ok) throw new Error(`Could not download ${attachment.name}: HTTP ${response.status}`);
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > 20 * 1024 * 1024) throw new Error(`Attachment ${attachment.name} exceeds 20 MB.`);
          const mimeType = attachment.contentType?.split(";")[0] ?? "";
          if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType)) {
            parts.push({ type: "image", data: bytes.toString("base64"), mimeType });
          } else {
            const dir = await mkdtemp(join(tmpdir(), "pi-discord-attachment-"));
            const path = join(dir, basename(attachment.name ?? "attachment"));
            await writeFile(path, bytes);
            files.push(`${attachment.name}: ${path}`);
          }
        }
        const prompt = [message.content, files.length ? `Attached files (local paths; use the read tool to inspect):\n${files.join("\n")}` : ""].filter(Boolean).join("\n\n");
        parts.unshift({ type: "text", text: prompt || "Please inspect the attached image(s)." });
        if (pendingSource?.messageId === message.id) pendingSource.text = prompt || "Please inspect the attached image(s).";
        if (isShuttingDown || remotelyPaused || transitionPending || message.channelId !== runtime.activeChannelId || !await maintainConnection()) return;
        pi.sendUserMessage(parts);
      } catch (err: any) {
        pendingReplyChannelId = null;
        pendingReplyUserId = null;
        pendingSource = null;
        await message.reply(`❌ Attachment failed: ${String(err?.message ?? err)}`).catch(() => {});
      }
    };
  }

  pi.on("session_before_switch", async (event: any, ctx: any) => {
    try {
      if (event.reason === "new") return await prepareReplacement(ctx);
      if (event.reason === "resume" && resumeTarget && !forceRecovery) return await prepareReplacement(ctx, undefined, resumeTarget.id);
      if (!forceRecovery && (agentBusy || questionResolver || rcCommandRunning || transitionPending)) return { cancel: true };
    } catch (error) {
      ctx.ui.notify(`Cannot safely switch remote session: ${String(error)}`, "error");
      return { cancel: true };
    }
  });
  pi.on("session_before_fork", async (event: any, ctx: any) => {
    try { return await prepareReplacement(ctx, event.position === "before" ? event.entryId : undefined); }
    catch (error) {
      ctx.ui.notify(`Cannot safely fork remote session: ${String(error)}`, "error");
      return { cancel: true };
    }
  });

  pi.on("session_start", async (event: any, ctx: any) => {
    activeModelRegistry = ctx.modelRegistry;
    activeSessionManager = ctx.sessionManager;
    activeCwd = ctx.cwd;
    currentSessionId = ctx.sessionManager.getSessionId();
    connectNotify = (msg, level) => ctx.ui.notify(msg, level);
    connectSetStatus = (key, val) => ctx.ui.setStatus(key, val);
    const saved = reloadSlot[reloadKey];
    delete reloadSlot[reloadKey];
    startMaintenance();
    connection = await connections.get(currentSessionId!);
    if (!saved || event.reason === "startup") return;
    const creating = event.reason === "new" || event.reason === "fork";
    const resuming = event.reason === "resume" && saved.remoteResume && !saved.recovery;
    let allocated = false;
    outcomeSlot[outcomeKey] = { ok: false };
    try {
      if ((creating || resuming) && saved.enabled && !connection) {
        const allocation = await connections.allocate(currentSessionId!);
        connection = allocation.connection;
        allocated = allocation.created;
      }
      // Terminal resume/startup stay disconnected. Discord resume and rollback carry the flame.
      const reconnect = (creating || resuming || event.reason === "reload" || saved.recovery) && saved.connected;
      if (reconnect && saved.config) {
        await startClient(saved.config, ctx.cwd, connectNotify, connectSetStatus, saved.nextChannelId);
      }
      outcomeSlot[outcomeKey] = { ok: true, channelId: runtime.activeChannelId ?? undefined };
    } catch (error) {
      outcomeSlot[outcomeKey] = { ok: false, error: String(error) };
      if (creating || resuming) {
        const retainedChannel = connection?.channelId;
        if (allocated) await disableRemote().catch(() => {});
        else await disconnectRemote().catch(() => {});
        if (saved.preparedDestination && saved.nextChannelId && saved.config &&
          (allocated || retainedChannel !== saved.nextChannelId)) {
          await new REST({ version: "10" }).setToken(saved.config.token)
            .delete(Routes.channel(saved.nextChannelId)).catch(() => {});
        }
        if (saved.previousFile) {
          isShuttingDown = false; // Failed connect closed transport, not this replacement runtime.
          recovery = { token: randomUUID(), saved, error: String(error) };
          // Session changes are command-only. Never call switchSession from session_start.
          const token = recovery.token;
          setTimeout(() => {
            if (recovery?.token === token && !isShuttingDown) {
              (pi.sendUserMessage as (text: string, options: { expandPromptTemplates: boolean }) => void)(
                `/discord-remote-recover ${token}`, { expandPromptTemplates: true });
            }
          }, 0);
        }
      }
      ctx.ui.notify(`Remote transition failed: ${String(error)}${recovery ? "; restoring original session…" : ""}`, "error");
    }
  });

  pi.registerCommand("discord-remote-recover", {
    description: "Internal authenticated rollback after a failed remote session transition",
    handler: async (token: string, ctx: any) => {
      if (!recovery || recovery.token !== token.trim()) return;
      const failed = recovery;
      recovery = undefined;
      forceRecovery = true;
      reloadSlot[reloadKey] = { ...failed.saved, nextChannelId: undefined, recovery: true };
      const report = async (text: string) => {
        if (failed.saved.config && failed.saved.previousChannelId) {
          await sendMessageViaDiscordRest({ token: failed.saved.config.token, channelId: failed.saved.previousChannelId, content: text });
        }
      };
      try {
        const result = await ctx.switchSession(failed.saved.previousFile!, { withSession: async (fresh: any) => {
          const restored = outcomeSlot[outcomeKey]?.ok;
          const text = restored ? `❌ Switch failed; original session and connection restored. ${failed.error}`
            : `❌ Switch failed, and reconnecting the original session also failed. Use /rc connect in its terminal. ${failed.error}`;
          fresh.ui.notify(text, "error");
          await report(text);
        } });
        if (result.cancelled) throw new Error("Rollback was cancelled");
      } catch (error) {
        await report(`❌ Switch failed and rollback failed: ${String(error)}. Resume the original session from the terminal.`);
      } finally {
        forceRecovery = false;
        delete reloadSlot[reloadKey];
      }
    },
  });

  pi.on("session_shutdown", async (event: any, ctx: any) => {
    if (expiryTimer) clearInterval(expiryTimer);
    if (preparationTimer) clearTimeout(preparationTimer);
    try {
      if (currentSessionId) connection = await connections.get(currentSessionId);
      if (!forceRecovery && ["reload", "new", "resume", "fork"].includes(event.reason)) {
        reloadSlot[reloadKey] = { config: activeConfig, cwd: ctx.cwd,
          enabled: !!connection, connected: !!client?.isReady() && !remotelyPaused,
          previousFile: ctx.sessionManager.getSessionFile(), previousChannelId: runtime.activeChannelId ?? undefined,
          nextChannelId: pendingNextChannelId ?? undefined, remoteResume: !!resumeTarget,
          preparedDestination: !!preparedChannel };
      }
    } finally {
      await disconnectRemote();
      preparedChannel = null;
      activeConfig = null;
    }
  });

  // ── Connect + channel-create helper ──────────────────────────────────────

  async function startClient(
    cfg: Config,
    cwd: string,
    notifyFn: (msg: string, level: "success" | "error" | "warning" | "info") => void,
    setStatusFn: (key: string, val: string | undefined) => void,
    nextChannelId?: string,
  ): Promise<void> {
    if (!currentSessionId) throw new Error("No active Pi session ID.");
    const sessionId = currentSessionId;
    if (client?.isReady() && runtime.activeChannelId && await maintainConnection()) {
      notifyFn("Already connected to Discord.", "info");
      return;
    }
    if (client) await disconnectRemote();
    connection = await connections.get(sessionId);
    if (!connection) throw new Error("Remote control is disabled. Run /rc enable first.");
    connection = await connections.claim(sessionId, connection.id, ownerId);
    activeConfig = cfg;
    remotelyPaused = true; // Do not accept events until binding and registration succeed.
    isShuttingDown = false;
    reconnectAttempt = 0;
    reconnectFailed = false;
    clearReconnectTimer();

    // Capture closures for reconnect reuse
    connectNotify = notifyFn;
    connectSetStatus = setStatusFn;

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    attachHandlers(client);

    // ── Reconnection handling (for post-connect disconnects only) ──────
    client.on("error", (err) => {
      console.error("[pi-remote] Discord client error:", err);
      if (!remotelyPaused) setStatusFn("pi-remote", "⚠️ Discord: error");
    });

    const initialClient = client;
    initialClient.on("shardDisconnect", () => {
      if (isShuttingDown || client !== initialClient) return;
      console.error("[pi-remote] Discord WebSocket disconnected, starting reconnect…");
      if (!remotelyPaused) setStatusFn("pi-remote", "🔄 Discord: reconnecting…");
      scheduleReconnect();
    });

    // ── Await login + ready so we can surface immediate errors ─────────
    // Register the ready listener BEFORE login to avoid a race window
    // where ready fires before the Promise is constructed.
    let cancelInitialReady = () => {};
    const readyPromise = new Promise<void>((resolve, reject) => {
      const initial = client!;
      const timeout = setTimeout(() => {
        initial.off("ready", onReady);
        reject(new Error("ready timeout (30s)"));
      }, 30_000);
      const onReady = async (c: Client) => {
        clearTimeout(timeout);
        cancelInitialReady = () => {};
        // Channel creation happens inside this single ready handler
        const channelName = makeChannelName(cwd);
        try {
          const guild = await c.guilds.fetch(cfg.guildId);
          if (client !== c || isShuttingDown) throw new Error("Connection attempt cancelled");
          const candidateId = connection!.channelId ?? nextChannelId;
          const savedChannel = candidateId ? await guild.channels.fetch(candidateId) : null;
          if (client !== c || isShuttingDown) throw new Error("Connection attempt cancelled");
          if (candidateId && !savedChannel?.isTextBased()) {
            throw new Error("Bound/prepared channel is missing or not text-based; refusing to rebind.");
          }
          const newChannel = savedChannel?.isTextBased() ? savedChannel : await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            ...(cfg.categoryId ? { parent: cfg.categoryId } : {}),
            topic: `Pi session ${sessionId} — ${cwd}`,
          });
          try {
            if (client !== c || isShuttingDown) throw new Error("Connection attempt cancelled");
            connection = await connections.bind(sessionId, connection!.id, ownerId, newChannel.id);
          } catch (error) {
            if (!candidateId) await newChannel.delete("Connection binding failed").catch(() => {});
            throw error;
          }
          runtime.activeChannelId = newChannel.id;
          runtime.sessionChannelName = newChannel.name;
          const rest = new REST({ version: "10" }).setToken(cfg.token);
          await rest.put(Routes.applicationGuildCommands(c.user!.id, cfg.guildId), { body: [
            ...MAPPED_CORE_COMMANDS.map(({ name, description }) => {
              const command = new SlashCommandBuilder().setName(name).setDescription(description);
              if (name === "name") command.addStringOption(o => o.setName("name").setDescription("New session name").setRequired(true));
              if (name === "tree") command.addStringOption(o => o.setName("entry").setDescription("Session entry ID").setRequired(true));
              return command.toJSON();
            }),
            new SlashCommandBuilder().setName("rc").setDescription("Control the Pi remote session")
              .addSubcommand(s => s.setName("disable").setDescription("Destroy this session's connection; preserve channel"))
              .addSubcommand(s => s.setName("enable").setDescription("Allocate a connection (use the Pi terminal when offline)"))
              .addSubcommand(s => s.setName("connect").setDescription("Connect an enabled session (Pi terminal when offline)"))
              .addSubcommand(s => s.setName("disconnect").setDescription("Disconnect but retain the connection resource"))
              .addSubcommand(s => s.setName("status").setDescription("Show connection status"))
              .toJSON(),
          ] });

          if (client !== c || isShuttingDown) throw new Error("Connection attempt cancelled");
          connection = await connections.touch(sessionId, connection!.id, ownerId);
          if (client !== c || isShuttingDown) throw new Error("Connection attempt cancelled");
          remotelyPaused = false;
          const label = `🔌 Discord: #${newChannel.name}`;
          notifyFn(`Connected as ${c.user!.tag} → #${newChannel.name}`, "success");
          setStatusFn("pi-remote", label);
        } catch (err) {
          reject(err);
          return;
        }
        resolve();
      };
      cancelInitialReady = () => { clearTimeout(timeout); initial.off("ready", onReady); };
      initial.once("ready", onReady);
    });

    void readyPromise.catch(() => {});
    try {
      setStatusFn("pi-remote", "🔌 Discord: connecting…");
      await withTimeout(client.login(cfg.token), 30_000, "discord_login");
      await withTimeout(readyPromise, 45_000, "discord_binding");
    } catch (err: any) {
      // Initial login failure — clean up and notify immediately
      console.error("[pi-remote] Initial login failed:", err.message);
      cancelInitialReady();
      await disconnectRemote();
      notifyFn(`❌ Failed to connect: ${err.message}`, "error");
      setStatusFn("pi-remote", undefined);
      throw err;
    }
  }

  // ── Intercept ask_user_question → redirect to Discord version ─────────

  // When Discord is connected, block the original ask_user_question (TUI-only)
  // and tell the LLM to use discord_ask_user_question instead.
  // When Discord is not connected, let the original tool through as fallback.
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "ask_user_question") return;
    if (!client?.isReady() || remotelyPaused || !runtime.activeChannelId || !await maintainConnection()) return;
    return { block: true, reason: "Discord is connected — use discord_ask_user_question instead." };
  });

  // ── System prompt hint: prefer Discord version when connected ──────────

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!client?.isReady() || remotelyPaused || !runtime.activeChannelId || !await maintainConnection()) return;
    const activeChannelId = runtime.activeChannelId;
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n" +
        (activeChannelId
          ? `Active Discord session channel ID: ${activeChannelId}. ` +
            "When using discord_send_file, pass this as channelId.\n\n"
          : "") +
        "When you need to ask the user a clarifying question, use the " +
        "discord_ask_user_question tool instead of ask_user_question. " +
        "The Discord version sends questions to the user's Discord channel. " +
        "If discord_ask_user_question returns an error about no UI, " +
        "fall back to ask_user_question.",
    };
  });

  // ── Tool: discord_ask_user_question → Discord ───────────────────────────

  // Send questions to Discord — avoids the TUI-only dialog from
  // @juicesharp/rpiv-ask-user-question that remote users can't see.
  // When Discord is connected, use this tool instead of ask_user_question.
  pi.registerTool({
    name: "discord_ask_user_question",
    executionMode: "sequential",
    label: "Ask User Question (Discord)",
    description:
      "Ask the user one or more structured clarifying questions via Discord. " +
      "Use this instead of ask_user_question when Discord is connected. " +
      "Questions and options are forwarded to the Discord channel. " +
      "The user replies with the option number, label, or custom text.",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String(),
          header: Type.String(),
          options: Type.Array(
            Type.Object({
              label: Type.String(),
              description: Type.String(),
              preview: Type.Optional(Type.String()),
            }),
          ),
          multiSelect: Type.Optional(Type.Boolean()),
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const channelId = pendingReplyChannelId;
      if (!client?.isReady() || remotelyPaused || transitionPending || !channelId || channelId !== runtime.activeChannelId || !await maintainConnection()) {
        return {
          content: [
            {
              type: "text",
              text: "Discord not connected. Please answer in the Pi TUI directly.",
            },
          ],
          details: { answers: [], cancelled: true, error: "no_ui" },
        };
      }

      let channel: TextChannel | null = null;
      try {
        const fetched = await client.channels.fetch(channelId);
        if (fetched?.isTextBased()) channel = fetched as TextChannel;
      } catch {
        // channel fetch failed — fall through
      }
      if (!channel) {
        return {
          content: [
            {
              type: "text",
              text: "Discord channel not available. Use ask_user_question instead for TUI-based questions, or connect Discord first.",
            },
          ],
          details: { answers: [], cancelled: true, error: "no_ui" },
        };
      }

      interface Answer {
        questionIndex: number;
        question: string;
        kind: "option" | "custom" | "chat" | "multi";
        answer: string | null;
        selected?: string[];
        notes?: string;
        preview?: string;
      }

      const answers: Answer[] = [];

      for (let qi = 0; qi < params.questions.length; qi++) {
        const q = params.questions[qi];

        // Show the question once; choices and descriptions live only in the select menu.
        const questionText = `## ${q.header}: ${q.question}`;

        // Discord select menus allow at most 25 options; reserve one for custom input.
        if (q.options.length > 24) {
          return {
            content: [{ type: "text", text: `Question ${qi + 1} has more than 24 options; Discord menus support at most 24 plus Other.` }],
            details: { answers, cancelled: true, error: "too_many_options" },
          };
        }
        // Install the waiter BEFORE publishing the component. IDs are unique per question.
        if (questionResolver) throw new Error("Another questionnaire is already waiting for an answer.");
        questionToken = randomUUID();
        questionChannelId = channelId;
        questionUserId = pendingReplyUserId;
        questionValues = q.options.map(option => option.label);
        const answerPromise = new Promise<string>((resolve, reject) => {
          questionResolver = resolve;
          questionRejecter = reject;
          questionTimeout = setTimeout(() => {
            reject(new Error("Question timed out — no response in 5 minutes"));
            clearQuestionState();
          }, 300_000);
          if (signal) {
            const onAbort = () => { reject(new Error("Question cancelled")); clearQuestionState(); };
            questionAbortListener = onAbort;
            questionAbortSignal = signal;
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          }
        });
        void answerPromise.catch(() => {});
        try {
          if (signal?.aborted) throw new Error("Question cancelled");
          const choices = q.options.map((option: any, index: number) => ({
            label: `${index + 1}. ${option.label}`.slice(0, 100),
            value: option.label,
            description: option.description?.slice(0, 100),
          }));
          choices.push({ label: "Other — enter a custom answer", value: "__other__", description: "Type an answer not listed above" });
          const menu = new StringSelectMenuBuilder()
            .setCustomId(`pi-question:${questionToken}`)
            .setPlaceholder(q.multiSelect ? "Choose one or more options" : "Choose an option")
            .setMinValues(1)
            .setMaxValues(q.multiSelect ? Math.max(1, choices.length - 1) : 1)
            .addOptions(choices);
          const sent = await channel.send({ content: questionText, components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] });
          questionMessageId = sent.id;
          await maintainConnection(true);
        } catch {
          questionRejecter?.(new Error("Failed to send question"));
          clearQuestionState();
          return {
            content: [{ type: "text", text: "Failed to send question to Discord." }],
            details: { answers: [], cancelled: true, error: "no_ui" },
          };
        }

        let answerText: string;
        try {
          answerText = await answerPromise;
        } catch (err: any) {
          clearQuestionState();
          return {
            content: [{ type: "text", text: `Question cancelled: ${err.message}` }],
            details: { answers, cancelled: true },
          };
        }
        clearQuestionState();

        const trimmed = answerText.trim();

        // Check for "chat" escape
        if (trimmed.toLowerCase() === "chat" || trimmed.toLowerCase() === "/chat") {
          answers.push({
            questionIndex: qi,
            question: q.question,
            kind: "chat",
            answer: null,
          });
          continue;
        }

        // Parse answer
        if (q.multiSelect) {
          // Multi-select: try to parse numbers/labels
          const parts = trimmed.split(/[\n,]+/).map((part) => part.trim()).filter(Boolean);
          const selected: string[] = [];
          for (const part of parts) {
            const num = parseInt(part, 10);
            if (!isNaN(num) && num >= 1 && num <= q.options.length) {
              selected.push(q.options[num - 1].label);
            } else {
              // Try label match
              const match = q.options.find(
                (o: any) => o.label.toLowerCase() === part.toLowerCase(),
              );
              if (match) {
                if (!selected.includes(match.label)) selected.push(match.label);
              }
            }
          }

          if (selected.length > 0) {
            answers.push({
              questionIndex: qi,
              question: q.question,
              kind: "multi",
              answer: selected.join(", "),
              selected,
            });
          } else {
            // No match — treat as custom
            answers.push({
              questionIndex: qi,
              question: q.question,
              kind: "custom",
              answer: trimmed,
            });
          }
        } else {
          // Single-select: try number first, then label match, then custom
          const num = parseInt(trimmed, 10);
          if (!isNaN(num) && num >= 1 && num <= q.options.length) {
            const opt = q.options[num - 1];
            answers.push({
              questionIndex: qi,
              question: q.question,
              kind: "option",
              answer: opt.label,
              preview: opt.preview,
            });
          } else {
            const match = q.options.find(
              (o: any) => o.label.toLowerCase() === trimmed.toLowerCase(),
            );
            if (match) {
              answers.push({
                questionIndex: qi,
                question: q.question,
                kind: "option",
                answer: match.label,
                preview: match.preview,
              });
            } else {
              // Custom answer
              answers.push({
                questionIndex: qi,
                question: q.question,
                kind: "custom",
                answer: trimmed,
              });
            }
          }
        }
      }

      const summary = answers
        .map((a) => {
          if (a.kind === "chat") return `Q${a.questionIndex + 1}: [chat]`;
          if (a.kind === "multi") return `Q${a.questionIndex + 1}: ${a.selected?.join(", ")}`;
          return `Q${a.questionIndex + 1}: ${a.answer}`;
        })
        .join("; ");

      return {
        content: [{ type: "text", text: `User answers: ${summary}` }],
        details: { answers, cancelled: false },
      };
    },
  });

  // ── Tool: upload a file or artifact to Discord (explicit opt-in) ─────────
  pi.registerTool({
    name: "discord_send_file",
    label: "Send File To Discord",
    description:
      "Upload a local file/artifact to the active Discord session channel. " +
      "Use only when the user explicitly asks to send a file. Provide exactly one source: local path, URL, or base64. This also supports images.",
    parameters: Type.Object({
      channelId: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      base64: Type.Optional(Type.String()),
      mediaType: Type.Optional(Type.String()),
      filename: Type.Optional(Type.String()),
      caption: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const normalized = { ...params };
      let provided = [normalized.path, normalized.url, normalized.base64].filter(Boolean).length;
      if (provided === 0 && lastImageArtifactPath) {
        normalized.path = lastImageArtifactPath;
        provided = 1;
      }

      if (provided !== 1) {
        return {
          content: [{ type: "text", text: "Provide exactly one file source: path, url, or base64." }],
          details: { ok: false, error: "invalid_source_count" },
        };
      }

      let result: { ok: boolean; sentAs?: string; error?: string };
      try {
        result = await withTimeout(
          sendAttachmentToActiveChannel(normalized),
          30_000,
          "discord_send_image_total",
        );
      } catch (err: any) {
        const msg = String(err?.message ?? "send_failed");
        result = { ok: false, error: msg };
      }
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Failed to send file to Discord: ${result.error}` }],
          details: result,
        };
      }

      return {
        content: [{ type: "text", text: `File sent to Discord (${result.sentAs}).` }],
        details: result,
      };
    },
  });

  // Bridge the built-ins that Pi exposes through stable ExtensionCommandContext APIs.
  // Invoked internally by the mapped Discord core slash commands.
  pi.registerCommand("discord-remote-core", {
    description: "Internal Discord bridge for mapped Pi core commands",
    handler: async (encoded: string, ctx: any) => {
      let request: { command: string; args?: string };
      try {
        request = JSON.parse(Buffer.from(encoded.trim(), "base64url").toString("utf8"));
      } catch {
        return;
      }
      const args = request.args?.trim() ?? "";
      const replyChannelId = pendingReplyChannelId;
      const replyUserId = pendingReplyUserId;
      const replyToken = activeConfig?.token;
      // The command's pi/ctx become stale after session replacement. Reply via
      // Discord REST, not the old runtime's client or UI callback.
      const replyAfterReplacement = async (text: string) => {
        if (replyChannelId && replyToken) {
          const content = `${replyUserId ? `<@${replyUserId}> ` : ""}${text}`;
          try {
            const sent = await sendMessageViaDiscordRest({ channelId: replyChannelId, token: replyToken, content });
            if (!sent.ok) console.error("[pi-remote] Replacement reply failed:", sent.error);
          } catch (err) {
            console.error("[pi-remote] Replacement reply failed:", err);
          }
        }
      };
      let result: string;
      try {
        switch (request.command) {
          case "abort":
            ctx.abort();
            result = "🛑 Pi operation aborted.";
            break;
          case "compact":
            ctx.compact();
            result = "🗜️ Session compaction requested.";
            break;
          case "model": {
            if (!args) throw new Error("Pass a model as provider/model.");
            const model = ctx.modelRegistry.getAvailable().find((item: any) =>
              `${item.provider}/${item.id}`.toLowerCase() === args.toLowerCase() ||
              item.id.toLowerCase() === args.toLowerCase() ||
              item.name.toLowerCase() === args.toLowerCase(),
            );
            if (!model) throw new Error(`Model not found: ${args}`);
            if (!await pi.setModel(model)) throw new Error(`Could not select ${model.provider}/${model.id}; check provider authentication.`);
            result = `✅ Model set to ${model.provider}/${model.id}.`;
            break;
          }
          case "thinking": {
            const allowed = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
            if (!allowed.includes(args.toLowerCase())) throw new Error(`Pass one of: ${allowed.join(", " )}.`);
            (pi.setThinkingLevel as (level: string) => void)(args.toLowerCase());
            result = `✅ Thinking level set to ${args.toLowerCase()}.`;
            break;
          }
          case "name":
            if (!args) throw new Error("Pass a non-empty session name.");
            pi.setSessionName(args);
            result = `✅ Session name set to ${args}.`;
            break;
          case "session": {
            const manager = ctx.sessionManager;
            const model = ctx.model;
            result = [
              `Session: ${manager.getSessionName() ?? "(unnamed)"}`,
              `ID: ${manager.getSessionId() ?? "(none)"}`,
              `File: ${manager.getSessionFile() ?? "(not saved yet)"}`,
              `Model: ${model ? `${model.provider}/${model.id}` : "(none)"}`,
              `Thinking: ${ctx.thinkingLevel ?? pi.getThinkingLevel()}`,
            ].join("\n");
            break;
          }
          case "resume": {
            const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
            const target = sessions.find(session => session.path === args && session.id !== currentSessionId);
            if (!target) throw new Error("Selected session is unavailable or is already the current session. Run /resume again.");
            if (!client?.isReady() || remotelyPaused) throw new Error("Resume from Discord requires a connected source session.");
            resumeTarget = { id: target.id, path: target.path };
            try {
              const outcome = await ctx.switchSession(target.path);
              if (!outcome.cancelled) {
                const next = outcomeSlot[outcomeKey];
                await replyAfterReplacement(next?.ok ? `✅ Resumed ${target.name || target.id}. Continue in <#${next.channelId}>.`
                  : "❌ Resume connection failed; restoring the original session.");
                return;
              }
              await discardPreparation();
              result = "Resume cancelled; original session retained.";
            } catch (error) {
              await discardPreparation();
              await replyAfterReplacement(`❌ Resume failed: ${String(error)}. If Pi could not create a replacement runtime, resume the original session from the terminal.`);
              return;
            } finally {
              resumeTarget = undefined;
            }
            break;
          }
          case "new": {
            const outcome = await ctx.newSession({
              withSession: async (newCtx: any) => {
                newCtx.ui.notify("Started a new Pi session.", "info");
              },
            });
            if (!outcome.cancelled) {
              const next = outcomeSlot[outcomeKey];
              await replyAfterReplacement(next?.ok ? `✅ Started a new Pi session. Continue in <#${next.channelId}>.`
                : "❌ New connection failed; restoring the original session.");
              return;
            }
            await discardPreparation();
            result = "New session cancelled; original session retained.";
            break;
          }
          case "fork": {
            if (!args || !ctx.sessionManager.getEntry(args)) throw new Error("Pass a valid session entry ID to fork from.");
            const outcome = await ctx.fork(args);
            if (!outcome.cancelled) {
              const next = outcomeSlot[outcomeKey];
              await replyAfterReplacement(next?.ok ? `✅ Forked session. Continue in <#${next.channelId}>.`
                : "❌ Fork connection failed; restoring the original session.");
              return;
            }
            await discardPreparation();
            result = "Fork cancelled; original session retained.";
            break;
          }
          case "clone": {
            const leafId = ctx.sessionManager.getLeafId();
            if (!leafId) throw new Error("Cannot clone an empty session.");
            const outcome = await ctx.fork(leafId, {
              position: "at",
              withSession: async (newCtx: any) => {
                newCtx.ui.notify("Cloned the current session position.", "info");
              },
            });
            if (!outcome.cancelled) {
              const next = outcomeSlot[outcomeKey];
              await replyAfterReplacement(next?.ok ? `✅ Cloned session. Continue in <#${next.channelId}>.`
                : "❌ Clone connection failed; restoring the original session.");
              return;
            }
            await discardPreparation();
            result = "Clone cancelled; original session retained.";
            break;
          }
          case "tree": {
            if (!args || !ctx.sessionManager.getEntry(args)) throw new Error("Pass a valid session entry ID to navigate to.");
            const outcome = await ctx.navigateTree(args);
            result = outcome.cancelled ? "Navigation cancelled." : `✅ Moved to session entry ${args}.`;
            break;
          }
          case "reload":
            await ctx.reload();
            // ctx is invalid after reload; do not access it again.
            return;
          default:
            throw new Error(`No direct Pi API mapping for /${request.command}.`);
        }
      } catch (err: any) {
        result = `❌ /${request.command} failed: ${String(err?.message ?? err)}`;
      }
      const targetChannelId = pendingReplyChannelId;
      if (targetChannelId) await sendToActiveChannel(result);
      if (pendingReplyChannelId === targetChannelId) {
        pendingReplyChannelId = null;
        pendingReplyUserId = null;
      }
    },
  });

  // ── Command ───────────────────────────────────────────────────────────────

  pi.registerCommand("rc", {
    description: "Manage this session's expiring Discord connection resource",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (args: any, ctx: any) => {
      const cmd = (args ?? "").trim().split(/\s+/)[0];
      if (rcCommandRunning || transitionPending) {
        ctx.ui.notify("A remote operation is already in progress. Please wait.", "warning");
        return;
      }
      rcCommandRunning = true;
      try {
      switch (cmd) {
        // ── setup ─────────────────────────────────────────────────────────
        case "setup": {
          const existing = await loadConfig();

          const token = await ctx.ui.input("Discord Bot Token:", existing?.token ?? "");
          if (!token) return;

          const guildId = await ctx.ui.input(
            "Guild (Server) ID:",
            existing?.guildId ?? "",
          );
          if (!guildId) return;

          const categoryId = await ctx.ui.input(
            "Category ID for new channels (leave empty = server root):",
            existing?.categoryId ?? "",
          );

          const allowedRaw = await ctx.ui.input(
            "Allowed Discord user IDs (comma-separated, leave empty = allow all):",
            existing?.allowedUserIds?.join(", ") ?? "",
          );
          const allowedUserIds = allowedRaw
            ? allowedRaw.split(",").map((s: string) => s.trim()).filter(Boolean)
            : undefined;

          const toolResponsesRaw = await ctx.ui.input(
            "Tool messages (0 = hide all, 1 = calls only, 2 = calls + results):",
            String(toolMessageLevel(existing?.toolResponses)),
          );
          if (toolResponsesRaw === undefined) return;
          const level = toolResponsesRaw.trim();
          if (level !== "0" && level !== "1" && level !== "2") {
            ctx.ui.notify("Tool messages must be 0, 1, or 2. Config was not saved.", "error");
            return;
          }
          const toolResponses = Number(level) as 0 | 1 | 2;

          const cfg: Config = {
            token,
            guildId,
            ...(existing && existing.guildId === guildId ? { sessionChannels: existing.sessionChannels, channelId: existing.channelId } : {}),
            ...(categoryId ? { categoryId } : {}),
            ...(allowedUserIds ? { allowedUserIds } : {}),
            reactions: true,
            toolResponses,
          };

          await saveConfig(cfg);
          ctx.ui.notify(`Config saved → ${CONFIG_FILE}`, "success");
          break;
        }

        case "enable": {
          activeModelRegistry = ctx.modelRegistry;
          activeConfig = await loadConfig();
          if (!activeConfig) throw new Error("No config found. Run /rc setup first.");
          // Old mapping-only channels are retired, never silently rebound to a new resource.
          await connections.retireLegacyChannels([
            ...Object.values(activeConfig.sessionChannels ?? {}), ...(activeConfig.channelId ? [activeConfig.channelId] : []),
          ]);
          connection = await connections.enable(currentSessionId!);
          ctx.ui.notify(`Remote enabled. Connection: ${connection.id}. Run /rc connect to connect.`, "info");
          break;
        }
        case "connect": {
          const cfg = await loadConfig();
          if (!cfg) throw new Error("No config found. Run /rc setup first.");
          await startClient(cfg, ctx.cwd, (msg, level) => ctx.ui.notify(msg, level),
            (key, val) => ctx.ui.setStatus(key, val));
          break;
        }
        case "disconnect": {
          await disconnectRemote();
          ctx.ui.notify("Disconnected; connection and channel binding retained.", "info");
          break;
        }
        case "disable": {
          connection = await connections.get(currentSessionId!);
          await disableRemote();
          ctx.ui.notify("Disabled; connection destroyed. Its channel cannot be reused.", "info");
          break;
        }
        case "status": {
          await maintainConnection();
          connection = await connections.get(currentSessionId!);
          ctx.ui.notify(`Session: ${currentSessionId}\nConnection: ${connection?.id ?? "none"}\n` +
            `State: ${!connection ? "disabled" : client?.isReady() && !remotelyPaused ? "connected" : "enabled / disconnected"}\n` +
            `Channel: ${connection?.channelId ?? "none"}\nExpires: ${connection ? new Date(connection.expiresAt).toISOString() : "n/a"}`, "info");
          break;
        }

        default: {
          ctx.ui.notify("Unknown /rc command. Use setup, enable, connect, disconnect, disable, or status.", "error");
        }
      }
      } finally {
        rcCommandRunning = false;
      }
    },
  });
}
