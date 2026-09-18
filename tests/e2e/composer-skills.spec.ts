// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";
import type { ServerEvent } from "../../src/shared/contracts";
import { createAppFixture } from "./support/app-fixture";

test("anchors dollar suggestions to the editor without a Skills toolbar button", async () => {
  const app = await createAppFixture({
    name: "composer-skills", initialState: "conversation", windowDisplay: "primary",
  });
  try {
    await app.resizeWindow(900, 800);
    const page = app.page;
    // This scenario owns editor geometry and keyboard interaction. Supply a
    // deterministic workflow projection; native discovery/cleanup is covered
    // by the provider control and workflow integration suites.
    await page.routeWebSocket(/ws:\/\/127\.0\.0\.1:/u, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const frame = JSON.parse(String(message)) as ServerEvent;
        const event = frame.type === "runtime.event" ? frame.event : frame;
        const workflow = event.type === "request.result" && event.result.kind === "agent.workflow" ? event.result.workflow : null;
        if (workflow) {
          workflow.skillsCapability = { kind: "codex-native", available: true, label: "Codex skills" };
          workflow.skills = [{
            id: "geometry-review", conversationId: workflow.conversationId,
            name: "review", description: "Review this project", shortDescription: null,
            scope: "repo", enabled: true, source: "codex-native",
          }];
        }
        socket.send(JSON.stringify(frame));
      });
    });
    await page.reload();
    const editor = page.getByLabel("Message", { exact: true });
    await expect(editor).toBeEnabled();
    await expect(page.locator(".composer-skills-trigger")).toHaveCount(0);
    await editor.fill("Use $rev for this change");
    for (let index = 0; index < " for this change".length; index += 1) {
      await editor.press("ArrowLeft");
    }
    const suggestions = page.getByRole("listbox", { name: "Skill suggestions" });
    await expect(suggestions.getByRole("option", { name: /\$review/u })).toBeVisible();
    const popup = page.locator(".composer-skills-popover");
    await expect.poll(async () => {
      const bounds = await popup.boundingBox();
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      return Boolean(bounds && viewport && bounds.x >= 0 && bounds.y >= 0
        && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
    }).toBe(true);
    await editor.press("Tab");
    await expect(editor).toHaveValue("Use $review for this change");
    await expect(editor).toBeFocused();
    await expect(suggestions).toHaveCount(0);
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});
