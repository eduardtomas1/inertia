# Browser viewport evidence

The Browser panel at the default 520 px width, before and after the agent
viewport. Every panel image comes from
`tests/e2e/agent-browser-viewport-evidence.spec.ts` on macOS (light theme,
2x display, reduced motion), run with
`INERTIA_BROWSER_VIEWPORT_EVIDENCE_DIR=docs/pr-evidence/browser-viewport`.
The spec drives the Browser through the main-process agent command path,
captures the real window with `screencapture -l` (the page is a native view
that Playwright screenshots do not include) and crops it to the panel. The
fixture page prints its own CSS viewport size and lays out in three, two or
one column. The before image comes from the same spec on `origin/main`
(438e066cb), which has no viewport control.

| File | What it shows | How captured |
| --- | --- | --- |
| [before-fit-narrow-panel](before-fit-narrow-panel.png) | Before: the page always lays out at the panel width (520×784, one column) | Spec on `origin/main`, panel crop |
| [after-fit-narrow-panel](after-fit-narrow-panel.png) | Fit (default): unchanged behaviour, Viewport reads "Fit" | Spec, panel crop |
| [after-desktop-1280x800](after-desktop-1280x800.png) | After `resize` preset `desktop`: the page lays out at 1280×800 in three columns, scaled to the panel and centred | Spec, panel crop |
| [after-mobile-375x812](after-mobile-375x812.png) | After `resize` preset `mobile`: 375×812, letterboxed in the stage | Spec, panel crop |
| [after-custom-1440x900](after-custom-1440x900.png) | After `resize` to 1440×900: the custom size appears as its own "1440×900" option | Spec, panel crop |
| [after-evidence-timeline](after-evidence-timeline.png) | Evidence timeline listing the viewport changes and the screenshot | Spec, panel crop |
| [agent-screenshot-desktop](agent-screenshot-desktop.png) | The PNG the `screenshot` command returns for the model at the 1280×800 viewport | Decoded from the command result |
| [approval-resize-desktop-light](approval-resize-desktop-light.png) | Supervised approval card for a desktop resize | Detail from the real approval registry; the turn and card are a synthetic fixture with no provider |

Not pictured:

- The before state has no counterpart for the other sizes: `origin/main` has
  no viewport control or `resize` command.
- The Tablet 768×1024 preset is not pictured.
