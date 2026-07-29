import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ComposerSkillsMenu,
  type ComposerSkillsMenuProps,
} from "../../src/renderer/src/components/composer/ComposerSkillsMenu";
import {
  useComposerMenus,
} from "../../src/renderer/src/components/composer/useComposerMenus";
import type {
  AgentSkillSummary,
} from "../../src/shared/contracts";

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
  selectedSkillIds: [],
  loading: false,
  error: null,
  disabled: false,
  running: false,
  onList: vi.fn(async () => undefined),
  onToggle: vi.fn(),
  onClear: vi.fn(),
};

describe("ComposerSkillsMenu", () => {
  it("uses instance-scoped popup relationships in split composers", () => {
    render(
      <>
        <Harness {...defaults} />
        <Harness {...defaults} />
      </>,
    );
    const triggers = screen.getAllByRole("button", {
      name: "Select Codex skills",
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

  it("moves focus through every menu action with arrow, Home, and End keys", async () => {
    render(<Harness {...defaults} selectedSkillIds={["skill-0"]} />);
    const trigger = screen.getByRole("button", {
      name: "Skills, 1 selected",
    });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getByRole("menuitem", {
        name: "Refresh Codex skills",
      })).toHaveFocus());

    fireEvent.keyDown(document.activeElement ?? trigger, { key: "ArrowDown" });
    expect(screen.getByRole("menuitemcheckbox", {
      name: /skill-0/i,
    })).toHaveFocus();
    fireEvent.keyDown(document.activeElement ?? trigger, { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Clear" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement ?? trigger, { key: "Home" });
    expect(screen.getByRole("menuitem", {
      name: "Refresh Codex skills",
    })).toHaveFocus();
    fireEvent.keyDown(document.activeElement ?? trigger, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("menu", { name: "Codex skills" }))
      .not.toBeInTheDocument();
  });

  it("disables additional skills and explains the per-turn limit", () => {
    const skills = Array.from({ length: 9 }, (_, index) => skill(index));
    render(
      <Harness
        {...defaults}
        skills={skills}
        selectedSkillIds={skills.slice(0, 8).map(({ id }) => id)}
      />,
    );
    fireEvent.click(screen.getByRole("button", {
      name: "Skills, 8 selected",
    }));

    expect(screen.getByRole("menuitemcheckbox", {
      name: /skill-8/i,
    })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Maximum 8 skills selected",
    );
  });

  it("discovers skills when the empty menu opens from the keyboard", () => {
    const onList = vi.fn(async () => undefined);
    render(<Harness {...defaults} skills={[]} onList={onList} />);
    const trigger = screen.getByRole("button", {
      name: "Select Codex skills",
    });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    expect(onList).toHaveBeenCalledWith(false);
    expect(screen.getByRole("menu", { name: "Codex skills" }))
      .toBeInTheDocument();
  });
});
