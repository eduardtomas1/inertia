import { describe, expect, it } from "vitest";
import {
  modelChooserPlacementChecks,
  type ModelChooserPlacementGeometry,
} from "../support/model-chooser-placement";

function geometry(vertical: "above" | "below", fitDifference = 0): ModelChooserPlacementGeometry {
  const height = 242.625;
  const anchor = { top: 622.375, bottom: 652.375 };
  const top = vertical === "below" ? anchor.bottom + 8 : anchor.top - 8 - height;
  return {
    frame: { top, bottom: top + height, height },
    anchor,
    workspace: { top: 67, bottom: anchor.bottom + 16 + height + fitDifference },
    viewportHeight: 920,
    vertical,
  };
}

describe("model chooser placement evidence", () => {
  it("accepts the correctly anchored fractional-zoom frame that reproduced the CI assertion", () => {
    expect(modelChooserPlacementChecks({
      frame: { top: 181.70834350585938, bottom: 378.66668701171875, height: 196.95834350585938 },
      anchor: { top: 143.70834350585938, bottom: 173.70834350585938 },
      workspace: { top: 66.66667175292969, bottom: 386.6666717529297 },
      viewportHeight: 614,
      vertical: "below",
    })).toEqual({ correctSide: true, anchored: true, insideWorkspace: true });
  });

  it.each(["above", "below"] as const)("allows %s only at the numerical fit boundary", (vertical) => {
    for (const difference of [-0.00001525878906, 0, 0.00001525878906]) {
      expect(modelChooserPlacementChecks(geometry(vertical, difference)))
        .toEqual({ correctSide: true, anchored: true, insideWorkspace: true });
    }
  });

  it.each([
    { difference: -0.5, vertical: "above", correct: true },
    { difference: -0.5, vertical: "below", correct: false },
    { difference: 0.5, vertical: "above", correct: false },
    { difference: 0.5, vertical: "below", correct: true },
  ] as const)("requires the actual fit side at $difference CSS px ($vertical)", ({ difference, vertical, correct }) => {
    expect(modelChooserPlacementChecks(geometry(vertical, difference)).correctSide).toBe(correct);
  });

  it.each(["above", "below"] as const)("still rejects an unanchored %s frame at the fit boundary", (vertical) => {
    const sample = geometry(vertical);
    sample.frame.top = sample.anchor.top;
    sample.frame.bottom = sample.frame.top + sample.frame.height;
    expect(modelChooserPlacementChecks(sample).anchored).toBe(false);
  });

  it("still rejects a frame crossing its workspace boundary", () => {
    const sample = geometry("above");
    sample.frame.top = sample.workspace.top;
    expect(modelChooserPlacementChecks(sample).insideWorkspace).toBe(false);
  });
});
