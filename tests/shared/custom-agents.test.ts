import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import {
  buildCustomAgentExport,
  compileCustomAgentInstructions,
  customAgentCallAttributionSchema,
  customAgentDraftSchema,
  customAgentExportFileName,
  customAgentExportSchema,
  customAgentHandleFromName,
  customAgentHandleFromNativeName,
  customAgentNativeName,
  duplicateCustomAgentName,
  MAX_CUSTOM_AGENT_BLOCK_CHARS,
  MAX_CUSTOM_AGENT_BLOCKS,
  MAX_CUSTOM_AGENT_COMPILED_CHARS,
  MAX_CUSTOM_AGENT_DESCRIPTION_CHARS,
  MAX_CUSTOM_AGENT_HANDLE_CHARS,
  MAX_CUSTOM_AGENT_NAME_CHARS,
  MAX_CUSTOM_AGENT_SKILLS,
  uniqueCustomAgentHandle,
  type CustomAgentDraft,
} from "../../src/shared/custom-agents";

function draft(overrides: Partial<CustomAgentDraft> = {}): CustomAgentDraft {
  return {
    name: "Reviewer",
    handle: "reviewer",
    description: "Reads the patch.",
    icon: { kind: "symbol", name: "shield" },
    accent: "teal",
    blocks: [{ id: randomUUID(), kind: "role", body: "You review patches." }],
    skills: [],
    ...overrides,
  };
}

const valid = (value: unknown) => customAgentDraftSchema.safeParse(value).success;

