import { randomUUID } from "node:crypto";

import type { Conversation } from "../../shared/contracts";
import { officiallyAllowsModelSwitchWithinSession } from "../../shared/continuation-policy";
import {
  continuationIdentityForSelection,
  continuationIdentitySchema,
  knownHarnessIdSchema,
  legacyProviderIdForHarness,
  modelSelectionSchema,
  nativeBackendProfile,
  nativeModelSelection,
  resolveHarnessBackendCompatibility,
} from "../../shared/model-routing";
import { conversationFromRow } from "./codecs";
import type { PersistenceContext } from "./context";
import type { NewConversationOptions } from "./types";
import { WorkspacePathAuthority } from "../workspace-path-authority";

type ConversationPersistenceContext = Pick<
  PersistenceContext,
  | "database"
  | "requireConversation"
  | "requireProject"
  | "selectProject"
  | "state"
  | "touchProject"
>;

export class ConversationRepository {
  private readonly pathAuthority: WorkspacePathAuthority;

  constructor(private readonly context: ConversationPersistenceContext) {
    this.pathAuthority = new WorkspacePathAuthority(context.database);
  }

  create(
    projectId: string,
    title: string,
    options: NewConversationOptions = {},
  ): Conversation {
    this.context.requireProject(projectId);
    const state = this.context.state();
    const now = new Date().toISOString();
    const legacyProviderId = options.providerId ?? state.default_provider;
    const modelSelection = options.modelSelection
      ? modelSelectionSchema.parse(options.modelSelection)
      : nativeModelSelection({
        providerId: legacyProviderId,
        modelId: options.model || state.default_model || "provider-default",
        alias: options.model || state.default_model || null,
        reasoningEffort: options.reasoningEffort ?? state.default_reasoning_effort,
      });
    const providerId = legacyProviderIdForHarness(modelSelection.harnessId);
    if (!providerId) throw new Error("The selected harness is unavailable in this build.");
    if (options.providerId && options.providerId !== providerId) {
      throw new Error("The legacy provider and model selection harness do not match.");
    }
    const conversation: Conversation = {
      id: options.id ?? randomUUID(), projectId, title,
      providerId,
      modelSelection,
      continuationIdentity: null,
      model: modelSelection.modelId === "provider-default" ? "" : modelSelection.modelId,
      reasoningEffort: modelSelection.reasoningEffort ?? "",
      interactionMode: options.interactionMode ?? state.default_interaction_mode,
      accessMode: options.accessMode ?? state.default_access_mode,
      status: "idle",
      attentionKind: null,
      branch: options.branch ?? null,
      worktreePath: options.worktreePath ?? null,
      providerSessionId: null,
      archivedAt: null,
      settledAt: null,
      completedAt: null,
      lastViewedAt: now,
      pinnedAt: null,
      snoozedUntil: null,
      createdAt: now,
      updatedAt: now,
    };
    const modelSelectionJson = JSON.stringify(modelSelection);
    this.context.database.transaction(() => {
      this.context.database.prepare(`
        INSERT INTO conversations (
          id, project_id, title, provider_id, model_selection_json, continuation_identity_json,
          model, reasoning_effort, interaction_mode,
          access_mode, status, attention_kind, branch, worktree_path, provider_session_id,
          archived_at, settled_at, completed_at, last_viewed_at, pinned_at, snoozed_until,
          created_at, updated_at
        ) VALUES (
          @id, @projectId, @title, @providerId, @modelSelectionJson, NULL,
          @model, @reasoningEffort, @interactionMode,
          @accessMode, @status, @attentionKind, @branch, @worktreePath, @providerSessionId,
          @archivedAt, @settledAt, @completedAt, @lastViewedAt, @pinnedAt, @snoozedUntil,
          @createdAt, @updatedAt
        )
      `).run({ ...conversation, modelSelectionJson });
      if (conversation.worktreePath !== null) {
        this.context.database.prepare(`
          INSERT INTO conversation_worktree_ownership (
            conversation_id, path, branch, owns_worktree, creation_state
          ) VALUES (?, ?, ?, 0, 'external')
        `).run(
          conversation.id,
          conversation.worktreePath,
          conversation.branch,
        );
        this.pathAuthority.enrollConversation(
          conversation.id,
          conversation.projectId,
          conversation.worktreePath,
        );
      }
      this.context.touchProject(projectId, now);
      if (options.activate !== false) {
        this.context.database.prepare(
          "UPDATE app_state SET active_project_id = ?, active_conversation_id = ? WHERE id = 1",
        ).run(projectId, conversation.id);
      }
    })();
    return conversation;
  }

