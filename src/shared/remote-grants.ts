export const REMOTE_GRANT_LIMITS = Object.freeze({
  projects: 64,
  conversationsPerProject: 200,
} as const);

export interface RemoteConversationGrant {
  projectId: string;
  conversationIds: string[];
  includeFutureConversations: boolean;
  legacyProjectWide: boolean;
}

export function normalizeRemoteConversationGrants(
  grants: readonly RemoteConversationGrant[],
): RemoteConversationGrant[] {
  const byProject = new Map<string, RemoteConversationGrant>();
  for (const grant of grants) {
    const projectId = grant.projectId.trim();
    if (!projectId) continue;
    const existing = byProject.get(projectId);
    const conversationIds = new Set(
      existing?.conversationIds ?? [],
    );
    for (const conversationId of grant.conversationIds) {
      const trimmed = conversationId.trim();
      if (trimmed) conversationIds.add(trimmed);
    }
    byProject.set(projectId, {
      projectId,
      conversationIds: [...conversationIds]
        .sort()
        .slice(0, REMOTE_GRANT_LIMITS.conversationsPerProject),
      includeFutureConversations: Boolean(
        existing?.includeFutureConversations || grant.includeFutureConversations,
      ),
      legacyProjectWide: Boolean(
        existing?.legacyProjectWide || grant.legacyProjectWide,
      ),
    });
  }
  return [...byProject.values()]
    .sort((left, right) => left.projectId.localeCompare(right.projectId))
    .slice(0, REMOTE_GRANT_LIMITS.projects);
}

export function remoteConversationGrantsFromProjectIds(
  projectIds: readonly string[],
): RemoteConversationGrant[] {
  return normalizeRemoteConversationGrants(projectIds.map((projectId) => ({
    projectId,
    conversationIds: [],
    includeFutureConversations: false,
    legacyProjectWide: true,
  })));
}

export function remoteGrantedProjectIds(
  grants: readonly RemoteConversationGrant[],
): string[] {
  return [...new Set(grants.map(({ projectId }) => projectId))].sort();
}

export function remoteGrantAllowsConversation(
  grants: readonly RemoteConversationGrant[],
  projectId: string,
  conversationId: string,
): boolean {
  const grant = grants.find((candidate) => candidate.projectId === projectId);
  if (!grant) return false;
  return grant.includeFutureConversations
    || grant.legacyProjectWide
    || grant.conversationIds.includes(conversationId);
}

export function remoteGrantIsProjectWide(
  grants: readonly RemoteConversationGrant[],
  projectId: string,
): boolean {
  const grant = grants.find((candidate) => candidate.projectId === projectId);
  return Boolean(
    grant && (grant.includeFutureConversations || grant.legacyProjectWide),
  );
}

export function remoteGrantsNeedReview(
  grants: readonly RemoteConversationGrant[],
): boolean {
  return grants.some(({ legacyProjectWide }) => legacyProjectWide);
}

export function sameRemoteConversationGrants(
  left: readonly RemoteConversationGrant[],
  right: readonly RemoteConversationGrant[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((grant, index) => {
    const other = right[index]!;
    return grant.projectId === other.projectId
      && grant.includeFutureConversations === other.includeFutureConversations
      && grant.legacyProjectWide === other.legacyProjectWide
      && grant.conversationIds.length === other.conversationIds.length
      && grant.conversationIds.every(
        (conversationId, position) =>
          conversationId === other.conversationIds[position],
      );
  });
}
