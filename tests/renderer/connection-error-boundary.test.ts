import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  decodeServerEventMessage,
  deliverDecodedServerEvent,
  notifyConnectionListeners,
  runtimeCommandDelivery,
  settlePendingConnectionRequest,
  UNREADABLE_RUNTIME_RESPONSE,
} from "../../src/renderer/src/utils/connectionMessages";

const appSource = readFileSync(
  new URL("../../src/renderer/src/App.tsx", import.meta.url),
  "utf8",
).replace(/\r\n?/gu, "\n");
const workspaceToolsSource = readFileSync(
  new URL("../../src/renderer/src/hooks/workspace-tools/useWorkspaceFiles.ts", import.meta.url),
  "utf8",
).replace(/\r\n?/gu, "\n");
const workspaceGitSource = readFileSync(
  new URL("../../src/renderer/src/hooks/workspace-tools/useWorkspaceGit.ts", import.meta.url),
  "utf8",
).replace(/\r\n?/gu, "\n");

describe("renderer error visibility boundary", () => {
  it("keeps a first-send request failure command-scoped while malformed transport data becomes global", () => {
    const pending = new Map();
    let commandError: Error | null = null;
    let connectionError: string | null = null;
    let clearedTimeout: number | null = null;
    pending.set("first-send", {
      resolve: () => undefined,
      reject: (error: Error) => {
        commandError = error;
      },
      timeout: 42,
    });
    const receive = (data: unknown): void => {
      try {
        const event = decodeServerEventMessage(data);
        settlePendingConnectionRequest(event, pending, (timeout) => {
          clearedTimeout = timeout;
        });
      } catch {
        connectionError = UNREADABLE_RUNTIME_RESPONSE;
      }
    };

    receive(JSON.stringify({
      type: "request.error",
      requestId: "first-send",
      message: "The first message could not be sent.",
    }));

    expect(commandError).toMatchObject({
      message: "The first message could not be sent.",
    });
    expect(runtimeCommandDelivery(commandError)).toBe("rejected");
    expect(connectionError).toBeNull();
    expect(clearedTimeout).toBe(42);
    expect(pending.size).toBe(0);

    receive("{malformed transport frame");
    expect(connectionError).toBe(UNREADABLE_RUNTIME_RESPONSE);
  });

  it("does not mislabel valid runtime data when a projection listener throws", () => {
    const unreadable = vi.fn();
    const projectionError = new Error("projection failed");
    const deliver = () => deliverDecodedServerEvent(
      JSON.stringify({ type: "snapshot.updated", snapshot: {} }),
      (event) => {
        notifyConnectionListeners(event, [
          () => { throw projectionError; },
        ], (error) => { throw error; });
      },
      unreadable,
    );

    expect(deliver).toThrow(projectionError);
    expect(unreadable).not.toHaveBeenCalled();
  });

  it("keeps file hydration local while surfacing an initial Git refresh failure", () => {
    const hydrationMarker = workspaceToolsSource.indexOf(
      "void loadActions();",
    );
    const hydrationStart = workspaceToolsSource.lastIndexOf(
      "useEffect(() => {",
      hydrationMarker,
    );
    const hydrationEnd = workspaceToolsSource.indexOf(
      "\n\n  const selectWorkspaceFile",
      hydrationStart,
    );
    const hydration = workspaceToolsSource.slice(hydrationStart, hydrationEnd);

    expect(hydrationStart).toBeGreaterThan(-1);
    expect(hydration).not.toContain("setActionError(");
    expect(hydration).toContain("void loadFiles().catch(() => {");
    expect(hydration).toContain(
      "automaticallyLoadedAuthorityRef.current = null;",
    );
    expect(workspaceGitSource).toMatch(
      /void loadGit\(\)\.catch\(\(error\) => \{[\s\S]*?if \(!cancelled\) \{[\s\S]*?setActionError\(/,
    );
    expect(workspaceGitSource).toContain(
      'error instanceof Error && error.message.trim()',
    );
    expect(workspaceGitSource).toContain(
      '"Git changes could not be loaded."',
    );
    expect(workspaceToolsSource).toContain(
      "setFilesError(",
    );
    expect(workspaceToolsSource).toContain('"Files could not be loaded."');
  });

  it("still promotes explicitly invoked action failures to the user-facing toast", () => {
    const runStart = appSource.indexOf("const run = useCallback");
    const runEnd = appSource.indexOf(
      "const openProjectPath = useCallback",
      runStart,
    );
    const run = appSource.slice(runStart, runEnd);

    expect(run).toContain("setActionError(null)");
    expect(run).toContain(
      'setActionError(error instanceof Error ? error.message : "That action could not be completed.")',
    );
  });
});
