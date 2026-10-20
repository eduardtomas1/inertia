import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { InitiativeRepositoryError } from "../../src/server/persistence/initiative-repository";
import { publicRuntimeError, RuntimeRequestError } from "../../src/server/runtime-errors";
import {
  createConversationCommandHandler,
  type ConversationCommandDependencies,
} from "../../src/server/runtime/commands/conversation-commands";
import {
  createRuntimeCommandExecutor,
  defineRuntimeCommandHandler,
  RUNTIME_COMMAND_TYPES,
} from "../../src/server/runtime/commands/command-router";
import { createInitiativeCommandHandler } from "../../src/server/runtime/commands/initiative-commands";
import { ConversationCreationService } from "../../src/server/runtime/conversation-creation-service";
import { ensureInitiativeSkillsFolder } from "../../src/server/runtime/initiative-skills-folder";
import type { AccessMode, ClientCommand, ModelSelection, ProviderInfo, ServerEvent } from "../../src/shared/contracts";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import { defaultInitiativePreferences } from "../../src/shared/initiatives";
import { providerIdForHarness, providerNativeModelSelection } from "../../src/shared/model-routing";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";

const roots: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const socket = {} as WebSocket;
const opus = providerNativeModelSelection({ providerId: "claude", modelId: "opus", alias: "opus", reasoningEffort: null });

function fixture(options: {
  validateDefault?: (selection: ModelSelection) => ModelSelection;
  providers?: ProviderInfo[];
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "inertia-initiative-tools-"));
  roots.push(root);
  const store = new RuntimeStore(join(root, "inertia.sqlite"), root, { recoverInterruptedRuns: false });
  stores.push(store);
  const project = store.createProject("Tools", root);
  const validateDefault = vi.fn(options.validateDefault ?? ((selection: ModelSelection) => selection));
  const ensureSkillsFolder = vi.fn((initiativeId: string) => { ensureInitiativeSkillsFolder(root, initiativeId); });
  const handler = createInitiativeCommandHandler({
    store,
    send: () => undefined,
    validateDefaultModel: validateDefault,
    ensureSkillsFolder,
  });
  const execute = createRuntimeCommandExecutor({
    handlers: [
      handler,
      defineRuntimeCommandHandler(
        RUNTIME_COMMAND_TYPES.filter((type) => !handler.commandTypes?.includes(type)),
        async () => "not-handled",
      ),
    ],
    send: (_socket: WebSocket, event: ServerEvent) => { events.push(event); },
    broadcastSnapshot: () => undefined,
    publicError: publicRuntimeError,
  });
  const events: ServerEvent[] = [];
  const run = async (type: ClientCommand["type"], payload: unknown): Promise<ServerEvent> => {
    events.length = 0;
    await execute(socket, clientCommandSchema.parse({ type, requestId: randomUUID(), payload }));
    return events.at(-1)!;
  };
  const creation = new ConversationCreationService({
    store,
    providers: {
      resolveModelRoute: (selection: { harnessId: string }) => ({ providerId: providerIdForHarness(selection.harnessId) }),
    } as never,
    backendProfileController: {
      validateSelection: (selection: unknown) => selection,
      validateDefault,
    } as never,
    workspaceRuns: {} as never,
    dataDirectory: root,
    broadcastSnapshot: () => undefined,
    ...(options.providers ? { providerInfo: () => options.providers! } : {}),
  });
  const create = (payload: Record<string, unknown> = {}) => creation.create({
    projectId: project.id,
    title: "New chat",
    ...payload,
  }, randomUUID());
  const initiative = (name = "Checkout") => store.initiatives.create({ id: randomUUID(), name });
  const setPreferences = (id: string, preferences: Record<string, unknown>) => {
    const current = store.initiatives.get(id)!;
    return store.initiatives.update(id, current.revision, { preferences });
  };
  const updateAccess = (conversationId: string, accessMode: AccessMode) => createConversationCommandHandler({
    store,
    backendProfileController: { isExternalSelection: () => false },
  } as unknown as ConversationCommandDependencies)(socket, {
    type: "conversation.update",
    requestId: randomUUID(),
    payload: { conversationId, accessMode },
  });
  return { root, store, project, run, create, initiative, setPreferences, updateAccess, validateDefault, ensureSkillsFolder };
}

