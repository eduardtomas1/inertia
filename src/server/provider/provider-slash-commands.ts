import type { ProviderId } from "../../shared/provider";
import type { ProviderSlashCommand } from "../../shared/contracts";
import { CLAUDE_ISOLATED_SKILL_PLUGIN_NAME } from "./claude-skill-plugin";

export const MAX_PROVIDER_SLASH_COMMANDS = 128;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_ARGUMENT_HINT_LENGTH = 120;
const COMMAND_NAME = /^[A-Za-z0-9][\w.:-]{0,63}$/u;

/**
 * Providers whose agent runs a prompt that starts with `/name` as that
 * command, and that report which commands exist. Codex app-server reports
 * none; OpenCode runs commands through a separate API rather than prompt
 * text, so advertising its list would send ordinary text.
 */
export const SLASH_COMMAND_PROVIDERS: readonly ProviderId[] = ["claude", "cursor", "kimi", "grok"];

/**
 * Commands no provider may advertise in Inertia: Inertia owns these itself
 * (compaction, resume, goals, plan/build modes) or they end the session that
 * Inertia manages.
 */
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

/**
 * Provider-specific commands that only work in the provider's own terminal UI,
 * or change settings Inertia sets on every turn (model, effort, fast mode),
 * so they would appear to work and then silently revert.
 */
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
  // Inertia's /compact already drives Cursor's summarize command.
  cursor: ["summarize"],
};

export interface RawProviderSlashCommand {
  name: unknown;
  description?: unknown;
  argumentHint?: unknown;
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const printable = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("");
  return printable.replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

/** Bounded, renderer-safe projection of the commands a provider reports. */
export function providerSlashCommands(
  providerId: ProviderId,
  commands: readonly RawProviderSlashCommand[],
): ProviderSlashCommand[] {
  if (!SLASH_COMMAND_PROVIDERS.includes(providerId)) return [];
  const hidden = new Set([...HIDDEN_FOR_EVERY_PROVIDER, ...(HIDDEN_BY_PROVIDER[providerId] ?? [])]);
  const skillPluginPrefix = `${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME.toLowerCase()}:`;
  const seen = new Set<string>();
  const projected: ProviderSlashCommand[] = [];
  for (const command of commands) {
    if (projected.length >= MAX_PROVIDER_SLASH_COMMANDS) break;
    const name = typeof command?.name === "string" ? command.name.trim().replace(/^\//u, "") : "";
    const key = name.toLowerCase();
    if (
      !COMMAND_NAME.test(name)
      || hidden.has(key)
      || seen.has(key)
      // Inertia's own skill plugin is offered through the $ skills menu.
      || (providerId === "claude" && key.startsWith(skillPluginPrefix))
    ) continue;
    seen.add(key);
    const argumentHint = cleanText(command.argumentHint, MAX_ARGUMENT_HINT_LENGTH);
    projected.push({
      name,
      description: cleanText(command.description, MAX_DESCRIPTION_LENGTH),
      argumentHint: argumentHint || null,
    });
  }
  return projected.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
}

/** Maps an ACP `available_commands_update` list (already shape-validated). */
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
