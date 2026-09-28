/**
 * Config management for pi-remote.
 * Config is persisted to ~/.pi/agent/pi-remote/config.json.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_DIR = join(homedir(), ".pi", "agent", "pi-remote");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface Config {
  token: string;
  /** Discord guild (server) ID — required for auto-channel creation */
  guildId: string;
  /** Optional category ID to put new channels under */
  categoryId?: string;
  /** Legacy channel ID; migrated only when no session mapping exists yet. */
  channelId?: string;
  /** Persistent one-to-one Pi session ID → Discord channel ID mapping. */
  sessionChannels?: Record<string, string>;
  /** Optional allow-list of Discord user IDs. Empty = allow everyone. */
  allowedUserIds?: string[];
  /** React with emoji while processing (default: true) */
  reactions?: boolean;
  /** 0 = no tool messages; 1 = calls only (default); 2 = calls and results. Booleans support older configs. */
  toolResponses?: 0 | 1 | 2 | boolean;
}

export function channelForSession(cfg: Config, sessionId: string, forkChannelId?: string): string | undefined {
  if (cfg.sessionChannels?.[sessionId]) return cfg.sessionChannels[sessionId];
  if (forkChannelId) return forkChannelId;
  // Migrate a pre-mapping installation once; never assign the last active channel to another session.
  if (!Object.keys(cfg.sessionChannels ?? {}).length) return cfg.channelId;
  return undefined;
}

export function toolMessageLevel(value: Config["toolResponses"]): 0 | 1 | 2 {
  if (value === 0) return 0;
  if (value === 2 || value === true) return 2;
  return 1; // unset, 1, or legacy false
}

export async function loadConfig(): Promise<Config | null> {
  try {
    const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf-8")) as Config;
    // Allow DISCORD_TOKEN env var to override the config token
    if (process.env.DISCORD_TOKEN) {
      cfg.token = process.env.DISCORD_TOKEN;
    }
    return cfg;
  } catch {
    // Fall back to env var only (useful for CI / headless setups)
    if (process.env.DISCORD_TOKEN && process.env.DISCORD_GUILD_ID) {
      return {
        token: process.env.DISCORD_TOKEN,
        guildId: process.env.DISCORD_GUILD_ID,
        categoryId: process.env.DISCORD_CATEGORY_ID,
        reactions: true,
        toolResponses: 1,
      };
    }
    return null;
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
}

/** Default config template shown in the editor when no config exists. */
export function defaultConfigTemplate(): string {
  return (
    JSON.stringify(
      {
        token: "",
        guildId: "",
        categoryId: "",
        allowedUserIds: [],
        reactions: true,
        // 0 = hide calls and results; 1 = calls only; 2 = calls and results
        toolResponses: 1,
      },
      null,
      2,
    ) + "\n"
  );
}
