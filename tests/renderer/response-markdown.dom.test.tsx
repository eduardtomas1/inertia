import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponseMarkdown } from "../../src/renderer/src/components/ResponseMarkdown";
import {
  MAX_CONCURRENT_MARKDOWN_IMAGE_LOADS,
  MAX_MARKDOWN_IMAGES_PER_DOCUMENT,
} from "../../src/renderer/src/components/markdown/MarkdownImageScheduler";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

type ObservedIntersection = Pick<
  IntersectionObserverEntry,
  "intersectionRatio" | "isIntersecting" | "target"
>;

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = [];

  readonly observed = new Set<Element>();

  constructor(
    private readonly callback: IntersectionObserverCallback,
  ) {
    TestIntersectionObserver.instances.push(this);
  }

  observe = (element: Element): void => {
    this.observed.add(element);
  };

  unobserve = (element: Element): void => {
    this.observed.delete(element);
  };

  disconnect = (): void => {
    this.observed.clear();
  };

  reveal(elements: Element[]): void {
    this.notify(elements, true);
  }

  hide(elements: Element[]): void {
    this.notify(elements, false);
  }

  private notify(elements: Element[], visible: boolean): void {
    const observations: ObservedIntersection[] = elements.map((target) => ({
      intersectionRatio: visible ? 1 : 0,
      isIntersecting: visible,
      target,
    }));
    this.callback(
      observations as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver,
    );
  }
}

function markdownImages(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `![Diagram ${index + 1}](assets/diagram-${index + 1}.png)`,
  ).join("\n\n");
}

afterEach(() => {
  vi.unstubAllGlobals();
  TestIntersectionObserver.instances = [];
});

