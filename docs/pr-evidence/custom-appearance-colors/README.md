# Custom light and dark colors

Real screenshots of the built Electron app on Linux x64, captured by
`tests/e2e/custom-theme.spec.ts` with an isolated synthetic conversation.
No live profile, credentials, private prompts, or user repository content is used.
The workbench's recovered-history label is part of the synthetic code-block fixture.

The selector uses the existing Appearance card, paired swatches, semantic tokens,
and settings command. Each appearance accepts a native color picker or editable
hex value. The seed supplies hue/tint; Inertia keeps its existing surface ladder,
readability targets, semantic status colors, and syntax/terminal roles. Grayscale
seeds stay neutral. Reset restores that appearance's preset; a preset card clears
both custom overrides. System mode chooses the matching saved color.

The shared palette implementation also generates the shipped preset CSS. Its
output is unchanged for all five preset families. Custom generation loads on
demand, while a validated cache paints the last custom palette before React.
See [renderer bundle measurements](renderer-bundle.json) for a comparison with
`cb93b1f5` using the same dependency graph.

## Settings

![Light custom color](custom-colors-light.png)
![Dark custom color](custom-colors-dark.png)

## Workbench

| Light | Dark |
| --- | --- |
| ![Light workbench](custom-workspace-light.png) | ![Dark workbench](custom-workspace-dark.png) |

## Smaller window

![Custom colors at 1000 × 800](custom-colors-narrow.png)

The standard captures are 1440 × 1100. These screenshots establish Linux Electron
rendering; native Windows/macOS color dialogs and rendering were not exercised.
