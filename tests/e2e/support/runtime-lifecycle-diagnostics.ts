import type { TestInfo } from "@playwright/test";
import WebSocket from "ws";

import { parseRuntimeLifecycleDiagnosticSnapshot } from
  "../../../src/shared/lifecycle-diagnostics";
import type { ServerEvent } from "../../../src/shared/contracts";
import { captureBoundedFailureDiagnostic } from
  "../../helpers/bounded-failure-diagnostic";

export async function attachRuntimeLifecycleFailureDiagnostic(
  testInfo: Pick<TestInfo, "attach">,
  readWebsocketUrl: () => Promise<string | null>,
): Promise<void> {
  const deadlineAt = Date.now() + 2_000;
  const diagnostic = await captureBoundedFailureDiagnostic(async () => {
    const url = await readWebsocketUrl();
    const remainingMs = deadlineAt - Date.now();
    if (!url || remainingMs <= 0) return null;
    return await new Promise((resolve) => {
      const socket = new WebSocket(url, {
        origin: "inertia://bundle", maxPayload: 2 * 1024 * 1024,
        handshakeTimeout: remainingMs,
      });
      const finish = (value: unknown): void => {
        clearTimeout(timer);
        socket.terminate();
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), remainingMs);
      socket.on("error", () => finish(null));
      socket.once("close", () => { clearTimeout(timer); resolve(null); });
      socket.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString()) as ServerEvent;
          const event = message.type === "runtime.event" ? message.event : message;
          if (event.type !== "server.welcome") return;
          // Validate and retain only the safe projection; never attach the
          // snapshot's conversation data or the authenticated WebSocket URL.
          finish(parseRuntimeLifecycleDiagnosticSnapshot(event.snapshot.lifecycleDiagnostics));
        } catch { finish(null); }
      });
    });
  }, 2_000);
  await testInfo.attach("runtime-lifecycle-diagnostic", {
    body: JSON.stringify(diagnostic, null, 2), contentType: "application/json",
  });
}