  select(conversationId: string): void {
    const conversation = this.context.requireConversation(conversationId);
    const completedTime = conversation.completed_at ? Date.parse(conversation.completed_at) : 0;
    const now = new Date(Math.max(
      Date.now(),
      Number.isFinite(completedTime) ? completedTime : 0,
    )).toISOString();
    this.context.database.transaction(() => {
      // This timestamp remains a legacy transcript-visit marker. Canonical
      // run attention is changed only by the explicit attention commands.
      this.context.database.prepare("UPDATE conversations SET last_viewed_at = ? WHERE id = ?")
        .run(now, conversationId);
      this.context.database.prepare("UPDATE app_state SET active_project_id = ?, active_conversation_id = ? WHERE id = 1")
        .run(conversation.project_id, conversationId);
    })();
  }

  hasMessages(conversationId: string): boolean {
    this.context.requireConversation(conversationId);
    return this.context.database.prepare("SELECT 1 FROM messages WHERE conversation_id = ? LIMIT 1").get(conversationId) !== undefined;
  }

  hasTurns(conversationId: string): boolean {
    this.context.requireConversation(conversationId);
    return this.context.database.prepare(
      "SELECT 1 FROM agent_turns WHERE conversation_id = ? LIMIT 1",
    ).get(conversationId) !== undefined;
  }

  update(
    conversationId: string,
    update: Partial<Pick<Conversation, "title" | "providerId" | "modelSelection" | "continuationIdentity" | "model" | "reasoningEffort" | "interactionMode" | "accessMode" | "branch" | "worktreePath" | "providerSessionId" | "status" | "attentionKind" | "pinnedAt" | "snoozedUntil">>,
  ): Conversation {
    const current = conversationFromRow(this.context.requireConversation(conversationId));
    const requestedProviderId = update.providerId ?? current.providerId;
    const legacySelectionChanged = update.providerId !== undefined
      || update.model !== undefined
      || update.reasoningEffort !== undefined;
    const modelSelection = update.modelSelection
      ? modelSelectionSchema.parse(update.modelSelection)
      : legacySelectionChanged
        ? nativeModelSelection({
          providerId: requestedProviderId,
          modelId: update.model ?? (
            update.providerId && update.providerId !== current.providerId
              ? "provider-default"
              : current.modelSelection.modelId
          ),
          alias: update.model ?? (
            update.providerId && update.providerId !== current.providerId
              ? null
              : current.modelSelection.alias
          ),
          reasoningEffort: update.reasoningEffort ?? (
            update.providerId && update.providerId !== current.providerId
              ? null
              : current.modelSelection.reasoningEffort
          ),
          providerOptions: update.providerId
            && update.providerId !== current.providerId
            ? {}
            : current.modelSelection.providerOptions,
        })
        : current.modelSelection;
    const selectedProviderId = legacyProviderIdForHarness(modelSelection.harnessId);
    if (!selectedProviderId) throw new Error("The selected harness is unavailable in this build.");
    if (update.providerId && update.providerId !== selectedProviderId) {
      throw new Error("The legacy provider and model selection harness do not match.");
    }
    const continuationBoundaryChanged = (
      modelSelection.harnessId !== current.modelSelection.harnessId
      || modelSelection.backendProfileId !== current.modelSelection.backendProfileId
      || modelSelection.backendConfigurationRevision
        !== current.modelSelection.backendConfigurationRevision
    );
    const statusChanged = update.status !== undefined && update.status !== current.status;
    const currentUpdatedTime = Date.parse(current.updatedAt);
    const eventTime = update.status === "completed" && statusChanged
      ? Math.max(Date.now(), Number.isFinite(currentUpdatedTime) ? currentUpdatedTime + 1 : 0)
      : Date.now();
    const now = new Date(eventTime).toISOString();
    const next = {
      ...current,
      ...update,
      providerId: selectedProviderId,
      modelSelection,
      providerSessionId: continuationBoundaryChanged
        ? null
        : (update.providerSessionId ?? current.providerSessionId),
      continuationIdentity: continuationBoundaryChanged
        ? null
        : update.providerSessionId === null
          ? null
          : (update.continuationIdentity ?? current.continuationIdentity),
      model: modelSelection.modelId === "provider-default" ? "" : modelSelection.modelId,
      reasoningEffort: modelSelection.reasoningEffort ?? "",
      attentionKind: update.status && update.status !== "needs-input"
        ? null
        : (update.attentionKind ?? current.attentionKind),
      settledAt: update.status === "running" ? null : current.settledAt,
      completedAt: update.status === "completed" && statusChanged ? now : current.completedAt,
      lastViewedAt: current.lastViewedAt,
      updatedAt: now,
    };
    if (next.providerSessionId && !next.continuationIdentity) {
      const native = nativeBackendProfile(selectedProviderId);
      const harnessId = knownHarnessIdSchema.safeParse(modelSelection.harnessId);
      if (!harnessId.success || native.id !== modelSelection.backendProfileId) {
        throw new Error(
          "A custom or historical provider session requires an explicit continuation identity.",
        );
      }
      const compatibility = resolveHarnessBackendCompatibility(
        harnessId.data,
        native,
      );
      next.continuationIdentity = continuationIdentityForSelection(
        modelSelection,
        native.endpointIdentity,
        !officiallyAllowsModelSwitchWithinSession(compatibility),
      );
    }
    const modelSelectionJson = JSON.stringify(modelSelection);
    const continuationIdentityJson = next.continuationIdentity
      ? JSON.stringify(continuationIdentitySchema.parse(next.continuationIdentity))
      : null;
    this.context.database.prepare(`
      UPDATE conversations SET
        title = @title, provider_id = @providerId,
        model_selection_json = @modelSelectionJson,
        continuation_identity_json = @continuationIdentityJson,
        model = @model,
        reasoning_effort = @reasoningEffort, interaction_mode = @interactionMode,
        access_mode = @accessMode, branch = @branch, worktree_path = @worktreePath,
        provider_session_id = @providerSessionId, status = @status,
        attention_kind = @attentionKind, settled_at = @settledAt,
        completed_at = @completedAt, last_viewed_at = @lastViewedAt,
        pinned_at = @pinnedAt, snoozed_until = @snoozedUntil,
        updated_at = @updatedAt
      WHERE id = @id
    `).run({ ...next, modelSelectionJson, continuationIdentityJson });
    this.context.touchProject(current.projectId, next.updatedAt);
    return next;
  }

