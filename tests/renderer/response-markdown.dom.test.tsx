import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ResponseMarkdown } from "../../src/renderer/src/components/ResponseMarkdown";

describe("ResponseMarkdown project files", () => {
  it("keeps encoded delimiters as literal project filenames", () => {
    const onOpenProjectFile = vi.fn();
    render(
      <ResponseMarkdown
        content={[
          "[literal hash](src/Service%23L12)",
          "[literal colon](src/Service.java%3A42)",
          "[literal question](src/why%3F.java)",
          "[extensionless source](Dockerfile:42)",
        ].join("\n\n")}
        projectRoot="/workspace"
        projectId="11111111-1111-4111-8111-111111111111"
        defaultCodeWrap={false}
        onOpenProjectFile={onOpenProjectFile}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "literal hash" }));
    fireEvent.click(screen.getByRole("link", { name: "literal colon" }));
    fireEvent.click(screen.getByRole("link", { name: "literal question" }));
    fireEvent.click(screen.getByRole("link", {
      name: "extensionless source",
    }));
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      1,
      "src/Service#L12",
      undefined,
      true,
    );
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      2,
      "src/Service.java:42",
      undefined,
      true,
    );
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      3,
      "src/why?.java",
      undefined,
      true,
    );
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(4, "Dockerfile:42");
  });

  it("preserves Windows drive and top-level source links through Markdown", () => {
    const onOpenProjectFile = vi.fn();
    render(
      <ResponseMarkdown
        content="[drive source](C:/Workspace/src/App.java#L4) and [readme](README:42)"
        projectRoot="C:/Workspace"
        projectId="11111111-1111-4111-8111-111111111111"
        defaultCodeWrap={false}
        onOpenProjectFile={onOpenProjectFile}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "drive source" }));
    fireEvent.click(screen.getByRole("link", { name: "readme" }));
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      1,
      "src/App.java",
      { startLine: 4, endLine: 4 },
    );
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(2, "README:42");

    render(
      <ResponseMarkdown
        content="[UNC source](\\\\server\\share\\workspace\\src\\Remote.java#L7)"
        projectRoot="\\\\SERVER\\Share\\Workspace"
        projectId="11111111-1111-4111-8111-111111111111"
        defaultCodeWrap={false}
        onOpenProjectFile={onOpenProjectFile}
      />,
    );
    fireEvent.click(screen.getByRole("link", { name: "UNC source" }));
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      3,
      "src/Remote.java",
      { startLine: 7, endLine: 7 },
    );
  });

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
          "Inspect [the exact range](src/server/adapter.ts#L42-L47).",
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
    fireEvent.click(screen.getByRole("link", { name: "the exact range" }));
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
      "src/server/adapter.ts",
      { startLine: 42, endLine: 47 },
    );
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      4,
      "docs",
    );
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      5,
      "src/server/adapter.ts",
    );
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      6,
      "src/my component.tsx",
    );
    expect(openProjectPath).toHaveBeenCalledWith({
      projectId: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
      relativePath: "src/server",
      action: "reveal",
    });
  });

  it("preserves interactive code state across an equivalent parent render", () => {
    const props = {
      content: "```ts\nconst stable = true;\n```",
      projectRoot: "/workspace",
      projectId: "11111111-1111-4111-8111-111111111111",
      defaultCodeWrap: false,
    } as const;
    const view = render(<ResponseMarkdown {...props} />);
    const wrap = screen.getByRole("button", { name: "Wrap" });
    fireEvent.click(wrap);
    expect(wrap).toHaveAttribute("aria-pressed", "true");
    expect(wrap).toHaveAttribute("title", "Disable code wrapping");

    view.rerender(<ResponseMarkdown {...props} />);

    expect(screen.getByRole("button", { name: "Wrap" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("preserves each code control across changing parent callbacks", async () => {
    const copyText = vi.fn(async () => true);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { copyText },
    });
    const content = [
      "```ts",
      "const first = true;",
      "```",
      "",
      "```json",
      "{\"second\":true}",
      "```",
    ].join("\n");
    const props = {
      content,
      projectRoot: "/workspace",
      projectId: "11111111-1111-4111-8111-111111111111",
      defaultCodeWrap: false,
    } as const;
    const view = render(
      <ResponseMarkdown {...props} onOpenProjectFile={() => undefined} />,
    );
    const wrapButtons = screen.getAllByRole("button", { name: "Wrap" });
    const copyButtons = screen.getAllByRole("button", { name: "Copy" });
    fireEvent.click(wrapButtons[0]!);
    fireEvent.click(copyButtons[1]!);
    await waitFor(() => expect(copyButtons[1]).toHaveTextContent("Copied"));

    view.rerender(
      <ResponseMarkdown {...props} onOpenProjectFile={() => undefined} />,
    );

    expect(screen.getAllByRole("button", { name: "Wrap" })[0])
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("button", { name: "Copy" })[0])
      .toHaveTextContent("Copy");
    expect(screen.getAllByRole("button", { name: "Copied" })[0])
      .toHaveTextContent("Copied");
    expect(copyText).toHaveBeenCalledWith('{"second":true}');
  });

  it("reports Markdown and CSV table copies independently", async () => {
    const copyText = vi.fn(async () => true);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { copyText },
    });
    render(
      <ResponseMarkdown
        content={"| Name | Value |\n| --- | --- |\n| route | exact |"}
        projectRoot="/workspace"
        projectId="11111111-1111-4111-8111-111111111111"
        defaultCodeWrap={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    await waitFor(() => expect(screen.getByRole("button", {
      name: "Copied Markdown",
    })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "CSV" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "CSV" }));
    await waitFor(() => expect(screen.getByRole("button", {
      name: "Copied CSV",
    })).toBeInTheDocument());
    expect(copyText).toHaveBeenNthCalledWith(
      1,
      "| Name | Value |\n| --- | --- |\n| route | exact |",
    );
    expect(copyText).toHaveBeenNthCalledWith(
      2,
      "Name,Value\nroute,exact",
    );
  });

  it("reports a failed copy locally and clears it after a successful retry", async () => {
    const copyText = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { copyText },
    });
    render(
      <ResponseMarkdown
        content={"```ts\nconst retry = true;\n```"}
        projectRoot="/workspace"
        projectId="11111111-1111-4111-8111-111111111111"
        defaultCodeWrap={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't copy. Try again or select the text manually.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(screen.getByRole("button", {
      name: "Copied",
    })).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Code copied to clipboard.",
    );
  });

  it("renders very large code blocks without synchronous highlighting", () => {
    const code = Array.from(
      { length: 2_001 },
      (_, index) => `const line${index} = ${index};`,
    ).join("\n");
    const { container } = render(
      <ResponseMarkdown
        content={`\`\`\`ts\n${code}\n\`\`\``}
        projectRoot="/workspace"
        projectId="11111111-1111-4111-8111-111111111111"
        defaultCodeWrap={false}
      />,
    );

    expect(container.querySelector("code.language-ts")).not.toBeNull();
    expect(container.querySelector("code.hljs")).toBeNull();
  });
});
