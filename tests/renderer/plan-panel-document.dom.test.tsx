import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PlanPanel } from "../../src/renderer/src/components/PlanPanel";
import { planDocument, planInlineSegments } from "../../src/renderer/src/utils/planDocument";

const markdown = { projectRoot: "/workspace", projectId: "project", defaultCodeWrap: true };
const plan = [
  "# Plan: bot de Google Chat interactivo",
  "## Context",
  "El bot solo envía avisos desde `notify_failure.sh` y **no responde**.",
  ...Array.from({ length: 24 }, (_, index) => `- Paso ${index + 1}`),
].join("\n");

describe("plan panel document", () => {
  it("takes the title from the plan heading and keeps the body as markdown", () => {
    expect(planDocument(plan).title).toBe("Bot de Google Chat interactivo");
    expect(planDocument(plan).body.startsWith("## Context")).toBe(true);
    expect(planDocument("Just steps\n- one")).toEqual({ title: null, body: "Just steps\n- one" });
    expect(planInlineSegments("Use `POST /` and **verify**")).toEqual([
      { kind: "text", text: "Use " },
      { kind: "code", text: "POST /" },
      { kind: "text", text: " and " },
      { kind: "strong", text: "verify" },
    ]);
  });

  it("renders the plan as markdown, collapses long plans and formats step titles", () => {
    const { container } = render(
      <PlanPanel
        document={plan}
        markdown={markdown}
        steps={[{ id: "step", title: "**Verificación**: validar `Authorization`", status: "pending" }]}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Bot de Google Chat interactivo" })).toBeTruthy();
    const document = container.querySelector(".plan-document")!;
    expect(document.querySelector("h2")?.textContent).toBe("Context");
    expect(document.querySelector("strong")?.textContent).toBe("no responde");
    expect(document.textContent).not.toContain("**");
    expect(document.classList.contains("is-collapsed")).toBe(true);
    const toggle = screen.getByRole("button", { name: "Show full plan" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.classList.contains("is-collapsed")).toBe(false);
    const step = container.querySelector(".plan-step-title")!;
    expect(step.querySelector("strong")?.textContent).toBe("Verificación");
    expect(step.querySelector("code")?.textContent).toBe("Authorization");
    expect(screen.getByRole("button", { name: "Copy plan" })).toBeTruthy();
  });

  it("shows a document-only plan without the empty state", () => {
    render(<PlanPanel document={"# Plan: Short\nOne paragraph."} markdown={markdown} steps={[]} />);
    expect(screen.queryByText("No plan yet")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show full plan" })).toBeNull();
    expect(screen.getByText("One paragraph.")).toBeTruthy();
  });
});
