# Performance evidence

## Screen opens: preloaded screens render without the Suspense delay (PW3)

React 19 holds back a lazy component for up to 300 ms after its Suspense fallback appears, and `React.lazy` suspends on its first render even when the code has already been fetched. Usage, the Usage Limits tab, the Limits dialog, Daily work, Tasks, the terminal dock and the model chooser's source list now render through `useLoadedSurface` (the hook Settings and the command palette already use), and the idle prefetch loads their code. A chunk that fails to load still reaches the window error boundary.

Measured with `INERTIA_SCREEN_OPEN_RUNS=5 npx playwright test --config playwright.screens.config.ts --max-failures=1` on an Apple M5 Pro (macOS 27), production build, input to the painted, settled screen. Before is `perf/faster-app-2026-10` at 3f3a0e701; after is the same harness on this change.

| Screen | Phase | Before median / p95 (ms) | After median / p95 (ms) | N | Load (1 min) before / after |
| --- | --- | ---: | ---: | ---: | --- |
| usage | cold | 338.9 / 339.3 | 31.3 / 39.2 | 5 | 1.6-2.5 / 2.2-2.8 |
| usage | warm | 30.2 / 38.5 | 30.6 / 36.3 | 5 | 1.6-2.5 / 2.2-2.8 |
| usage-limits-tab | cold | 314.2 / 323.8 | 14.2 / 15.7 | 5 | 1.6-2.5 / 2.2-2.8 |
| usage-limits-tab | warm | 13.6 / 14.7 | 14.4 / 14.8 | 5 | 1.6-2.5 / 2.2-2.8 |
| limits-dialog | cold | 339 / 339.3 | 30 / 36.2 | 5 | 1.6-2.5 / 2.2-2.8 |
| limits-dialog | warm | 30.5 / 31.3 | 30.7 / 36.2 | 5 | 1.6-2.5 / 2.2-2.8 |
| daily-work | cold | 338.5 / 339.1 | 37.6 / 39.1 | 5 | 1.6-2.5 / 2.2-2.8 |
| daily-work | warm | 31.1 / 32.1 | 31.6 / 37.7 | 5 | 1.6-2.5 / 2.2-2.8 |
| tasks | cold | 322 / 322.7 | 31.2 / 142.9 | 5 | 1.6-2.5 / 2.2-2.8 |
| tasks | warm | 30 / 30.9 | 31.3 / 36 | 5 | 1.6-2.5 / 2.2-2.8 |
| terminal | cold | 355.2 / 356 | 54.5 / 55.4 | 5 | 1.6-2.5 / 2.2-2.8 |
| terminal | warm | 39.5 / 46.9 | 39.6 / 47.7 | 5 | 1.6-2.5 / 2.2-2.8 |
| model-chooser | cold | 314.7 / 323 | 31 / 31.3 | 5 | 1.6-2.5 / 2.2-2.8 |
| model-chooser | warm | 29.7 / 31 | 31.3 / 32.2 | 5 | 1.6-2.5 / 2.2-2.8 |

The one slow Tasks sample (142.9 ms) had its content at 14.8 ms and a late paint; the baseline Settings row shows the same kind of single late paint (310 ms p95) without this change.

## Screen opens: detached chat window transcript (PW3)

A Chromium trace of the detached window on the baseline showed the chat area mounted at about 142 ms after navigation, React installed a 273 ms timer at that moment, and the 49 ms render that put the transcript on screen ran when that timer fired at 416 ms: the same 300 ms fallback throttle on the lazy `ResponseTimeline`. The window now starts loading the transcript code as soon as its own code runs, and `ChatWorkspace` renders the transcript through `useLoadedSurface`.

Same harness and machine. Before is the screen-open change above; after adds this change.

| Screen | Phase | Before median / p95 (ms) | After median / p95 (ms) | N | Load (1 min) before / after |
| --- | --- | ---: | ---: | ---: | --- |
| detached-window | cold | 489.8 / 496.4 | 188.9 / 192.8 | 5 | 2.2-2.8 / 2.0-4.2 |
| detached-window | warm | 494.6 / 498.2 | 188 / 193.5 | 5 | 2.2-2.8 / 2.0-4.2 |
| chat-switch-short | cold | 60.8 / 61.2 | 60 / 63.5 | 5 | 2.2-2.8 / 2.0-4.2 |
| chat-switch-short | warm | 40.9 / 41.6 | 38.4 / 40.2 | 5 | 2.2-2.8 / 2.0-4.2 |
| chat-switch-long | cold | 41.4 / 41.8 | 39.3 / 41.1 | 5 | 2.2-2.8 / 2.0-4.2 |
| chat-switch-long | warm | 41.7 / 42.2 | 41.4 / 42.6 | 5 | 2.2-2.8 / 2.0-4.2 |

Time from navigation start to the transcript: about 464 ms before, about 159 ms after.

## Tried and dropped: Settings section scroll after the commit (PW3)

Moving the Settings navigation `scrollIntoView` from a layout effect to the next animation frame did not change the Settings open time; the forced style and layout it triggers (about 8 ms) is work the first paint needs anyway. The change was reverted.

| Screen | Phase | Before median / p95 (ms) | After median / p95 (ms) | N | Load (1 min) before / after |
| --- | --- | ---: | ---: | ---: | --- |
| settings | cold | 55 / 55.7 | 55.5 / 55.9 | 5 | 2.0-4.2 / 2.5-3.4 |
| settings | warm | 47.1 / 47.2 | 47.6 / 48.4 | 5 | 2.0-4.2 / 2.5-3.4 |

## Screen opens: bundle and desktop benchmark (PW3)

The screens stay in their own chunks and no renderer budget changed. Against 3f3a0e701: main workbench first load 871,662 → 872,111 bytes (+449), detached chat first load 666,811 → 666,924 (+113), detached chat chunk 11,110 → 11,123 (+13), shared core 2,289,856 → 2,289,764 (−92), Tasks chunk 20,954 → 20,944 (−10); the background tasks, thread actions and terminal chunks grew by 1 byte each.

`npm run benchmark:desktop:built`, three runs per build (load 2.2–5.5):

| Metric | Before (runs) | After (runs) |
| --- | --- | --- |
| Terminal startup (ms) | 371.7, 367.7, 382.0 | 72.6, 63.3, 59.4 |
| Split chat interactive (ms) | 270.3, 264.8, 281.0 | 368.1, 365.3, 367.9 |
| Long conversation scroll p95 frame (ms) | 8.8, 8.4, 8.5 | 9.3, 8.4, 8.4 |
| First streamed delta to paint (ms) | 20, 19, 17 | 17, 19, 21 |
| Streaming p95 visible gap (ms) | 75.9, 75.7, 75.7 | 75.6, 75.5, 75.6 |
| Warm startup first window (ms) | 297.6, 279.8, 302.0 | 279.1, 290.3, 301.0 |

The benchmark opens the split immediately after the terminal. With a 1.5 s pause inserted before the split (local experiment, not committed) the split takes 388.3 ms before and 292.0 ms after, so the split itself is not slower; its time depends on what is still in flight when it starts, and the terminal now finishes about 300 ms sooner.
