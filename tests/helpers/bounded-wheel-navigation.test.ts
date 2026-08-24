import { describe, expect, it, vi } from "vitest";

import { driveBoundedWheelNavigation } from "./bounded-wheel-navigation";

function scrollReader(
  positions: readonly number[],
  itemIndexes: readonly number[] = positions.map((position) => Math.floor(position / 1_000)),
  itemOffsets: readonly number[] = positions.map((position) => -(position % 1_000)),
  itemIds: readonly string[] = itemIndexes.map((itemIndex) => `turn-${itemIndex}`),
  scrollHeights: readonly number[] = positions.map(() => 300_000),
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
      scrollHeight: scrollHeights[Math.min(sample, scrollHeights.length - 1)]!,
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
      "Wheel gesture 1 made no upward progress: logical position ended at turn-8 (item 8, offset -665) while tracked turn-8 ended at -665 from item 8 offset -665 (scrollTop 8665 from 8665; scrollHeight 300000 from 300000).",
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
      "Wheel gesture 1 made no upward progress: logical position ended at turn-8 (item 8, offset -665) while tracked turn-8 ended at -665 from item 8 offset -665 (scrollTop 7500 from 8665; scrollHeight 300000 from 300000).",
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
      "Wheel gesture 1 made no upward progress: logical position ended at stream-turn (item 300, offset -280) while tracked stream-turn ended at -280 from item 299 offset -280 (scrollTop 159600 from 159147; scrollHeight 300000 from 300000).",
    );
    expect(wheelUp).toHaveBeenCalledTimes(1);
  });

  it("spends another bounded gesture when stream growth counteracts the first wheel", async () => {
    const wheelUp = vi.fn(async () => undefined);

    await expect(driveBoundedWheelNavigation({
      maxGestures: 3,
      maxProgressSamples: 1,
      readPosition: scrollReader(
        [160_620, 161_060, 0],
        [301, 301, 0],
        [-201, -641, 0],
        ["stream-turn", "stream-turn", "turn-0"],
        [162_000, 162_440, 162_440],
      ),
      targetScrollTop: 120,
      waitForNextSample: async () => undefined,
      wheelUp,
    })).resolves.toEqual({ gestures: 2, scrollTop: 0 });
    expect(wheelUp).toHaveBeenCalledTimes(2);
  });

  it("rejects counter-motion when the document height shrinks", async () => {
    const wheelUp = vi.fn(async () => undefined);

    await expect(driveBoundedWheelNavigation({
      maxGestures: 3,
      maxProgressSamples: 1,
      readPosition: scrollReader(
        [160_620, 161_060],
        [301, 301],
        [-201, -641],
        ["stream-turn", "stream-turn"],
        [162_440, 162_000],
      ),
      targetScrollTop: 120,
      waitForNextSample: async () => undefined,
      wheelUp,
    })).rejects.toThrow(
      "Wheel gesture 1 made no upward progress: logical position ended at stream-turn (item 301, offset -641) while tracked stream-turn ended at -641 from item 301 offset -201 (scrollTop 161060 from 160620; scrollHeight 162000 from 162440).",
    );
    expect(wheelUp).toHaveBeenCalledTimes(1);
  });

  it("rejects the hosted ARM counter-motion signature at equal height", async () => {
    const wheelUp = vi.fn(async () => undefined);

    await expect(driveBoundedWheelNavigation({
      maxGestures: 3,
      maxProgressSamples: 1,
      readPosition: scrollReader(
        [160_620, 161_060],
        [301, 301],
        [-201, -641],
        ["stream-turn", "stream-turn"],
        [162_000, 162_000],
      ),
      targetScrollTop: 120,
      waitForNextSample: async () => undefined,
      wheelUp,
    })).rejects.toThrow(
      "Wheel gesture 1 made no upward progress: logical position ended at stream-turn (item 301, offset -641) while tracked stream-turn ended at -641 from item 301 offset -201 (scrollTop 161060 from 160620; scrollHeight 162000 from 162000).",
    );
    expect(wheelUp).toHaveBeenCalledTimes(1);
  });

  it("does not carry a growth allowance into the next flat gesture", async () => {
    const wheelUp = vi.fn(async () => undefined);

    await expect(driveBoundedWheelNavigation({
      maxGestures: 3,
      maxProgressSamples: 1,
      readPosition: scrollReader(
        [160_620, 161_060, 161_500],
        [301, 301, 301],
        [-201, -641, -1_081],
        ["stream-turn", "stream-turn", "stream-turn"],
        [162_000, 162_440, 162_440],
      ),
      targetScrollTop: 120,
      waitForNextSample: async () => undefined,
      wheelUp,
    })).rejects.toThrow(
      "Wheel gesture 2 made no upward progress: logical position ended at stream-turn (item 301, offset -1081) while tracked stream-turn ended at -1081 from item 301 offset -641 (scrollTop 161500 from 161060; scrollHeight 162440 from 162440).",
    );
    expect(wheelUp).toHaveBeenCalledTimes(2);
  });

  it("does not exceed a one-gesture cap when the document grows", async () => {
    const wheelUp = vi.fn(async () => undefined);

    await expect(driveBoundedWheelNavigation({
      maxGestures: 1,
      maxProgressSamples: 1,
      readPosition: scrollReader(
        [160_620, 161_060],
        [301, 301],
        [-201, -641],
        ["stream-turn", "stream-turn"],
        [162_000, 162_440],
      ),
      targetScrollTop: 120,
      waitForNextSample: async () => undefined,
      wheelUp,
    })).rejects.toThrow(
      "Reader navigation exhausted 1 wheel gestures at scrollTop 161060; expected less than 120.",
    );
    expect(wheelUp).toHaveBeenCalledTimes(1);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid scrollHeight %s before navigation",
    async (scrollHeight) => {
      const wheelUp = vi.fn(async () => undefined);

      await expect(driveBoundedWheelNavigation({
        maxGestures: 3,
        maxProgressSamples: 1,
        readPosition: scrollReader(
          [160_620],
          [301],
          [-201],
          ["stream-turn"],
          [scrollHeight],
        ),
        targetScrollTop: 120,
        waitForNextSample: async () => undefined,
        wheelUp,
      })).rejects.toThrow(
        `The initial reader position returned invalid scrollHeight ${String(scrollHeight)}.`,
      );
      expect(wheelUp).not.toHaveBeenCalled();
    },
  );

  it("keeps growing counter-motion inside the strict gesture cap", async () => {
    const wheelUp = vi.fn(async () => undefined);

    await expect(driveBoundedWheelNavigation({
      maxGestures: 3,
      maxProgressSamples: 1,
      readPosition: scrollReader(
        [160_620, 161_060, 161_500, 161_940],
        [301, 301, 301, 301],
        [-201, -641, -1_081, -1_521],
        ["stream-turn", "stream-turn", "stream-turn", "stream-turn"],
        [162_000, 162_440, 162_880, 163_320],
      ),
      targetScrollTop: 120,
      waitForNextSample: async () => undefined,
      wheelUp,
    })).rejects.toThrow(
      "Reader navigation exhausted 3 wheel gestures at scrollTop 161940; expected less than 120.",
    );
    expect(wheelUp).toHaveBeenCalledTimes(3);
  });
});
