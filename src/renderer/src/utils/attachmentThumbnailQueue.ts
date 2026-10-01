export type AttachmentThumbnailState = "loading" | "ready" | "unavailable";

interface Thumbnail {
  element: HTMLSpanElement;
  source: string;
  update: (state: AttachmentThumbnailState) => void;
  visible: boolean;
  image?: HTMLImageElement;
}

const THUMBNAIL_READ_TIMEOUT_MS = 15_000;
const pending = new Set<Thumbnail>();
const loading = new Map<HTMLImageElement, () => void>();

function pump(): void {
  while (loading.size < 2 && pending.size) {
    const next = [...pending].find(({ element }) => element.parentElement === document.activeElement)
      ?? pending.values().next().value!;
    pending.delete(next);
    const image = next.image = new Image();
    image.alt = "";
    const settle = (failed?: boolean): void => {
      if (!loading.delete(image)) return;
      clearTimeout(timer);
      image.onload = image.onerror = null;
      if (next.image === image) {
        if (next.visible && failed !== undefined) next.update(failed ? "unavailable" : "ready");
        else next.image = undefined;
      }
      if (failed === undefined) {
        image.src = "";
        image.remove();
        setTimeout(pump);
      } else pump();
    };
    const timer = setTimeout(settle, THUMBNAIL_READ_TIMEOUT_MS);
    loading.set(image, settle);
    image.onload = () => settle(false);
    image.onerror = () => settle(true);
    image.src = next.source;
    next.element.append(image);
  }
}

export function observeAttachmentThumbnail(
  element: HTMLSpanElement,
  source: string,
  update: (state: AttachmentThumbnailState) => void,
): () => void {
  const entry: Thumbnail = { element, source, update, visible: false };
  let disposed = false;
  const hide = (): void => {
    entry.visible = false;
    pending.delete(entry);
    const image = entry.image;
    entry.image = undefined;
    image?.remove();
    if (image) loading.get(image)?.();
  };
  const observer = new IntersectionObserver(([observation]) => {
    if (disposed) return;
    if (!observation!.isIntersecting) { hide(); return; }
    entry.visible = true;
    if (entry.image) element.append(entry.image);
    else {
      update("loading");
      pending.add(entry);
      pump();
    }
  });
  observer.observe(element);
  return () => {
    disposed = true;
    observer.disconnect();
    hide();
  };
}
