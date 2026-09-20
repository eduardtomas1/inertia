# Wait for the full Snapshot preview before deleting its attachment

The v0.0.60 Intel macOS release job failed the light-theme Snapshot scenario
with an attachment-preview HTTP 404 and its corresponding renderer console
error. The initial thumbnail had decoded, and the retained compact screenshot
also shows it correctly. The failure was the final assertion that the renderer
error list remained empty.

- Release run: https://github.com/eduardtomas1/inertia/actions/runs/35504373634
- Failed job: https://github.com/eduardtomas1/inertia/actions/runs/35504373634/job/106061710191
- Frozen application commit: `519e2ecde83b2200e3fd2a9d5a9537d875b6ef4e`

## Ordering gap

Opening the dialog creates another image request. The test waited for the
dialog and its close-button focus, then immediately switched to accessibility
data, closed the dialog and removed the attachment. It did not wait for that
second image to decode. Removal revokes the attachment, so a pending validated
preview request can subsequently return 404. The original CI trace contains
test actions, not a browser network trace; request timing was investigated
separately rather than inferred as a directly observed CI event.

The corrected test requires a complete 800 × 500 image in the preview dialog
before switching views. It retains the existing deadlines and every focus,
layout, settings-persistence and renderer-error assertion. This also verifies
the full-size image that the original scenario never checked.

## Controlled reproduction on unchanged application code

The diagnostic checkout uses the frozen v0.0.60 application. Test-only request
observers record the import, dialog, accessibility, removal and reload phases.
An Electron `webRequest.onBeforeRequest` observer delays only the second
`/attachment-preview/` request by 1,100 ms, then continues it normally. It does
not synthesize a response, delete the file, alter IPC, or change the application.

- Original ordering: **3/3 failed** with the same pair of HTTP 404 and console
  errors. The recorded 404 arrived after the remove action, during Settings.
- Corrected image-readiness assertion, with the same delay: **6/6 passed**
  across dark and light themes. The image returned 200 and decoded before the
  accessibility and removal actions.
- Corrected production test without diagnostic observers or delay: **9/9
  passed**, repeating both theme scenarios and the native-binding scenario
  three times on macOS ARM64.

The delayed-request control proves the ordering failure without weakening the
attachment revocation contract. No application, protocol, version, packaging or
release-tag change is included in this correction.

## Verification

```sh
npm run build
npx playwright test tests/e2e/snapshots-compaction.spec.ts \
  --project=display-sensitive --repeat-each=3
```

Both commands passed. The complete Node 22 `npm run check` also passed:
9,341 tests passed and 146 were skipped, with the architecture, migration,
lint, type, theme-generation, build and renderer-budget checks passing.
Hosted native results are recorded in the pull request after they finish.
