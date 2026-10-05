import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "../../src/renderer/src/components/Composer";
import type { ComposerProps } from "../../src/renderer/src/components/composer/types";
import type { QueueCommandRunner } from "../../src/renderer/src/components/composer/runtimeQueueClient";
import type { MessageQueueResult } from "../../src/shared/queued-messages";

import { composerProps, conversation } from "./composer-fixtures";

type LatestTurn = NonNullable<ComposerProps["latestTurn"]>;

const turnId = "71717171-7171-4171-8171-717171717171";

function runningTurn(harnessId: string): LatestTurn {
  return { ...({} as LatestTurn), id: turnId, status: "running", harnessId };
}

function queueRunner(): ReturnType<typeof vi.fn<QueueCommandRunner>> {
  return vi.fn<QueueCommandRunner>(async (command): Promise<MessageQueueResult> => ({
    kind: "message.queue",
    conversationId: command.payload.conversationId,
    entries: [],
    receipt: command.type === "message.queue.get" ? null : {
      id: command.payload.id!, conversationId: command.payload.conversationId,
      content: "content" in command.payload ? command.payload.content : "", attachments: [],
      state: "waiting", createdAt: "2026-10-05T00:00:00.000Z", error: null, turnId: null, userMessageId: null,
    },
  }));
}

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("Stop and send for routes without live follow-ups", () => {
  it.each(["Enter", "click"] as const)("stops the exact running turn and sends the draft with %s", async (trigger) => {
    const current = conversation("72727272-7272-4272-8272-727272727272");
    const run = queueRunner();
    const onStop = vi.fn(async () => undefined);
    render(<Composer {...composerProps(current, {
      running: true, latestTurn: runningTurn("kimi-acp"), onQueueCommand: run, onStop,
    })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    expect(input).toHaveAttribute("placeholder", "Enter stops and sends · Tab queues");
    fireEvent.change(input, { target: { value: "Do this instead." } });
    const action = await screen.findByRole("button", { name: "Stop and send" });
    input.focus();

    await act(async () => {
      if (trigger === "Enter") fireEvent.keyDown(input, { key: "Enter" });
      else fireEvent.click(action);
    });

    await waitFor(() => expect(run.mock.calls.map(([command]) => command.type)).toContain("message.queue.stop-and-send"));
    const command = run.mock.calls.find(([candidate]) => candidate.type === "message.queue.stop-and-send")![0];
    expect(command.payload).toMatchObject({
      conversationId: current.id, turnId, content: "Do this instead.", attachments: [],
    });
    expect(onStop).not.toHaveBeenCalled();
    await waitFor(() => expect(input).toHaveValue(""));
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByRole("button", { name: "Stop agent" })).toBeVisible();
  });

  it("keeps the draft and its error when the runtime refuses", async () => {
    const current = conversation("73737373-7373-4373-8373-737373737373");
    const run = vi.fn<QueueCommandRunner>(async (command) => {
      if (command.type === "message.queue.get") return { kind: "message.queue", conversationId: current.id, entries: [], receipt: null };
      throw new Error("Send or remove the queued message first.");
    });
    render(<Composer {...composerProps(current, {
      running: true, latestTurn: runningTurn("cursor-acp"), onQueueCommand: run,
    })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Keep me." } });
    await screen.findByRole("button", { name: "Stop and send" });

    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });

    expect(await screen.findByText("Send or remove the queued message first.")).toBeVisible();
    expect(input).toHaveValue("Keep me.");
  });

  it("keeps Stop agent and live follow-ups on routes that steer the running turn", async () => {
    const current = conversation("74747474-7474-4474-8474-747474747474");
    const onSend = vi.fn(async () => undefined);
    const run = queueRunner();
    render(<Composer {...composerProps(current, {
      running: true, latestTurn: runningTurn("codex-app-server"), onQueueCommand: run, onSend,
    })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    expect(input).toHaveAttribute("placeholder", "Enter sends · Tab queues");
    fireEvent.change(input, { target: { value: "Also cover the edge case." } });
    expect(await screen.findByRole("button", { name: "Stop agent" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stop and send" })).toBeNull();

    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });

    expect(onSend).toHaveBeenCalledWith("Also cover the edge case.", [], undefined);
    expect(run.mock.calls.map(([command]) => command.type)).not.toContain("message.queue.stop-and-send");
  });
});
