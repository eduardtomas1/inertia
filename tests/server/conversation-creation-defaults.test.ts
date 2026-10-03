import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { ConversationCreationService } from "../../src/server/runtime/conversation-creation-service";
import type { ProviderInfo } from "../../src/shared/contracts";
import { providerIdForHarness } from "../../src/shared/model-routing";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";
import type { ProviderId } from "../../src/shared/provider";

const roots: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type ProviderState = Pick<ProviderInfo, "id" | "available" | "installState" | "authState" | "canRun">;

const ready = (id: ProviderId): ProviderState => ({ id, available: true, installState: "installed", authState: "authenticated", canRun: true });
const missing = (id: ProviderId): ProviderState => ({ id, available: false, installState: "not-installed", authState: "unknown", canRun: false });
const checking = (id: ProviderId): ProviderState => ({ id, available: false, installState: "checking", authState: "checking", canRun: false });

function fixture(providers: ProviderState[]) {
  const root = mkdtempSync(join(tmpdir(), "inertia-creation-defaults-"));
  roots.push(root);
  const store = new RuntimeStore(join(root, "inertia.sqlite"), root, { recoverInterruptedRuns: false });
  stores.push(store);
  const project = store.createProject("Defaults", root);
  const creation = new ConversationCreationService({
    store,
    providers: {
      resolveModelRoute: (selection: { harnessId: string }) => ({ providerId: providerIdForHarness(selection.harnessId) }),
    } as never,
    backendProfileController: { validateSelection: (selection: unknown) => selection } as never,
    workspaceRuns: {} as never,
    dataDirectory: root,
    broadcastSnapshot: () => undefined,
    providerInfo: () => providers as ProviderInfo[],
  });
  const create = (payload: Record<string, unknown> = {}) => creation.create({
    projectId: project.id,
    title: "New chat",
    ...payload,
  }, crypto.randomUUID());
  return { store, project, create };
}

describe("new chat default provider fallback", () => {
  it("falls back to the first ready provider and drops the stored model and reasoning", async () => {
    const { store, create } = fixture([missing("codex"), ready("claude"), ready("cursor")]);
    store.updateSettings({ defaultProvider: "codex", defaultModel: "gpt-5.1-codex", defaultReasoningEffort: "high" });
    const conversation = await create();
    expect(conversation.providerId).toBe("claude");
    expect(conversation.modelSelection).toMatchObject({ modelId: "provider-default", reasoningEffort: null });
  });

  it("keeps the stored provider, model and reasoning while that provider is ready", async () => {
    const { store, create } = fixture([ready("codex"), ready("claude")]);
    store.updateSettings({ defaultProvider: "codex", defaultModel: "gpt-5.1-codex", defaultReasoningEffort: "high" });
    const conversation = await create();
    expect(conversation.providerId).toBe("codex");
    expect(conversation.modelSelection).toMatchObject({ modelId: "gpt-5.1-codex", reasoningEffort: "high" });
  });

  it("keeps the stored provider while its state is still being checked", async () => {
    const { create } = fixture([checking("codex"), ready("claude")]);
    expect((await create()).providerId).toBe("codex");
  });

  it("never overrides an explicitly requested provider", async () => {
    const { store, create } = fixture([missing("codex"), ready("claude")]);
    store.updateSettings({ defaultProvider: "claude", defaultModel: "claude-sonnet-4-5" });
    const conversation = await create({ providerId: "codex" });
    expect(conversation.providerId).toBe("codex");
  });
});

describe("new chat default access", () => {
  it("uses the project's default access, then the global default, and keeps an explicit choice", async () => {
    const { store, project, create } = fixture([ready("codex")]);
    store.updateSettings({ defaultAccessMode: "auto-edit" });
    expect((await create()).accessMode).toBe("auto-edit");

    store.updateProject(project.id, { preferences: { ...defaultProjectPreferences(), defaultAccessMode: "full" } });
    expect((await create()).accessMode).toBe("full");
    expect((await create({ accessMode: "supervised" })).accessMode).toBe("supervised");

    store.updateProject(project.id, { preferences: { ...defaultProjectPreferences(), defaultAccessMode: null } });
    expect((await create()).accessMode).toBe("auto-edit");
  });
});
