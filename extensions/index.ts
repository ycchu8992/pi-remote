/**
 * pi-discord-remote — control this Pi session from Discord
 *
 * Each /rc start connects to the saved channel or creates a fresh text channel named after the
 * current working directory + date (e.g. "kaleidoscope-may09").  On stop
 * (or session shutdown) the channel is deleted to stay within Discord's
 * per-server channel limit.
 *
 * Bot permissions required:
 *   • Read/Send Messages, Add Reactions  (existing)
 *   • Manage Channels                    (new — for create + rename)
 *
 * Commands:
 *   /rc setup       — interactive setup (token, guildId, categoryId, allowed users)
 *   /rc start       — connect or resume
 *   /rc disconnect  — pause while preserving channel
 *   /rc stop        — delete channel + disconnect
 *   /rc status      — show connection state
 *   /rc open-config — edit config.json in the editor
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

import { loadConfig, saveConfig, CONFIG_FILE, defaultConfigTemplate } from "./config.js";
import type { Config } from "./config.js";
import {
  makeChannelName,
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
  { name: "model", description: "Select a model (argument: provider/model)" },
  { name: "thinking", description: "Set thinking level (minimal/low/medium/high/xhigh/max)" },
  { name: "name", description: "Set the session display name" },
  { name: "session", description: "Show current session information" },
  { name: "new", description: "Start a new session" },
  { name: "fork", description: "Fork from a session entry ID" },
  { name: "clone", description: "Clone the current session position" },
  { name: "tree", description: "Navigate to a session entry ID" },
  { name: "reload", description: "Reload extensions and session resources" },
] as const;

// ─── Extension ────────────────────────────────────────────────────────────────

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
  }

  // ── Shared send helpers ──────────────────────────────────────────────────

  async function sendToActiveChannel(text: string): Promise<void> {
    if (!client || !pendingReplyChannelId) return;
    try {
      const channel = (await client.channels.fetch(pendingReplyChannelId)) as TextChannel | null;
      if (!channel?.isTextBased()) return;
      await (channel as TextChannel).send(text);
    } catch (err) {
      console.error("[pi-discord-remote] Failed to send message:", err);
    }
  }

  function getTargetChannelId(overrideChannelId?: string): string | null {
    const override = overrideChannelId?.trim();
    return override || runtime.activeChannelId || activeConfig?.channelId || pendingReplyChannelId || null;
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
      return await sendOnce();
    } catch (err: any) {
      if (isAbortLikeError(err)) {
        try {
          await sleep(300);
          return await sendOnce();
        } catch (retryErr: any) {
          return { ok: false, error: toError(retryErr) };
        }
      }
      return { ok: false, error: toError(err) };
    }
  }

  // ── Collect assistant output ──────────────────────────────────────────────

  // Mirror terminal prompts to the same channel as remote turns. Extension-origin
  // prompts are already present in Discord and must not be echoed back.
  pi.on("input", async (event) => {
    if (event.source !== "interactive" || !client?.isReady() || remotelyPaused || !runtime.activeChannelId) return;
    pendingReplyChannelId = runtime.activeChannelId;
    pendingReplyUserId = null;
    for (const chunk of splitMessage(`⌨️ Terminal: ${event.text}`)) await sendToActiveChannel(chunk);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("agent_start", async (_event: any) => {
    agentBusy = true;
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

    // Only send text summaries if toolResponses is enabled
    if (!activeConfig?.toolResponses) return;

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
      await sendToActiveChannel("💭 _Thinking…_");
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("tool_execution_start", async (event: any) => {
    if (!pendingReplyChannelId) return;
    // discord_ask_user_question is handled by our tool (formatted output)
    if (event.toolName === "discord_ask_user_question") return;
    await sendToActiveChannel(toolLabel(event.toolName, event.args));
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("message_end", async (event: any) => {
    if (!pendingReplyChannelId) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = event.message.content as Array<any>;

    // Provider failures can end without a text response. Surface them immediately,
    // rather than silently clearing the pending reply at agent_end.
    if (event.message.role === "assistant" && event.message.stopReason === "error") {
      const error = String(event.message.errorMessage ?? "Unknown provider error");
      if (/context.length|context.window|token.limit|too.many.tokens|maximum.*tokens|prompt.*too.long/i.test(error)) {
        await sendToActiveChannel(`❌ Context/token limit reached: ${error.slice(0, 1200)}`);
      } else {
        await sendToActiveChannel(`❌ Model error: ${error.slice(0, 1200)}`);
      }
    }

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
    agentBusy = false;

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
  });

  // ── Cleanup helper ───────────────────────────────────────────────────────

  async function deleteSessionChannel(
    setStatusFn: (key: string, val: string | undefined) => void,
  ): Promise<void> {
    if (!client || !runtime.activeChannelId) return;
    try {
      const channel = (await client.channels.fetch(runtime.activeChannelId)) as TextChannel | null;
      if (channel) await channel.delete("Pi session ended");
    } catch (err) {
      console.error("[pi-discord-remote] Failed to delete channel:", err);
    }
    runtime.activeChannelId = null;
    runtime.sessionChannelName = null;
    if (activeConfig) { activeConfig.channelId = undefined; await saveConfig(activeConfig); }
    setStatusFn("pi-discord-remote", undefined);
  }

  // ── Reconnect logic ────────────────────────────────────────────────────────

  function clearReconnectTimer(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(): void {
    clearReconnectTimer();
    reconnectAttempt++;

    if (reconnectAttempt > RECONNECT_MAX_ATTEMPTS) {
      console.error(
        `[pi-discord-remote] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached. Giving up.`,
      );
      reconnectFailed = true;
      connectNotify?.(
        `❌ Discord reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts. Run /rc start to retry.`,
        "error",
      );
      connectSetStatus?.("pi-discord-remote", "❌ Discord: reconnect failed");
      return;
    }

    // Exponential backoff with jitter: 2s, 4s, 8s, 16s, … up to 60s
    const baseDelay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempt - 1), RECONNECT_MAX_DELAY_MS);
    const jitter = Math.random() * 1_000;
    const delay = baseDelay + jitter;

    console.log(
      `[pi-discord-remote] Reconnect attempt ${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS} in ${Math.round(delay)}ms`,
    );
    connectSetStatus?.("pi-discord-remote", `🔄 Discord: reconnecting (${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS})…`);

    reconnectTimer = setTimeout(async () => {
      if (isShuttingDown) return;
      await attemptReconnect();
    }, delay);
  }

  async function attemptReconnect(): Promise<void> {
    if (!activeConfig) return;

    // Destroy the old client if it still exists
    if (client) {
      await client.destroy().catch(() => {});
      client = null;
    }

    const cfg = activeConfig;
    const notify = connectNotify ?? ((_m: string, _l: any) => {});
    const setStatus = connectSetStatus ?? ((_k: string, _v: any) => {});

    console.log("[pi-discord-remote] Reconnecting to Discord…");

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    client.on("messageCreate", buildMessageHandler());
    client.on("interactionCreate", buildInteractionHandler());
    client.on("error", (err) => {
      console.error("[pi-discord-remote] Discord client error:", err);
      setStatus("pi-discord-remote", "⚠️ Discord: error");
    });
    client.on("shardDisconnect", () => {
      if (isShuttingDown) return;
      console.error("[pi-discord-remote] Discord WebSocket disconnected during reconnect, retrying…");
      setStatus("pi-discord-remote", "🔄 Discord: reconnecting…");
      scheduleReconnect();
    });

    try {
      await client.login(cfg.token);
      // Wait for ready
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("ready timeout")), 30_000);
        client!.once("ready", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      // Successfully reconnected — restore channel reference
      reconnectAttempt = 0;
      const channelLabel = runtime.sessionChannelName ?? runtime.activeChannelId ?? "unknown";
      console.log(`[pi-discord-remote] Reconnected successfully → #${channelLabel}`);
      notify(`✅ Discord reconnected → #${channelLabel}`, "success");
      setStatus("pi-discord-remote", `🔌 Discord: #${channelLabel}`);

      // Post a notice in the channel so the user knows we're back
      if (runtime.activeChannelId) {
        try {
          const ch = (await client.channels.fetch(runtime.activeChannelId)) as TextChannel | null;
          if (ch?.isTextBased()) {
            await ch.send("🔌 _Reconnected — ready for commands._").catch(() => {});
          }
        } catch {
          // Channel may have been deleted — that's fine
        }
      }
    } catch (err: any) {
      console.error("[pi-discord-remote] Reconnect failed:", err.message);
      scheduleReconnect();
    }
  }

  function buildInteractionHandler() {
    return async (interaction: any) => {
      if (interaction.isAutocomplete?.() && interaction.commandName === "model") {
        const query = String(interaction.options.getFocused() ?? "").toLowerCase();
        const choices = (activeModelRegistry?.getAvailable?.() ?? [])
          .filter((model: any) => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query))
          .slice(0, 25)
          .map((model: any) => ({ name: `${model.name} (${model.provider}/${model.id})`.slice(0, 100), value: `${model.provider}/${model.id}` }));
        await interaction.respond(choices);
        return;
      }
      if (interaction.isAutocomplete?.() && interaction.commandName === "pi") {
        const query = String(interaction.options.getFocused() ?? "").toLowerCase();
        const choices = pi.getCommands()
          .filter(command => command.name !== "discord-remote-core" && !MAPPED_CORE_COMMANDS.some(mapped => mapped.name === command.name))
          .filter(command => command.name.toLowerCase().includes(query))
          .slice(0, 25)
          .map(command => ({ name: `/${command.name}${command.description ? ` — ${command.description}` : ""}`.slice(0, 100), value: command.name }));
        await interaction.respond(choices);
        return;
      }
      if (!interaction.isChatInputCommand?.() || !activeConfig) return;
      if (interaction.commandName === "pi") {
        if (activeConfig.allowedUserIds?.length && !activeConfig.allowedUserIds.includes(interaction.user.id)) {
          await interaction.reply({ content: "❌ You are not on the allow-list.", ephemeral: true });
          return;
        }
        if (remotelyPaused || interaction.channelId !== runtime.activeChannelId) {
          await interaction.reply({ content: "Use `/pi` in the active session channel while connected.", ephemeral: true });
          return;
        }
        const commandName = interaction.options.getString("command", true);
        const args = interaction.options.getString("args") ?? "";
        const isDynamic = !MAPPED_CORE_COMMANDS.some(command => command.name === commandName) &&
          pi.getCommands().some(command => command.name === commandName);
        if (!isDynamic) {
          await interaction.reply({ content: `Unknown or unsupported Pi command: /${commandName}. Try autocomplete.`, ephemeral: true });
          return;
        }
        if (agentBusy && commandName !== "abort") {
          await interaction.reply({ content: "⏳ Pi is processing. Only /pi abort can run right now.", ephemeral: true });
          return;
        }
        await interaction.reply({ content: `Running Pi command /${commandName}${args ? ` ${args}` : ""}…` });
        pendingReplyChannelId = interaction.channelId;
        pendingReplyUserId = interaction.user.id;
        const commandText = `/${commandName}${args ? ` ${args}` : ""}`;
        // Current Pi runtimes support extension-command dispatch through this option.
        (pi.sendUserMessage as (text: string, options?: { expandPromptTemplates?: boolean }) => void)(
          commandText,
          { expandPromptTemplates: true },
        );
        return;
      }
      if (MAPPED_CORE_COMMANDS.some(command => command.name === interaction.commandName)) {
        if (activeConfig.allowedUserIds?.length && !activeConfig.allowedUserIds.includes(interaction.user.id)) {
          await interaction.reply({ content: "❌ You are not on the allow-list.", ephemeral: true });
          return;
        }
        if (remotelyPaused || interaction.channelId !== runtime.activeChannelId) {
          await interaction.reply({ content: "Use this core command in the active session channel while connected.", ephemeral: true });
          return;
        }
        const coreCommand = interaction.commandName;
        let coreArgs = "";
        if (coreCommand === "model") coreArgs = interaction.options.getString("model", true);
        else if (coreCommand === "thinking") coreArgs = interaction.options.getString("level", true);
        else if (coreCommand === "name") coreArgs = interaction.options.getString("name", true);
        else if (coreCommand === "fork" || coreCommand === "tree") coreArgs = interaction.options.getString("entry", true);
        if (agentBusy && coreCommand !== "abort") {
          await interaction.reply({ content: "⏳ Pi is processing. Only /abort can run right now.", ephemeral: true });
          return;
        }
        await interaction.reply({ content: `Running /${coreCommand}${coreArgs ? ` ${coreArgs}` : ""}…` });
        pendingReplyChannelId = interaction.channelId;
        pendingReplyUserId = interaction.user.id;
        const payload = Buffer.from(JSON.stringify({ command: coreCommand, args: coreArgs })).toString("base64url");
        (pi.sendUserMessage as (text: string, options?: { expandPromptTemplates?: boolean }) => void)(
          `/discord-remote-core ${payload}`, { expandPromptTemplates: true },
        );
        return;
      }
      if (interaction.commandName !== "rc") return;
      if (activeConfig.allowedUserIds?.length && !activeConfig.allowedUserIds.includes(interaction.user.id)) {
        await interaction.reply({ content: "❌ You are not on the allow-list.", ephemeral: true });
        return;
      }
      const action = interaction.options.getSubcommand();
      if (action === "setup") {
        if (!interaction.guildId) { await interaction.reply({ content: "Run setup in a server.", ephemeral: true }); return; }
        activeConfig.guildId = interaction.guildId;
        await saveConfig(activeConfig);
        await interaction.reply({ content: "This server is configured. Set bot token and allow-list with `/rc setup` in the Pi terminal.", ephemeral: true });
      } else if (action === "stop") {
        await interaction.deferReply({ ephemeral: true });
        await deleteSessionChannel(() => {});
        remotelyPaused = true;
        await interaction.editReply("Session channel deleted. Run /rc start in Pi to create another.");
      } else if (action === "status") {
        await interaction.reply({ content: `Discord ${client?.isReady() ? "connected" : "disconnected"}; channel: ${runtime.activeChannelId ?? "none"}`, ephemeral: true });
      } else if (action === "disconnect") {
        remotelyPaused = true;
        pendingReplyChannelId = null;
        await interaction.reply({ content: `Paused; channel ${runtime.activeChannelId ?? "(none)"} preserved. Use /rc start to resume.`, ephemeral: true });
      } else if (action === "start") {
        if (!runtime.activeChannelId && client?.isReady()) {
          try {
            const guild = await client.guilds.fetch(activeConfig.guildId);
            const name = makeChannelName(process.cwd());
            const channel = await guild.channels.create({ name, type: ChannelType.GuildText,
              ...(activeConfig.categoryId ? { parent: activeConfig.categoryId } : {}),
              topic: `Pi session — ${process.cwd()}` });
            runtime.activeChannelId = channel.id;
            runtime.sessionChannelName = channel.name;
            activeConfig.channelId = channel.id;
            await saveConfig(activeConfig);
          } catch (err: any) {
            await interaction.reply({ content: `Could not create channel: ${err.message}`, ephemeral: true });
            return;
          }
        }
        remotelyPaused = false;
        await interaction.reply({ content: `Resumed Pi remote session in <#${runtime.activeChannelId}>.`, ephemeral: true });
      } else if (action === "prompt") {
        if (remotelyPaused) { await interaction.reply({ content: "Session is paused; use /rc start first.", ephemeral: true }); return; }
        const prompt = interaction.options.getString("text", true);
        if (agentBusy) { await interaction.reply({ content: "⏳ Agent is busy.", ephemeral: true }); return; }
        if (!runtime.activeChannelId || interaction.channelId !== runtime.activeChannelId) {
          await interaction.reply({ content: "Use this command in the active session channel.", ephemeral: true }); return;
        }
        await interaction.reply({ content: "⏳ Sent to Pi." });
        pendingReplyChannelId = interaction.channelId;
        pendingReplyUserId = interaction.user.id;
        pi.sendUserMessage(prompt);
      } else {
        await interaction.reply({ content: "Run /rc start in the Pi terminal to connect.", ephemeral: true });
      }
    };
  }

  function buildMessageHandler() {
    return async (message: Message) => {
      if (!activeConfig) return;
      if (message.author.bot) return;
      if (remotelyPaused || message.channelId !== runtime.activeChannelId) return;

      if (
        activeConfig.allowedUserIds?.length &&
        !activeConfig.allowedUserIds.includes(message.author.id)
      ) {
        await message.reply("❌ Your user ID is not on the allow-list.").catch(() => {});
        return;
      }

      // If waiting for a question answer, route this message to the resolver
      if (questionResolver && message.channelId === questionChannelId) {
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
        pi.sendUserMessage(parts);
      } catch (err: any) {
        pendingReplyChannelId = null;
        pendingReplyUserId = null;
        await message.reply(`❌ Attachment failed: ${String(err?.message ?? err)}`).catch(() => {});
      }
    };
  }

  // Keep Pi's model catalogue available for Discord slash autocomplete.
  pi.on("session_start", (_event: any, ctx: any) => {
    activeModelRegistry = ctx.modelRegistry;
  });

  // ── Session cleanup ───────────────────────────────────────────────────────

  pi.on("session_shutdown", async (event: any) => {
    // These are session replacements, not process shutdowns. Keep the Discord
    // gateway and remote channel alive while Pi swaps the active session.
    if (["new", "resume", "fork"].includes(event?.reason)) return;
    // Reject any pending question so tool execution doesn't hang
    if (questionRejecter) {
      questionRejecter(new Error("Session shut down"));
    }
    clearQuestionState();
    clearReconnectTimer();
    isShuttingDown = true;
    // Don't destroy Discord client on reload — just re-register handlers
    if (event?.reason === "reload") {
      isShuttingDown = false;
      return;
    }
    if (client) {
      await deleteSessionChannel((_k, _v) => {});
      await client.destroy().catch(() => {});
      client = null;
      activeConfig = null;
      runtime.activeChannelId = null;
      runtime.sessionChannelName = null;
    }
  });

  // Auto-connect removed — user must run /rc start explicitly.

  // ── Connect + channel-create helper ──────────────────────────────────────

  async function startClient(
    cfg: Config,
    cwd: string,
    notifyFn: (msg: string, level: "success" | "error" | "warning" | "info") => void,
    setStatusFn: (key: string, val: string | undefined) => void,
  ): Promise<void> {
    if (client) {
      notifyFn("Already connected to Discord.", "warning");
      return;
    }

    activeConfig = cfg;
    remotelyPaused = false;
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

    client.on("messageCreate", buildMessageHandler());
    client.on("interactionCreate", buildInteractionHandler());

    // ── Reconnection handling (for post-connect disconnects only) ──────
    client.on("error", (err) => {
      console.error("[pi-discord-remote] Discord client error:", err);
      setStatusFn("pi-discord-remote", "⚠️ Discord: error");
    });

    client.on("shardDisconnect", () => {
      if (isShuttingDown) return;
      console.error("[pi-discord-remote] Discord WebSocket disconnected, starting reconnect…");
      setStatusFn("pi-discord-remote", "🔄 Discord: reconnecting…");
      scheduleReconnect();
    });

    // ── Await login + ready so we can surface immediate errors ─────────
    // Register the ready listener BEFORE login to avoid a race window
    // where ready fires before the Promise is constructed.
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("ready timeout (30s)")), 30_000);
      client!.once("ready", async (c) => {
        clearTimeout(timeout);
        // Channel creation happens inside this single ready handler
        const channelName = makeChannelName(cwd);
        try {
          const guild = await c.guilds.fetch(cfg.guildId);
          const savedChannel = cfg.channelId ? await guild.channels.fetch(cfg.channelId).catch(() => null) : null;
          const newChannel = savedChannel?.isTextBased() ? savedChannel : await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            ...(cfg.categoryId ? { parent: cfg.categoryId } : {}),
            topic: `Pi session — ${cwd}`,
          });
          runtime.activeChannelId = newChannel.id;
          runtime.sessionChannelName = newChannel.name;
          cfg.channelId = newChannel.id;
          await saveConfig(cfg);
          const rest = new REST({ version: "10" }).setToken(cfg.token);
          await rest.put(Routes.applicationGuildCommands(c.user.id, cfg.guildId), { body: [
            new SlashCommandBuilder().setName("pi").setDescription("Run any available Pi slash command")
              .addStringOption(o => o.setName("command").setDescription("Pi slash command (autocomplete) ").setRequired(true).setAutocomplete(true))
              .addStringOption(o => o.setName("args").setDescription("Arguments for the selected command")),
            ...MAPPED_CORE_COMMANDS.map(({ name, description }) => {
              const command = new SlashCommandBuilder().setName(name).setDescription(description);
              if (name === "model") command.addStringOption(o => o.setName("model").setDescription("Choose a configured model").setRequired(true).setAutocomplete(true));
              if (name === "thinking") command.addStringOption(o => o.setName("level").setDescription("Thinking level").setRequired(true).addChoices(
                { name: "off", value: "off" }, { name: "minimal", value: "minimal" }, { name: "low", value: "low" },
                { name: "medium", value: "medium" }, { name: "high", value: "high" }, { name: "xhigh", value: "xhigh" }, { name: "max", value: "max" },
              ));
              if (name === "name") command.addStringOption(o => o.setName("name").setDescription("New session name").setRequired(true));
              if (name === "fork" || name === "tree") command.addStringOption(o => o.setName("entry").setDescription("Session entry ID").setRequired(true));
              return command.toJSON();
            }),
            new SlashCommandBuilder().setName("rc").setDescription("Control the Pi remote session")
              .addSubcommand(s => s.setName("setup").setDescription("Configure this server"))
              .addSubcommand(s => s.setName("start").setDescription("Connect to this Pi session"))
              .addSubcommand(s => s.setName("stop").setDescription("Delete the session channel"))
              .addSubcommand(s => s.setName("disconnect").setDescription("Disconnect but preserve the channel"))
              .addSubcommand(s => s.setName("status").setDescription("Show connection status"))
              .addSubcommand(s => s.setName("prompt").setDescription("Send a prompt to Pi").addStringOption(o => o.setName("text").setDescription("Prompt text").setRequired(true)))
              .toJSON(),
          ] });

          const label = `🔌 Discord: #${channelName}`;
          notifyFn(`Connected as ${c.user.tag} → #${channelName}`, "success");
          setStatusFn("pi-discord-remote", label);
        } catch (err) {
          // Channel creation failed — fall back to configured channelId
          console.error("[pi-discord-remote] Could not create channel:", err);
          notifyFn(
            `⚠️ Could not create channel (check Manage Channels permission). Falling back to configured channelId.`,
            "warning",
          );
          runtime.activeChannelId = cfg.channelId ?? null;
          setStatusFn("pi-discord-remote", `🔌 Discord: ${c.user.tag} (fallback)`);
        }
        resolve();
      });
    });

    try {
      setStatusFn("pi-discord-remote", "🔌 Discord: connecting…");
      await client.login(cfg.token);
      await readyPromise;
    } catch (err: any) {
      // Initial login failure — clean up and notify immediately
      console.error("[pi-discord-remote] Initial login failed:", err.message);
      await client.destroy().catch(() => {});
      client = null;
      activeConfig = null;
      connectNotify = null;
      connectSetStatus = null;
      notifyFn(`❌ Failed to connect: ${err.message}`, "error");
      setStatusFn("pi-discord-remote", undefined);
    }
  }

  // ── Intercept ask_user_question → redirect to Discord version ─────────

  // When Discord is connected, block the original ask_user_question (TUI-only)
  // and tell the LLM to use discord_ask_user_question instead.
  // When Discord is not connected, let the original tool through as fallback.
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "ask_user_question") return;
    if (!client?.isReady()) return; // Discord not ready — let TUI tool work
    return { block: true, reason: "Discord is connected — use discord_ask_user_question instead." };
  });

  // ── System prompt hint: prefer Discord version when connected ──────────

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!client?.isReady()) return;
    const activeChannelId = runtime.activeChannelId ?? activeConfig?.channelId;
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
      if (!client || !channelId) {
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

        // Format question for Discord
        const lines: string[] = [];
        lines.push(`## ${q.header}: ${q.question}`);
        lines.push("");

        if (q.multiSelect) {
          lines.push("*(Multi-select — reply with numbers/labels separated by commas)*");
          lines.push("");
        }

        for (let oi = 0; oi < q.options.length; oi++) {
          const opt = q.options[oi];
          lines.push(`${oi + 1}. **${opt.label}** — ${opt.description}`);
          if (opt.preview) {
            lines.push(`\`\`\`\n${opt.preview}\n\`\`\``);
          }
        }

        lines.push("");
        if (q.multiSelect) {
          lines.push("> Reply with numbers/labels (e.g. \"1,3\") or type \"chat\" to skip.");
        } else {
          lines.push("> Reply with the number or label, type a custom answer, or type \"chat\" to skip.");
        }

        // Send the question
        try {
          await channel.send(lines.join("\n"));
        } catch {
          return {
            content: [{ type: "text", text: "Failed to send question to Discord." }],
            details: { answers: [], cancelled: true, error: "no_ui" },
          };
        }

        // Wait for answer
        questionChannelId = channelId;
        let answerText: string;
        try {
          answerText = await new Promise<string>((resolve, reject) => {
            questionResolver = resolve;
            questionRejecter = reject;

            questionTimeout = setTimeout(() => {
              clearQuestionState();
              reject(new Error("Question timed out — no response in 5 minutes"));
            }, 300_000);

            const onAbort = () => {
              clearQuestionState();
              reject(new Error("Session shut down while waiting for question answer"));
            };
            if (signal) {
              if (signal.aborted) {
                onAbort();
                return;
              }
              questionAbortListener = onAbort;
              questionAbortSignal = signal;
              signal.addEventListener("abort", onAbort, { once: true });
            }
          });
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
          const parts = trimmed.split(/[,\s]+/).filter(Boolean);
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
  // This command is invoked internally by the Discord /pi router, not shown in its autocomplete.
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
          case "new": {
            const outcome = await ctx.newSession({
              withSession: async (newCtx: any) => {
                newCtx.ui.notify("Started a new Pi session.", "info");
              },
            });
            result = outcome.cancelled ? "New session cancelled." : "✅ Started a new Pi session.";
            break;
          }
          case "fork": {
            if (!args || !ctx.sessionManager.getEntry(args)) throw new Error("Pass a valid session entry ID to fork from.");
            const outcome = await ctx.fork(args, {
              withSession: async (newCtx: any) => {
                newCtx.ui.notify(`Forked session at ${args}.`, "info");
              },
            });
            result = outcome.cancelled ? "Fork cancelled." : `✅ Forked session at ${args}.`;
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
            result = outcome.cancelled ? "Clone cancelled." : "✅ Cloned the current session position.";
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
    description: "Control this Pi session from Discord (creates a new channel per session)",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (args: any, ctx: any) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const cmd = parts[0] || "help";

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
            "Send tool responses to Discord? (yes/no, default: no):",
            existing?.toolResponses ? "yes" : "no",
          );
          const toolResponses = toolResponsesRaw?.trim().toLowerCase() === "yes";

          const cfg: Config = {
            token,
            guildId,
            ...(categoryId ? { categoryId } : {}),
            ...(allowedUserIds ? { allowedUserIds } : {}),
            reactions: true,
            toolResponses,
          };

          await saveConfig(cfg);
          ctx.ui.notify(`Config saved → ${CONFIG_FILE}`, "success");
          break;
        }

        // ── start ─────────────────────────────────────────────────────────
        case "connect":
        case "start": {
          activeModelRegistry = ctx.modelRegistry;
          const cfg = await loadConfig();
          if (!cfg) {
            ctx.ui.notify("No config found. Run /rc setup first.", "error");
            return;
          }
          await startClient(
            cfg,
            ctx.cwd,
            (msg, level) => ctx.ui.notify(msg, level),
            (key, val) => ctx.ui.setStatus(key, val),
          );
          break;
        }

        // Disconnect while keeping the Discord channel for a later reconnect.
        case "disconnect": {
          if (!client) { ctx.ui.notify("Not connected.", "warning"); return; }
          remotelyPaused = true;
          pendingReplyChannelId = null;
          ctx.ui.setStatus("pi-discord-remote", "⏸️ Discord: paused");
          ctx.ui.notify(`Paused. Channel ${runtime.activeChannelId ?? "(none)"} was preserved; use /rc start to resume.`, "info");
          break;
        }

        // ── stop ──────────────────────────────────────────────────────────
        case "stop": {
          if (!client) {
            ctx.ui.notify("Not connected.", "warning");
            return;
          }
          isShuttingDown = true;
          clearReconnectTimer();
          reconnectAttempt = 0;
          reconnectFailed = false;
          await deleteSessionChannel((key, val) => ctx.ui.setStatus(key, val));
          await client.destroy().catch(() => {});
          client = null;
          activeConfig = null;
          runtime.activeChannelId = null;
          runtime.sessionChannelName = null;
          connectNotify = null;
          connectSetStatus = null;
          ctx.ui.notify("Disconnected from Discord. Channel deleted.", "info");
          break;
        }

        // ── status ────────────────────────────────────────────────────────
        case "status": {
          if (remotelyPaused) { ctx.ui.notify(`⏸️ Paused; channel preserved: ${runtime.activeChannelId ?? "none"}`, "info"); break; }
          if (client?.isReady()) {
            ctx.ui.notify(
              `✅ Connected as ${client.user.tag}\n` +
                `   Channel: #${runtime.sessionChannelName ?? runtime.activeChannelId ?? "(fallback)"}\n` +
                `   Channel ID: ${runtime.activeChannelId ?? "(unknown)"}\n` +
                `   Allow-list: ${activeConfig?.allowedUserIds?.join(", ") || "everyone"}`,
              "info",
            );
          } else if (client) {
            ctx.ui.notify("⏳ Connecting…", "info");
          } else if (reconnectTimer) {
            ctx.ui.notify(
              `🔄 Reconnecting (attempt ${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS})…`,
              "info",
            );
          } else if (reconnectFailed) {
            ctx.ui.notify(
              `❌ Reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts. Run /rc stop then /rc start to retry.`,
              "error",
            );
          } else {
            ctx.ui.notify("❌ Not connected. Run /rc start.", "info");
          }
          break;
        }

        // ── open-config ───────────────────────────────────────────────────
        case "open-config": {
          const raw = existsSync(CONFIG_FILE)
            ? await readFile(CONFIG_FILE, "utf-8")
            : defaultConfigTemplate();

          const edited = await ctx.ui.editor("pi-discord-remote config.json", raw);
          if (!edited) return;

          try {
            const parsed = JSON.parse(edited) as Config;
            await saveConfig(parsed);
            ctx.ui.notify("Config saved.", "success");
          } catch {
            ctx.ui.notify("Invalid JSON — config not saved.", "error");
          }
          break;
        }

        // ── help ──────────────────────────────────────────────────────────
        default: {
          ctx.ui.notify(
            [
              "/rc setup       — configure bot token, guild, category",
              "/rc start       — connect (reuse prior channel when available)",
              "/rc disconnect — disconnect but preserve channel",
              "/rc stop        — delete channel + disconnect",
              "/rc status      — show connection state",
              "/rc open-config — edit config JSON",
            ].join("\n"),
            "info",
          );
        }
      }
    },
  });
}
