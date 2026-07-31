import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";

import type { Conversation, Project } from "@shared/contracts";
import {
  normalizeRemoteConversationGrants,
  REMOTE_GRANT_LIMITS,
  type RemoteConversationGrant,
} from "@shared/remote-grants";
import type { RemoteDeviceView, RemoteScope } from "@shared/remote-protocol";

export const REMOTE_SANITIZED_TRANSCRIPT_NOTE =
  "Automated redaction reduces accidental exposure but cannot guarantee that "
  + "arbitrary conversation text contains no sensitive information.";

export function remoteGrantFor(
  grants: readonly RemoteConversationGrant[],
  projectId: string,
): RemoteConversationGrant {
  return grants.find((grant) => grant.projectId === projectId) ?? {
    projectId,
    conversationIds: [],
    includeFutureConversations: false,
    legacyProjectWide: false,
  };
}

export function remoteGrantsAllowSomething(
  grants: readonly RemoteConversationGrant[],
): boolean {
  return grants.some((grant) =>
    grant.includeFutureConversations
    || grant.legacyProjectWide
    || grant.conversationIds.length > 0);
}

function withGrant(
  grants: readonly RemoteConversationGrant[],
  next: RemoteConversationGrant,
): RemoteConversationGrant[] {
  return normalizeRemoteConversationGrants([
    ...grants.filter(({ projectId }) => projectId !== next.projectId),
    next,
  ]);
}

export function ConversationGrantEditor({
  projects,
  conversations,
  projectIds,
  grants,
  onChange,
}: {
  projects: Project[];
  conversations: Conversation[];
  projectIds: string[];
  grants: RemoteConversationGrant[];
  onChange(grants: RemoteConversationGrant[]): void;
}): React.JSX.Element {
  const selected = useMemo(
    () => projects.filter(({ id }) => projectIds.includes(id)),
    [projectIds, projects],
  );
  if (selected.length === 0) {
    return (
      <p className="settings-card-note" role="status">
        Choose at least one project to grant remote access.
      </p>
    );
  }
  return (
    <div className="remote-grant-editor">
      {selected.map((project) => {
        const grant = remoteGrantFor(grants, project.id);
        const projectConversations = conversations.filter(
          ({ projectId }) => projectId === project.id,
        );
        const availableConversationIds = new Set(
          projectConversations.map(({ id }) => id),
        );
        const visibleConversationIds = grant.conversationIds.filter(
          (id) => availableConversationIds.has(id),
        );
        const unavailableGrantCount = grant.conversationIds.length
          - visibleConversationIds.length;
        const projectWide = grant.includeFutureConversations
          || grant.legacyProjectWide;
        return (
          <fieldset key={project.id} className="remote-project-scope">
            <legend>{project.name}</legend>
            <label className="remote-checkbox">
              <input
                type="checkbox"
                checked={projectWide}
                onChange={(event) => onChange(withGrant(grants, {
                  ...grant,
                  conversationIds: visibleConversationIds,
                  includeFutureConversations: event.target.checked,
                  legacyProjectWide: false,
                }))}
              />
              Include every conversation, including ones created later
            </label>
            {grant.legacyProjectWide && (
              <p className="settings-card-note" role="status">
                <AlertTriangle size={13} aria-hidden="true" />
                This device was paired before conversation-level access existed,
                so it can still read every conversation in this project. Turn
                off &ldquo;Include every conversation&rdquo; to narrow it.
              </p>
            )}
            {unavailableGrantCount > 0 && !projectWide && (
              <p className="settings-card-note" role="status">
                {unavailableGrantCount} conversation grant(s) no longer match
                an unarchived conversation. They will be removed when you
                update this project&apos;s selection.
              </p>
            )}
            {projectWide
              ? (
                  <p className="settings-card-note">
                    Every unarchived conversation in this project is available
                    remotely.
                  </p>
                )
              : projectConversations.length === 0
                ? (
                    <p className="settings-card-note">
                      This project has no unarchived conversations to share.
                    </p>
                  )
                : projectConversations.map((conversation) => (
                    <label key={conversation.id}>
                      <input
                        type="checkbox"
                        checked={grant.conversationIds.includes(conversation.id)}
                        disabled={
                          !grant.conversationIds.includes(conversation.id)
                          && visibleConversationIds.length
                            >= REMOTE_GRANT_LIMITS.conversationsPerProject
                        }
                        onChange={(event) => onChange(withGrant(grants, {
                          ...grant,
                          conversationIds: event.target.checked
                            ? [...new Set([
                                ...visibleConversationIds,
                                conversation.id,
                              ])]
                            : visibleConversationIds.filter(
                                (id) => id !== conversation.id,
                              ),
                        }))}
                      />
                      {conversation.title}
                    </label>
                  ))}
          </fieldset>
        );
      })}
      <p className="settings-card-note">
        <strong>Sanitized remote transcript.</strong>{" "}
        {REMOTE_SANITIZED_TRANSCRIPT_NOTE}
      </p>
    </div>
  );
}

export function DeviceAccessPreview({
  device,
  projects,
  conversations,
}: {
  device: RemoteDeviceView;
  projects: Project[];
  conversations: Conversation[];
}): React.JSX.Element {
  const rows = device.projectIds.map((projectId) => {
    const grant = remoteGrantFor(device.grants, projectId);
    const projectWide = grant.includeFutureConversations
      || grant.legacyProjectWide;
    const named = conversations.filter(
      ({ id, projectId: owner }) =>
        owner === projectId && grant.conversationIds.includes(id),
    );
    return {
      projectId,
      name: projects.find(({ id }) => id === projectId)?.name ?? projectId,
      projectWide,
      includesFuture: projectWide,
      conversationLabels: named.map(({ title }) => title),
      grantedCount: grant.conversationIds.length,
    };
  });
  return (
    <div className="remote-access-preview">
      <strong>This device can currently reach</strong>
      {rows.length === 0 && <span>Nothing. No project is granted.</span>}
      {rows.map((row) => (
        <div key={row.projectId}>
          <span>{row.name}</span>
          <small>
            {row.projectWide
              ? "Every conversation, including future ones"
              : row.grantedCount === 0
                ? "No conversations"
                : row.conversationLabels.length > 0
                  ? row.conversationLabels.join(", ")
                  : `${row.grantedCount} conversation(s) no longer visible here`}
          </small>
        </div>
      ))}
      <small>
        {describeScopes(device.scopes)}
        {" · "}
        {device.revokedAt
          ? `Revoked ${new Date(device.revokedAt).toLocaleString()}`
          : `Expires ${new Date(device.expiresAt).toLocaleString()}`}
      </small>
    </div>
  );
}

function describeScopes(scopes: RemoteScope[]): string {
  if (scopes.includes("prompt")) return "View and text prompts";
  return scopes.includes("view") ? "View only" : "No access";
}
