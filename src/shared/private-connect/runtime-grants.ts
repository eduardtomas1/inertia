import { z } from "zod";
import { PRIVATE_CONNECT_GRANT_LIMITS } from "./grants";

export const PRIVATE_CONNECT_RUNTIME_GRANT_LIMITS =
  PRIVATE_CONNECT_GRANT_LIMITS;

export interface PrivateConnectRuntimeGrant {
  projectId: string;
  conversationIds: string[];
  includeFutureConversations: boolean;
  legacyProjectWide: boolean;
}

const runtimeEntityId = z.string().trim().min(1).max(200);
export const privateConnectRuntimeGrantSchema = z.object({
  projectId: runtimeEntityId,
  conversationIds: z.array(runtimeEntityId).max(PRIVATE_CONNECT_RUNTIME_GRANT_LIMITS.conversationsPerProject),
  includeFutureConversations: z.boolean(),
  legacyProjectWide: z.boolean(),
}).strict();

export function normalizePrivateConnectRuntimeGrants(
  grants: readonly PrivateConnectRuntimeGrant[],
): PrivateConnectRuntimeGrant[] {
  const byProject = new Map<string, PrivateConnectRuntimeGrant>();
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
        .slice(0, PRIVATE_CONNECT_RUNTIME_GRANT_LIMITS.conversationsPerProject),
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
    .slice(0, PRIVATE_CONNECT_RUNTIME_GRANT_LIMITS.projects);
}

export function privateConnectRuntimeGrantsFromProjectIds(
  projectIds: readonly string[],
): PrivateConnectRuntimeGrant[] {
  return normalizePrivateConnectRuntimeGrants(projectIds.map((projectId) => ({
    projectId,
    conversationIds: [],
    includeFutureConversations: false,
    legacyProjectWide: true,
  })));
}

export function privateConnectRuntimeGrantedProjectIds(
  grants: readonly PrivateConnectRuntimeGrant[],
): string[] {
  return [...new Set(grants.map(({ projectId }) => projectId))].sort();
}

export function privateConnectRuntimeGrantAllowsConversation(
  grants: readonly PrivateConnectRuntimeGrant[],
  projectId: string,
  conversationId: string,
): boolean {
  const grant = grants.find((candidate) => candidate.projectId === projectId);
  if (!grant) return false;
  return grant.includeFutureConversations
    || grant.legacyProjectWide
    || grant.conversationIds.includes(conversationId);
}

export function privateConnectRuntimeGrantIsProjectWide(
  grants: readonly PrivateConnectRuntimeGrant[],
  projectId: string,
): boolean {
  const grant = grants.find((candidate) => candidate.projectId === projectId);
  return Boolean(
    grant && (grant.includeFutureConversations || grant.legacyProjectWide),
  );
}

export function privateConnectRuntimeGrantsNeedReview(
  grants: readonly PrivateConnectRuntimeGrant[],
): boolean {
  return grants.some(({ legacyProjectWide }) => legacyProjectWide);
}

export function samePrivateConnectRuntimeGrants(
  left: readonly PrivateConnectRuntimeGrant[],
  right: readonly PrivateConnectRuntimeGrant[],
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
