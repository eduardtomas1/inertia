import { render } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";

import { useTextareaAutosize } from "../../src/renderer/src/components/composer/useTextareaAutosize";

function Field({ content }: { content: string }): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  useTextareaAutosize(ref, content);
  return <textarea ref={ref} aria-label="Message" defaultValue={content} />;
}

function renderWithScrollHeight(scrollHeight: number): HTMLTextAreaElement {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => scrollHeight });
  try {
    const { getByRole } = render(<Field content={"line\n".repeat(20)} />);
    return getByRole("textbox") as HTMLTextAreaElement;
  } finally {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, "scrollHeight", descriptor);
  }
}

describe("composer textarea autosize", () => {
  it("grows with its content up to 200px and then scrolls", () => {
    const tall = renderWithScrollHeight(260);
    expect(tall.style.height).toBe("200px");
    expect(tall.style.overflowY).toBe("auto");
  });

  it("fits shorter content without a scrollbar", () => {
    const short = renderWithScrollHeight(190);
    expect(short.style.height).toBe("190px");
    expect(short.style.overflowY).toBe("hidden");
  });
});
