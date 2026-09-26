import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Composer } from "../../src/renderer/src/components/Composer";
import { composerProps, conversation, provider } from "./composer-fixtures";

vi.mock("../../src/renderer/src/components/composer/composerQueueAction", () => {
  throw new Error("Queue module unavailable");
});
vi.mock("../../src/renderer/src/components/composer/composerRouteRepair", () => {
  throw new Error("Provider repair module unavailable");
});

afterEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); });

it("keeps the draft and reports a failed queue module load without sending", async () => {
  const onSend = vi.fn(async () => undefined);
  const onMessageQueueCommand = vi.fn();
  render(<Composer {...composerProps(conversation("queue-load-failure"), {
    running: true, onSend, onMessageQueueCommand,
  })} />);
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: "Keep this queued draft" } });
  fireEvent.keyDown(input, { key: "Tab" });
  await waitFor(() => expect(screen.getByText(/error when mocking a module|Queue module unavailable/u)).toBeVisible());
  expect(input).toHaveValue("Keep this queued draft");
  expect(onSend).not.toHaveBeenCalled();
  expect(onMessageQueueCommand).not.toHaveBeenCalled();
});

it("reports a failed provider repair module load and releases the action", async () => {
  const onRefreshProvider = vi.fn();
  render(<Composer {...composerProps(conversation("repair-load-failure"), {
    providers: [{ ...provider, canRun: false, authState: "error" }], onRefreshProvider,
  })} />);
  const repair = screen.getByRole("button", { name: /Refresh.*connection check failed/u });
  fireEvent.click(repair);
  await waitFor(() => expect(screen.getByText(/error when mocking a module|Provider repair module unavailable/u)).toBeVisible());
  expect(repair).toBeEnabled();
  expect(onRefreshProvider).not.toHaveBeenCalled();
});
