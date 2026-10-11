import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  PromptPresetMenu,
} from "../../src/renderer/src/components/composer/PromptPresetMenu";
import {
  useComposerMenus,
} from "../../src/renderer/src/components/composer/useComposerMenus";
import type {
  PromptPreset,
  PromptPresetDraft,
} from "../../src/shared/prompt-presets";

const route = {
  harnessId: "codex-app-server",
  backendProfileId: "builtin:openai",
  modelId: "gpt-5.6-sol",
  reasoningEffort: "xhigh",
} as const;
const presets: PromptPreset[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Review lifecycle",
    body: "Review this change for lifecycle races.",
    route: null,
    position: 0,
    revision: 1,
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Route audit",
    body: "Audit this route.",
    route: { ...route, reasoningEffort: "high" },
    position: 1,
    revision: 3,
    createdAt: "2026-08-10T10:01:00.000Z",
    updatedAt: "2026-08-10T10:02:00.000Z",
  },
];

function Harness({
  entries = presets,
  currentMessage = "Current composer text",
  onApply = vi.fn(() => Promise.resolve(true)),
  onCreate = vi.fn(() => Promise.resolve()),
  onUpdate = vi.fn(() => Promise.resolve()),
  onDuplicate = vi.fn(() => Promise.resolve()),
  onDelete = vi.fn(() => Promise.resolve()),
  onReorder = vi.fn(() => Promise.resolve()),
  currentRoute = route,
}: {
  entries?: PromptPreset[];
  currentMessage?: string;
  onApply?: (preset: PromptPreset) => Promise<boolean>;
  onCreate?: (draft: PromptPresetDraft) => Promise<void>;
  onUpdate?: (preset: PromptPreset, draft: PromptPresetDraft) => Promise<void>;
  onDuplicate?: (preset: PromptPreset) => Promise<void>;
  onDelete?: (preset: PromptPreset) => Promise<void>;
  onReorder?: (presetIds: readonly string[]) => Promise<void>;
  currentRoute?: typeof route & { fastMode?: boolean };
}): React.JSX.Element {
  const controller = useComposerMenus();
  return (
    <PromptPresetMenu
      presets={entries}
      currentMessage={currentMessage}
      currentRoute={currentRoute}
      menuController={controller}
      onApply={onApply}
      onCommand={(_key, command) => {
        if (command.type === "prompt-preset.create") {
          return onCreate(command.payload);
        }
        if (command.type === "prompt-preset.reorder") {
          return onReorder(command.payload.presetIds);
        }
        const preset = entries.find(({ id }) =>
          id === command.payload.presetId);
        if (!preset) return Promise.reject(new Error("Missing test preset"));
        if (command.type === "prompt-preset.update") {
          return onUpdate(preset, {
            name: command.payload.name ?? preset.name,
            body: command.payload.body ?? preset.body,
            route: command.payload.route === undefined
              ? preset.route
              : command.payload.route,
          });
        }
        if (command.type === "prompt-preset.duplicate") {
          return onDuplicate(preset);
        }
        return onDelete(preset);
      }}
    />
  );
}

