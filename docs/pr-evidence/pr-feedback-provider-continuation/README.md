# PR feedback tasks and provider continuation

These unedited Electron screenshots were captured by the Linux x64 job in
[CI run 36835732317](https://github.com/eduardtomas1/inertia/actions/runs/36835732317)
at source commit `bdb033985b37911535a63504d33462612c13a3ab`.
Both feature scenarios passed on Linux x64, Linux ARM64, and Windows ARM64.
They use deterministic review discussions and conversation fixtures, with real
runtime commands, checkout checks, context persistence, and restart validation.

- `pr-feedback-selected.png`: selected unresolved feedback and the task action.
- `provider-continuation-preview.png`: context selection and an optional instruction.
- `provider-continuation-draft.png`: the linked context packet and preserved draft.

The subsequent focus regression fix preserves composer focus after the feedback
dialog closes; it does not change the pictured controls. The draft capture now
also checks composer containment and closes the Changes panel for readability.

`renderer-bundle.json` records matching-dependency production bundle measurements.
