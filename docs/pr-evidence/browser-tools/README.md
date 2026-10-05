# Browser tool surface evidence

Supervised approval cards for the new Browser actions. Each image comes from
`tests/e2e/agent-browser-approval-evidence.spec.ts` on macOS, run with
`INERTIA_BROWSER_TOOLS_EVIDENCE_DIR=docs/pr-evidence/browser-tools`. The card
text is the detail produced by the real main-process approval registry for a
local fixture page; the turn and card are a synthetic fixture with no
provider.

| Change | Image |
| --- | --- |
| A click that accepts the page's confirmation dialog says so | [approval-click-accept-dialog-light-wide](approval-click-accept-dialog-light-wide.png) |
| Reload names the address it will load, reduced to its origin like the navigate card | [approval-history-reload-light-wide](approval-history-reload-light-wide.png) |
| Scrolling to a ref names the control by role and label | [approval-scroll-to-ref-light-wide](approval-scroll-to-ref-light-wide.png) |

Not pictured:

- Taking over the page changes nothing in the Browser pane; only the agent's
  results report `controller: "user"`.
- Inertia's own "Leave this page?" confirmation, shown when the user leaves a
  page whose `beforeunload` handler asks to stay, is a native macOS message
  box that the Playwright harness cannot capture.
