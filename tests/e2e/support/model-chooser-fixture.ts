import { expect } from "@playwright/test";
import type { AppSnapshot, ServerEvent } from "../../../src/shared/contracts";
import { createAppFixture, type AppFixture } from "./app-fixture";
import { seedLargeModelCatalog } from "./model-catalog-fixture";

export async function createModelChooserFixture(name: string): Promise<AppFixture> {
  const app = await createAppFixture({
    name,
    initialState: "conversation",
    windowDisplay: "primary",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      seedLargeModelCatalog(testDirectory, workspaceDirectory);
    },
  });
  // This fixture disables provider execution. Supply discovery readiness at
  // the renderer transport boundary, without enabling real CLIs or bypassing
  // the runtime's route/continuation checks. Other providers stay absent.
  const readySnapshot = (snapshot: AppSnapshot): AppSnapshot => ({
    ...snapshot,
    providers: snapshot.providers.map((provider) =>
      provider.id === "codex" || provider.id === "claude"
        ? { ...provider, available: true, installState: "installed", authState: "authenticated", canRun: true }
        : provider),
  });
  try {
    await app.page.routeWebSocket(/.*/u, (route) => {
      route.connectToServer().onMessage((data) => {
        const event = JSON.parse(data.toString()) as ServerEvent;
        if (event.type === "server.welcome" || event.type === "snapshot.updated") {
          event.snapshot = readySnapshot(event.snapshot);
        } else if (event.type === "runtime.event" && event.event.type === "snapshot.updated") {
          event.event.snapshot = readySnapshot(event.event.snapshot);
        }
        route.send(JSON.stringify(event));
      });
    });
    await app.page.reload();
    await expect(app.page.getByRole("textbox", { name: "Message" })).toBeVisible();
    return app;
  } catch (error) {
    try {
      await app.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Model chooser fixture setup and cleanup failed.");
    }
    throw error;
  }
}
