import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useSidebarIndexMotion } from "../../src/renderer/src/hooks/useSidebarIndexMotion";

function MotionHarness({
  active = true,
  enabled,
  order,
  visible = true,
}: {
  active?: boolean;
  enabled: boolean;
  order: string[];
  visible?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useSidebarIndexMotion({
    containerRef,
    enabled,
    layoutKey: order.join(":"),
  });
  return (
    <div
      className="app-shell"
      data-document-active={active}
      data-document-visible={visible}
    >
      <div ref={containerRef}>
        {order.map((identity) => (
          <div data-sidebar-motion-id={identity} key={identity}>{identity}</div>
        ))}
      </div>
    </div>
  );
}

function animationStub(): Animation {
  return {
    addEventListener: vi.fn(),
    cancel: vi.fn(),
  } as unknown as Animation;
}

function installAnimateStub() {
  const animate = vi.fn<HTMLElement["animate"]>(() => animationStub());
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });
  return animate;
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

describe("sidebar index position motion", () => {
  it("animates only retained rows that actually move", async () => {
    let viewportShift = 0;
    const getBounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getBounds(this: HTMLElement) {
        const top = viewportShift + (this.hasAttribute("data-sidebar-motion-id")
          ? [...(this.parentElement?.children ?? [])].indexOf(this) * 48
          : 0);
        return {
          bottom: top + 48,
          height: 48,
          left: 0,
          right: 240,
          top,
          width: 240,
          x: 0,
          y: top,
          toJSON: () => ({}),
        };
      });
    const animate = installAnimateStub();
    const view = render(
      <MotionHarness enabled order={["thread:alpha", "thread:beta"]} />,
    );
    await vi.dynamicImportSettled();
    expect(getBounds).toHaveBeenCalledTimes(3);
    expect(animate).not.toHaveBeenCalled();

    // A scrolled ancestor shifts both the stream and its rows in viewport
    // coordinates. Only the rows' movement within the stream should animate.
    viewportShift = -400;
    view.rerender(
      <MotionHarness enabled order={["thread:beta", "thread:alpha"]} />,
    );

    await vi.dynamicImportSettled();
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.calls[0]?.[0]).toEqual([
      { opacity: 0.86, transform: "translate(0px, 48px)" },
      { opacity: 1, transform: "translate(0, 0)" },
    ]);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({
      duration: expect.any(Number),
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    });
  });

  it.each([
    ["reduced motion", false, true],
    ["hidden document", true, false],
  ] as const)("does not animate for %s", async (_label, enabled, visible) => {
    const getBounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getBounds(this: HTMLElement) {
        const top = [...(this.parentElement?.children ?? [])].indexOf(this) * 48;
        return {
          bottom: top + 48,
          height: 48,
          left: 0,
          right: 240,
          top,
          width: 240,
          x: 0,
          y: top,
          toJSON: () => ({}),
        };
      });
    const animate = installAnimateStub();
    const view = render(
      <MotionHarness enabled={enabled} order={["a", "b"]} visible={visible} />,
    );
    if (enabled) {
      await vi.dynamicImportSettled();
      expect(getBounds).toHaveBeenCalledTimes(3);
    }

    view.rerender(
      <MotionHarness enabled={enabled} order={["b", "a"]} visible={visible} />,
    );
    if (enabled) {
      await vi.dynamicImportSettled();
      expect(getBounds).toHaveBeenCalledTimes(6);
    } else {
      await act(async () => undefined);
    }

    expect(animate).not.toHaveBeenCalled();
  });

  it("continues position motion while the visible document is unfocused", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getBounds(this: HTMLElement) {
        const top = [...(this.parentElement?.children ?? [])].indexOf(this) * 48;
        return {
          bottom: top + 48,
          height: 48,
          left: 0,
          right: 240,
          top,
          width: 240,
          x: 0,
          y: top,
          toJSON: () => ({}),
        };
      });
    const animate = installAnimateStub();
    const view = render(
      <MotionHarness active={false} enabled order={["a", "b"]} visible />,
    );
    await vi.dynamicImportSettled();
    expect(animate).not.toHaveBeenCalled();

    view.rerender(
      <MotionHarness active={false} enabled order={["b", "a"]} visible />,
    );
    await vi.dynamicImportSettled();
    expect(animate).toHaveBeenCalledTimes(2);
  });

  it("resynchronizes hidden layout changes before visible motion resumes", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getBounds(this: HTMLElement) {
        const top = [...(this.parentElement?.children ?? [])].indexOf(this) * 48;
        return {
          bottom: top + 48,
          height: 48,
          left: 0,
          right: 240,
          top,
          width: 240,
          x: 0,
          y: top,
          toJSON: () => ({}),
        };
      });
    const animate = installAnimateStub();
    const view = render(<MotionHarness enabled order={["a", "b"]} />);
    await vi.dynamicImportSettled();
    expect(animate).not.toHaveBeenCalled();

    view.rerender(<MotionHarness enabled order={["b", "a"]} visible={false} />);
    await vi.dynamicImportSettled();
    expect(animate).not.toHaveBeenCalled();

    view.rerender(<MotionHarness enabled order={["b", "a"]} visible />);
    await vi.dynamicImportSettled();
    expect(animate).not.toHaveBeenCalled();

    view.rerender(<MotionHarness enabled order={["a", "b"]} visible />);
    await vi.dynamicImportSettled();
    expect(animate).toHaveBeenCalledTimes(2);
  });

  it("cancels active position motion when reduced motion becomes active", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getBounds(this: HTMLElement) {
        const top = [...(this.parentElement?.children ?? [])].indexOf(this) * 48;
        return {
          bottom: top + 48,
          height: 48,
          left: 0,
          right: 240,
          top,
          width: 240,
          x: 0,
          y: top,
          toJSON: () => ({}),
        };
      });
    const animation = animationStub();
    const animate = installAnimateStub();
    animate.mockReturnValue(animation);
    const view = render(<MotionHarness enabled order={["a", "b"]} />);
    await vi.dynamicImportSettled();
    expect(animate).not.toHaveBeenCalled();
    view.rerender(<MotionHarness enabled order={["b", "a"]} />);
    await vi.dynamicImportSettled();
    expect(animate).toHaveBeenCalledTimes(2);

    view.rerender(<MotionHarness enabled={false} order={["b", "a"]} />);

    await vi.dynamicImportSettled();
    expect(animation.cancel).toHaveBeenCalledTimes(2);
  });
});
