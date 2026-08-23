import { describe, expect, it, vi } from "vitest";

import { driveBoundedWheelNavigation } from "./bounded-wheel-navigation";

function scrollReader(
  positions: readonly number[],
  itemIndexes: readonly number[] = positions.map((position) => Math.floor(position / 1_000)),
  itemOffsets: readonly number[] = positions.map((position) => -(position % 1_000)),
  itemIds: readonly string[] = itemIndexes.map((itemIndex) => `turn-${itemIndex}`),
) {
  let index = 0;
  return vi.fn(async (trackedItemId?: string) => {
    const sample = Math.min(index++, positions.length - 1);
    const itemId = itemIds[Math.min(sample, itemIds.length - 1)]!;
    const itemOffset = itemOffsets[Math.min(sample, itemOffsets.length - 1)]!;
    return {
      itemId,
      itemIndex: itemIndexes[Math.min(sample, itemIndexes.length - 1)]!,
      itemOffset,
      scrollTop: positions[sample]!,
      trackedItemOffset: trackedItemId === undefined || trackedItemId === itemId
        ? itemOffset
        : null,
    };
  });
}

describe("bounded real-wheel navigation", () => {
  it("rejects a fixture that starts at the target without a real wheel gesture", async () => {
    const wheelUp = vi.fn(async () => undefined);

    await expect(driveBoundedWheelNavigation({
      maxGestures: 16,
      maxProgressSamples: 3,
      readPosition: scrollReader([119]),
      targetScrollTop: 120,
      waitForNextSample: async () => undefined,
      wheelUp,
    })).rejects.toThrow(
      "Reader navigation started at scrollTop 119; expected at least 120 before a real wheel gesture.",
    );
    expect(wheelUp).not.toHaveBeenCalled();
  });

  it("continues past the former fixed eight gestures until the reader reaches the top", async () => {
    const readPosition = scrollReader([
      248_665,
      218_665,
      188_665,
      158_665,
      128_665,
      98_665,
      68_665,
      38_665,
      8_665,
      0,
    ]);
    const wheelUp = vi.fn(async () => undefined);

    await expect(driveBoundedWheelNavigation({
      maxGestures: 16,
      maxProgressSamples: 3,
      readPosition,
      targetScrollTop: 120,
      waitForNextSample: async () => undefined,
      wheelUp,
    })).resolves.toEqual({ gestures: 9, scrollTop: 0 });
    expect(wheelUp).toHaveBeenCalledTimes(9);
  });

  it("waits for delayed progress before sending another wheel gesture", async () => {
    const waitForNextSample = vi.fn(async () => undefined);
    const wheelUp = vi.fn(async () => undefined);

    await expect(driveBoundedWheelNavigation({
      maxGestures: 16,
      maxProgressSamples: 3,
      readPosition: scrollReader([1_000, 1_000, 700, 0]),
      targetScrollTop: 120,
      waitForNextSample,
      wheelUp,
    })).resolves.toEqual({ gestures: 2, scrollTop: 0 });
    expect(waitForNextSample).toHaveBeenCalledTimes(1);
    expect(wheelUp).toHaveBeenCalledTimes(2);
  });

  it("fails immediately when a real wheel gesture makes no measurable progress", async () => {
    const wheelUp = vi.fn(async () => undefined);

    await expect(driveBoundedWheelNavigation({
      maxGestures: 16,
      maxProgressSamples: 3,
      readPosition: scrollReader([8_665, 8_665, 8_665, 8_665]),
      targetScrollTop: 120,
      waitForNextSample: async () => undefined,
      wheelUp,
    })).rejects.toThrow(
      "Wheel gesture 1 made no upward progress: logical position ended at turn-8 (item 8, offset -665) while tracked turn-8 ended at -665 from item 8 offset -665 (scrollTop 8665 from 8665).",
    );
    expect(wheelUp).toHaveBeenCalledTimes(1);
  });

  it("fails at the strict gesture cap even when every gesture makes progress", async () => {
    const wheelUp = vi.fn(async () => undefined);

    await expect(driveBoundedWheelNavigation({
      maxGestures: 3,
      maxProgressSamples: 2,
      readPosition: scrollReader([1_000, 900, 800, 700]),
      targetScrollTop: 120,
      waitForNextSample: async () => undefined,
      wheelUp,
    })).rejects.toThrow(
      "Reader navigation exhausted 3 wheel gestures at scrollTop 700; expected less than 120.",
    );
    expect(wheelUp).toHaveBeenCalledTimes(3);
  });

  it("accepts logical upward progress while a streamed row raises absolute scrollTop", async () => {
    const wheelUp = vi.fn(async () => undefined);

    await expect(driveBoundedWheelNavigation({
      maxGestures: 3,
      maxProgressSamples: 2,
      readPosition: scrollReader(
        [159_147, 159_434, 80_164, 0],
        [299, 300, 80, 0],
        [-280, -61, -164, 0],
        ["stream-turn", "stream-turn", "turn-80", "turn-0"],
      ),
      targetScrollTop: 120,
      waitForNextSample: async () => undefined,
      wheelUp,
    })).resolves.toEqual({ gestures: 3, scrollTop: 0 });
    expect(wheelUp).toHaveBeenCalledTimes(3);
  });

  it("rejects an absolute decrease when the logical reader anchor did not move", async () => {
    const wheelUp = vi.fn(async () => undefined);

    await expect(driveBoundedWheelNavigation({
      maxGestures: 3,
      maxProgressSamples: 2,
      readPosition: scrollReader(
        [8_665, 8_000, 7_500],
        [8, 8, 8],
        [-665, -665, -665],
      ),
      targetScrollTop: 120,
      waitForNextSample: async () => undefined,
      wheelUp,
    })).rejects.toThrow(
      "Wheel gesture 1 made no upward progress: logical position ended at turn-8 (item 8, offset -665) while tracked turn-8 ended at -665 from item 8 offset -665 (scrollTop 7500 from 8665).",
    );
    expect(wheelUp).toHaveBeenCalledTimes(1);
  });

  it("rejects a shifted virtual index when the stable reader row did not move", async () => {
    const wheelUp = vi.fn(async () => undefined);

    await expect(driveBoundedWheelNavigation({
      maxGestures: 3,
      maxProgressSamples: 2,
      readPosition: scrollReader(
        [159_147, 159_434, 159_600],
        [299, 300, 300],
        [-280, -280, -280],
        ["stream-turn", "stream-turn", "stream-turn"],
      ),
      targetScrollTop: 120,
      waitForNextSample: async () => undefined,
      wheelUp,
    })).rejects.toThrow(
      "Wheel gesture 1 made no upward progress: logical position ended at stream-turn (item 300, offset -280) while tracked stream-turn ended at -280 from item 299 offset -280 (scrollTop 159600 from 159147).",
    );
    expect(wheelUp).toHaveBeenCalledTimes(1);
  });
});