describe("PromptPresetMenu", () => {
  it("names Standard when a legacy route blocks an otherwise matching Fast route", async () => {
    const legacyPreset: PromptPreset = {
      ...presets[1]!,
      route: { ...route, reasoningEffort: "xhigh" },
    };
    render(<Harness
      entries={[legacyPreset]}
      currentRoute={{ ...route, fastMode: true }}
    />);
    const trigger = screen.getByRole("button", {
      name: "Prompt presets, 1 saved",
    });
    expect(trigger).not.toHaveAttribute("aria-describedby");
    fireEvent.click(trigger);
    expect((await screen.findByTitle(/speed Standard/u)).closest("button"))
      .toHaveAttribute("aria-disabled", "true");
  });

  it("lists presets without a heading and offers one line plus one button when empty", async () => {
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Prompt presets, 2 saved" }));
    const dialog = await screen.findByRole("dialog", { name: "Prompt presets" });
    expect(dialog).not.toHaveTextContent("Reusable text");
    expect(dialog.querySelector("strong")?.textContent).not.toBe("Prompt presets");
    expect(within(dialog).getByRole("button", { name: "New" })).toHaveClass("secondary-button");
    view.unmount();
    render(<Harness entries={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Prompt presets" }));
    const empty = await screen.findByRole("dialog", { name: "Prompt presets" });
    expect(empty).toHaveTextContent(/^No presets yetCreate a preset$/u);
    expect(empty.querySelectorAll("button")).toHaveLength(1);
  });

  it("states the 30-preset limit on New and Duplicate and keeps the count as plain text", async () => {
    const full: PromptPreset[] = Array.from({ length: 30 }, (_, index) => ({
      ...presets[0]!,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `Preset ${index}`,
      position: index,
    }));
    const onDuplicate = vi.fn(() => Promise.resolve());
    render(<Harness entries={full} onDuplicate={onDuplicate} />);
    fireEvent.click(screen.getByRole("button", { name: "Prompt presets, 30 saved" }));
    const dialog = await screen.findByRole("dialog", { name: "Prompt presets" });
    expect(within(dialog).getByText("30/30")).toHaveClass("prompt-presets-count");
    const create = within(dialog).getByRole("button", { name: "New" });
    expect(create).toHaveAttribute("aria-disabled", "true");
    expect(create).toHaveAccessibleDescription("30 presets is the limit");
    fireEvent.click(create);
    expect(screen.queryByLabelText("Name")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit prompt preset: Preset 3" }));
    const duplicate = screen.getByRole("button", { name: "Duplicate" });
    expect(duplicate).toHaveAttribute("aria-disabled", "true");
    expect(duplicate).toHaveAccessibleDescription("30 presets is the limit");
    fireEvent.click(duplicate);
    expect(onDuplicate).not.toHaveBeenCalled();
  });

  it("opens from the keyboard, applies matching text, and explains route blocks", async () => {
    const onApply = vi.fn(() => Promise.resolve(true));
    render(<Harness onApply={onApply} />);
    const trigger = screen.getByRole("button", {
      name: "Prompt presets, 2 saved",
    });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const dialog = await screen.findByRole("dialog", { name: "Prompt presets" });
    await waitFor(() => expect(within(dialog).getByRole("button", {
      name: "New",
    })).toHaveFocus());

    const apply = within(dialog).getByRole("button", { name: /^Review lifecycle/u });
    expect(apply).not.toHaveAttribute("title");
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledExactlyOnceWith(presets[0]);
    await waitFor(() => expect(screen.queryByRole("dialog", {
      name: "Prompt presets",
    })).not.toBeInTheDocument());

    fireEvent.click(trigger);
    const blockedRouteLabel = [
      "Harness codex-app-server",
      "backend builtin:openai",
      "model gpt-5.6-sol",
      "reasoning high",
    ].join(" · ");
    const reason = await screen.findByTitle(
      `Available on ${blockedRouteLabel}`,
    );
    expect(reason).toHaveTextContent(`Available on ${blockedRouteLabel}`);
    const blocked = reason.closest("button")!;
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    expect(blocked).not.toHaveAttribute("title");
    blocked.focus();
    expect(blocked).toHaveFocus();
    fireEvent.click(blocked);
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("creates from current text without route, attachments, or implicit send state", async () => {
    const onCreate = vi.fn<
      (draft: PromptPresetDraft) => Promise<void>
    >(() => Promise.resolve());
    render(<Harness onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", {
      name: "Prompt presets, 2 saved",
    }));
    fireEvent.click(await screen.findByRole("button", { name: "New" }));

    expect(screen.getByLabelText("Name")).toHaveValue("Current composer text");
    expect(screen.getByLabelText("Prompt text"))
      .toHaveValue("Current composer text");
    fireEvent.click(screen.getByRole("button", { name: "Save preset" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toEqual({
      name: "Current composer text",
      body: "Current composer text",
      route: null,
    });
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("attachments");
  });

  it("keeps edit operations explicit and keyboard-labeled", async () => {
    const onUpdate = vi.fn(() => Promise.resolve());
    const onDuplicate = vi.fn(() => Promise.resolve());
    const onDelete = vi.fn(() => Promise.resolve());
    const onReorder = vi.fn(() => Promise.resolve());
    render(<Harness
      onUpdate={onUpdate}
      onDuplicate={onDuplicate}
      onDelete={onDelete}
      onReorder={onReorder}
    />);
    fireEvent.click(screen.getByRole("button", {
      name: "Prompt presets, 2 saved",
    }));
    const edit = await screen.findByRole("button", {
      name: "Edit prompt preset: Route audit",
    });
    expect(edit).not.toHaveAttribute("title");
    fireEvent.click(edit);
    const routeToggle = screen.getByRole("checkbox", {
      name: /Bound to saved model route/u,
    });
    expect(routeToggle).toBeChecked();
    expect(routeToggle).toHaveAccessibleName(
      /Harness codex-app-server · backend builtin:openai · model gpt-5\.6-sol · reasoning high/u,
    );
    expect(screen.getByText(/Saved route differs from this chat/u))
      .toBeVisible();
    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "Route review" } });
    fireEvent.click(screen.getByRole("button", { name: "Save preset" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(
      presets[1],
      {
        name: "Route review",
        body: presets[1]!.body,
        route: presets[1]!.route,
      },
    ));

    fireEvent.click(await screen.findByRole("button", {
      name: "Edit prompt preset: Route audit",
    }));
    const moveUp = screen.getByRole("button", { name: "Move Route audit up" });
    const moveDown = screen.getByRole("button", { name: "Move Route audit down" });
    for (const control of [moveUp, moveDown]) expect(control).not.toHaveAttribute("title");
    fireEvent.pointerEnter(moveUp, { pointerType: "mouse" });
    await waitFor(() => expect([...document.querySelectorAll('[role="tooltip"]')].map(({ textContent }) => textContent)).toContain("Move up"));
    fireEvent.pointerLeave(moveUp, { pointerType: "mouse" });
    fireEvent.click(moveUp);
    await waitFor(() => expect(onReorder).toHaveBeenCalledWith([
      presets[1]!.id,
      presets[0]!.id,
    ]));

    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(onDuplicate).toHaveBeenCalledWith(presets[1]));
  });

  it("distinguishes backend routes and explicitly rebinds off then on", async () => {
    const alternateRoutePreset: PromptPreset = {
      ...presets[1]!,
      id: "33333333-3333-4333-8333-333333333333",
      name: "Alternate backend",
      route: {
        ...route,
        harnessId: "claude-agent-sdk",
        backendProfileId: "custom:anthropic",
      },
      position: 0,
    };
    const onUpdate = vi.fn(() => Promise.resolve());
    render(<Harness entries={[alternateRoutePreset]} onUpdate={onUpdate} />);
    fireEvent.click(screen.getByRole("button", {
      name: "Prompt presets, 1 saved",
    }));
    const storedRouteLabel = [
      "Harness claude-agent-sdk",
      "backend custom:anthropic",
      "model gpt-5.6-sol",
      "reasoning xhigh",
    ].join(" · ");
    expect((await screen.findByTitle(`Available on ${storedRouteLabel}`)).closest("button"))
      .toHaveAttribute("aria-disabled", "true");

    fireEvent.click(screen.getByRole("button", {
      name: "Edit prompt preset: Alternate backend",
    }));
    const routeToggle = screen.getByRole("checkbox", {
      name: /Bound to saved model route/u,
    });
    expect(routeToggle).toHaveAccessibleName(new RegExp(storedRouteLabel, "u"));
    fireEvent.click(routeToggle);
    expect(routeToggle).not.toBeChecked();
    expect(routeToggle).toHaveAccessibleName(
      /Limit to current model route Harness codex-app-server · backend builtin:openai · model gpt-5\.6-sol · reasoning xhigh/u,
    );
    fireEvent.click(routeToggle);
    expect(routeToggle).toBeChecked();
    expect(routeToggle).toHaveAccessibleName(
      /Bound to saved model route Harness codex-app-server · backend builtin:openai · model gpt-5\.6-sol · reasoning xhigh/u,
    );
    expect(screen.queryByText(/Saved route differs from this chat/u))
      .not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save preset" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(
      alternateRoutePreset,
      {
        name: alternateRoutePreset.name,
        body: alternateRoutePreset.body,
        route,
      },
    ));
  });

  it("returns focus to the preset list after cancelling an edit", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", {
      name: "Prompt presets, 2 saved",
    }));
    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "New" }))
      .toHaveFocus());
  });

  it("ignores stale failures after the menu closes during a rapid edit", async () => {
    let rejectCreate: (error: Error) => void = () => undefined;
    const onCreate = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectCreate = reject;
    }));
    render(<Harness onCreate={onCreate} />);
    const trigger = screen.getByRole("button", {
      name: "Prompt presets, 2 saved",
    });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    const save = screen.getByRole("button", { name: "Save preset" });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(onCreate).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", {
      name: "Prompt presets",
    })).not.toBeInTheDocument());
    await act(async () => rejectCreate(new Error("stale failure")));
    fireEvent.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Prompt presets" }))
      .not.toHaveTextContent("stale failure");
  });

  it("keeps a reopened draft when an earlier save resolves", async () => {
    let resolveCreate: () => void = () => undefined;
    const onCreate = vi.fn(() => new Promise<void>((resolve) => {
      resolveCreate = resolve;
    }));
    render(<Harness onCreate={onCreate} />);
    const trigger = screen.getByRole("button", {
      name: "Prompt presets, 2 saved",
    });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(screen.getByRole("button", { name: "Save preset" }));
    expect(onCreate).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", {
      name: "Prompt presets",
    })).not.toBeInTheDocument());
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "New draft" },
    });
    fireEvent.change(screen.getByLabelText("Prompt text"), {
      target: { value: "Keep this reopened draft." },
    });

    await act(async () => resolveCreate());

    expect(screen.getByLabelText("Name")).toHaveValue("New draft");
    expect(screen.getByLabelText("Prompt text"))
      .toHaveValue("Keep this reopened draft.");
  });

  it("requires a second, clearly named delete action", async () => {
    const onDelete = vi.fn(() => Promise.resolve());
    render(<Harness onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", {
      name: "Prompt presets, 2 saved",
    }));
    fireEvent.click(await screen.findByRole("button", {
      name: "Edit prompt preset: Review lifecycle",
    }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(presets[0]));
  });
});
