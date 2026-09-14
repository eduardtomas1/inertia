import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ResponseMarkdown } from "../../src/renderer/src/components/ResponseMarkdown";

afterEach(() => { Reflect.deleteProperty(window, "inertia"); });
function fixture(content: string) {
  const openExternal = vi.fn(async (_url: string) => undefined);
  const onOpenProjectFile = vi.fn();
  Object.defineProperty(window, "inertia", { configurable: true, value: { openExternal } });
  const result = render(<ResponseMarkdown content={content} projectRoot="/workspace/project"
    projectId="11111111-1111-4111-8111-111111111111" defaultCodeWrap={false}
    onOpenProjectFile={onOpenProjectFile} />);
  return { ...result, openExternal, onOpenProjectFile };
}

it.each([
  ["[Workflow](</home/example/Desktop/automation/Workflow with spaces.json>)", "file:///home/example/Desktop/automation/Workflow%20with%20spaces.json"],
  ["[Workflow](../Workflow.json)", "file:///workspace/Workflow.json"],
  ["[Workflow](file:///Users/example/Documents/Workflow%20with%20spaces.json)", "file:///Users/example/Documents/Workflow%20with%20spaces.json"],
  ["[Workflow](file:///C:/Other%20Folder/Workflow.json)", "file:///C:/Other%20Folder/Workflow.json"],
  ["[Workflow](file://server/share/Workflow.json)", "file://server/share/Workflow.json"],
  ["[Workflow](/elsewhere/name%23part%3A42%3F.json#L12)", "file:///elsewhere/name%23part%3A42%3F.json"],
  ["[Workflow](/elsewhere/source.ts:42:7)", "file:///elsewhere/source.ts:42:7"],
  ["[Workflow](file:///elsewhere/source.ts:42)", "file:///elsewhere/source.ts:42"],
])("opens an outside-project Markdown link on click: %s", (content, url) => {
  const { openExternal, onOpenProjectFile } = fixture(content);
  const link = screen.getByRole("link", { name: "Workflow" });
  expect(link).toHaveClass("response-project-file-link");
  expect(link).toHaveAttribute("href", url);
  expect(openExternal).not.toHaveBeenCalled();
  fireEvent.click(link);
  expect(openExternal).toHaveBeenCalledWith(url);
  expect(onOpenProjectFile).not.toHaveBeenCalled();
});

it("makes outside-project code-block file headers clickable", () => {
  const { openExternal, onOpenProjectFile } = fixture("```ts file=/elsewhere/source.ts:42\nconst value = 1;\n```");
  fireEvent.click(screen.getByRole("link", { name: "/elsewhere/source.ts:42" }));
  expect(openExternal).toHaveBeenCalledWith("file:///elsewhere/source.ts:42");
  expect(onOpenProjectFile).not.toHaveBeenCalled();
});

it("keeps project-local file URLs in the workspace preview", () => {
  const { openExternal, onOpenProjectFile } = fixture("[Source](file:///workspace/project/src/app.ts#L12)");
  fireEvent.click(screen.getByRole("link", { name: "Source" }));
  expect(openExternal).not.toHaveBeenCalled();
  expect(onOpenProjectFile).toHaveBeenCalledWith("src/app.ts", { startLine: 12, endLine: 12 });
});

it("shows a failed open and lets the user retry", async () => {
  const { openExternal } = fixture("[Workflow](/elsewhere/Workflow.json)");
  openExternal.mockRejectedValueOnce(new Error("Native error containing a private path"));
  const link = screen.getByRole("link", { name: "Workflow" });
  fireEvent.click(link);
  expect(await screen.findByRole("alert")).toHaveTextContent("The local file could not be opened.");
  expect(screen.queryByText(/private path/u)).toBeNull();
  fireEvent.click(link);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(openExternal).toHaveBeenCalledTimes(2);
});

it("does not load outside-project images or open them while rendering", () => {
  const { container, openExternal } = fixture("![local](/elsewhere/image.png)\n\n![local URL](file:///elsewhere/image.png)");
  expect(container.querySelector("img")).toBeNull();
  expect(openExternal).not.toHaveBeenCalled();
});
