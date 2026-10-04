# Custom colours: preset parity and Muted colours

Platform: macOS arm64, device scale 2, built Electron app (`npm run build:bundle`).
Spec: `tests/e2e/custom-colours-reach.spec.ts` with the synthetic `conversation`
fixture (one code block, one unstaged diff, one local shell terminal). No
provider ran.

`before-*` images come from `origin/main` 75dc9ceb, so their Settings page is
the pre-rework General page. The other images come from this branch.

Each image name is `<colour>-<view>-<theme>.png`:

- colour: `ember` (built-in preset, for reference), `teal` (#0d9488),
  `teal-muted`, `orange` (#f97316), `orange-muted`
- view: `workspace` (chat with code, Changes diff, terminal dock), `settings`
  (Appearance, custom colours and the Muted colours row), `detached` (the chat
  in its own window)
- theme: `light`, `dark`

| Colour | Before | After, vivid | After, muted |
| --- | --- | --- | --- |
| Teal, light | ![](before-teal-workspace-light.png) | ![](teal-workspace-light.png) | ![](teal-muted-workspace-light.png) |
| Teal, dark | ![](before-teal-workspace-dark.png) | ![](teal-workspace-dark.png) | ![](teal-muted-workspace-dark.png) |
| Orange, light | ![](before-orange-workspace-light.png) | ![](orange-workspace-light.png) | ![](orange-muted-workspace-light.png) |
| Orange, dark | ![](before-orange-workspace-dark.png) | ![](orange-workspace-dark.png) | ![](orange-muted-workspace-dark.png) |
| Settings, dark | ![](before-teal-settings-dark.png) | ![](teal-settings-dark.png) | ![](teal-muted-settings-dark.png) |
| Detached, dark | ![](before-orange-detached-dark.png) | ![](orange-detached-dark.png) | ![](orange-muted-detached-dark.png) |

What changed: a custom colour already drove the same 55 palette tokens as a
preset, with the same tint strengths, and that output stays byte-identical.
The new Muted colours switch halves the chroma of every hue-derived token
(surfaces, text tint, accent, accent-soft, selection, aurora, syntax keyword,
terminal selection) without changing any lightness. The guards for text,
accent and terminal contrast hold in both treatments.
