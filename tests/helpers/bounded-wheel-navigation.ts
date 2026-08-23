interface BoundedWheelNavigationOptions {
  maxGestures: number;
  maxProgressSamples: number;
  readScrollTop: () => Promise<number>;
  targetScrollTop: number;
  waitForNextSample: () => Promise<void>;
  wheelUp: () => Promise<void>;
}

interface BoundedWheelNavigationResult {
  gestures: number;
  scrollTop: number;
}

function requireScrollTop(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} returned invalid scrollTop ${String(value)}.`);
  }
  return value;
}

export async function driveBoundedWheelNavigation(
  options: BoundedWheelNavigationOptions,
): Promise<BoundedWheelNavigationResult> {
  let scrollTop = requireScrollTop(
    await options.readScrollTop(),
    "The initial reader position",
  );
  if (scrollTop < options.targetScrollTop) {
    throw new Error(
      `Reader navigation started at scrollTop ${scrollTop}; expected at least ${options.targetScrollTop} before a real wheel gesture.`,
    );
  }

  for (let gesture = 1; gesture <= options.maxGestures; gesture += 1) {
    const previousScrollTop = scrollTop;
    await options.wheelUp();

    for (let sample = 0; sample < options.maxProgressSamples; sample += 1) {
      scrollTop = requireScrollTop(
        await options.readScrollTop(),
        `Reader position after wheel gesture ${gesture}`,
      );
      if (scrollTop < previousScrollTop) break;
      if (sample + 1 < options.maxProgressSamples) {
        await options.waitForNextSample();
      }
    }

    if (scrollTop >= previousScrollTop) {
      throw new Error(
        `Wheel gesture ${gesture} made no upward progress: scrollTop remained ${scrollTop} from ${previousScrollTop}.`,
      );
    }
    if (scrollTop < options.targetScrollTop) {
      return { gestures: gesture, scrollTop };
    }
  }

  throw new Error(
    `Reader navigation exhausted ${options.maxGestures} wheel gestures at scrollTop ${scrollTop}; expected less than ${options.targetScrollTop}.`,
  );
}
