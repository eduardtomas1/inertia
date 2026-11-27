import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResponseMarkdown } from "../../src/renderer/src/components/ResponseMarkdown";
import { EditorPreferenceContext } from "../../src/renderer/src/hooks/useAvailableEditors";
import { renderedAnswerText } from "../../src/renderer/src/utils/answerPlainText";
import {
  MAX_CONCURRENT_MARKDOWN_IMAGE_LOADS,
  MAX_MARKDOWN_IMAGES_PER_DOCUMENT,
} from "../../src/renderer/src/components/markdown/MarkdownImageScheduler";

const markdownRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  return {
    ...actual,
    default: (options: Parameters<typeof actual.default>[0]) => {
      markdownRenders.count += 1;
      return actual.default(options);
    },
  };
});

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

  it("keeps the Markdown syntax node out of rendered attributes", () => {
    const { container } = render(
      <ResponseMarkdown
        content={[
          "Read [the docs](https://example.com/docs), [the entry](src/index.ts) and [below](#totals).",
          "",
          "<details><summary>More</summary>Hidden detail</details>",
          "",
          "## Totals",
          "",
          "| Name | Value |",
          "| --- | --- |",
          "| route | exact |",
        ].join("\n")}
        projectRoot="/workspace"
        projectId="11111111-1111-4111-8111-111111111111"
        defaultCodeWrap={false}
      />,
    );

    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("details")).not.toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(3);
    expect(container.querySelectorAll("[node]")).toHaveLength(0);
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

function withoutReactIds(html: string): string {
  return html.replace(/_r_[0-9a-z]+_/gu, "id");
}

function markdown(content: string, streaming = false) {
  return (
    <ResponseMarkdown
      content={content}
      projectRoot="/project"
      projectId={PROJECT_ID}
      defaultCodeWrap={false}
      streaming={streaming}
    />
  );
}

describe("ResponseMarkdown parse reuse", () => {
  beforeEach(() => {
    markdownRenders.count = 0;
  });

  it("reuses the rendered Markdown of a settled message when its row mounts again", () => {
    const content = "## Remounted answer\n\nA [link](./notes.md) and code:\n\n```ts\nconst remounted = 1;\n```\n";
    const first = render(markdown(content));
    const html = withoutReactIds(first.container.innerHTML);
    first.unmount();

    const second = render(markdown(content));

    expect(withoutReactIds(second.container.innerHTML)).toBe(html);
    expect(markdownRenders.count).toBe(1);
  });

  it("parses streaming content on every mount", () => {
    const content = "Streaming answer that is still growing";
    render(markdown(content, true)).unmount();
    render(markdown(content, true)).unmount();

    expect(markdownRenders.count).toBe(2);
  });
});

describe("ResponseMarkdown media linking and inline embeds", () => {
  it("resolves in-project file:// and Windows drive image embeds to workspace-image URLs", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { container } = render(
      <ResponseMarkdown
        content="![shot](file:///workspace/project/assets/shot.png)"
        projectRoot="/workspace/project"
        projectId={PROJECT_ID}
        conversationId={CONVERSATION_ID}
        defaultCodeWrap={false}
      />,
    );
    const posixImg = await waitFor(() => {
      const img = container.querySelector<HTMLImageElement>("img");
      expect(img).not.toBeNull();
      return img!;
    });
    expect(posixImg).toHaveAttribute(
      "src",
      `inertia://bundle/workspace-image/${PROJECT_ID}/${CONVERSATION_ID}/assets%2Fshot.png`,
    );

    const win = render(
      <ResponseMarkdown
        content="![win shot](C:/workspace/project/assets/shot.png)"
        projectRoot="C:/workspace/project"
        projectId={PROJECT_ID}
        defaultCodeWrap={false}
      />,
    );
    const winImg = await waitFor(() => {
      const img = win.container.querySelector<HTMLImageElement>("img");
      expect(img).not.toBeNull();
      return img!;
    });
    expect(winImg).toHaveAttribute(
      "src",
      `inertia://bundle/workspace-image/${PROJECT_ID}/project/assets%2Fshot.png`,
    );
  });

  it("handles unencoded percent signs, strips :line suffixes, ignores dot paths, and supports projectBaseRoot", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { container } = render(
      <ResponseMarkdown
        content={[
          "![percent](assets/100%_done.png:12)",
          "",
          "![parent](file:///workspace/repo/shared/logo.png)",
          "",
          "![dot](.)",
        ].join("\n")}
        projectRoot="/workspace/repo/.worktrees/feat"
        projectBaseRoot="/workspace/repo"
        projectId={PROJECT_ID}
        conversationId={CONVERSATION_ID}
        defaultCodeWrap={false}
      />,
    );
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    const images = [...container.querySelectorAll<HTMLImageElement>("img")];
    expect(images[0]).toHaveAttribute(
      "src",
      `inertia://bundle/workspace-image/${PROJECT_ID}/${CONVERSATION_ID}/assets%2F100%25_done.png`,
    );
    expect(images[1]).toHaveAttribute(
      "src",
      `inertia://bundle/workspace-image/${PROJECT_ID}/project/shared%2Flogo.png`,
    );
    expect(screen.getByRole("img", { name: "dot" })).toHaveTextContent("dot (image unavailable)");
  });

  it("renders inline video and audio cards with workspace-media URLs, Expand actions, error fallback, and unmount cleanup", () => {
    const onPreviewMedia = vi.fn();
    const onOpenProjectFile = vi.fn();
    const openProjectPath = vi.fn(async () => undefined);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { openProjectPath },
    });
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const loadSpy = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);

    const { container, unmount } = render(
      <ResponseMarkdown
        content={"![demo](recordings/demo.mp4)\n\n![clip](clips/voice.mp3)"}
        projectRoot="/workspace/project"
        projectId={PROJECT_ID}
        conversationId={CONVERSATION_ID}
        defaultCodeWrap={false}
        onOpenProjectFile={onOpenProjectFile}
        onPreviewMedia={onPreviewMedia}
      />,
    );

    const video = container.querySelector<HTMLVideoElement>("video");
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("preload", "metadata");
    expect(video).toHaveAttribute(
      "src",
      `inertia://bundle/workspace-media/${PROJECT_ID}/${CONVERSATION_ID}/recordings%2Fdemo.mp4`,
    );

    const audio = container.querySelector<HTMLAudioElement>("audio");
    expect(audio).not.toBeNull();
    expect(audio).toHaveAttribute("controls");
    expect(audio).toHaveAttribute(
      "src",
      `inertia://bundle/workspace-media/${PROJECT_ID}/${CONVERSATION_ID}/clips%2Fvoice.mp3`,
    );

    const expandButtons = screen.getAllByRole("button", { name: "Expand" });
    expect(expandButtons).toHaveLength(2);
    fireEvent.click(expandButtons[0]!);
    expect(onPreviewMedia).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      relativePath: "recordings/demo.mp4",
      kind: "video",
      name: "demo.mp4",
    }));

    expect(renderedAnswerText(container, "fallback")).toBe(
      "demo (recordings/demo.mp4)\n\nclip (clips/voice.mp3)",
    );

    fireEvent.error(video!);
    expect(screen.getByRole("button", { name: "Open in Files" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open in Files" }));
    expect(onOpenProjectFile).toHaveBeenCalledWith("recordings/demo.mp4");
    fireEvent.click(screen.getByRole("button", { name: "Open externally" }));
    expect(openProjectPath).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      relativePath: "recordings/demo.mp4",
      action: "open-externally",
    });

    unmount();
    expect(pauseSpy).toHaveBeenCalled();
    expect(loadSpy).toHaveBeenCalled();
    expect(audio!.getAttribute("src")).toBeNull();
    pauseSpy.mockRestore();
    loadSpy.mockRestore();
  });

  it("renders inline PDF and spreadsheet cards calling onPreviewMedia and copies clean plain text", () => {
    const onPreviewMedia = vi.fn();
    const { container } = render(
      <ResponseMarkdown
        content={"![report](docs/report.pdf)\n\n![budget](data/budget.xlsx)\n\n![metrics](data/metrics.csv)"}
        projectRoot="/workspace/project"
        projectId={PROJECT_ID}
        defaultCodeWrap={false}
        onPreviewMedia={onPreviewMedia}
      />,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toHaveTextContent("report.pdf");
    expect(buttons[0]).toHaveTextContent("PDF");
    expect(buttons[1]).toHaveTextContent("budget.xlsx");
    expect(buttons[1]).toHaveTextContent("Excel");
    expect(buttons[2]).toHaveTextContent("metrics.csv");
    expect(buttons[2]).toHaveTextContent("CSV");

    fireEvent.click(buttons[0]!);
    expect(onPreviewMedia).toHaveBeenNthCalledWith(1, expect.objectContaining({
      relativePath: "docs/report.pdf",
      kind: "pdf",
    }));
    fireEvent.click(buttons[1]!);
    expect(onPreviewMedia).toHaveBeenNthCalledWith(2, expect.objectContaining({
      relativePath: "data/budget.xlsx",
      kind: "spreadsheet",
    }));

    expect(renderedAnswerText(container, "fallback")).toBe(
      "report (docs/report.pdf)\n\nbudget (data/budget.xlsx)\n\nmetrics (data/metrics.csv)",
    );
  });

  it("routes media markdown links to onPreviewMedia even when preferredEditor is external", () => {
    const onPreviewMedia = vi.fn();
    const onOpenProjectFile = vi.fn();
    const openProjectPath = vi.fn(async () => undefined);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { openProjectPath },
    });

    render(
      <EditorPreferenceContext.Provider value={{ preferredEditor: "vscode", detectedEditors: [] }}>
        <ResponseMarkdown
          content={[
            "[report](docs/report.pdf)",
            "[demo](recordings/demo.mp4)",
            "[budget](data/budget.xlsx)",
            "[shot](assets/shot.png)",
            "[code](src/index.ts)",
          ].join("\n\n")}
          projectRoot="/workspace/project"
          projectId={PROJECT_ID}
          defaultCodeWrap={false}
          onOpenProjectFile={onOpenProjectFile}
          onPreviewMedia={onPreviewMedia}
        />
      </EditorPreferenceContext.Provider>,
    );

    fireEvent.click(screen.getByRole("link", { name: "report" }));
    fireEvent.click(screen.getByRole("link", { name: "demo" }));
    fireEvent.click(screen.getByRole("link", { name: "budget" }));
    fireEvent.click(screen.getByRole("link", { name: "shot" }));
    expect(onPreviewMedia).toHaveBeenCalledTimes(4);
    expect(onPreviewMedia).toHaveBeenNthCalledWith(1, expect.objectContaining({ relativePath: "docs/report.pdf", kind: "pdf" }));
    expect(onPreviewMedia).toHaveBeenNthCalledWith(2, expect.objectContaining({ relativePath: "recordings/demo.mp4", kind: "video" }));
    expect(onPreviewMedia).toHaveBeenNthCalledWith(3, expect.objectContaining({ relativePath: "data/budget.xlsx", kind: "spreadsheet" }));
    expect(onPreviewMedia).toHaveBeenNthCalledWith(4, expect.objectContaining({ relativePath: "assets/shot.png", kind: "image" }));
    expect(openProjectPath).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("link", { name: "code" }));
    expect(openProjectPath).toHaveBeenCalledWith(expect.objectContaining({
      relativePath: "src/index.ts",
      action: "open-in-editor",
      editor: "vscode",
    }));
  });

  it("opens preview lightbox when clicking a loaded inline image", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const onPreviewMedia = vi.fn();
    const { container } = render(
      <ResponseMarkdown
        content="![Dashboard](assets/dashboard.png)"
        projectRoot="/workspace/project"
        projectId={PROJECT_ID}
        defaultCodeWrap={false}
        onPreviewMedia={onPreviewMedia}
      />,
    );

    const img = await waitFor(() => {
      const node = container.querySelector<HTMLImageElement>("img");
      expect(node).not.toBeNull();
      return node!;
    });
    fireEvent.load(img);
    fireEvent.click(img);

    expect(onPreviewMedia).toHaveBeenCalledWith(expect.objectContaining({
      projectId: PROJECT_ID,
      relativePath: "assets/dashboard.png",
      kind: "image",
      name: "dashboard.png",
    }));
  });

  it("keeps the 9th image capped at the document image limit without a manual override button", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { container } = render(
      <ResponseMarkdown
        content={markdownImages(MAX_MARKDOWN_IMAGES_PER_DOCUMENT + 1)}
        projectRoot="/workspace/project"
        projectId={PROJECT_ID}
        defaultCodeWrap={false}
      />,
    );

    await waitFor(() => {
      const shells = container.querySelectorAll(".response-markdown-image-shell");
      expect(shells).toHaveLength(MAX_MARKDOWN_IMAGES_PER_DOCUMENT + 1);
      expect(shells[MAX_MARKDOWN_IMAGES_PER_DOCUMENT]?.getAttribute("data-markdown-image-state")).toBe("overflow");
    });
    expect(screen.queryByRole("button", { name: "Load image" })).toBeNull();
    expect(renderedAnswerText(container, "fallback")).not.toContain("Load image");
  });

  it("renders outside-project local media as a clickable button without loading or auto-opening it", () => {
    const openExternal = vi.fn(async () => undefined);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { openExternal },
    });
    const { container } = render(
      <ResponseMarkdown
        content="![Outside shot](file:///elsewhere/shot.png)"
        projectRoot="/workspace/project"
        projectId={PROJECT_ID}
        defaultCodeWrap={false}
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(openExternal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Outside shot" }));
    expect(openExternal).toHaveBeenCalledWith("file:///elsewhere/shot.png");
  });

  it("loads visible workspace images cleanly under React StrictMode", async () => {
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        x: 0,
        y: 40,
        top: 40,
        bottom: 220,
        left: 0,
        right: 320,
        width: 320,
        height: 180,
        toJSON: () => ({}),
      });
    try {
      const { container } = render(
        <StrictMode>
          <ResponseMarkdown
            content="![Chart](assets/chart.png)"
            projectRoot="/workspace/project"
            projectId={PROJECT_ID}
            defaultCodeWrap={false}
          />
        </StrictMode>,
      );

      await waitFor(() => {
        const img = container.querySelector<HTMLImageElement>('img[alt="Chart"]');
        expect(img).not.toBeNull();
        expect(img?.getAttribute("src")).toBe(
          `inertia://bundle/workspace-image/${PROJECT_ID}/project/assets%2Fchart.png`,
        );
      });
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("preserves inline video src under React StrictMode and when switching video URLs", () => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const { container, rerender } = render(
      <StrictMode>
        <ResponseMarkdown
          content="![Demo A](demos/a.mp4)"
          projectRoot="/workspace/project"
          projectId={PROJECT_ID}
          defaultCodeWrap={false}
        />
      </StrictMode>,
    );
    expect(container.querySelector("video")).toHaveAttribute(
      "src",
      `inertia://bundle/workspace-media/${PROJECT_ID}/project/demos%2Fa.mp4`,
    );

    rerender(
      <StrictMode>
        <ResponseMarkdown
          content="![Demo B](demos/b.mp4)"
          projectRoot="/workspace/project"
          projectId={PROJECT_ID}
          defaultCodeWrap={false}
        />
      </StrictMode>,
    );
    expect(container.querySelector("video")).toHaveAttribute(
      "src",
      `inertia://bundle/workspace-media/${PROJECT_ID}/project/demos%2Fb.mp4`,
    );
  });

  it("lets the parent link own interaction for wrapped images without nesting a preview button", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const openExternal = vi.fn(async () => undefined);
    const onPreviewMedia = vi.fn();
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { openExternal },
    });
    const { container } = render(
      <ResponseMarkdown
        content="[![Chart](assets/chart.png)](https://example.com)"
        projectRoot="/workspace/project"
        projectId={PROJECT_ID}
        defaultCodeWrap={false}
        onPreviewMedia={onPreviewMedia}
      />,
    );

    const link = await waitFor(() => {
      const anchor = container.querySelector<HTMLAnchorElement>("a");
      expect(anchor?.querySelector('img[alt="Chart"]')).not.toBeNull();
      return anchor!;
    });
    expect(link.querySelector("button")).toBeNull();
    fireEvent.click(link.querySelector('img[alt="Chart"]')!);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/");
    expect(onPreviewMedia).not.toHaveBeenCalled();

    // Wrapped video and audio render static cards without nested controls or buttons.
    const { container: mediaContainer } = render(
      <ResponseMarkdown
        content="[![Demo](demos/clip.mp4)](https://example.com/v) [![Track](audio/song.mp3)](https://example.com/a)"
        projectRoot="/workspace/project"
        projectId={PROJECT_ID}
        defaultCodeWrap={false}
        onPreviewMedia={onPreviewMedia}
      />,
    );
    const anchors = mediaContainer.querySelectorAll<HTMLAnchorElement>("a");
    expect(anchors).toHaveLength(2);
    for (const anchor of anchors) {
      expect(anchor.querySelector("video")).toBeNull();
      expect(anchor.querySelector("audio")).toBeNull();
      expect(anchor.querySelector("button")).toBeNull();
    }
    fireEvent.click(anchors[0]!);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/v");
    expect(onPreviewMedia).not.toHaveBeenCalled();
  });

  it("does not pass base-checkout paths into a worktree conversation's Files callback", () => {
    const openProjectPath = vi.fn(async () => undefined);
    const onOpenProjectFile = vi.fn();
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { openProjectPath },
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);

    const { container } = render(
      <ResponseMarkdown
        content={[
          "[Base README](/workspace/base/README.md)",
          "",
          "![Base clip](/workspace/base/demos/clip.mp4)",
        ].join("\n")}
        projectRoot="/workspace/worktrees/feature"
        projectBaseRoot="/workspace/base"
        projectId={PROJECT_ID}
        conversationId="22222222-2222-4222-8222-222222222222"
        defaultCodeWrap={false}
        onOpenProjectFile={onOpenProjectFile}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "Base README" }));
    expect(onOpenProjectFile).not.toHaveBeenCalled();
    expect(openProjectPath).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      relativePath: "README.md",
      action: "reveal",
    });

    const video = container.querySelector("video")!;
    fireEvent.error(video);
    expect(screen.queryByRole("button", { name: "Open in Files" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open externally" }));
    expect(openProjectPath).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      relativePath: "demos/clip.mp4",
      action: "open-externally",
    });
  });
});
