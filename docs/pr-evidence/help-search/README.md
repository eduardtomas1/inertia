# Help search

Platform: macOS 27 (Apple silicon), device scale 2, Electron from `npm ci`,
renderer from `npm run build:bundle`.

Spec: `tests/e2e/layout.spec.ts`, "searches Help, moves through the results
and opens an entry's setting". It uses the synthetic `conversation` fixture
(no provider is started), a fixed clock, and switches themes in place with
`setAppearanceInPlace`. The same run asserts that the dialog and the results
list fit the viewport at every size, that the page has no horizontal overflow,
that the live region reads "2 results", "No matches" and "1 result", that
Escape clears the query and keeps the open topic, and that ArrowDown, ArrowUp
and Enter open Settings → General from the "Custom colors" result.

## Before and after

The "before" images are the Help captures recorded when Help shipped
(`docs/pr-evidence/help-guide/`); Help had no search field.

| State | Before | After |
| --- | --- | --- |
| Topics, dark, wide | ![](../help-guide/help-getting-started-dark.png) | ![](help-search-topics-dark-wide.png) |
| Topics, light, wide | ![](../help-guide/help-getting-started-light.png) | ![](help-search-topics-light-wide.png) |

## Results

| Size | Dark | Light |
| --- | --- | --- |
| Wide (1440×920) | ![](help-search-results-dark-wide.png) | ![](help-search-results-light-wide.png) |
| Narrow (1000×800) | ![](help-search-results-dark-narrow.png) | ![](help-search-results-light-narrow.png) |
| Tight (760×600) | ![](help-search-results-dark-760x600.png) | ![](help-search-results-light-760x600.png) |

No matches: ![](help-search-no-matches-dark-wide.png)

## What changed

- A search field sits above the topic tabs and takes focus when Help opens.
- While the query has words, the tabs are replaced by matching entries grouped
  under their topic, with matched words marked. Each group keeps its topic's
  action buttons. The footer shows only Done.
- The field uses `--surface`, `--border-strong`, `--radius-small` and
  `--control-height`; marks use `--accent-soft`, as in the command palette.
