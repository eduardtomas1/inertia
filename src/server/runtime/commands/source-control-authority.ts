export function repositoryAuthorityBinding(
  projectId: string,
  conversationId: string | undefined,
  workspaceRoot: string,
  repositoryPath: string,
  metadataMarkerIdentity: string,
): readonly string[] {
  return [
    projectId,
    conversationId ?? "",
    workspaceRoot,
    repositoryPath,
    metadataMarkerIdentity,
  ];
}

export function commitReviewAuthorityBinding(
  projectId: string,
  conversationId: string | undefined,
  workspaceRoot: string,
  repositoryPath: string,
  metadataMarkerIdentity: string,
  fingerprint: string,
): readonly string[] {
  return [
    projectId,
    conversationId ?? "",
    workspaceRoot,
    repositoryPath,
    metadataMarkerIdentity,
    fingerprint,
  ];
}
