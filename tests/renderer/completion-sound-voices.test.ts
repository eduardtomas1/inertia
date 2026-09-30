import { describe, expect, it } from "vitest";

import { BUILT_IN_COMPLETION_SOUNDS } from "../../src/shared/completion-sound";
import { COMPLETION_SOUND_VOICES } from "../../src/renderer/src/utils/completionSoundPlayer";

function fakeContext() {
  const stops: number[] = [];
  const param = () => ({
    value: 0,
    setValueAtTime() { return this; },
    exponentialRampToValueAtTime() { return this; },
    linearRampToValueAtTime() { return this; },
  });
  const node = () => ({ connect: (target: unknown) => target });
  const context = {
    createOscillator: () => ({
      ...node(),
      type: "sine",
      frequency: param(),
      detune: param(),
      start() {},
      stop(at: number) { stops.push(at); },
    }),
    createGain: () => ({ ...node(), gain: param() }),
    createBiquadFilter: () => ({ ...node(), type: "lowpass", frequency: param() }),
  };
  return { context: context as unknown as BaseAudioContext, stops };
}

describe("built-in completion sounds", () => {
  it.each(BUILT_IN_COMPLETION_SOUNDS)("%s lasts between 1 and 3 seconds and reports its true end", (sound) => {
    const { context, stops } = fakeContext();
    const start = 10;
    const end = COMPLETION_SOUND_VOICES[sound](context, {} as AudioNode, start);
    expect(stops.length).toBeGreaterThan(0);
    expect(end).toBe(Math.max(...stops));
    expect(end - start).toBeGreaterThanOrEqual(1);
    expect(end - start).toBeLessThanOrEqual(3);
  });
});
