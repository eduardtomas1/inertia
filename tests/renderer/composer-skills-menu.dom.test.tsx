import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";

import {
  ComposerSkillsMenu,
  type ComposerSkillsMenuProps,
} from "../../src/renderer/src/components/composer/ComposerSkillsMenu";
import { useComposerMenus } from "../../src/renderer/src/components/composer/useComposerMenus";
import type { AgentSkillSummary } from "../../src/shared/contracts";

function skill(index: number): AgentSkillSummary {
  return {
    id: `skill-${index}`,
    conversationId: "conversation-1",
    name: `skill-${index}`,
    description: `Skill ${index} full description`,
    shortDescription: `Skill ${index} summary`,
    scope: "repo",
    enabled: true,
    source: "codex-native",
  };
}

function Harness(
  props: Omit<ComposerSkillsMenuProps, "menuController">,
): React.JSX.Element {
  const menuController = useComposerMenus();
  return <ComposerSkillsMenu {...props} menuController={menuController} />;
}

const defaults: Omit<ComposerSkillsMenuProps, "menuController"> = {
  skills: [skill(0), skill(1)],
  capability: {
    kind: "codex-native",
    available: true,
    label: "Codex skills",
  },
  loading: false,
  error: null,
  listboxId: "test-skill-menu",
  disabled: false,
  running: false,
  onList: vi.fn(async () => undefined),
  onInsert: vi.fn(),
};

describe("ComposerSkillsMenu", () => {
  it("keeps unavailable skills visible and explains the runtime reason", () => {
    const reason = "This harness does not expose skills for this route.";
    render(
      <Harness
        {...defaults}
        capability={{
          kind: "unavailable",
          available: false,
          label: "Skills unavailable",
          reason,
        }}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: `Skills unavailable: ${reason}`,
    });
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    expect(trigger).toHaveAttribute("data-readiness", "unavailable");
    expect(trigger).toHaveAttribute("title", reason);
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("names the temporary reason when insertion is blocked during a turn", () => {
    render(<Harness {...defaults} running />);
    const trigger = screen.getByRole("button", {
      name: /Skills unavailable: Skills can be changed after/u,
    });
    expect(trigger).toHaveAttribute("data-readiness", "blocked");
  });

  it("uses instance-scoped popup relationships in split composers", () => {
    render(
      <>
        <Harness {...defaults} listboxId="split-skills-primary" />
        <Harness {...defaults} listboxId="split-skills-secondary" />
      </>,
    );
    const triggers = screen.getAllByRole("button", {
      name: "Insert a codex skills invocation",
    });
    fireEvent.click(triggers[0]!);
    fireEvent.click(triggers[1]!);

    const controls = triggers.map((trigger) => trigger.getAttribute("aria-controls"));
    expect(controls[0]).not.toBe(controls[1]);
    for (const id of controls) {
      expect(id).not.toBeNull();
      expect(document.getElementById(id ?? "")).not.toBeNull();
    }
  });

  it("searches, navigates, and inserts the exact canonical token", async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<Harness {...defaults} onInsert={onInsert} />);
    const trigger = screen.getByRole("button", {
      name: "Insert a codex skills invocation",
    });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const search = screen.getByRole("searchbox", { name: /Find a skill/u });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, { target: { value: "skill 1 summary" } });
    expect(screen.queryByRole("menuitem", { name: /skill-0/i }))
      .not.toBeInTheDocument();
    const item = screen.getByRole("menuitem", { name: /\$skill-1/i });
    await user.tab();
    expect(item).toHaveFocus();
    fireEvent.click(item);
    expect(onInsert).toHaveBeenCalledWith(expect.objectContaining({
      name: "skill-1",
    }));
    expect(screen.queryByRole("menu", { name: "Insert Codex skills" }))
      .not.toBeInTheDocument();
  });

  it("discovers skills when the empty menu opens from the keyboard", () => {
    const onList = vi.fn(async () => undefined);
    render(<Harness {...defaults} skills={[]} onList={onList} />);
    const trigger = screen.getByRole("button", {
      name: "Insert a codex skills invocation",
    });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    expect(onList).toHaveBeenCalledWith(false);
    expect(screen.getByRole("menu", { name: "Insert Codex skills" }))
      .toBeInTheDocument();
  });

  it("keeps autocomplete options keyboard reachable and natively activatable", async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(
      <div className="composer">
        <textarea aria-label="Message" defaultValue="$skill" />
        <Harness {...defaults} completion="skill" onInsert={onInsert} />
      </div>,
    );
    const editor = screen.getByRole("textbox", { name: "Message" });
    editor.focus();
    const suggestions = await screen.findByRole("listbox", {
      name: "Skill suggestions",
    });
    const options = within(suggestions).getAllByRole("option");
    expect(options.every((option) => option.tabIndex === 0)).toBe(true);
    options[0]!.focus();
    expect(options[0]).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onInsert).toHaveBeenCalledWith(expect.objectContaining({
      name: "skill-0",
    }));
  });
});
