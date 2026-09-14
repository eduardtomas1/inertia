# Antigravity provider evidence

These are real-time Electron captures from
`tests/e2e/antigravity-evidence.spec.ts`, taken on macOS ARM64 with one
Playwright worker in the `isolated` project. The home directory, workspace,
database and Electron profile are synthetic. The user's running app was not
closed, modified or photographed, and no screenshot was retouched or
generated.

The real Antigravity CLI was never run. A fake `agy` Node script is the only
Antigravity executable on the fixture's `PATH`: it prints `1.2.2` for
`--version` and emits documented stream-json events for a turn. Before any
capture, the spec asserts that no `agy` or `antigravity` exists in the other
searched system directories, that the Settings binary path resolves to the
fake, and that every recorded launch came from the fake. The fake makes no
network requests, and no account, token or keyring is involved.

## Captures

| Surface | Light | Dark |
| --- | --- | --- |
| Provider readiness: version-gated install, per-turn sign-in, Connect, no Gemini CLI row | [Light](provider-readiness-light.png) | [Dark](provider-readiness-dark.png) |
| Model chooser with the Antigravity source | [Light](model-chooser-light.png) | [Dark](model-chooser-dark.png) |
| Running turn: streamed text and a running tool step | [Light](running-turn-light.png) | [Dark](running-turn-dark.png) |
| Completed turns, the second resumed with `--conversation` | [Light](completed-turn-light.png) | [Dark](completed-turn-dark.png) |
| Antigravity mark in the Settings provider tile | [Light](antigravity-mark-settings-light.png) | [Dark](antigravity-mark-settings-dark.png) |
| Antigravity mark at 16 px in the composer route chip | [Light](antigravity-mark-chip-light.png) | [Dark](antigravity-mark-chip-dark.png) |

## What the spec asserts

- Every turn launches `agy --input-format stream-json --output-format stream-json`.
  No launch carries `-p`, `--print` or `--prompt`.
- The second turn adds `--conversation <id>` from the first turn's result.
- The Settings provider list has no Gemini CLI row.
- The Antigravity composer drops the images wording and offers documents and
  spreadsheets only, because the harness declares no image input.
- The Settings tile and the composer route chip render the official
  Antigravity mark: the Google-contributed ACP registry icon, unmodified and
  inverted in dark themes like the other monochrome marks.
- Both turns complete with the streamed text and no renderer errors.

## Reproduction

Run `npm run check`, then, with no other build running:

```sh
INERTIA_E2E_WORKERS=1 npx playwright test tests/e2e/antigravity-evidence.spec.ts --project=isolated
```

The images are written as test attachments under `test-results`.
