import type { Query, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

import { ProviderCommandCatalog } from "../../src/server/provider/provider-command-catalog";
import { readClaudeAgentSdkMetadata } from "../../src/server/provider/claude-agent-sdk-metadata";
import { CLAUDE_ISOLATED_SKILL_PLUGIN_NAME } from "../../src/server/provider/claude-skill-plugin";
import {
  acpSlashCommands,
  MAX_PROVIDER_SLASH_COMMANDS,
  providerSlashCommands,
} from "../../src/server/provider/provider-slash-commands";

function command(name: string, description = `${name} command`, argumentHint = ""): SlashCommand {
  return { name, description, argumentHint };
}

describe("provider slash commands", () => {
  it("keeps commands Claude runs from a prompt and hides the ones Inertia owns or cannot host", () => {
    const projected = providerSlashCommands("claude", [
      command("advisor", "Set the advisor model", "<fable|opus|sonnet|off>"),
      command("code-review"),
      command("compact"),
      command("clear"),
      command("model"),
      command("config"),
      command("__remote-workflow"),
      command(`${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME}:fixture-skill`),
      command("anthropic-skills:pdf"),
      command("Advisor"),
      command("two words"),
    ]);
    expect(projected).toEqual([
      { name: "advisor", description: "Set the advisor model", argumentHint: "<fable|opus|sonnet|off>" },
      { name: "anthropic-skills:pdf", description: "anthropic-skills:pdf command", argumentHint: null },
      { name: "code-review", description: "code-review command", argumentHint: null },
    ]);
  });

  it("bounds the list and strips control characters from provider text", () => {
    const many = Array.from({ length: MAX_PROVIDER_SLASH_COMMANDS + 20 }, (_, index) => command(`cmd-${index}`));
    expect(providerSlashCommands("claude", many)).toHaveLength(MAX_PROVIDER_SLASH_COMMANDS);
    const [projected] = providerSlashCommands("claude", [
      command("review", `Line one\n\u0007line two${"x".repeat(400)}`, "<file>\t[focus]"),
    ]);
    expect(projected?.description.startsWith("Line one line two")).toBe(true);
    expect(projected?.description).toHaveLength(300);
    expect(projected?.argumentHint).toBe("<file> [focus]");
  });

  it("advertises nothing for providers that cannot run commands from prompt text", () => {
    for (const providerId of ["codex", "opencode", "antigravity"] as const) {
      expect(providerSlashCommands(providerId, [command("review")])).toEqual([]);
    }
  });

  it("maps ACP available commands with their input hint", () => {
    expect(acpSlashCommands("cursor", [
      { name: "review", description: "Review the diff", input: { hint: "<focus>" } },
      { name: "/summarize", description: "Summarize", input: null },
      { name: "plan", description: "Inertia owns plan mode" },
    ])).toEqual([{ name: "review", description: "Review the diff", argumentHint: "<focus>" }]);
    expect(acpSlashCommands("kimi", [{ name: "/init", description: "Write AGENTS.md" }]))
      .toEqual([{ name: "init", description: "Write AGENTS.md", argumentHint: null }]);
  });

  it("reads Claude's commands through the metadata probe without asking for models", async () => {
    const supportedModels = vi.fn(async () => []);
    const query = {
      supportedModels,
      supportedCommands: async () => [command("advisor", "Set the advisor model", "<model>"), command("clear")],
      close: vi.fn(),
    } as unknown as Query;
    await expect(readClaudeAgentSdkMetadata("/fixture/claude", {}, "/fixture", 5_000, () => query, ["commands"]))
      .resolves.toEqual({ commands: [{ name: "advisor", description: "Set the advisor model", argumentHint: "<model>" }] });
    expect(supportedModels).not.toHaveBeenCalled();
  });

  it("reports no commands field when Claude's command read fails, so it is never cached as empty", async () => {
    const query = {
      supportedModels: async () => [],
      supportedCommands: async () => { throw new Error("control request failed"); },
      close: vi.fn(),
    } as unknown as Query;
    await expect(readClaudeAgentSdkMetadata("/fixture/claude", {}, "/fixture", 5_000, () => query, ["commands"]))
      .resolves.toEqual({});
  });

  it("serves the commands an ACP provider advertised during a run, and none for others", async () => {
    let cursorExecutable = "/fixture/cursor-agent";
    const catalog = new ProviderCommandCatalog({
      installationAuthority: {} as never,
      resolvedCommand: (providerId) => providerId === "cursor" ? cursorExecutable : undefined,
      claudeExecutable: async () => { throw new Error("not used"); },
      trackAuxiliary: async (operation) => await operation(),
      rememberEnvironment: () => undefined,
      signal: new AbortController().signal,
    });
    await expect(catalog.list("cursor", "/fixture")).resolves.toEqual([]);
    const review = { name: "review", description: "Review the diff", argumentHint: null };
    catalog.learn("cursor", [review]);
    catalog.learn("codex", [review]);
    await expect(catalog.list("cursor", "/fixture")).resolves.toEqual([review]);
    await expect(catalog.list("kimi", "/fixture")).resolves.toEqual([]);
    await expect(catalog.list("codex", "/fixture")).resolves.toEqual([]);
    // A different Cursor installation forgets what the old one advertised.
    cursorExecutable = "/fixture/updated/cursor-agent";
    await expect(catalog.list("cursor", "/fixture")).resolves.toEqual([]);
  });

  it("retries Claude after a failed read instead of caching it", async () => {
    const claudeExecutable = vi.fn(async () => { throw new Error("Claude CLI is not installed."); });
    const catalog = new ProviderCommandCatalog({
      installationAuthority: {} as never,
      resolvedCommand: () => undefined,
      claudeExecutable,
      trackAuxiliary: async (operation) => await operation(),
      rememberEnvironment: () => undefined,
      signal: new AbortController().signal,
    });
    await expect(catalog.list("claude", "/fixture")).rejects.toThrow("Claude CLI is not installed.");
    await expect(catalog.list("claude", "/fixture")).rejects.toThrow("Claude CLI is not installed.");
    expect(claudeExecutable).toHaveBeenCalledTimes(2);
  });
});
