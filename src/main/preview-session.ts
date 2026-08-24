import { randomUUID } from "node:crypto";
import type { Session } from "electron";

const hardenedSessions = new WeakSet<Session>();

export function createPreviewPartition(prefix = "inertia-preview"): string {
  if (!/^[a-z0-9-]{1,64}$/u.test(prefix)) {
    throw new Error("Invalid preview session partition prefix.");
  }
  return `${prefix}-${randomUUID()}`;
}

export function hardenDesktopSession(session: Session): void {
  if (hardenedSessions.has(session)) return;
  hardenedSessions.add(session);
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.on("will-download", (event, item) => {
    event.preventDefault();
    item.cancel();
  });
}