  settle(conversationId: string, settled: boolean): Conversation {
    const current = conversationFromRow(this.context.requireConversation(conversationId));
    if (settled && (current.status === "running" || current.status === "needs-input")) {
      throw new Error("Active threads cannot be settled while the agent is working or waiting for you.");
    }
    const now = new Date().toISOString();
    const settledAt = settled ? now : null;
    this.context.database.prepare("UPDATE conversations SET settled_at = ?, last_viewed_at = CASE WHEN ? THEN ? ELSE last_viewed_at END, updated_at = ? WHERE id = ?")
      .run(settledAt, Number(settled), now, now, conversationId);
    this.context.touchProject(current.projectId, now);
    return { ...current, settledAt, lastViewedAt: settled ? now : current.lastViewedAt, updatedAt: now };
  }

  archive(conversationId: string, archived: boolean): void {
    const conversation = this.context.requireConversation(conversationId);
    const archivedAt = archived ? new Date().toISOString() : null;
    this.context.database.prepare("UPDATE conversations SET archived_at = ?, updated_at = ? WHERE id = ?").run(archivedAt, new Date().toISOString(), conversationId);
    const state = this.context.state();
    if (archived && state.active_conversation_id === conversationId) {
      this.context.selectProject(conversation.project_id);
    }
  }

  delete(conversationId: string): void {
    const conversation = this.context.requireConversation(conversationId);
    this.context.database.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
    if (this.context.state().active_conversation_id === null) {
      this.context.selectProject(conversation.project_id);
    }
  }

  get(conversationId: string): Conversation {
    return conversationFromRow(this.context.requireConversation(conversationId));
  }

  path(conversationId: string): string {
    const conversation = this.context.requireConversation(conversationId);
    return this.pathAuthority.resolveConversation(
      conversation,
      this.context.requireProject(conversation.project_id),
    );
  }
}
