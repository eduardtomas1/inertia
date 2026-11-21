# CAD tools

The user guide is [AutoCAD and SketchUp](user/cad.md). This page covers how
the tools work.

The `inertia.cad` capability pack
([harness capabilities](HARNESS_CAPABILITIES.md#inertiacad)) adds eight tools:
`inertia_cad_status`, `inertia_cad_setup`, `inertia_cad_get_selection`,
`inertia_cad_query_objects`, `inertia_cad_capture_view`,
`inertia_cad_preview_changes`, `inertia_cad_apply_changes`, and
`inertia_cad_save_copy`.

- **AutoCAD.** For each request Inertia runs Windows PowerShell 5.1 on the
  bridge script it writes to `<data>/cad/InertiaCadBridge-<digest>.ps1`, through
  the restricted process runner: no shell, an allowlisted environment, bounded
  output (1 MiB) and runtime (10 minutes), and process-tree termination on
  timeout or cancellation. The script reaches the running AutoCAD through COM,
  shows the approval dialog, and groups each applied change into one undo
  mark.
- **SketchUp.** The extension runs a JSON-lines server on `127.0.0.1` with a
  random port and a random token, which it writes to
  `~/.inertia-cad/hosts/sketchup-<pid>.json`. Inertia opens one connection per
  request. Work runs on SketchUp's main thread inside one undoable operation.
  Setup writes only the extension's own files and refuses to write through a
  link at any of their paths.
- **Proposals.** A preview records the target fingerprints and the exact text
  of the approval dialog. Apply sends both; the bridge refuses the change when
  a fingerprint no longer matches. Erasing an AutoCAD block insert also
  fingerprints its block definition's objects, so a rescaled insert or an edited
  definition is refused too. A proposal is sent to the CAD app at most
  once: a retried apply returns the first outcome, and outcomes are kept in
  `<data>/cad/receipts.jsonl` so a retry after a restart still finds them.
  Writes run one at a time.
- **Results** are kept under the 32 KiB host-tool result limit by returning
  fewer rows: a query continues with `nextCursor`, a selection says
  `truncated`, and long change lists report `changesShown` and `changesTotal`.
  Captures are returned as images only to models that accept images.
- **Bridge sources** live in `src/server/cad/hosts`. They are embedded in
  `src/server/cad/bridge-sources.ts` by `npm run generate:cad-bridges`;
  `npm run check:cad-bridges` (part of `check:quality`) fails when the embedded
  copy is stale. The `CAD bridges` workflow runs the Ruby tests against a fake
  SketchUp API, and the PowerShell tests against a fake AutoCAD under Windows
  PowerShell 5.1 and PowerShell 7.

Real AutoCAD and SketchUp are not part of CI; the bridges are exercised against
fakes of each app's API.
