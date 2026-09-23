import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProjectIcon, ProjectName } from "../../src/renderer/src/components/ProjectIcon";
import { loadProjectColorContrast, projectColorTints } from "../../src/renderer/src/lib/projectColorTints";
import { adaptProjectColor } from "../../src/shared/project-color-contrast";
import { PROJECT_COLOR_PALETTE } from "../../src/shared/project-colors";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";

describe("project colour tint resolution", () => {
  it("resolves palette colours synchronously and loads custom colour contrast on demand, then re-renders marks", async () => {
    expect(projectColorTints(null)).toBeNull();
    expect(projectColorTints({ kind: "palette", name: "blue" })).toMatchObject({ light: PROJECT_COLOR_PALETTE.blue.light, dark: PROJECT_COLOR_PALETTE.blue.dark });
    expect(projectColorTints({ kind: "palette", name: "chartreuse" as never })).toBeNull();
    expect(projectColorTints({ kind: "custom", value: "not a colour" })).toBeNull();
    const custom = { color: "#6f76d9", preferences: { ...defaultProjectPreferences(), color: { kind: "custom" as const, value: "#FF00AA" }, colorEmphasis: "icon-and-name" as const } };
    const view = render(<><ProjectIcon project={custom} /><ProjectName project={custom}>Studio</ProjectName></>);
    expect(loadProjectColorContrast.peek()).toBeNull();
    expect(view.container.querySelector("[data-project-tinted]")).toBeNull();
    await act(async () => { await loadProjectColorContrast(); });
    const tints = { light: adaptProjectColor("#ff00aa", "light"), dark: adaptProjectColor("#ff00aa", "dark") };
    expect(projectColorTints({ kind: "custom", value: "#ff00aa" })).toEqual(tints);
    const icon = view.container.querySelector<SVGElement>("svg")!;
    expect(icon).toHaveAttribute("data-project-tinted", "true");
    expect(icon.style.getPropertyValue("--project-tint-dark")).toBe(tints.dark);
    expect(view.getByText("Studio")).toHaveClass("project-name-tinted");
  });
});
