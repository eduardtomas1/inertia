# Performance evidence

Measured on an Apple M5 Pro, macOS, 120 Hz display, production build
(`npm run build:bundle`). "Missed refreshes" is the share of display
refreshes that produced no new frame during the pass. Medians over N
runs, with the run p95 in brackets where N >= 5. "Load" is the 1-minute
load average logged before and after each run.

Scroll profile: `tests/performance/scroll-profile.spec.ts`, transcript
of 300 or 2,000 turns (`INERTIA_SCROLL_COVERAGE=1`), streaming follow,
and a 500-chat sidebar. Content loading:
`tests/performance/content-loading.benchmark.spec.ts`.

## Scrolling: render rows synchronously only when the viewport leaves them

Before: the transcript virtualizer flushed a synchronous React render on
every scroll event that moved its range. After: scroll events that stay
inside the rows already rendered (overscan included) paint first and
render in the next task; leaving the rendered rows or a row measurement
still renders synchronously.

| Metric | Before | After | N | Load |
| --- | --- | --- | --- | --- |
| Missed refreshes, 300 turns, wheel up | 4.19% (4.32) | 1.66% (2.46) | 5 | 1.8-5.2 |
| Missed refreshes, 300 turns, wheel down | 3.59% (3.73) | 1.93% (2.26) | 5 | 1.8-5.2 |
| Missed refreshes, 300 turns, thumb drag up | 15.66% (23.25) | 11.13% (11.48) | 5 | 1.8-5.2 |
| Missed refreshes, 300 turns, thumb drag down | 12.13% (12.78) | 2.29% (2.99) | 5 | 1.8-5.2 |
| Missed refreshes, 2,000 turns, wheel up | 4.07% (4.28) | 1.52% (1.86) | 5 | 1.8-5.2 |
| Missed refreshes, 2,000 turns, wheel down | 3.01% (3.26) | 1.27% (1.47) | 5 | 1.8-5.2 |
| Missed refreshes, 2,000 turns, thumb drag up | 57.02% (57.48) | 56.34% (57.07) | 5 | 1.8-5.2 |
| Mean blank viewport, 2,000 turns, thumb drag up | 6.75% (7.29) | 6.71% (7.19) | 5 | 1.8-5.2 |
| p95 frame, 300 turns, thumb drag down | 16.7 ms | 10.2 ms | 5 | 1.8-5.2 |
| Missed refreshes, streaming, wheel up | 3.86% (6.25) | 3.37% (3.81) | 5 | 1.8-5.2 |

Tried and dropped: turning synchronous renders off entirely
(`useFlushSync: false`) reached 1.26% missed on the 300-turn drag up but
raised the mean blank viewport on the 2,000-turn drag up from 6.75% to
33.3% (N=5, load 2.1-4.1).

## Transcript navigation: keep the state when a scroll does not change the mode

Before: every intentional scroll event created a new navigation state,
so `ChatWorkspace` and its unmemoised children rendered on each wheel
tick. After: the reducer returns the current state when the mode is
unchanged.

| Metric | Before | After | N | Load |
| --- | --- | --- | --- | --- |
| Components rendered, 300 turns, wheel up | 10,343 | 1,913 | 5 / 4 | 2.0-3.2 |
| Components rendered, 300 turns, wheel down | 10,688 | 2,228 | 5 / 4 | 2.0-3.2 |
| Components rendered, 2,000 turns, wheel up | 10,415 | 1,914 | 5 | 2.0-3.2 |
| Components rendered, 2,000 turns, wheel down | 10,060 | 2,308 | 5 | 2.0-3.2 |
| Main-thread busy, 2,000 turns, wheel up | 2,922 ms | 2,850 ms | 3 | 1.7-2.9 |
| Main-thread busy, 2,000 turns, wheel down | 2,544 ms | 2,465 ms | 3 | 1.7-2.9 |

Frame timings were already inside the refresh budget on wheel scrolling
and did not change. One after-run (300 turns) ended above load 6 and was
discarded, hence N=4 there.

## Markdown and code highlighting: reuse results when rows remount

Before: a row that scrolled back into view, or a chat opened again,
parsed its Markdown and highlighted its code again. After: settled
Markdown trees and highlighted code are kept in bounded caches (500
entries each, 1.5M and 4M characters); streaming Markdown is not cached.

