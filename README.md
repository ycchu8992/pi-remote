# pi-remote

> Control your [Pi](https://pi.dev) coding-agent session from Discord.

`/rc start` connects the extension and creates a Discord text channel on first use. Later connections reuse the saved channel. Messages in the channel are injected into Pi as prompts. `/rc disconnect` pauses message handling but preserves the channel; `/rc stop` deletes it.

## Install

The npm package is not published yet. For now, install from the source repository. Requires [Pi](https://pi.dev), Git, and Node.js 18 or newer:

```bash
git clone https://github.com/ycchu8992/pi-discord-remote.git
cd pi-discord-remote
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
/rc setup        — configure token, server ID, optional category
/rc start        — connect or resume (reuses saved channel)
/rc disconnect   — pause while preserving channel
/rc stop         — delete channel + disconnect
/rc status       — show connection state
/rc open-config  — edit config JSON in Pi's editor
```

### Setup prompts

| Field | Where to find it |
|-------|-----------------|
| Bot token | Discord Developer Portal → Bot → Token |
| Guild (Server) ID | Right-click server → Copy Server ID (needs Developer Mode) |
| Category ID | Right-click a category → Copy Category ID (optional — channels go to server root otherwise) |
| Allowed user IDs | Right-click a user → Copy User ID (leave empty to allow everyone) |
| Tool responses | Send tool outputs (results/errors) to Discord alongside tool-call labels? (y/n, default: no) |

Config is stored at `~/.pi/agent/pi-discord-remote/config.json`.

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
| `toolResponses` | boolean | `false` | Also post tool outputs/results alongside tool-call labels (truncated to ≤400 chars) |

Edit config with `/rc open-config`.

## How it works

The extension loads silently on Pi startup — no channel is created until you explicitly run the command.

- **`/rc start`** — bot logs in, reuses its saved channel (or creates one named `<project>-<mon><dd>-<HHMM>`), and listens there only
- **Incoming message** — injected as a user prompt into the active Pi session; bot reacts ⏳ while Pi works, then posts the full response back
- **Tool calls** — each tool invocation is labeled (🔧 bash, 📄 read, ✏️ edit, etc.) with a detail line; if `toolResponses` is on, results follow as ↩️/❌ code blocks
- **`/rc disconnect`** — pause remote messages without deleting the channel; **`/rc stop`** (or Pi exit) deletes the channel and disconnects.
- Discord `/rc ...` controls this integration. Core Pi commands with public API mappings are exposed directly as Discord slash commands: `/model` (with live model autocomplete), `/thinking`, `/name`, `/session`, `/new`, `/compact`, `/abort`, `/fork`, `/clone`, `/tree`, and `/reload`. Other extension, skill, and prompt commands are not available through Discord. Commands that require TUI-only UI (for example `/settings` or `/login`) are not mapped.

### Sending files and artifacts

Forwarding is opt-in. Use `discord_send_file` to upload a local artifact/file (or URL/base64) to the active channel. For image-specific forwarding, the tool accepts the same path/URL/base64 inputs.
- optional `channelId` (recommended for deterministic targeting)
- source by local `path`
- or source by `url`
- or source by `base64` (+ optional `mediaType`)

Exactly one source should be provided per call. If omitted, the tool falls back to the latest `agent_browser` image artifact path.

`/rc status` shows the active **Channel ID** for explicit targeting.

The tool returns explicit send errors (for example `unknown_channel:<id>` or timeout/HTTP errors) instead of silently forwarding images.

### `ask_user_question` → Discord

Pi's TUI-only `ask_user_question` dialog (from `@juicesharp/rpiv-ask-user-question`) is invisible over Discord remote. When Discord is connected, pi-discord-remote:

1. **Blocks** the original `ask_user_question` via `tool_call` event interception — the TUI dialog never appears
2. **Registers** `discord_ask_user_question` — a drop-in replacement that formats questions as Discord messages and collects answers from the channel
3. **Hints** the LLM via `before_agent_start` to prefer `discord_ask_user_question` when Discord is connected

When Discord **is not** connected, the original `ask_user_question` (TUI dialog) works normally as a fallback. No need to uninstall `@juicesharp/rpiv-ask-user-question` — the two extensions coexist gracefully.

## License

MIT