describe("initiative tool settings", () => {
  it("merges settings changes, canonicalises the default model and publishes them in the snapshot", async () => {
    const canonical = { ...opus, alias: "Claude Opus" };
    const { store, project, run, initiative, validateDefault } = fixture({
      validateDefault: (selection) => ({ ...canonical, reasoningEffort: selection.reasoningEffort }),
    });
    const created = initiative();
    expect(created.preferences).toEqual(defaultInitiativePreferences());

    expect(await run("initiative.update", {
      id: created.id,
      expectedRevision: 1,
      preferences: { defaultModel: opus, defaultReasoningEffort: "high", accessCeiling: "auto-edit" },
    })).toMatchObject({ type: "request.ok" });
    expect(validateDefault).toHaveBeenLastCalledWith({ ...opus, reasoningEffort: "high" });
    expect(store.initiatives.get(created.id)!.preferences).toEqual({
      ...defaultInitiativePreferences(),
      defaultModel: { ...canonical, reasoningEffort: null },
      defaultReasoningEffort: "high",
      accessCeiling: "auto-edit",
    });

    // Changing only the reasoning revalidates it with the stored model.
    await run("initiative.update", { id: created.id, expectedRevision: 2, preferences: { defaultReasoningEffort: "low" } });
    expect(validateDefault).toHaveBeenLastCalledWith({ ...canonical, reasoningEffort: "low" });
    await run("initiative.update", { id: created.id, expectedRevision: 3, preferences: { browserAccess: false, defaultProjectId: project.id } });
    expect(store.initiatives.get(created.id)!.preferences).toMatchObject({
      defaultReasoningEffort: "low", accessCeiling: "auto-edit", browserAccess: false, defaultProjectId: project.id,
    });
    // Clearing the model clears its reasoning.
    await run("initiative.update", { id: created.id, expectedRevision: 4, preferences: { defaultModel: null } });
    expect(store.initiatives.get(created.id)!.preferences).toMatchObject({ defaultModel: null, defaultReasoningEffort: null });

    const snapshot = store.shellSnapshot();
    expect(snapshot.initiatives?.[0]?.preferences).toEqual(store.initiatives.get(created.id)!.preferences);
    expect(parseServerEvent({ type: "snapshot.updated", snapshot })).toBeTruthy();
  });

  it("refuses an unusable default model, an unknown project and malformed settings", async () => {
    const { store, run, initiative } = fixture({
      validateDefault: () => { throw new RuntimeRequestError("Only an enabled compatible backend can be a default."); },
    });
    const created = initiative();
    expect(await run("initiative.update", { id: created.id, expectedRevision: 1, preferences: { defaultModel: opus } }))
      .toMatchObject({ type: "request.error", message: "Only an enabled compatible backend can be a default." });
    expect(await run("initiative.update", { id: created.id, expectedRevision: 1, preferences: { defaultProjectId: randomUUID() } }))
      .toMatchObject({ type: "request.error", message: "That project is no longer available." });
    expect(store.initiatives.get(created.id)).toMatchObject({ revision: 1, preferences: defaultInitiativePreferences() });
    for (const preferences of [{}, { accessCeiling: "root" }, { claudeMaxBudgetUsd: 0 }, { skillsFolder: "yes" }, { other: true }]) {
      expect(clientCommandSchema.safeParse({
        type: "initiative.update",
        requestId: randomUUID(),
        payload: { id: created.id, expectedRevision: 1, preferences },
      }).success).toBe(false);
    }
  });

  it("creates the contained skills folder before turning it on, and keeps files when turned off", async () => {
    const { root, store, run, initiative, ensureSkillsFolder } = fixture();
    const created = initiative();
    await run("initiative.update", { id: created.id, expectedRevision: 1, preferences: { skillsFolder: true } });
    expect(ensureSkillsFolder).toHaveBeenCalledWith(created.id);
    const skills = join(root, "initiatives", created.id, "skills", ".claude", "skills");
    expect(existsSync(skills)).toBe(true);
    expect(store.initiatives.get(created.id)!.preferences.skillsFolder).toBe(true);
    await run("initiative.update", { id: created.id, expectedRevision: 2, preferences: { skillsFolder: false } });
    expect(store.initiatives.get(created.id)!.preferences.skillsFolder).toBe(false);
    expect(existsSync(skills)).toBe(true);

    ensureSkillsFolder.mockImplementationOnce(() => { throw new RuntimeRequestError("The initiative's skills folder could not be verified."); });
    expect(await run("initiative.update", { id: created.id, expectedRevision: 3, preferences: { skillsFolder: true } }))
      .toMatchObject({ type: "request.error" });
    expect(store.initiatives.get(created.id)).toMatchObject({ revision: 3, preferences: { skillsFolder: false } });
  });
});

