import { afterEach, describe, expect, it, vi } from "vitest";

import { modelChooserContentGeometry } from "../support/model-chooser-placement";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("model chooser content evidence", () => {
  it("does not compare bounds from different composer positions", async () => {
    document.body.innerHTML = '<div role="dialog"><ul aria-label="Model results"></ul></div>';
    const chooser = document.querySelector("div")!;
    const list = chooser.querySelector("ul")!;
    let offset = 0;
    vi.spyOn(chooser, "getBoundingClientRect").mockImplementation(() =>
      new DOMRect(0, 300 + offset, 450, 300));
    vi.spyOn(list, "getBoundingClientRect").mockImplementation(() =>
      new DOMRect(50, 345 + offset, 400, 254));

    const oldFrame = chooser.getBoundingClientRect();
    // A snapshot repositions the composer between independent CDP requests.
    await Promise.resolve().then(() => { offset = -68.40625; });
    expect(Math.abs(oldFrame.bottom - list.getBoundingClientRect().bottom)).toBe(69.40625);

    expect(modelChooserContentGeometry(chooser)).toEqual({ frameHeight: 300, bottomGap: 1 });
    offset = 40;
    expect(modelChooserContentGeometry(chooser)).toEqual({ frameHeight: 300, bottomGap: 1 });

    // A real blank area remains visible to the same 2px geometry assertion.
    vi.spyOn(list, "getBoundingClientRect").mockImplementation(() =>
      new DOMRect(50, 345 + offset, 400, 185.59375));
    expect(modelChooserContentGeometry(chooser).bottomGap).toBe(69.40625);
    expect(modelChooserContentGeometry(chooser).bottomGap).toBeGreaterThan(2);
  });
});