| Metric | Before | After | N | Load |
| --- | --- | --- | --- | --- |
| Detail result to visible rows, 2,000-message chat, warm open | 26.5 ms (27.1) | 18.8 ms (19.4) | 5 | 1.7-2.6 |
| Detail result to visible rows, 300-message chat, warm open | 26.7 ms (28.6) | 19.1 ms (19.5) | 5 | 1.7-2.6 |
| Click to visible, 2,000-message chat, warm open | 67.5 ms (69.6) | 59.9 ms (62.0) | 5 | 1.7-2.6 |
| Click to visible, reopen after older pages | 64.1 ms (65.9) | 59.0 ms (60.3) | 5 | 1.7-2.6 |
| Detail result to visible rows, 2,000-message chat, cold open | 26.3 ms | 27.1 ms | 5 | 1.7-2.6 |
| Jump to latest after loading 2,000 turns | 59.7 ms | 48.8 ms | 5 | 2.0-5.5 |
| Main-thread busy, 2,000 turns, second drag over the same range | 5,327 ms | 4,959 ms | 3 | 1.7-2.6 |
| Missed refreshes, 2,000 turns, thumb drag down | 46.99% | 44.92% | 5 | 2.0-5.5 |

Wheel and thumb-drag frame timings were compared in interleaved runs
(before and after alternating) and stayed within noise.

## Row height estimates: price Markdown by the rendered answer typography

Before: Markdown prose and list lines were priced at 25 px, every heading
at 30 px, every list item and table line as its own block with a 12 px
gap, and table delimiter rows as rendered rows. The rendered answer uses
14.5 px text at 1.6 line height (23.2 px), 24 px and 20 px headings,
6 px between list items and 36 px table rows below a 24 px toolbar.
After: the estimate uses those values and prices a list or a table as
one block.

| Metric | Before | After | N | Load |
| --- | --- | --- | --- | --- |
| Estimated height before measuring, 300 turns (measured 358,282 px) | 388,139 px (+8.3%) | 363,351 px (+1.4%) | 5 | 2.2-4.3 |
| Estimated height before measuring, 2,000 turns (measured about 2,390,000 px) | 2,597,385 px (+8.4%) | 2,424,697 px (+1.5%) | 5 | 2.2-4.3 |
| Mean blank viewport, 2,000 turns, thumb drag up | 6.34% (8.31) | 1.41% (1.42) | 5 | 2.2-4.3 |
| Mean blank viewport, 2,000 turns, thumb drag down | 1.18% (2.04) | 0.42% (0.57) | 5 | 2.2-4.3 |
| Missed refreshes, 300 turns, thumb drag up | 8.03% (10.02) | 7.73% (11.84) | 5 | 2.2-4.3 |
| Missed refreshes, 2,000 turns, thumb drag up | 55.97% (56.68) | 55.51% (56.24) | 5 | 2.2-4.3 |
| Missed refreshes, 2,000 turns, wheel up | 2.52% (2.67) | 1.67% (3.26) | 5 | 2.2-4.3 |

Before and after runs alternated. Jump to latest after loading 2,000
turns was bimodal in both builds (45-59 ms after, 48-58 ms in earlier
runs of the same before build), so its median is not a reliable
comparison here; the desktop benchmark below covers it.

## Sidebar: reuse one relative-time formatter

Before: every sidebar row label built a new `Intl.RelativeTimeFormat`.
After: one module-level formatter is reused.

| Metric | Before | After | N | Load |
| --- | --- | --- | --- | --- |
| Main-thread busy, 500-chat sidebar, wheel down | 2,728 ms | 2,477 ms | 3 | 2.6-2.8 |
| Main-thread busy, 500-chat sidebar, wheel up | 2,678 ms | 2,146 ms | 3 | 2.6-2.8 |
| Main-thread busy, wheel down while streaming | 2,747 ms | 2,597 ms | 3 | 2.6-2.8 |

Tried and dropped: updating the sidebar window only when its visible
index range changes made no difference (678 commits per wheel pass
before and after, N=5), because at wheel speed the range changes on
almost every event. Keeping the window until the visible rows come
within four rows of its edge cut commits from 678 to 190 and rendered
components from 320,685 to 45,859 per pass, but each re-centre mounted
several rows at once and produced one 16.7 ms frame in most passes
(maximum frame 9.4 ms before; missed refreshes 0% to 0.28%, N=5), so it
was not kept.

## Desktop benchmark with all kept fixes

`npm run benchmark:desktop:built`, before (feature branch) and after
(this branch) alternating, N=3 runs, five follow-latest samples per run,
load 2.1-5.3.

| Metric | Before | After | N |
| --- | --- | --- | --- |
| Jump to latest | 41.8 ms (max 46.2) | 42.2 ms (max 44.6) | 15 |
| Reader navigation | 151.2 ms (max 192.7) | 139.9 ms (max 173.0) | 15 |
| Long conversation p95 frame | 8.8 ms | 8.4 ms | 3 |
| Long conversation maximum frame | 16.7 ms | 9.4 ms | 3 |
| Streaming first delta to paint | 18 ms | 19 ms | 3 |
| Streaming completion to final paint | 285 ms | 270 ms | 3 |
| Streaming p95 visible gap | 76.7 ms | 75.6 ms | 3 |
