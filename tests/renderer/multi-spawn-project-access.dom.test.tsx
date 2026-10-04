import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MultiSpawnDialog } from "../../src/renderer/src/components/MultiSpawnDialog";
import { writeMultiSpawnPreset } from "../../src/renderer/src/utils/multiSpawn";
import { defaultSettings, type AppSnapshot, type Project } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";

const fullAccessProjectId = "11111111-1111-4111-8111-111111111111";
const plainProjectId = "22222222-2222-4222-8222-222222222222";
const now = "2026-10-04T10:00:00.000Z";
const browserLocalStorage = window.localStorage;

function project(id: string, name: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name,
    path: `/workspace/${name.toLowerCase()}`,
    normalizedPath: `/workspace/${name.toLowerCase()}`,
    repositoryIdentity: null,
    repositoryRoot: null,
    repositoryRelativePath: "",
    groupingMode: null,
    gitRepositoryLimit: 64,
    color: "#6366f1",
    status: "ready",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function snapshot(activeProjectId: string): AppSnapshot {
  return {
    projects: [
      project(fullAccessProjectId, "Trusted", {
        preferences: { ...defaultProjectPreferences(), defaultAccessMode: "full" },
      }),
      project(plainProjectId, "Plain"),
    ],
    conversations: [],
    providers: [],
    backendProfiles: [],
    backendDefaults: [],
    runs: [],
    settings: defaultSettings,
    activeProjectId,
    activeConversationId: null,
  };
}

function renderDialog(activeProjectId: string): void {
  render(
    <MultiSpawnDialog
      open
      snapshot={snapshot(activeProjectId)}
      settings={defaultSettings}
      submitting={false}
      error={null}
      onClose={vi.fn()}
      onSubmit={vi.fn(async () => undefined)}
      onOpenProviderSetup={vi.fn()}
      onOpenBackendSetup={vi.fn()}
    />,
  );
}

function chooseProject(chat: 1 | 2, projectId: string): void {
  fireEvent.change(screen.getByLabelText(`Chat ${chat} project`), { target: { value: projectId } });
}

describe("duo access when a chat's project changes", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
        key: (index: number) => [...values.keys()][index] ?? null,
        get length() {
          return values.size;
        },
      } satisfies Storage,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, value: browserLocalStorage });
  });

  it("does not carry one project's default access into a project without one", () => {
    renderDialog(fullAccessProjectId);
    expect(screen.getByLabelText("Chat 2 access")).toHaveValue("full");
    chooseProject(2, plainProjectId);
    expect(screen.getByLabelText("Chat 2 access")).toHaveValue("supervised");
    expect(screen.getByLabelText("Chat 1 access")).toHaveValue("full");
  });

  it("uses the new project's default access instead of the global default", () => {
    renderDialog(plainProjectId);
    expect(screen.getByLabelText("Chat 1 access")).toHaveValue("supervised");
    chooseProject(1, fullAccessProjectId);
    expect(screen.getByLabelText("Chat 1 access")).toHaveValue("full");
  });

  it("keeps explicitly chosen access across project changes", () => {
    renderDialog(fullAccessProjectId);
    fireEvent.change(screen.getByLabelText("Chat 2 access"), { target: { value: "auto-edit" } });
    chooseProject(2, plainProjectId);
    expect(screen.getByLabelText("Chat 2 access")).toHaveValue("auto-edit");
    chooseProject(2, fullAccessProjectId);
    expect(screen.getByLabelText("Chat 2 access")).toHaveValue("auto-edit");
  });

  it("keeps remembered access across project changes", () => {
    const selection = providerNativeModelSelection({ providerId: "codex", modelId: "gpt-5.6-sol" });
    const side = { projectId: fullAccessProjectId, title: "Side", selection, interactionMode: "build" as const };
    writeMultiSpawnPreset(window.localStorage, {
      prompt: "",
      rememberPreset: true,
      sides: [{ ...side, accessMode: "full" }, { ...side, accessMode: "auto-edit" }],
      comparison: { enabled: false, side: { ...side, accessMode: "supervised", interactionMode: "plan" } },
    });
    renderDialog(fullAccessProjectId);
    expect(screen.getByLabelText("Chat 2 access")).toHaveValue("auto-edit");
    chooseProject(2, plainProjectId);
    expect(screen.getByLabelText("Chat 2 access")).toHaveValue("auto-edit");
  });
});
