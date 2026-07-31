export async function writeClipboardText(text: string): Promise<boolean> {
  if (!text) return false;
  const bridge = window.inertia;
  if (bridge?.copyText) {
    try {
      return await bridge.copyText(text);
    } catch {
      return false;
    }
  }
  if (!navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