describe("custom agent contracts", () => {
  it("bounds names, handles, descriptions, blocks and skills", () => {
    expect(valid(draft())).toBe(true);
    expect(valid(draft({ name: "n".repeat(MAX_CUSTOM_AGENT_NAME_CHARS) }))).toBe(true);
    expect(valid(draft({ name: "n".repeat(MAX_CUSTOM_AGENT_NAME_CHARS + 1) }))).toBe(false);
    expect(valid(draft({ name: "   " }))).toBe(false);
    expect(valid(draft({ name: "Two\nlines" }))).toBe(false);
    expect(valid(draft({ handle: "a".repeat(MAX_CUSTOM_AGENT_HANDLE_CHARS) }))).toBe(true);
    expect(valid(draft({ handle: "a".repeat(MAX_CUSTOM_AGENT_HANDLE_CHARS + 1) }))).toBe(false);
    for (const handle of ["", "Upper", "-lead", "tail-", "dou--ble", "sp ace", "ñ"]) {
      expect(valid(draft({ handle }))).toBe(false);
    }
    expect(valid(draft({ description: "d".repeat(MAX_CUSTOM_AGENT_DESCRIPTION_CHARS + 1) }))).toBe(false);
    expect(valid(draft({ accent: "magenta" as never }))).toBe(false);
    expect(valid(draft({ accent: null }))).toBe(true);
    expect(valid(draft({ blocks: [{ id: randomUUID(), kind: "role", body: "  " }] }))).toBe(false);
    expect(valid(draft({ blocks: [{ id: randomUUID(), kind: "role", body: "b".repeat(MAX_CUSTOM_AGENT_BLOCK_CHARS + 1) }] }))).toBe(false);
    const id = randomUUID();
    expect(valid(draft({ blocks: [{ id, kind: "role", body: "a" }, { id, kind: "must", body: "b" }] }))).toBe(false);
    expect(valid(draft({
      blocks: Array.from({ length: MAX_CUSTOM_AGENT_BLOCKS + 1 }, () => ({ id: randomUUID(), kind: "role" as const, body: "x" })),
    }))).toBe(false);
    expect(valid(draft({ skills: Array.from({ length: MAX_CUSTOM_AGENT_SKILLS + 1 }, (_, index) => `skill-${index}`) }))).toBe(false);
    expect(valid(draft({ skills: ["same", "same"] }))).toBe(false);
    expect(valid({ ...draft(), extra: true })).toBe(false);
    expect(valid(draft({
      blocks: Array.from({ length: 4 }, () => ({ id: randomUUID(), kind: "directions" as const, body: "w".repeat(MAX_CUSTOM_AGENT_BLOCK_CHARS) })),
    }))).toBe(false);
    expect(MAX_CUSTOM_AGENT_COMPILED_CHARS).toBeLessThan(4 * MAX_CUSTOM_AGENT_BLOCK_CHARS);
  });

  it("accepts symbol icons and only small normalized PNG images", () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    expect(valid(draft({ icon: { kind: "image", data: png } }))).toBe(true);
    expect(valid(draft({ icon: { kind: "image", data: "data:image/jpeg;base64,/9j/4AAQ" } }))).toBe(false);
    expect(valid(draft({ icon: { kind: "symbol", name: "unknown" as never } }))).toBe(false);
  });

  it("compiles blocks into ordered markdown sections", () => {
    const compiled = compileCustomAgentInstructions({
      name: "Reviewer",
      description: " Reads the patch. ",
      skills: ["code-review", "security"],
      blocks: [
        { id: randomUUID(), kind: "example", body: "Q: ok?\nA: yes" },
        { id: randomUUID(), kind: "must-not", body: "* Guess\n\n2) Rewrite history" },
        { id: randomUUID(), kind: "must", body: "- Cite files\n• Be brief" },
        { id: randomUUID(), kind: "role", body: "You review patches." },
        { id: randomUUID(), kind: "directions", body: "Read first." },
        { id: randomUUID(), kind: "directions", body: "Then report." },
        { id: randomUUID(), kind: "message", body: "Checklist" },
      ],
    });
    expect(compiled).toBe([
      "# Reviewer",
      "",
      "Reads the patch.",
      "",
      "## Role",
      "",
      "You review patches.",
      "",
      "## Directions",
      "",
      "Read first.\n\nThen report.",
      "",
      "## Always",
      "",
      "- Cite files",
      "- Be brief",
      "",
      "## Never",
      "",
      "- Guess",
      "- Rewrite history",
      "",
      "## Brief",
      "",
      "Checklist",
      "",
      "## Example",
      "",
      "Q: ok?\nA: yes",
      "",
      "## Skills",
      "",
      "- code-review",
      "- security",
      "",
    ].join("\n"));
    expect(compileCustomAgentInstructions({ name: "Bare", description: "", blocks: [], skills: [] })).toBe("# Bare\n");
  });

  it("slugs handles from names and native agent names", () => {
    expect(customAgentHandleFromName("Còdi Revisor!")).toBe("codi-revisor");
    expect(customAgentHandleFromName("  --  ")).toBe("agent");
    expect(customAgentHandleFromName("x".repeat(40))).toHaveLength(MAX_CUSTOM_AGENT_HANDLE_CHARS);
    expect(customAgentHandleFromName(`${"a".repeat(31)} b`)).toBe("a".repeat(31));
    expect(customAgentNativeName("reviewer")).toBe("inertia-reviewer");
    expect(customAgentHandleFromNativeName("inertia-reviewer")).toBe("reviewer");
    expect(customAgentHandleFromNativeName("reviewer")).toBeNull();
    expect(customAgentHandleFromNativeName("inertia-Bad")).toBeNull();
    expect(customAgentHandleFromNativeName(null)).toBeNull();
  });

  it("suffixes taken handles within the length limit", () => {
    expect(uniqueCustomAgentHandle("reviewer", [])).toBe("reviewer");
    expect(uniqueCustomAgentHandle("reviewer", ["reviewer"])).toBe("reviewer-2");
    expect(uniqueCustomAgentHandle("reviewer", ["reviewer", "reviewer-2"])).toBe("reviewer-3");
    const long = `${"a".repeat(30)}-b`;
    const suffixed = uniqueCustomAgentHandle(long, [long]);
    expect(suffixed).toBe(`${"a".repeat(30)}-2`);
    expect(suffixed.length).toBeLessThanOrEqual(MAX_CUSTOM_AGENT_HANDLE_CHARS);
    expect(duplicateCustomAgentName("Reviewer")).toBe("Reviewer copy");
    expect(duplicateCustomAgentName("n".repeat(MAX_CUSTOM_AGENT_NAME_CHARS))).toHaveLength(MAX_CUSTOM_AGENT_NAME_CHARS);
  });

  it("builds a strict export envelope of drafts", () => {
    const agent = { ...draft(), id: randomUUID(), position: 0, revision: 3, createdAt: "2026-10-29T10:00:00.000Z", updatedAt: "2026-10-29T10:00:00.000Z" };
    const envelope = buildCustomAgentExport([agent], "2026-10-29T10:00:00.000Z");
    expect(envelope).toEqual({
      format: "inertia-custom-agents",
      version: 1,
      exportedAt: "2026-10-29T10:00:00.000Z",
      agents: [draft({ blocks: agent.blocks })],
    });
    expect(envelope.agents[0]).not.toHaveProperty("id");
    expect(customAgentExportSchema.safeParse(envelope).success).toBe(true);
    expect(customAgentExportSchema.safeParse({ ...envelope, agents: [] }).success).toBe(false);
    expect(customAgentExportSchema.safeParse({ ...envelope, version: 2 }).success).toBe(false);
    expect(customAgentExportFileName([agent])).toMatch(/^inertia-agent-reviewer-\d{4}-\d{2}-\d{2}\.json$/u);
    expect(customAgentExportFileName([agent, agent])).toMatch(/^inertia-agents-\d{4}-\d{2}-\d{2}\.json$/u);
  });

  it("validates call attribution", () => {
    const call = {
      agentId: randomUUID(),
      revision: 1,
      handle: "reviewer",
      name: "Reviewer",
      icon: { kind: "symbol", name: "bot" },
      accent: null,
      delivery: "in-role",
    };
    expect(customAgentCallAttributionSchema.safeParse(call).success).toBe(true);
    expect(customAgentCallAttributionSchema.safeParse({ ...call, delivery: "other" }).success).toBe(false);
    expect(customAgentCallAttributionSchema.safeParse({ ...call, extra: 1 }).success).toBe(false);
  });

  it("parses the custom agent runtime commands strictly", () => {
    const requestId = randomUUID();
    const agentId = randomUUID();
    const parse = (command: unknown) => clientCommandSchema.safeParse(command).success;
    expect(parse({ requestId, type: "custom-agent.create", payload: { agent: draft(), onHandleConflict: "rename" } })).toBe(true);
    expect(parse({ requestId, type: "custom-agent.create", payload: { agent: draft(), onHandleConflict: "merge" } })).toBe(false);
    expect(parse({ requestId, type: "custom-agent.create", payload: { agent: draft() } })).toBe(false);
    expect(parse({ requestId, type: "custom-agent.update", payload: { agentId, expectedRevision: 1, accent: null } })).toBe(true);
    expect(parse({ requestId, type: "custom-agent.update", payload: { agentId, expectedRevision: 1 } })).toBe(false);
    expect(parse({ requestId, type: "custom-agent.update", payload: { agentId, expectedRevision: 1, handle: "Bad" } })).toBe(false);
    expect(parse({ requestId, type: "custom-agent.update", payload: { agentId, expectedRevision: 1, name: "x", extra: 1 } })).toBe(false);
    expect(parse({ requestId, type: "custom-agent.duplicate", payload: { agentId, expectedRevision: 2 } })).toBe(true);
    expect(parse({ requestId, type: "custom-agent.delete", payload: { agentId, expectedRevision: 0 } })).toBe(false);
    expect(parse({ requestId, type: "custom-agent.reorder", payload: { expectedAgentIds: [agentId], agentIds: [agentId] } })).toBe(true);
    expect(parse({ requestId, type: "custom-agent.reorder", payload: { expectedAgentIds: [agentId], agentIds: [agentId, agentId] } })).toBe(false);
  });
});
