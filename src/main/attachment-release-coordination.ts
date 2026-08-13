interface RendererAttachmentRegistry {
  releaseFromRenderer(id: string): Promise<boolean>;
}

interface RuntimeAttachmentOwner {
  deferAttachmentRelease(id: string): boolean;
}

export async function releaseRendererAttachment(
  id: string,
  registry: RendererAttachmentRegistry,
  runtime: RuntimeAttachmentOwner | null,
): Promise<void> {
  if (runtime?.deferAttachmentRelease(id)) return;
  const released = await registry.releaseFromRenderer(id);
  // A handoff can consume and cancel the registry-side deletion after the
  // first ownership check. Transfer that already-issued renderer intent to
  // the now-live runtime claim so relinquish/failure still deletes the copy.
  if (!released) runtime?.deferAttachmentRelease(id);
}
