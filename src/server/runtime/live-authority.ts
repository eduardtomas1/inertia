export async function issueAuthorityForLiveOwner(
  isOwnerLive: () => boolean,
  issue: () => Promise<string>,
  clearOwner: () => void,
): Promise<string | null> {
  if (!isOwnerLive()) return null;
  const authorityRef = await issue();
  if (isOwnerLive()) return authorityRef;
  clearOwner();
  return null;
}
