import { describe, expect, it } from "vitest";

import type { AgentTurn, AgentTurnStatus, Conversation, TurnGitArtifact } from "../../src/shared/contracts";
import { buildDuoComparisonBrief } from "../../src/server/runtime/duo/duo-comparison-brief";
import type { DuoComparisonPromptStore } from "../../src/server/runtime/duo/duo-comparison";
import { duoComparisonBriefSchema } from "../../src/shared/duo-comparison-brief";

type Launch = Parameters<typeof buildDuoComparisonBrief>[1];

interface SideFixture {
  title?: string;
  providerId?: Conversation["providerId"];
  status?: AgentTurnStatus;
  artifact?: Partial<TurnGitArtifact> | null;
  deleted?: boolean;
}

function fixture(sides: readonly [SideFixture, SideFixture]): { store: DuoComparisonPromptStore; launch: Launch } {
  const store: DuoComparisonPromptStore = {
    agentTurn: (turnId: string) => ({
      id: turnId,
      conversationId: `side-${turnId.slice(-1)}`,
      status: sides[Number(turnId.slice(-1))]!.status ?? "completed",
    } as AgentTurn),
    conversation: (conversationId: string) => {
      const side = sides[Number(conversationId.slice(-1))]!;
      if (side.deleted) throw new Error("Conversation not found.");
      return { id: conversationId, title: side.title ?? "Simplify sign-up", providerId: side.providerId ?? "codex" } as Conversation;
    },
    conversationDetail: () => null,
    conversationPath: () => "/workspace",
    turnGitArtifact: (turnId: string) => {
      const artifact = sides[Number(turnId.slice(-1))]!.artifact;
      return artifact === undefined || artifact === null
        ? null
        : { files: [], status: "ready", completeness: "complete", absenceReason: null, ...artifact } as TurnGitArtifact;
    },
  };
  const launch = {
    launchId: "launch-1",
    sides: [
      { conversationId: "side-0", turnId: "turn-0" },
      { conversationId: "side-1", turnId: "turn-1" },
    ],
    comparison: { conversationId: "judge" },
  } as unknown as Launch;
  return { store, launch };
}

const files = (count: number) => Array.from({ length: count }, (_, index) => ({ path: `file-${index}.ts` })) as TurnGitArtifact["files"];

describe("Duo comparison brief", () => {
  it("records each side's title, provider, terminal status and complete file count", () => {
    const { store, launch } = fixture([
      { title: "  Simplify sign-up  ", artifact: { files: files(2) } },
      { providerId: "claude", status: "failed", artifact: { files: files(0) } },
    ]);
    expect(buildDuoComparisonBrief(store, launch)).toEqual({
      launchId: "launch-1",
      sides: [
        { conversationId: "side-0", providerId: "codex", title: "Simplify sign-up", status: "completed", filesChanged: 2 },
        { conversationId: "side-1", providerId: "claude", title: "Simplify sign-up", status: "failed", filesChanged: 0 },
      ],
    });
  });

  it("never invents a file count it could not record completely", () => {
    for (const artifact of [
      null,
      { status: "pending" as const, files: files(1) },
      { status: "partial" as const, files: files(3) },
      { completeness: "truncated" as const, files: files(3) },
      { status: "failed" as const },
      { absenceReason: "not-repository" as const },
    ]) {
      const { store, launch } = fixture([{ artifact }, { artifact: { files: files(1) } }]);
      expect(buildDuoComparisonBrief(store, launch)?.sides[0].filesChanged).toBeNull();
    }
  });

  it("keeps a deleted side as an untitled row and bounds long titles to the contract", () => {
    const { store, launch } = fixture([{ deleted: true }, { title: "x".repeat(500) }]);
    const brief = buildDuoComparisonBrief(store, launch)!;
    expect(brief.sides[0]).toEqual({ conversationId: "side-0", providerId: null, title: "", status: "completed", filesChanged: null });
    expect(brief.sides[1].title).toHaveLength(200);
    expect(duoComparisonBriefSchema.safeParse(brief).success).toBe(true);
  });

  it("omits the brief rather than flag a comparison whose sources are not terminal or not identified", () => {
    const running = fixture([{ status: "running" }, {}]);
    expect(buildDuoComparisonBrief(running.store, running.launch)).toBeUndefined();
    const { store, launch } = fixture([{}, {}]);
    const incomplete = { ...launch, sides: [launch.sides[0], { ...launch.sides[1], turnId: null }] } as unknown as Launch;
    expect(buildDuoComparisonBrief(store, incomplete)).toBeUndefined();
  });
});
