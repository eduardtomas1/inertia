import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentGalleryItem, AttachmentGalleryResult } from "@shared/attachment-gallery";
import type { ClientCommand, ServerEvent } from "@shared/contracts";
import { attachmentGalleryRequest } from "../lib/attachmentGalleryRequest";

export function useAttachmentGallery(options: {
  conversationId?: string;
  runtimeGeneration?: string | null;
  attachments: readonly AttachmentGalleryItem[];
  requestPage?: (cursor?: string) => Promise<AttachmentGalleryResult>;
  sendCommand?: (command: ClientCommand) => Promise<ServerEvent>;
}) {
  const { conversationId, runtimeGeneration, attachments, requestPage, sendCommand } = options;
  const loader = useRef(requestPage);
  loader.current = requestPage ?? (conversationId && sendCommand ? attachmentGalleryRequest(sendCommand, conversationId) : undefined);
  const generation = useRef(0);
  const [page, setPage] = useState<AttachmentGalleryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (cursor?: string) => {
    if (!conversationId || !loader.current) return;
    const expected = ++generation.current;
    setLoading(true); setError(null);
    try {
      const result = await loader.current(cursor);
      if (expected === generation.current && result.conversationId === conversationId) setPage(result);
    } catch (failure) {
      if (expected === generation.current) setError(failure instanceof Error ? failure.message : "The chat attachments could not be loaded.");
    } finally {
      if (expected === generation.current) setLoading(false);
    }
  }, [conversationId]);
  // Sending a newly visible attachment refreshes metadata without refetching on streamed text.
  const attachmentVersion = attachments.map(({ id }) => id).join(":");
  useEffect(() => {
    setPage(null);
    void load();
    return () => { generation.current += 1; };
  }, [conversationId, runtimeGeneration, attachmentVersion, load]);
  const visible = page?.conversationId === conversationId ? page : null;
  return { attachments: visible?.attachments ?? attachments, olderCursor: visible?.olderCursor,
    newerCursor: visible?.newerCursor, loading, error, load };
}
