import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ResponseMarkdown } from "../../src/renderer/src/components/ResponseMarkdown";

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

beforeEach(() => {
  markdownRenders.count = 0;
});

describe("ResponseMarkdown parse reuse", () => {
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
