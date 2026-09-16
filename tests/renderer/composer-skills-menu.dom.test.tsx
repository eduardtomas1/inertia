import {
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useLayoutEffect, useRef } from "react";
import userEvent from "@testing-library/user-event";

import {
  ComposerSkillsMenu,
  type ComposerSkillsMenuProps,
} from "../../src/renderer/src/components/composer/ComposerSkillsMenu";
import { useComposerSkillCompletion } from "../../src/renderer/src/components/composer/useComposerSkillCompletion";
import { useComposerMenus } from "../../src/renderer/src/components/composer/useComposerMenus";
import type { AgentSkillSummary } from "../../src/shared/contracts";

function rect({
  top,
  right,
  bottom,
  left,
}: {
  top: number;
  right: number;
  bottom: number;
  left: number;
}): DOMRect {
  return {
    top,
    right,
    bottom,
    left,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

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
  const editor = useRef<HTMLTextAreaElement>(null);
  const { setMenuTrigger } = menuController;
  useLayoutEffect(() => {
    setMenuTrigger("skills", editor.current);
    return () => setMenuTrigger("skills", null);
  }, [setMenuTrigger]);
  return <><textarea ref={editor} aria-label="Message" aria-controls={props.listboxId} />
    <ComposerSkillsMenu {...props} menuController={menuController} /></>;
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
  it("matches skill names independently of the renderer locale", () => {
    const localeLowercase = vi.spyOn(String.prototype, "toLocaleLowerCase")
      .mockImplementation(function (this: string): string {
        return this.toLocaleLowerCase("tr-TR");
      });
    const inspect = { ...skill(0), name: "Inspect" };

    try {
      const { result } = renderHook(() => useComposerSkillCompletion(
        [inspect],
        "$I",
        true,
      ));
      expect(result.current.activeSkill?.name).toBe("Inspect");
    } finally {
      localeLowercase.mockRestore();
    }
  });

  it("has no skills button, and only opens suggestions for a typed dollar query", () => {
    const view = render(<Harness {...defaults} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    view.rerender(<Harness {...defaults} completion="" />);
    expect(screen.getByRole("listbox", { name: "Skill suggestions" })).toBeInTheDocument();
  });

  it.each([{ running: true }, { disabled: true }, {
    capability: { kind: "unavailable" as const, available: false as const, label: "Skills unavailable" as const, reason: "Unsupported route" },
  }])("does not discover or insert skills for a blocked route: %j", (blocked) => {
    const onList = vi.fn(async () => undefined);
    render(<Harness {...defaults} {...blocked} skills={[]} completion="" onList={onList} />);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onList).not.toHaveBeenCalled();
  });

  it("uses instance-scoped popup relationships in split composers", () => {
    render(<><Harness {...defaults} completion="" listboxId="primary-skills" />
      <Harness {...defaults} completion="" listboxId="secondary-skills" /></>);
    for (const editor of screen.getAllByRole("textbox")) {
      expect(document.getElementById(editor.getAttribute("aria-controls")!)).not.toBeNull();
    }
    expect(screen.getAllByRole("listbox")).toHaveLength(2);
  });

  it("positions the generated Skills popover inside its split pane", async () => {
    render(
      <section className="conversation-split-pane">
        <div className="chat-workspace">
          <div className="composer">
            <Harness {...defaults} completion="" listboxId="split-skills-generated" />
          </div>
        </div>
      </section>,
    );
    const pane = document.querySelector<HTMLElement>(
      ".conversation-split-pane",
    )!;
    const workspace = document.querySelector<HTMLElement>(
      ".chat-workspace",
    )!;
    const trigger = screen.getByRole("textbox", { name: "Message" });
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1_180);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(640);
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(rect({
      top: 0,
      right: 260,
      bottom: 600,
      left: 0,
    }));
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue(rect({
      top: 0,
      right: 260,
      bottom: 600,
      left: 0,
    }));
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect({
      top: 520,
      right: 252,
      bottom: 552,
      left: 220,
    }));

    const popover = screen.getByRole("listbox", { name: "Skill suggestions" }).parentElement!;
    vi.spyOn(popover, "getBoundingClientRect").mockImplementation(() => {
      const width = Number.parseFloat(popover.style.maxWidth) || 300;
      const [shiftX = 0, shiftY = 0] = popover.style.translate
        .match(/-?\d+(?:\.\d+)?/gu)
        ?.map(Number) ?? [];
      return rect({
        top: 300 + shiftY,
        right: 220 + shiftX + width,
        bottom: 500 + shiftY,
        left: 220 + shiftX,
      });
    });
    Object.defineProperties(popover, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 200 },
    });

    expect(trigger).toHaveAttribute("aria-controls", "split-skills-generated");
    await waitFor(() => expect(popover).toHaveAttribute(
      "data-composer-popover-positioned",
      "true",
    ));
    const positioned = popover.getBoundingClientRect();
    expect(positioned.left).toBeGreaterThanOrEqual(8);
    expect(positioned.right).toBeLessThanOrEqual(252);
  });

  it("discovers an empty catalog on dollar entry once and offers retry after failure", () => {
    const onList = vi.fn(async () => undefined);
    const view = render(<Harness {...defaults} skills={[]} completion="" onList={onList} />);
    expect(onList).toHaveBeenCalledExactlyOnceWith(false);
    view.rerender(<Harness {...defaults} skills={[]} completion="s" onList={onList} error="Discovery failed" />);
    expect(onList).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Discovery failed");
    fireEvent.click(screen.getByRole("button", { name: "Refresh skills" }));
    expect(onList).toHaveBeenLastCalledWith(true);
  });

  it("keeps Escape dismissed until the query changes and shows no-match feedback", () => {
    const view = render(<Harness {...defaults} completion="skill" />);
    const editor = screen.getByRole("textbox");
    editor.focus();
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    view.rerender(<Harness {...defaults} completion="missing" />);
    expect(screen.getByRole("status")).toHaveTextContent("No skills match");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("keeps autocomplete options keyboard reachable and natively activatable", async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(
      <div className="composer">
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
