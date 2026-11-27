import type { ProviderId } from "../../shared/provider";
import {
  PROVIDER_SLASH_COMMAND_LIMITS,
  PROVIDER_SLASH_COMMAND_NAME,
  type ProviderSlashCommand,
} from "../../shared/contracts";
import { CLAUDE_ISOLATED_SKILL_PLUGIN_NAME } from "./claude-skill-plugin";

export const MAX_PROVIDER_SLASH_COMMANDS = PROVIDER_SLASH_COMMAND_LIMITS.commands;

export const SLASH_COMMAND_PROVIDERS: readonly ProviderId[] = ["claude", "cursor", "kimi", "antigravity", "grok"];

const HIDDEN_FOR_EVERY_PROVIDER: readonly string[] = [
  "build",
  "clear",
  "compact",
  "exit",
  "goal",
  "login",
  "logout",
  "plan",
  "quit",
  "resume",
];

const HIDDEN_BY_PROVIDER: Partial<Record<ProviderId, readonly string[]>> = {
  claude: [
    "add-dir",
    "agents",
    "auto-mode-setup",
    "autocompact",
    "color",
    "config",
    "doctor",
    "effort",
    "fast",
    "focus",
    "heapdump",
    "hooks",
    "ide",
    "init",
    "mcp",
    "memory",
    "model",
    "output-style",
    "permissions",
    "plugin",
    "reload-plugins",
    "reload-skills",
    "rename",
    "statusline",
    "terminal-setup",
    "theme",
    "vim",
  ],
  cursor: ["summarize"],
  antigravity: [
    "add-dir",
    "agents",
    "artifact",
    "branch",
    "changelog",
    "codesearch",
    "config",
    "context",
    "conversation",
    "copy",
    "credits",
    "cs",
    "diff",
    "effort",
    "feedback",
    "fork",
    "help",
    "hooks",
    "keybindings",
    "mcp",
    "model",
    "new",
    "open",
    "permissions",
    "plugin",
    "plugins",
    "quota",
    "record",
    "remote-control",
    "rename",
    "rewind",
    "search",
    "settings",
    "skills",
    "statusline",
    "switch",
    "tasks",
    "title",
    "undo",
    "usage",
    "voice",
  ],
};

export interface RawProviderSlashCommand {
  name: unknown;
  description?: unknown;
  argumentHint?: unknown;
}

function invisibleFormatCharacter(code: number): boolean {
  return code === 0x00ad
    || code === 0x034f
    || code === 0x061c
    || code === 0x115f
    || code === 0x1160
    || code === 0x180e
    || (code >= 0x200b && code <= 0x200f)
    || (code >= 0x202a && code <= 0x202e)
    || (code >= 0x2060 && code <= 0x2069)
    || code === 0x3164
    || code === 0xfeff
    || code === 0xffa0
    || (code >= 0xfff9 && code <= 0xfffb)
    || (code >= 0xd800 && code <= 0xdfff)
    || (code >= 0xe0000 && code <= 0xe007f);
}

function controlCharacter(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

function cleanProviderCommandText(value: unknown, maxCodePoints: number): string {
  if (typeof value !== "string") return "";
  const printable = Array.from(value.slice(0, maxCodePoints * 8), (character) => {
    const code = character.codePointAt(0) ?? 0;
    if (invisibleFormatCharacter(code)) return "";
    return controlCharacter(code) ? " " : character;
  }).join("");
  const collapsed = printable.replace(/\s+/gu, " ").trim();
  return [...collapsed].slice(0, maxCodePoints).join("").trimEnd();
}

export function providerSlashCommands(
  providerId: ProviderId,
  commands: readonly unknown[],
): ProviderSlashCommand[] {
  if (!SLASH_COMMAND_PROVIDERS.includes(providerId)) return [];
  const hidden = new Set([...HIDDEN_FOR_EVERY_PROVIDER, ...(HIDDEN_BY_PROVIDER[providerId] ?? [])]);
  const skillPluginPrefix = `${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME.toLowerCase()}:`;
  const seen = new Set<string>();
  const projected: ProviderSlashCommand[] = [];
  for (const entry of commands) {
    if (projected.length >= MAX_PROVIDER_SLASH_COMMANDS) break;
    if (entry === null || typeof entry !== "object") continue;
    const command = entry as RawProviderSlashCommand;
    const name = typeof command.name === "string" ? command.name.trim().replace(/^\//u, "") : "";
    const key = name.toLowerCase();
    if (
      !PROVIDER_SLASH_COMMAND_NAME.test(name)
      || hidden.has(key)
      || seen.has(key)
      || (providerId === "claude" && key.startsWith(skillPluginPrefix))
    ) continue;
    seen.add(key);
    const argumentHint = cleanProviderCommandText(
      command.argumentHint,
      PROVIDER_SLASH_COMMAND_LIMITS.argumentHint,
    );
    projected.push({
      name,
      description: cleanProviderCommandText(command.description, PROVIDER_SLASH_COMMAND_LIMITS.description),
      argumentHint: argumentHint || null,
    });
  }
  return projected.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
}

export function acpSlashCommands(
  providerId: ProviderId,
  availableCommands: readonly unknown[],
): ProviderSlashCommand[] {
  return providerSlashCommands(
    providerId,
    availableCommands.slice(0, MAX_PROVIDER_SLASH_COMMANDS * 2).map((value) => {
      const command = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
      const input = command.input !== null && typeof command.input === "object"
        ? command.input as Record<string, unknown>
        : undefined;
      return { name: command.name, description: command.description, argumentHint: input?.hint };
    }),
  );
}
