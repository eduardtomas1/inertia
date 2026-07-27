import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const connectionSource = readFileSync(
  new URL("../../src/renderer/src/hooks/useInertiaConnection.ts", import.meta.url),
  "utf8",
);
const appSource = readFileSync(
  new URL("../../src/renderer/src/App.tsx", import.meta.url),
  "utf8",
);
const workspaceToolsSource = readFileSync(
  new URL("../../src/renderer/src/hooks/workspace-tools/useWorkspaceFiles.ts", import.meta.url),
  "utf8",
);
const workspaceGitSource = readFileSync(
  new URL("../../src/renderer/src/hooks/workspace-tools/useWorkspaceGit.ts", import.meta.url),
  "utf8",
);

describe("renderer error visibility boundary", () => {
  it("rejects command-scoped request errors without turning them into connection errors", () => {
    const requestErrorStart = connectionSource.indexOf(
      'if (event.type === "request.error")',
    );
    const requestErrorEnd = connectionSource.indexOf(
      "} else {",
      requestErrorStart,
    );
    const requestErrorBranch = connectionSource.slice(
      requestErrorStart,
      requestErrorEnd,
    );

    expect(requestErrorBranch).toContain("pending.reject(requestError)");
    expect(requestErrorBranch).not.toContain("setError(");
    expect(connectionSource).toContain(
      'setError("Inertia received an unreadable response from its local service.")',
    );
    expect(connectionSource).toContain(
      'setError(connectionError instanceof Error ? connectionError.message : "The local service is unavailable.")',
    );
  });

  it("keeps first-connect workspace hydration failures inside their owning tools", () => {
    const hydrationStart = workspaceToolsSource.indexOf(
      "void Promise.allSettled([loadFiles(), loadActions()])",
    );
    const hydrationEnd = workspaceToolsSource.indexOf(
      "}, [conversation?.id",
      hydrationStart,
    );
    const hydration = workspaceToolsSource.slice(hydrationStart, hydrationEnd);

    expect(hydrationStart).toBeGreaterThan(-1);
    expect(hydration).not.toContain("setActionError(");
    expect(workspaceGitSource).toContain(
      "void loadGit().catch(() => undefined).finally",
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