describe("initiative access ceiling", () => {
  it("lowers every member above a new or lower ceiling in the same update, and never raises one", async () => {
    const { store, project, run, initiative } = fixture();
    const target = initiative();
    const other = initiative("Other");
    const full = store.createConversation(project.id, "Full", { accessMode: "full", initiativeId: target.id });
    const edit = store.createConversation(project.id, "Edit", { accessMode: "auto-edit", initiativeId: target.id });
    const supervised = store.createConversation(project.id, "Supervised", { accessMode: "supervised", initiativeId: target.id });
    const archived = store.createConversation(project.id, "Archived", { accessMode: "full", initiativeId: target.id });
    store.archiveConversation(archived.id, true);
    const outsider = store.createConversation(project.id, "Outsider", { accessMode: "full", initiativeId: other.id });
    const loose = store.createConversation(project.id, "Loose", { accessMode: "full" });
    const updatedAt = store.conversation(full.id).updatedAt;
    const access = () => [full, edit, supervised, archived, outsider, loose].map(({ id }) => store.conversation(id).accessMode);

    // A stale revision changes nothing, including the members.
    expect(await run("initiative.update", { id: target.id, expectedRevision: 9, preferences: { accessCeiling: "auto-edit" } }))
      .toMatchObject({ type: "request.error" });
    expect(access()).toEqual(["full", "auto-edit", "supervised", "full", "full", "full"]);

    await run("initiative.update", { id: target.id, expectedRevision: 1, preferences: { accessCeiling: "auto-edit" } });
    expect(access()).toEqual(["auto-edit", "auto-edit", "supervised", "auto-edit", "full", "full"]);
    expect(store.conversation(full.id).updatedAt).toBe(updatedAt);

    await run("initiative.update", { id: target.id, expectedRevision: 2, preferences: { accessCeiling: "supervised" } });
    expect(access()).toEqual(["supervised", "supervised", "supervised", "supervised", "full", "full"]);

    await run("initiative.update", { id: target.id, expectedRevision: 3, preferences: { accessCeiling: null } });
    expect(access()).toEqual(["supervised", "supervised", "supervised", "supervised", "full", "full"]);
  });

  it("lowers a chat to the ceiling when it joins, and leaves it alone otherwise", async () => {
    const { store, project, run, initiative, setPreferences } = fixture();
    const limited = initiative();
    setPreferences(limited.id, { accessCeiling: "auto-edit" });
    const open = initiative("Open");
    const chat = store.createConversation(project.id, "Chat", { accessMode: "full" });
    const { projectId, worktreePath, providerId } = store.conversation(chat.id);

    await run("initiative.assign", { conversationId: chat.id, initiativeId: open.id });
    expect(store.conversation(chat.id).accessMode).toBe("full");
    await run("initiative.assign", { conversationId: chat.id, initiativeId: limited.id });
    expect(store.conversation(chat.id)).toMatchObject({ accessMode: "auto-edit", initiativeId: limited.id, projectId, worktreePath, providerId });
    await run("initiative.assign", { conversationId: chat.id, initiativeId: null });
    expect(store.conversation(chat.id)).toMatchObject({ accessMode: "auto-edit", initiativeId: null });
  });

  it("refuses raising a member chat above the ceiling with a message naming the initiative", async () => {
    const { store, project, initiative, setPreferences, updateAccess } = fixture();
    const limited = initiative("Checkout");
    setPreferences(limited.id, { accessCeiling: "auto-edit" });
    const chat = store.createConversation(project.id, "Chat", { accessMode: "supervised", initiativeId: limited.id });

    // The store refuses, with a readable message naming the initiative.
    await expect(updateAccess(chat.id, "full")).rejects.toThrow(
      new InitiativeRepositoryError("“Checkout” limits chats to Auto-accept edits."),
    );
    expect(publicRuntimeError(await updateAccess(chat.id, "full").catch((error: unknown) => error)))
      .toBe("“Checkout” limits chats to Auto-accept edits.");
    await expect(updateAccess(chat.id, "auto-edit")).resolves.toBe("mutation");
    expect(store.conversation(chat.id).accessMode).toBe("auto-edit");

    // The store refuses too, for any caller that changes a chat's access.
    expect(() => store.updateConversation(chat.id, { accessMode: "full" }))
      .toThrow(new InitiativeRepositoryError("“Checkout” limits chats to Auto-accept edits."));
    // The ceiling holds for archived initiatives as well.
    setPreferences(limited.id, { accessCeiling: "auto-edit" });
    const current = store.initiatives.get(limited.id)!;
    store.initiatives.update(limited.id, current.revision, { status: "archived" });
    await expect(updateAccess(chat.id, "full")).rejects.toThrow("limits chats to Auto-accept edits");

    const loose = store.createConversation(project.id, "Loose", { accessMode: "supervised" });
    await expect(updateAccess(loose.id, "full")).resolves.toBe("mutation");
  });
});

