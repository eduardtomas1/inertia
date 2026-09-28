import {
  COMPLETION_SOUND_LIBRARY_MAX,
  COMPLETION_SOUND_MAX_PLAY_SECONDS,
  isBuiltInCompletionSound,
  type BuiltInCompletionSound,
  type CompletionSoundSettings,
} from "@shared/completion-sound";

type Voice = (context: BaseAudioContext, output: AudioNode, start: number) => number;

const FADE_SECONDS = 0.25;
const OUTPUT_GAIN = 0.32;

function tone(
  context: BaseAudioContext,
  output: AudioNode,
  options: { frequency: number; start: number; attack?: number; decay: number; gain: number; type?: OscillatorType; detune?: number },
): number {
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  const attack = options.attack ?? 0.006;
  oscillator.type = options.type ?? "sine";
  oscillator.frequency.value = options.frequency;
  oscillator.detune.value = options.detune ?? 0;
  envelope.gain.setValueAtTime(0.0001, options.start);
  envelope.gain.exponentialRampToValueAtTime(options.gain, options.start + attack);
  envelope.gain.exponentialRampToValueAtTime(0.0001, options.start + attack + options.decay);
  oscillator.connect(envelope).connect(output);
  oscillator.start(options.start);
  const end = options.start + attack + options.decay + 0.02;
  oscillator.stop(end);
  return end;
}

export const COMPLETION_SOUND_VOICES: Readonly<Record<BuiltInCompletionSound, Voice>> = {
  chime: (context, output, start) => Math.max(
    tone(context, output, { frequency: 1046.5, start, decay: 0.9, gain: 0.55 }),
    tone(context, output, { frequency: 2093, start, decay: 0.45, gain: 0.12 }),
    tone(context, output, { frequency: 1568, start: start + 0.14, decay: 1.1, gain: 0.5 }),
    tone(context, output, { frequency: 3136, start: start + 0.14, decay: 0.5, gain: 0.1 }),
  ),
  glass: (context, output, start) => Math.max(
    tone(context, output, { frequency: 2093, start, decay: 1.2, gain: 0.35, type: "triangle", detune: -5 }),
    tone(context, output, { frequency: 2093, start, decay: 1.2, gain: 0.35, type: "triangle", detune: 5 }),
    tone(context, output, { frequency: 3520, start: start + 0.01, decay: 0.7, gain: 0.12 }),
  ),
  marimba: (context, output, start) => Math.max(
    ...[784, 987.8, 1174.7].flatMap((frequency, index) => [
      tone(context, output, { frequency, start: start + index * 0.12, decay: 0.8, gain: 0.5 }),
      tone(context, output, { frequency: frequency * 4, start: start + index * 0.12, decay: 0.08, gain: 0.08 }),
    ]),
  ),
  bloom: (context, output, start) => {
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2400;
    filter.connect(output);
    return Math.max(...[523.3, 659.3, 784, 1046.5].map((frequency, index) => tone(context, filter, {
      frequency, start: start + index * 0.05, attack: 0.22, decay: 1.5, gain: 0.22,
    })));
  },
  pop: (context, output, start) => {
    const bubble = (at: number, from: number, to: number): number => {
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.frequency.setValueAtTime(from, at);
      oscillator.frequency.exponentialRampToValueAtTime(to, at + 0.07);
      envelope.gain.setValueAtTime(0.0001, at);
      envelope.gain.exponentialRampToValueAtTime(0.6, at + 0.008);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      oscillator.connect(envelope).connect(output);
      oscillator.start(at);
      oscillator.stop(at + 0.18);
      return at + 0.18;
    };
    return Math.max(
      bubble(start, 420, 880),
      bubble(start + 0.12, 560, 1180),
      tone(context, output, { frequency: 1318.5, start: start + 0.26, decay: 0.72, gain: 0.18 }),
    );
  },
  bell: (context, output, start) => {
    const carrier = context.createOscillator();
    const modulator = context.createOscillator();
    const depth = context.createGain();
    const envelope = context.createGain();
    carrier.frequency.value = 880;
    modulator.frequency.value = 880 * 1.4;
    depth.gain.setValueAtTime(900, start);
    depth.gain.exponentialRampToValueAtTime(1, start + 1.6);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(0.45, start + 0.005);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + 2.2);
    modulator.connect(depth).connect(carrier.frequency);
    carrier.connect(envelope).connect(output);
    modulator.start(start);
    carrier.start(start);
    modulator.stop(start + 2.25);
    carrier.stop(start + 2.25);
    return start + 2.25;
  },
};

let sharedContext: AudioContext | null = null;
const customCache = new Map<string, Promise<AudioBuffer | null>>();
let current: GainNode | null = null;

function audioContext(): AudioContext | null {
  if (sharedContext) return sharedContext;
  if (typeof AudioContext === "undefined") return null;
  sharedContext = new AudioContext();
  return sharedContext;
}

export function decodeCustomCompletionSound(file: string, context = audioContext()): Promise<AudioBuffer | null> {
  const cached = customCache.get(file);
  if (cached) return cached;
  const buffer = (async () => {
    if (!context) return null;
    const bytes = await window.inertia?.readCompletionSound?.(file);
    if (!bytes?.byteLength) return null;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return await context.decodeAudioData(copy.buffer);
  })().catch(() => null);
  customCache.set(file, buffer);
  while (customCache.size > COMPLETION_SOUND_LIBRARY_MAX) customCache.delete(customCache.keys().next().value!);
  return buffer;
}

export function forgetCustomCompletionSound(file: string): void {
  customCache.delete(file);
}

export async function playCompletionSound(settings: Pick<CompletionSoundSettings, "sound" | "library">): Promise<boolean> {
  const context = audioContext();
  if (!context) return false;
  if (context.state === "suspended") await context.resume().catch(() => undefined);
  const builtIn = isBuiltInCompletionSound(settings.sound);
  const custom = !builtIn && settings.library.some(({ file }) => file === settings.sound)
    ? await decodeCustomCompletionSound(settings.sound, context)
    : null;
  if (current) {
    const fading = current;
    fading.gain.setTargetAtTime(0, context.currentTime, 0.03);
    setTimeout(() => fading.disconnect(), 200);
  }
  const output = context.createGain();
  output.gain.value = OUTPUT_GAIN;
  output.connect(context.destination);
  current = output;
  const start = context.currentTime + 0.02;
  if (custom) {
    const source = context.createBufferSource();
    source.buffer = custom;
    source.connect(output);
    const length = Math.min(custom.duration, COMPLETION_SOUND_MAX_PLAY_SECONDS);
    if (custom.duration > COMPLETION_SOUND_MAX_PLAY_SECONDS) {
      output.gain.setValueAtTime(OUTPUT_GAIN, start + length - FADE_SECONDS);
      output.gain.linearRampToValueAtTime(0, start + length);
    }
    source.start(start, 0, length);
    source.onended = () => { if (current === output) current = null; output.disconnect(); };
    return true;
  }
  const voice = COMPLETION_SOUND_VOICES[isBuiltInCompletionSound(settings.sound) ? settings.sound : "chime"];
  const end = voice(context, output, start);
  setTimeout(() => { if (current === output) current = null; output.disconnect(); }, Math.ceil((end - context.currentTime) * 1000) + 100);
  return builtIn;
}
