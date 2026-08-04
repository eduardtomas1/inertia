import { z } from "zod";

export const PRIVATE_CONNECT_GRANT_LIMITS = Object.freeze({
  projects: 64,
  conversationsPerProject: 256,
});

const entityId = z.string().trim().min(1).max(200);

export const privateConnectConversationGrantSchema = z.object({
  projectId: entityId,
  conversationIds: z.array(entityId).max(
    PRIVATE_CONNECT_GRANT_LIMITS.conversationsPerProject,
  ),
  includeFutureConversations: z.boolean(),
}).strict();
export type PrivateConnectConversationGrant = z.infer<
  typeof privateConnectConversationGrantSchema
>;

export const privateConnectConversationGrantsSchema = z.array(
  privateConnectConversationGrantSchema,
).max(PRIVATE_CONNECT_GRANT_LIMITS.projects);

export function normalizePrivateConnectGrants(
  grants: readonly PrivateConnectConversationGrant[],
): PrivateConnectConversationGrant[] {
  const byProject = new Map<string, PrivateConnectConversationGrant>();
  for (const grant of grants) {
    const projectId = grant.projectId.trim();
    if (!projectId) continue;
    const existing = byProject.get(projectId);
    byProject.set(projectId, {
      projectId,
      conversationIds: [...new Set([
        ...(existing?.conversationIds ?? []),
        ...grant.conversationIds.map((id) => id.trim()),
      ])]
        .filter(Boolean)
        .slice(0, PRIVATE_CONNECT_GRANT_LIMITS.conversationsPerProject),
      includeFutureConversations: Boolean(
        existing?.includeFutureConversations || grant.includeFutureConversations,
      ),
    });
  }
  return [...byProject.values()].slice(0, PRIVATE_CONNECT_GRANT_LIMITS.projects);
}

export function privateConnectGrantsFromProjectIds(
  projectIds: readonly string[],
): PrivateConnectConversationGrant[] {
  return normalizePrivateConnectGrants(
    [...new Set(projectIds)].map((projectId) => ({
      projectId,
      conversationIds: [],
      includeFutureConversations: true,
    })),
  );
}

export function privateConnectGrantedProjectIds(
  grants: readonly PrivateConnectConversationGrant[],
): string[] {
  return normalizePrivateConnectGrants(grants).map(({ projectId }) => projectId);
}

export function privateConnectGrantAllowsConversation(
  grants: readonly PrivateConnectConversationGrant[],
  projectId: string,
  conversationId: string,
): boolean {
  const grant = grants.find((candidate) => candidate.projectId === projectId);
  return Boolean(
    grant
    && (grant.includeFutureConversations || grant.conversationIds.includes(conversationId)),
  );
}
