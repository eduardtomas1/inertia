interface Thumbnail {
  element: HTMLSpanElement;
  source: string;
  update: (failed: boolean) => void;
  visible: boolean;
  image?: HTMLImageElement;
}

const pending = new Set<Thumbnail>();
const loading = new Set<HTMLImageElement>();

function pump(): void {
  while (loading.size < 2 && pending.size) {
    const next = [...pending].find(({ element }) => element.parentElement === document.activeElement)
      ?? pending.values().next().value!;
    pending.delete(next);
    const image = next.image = new Image();
    image.alt = "";
    loading.add(image);
    const finish = (failed: boolean): void => {
      image.onload = image.onerror = null;
      loading.delete(image);
      if (next.image === image) {
        if (next.visible) next.update(failed);
        else next.image = undefined;
      }
      pump();
    };
    // Keep the slot until load/error after unmount: abandoning the browser
    // request does not stop its native attachment read.
    image.onload = () => finish(false);
    image.onerror = () => finish(true);
    image.src = next.source;
    next.element.append(image);
  }
}

export function observeAttachmentThumbnail(
  element: HTMLSpanElement,
  source: string,
  update: (failed: boolean) => void,
): () => void {
  const entry: Thumbnail = { element, source, update, visible: false };
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
    else { pending.add(entry); pump(); }
  });
  observer.observe(element);
  return () => {
    disposed = true;
    observer.disconnect();
    hide();
    entry.image = undefined;
  };
}
