// Serialize into the renderer before paste; keep the first pending state even
// when the next Playwright round trip arrives after the commit response.
export function observePendingAttachment(composer: Element, name: string): {
  read: () => { visible: boolean; imageCount: number } | null;
  dispose: () => void;
} {
  let observed: { visible: boolean; imageCount: number } | null = null;
  const observer = new MutationObserver(() => {
    const pending = [...composer.querySelectorAll('[data-attachment-pending="true"]')]
      .find((row) => row.querySelector(".composer-attachment-copy strong")?.textContent === name);
    if (!pending) return;
    const bounds = pending.getBoundingClientRect();
    observed = {
      visible: pending.isConnected && bounds.width > 0 && bounds.height > 0
        && getComputedStyle(pending).visibility === "visible",
      imageCount: pending.querySelectorAll("img").length,
    };
    observer.disconnect();
  });
  observer.observe(composer, { subtree: true, childList: true, attributes: true });
  return { read: () => observed, dispose: () => observer.disconnect() };
}
