export const NATIVE_PREVIEW_OVERLAY_OPENED =
  "inertia:native-preview-overlay-opened";
export const NATIVE_PREVIEW_OVERLAY_CLOSED =
  "inertia:native-preview-overlay-closed";
export const NATIVE_PREVIEW_SUSPENSION_CHANGED =
  "inertia:native-preview-suspension-changed";

const suspensions = new Set<string>();

export function setNativePreviewSuspension(
  id: string,
  suspended: boolean,
): void {
  if (suspensions.has(id) === suspended) return;
  const wasSuspended = suspensions.size > 0;
  if (suspended) suspensions.add(id);
  else suspensions.delete(id);
  const isSuspended = suspensions.size > 0;
  if (!wasSuspended && isSuspended) {
    window.dispatchEvent(new Event(NATIVE_PREVIEW_OVERLAY_OPENED));
  } else if (wasSuspended && !isSuspended) {
    window.dispatchEvent(new Event(NATIVE_PREVIEW_OVERLAY_CLOSED));
  }
  window.dispatchEvent(new Event(NATIVE_PREVIEW_SUSPENSION_CHANGED));
}

export function nativePreviewSuspended(): boolean {
  return suspensions.size > 0;
}