describe("ResponseMarkdown project files", () => {
  it("keeps encoded delimiters as literal project filenames", () => {
    const onOpenProjectFile = vi.fn();
    render(
      <ResponseMarkdown
        content={[
          "[literal hash](src/Service%23L12)",
          "[literal colon](src/Service.java%3A42)",
          "[literal question](src/why%3F.java)",
          "[question source](src/why%3F.java:42)",
          "[colon source](src/name%3A42:7)",
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
    fireEvent.click(screen.getByRole("link", { name: "question source" }));
    fireEvent.click(screen.getByRole("link", { name: "colon source" }));
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
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      4,
      "src/why?.java",
      { startLine: 42, endLine: 42 },
      true,
    );
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      5,
      "src/name:42",
      { startLine: 7, endLine: 7 },
      true,
    );
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(6, "Dockerfile:42");
  });

  it("opens raw delimiter filenames from code-file metadata", () => {
    const onOpenProjectFile = vi.fn();
    render(
      <ResponseMarkdown
        content={[
          '```java file="src/why?.java"',
          "class Question {}",
          "```",
          "",
          '```java file="src/hash#part.java"',
          "class Hash {}",
          "```",
          "",
          '```java file="Name:Part.java"',
          "class Colon {}",
          "```",
        ].join("\n")}
        projectRoot="/workspace"
        projectId="11111111-1111-4111-8111-111111111111"
        defaultCodeWrap={false}
        onOpenProjectFile={onOpenProjectFile}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "src/why?.java" }));
    fireEvent.click(screen.getByRole("button", { name: "src/hash#part.java" }));
    fireEvent.click(screen.getByRole("button", { name: "Name:Part.java" }));
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(1, "src/why?.java");
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(2, "src/hash#part.java");
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(3, "Name:Part.java");
  });

  it("preserves Windows drive and top-level source links through Markdown", () => {
    const onOpenProjectFile = vi.fn();
    render(
      <ResponseMarkdown
        content="[drive source](C:/Workspace/src/App.java#L4), [encoded drive](C%3A%5CWorkspace%5Csrc%5CEncoded.java:9), and [readme](README:42)"
        projectRoot="C:/Workspace"
        projectId="11111111-1111-4111-8111-111111111111"
        defaultCodeWrap={false}
        onOpenProjectFile={onOpenProjectFile}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "drive source" }));
    fireEvent.click(screen.getByRole("link", { name: "encoded drive" }));
    fireEvent.click(screen.getByRole("link", { name: "readme" }));
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      1,
      "src/App.java",
      { startLine: 4, endLine: 4 },
    );
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      2,
      "src/Encoded.java",
      { startLine: 9, endLine: 9 },
    );
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(3, "README:42");

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
      4,
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
      "src/server",
    );
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      5,
      "docs",
    );
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      6,
      "src/server/adapter.ts",
    );
    expect(onOpenProjectFile).toHaveBeenNthCalledWith(
      7,
      "src/my component.tsx",
    );
    expect(openProjectPath).not.toHaveBeenCalled();
  });

  it("preserves decomposed Unicode in same-file and cross-file heading ids", () => {
    const onOpenProjectFile = vi.fn();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    render(
      <ResponseMarkdown
        content={[
          "[Local section](#cafe%CC%81)",
          "[Other section](guide.md#cafe%CC%81)",
          "",
          "## Cafe\u0301",
        ].join("\n")}
        projectRoot="/workspace"
        projectId="11111111-1111-4111-8111-111111111111"
        defaultCodeWrap={false}
        onOpenProjectFile={onOpenProjectFile}
      />,
    );
    const heading = screen.getByRole("heading", { name: "Cafe\u0301" });
    expect(heading).toHaveAttribute("id", "user-content-cafe\u0301");

    fireEvent.click(screen.getByRole("link", { name: "Local section" }));
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      inline: "nearest",
    });
    expect(heading).toHaveFocus();

    fireEvent.click(screen.getByRole("link", { name: "Other section" }));
    expect(onOpenProjectFile).toHaveBeenCalledWith(
      "guide.md",
      undefined,
      undefined,
      "cafe\u0301",
    );
  });

  it("keeps empty alt text decorative for trusted images", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { container } = render(
      <ResponseMarkdown
        content="![](assets/divider.png)\n\n![](https://example.com/unavailable.png)\n\n![   ](https://example.com/space.png)"
        projectRoot="/workspace"
        projectId="11111111-1111-4111-8111-111111111111"
        defaultCodeWrap={false}
      />,
    );
    const trusted = await waitFor(() => {
      const image = container.querySelector("img");
      expect(image).not.toBeNull();
      return image;
    });
    expect(trusted).toHaveAttribute("alt", "");
    expect(trusted).not.toHaveAccessibleName();
    const unavailable = container.querySelectorAll(
      ".response-markdown-image-unavailable",
    );
    expect(unavailable).toHaveLength(2);
    for (const placeholder of unavailable) {
      expect(placeholder).toHaveAttribute("aria-hidden", "true");
      expect(placeholder).not.toHaveAttribute("role");
      expect(placeholder).not.toHaveAttribute("aria-label");
    }
    expect(screen.queryByRole("img", { name: "Markdown image" }))
      .not.toBeInTheDocument();
  });

  it("admits a bounded image set and restores load slots on completion", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { container } = render(
      <ResponseMarkdown
        content={markdownImages(MAX_MARKDOWN_IMAGES_PER_DOCUMENT + 2)}
        projectRoot="/workspace"
        projectId={PROJECT_ID}
        conversationId={CONVERSATION_ID}
        defaultCodeWrap={false}
      />,
    );

    await waitFor(() => expect(container.querySelectorAll(
      '[data-markdown-image-state="loading"] img',
    )).toHaveLength(MAX_CONCURRENT_MARKDOWN_IMAGE_LOADS));
    const shells = container.querySelectorAll(".response-markdown-image-shell");
    expect(shells).toHaveLength(MAX_MARKDOWN_IMAGES_PER_DOCUMENT + 2);
    const overflow = container.querySelectorAll(
      '[data-markdown-image-overflow="true"]',
    );
    expect(overflow).toHaveLength(2);
    for (const placeholder of overflow) {
      expect(placeholder.closest(".response-markdown-image-shell")
        ?.querySelector("img[src]")).toBeNull();
      expect(placeholder).toHaveTextContent("document image limit reached");
    }

    const firstLoading = container.querySelector<HTMLImageElement>(
      '[data-markdown-image-state="loading"] img',
    );
    expect(firstLoading).toHaveAttribute(
      "src",
      `inertia://bundle/workspace-image/${PROJECT_ID}/${CONVERSATION_ID}/assets%2Fdiagram-1.png`,
    );
    expect(firstLoading).toHaveAttribute("loading", "lazy");
    expect(firstLoading).toHaveAttribute("decoding", "async");
    fireEvent.load(firstLoading!);
    await waitFor(() => {
      expect(container.querySelectorAll(
        '[data-markdown-image-state="loaded"] img',
      )).toHaveLength(1);
      expect(container.querySelectorAll(
        '[data-markdown-image-state="loading"] img',
      )).toHaveLength(MAX_CONCURRENT_MARKDOWN_IMAGE_LOADS);
    });

    const nextLoading = container.querySelector<HTMLImageElement>(
      '[data-markdown-image-state="loading"] img',
    );
    fireEvent.error(nextLoading!);
    await waitFor(() => {
      expect(container.querySelectorAll(
        '[data-markdown-image-state="error"] img',
      )).toHaveLength(0);
      expect(container.querySelectorAll(
        '[data-markdown-image-state="loading"] img',
      )).toHaveLength(MAX_CONCURRENT_MARKDOWN_IMAGE_LOADS);
    });
  });

  it("loads only observed-near images and releases hidden resources", async () => {
    vi.stubGlobal(
      "IntersectionObserver",
      TestIntersectionObserver as unknown as typeof IntersectionObserver,
    );
    const { container } = render(
      <ResponseMarkdown
        content={markdownImages(4)}
        projectRoot="/workspace"
        projectId={PROJECT_ID}
        defaultCodeWrap={false}
      />,
    );
    await waitFor(() => expect(TestIntersectionObserver.instances)
      .toHaveLength(1));
    const observer = TestIntersectionObserver.instances[0]!;
    const shells = [...container.querySelectorAll(
      ".response-markdown-image-shell",
    )];
    expect(observer.observed.size).toBe(4);
    expect(container.querySelector("img[src]")).toBeNull();

    act(() => observer.reveal(shells.slice(0, 3)));
    await waitFor(() => expect(container.querySelectorAll(
      '[data-markdown-image-state="loading"] img',
    )).toHaveLength(MAX_CONCURRENT_MARKDOWN_IMAGE_LOADS));
    expect(shells[2]).toHaveAttribute("data-markdown-image-state", "waiting");

    fireEvent.load(shells[0]!.querySelector("img")!);
    await waitFor(() => expect(shells[2])
      .toHaveAttribute("data-markdown-image-state", "loading"));
    act(() => observer.hide([shells[0]!]));
    expect(shells[0]).toHaveAttribute("data-markdown-image-state", "waiting");
    expect(shells[0]!.querySelector("img[src]")).toBeNull();

    fireEvent.error(shells[1]!.querySelector("img")!);
    await waitFor(() => expect(container.querySelectorAll(
      '[data-markdown-image-state="loading"] img',
    )).toHaveLength(1));
    act(() => observer.reveal([shells[3]!]));
    await waitFor(() => expect(container.querySelectorAll(
      '[data-markdown-image-state="loading"] img',
    )).toHaveLength(MAX_CONCURRENT_MARKDOWN_IMAGE_LOADS));
  });

  it("restores admission after an image unmounts", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const original = markdownImages(MAX_MARKDOWN_IMAGES_PER_DOCUMENT + 1);
    const view = render(
      <ResponseMarkdown
        content={original}
        projectRoot="/workspace"
        projectId={PROJECT_ID}
        defaultCodeWrap={false}
      />,
    );
    await waitFor(() => expect(view.container.querySelectorAll(
      '[data-markdown-image-overflow="true"]',
    )).toHaveLength(1));

    const withoutEighth = [
      markdownImages(MAX_MARKDOWN_IMAGES_PER_DOCUMENT - 1),
      `![Diagram ${MAX_MARKDOWN_IMAGES_PER_DOCUMENT + 1}](assets/diagram-${MAX_MARKDOWN_IMAGES_PER_DOCUMENT + 1}.png)`,
    ].join("\n\n");
    view.rerender(
      <ResponseMarkdown
        content={withoutEighth}
        projectRoot="/workspace"
        projectId={PROJECT_ID}
        defaultCodeWrap={false}
      />,
    );
    await waitFor(() => expect(view.container.querySelector(
      '[data-markdown-image-overflow="true"]',
    )).toBeNull());
    expect(view.container.querySelectorAll(".response-markdown-image-shell"))
      .toHaveLength(MAX_MARKDOWN_IMAGES_PER_DOCUMENT);
  });

  it("disposes image admissions when the render identity changes", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const oldProjectId = "11111111-1111-4111-8111-111111111111";
    const newProjectId = "33333333-3333-4333-8333-333333333333";
    const view = render(
      <ResponseMarkdown
        content={markdownImages(3)}
        projectRoot="/workspace"
        projectId={oldProjectId}
        defaultCodeWrap={false}
      />,
    );
    await waitFor(() => expect(view.container.querySelectorAll(
      '[data-markdown-image-state="loading"] img',
    )).toHaveLength(MAX_CONCURRENT_MARKDOWN_IMAGE_LOADS));

    view.rerender(
      <ResponseMarkdown
        content={markdownImages(3)}
        projectRoot="/workspace"
        projectId={newProjectId}
        defaultCodeWrap={false}
      />,
    );
    await waitFor(() => {
      const active = [...view.container.querySelectorAll<HTMLImageElement>(
        '[data-markdown-image-state="loading"] img',
      )];
      expect(active).toHaveLength(MAX_CONCURRENT_MARKDOWN_IMAGE_LOADS);
      for (const image of active) {
        expect(image.src).toContain(newProjectId);
        expect(image.src).not.toContain(oldProjectId);
      }
    });
  });

  it("blocks inline image data and preserves descriptive placeholder access", () => {
    const { container } = render(
      <ResponseMarkdown
        content="![Inline chart](data:image/png;base64,iVBORw0KGgo=)"
        projectRoot="/workspace"
        projectId="11111111-1111-4111-8111-111111111111"
        defaultCodeWrap={false}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[src^="data:image/"]')).toBeNull();
    expect(screen.getByRole("img", { name: "Inline chart" }))
      .toHaveTextContent("Inline chart (image unavailable)");
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
