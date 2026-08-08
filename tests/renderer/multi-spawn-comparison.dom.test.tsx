import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MultiSpawnDialog } from "../../src/renderer/src/components/MultiSpawnDialog";
import type { MultiSpawnDraft } from "../../src/renderer/src/utils/multiSpawn";
import {
  type AppSnapshot,
  defaultSettings,
  type Project,
  type ProviderInfo,
} from "../../src/shared/contracts";

const firstProjectId = "11111111-1111-4111-8111-111111111111";
const secondProjectId = "22222222-2222-4222-8222-222222222222";
const firstConversationId = "33333333-3333-4333-8333-333333333333";
const secondConversationId = "44444444-4444-4444-8444-444444444444";
const comparisonConversationId = "77777777-7777-4777-8777-777777777777";
const firstTurnId = "55555555-5555-4555-8555-555555555555";
const secondTurnId = "66666666-6666-4666-8666-666666666666";
const now = "2026-08-08T10:00:00.000Z";

function project(id: string, name: string): Project {
  const path = `/workspace/${name.toLocaleLowerCase("en-US")}`;
  return {
    id,
    name,
    path,
    normalizedPath: path,
    repositoryIdentity: null,
    repositoryRoot: null,
    repositoryRelativePath: "",
    groupingMode: null,
    gitRepositoryLimit: 64,
    color: "#6366f1",
    status: "ready",
    createdAt: now,
    updatedAt: now,
  };
}

const provider: ProviderInfo = {
  id: "codex",
  label: "Codex",
  command: "codex",
  available: true,
  version: "1.0.0",
  executable: "/opt/bin/codex",
  installState: "installed",
  authState: "authenticated",
  canRun: true,
  statusMessage: null,
  models: [{
    id: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    description: "Test model",
    isDefault: true,
    inputModalities: ["text"],
    reasoningOptions: [{
      value: "high",
      label: "High",
      description: "Deep reasoning",
    }],
    defaultReasoningEffort: "high",
  }],
  rateLimits: [],
  metadataState: {
    models: {
      freshness: "fresh",
      provenance: "provider",
      updatedAt: now,
      lastAttemptedAt: now,
      refreshing: false,
    },
    rateLimits: {
      freshness: "unavailable",
      provenance: null,
      updatedAt: null,
      lastAttemptedAt: null,
      refreshing: false,
    },
  },
};

const settings = {
  ...defaultSettings,
  defaultProvider: "codex" as const,
  defaultModel: "gpt-5.6-sol",
  defaultReasoningEffort: "high",
};
const snapshot: AppSnapshot = {
  projects: [
    project(firstProjectId, "Inertia"),
    project(secondProjectId, "Companion"),
  ],
  conversations: [],
  providers: [provider],
  backendProfiles: [],
  backendDefaults: [],
  runs: [],
  settings,
  activeProjectId: firstProjectId,
  activeConversationId: null,
};

describe("Duo third-model comparison dialog", () => {
  beforeEach(() => window.localStorage.clear());

  it("makes the lock explicit and collects an independent judge route", async () => {
    const onSubmit = vi.fn(async (_draft: MultiSpawnDraft) => undefined);
    render(
      <MultiSpawnDialog
        open
        snapshot={snapshot}
        settings={settings}
        submitting={false}
        error={null}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        onOpenProviderSetup={vi.fn()}
        onOpenBackendSetup={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", {
      name: "Compare with a third model",
    }));
    expect(screen.getAllByText("GPT-5.6-Sol")).toHaveLength(3);
    expect(screen.getByText(/up to 5,500 characters/u)).toBeVisible();
    expect(screen.getByText(/no source session, source reasoning, source tool history/u))
      .toBeVisible();
    fireEvent.change(screen.getByLabelText("Comparison chat project"), {
      target: { value: secondProjectId },
    });
    fireEvent.change(screen.getByLabelText("Chat 2 project"), {
      target: { value: secondProjectId },
    });
    fireEvent.change(screen.getByLabelText("Comparison chat access"), {
      target: { value: "full" },
    });
    expect(screen.getByText("Judge can edit a source checkout")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Shared prompt"), {
      target: { value: "Audit the lifecycle." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Launch duo" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      comparison: {
        enabled: true,
        side: {
          projectId: secondProjectId,
          title: "Duo comparison",
          accessMode: "full",
          interactionMode: "plan",
        },
      },
    });
  });

  it("shows explicit retry and lock-release actions for a failed judge", () => {
    const onRetryComparison = vi.fn(async () => undefined);
    const onCancelComparison = vi.fn(async () => undefined);
    render(
      <MultiSpawnDialog
        open
        snapshot={snapshot}
        settings={settings}
        submitting={false}
        error="The judge turn failed."
        recoveryStatus={{
          launchId: crypto.randomUUID(),
          state: "running",
          error: null,
          sides: [
            {
              ordinal: 0,
              conversationId: firstConversationId,
              turnId: firstTurnId,
              dispatchState: "started",
            },
            {
              ordinal: 1,
              conversationId: secondConversationId,
              turnId: secondTurnId,
              dispatchState: "started",
            },
          ],
          comparison: {
            state: "failed",
            conversationId: comparisonConversationId,
            turnId: crypto.randomUUID(),
            attempt: 1,
            error: "The judge turn failed.",
          },
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn(async () => undefined)}
        onRetryComparison={onRetryComparison}
        onCancelComparison={onCancelComparison}
        onOpenProviderSetup={vi.fn()}
        onOpenBackendSetup={vi.fn()}
      />,
    );

    expect(screen.getByRole("region", {
      name: "Third-model comparison status",
    })).toHaveTextContent("explicit retry available");
    fireEvent.click(screen.getByRole("button", {
      name: "Retry judge explicitly",
    }));
    fireEvent.click(screen.getByRole("button", {
      name: "Cancel comparison and release lock",
    }));
    expect(onRetryComparison).toHaveBeenCalledTimes(1);
    expect(onCancelComparison).toHaveBeenCalledTimes(1);
  });
});
