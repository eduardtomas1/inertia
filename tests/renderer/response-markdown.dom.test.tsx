import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ResponseMarkdown } from "../../src/renderer/src/components/ResponseMarkdown";

describe("ResponseMarkdown project files", () => {
  it("routes prose links and code-file metadata into Inertia's file viewer", () => {
    const onOpenProjectFile = vi.fn();
    const openProjectPath = vi.fn(async () => undefined);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { openProjectPath },
    });
    render(
      <ResponseMarkdown
        content={[
          "Inspect [the adapter](src/server/adapter.ts).",
          "",
          "Inspect [the cited adapter](src/server/adapter.ts:42:7).",
          "",
          "Browse [the sources](src/server/).",
          "",
          "Browse [docs without a slash](docs).",
          "",
          "```ts file=src/server/adapter.ts",
          "export const adapter = true;",
          "```",
          "",
          "```tsx file=\"src/my component.tsx\"",
          "export const component = true;",
          "```",
        ].join("\n")}
        projectRoot="/workspace"
        projectId="11111111-1111-4111-8111-111111111111"
        conversationId="22222222-2222-4222-8222-222222222222"
        defaultCodeWrap={false}
        onOpenProjectFile={onOpenProjectFile}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "the adapter" }));
    fireEvent.click(screen.getByRole("link", { name: "the cited adapter" }));
    fireEvent.click(screen.getByRole("link", { name: "the sources" }));
    fireEvent.click(screen.getByRole("link", {
      name: "docs without a slash",
    }));
    fireEvent.click(screen.getByRole("button", {
      name: "src/server/adapter.ts",
    }));
    fireEvent.click(screen.getByRole("button", {
      name: "src/my component.tsx",
    }));
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      1,
      "src/server/adapter.ts",
    );
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      2,
      "src/server/adapter.ts:42:7",
    );
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      3,
      "docs",
    );
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      4,
      "src/server/adapter.ts",
    );
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      5,
      "src/my component.tsx",
    );
    expect(openProjectPath).toHaveBeenCalledWith({
      projectId: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
      relativePath: "src/server",
      action: "reveal",
    });
  });
});
