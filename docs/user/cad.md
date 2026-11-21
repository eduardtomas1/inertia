# AutoCAD and SketchUp

Agents can read and edit the drawing or model you have open in AutoCAD or
SketchUp on the same computer as Inertia. Ask what is selected, find objects by
layer or type, capture the current view as an image, or have the agent draw,
move, recolor, or retag objects. Nothing in a drawing changes until you approve
it inside the CAD app, and one Undo reverts each approved change.

## Requirements

- **AutoCAD:** full AutoCAD for Windows. AutoCAD LT and AutoCAD for Mac are not
  supported.
- **SketchUp:** SketchUp Pro or Studio desktop, on Windows or macOS. SketchUp
  Free, SketchUp for Web, and SketchUp Go are not supported.

## Get started

1. Open the project's settings and set **Agent CAD tools** to **On**. The tools
   are off by default, so other projects never carry them. New chats pick up
   the change; Codex chats need a new chat, because Codex registers tools only
   when a chat starts.
2. Open your drawing in AutoCAD, or your model in SketchUp.
3. Ask the agent which CAD drawings are open. It reports each open drawing and
   model, and anything you need to fix first.
4. For SketchUp, ask the agent to set up SketchUp the first time. Inertia asks
   you to approve writing its extension into every installed SketchUp version's
   Plugins folder; restart SketchUp afterwards. Ask again after updating
   Inertia if the agent says the extension is outdated. AutoCAD needs no setup.

## How edits work

1. The agent prepares a change and gets a preview of every object before and
   after. A preview never changes the drawing.
2. The agent explains the change in the chat.
3. When the agent applies it, AutoCAD or SketchUp shows a Yes/No dialog that
   summarizes the change. Choose **Yes** to apply it or **No** to cancel. If the
   agent seems to be waiting, switch to the CAD app to answer the dialog.
4. Each approved change is one Undo step in the CAD app.

A preview can be applied once, within 30 minutes. If the objects it changes
were edited since the preview, nothing is applied and the agent prepares a new
one. If the agent reports that the outcome is unknown, for example because the
CAD app stopped responding, check the drawing before asking it to try again.

## Save a copy

Ask the agent to save a copy to keep a snapshot of your work. Inertia asks you
to approve the file name first. Copies are always new files and never replace
an existing file or re-save the original. By default the copy goes next to the
original as `<name> (Inertia copy <date and time>)`. In AutoCAD, save the
drawing first; a drawing with unsaved changes can't be copied.

## What agents can edit

- **AutoCAD**, in drawing units: add lines, polylines, circles, and text;
  create layers; move and erase objects; change an object's layer or color;
  change text and block attribute values.
- **SketchUp**, in millimeters: add boxes; create tags and materials; move,
  erase, hide, or show objects; rename them; change an object's tag or
  material.

Agents edit top-level objects only. They can't change objects inside an
AutoCAD block definition, or inside a SketchUp component that other instances
share, because the edit would change every copy. Objects on locked AutoCAD
layers, and locked SketchUp objects or objects inside locked groups, are
refused. Agents can't run commands, scripts, or plugins in the CAD apps.

## Privacy

Drawing data, text, and screenshots that the agent reads go to the provider the
chat uses, like anything else in the conversation. Work on copies of client
projects when their terms require it.

## Troubleshooting

- **SketchUp is not running or not found.** Open SketchUp. If you just set it
  up, restart SketchUp so it loads the extension. If SketchUp was installed
  recently, open it once before asking the agent to set it up.
- **SketchUp is running but not answering.** Close any open dialog in SketchUp.
- **AutoCAD is busy.** Finish or cancel the current command and close any open
  dialog in AutoCAD.
- **AutoCAD is not found.** Make sure full AutoCAD for Windows is open with a
  drawing.
- **Remove the SketchUp extension.** Quit SketchUp, then delete
  `inertia_cad_bridge.rb` and the `inertia_cad_bridge` folder from SketchUp's
  Plugins folder: `%APPDATA%\SketchUp\SketchUp 20XX\SketchUp\Plugins` on
  Windows, `~/Library/Application Support/SketchUp 20XX/SketchUp/Plugins` on
  macOS.

How the tools work underneath is in [CAD tools](../CAD_TOOLS.md).
