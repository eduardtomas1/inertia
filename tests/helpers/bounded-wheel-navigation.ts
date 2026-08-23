interface BoundedWheelNavigationOptions {
  maxGestures: number;
  maxProgressSamples: number;
  readPosition: () => Promise<BoundedWheelPosition>;
  targetScrollTop: number;
  waitForNextSample: () => Promise<void>;
  wheelUp: () => Promise<void>;
}

interface BoundedWheelPosition {
  itemIndex: number;
  itemOffset: number;
  scrollTop: number;
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
  if (!Number.isInteger(value.itemIndex) || value.itemIndex < 0) {
    throw new Error(`${label} returned invalid itemIndex ${String(value.itemIndex)}.`);
  }
  if (!Number.isFinite(value.itemOffset)) {
    throw new Error(`${label} returned invalid itemOffset ${String(value.itemOffset)}.`);
  }
  return value;
}

function madeUpwardProgress(
  previous: BoundedWheelPosition,
  current: BoundedWheelPosition,
): boolean {
  // A streaming row can grow while the virtualizer preserves the same logical
  // viewport anchor, which may raise absolute scrollTop. Moving to an earlier
  // row, or exposing more of the same row, is the stable reader-owned signal.
  return current.itemIndex < previous.itemIndex
    || (
      current.itemIndex === previous.itemIndex
      && current.itemOffset > previous.itemOffset
    );
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
        await options.readPosition(),
        `Reader position after wheel gesture ${gesture}`,
      );
      if (madeUpwardProgress(previousPosition, position)) break;
      if (sample + 1 < options.maxProgressSamples) {
        await options.waitForNextSample();
      }
    }

    if (!madeUpwardProgress(previousPosition, position)) {
      throw new Error(
        `Wheel gesture ${gesture} made no upward progress: logical position ended at item ${position.itemIndex} offset ${position.itemOffset} from item ${previousPosition.itemIndex} offset ${previousPosition.itemOffset} (scrollTop ${position.scrollTop} from ${previousPosition.scrollTop}).`,
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
