export type AttachmentThumbnailState = "loading" | "ready" | "unavailable";

interface Thumbnail {
  element: HTMLSpanElement;
  source: string;
  update: (state: AttachmentThumbnailState) => void;
  visible: boolean;
  attempts: number;
  image?: HTMLImageElement;
}

const THUMBNAIL_READ_TIMEOUT_MS = 15_000;
const MAX_THUMBNAIL_READ_ATTEMPTS = 3;
const pending = new Set<Thumbnail>();
const loading = new Set<HTMLImageElement>();

function pump(): void {
  while (loading.size < 2 && pending.size) {
    const next = [...pending].find(({ element }) => element.parentElement === document.activeElement)
      ?? pending.values().next().value!;
    pending.delete(next);
    next.attempts += 1;
    const image = next.image = new Image();
    image.alt = "";
    loading.add(image);
    const settle = (failed?: boolean): void => {
      if (!loading.delete(image)) return;
      clearTimeout(timer);
      image.onload = image.onerror = null;
      if (failed === undefined) {
        image.src = "";
        image.remove();
      }
      if (next.image === image) {
        if (next.visible && failed !== undefined) next.update(failed ? "unavailable" : "ready");
        else {
          next.image = undefined;
          if (next.visible && next.attempts < MAX_THUMBNAIL_READ_ATTEMPTS) {
            setTimeout(() => {
              if (!next.visible || next.image) return;
              pending.add(next);
              pump();
            }, next.attempts * 1_000);
          }
        }
      }
      pump();
    };
    const timer = setTimeout(settle, THUMBNAIL_READ_TIMEOUT_MS);
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
  const entry: Thumbnail = { element, source, update, visible: false, attempts: 0 };
  let disposed = false;
  const hide = (): void => {
    entry.visible = false;
    pending.delete(entry);
    entry.image?.remove();
    if (entry.image && !loading.has(entry.image)) entry.image = undefined;
  };
  const observer = new IntersectionObserver(([observation]) => {
    if (disposed) return;
    if (!observation!.isIntersecting) { hide(); return; }
    entry.visible = true;
    if (entry.image) element.append(entry.image);
    else {
      update("loading");
      entry.attempts = 0;
      pending.add(entry);
      pump();
    }
  });
  observer.observe(element);
  return () => {
    disposed = true;
    observer.disconnect();
    hide();
    entry.image = undefined;
  };
}
