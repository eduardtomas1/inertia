# Agents settings: framed provider and backend lists

Screenshots of the built Electron app on macOS (arm64), taken with
`animations: "disabled"` and the pointer moved away on the same synthetic
fixture as `tests/e2e/provider-settings-visual.spec.ts`. Before is a build of
`main`; after is this branch. No live profile, credentials,
provider account or user repository is shown.

Before the Settings rework, Providers sat in one framed panel: a tinted list on
the left with hairlines between rows, and the selected provider's details on the
right. The rework dropped the frame, so the list and details floated on the
page. This change brings the frame back for the Agents section only, and uses
it for Custom backends too.

- Each list (Providers and Custom backends) sits in one bordered panel with
  rounded corners.
- The list column has a slightly tinted background, a divider on its right, and
  a hairline under every row. The selected row keeps the selected background
  and no longer has an accent bar. A hovered row is tinted half as strongly as
  the selected row, so hover never reads as selection.
- When the list is taller than the details, the last row's hairline sits
  under the frame's edge instead of doubling it. Backend rows are as tall as
  provider rows.
- In forced colours the selected row's outline is drawn inside the frame, so
  the frame does not clip it.
- The details column has its own padding, so the header, tabs and rows line up
  inside the frame.
- Providers gets back its one-line description: "Use the coding tools and
  accounts already installed on this computer."
- Below 760 px the list stacks above the details inside the same frame, as
  before. An empty list adds no border under the frame's top edge.

No eyebrows, pills, chips or icon tiles are added. Status text, controls and
behaviour are unchanged.

| | Before | After |
| --- | --- | --- |
| Light, 1440 px | [before-agents-light-wide](before-agents-light-wide.png) | [after-agents-light-wide](after-agents-light-wide.png) |
| Dark, 1440 px | [before-agents-dark-wide](before-agents-dark-wide.png) | [after-agents-dark-wide](after-agents-dark-wide.png) |
| Custom backends, light | | [after-custom-backends-light-wide](after-custom-backends-light-wide.png) |
| Custom backends, dark | | [after-custom-backends-dark-wide](after-custom-backends-dark-wide.png) |
| 760 px, light | | [after-agents-light-760](after-agents-light-760.png) |
