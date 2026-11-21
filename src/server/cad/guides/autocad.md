# AutoCAD guide

Read before reading, drawing or editing a designer's AutoCAD work. For anything they will present, also read `inertia_cad_guide({topic: "presentation"})`.

## MUST NOT

- Reach AutoCAD or the designer's drawings any way but the `inertia_cad_*` tools: no COM, `SendCommand`, LISP, scripts or accoreconsole runs of your own. Parse only DXFs that you or `inertia_cad_export` wrote.
- Save, close or undo in their session, or build new work inside their drawing.
- Draw on `Defpoints`, or on `0` outside block definitions.
- Give objects their own colour, linetype or lineweight unless asked. Properties stay ByLayer.
- Scale geometry to fit a sheet. Model space is 1:1; scale is applied at plot.

## MUST

- Look before reasoning and after every change: `inertia_cad_export` `png` for saved files, `inertia_cad_capture_view {bbox}` for edits just applied (they are unsaved, so exports don't show them).
- Say so when what you read is older than the open drawing (`liveUnsaved`, or `modified: true` in `inertia_cad_status`).
- On `READ_MODIFIED_DRAWING`, stop every call on that drawing and tell the designer.

## Procedure

1. `inertia_cad_status`. Fix what `hint` names.
2. `inertia_cad_document_info` once per drawing; add `style: true` before drawing anything.
3. Take one path:
   - **Understand it.** `inertia_cad_export` `png` of an `area`; the image is about 1600 px wide, so a smaller `area` zooms. For all the geometry, `dxf`, then ezdxf. Keep `inertia_cad_query_objects` for filtered lookups.
   - **A small change they asked for, in their drawing.** See "Editing the open drawing".
   - **Anything else**: a new drawing or sheet, hatches, arcs, dimensions, styles, more than 50 operations. See "Building a new drawing".

## Reading their drawing

- **Units.** `insUnits` is often wrong: drawings marked mm are often drawn in metres. Measure something known: a door leaf (0.7–1.0 m), a storey (2.5–3.5 m), a dimension's `measurement`. That gives the real mm per unit: 1000, 10 or 1.
- **Scale.** `mmPerUnit` = real mm per unit ÷ scale denominator: 1:50 is 20 in metres, 0.02 in mm. Anything sized on paper is paper mm ÷ `mmPerUnit` in drawing units: 2.5 mm text at 1:50 in metres is 0.125.
- **Plot styles.** If `layouts[].plotStyleTable` is a `.ctb`, colour sets the printed lineweight: give new content the colour of their layer with the same role.
- **Text.** Copy style and height from their own text (`inertia_cad_query_objects {types: ["TEXT", "MTEXT"]}`), and from `dimStyles.active` for dimensions.
- **Xrefs** are not listed by `inertia_cad_document_info`, and relative ones are missing from exports (see `warnings`). If content looks missing, tell the designer.
- **Exports of their drawing** (`dxf`, `pdf`) land beside it; pass a `destination` in your own folder, which the designer approves in Inertia.

## Editing the open drawing

- There is no dialog: the user's request is the approval, and a change may land while the designer works. Apply only what they asked for: preview, tell the user what will change, apply, then `inertia_cad_capture_view {bbox}` to verify.
- Pass `layer` on every `add_*`; otherwise objects land on the current layer. `add_text` takes `current.textStyle`.
- Prefer existing layers. `acad.create_layer` sets only a colour index, so ask before adding one.
- `NESTED_TARGET` and `LOCKED` are the designer's decisions: report them, and don't press for exploding or unlocking.
- `HOST_BUSY`, `INACTIVE_DOCUMENT`, `HOST_OFFLINE` and `UNDO_DISABLED` mean nothing was sent: once the designer fixes the cause, apply the same `proposalId`. `TARGET_CHANGED` or `PROPOSAL_EXPIRED`: read and preview again.

## Building a new drawing

1. Write a DXF with ezdxf, in the unit their geometry is really drawn in. Keep it in a new delivery folder: each output lands beside its `source`.
2. Use their layer, text style and dim style names exactly: the build replaces your definitions with theirs. Copy blocks you reuse from a `dxf` export. Make repeated items blocks and dimensions real dimension entities. Run `doc.audit()`.
3. `inertia_cad_export {source: "<your.dxf>", format: "dwg", template: "<their drawing>"}`. Only your model space is carried over, so compose sheets there.
4. Render the result as `png` and compare colours, lineweights and fonts with theirs. Say what doesn't match.

## Limits

- A tool or parameter named here is missing (`inertia_cad_export`, `style`, `within`, `fields`): your schemas are stale. Ask for a fresh session; never fall back to COM or scripts.
- `inertia_cad_status` reports `headless: false`: `inertia_cad_export` is unavailable. Use `inertia_cad_query_objects` and `inertia_cad_capture_view {bbox}`, and say what you couldn't check.
