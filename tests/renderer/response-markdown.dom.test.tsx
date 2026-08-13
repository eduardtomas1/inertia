import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ResponseMarkdown } from "../../src/renderer/src/components/ResponseMarkdown";

describe("ResponseMarkdown project files", () => {
  it("keeps a project source range on the real Files navigation callback", () => {
    const onOpenProjectFile = vi.fn();
    render(
      <ResponseMarkdown
        content="Open [the Java service](src/main/java/Service.java#L12-L15)."
        projectRoot="/workspace"
        projectId="11111111-1111-4111-8111-111111111111"
        defaultCodeWrap={false}
        onOpenProjectFile={onOpenProjectFile}
      />,
    );

    const link = screen.getByRole("link", { name: "the Java service" });
    expect(link).toHaveAttribute("data-language", "java");
    expect(link).toHaveAttribute("data-language-accent", "amber");
    fireEvent.click(link);
    expect(onOpenProjectFile).toHaveBeenCalledWith(
      "src/main/java/Service.java#L12-L15",
    );
  });

  it("keeps a code header source range while displaying a relative file label", () => {
    const onOpenProjectFile = vi.fn();
    render(
      <ResponseMarkdown
        content={[
          "```java file=/workspace/src/main/java/Service.java#L12-L15",
          "public final class Service {}",
          "```",
        ].join("\n")}
        projectRoot="/workspace"
        projectId="11111111-1111-4111-8111-111111111111"
        defaultCodeWrap={false}
        onOpenProjectFile={onOpenProjectFile}
      />,
    );

    fireEvent.click(screen.getByRole("button", {
      name: "src/main/java/Service.java",
    }));
    expect(onOpenProjectFile).toHaveBeenCalledWith(
      "src/main/java/Service.java#L12-L15",
    );
    expect(document.body).not.toHaveTextContent("/workspace");
  });

  it("opens extensionless locations and encoded delimiters as exact files", () => {
    const onOpenProjectFile = vi.fn();
    render(
      <ResponseMarkdown
        content={[
          "Open [the image](Dockerfile:42).",
          "Open [the literal hash](src/Service%23L12).",
          "Open [the literal colon](src/Service.java%3A42).",
        ].join("\n\n")}
        projectRoot="/workspace"
        projectId="11111111-1111-4111-8111-111111111111"
        defaultCodeWrap={false}
        onOpenProjectFile={onOpenProjectFile}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "the image" }));
    fireEvent.click(screen.getByRole("link", { name: "the literal hash" }));
    fireEvent.click(screen.getByRole("link", { name: "the literal colon" }));
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(1, "Dockerfile:42");
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(2, "src/Service#L12");
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(3, "src/Service.java:42");
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