describe("new chats in an initiative", () => {
  it("uses the initiative's default access before the project's and clamps any access to the ceiling", async () => {
    const { store, project, create, initiative, setPreferences } = fixture();
    store.updateSettings({ defaultAccessMode: "supervised" });
    store.updateProject(project.id, { preferences: { ...defaultProjectPreferences(), defaultAccessMode: "auto-edit" } });
    const target = initiative();

    expect((await create({ initiativeId: target.id })).accessMode).toBe("auto-edit");
    setPreferences(target.id, { defaultAccessMode: "full" });
    expect((await create({ initiativeId: target.id })).accessMode).toBe("full");
    expect((await create()).accessMode).toBe("auto-edit");
    expect((await create({ initiativeId: target.id, accessMode: "supervised" })).accessMode).toBe("supervised");

    setPreferences(target.id, { accessCeiling: "auto-edit" });
    expect((await create({ initiativeId: target.id })).accessMode).toBe("auto-edit");
    expect((await create({ initiativeId: target.id, accessMode: "full" })).accessMode).toBe("auto-edit");
    setPreferences(target.id, { defaultAccessMode: null, accessCeiling: "supervised" });
    store.updateProject(project.id, { preferences: defaultProjectPreferences() });
    store.updateSettings({ defaultAccessMode: "full" });
    // The Settings default is lowered too.
    expect((await create({ initiativeId: target.id })).accessMode).toBe("supervised");
    expect((await create()).accessMode).toBe("full");
  });

  it("uses the initiative's default model when the request names none, while it stays usable", async () => {
    const usable = new Set(["opus"]);
    const ready = { id: "claude", available: true, installState: "installed", authState: "authenticated", canRun: true } as ProviderInfo;
    const providers: ProviderInfo[] = [ready];
    const { store, create, initiative, setPreferences, validateDefault } = fixture({
      providers,
      validateDefault: (selection) => {
        if (!usable.has(selection.modelId)) throw new RuntimeRequestError("That model is no longer offered by the native harness.");
        return selection;
      },
    });
    store.updateSettings({ defaultProvider: "codex", defaultModel: "", defaultReasoningEffort: "" });
    const target = initiative();
    setPreferences(target.id, { defaultModel: opus, defaultReasoningEffort: "high" });

    expect((await create({ initiativeId: target.id })).modelSelection).toMatchObject({
      harnessId: opus.harnessId, modelId: "opus", reasoningEffort: "high",
    });
    expect(validateDefault).toHaveBeenLastCalledWith({ ...opus, reasoningEffort: "high" });
    // An explicit model or provider wins.
    const sonnet = providerNativeModelSelection({ providerId: "claude", modelId: "sonnet", alias: "sonnet" });
    expect((await create({ initiativeId: target.id, modelSelection: sonnet })).modelSelection.modelId).toBe("sonnet");
    expect((await create({ initiativeId: target.id, providerId: "codex" })).providerId).toBe("codex");
    // A removed model, or a provider that cannot run, falls through to Settings.
    usable.clear();
    expect((await create({ initiativeId: target.id })).modelSelection.modelId).toBe("provider-default");
    usable.add("opus");
    providers[0] = { ...ready, available: false, installState: "not-installed", authState: "unknown", canRun: false };
    expect((await create({ initiativeId: target.id })).modelSelection.modelId).toBe("provider-default");
    expect((await create()).modelSelection.modelId).toBe("provider-default");
  });

  it("resolves a request without a model from the initiative, then the project, then Settings", async () => {
    const usable = new Set(["opus", "sonnet"]);
    const offered = new Map([["opus", ["high", "low"]], ["sonnet", ["medium"]]]);
    const { store, project, create, initiative, setPreferences } = fixture({
      validateDefault: (selection) => {
        if (!usable.has(selection.modelId)) throw new RuntimeRequestError("That model is no longer offered by the native harness.");
        if (selection.reasoningEffort && !offered.get(selection.modelId)?.includes(selection.reasoningEffort)) {
          throw new RuntimeRequestError("Choose a listed reasoning level.");
        }
        return selection;
      },
    });
    store.updateSettings({ defaultProvider: "codex", defaultModel: "", defaultReasoningEffort: "" });
    const sonnet = providerNativeModelSelection({ providerId: "claude", modelId: "sonnet", alias: "sonnet", reasoningEffort: "medium" });
    store.saveModelBackendDefault(project.id, sonnet);
    const target = initiative();
    setPreferences(target.id, { defaultModel: opus, defaultReasoningEffort: "high" });
    const model = async (payload: Record<string, unknown> = {}) => {
      const { modelSelection } = await create(payload);
      return [modelSelection.modelId, modelSelection.reasoningEffort];
    };

    expect(await model({ initiativeId: target.id })).toEqual(["opus", "high"]);
    // The project layer applies to chats outside an initiative too.
    expect(await model()).toEqual(["sonnet", "medium"]);
    // A request that names only a reasoning level keeps the layered model.
    expect(await model({ initiativeId: target.id, reasoningEffort: "low" })).toEqual(["opus", "low"]);
    // A level the model does not offer leaves the layer's own level.
    expect(await model({ initiativeId: target.id, reasoningEffort: "medium" })).toEqual(["opus", "high"]);
    // An unusable initiative model falls through to the project, then Settings.
    usable.delete("opus");
    expect(await model({ initiativeId: target.id })).toEqual(["sonnet", "medium"]);
    usable.delete("sonnet");
    expect((await create({ initiativeId: target.id })).modelSelection).toMatchObject({
      harnessId: "codex-app-server",
      modelId: "provider-default",
    });
    // A request that names a model or provider never uses the layers.
    usable.add("opus");
    expect((await create({ initiativeId: target.id, providerId: "codex" })).providerId).toBe("codex");
    expect((await create({ initiativeId: target.id, model: "gpt-test" })).modelSelection.modelId).not.toBe("opus");
  });
});
