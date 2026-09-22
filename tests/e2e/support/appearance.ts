import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import WebSocket from "ws";

import type { ServerEvent } from "../../../src/shared/contracts";
import type { AppFixture } from "./app-fixture";

/**
 * Chooses Light or Dark in Settings. There is no quick theme toggle, so this
 * is the user's path too. Returns through the named sidebar destination, or
 * stays in Settings when `returnTo` is null.
 */
export async function setAppearance(
  page: Page,
  theme: "light" | "dark",
  returnTo: string | null = "Workspace",
): Promise<void> {
  const html = page.locator("html");
  if (await html.getAttribute("data-theme") === theme) return;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.getByRole("radiogroup", { name: "Appearance" })
    .getByRole("radio", { name: theme === "dark" ? "Dark" : "Light", exact: true })
    .click();
  await expect(html).toHaveAttribute("data-theme", theme);
  if (returnTo) await page.getByRole("button", { name: returnTo, exact: true }).click();
}

/**
 * Saves the theme through the runtime, as Settings does, without leaving the
 * current view. For scenarios whose layout would not survive a Settings trip.
 */
export async function setAppearanceInPlace(
  app: AppFixture,
  theme: "light" | "dark",
): Promise<void> {
  const html = app.page.locator("html");
  if (await html.getAttribute("data-theme") === theme) return;
  const { websocketUrl } = await app.runtimeSnapshot();
  if (!websocketUrl) throw new Error("Fixture runtime is unavailable.");
  const requestId = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(websocketUrl, {
      origin: "inertia://bundle",
      maxPayload: 2 * 1024 * 1024,
    });
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      socket.terminate();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("The theme update timed out.")), 10_000);
    socket.on("error", (error) => finish(error));
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as ServerEvent;
      const event = frame.type === "runtime.event" ? frame.event : frame;
      if (event.type === "server.welcome") {
        socket.send(JSON.stringify({ type: "settings.update", requestId, payload: { theme } }));
      } else if (
        (event.type === "request.ok" || event.type === "request.result")
        && event.requestId === requestId
      ) {
        finish();
      } else if (event.type === "request.error" && event.requestId === requestId) {
        finish(new Error(event.message));
      }
    });
  });
  await expect(html).toHaveAttribute("data-theme", theme);
}
