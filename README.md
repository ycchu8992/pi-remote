# pi-remote

> Control your [Pi](https://pi.dev) coding-agent session from Discord.

A **session** is a Pi agent session; a **channel** is a Discord text channel (forks may use a thread); a **connection** is a durable resource owned exclusively by one session, even while disconnected. Run `/rc enable` to allocate the resource, then `/rc connect` to bind a channel and connect. Messages in that channel become prompts in the owning session.

## Install

The npm package is not published yet. For now, install from the source repository. Requires [Pi](https://pi.dev) 0.87.1 (command dispatch and replacement-context APIs), Git, and Node.js 22.19 or newer:

```bash
git clone https://github.com/ycchu8992/pi-remote.git
cd pi-remote
npm ci
npm run build
pi install "$PWD"
```

Restart Pi to load the extension, then run `/rc setup` in Pi to configure your Discord bot. See [Bot setup](#bot-setup) for the required Discord permissions and [Usage](#usage) for commands. To update later, pull the latest source, rerun `npm ci && npm run build`, and restart Pi.

## Bot setup

1. Create a bot at [discord.com/developers/applications](https://discord.com/developers/applications)
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content**
3. Invite the bot to your server with these permissions:
   - Read Messages / View Channels
   - Send Messages
   - Add Reactions
   - **Manage Channels** ← required for auto-create/delete

## Usage

```
/rc setup       — configure token, server ID, optional category
/rc enable      — allocate this session's connection; no login or channel creation
/rc connect     — connect; reuse this connection's channel or create one
/rc disconnect  — disconnect; retain connection and channel binding
/rc disable     — destroy connection; preserve but permanently retire its channel
/rc status      — show session, resource ID, state, channel, and expiration
```

### Setup prompts

| Field | Where to find it |
|-------|-----------------|
| Bot token | Discord Developer Portal → Bot → Token |
| Guild (Server) ID | Right-click server → Copy Server ID (needs Developer Mode) |
| Category ID | Right-click a category → Copy Category ID (optional — channels go to server root otherwise) |
| Allowed user IDs | Right-click a user → Copy User ID (leave empty to allow everyone) |
| Tool messages | Choose `0` (hide tool calls and results), `1` (calls only, default), or `2` (calls and results) |

Credentials/settings are stored at `~/.pi/agent/pi-remote/config.json`. Non-secret connection resources and permanent channel tombstones are stored separately in `connections.json` in the same directory. Registry updates use a cross-process lock and atomic file replacement.

### Environment variables (alternative to config file)

For CI or headless setups, you can skip `setup` entirely and set these env vars:

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token (overrides config file) |
| `DISCORD_GUILD_ID` | Guild (server) ID |
| `DISCORD_CATEGORY_ID` | Optional category ID |

## Config reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `token` | string | — | Discord bot token |
| `guildId` | string | — | Discord guild (server) ID |
| `categoryId` | string | — | Optional category for auto-created channels |
| `allowedUserIds` | string[] | `[]` | Allow-list of Discord user IDs (empty = everyone) |
| `reactions` | boolean | `true` | React with ⏳ while processing |
| `toolResponses` | 0 / 1 / 2 | `1` | `0` hides tool calls and results; `1` shows calls only; `2` shows calls and results (results truncated to ≤400 chars). Legacy `false`/`true` behave as `1`/`2`. |

To change configuration, run `/rc setup` again or edit `~/.pi/agent/pi-remote/config.json` directly.

## How it works

The extension loads silently. Startup and the **terminal** `/resume` do not automatically connect; use `/rc connect` for a retained, unexpired resource. An expired or disabled session first needs `/rc enable`. **Discord `/resume`** instead transfers the current connection's flame to the selected saved session.

- **Ownership** — one resource per session, never transferable. One channel/thread can belong to only one resource for its entire lifetime. Destroying a resource permanently retires its channel, even for the same session. Re-enabling allocates a new resource and subsequent connect creates a new channel.
- **Disconnect vs. disable** — disconnect and `/quit` retain the resource and its binding; disable destroys the resource. Neither deletes the Discord channel or the session history. Without a gateway, offline channels cannot receive commands: reconnect from the Pi terminal.
- **New/clone** — create a new session. Disabled stays disabled; enabled/disconnected gets a new unbound resource; connected carries the “flame” to a new resource and channel. The original resource is disconnected, not destroyed. These commands never add another simultaneously connected worker. Start another terminal and explicitly enable/connect to do that.
- **Fork** — same resource/state inheritance, but uses a new thread on the selected original message when possible. Forking from a thread, or an original message which already has a thread, falls back to a new ordinary channel. With no connection, the session remains disconnected and a later connect creates an ordinary channel. The bot needs **Create Public Threads** and **Send Messages in Threads**. Ambiguous historical source-message matches are rejected, not guessed.
- **Switch failure** — Discord destination preparation runs before leaving S1. Failure there cancels the switch. Failure connecting S2 destroys its incomplete resource, removes its newly prepared destination, and schedules a command-context rollback to S1 with a notification in the original channel. If the Pi host cannot create any replacement runtime at all, or rollback itself fails, terminal recovery is required; never assume success from a created channel alone. Connected transitions require a saved original session so rollback has a valid path.
- **Discord resume** — a private, paginated picker lists other saved sessions in the current session directory (newest first). The selected session is revalidated before switching. S1 disconnects; S2 reconnects its retained resource/channel, or automatically enables and connects a new resource/channel if disabled/expired. Already-owned targets are rejected. A failed switch restores S1 without destroying S2's pre-existing resource/channel. If an existing unbound resource acquired a new binding before failure, that binding is retained for retry. The picker is bound to its user, channel, and source session and expires after ten minutes.
- **Destination names** — channels and threads use the same session label as the Discord `/resume` picker: custom session name, otherwise first user message, otherwise `Unnamed session`, followed by a short session ID. Ordinary channel names are lowercased and punctuation/whitespace normalized to hyphens; thread names preserve the display label. `/name` changes sync automatically while connected; reconnect also synchronizes offline changes. Unnamed sessions update after their first completed conversation. Retired/disconnected channels are not renamed in the background. Rename permission/rate-limit failures produce a warning rather than destroying the connection.
- **Reload** — keeps the same resource/channel and reconnects only if previously connected.
- **Expiry** — 24 hours since allocation or last meaningful use. Successful connect, accepted remote input, and sent messages refresh activity; status queries/lease heartbeats do not. Live work and bounded question waits defer destruction. A crashed worker cannot hold a resource busy forever: ownership leases expire after 60 seconds, renewed every 15 seconds. After a crash, another runtime may need to wait for that lease before connecting.
- **Offline expiry** — the deadline remains authoritative without a daemon. Startup/access sweeps expired resources; connected runtimes also check every 15 seconds and before processing events. Nothing reconnects an expired resource. There is no connection-count limit, gateway, channel cleanup command, or channel-name status marker in this version.
- **Routing** — foreign channels and unknown menu/question IDs are ignored before acknowledgement. Duplicate ownership of a resource is rejected. All participating Pi processes must run this version; legacy runtimes do not honor these leases.
- **Incoming messages** — injected as prompts; bot reacts ⏳ and forwards each completed line of the formal reply as a new Discord message, without editing older replies; the final unterminated line is sent when the assistant message ends. Only the first reply line starts with an @mention. When the model exposes thinking text, one `💭 Thinking…` notice is sent per agent run; thinking content is not forwarded. Discord replies include the referenced message's author and text as explicit context (up to 3,000 characters); if Discord cannot retrieve the reference, the agent is told that the context is unavailable. While Pi is working, new Discord messages are forwarded as steering input, like pressing Enter in the terminal: Pi delivers them after the current assistant turn and its tool calls. Pi's steering-mode setting controls how queued steering messages are grouped, not whether they become steering or follow-up. While a Discord question is waiting for an answer, channel messages remain answers instead. `toolResponses` selects hidden/calls/calls+results as before.

Discord exposes `/rc status`, `/rc disconnect`, `/rc disable`, and idempotent `/rc enable`/`connect` for already connected sessions. `/rc setup` is terminal-only. Core slash commands: `/model`, `/thinking`, `/name`, `/session`, `/new`, `/resume`, `/compact`, `/abort`, `/fork`, `/clone`, `/tree`, `/reload`, `/export`, and `/scoped-models`. Other extension/skill/TUI-only commands are not mapped.

Discord `/export` saves an HTML file in the Pi working directory with the same default filename as terminal `/export`, then uploads **that same file** to the active Discord channel. The local file remains even if the upload fails. Custom output paths and JSONL export are available from the terminal only. The export may contain private data and is visible to users with access to that channel. `/scoped-models` opens a private, paginated Discord menu of available models. Select an item to toggle it, then **Save**; **Reset to all** clears the restriction when saved. The saved scope immediately filters the Discord `/model` picker; Pi's current session's own model-cycling scope still changes only for **new Pi sessions**. The menu is tied to its initiating user and session and expires after ten minutes.

### Upgrade from mapping-only versions

Stop or disconnect **all old-version Pi runtimes** before activating this version; do not mix versions using the same bot. Existing `sessionChannels`/`channelId` settings are treated as legacy, retired channels, not imported as live connections. In each desired terminal run `/rc enable`, then `/rc connect`; this creates a fresh channel. Existing Discord history is not deleted. Build/install does not itself reload running Pi sessions.

### Sending files and artifacts

Forwarding is opt-in. Use `discord_send_file` to upload a local artifact/file (or URL/base64) to the active channel. For image-specific forwarding, the tool accepts the same path/URL/base64 inputs.
- optional `channelId` (must match this connection's active channel/thread)
- source by local `path`
- or source by `url`
- or source by `base64` (+ optional `mediaType`)

Exactly one source should be provided per call. If omitted, the tool falls back to the latest `agent_browser` image artifact path.

`/rc status` shows the active **Channel ID** for explicit targeting.

The tool returns explicit send errors (for example `unknown_channel:<id>` or timeout/HTTP errors) instead of silently forwarding images.

### `ask_user_question` → Discord

Pi's TUI-only `ask_user_question` dialog (from `@juicesharp/rpiv-ask-user-question`) is invisible over Discord remote. When Discord is connected, pi-remote:

1. **Blocks** the original `ask_user_question` via `tool_call` event interception — the TUI dialog never appears
2. **Registers** `discord_ask_user_question` — a drop-in replacement that formats questions as Discord messages and collects answers from the channel
3. **Hints** the LLM via `before_agent_start` to prefer `discord_ask_user_question` when Discord is connected

Questions and custom-answer modals have unique per-question IDs; stale/foreign components cannot answer the current question. Plain-text `stop`, `cancel`, `停下`, `停止`, `取消`, or repeated `停` cancels the whole questionnaire rather than becoming an answer. Only the initiating user may answer when the question came from a Discord prompt.

When Discord **is not** connected, the original `ask_user_question` (TUI dialog) works normally as a fallback. No need to uninstall `@juicesharp/rpiv-ask-user-question` — the two extensions coexist gracefully.

## LLM context cost and agent awareness

The figures below estimate **input context**, not memory or Discord API usage. They are **rough tok estimates**, not measured token counts: model/provider tokenizers and tool serialization differ. In the current code, the two registered model-facing tool definitions (name, description, parameters) total **1,262 ASCII characters**; when connected, `before_agent_start` also adds **392 ASCII characters** to the system prompt for a 19-digit channel ID. The estimates assume both tools remain active and no other extension changes the active tool set.

| State of this extension | Additional per-session conversation history while unused | Additional input per model prompt/turn |
|---|---|---|
| Installed/loaded, never `/rc enable` | **0 tok** of additional user/assistant conversation messages; the two tool definitions are available to the model | Approximately **300–600 tok** for the two tool definitions; **0 tok** of Discord connection hint |
| `/rc enable`, not `/rc connect` | **0 tok** of additional conversation messages from allocation; the registry entry is on disk, outside model context | Approximately **300–600 tok**, the same as loaded-but-unused; allocation alone adds no prompt text |
| `/rc connect` (for comparison) | No *per-turn accumulating* connection message while idle; the active channel ID is supplied in the request prompt | Approximately **400–750 tok**: the tools above plus roughly **90–150 tok** of connection-specific system-prompt text |
| `/rc disable` after connecting | Disabling itself adds **0 tok** of conversation messages and does not erase earlier session history | Future requests return to approximately **300–600 tok** for the still-registered tools; the connection hint stops. Earlier user messages/tool results, if any, remain in the session |

The per-prompt column is the approximate **context occupancy on each model request**, not a fresh charge to be added cumulatively to the session transcript on every turn. A model turn can make multiple provider requests, and prompt caching may change billed input without removing these definitions from the logical request. The installed tools are registered regardless of `/rc enable`, `/rc connect`, or `/rc disable`; those commands do **not** unload the extension. Exact tok deltas require comparing actual provider requests for the same model and conversation with and without this extension.

**Reply/forwarding costs are separate from the table:** forwarding the agent's output, thinking notice and tool-status messages *to Discord* does not itself add model input. A Discord prompt becomes a normal user message (as terminal input would); replying to a Discord message can prepend up to 3,000 characters of quoted context, and incoming images, attachment paths, steering prompts, question answers and tool results can add variable context if used. These are usage-dependent, not fixed costs of merely loading or enabling the extension.

What the agent additionally knows or can do:

- It sees the names, descriptions and parameter schemas for `discord_ask_user_question` and `discord_send_file`, including that they can ask questions through Discord and send a file to the active channel. These tools remain registered even when disconnected, although using them then fails or returns a no-UI result.
- **Only while connected**, it receives the active Discord channel ID and instructions to prefer the Discord question tool over the terminal-only question tool; the extension also blocks calls to the terminal-only `ask_user_question` during connection.
- When a user replies to a Discord message, the quoted author's name and text may be included in that *specific* user prompt. Non-image attachments can be represented by local file paths; these are not injected on unrelated turns.
- It does **not** automatically learn the bot token, the connection registry, all channels, or other sessions merely because the extension is loaded.

## License

MIT
