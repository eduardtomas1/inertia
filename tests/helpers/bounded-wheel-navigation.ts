interface BoundedWheelNavigationOptions {
  maxGestures: number;
  maxProgressSamples: number;
  readPosition: (trackedItemId?: string) => Promise<BoundedWheelPosition>;
  targetScrollTop: number;
  waitForNextSample: () => Promise<void>;
  wheelUp: () => Promise<void>;
}

interface BoundedWheelPosition {
  itemId: string;
  itemIndex: number;
  itemOffset: number;
  scrollHeight: number;
  scrollTop: number;
  trackedItemOffset: number | null;
}

interface BoundedWheelNavigationResult {
  gestures: number;
  scrollTop: number;
}

function requirePosition(
  value: BoundedWheelPosition,
  label: string,
): BoundedWheelPosition {
  if (!Number.isFinite(value.scrollTop) || value.scrollTop < 0) {
    throw new Error(`${label} returned invalid scrollTop ${String(value.scrollTop)}.`);
  }
  if (!Number.isFinite(value.scrollHeight) || value.scrollHeight < 0) {
    throw new Error(`${label} returned invalid scrollHeight ${String(value.scrollHeight)}.`);
  }
  if (value.itemId.length === 0) {
    throw new Error(`${label} returned an empty itemId.`);
  }
  if (!Number.isInteger(value.itemIndex) || value.itemIndex < 0) {
    throw new Error(`${label} returned invalid itemIndex ${String(value.itemIndex)}.`);
  }
  if (!Number.isFinite(value.itemOffset)) {
    throw new Error(`${label} returned invalid itemOffset ${String(value.itemOffset)}.`);
  }
  if (
    value.trackedItemOffset !== null
    && !Number.isFinite(value.trackedItemOffset)
  ) {
    throw new Error(
      `${label} returned invalid trackedItemOffset ${String(value.trackedItemOffset)}.`,
    );
  }
  return value;
}

function madeUpwardProgress(
  previous: BoundedWheelPosition,
  current: BoundedWheelPosition,
): boolean {
  // Virtual indices can shift while streamed rows are inserted or reconciled.
  // Follow the exact prior row instead: exposing more of that stable row is
  // reader-owned progress even when measurement raises absolute scrollTop.
  if (current.trackedItemOffset !== null) {
    return current.trackedItemOffset > previous.itemOffset;
  }
  // Once the prior row is unmounted, only an independently lower native scroll
  // coordinate proves progress. A shifted virtual index is diagnostic only.
  return current.scrollTop < previous.scrollTop;
}

export async function driveBoundedWheelNavigation(
  options: BoundedWheelNavigationOptions,
): Promise<BoundedWheelNavigationResult> {
  let position = requirePosition(
    await options.readPosition(),
    "The initial reader position",
  );
  if (position.scrollTop < options.targetScrollTop) {
    throw new Error(
      `Reader navigation started at scrollTop ${position.scrollTop}; expected at least ${options.targetScrollTop} before a real wheel gesture.`,
    );
  }

  for (let gesture = 1; gesture <= options.maxGestures; gesture += 1) {
    const previousPosition = position;
    await options.wheelUp();

    for (let sample = 0; sample < options.maxProgressSamples; sample += 1) {
      position = requirePosition(
        await options.readPosition(previousPosition.itemId),
        `Reader position after wheel gesture ${gesture}`,
      );
      if (madeUpwardProgress(previousPosition, position)) break;
      if (sample + 1 < options.maxProgressSamples) {
        await options.waitForNextSample();
      }
    }

    if (!madeUpwardProgress(previousPosition, position)) {
      // Streaming can grow the document by more than the wheel delta and move
      // the stable reader row up/out even though Chromium accepted the gesture.
      // Growth is not success: it only spends the next already-bounded gesture.
      if (position.scrollHeight > previousPosition.scrollHeight) continue;
      throw new Error(
        `Wheel gesture ${gesture} made no upward progress: logical position ended at ${position.itemId} (item ${position.itemIndex}, offset ${position.itemOffset}) while tracked ${previousPosition.itemId} ended at ${String(position.trackedItemOffset)} from item ${previousPosition.itemIndex} offset ${previousPosition.itemOffset} (scrollTop ${position.scrollTop} from ${previousPosition.scrollTop}; scrollHeight ${position.scrollHeight} from ${previousPosition.scrollHeight}).`,
      );
    }
    if (position.scrollTop < options.targetScrollTop) {
      return { gestures: gesture, scrollTop: position.scrollTop };
    }
  }

  throw new Error(
    `Reader navigation exhausted ${options.maxGestures} wheel gestures at scrollTop ${position.scrollTop}; expected less than ${options.targetScrollTop}.`,
  );
}
