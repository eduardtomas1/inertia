# CAD tools

The user guide is [AutoCAD and SketchUp](user/cad.md). This page covers how
the tools work.

The `inertia.cad` capability pack
([harness capabilities](HARNESS_CAPABILITIES.md#inertiacad)) adds eleven tools:
`inertia_cad_status`, `inertia_cad_setup`, `inertia_cad_get_selection`,
`inertia_cad_query_objects`, `inertia_cad_document_info`, `inertia_cad_capture_view`,
`inertia_cad_export`, `inertia_cad_guide`,
`inertia_cad_preview_changes`, `inertia_cad_apply_changes`, and
`inertia_cad_save_copy`.

- **AutoCAD.** For each request Inertia runs Windows PowerShell 5.1 on the
  bridge script it writes to `<data>/cad/InertiaCadBridge-<digest>.ps1`, through
  the restricted process runner: no shell, an allowlisted environment, bounded
  output (1 MiB) and runtime (10 minutes), and process-tree termination on
  timeout or cancellation. Inertia checks the script's content once per run
  and rewrites a damaged copy. The script reaches the running AutoCAD through
  COM and groups each applied change into one undo mark, then regenerates the
  active viewport. Every read runs behind a tripwire: if DBMOD or the model space count
  changes during it, it fails with `READ_MODIFIED_DRAWING`. An apply holds a
  per-session mutex and is refused while a command is active or undo is off.
- **SketchUp.** The extension runs a JSON-lines server on `127.0.0.1` with a
  random port and a random token, which it writes to
  `~/.inertia-cad/hosts/sketchup-<pid>.json`. Inertia opens one connection per
  request. Work runs on SketchUp's main thread inside one undoable operation.
  The extension loads on SketchUp 2020 or newer, and status follows the
  newest installed version.
  Setup writes only the extension's own files and refuses to write through a
  link at any of their paths.
- **Proposals.** A preview records the target fingerprints. Apply runs at
  once, with no dialog in the CAD app or in Inertia: the user's request in the
  chat is the approval. The bridge refuses the change when a fingerprint no
  longer matches, while a command is active, or while undo is off, and an
  AutoCAD apply holds a session mutex. Erasing an AutoCAD block insert also
  fingerprints its block definition's objects, so a rescaled insert or an edited
  definition is refused too. A proposal is sent to the CAD app at most once: a
  retried apply returns the first outcome, and outcomes are kept in
  `<data>/cad/receipts.jsonl` (its newest 5,000 lines) so a retry after a
  restart still finds them. One write runs at a time, and another is refused
  with `HOST_BUSY` instead of waiting in line, so every call answers within
  28 seconds (under OpenCode's 30-second host-tool timeout), and a cancelled
  call never cancels an edit already sent. Every request carries `deadlineAt`,
  so a bridge never starts work nobody will read. A failure before any step
  (busy, offline, undo off) leaves the proposal usable; an answer lost after
  that is recorded as `unknown`. A SketchUp extension older than 1.2.0 still
  shows its dialog; its `rejected` and `expired` answers are recorded with a
  prompt to update it.
- **Exports.** `inertia_cad_export` runs AutoCAD's `accoreconsole.exe` (found
  through the registry or `Program Files\Autodesk\AutoCAD 20xx`) on a copy of
  the saved file, with `/isolate` in Inertia's own profile, through the same
  restricted process runner, one export at a time, within 55 seconds across its
  passes. Script lines are printable ASCII and only use names AutoCAD itself
  listed; paths never appear in scripts. `png` renders an area on white, `pdf`
  plots at `mmPerUnit` on A4 to A0 (paper matched by its dimensions, so
  localized names work), `dxf` exports, and `dwg` builds a drawing from a DXF,
  optionally on a copy of the user's drawing as a template. Outputs never
  overwrite anything except Inertia's own earlier exports, matched by hash in
  `<data>/cad/exports.jsonl`; exports of the user's drawings go to
  `<data>/cad/exported/`, and another destination needs the user's approval.
  `liveUnsaved` flags an open drawing newer than the saved file.
- **Style and guides.** `inertia_cad_document_info` with `style: true` adds layer
  true colour, lineweight and transparency, text and dimension styles, the
  current layer, styles and LTSCALE, and each layout's paper, device and plot
  style, under the read tripwire. `inertia_cad_guide` returns one of three
  short embedded guides (`autocad`, `sketchup`, `presentation`), kept in
  `src/server/cad/guides` and embedded with the bridges.
- **Results** are kept under the 32 KiB host-tool result limit by returning
  fewer rows: a query continues with `nextCursor`, a selection says
  `truncated`, and long change lists report `changesShown` and `changesTotal`.
  Captures are returned as images only to models that accept images. Reads
  answer within 28 seconds; AutoCAD stops scanning early and returns a
  `partial` page with `nextCursor`.
- **Bridge sources** live in `src/server/cad/hosts`. They are embedded in
  `src/server/cad/bridge-sources.ts` by `npm run generate:cad-bridges`;
  `npm run check:cad-bridges` (part of `check:quality`) fails when the embedded
  copy is stale. The `CAD bridges` workflow runs the Ruby tests against a fake
  SketchUp API, and the PowerShell tests against a fake AutoCAD under Windows
  PowerShell 5.1 and PowerShell 7.

Real AutoCAD and SketchUp are not part of CI; the bridges are exercised against
fakes of each app's API.
