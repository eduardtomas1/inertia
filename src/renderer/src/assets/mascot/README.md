# Inertia pixel mascot

The final pixel-art mascot: a white, cursor-headed stick figure based on Inertia's
own logo in `resources/icon.svg`. All five states share a 96 × 96 transparent
canvas and a fixed 12-color palette. Activity loops use 12 fps; the suspended
pickup uses 24 fps. Animated WebP files use
lossless encoding to retain crisp pixel edges. PNGs are the matching still frames.

| State | Animation | Still frame | Duration | Frames |
| --- | --- | --- | ---: | ---: |
| Idle | [idle.webp](idle.webp) | [idle.png](idle.png) | 4 s | 48 |
| Thinking | [thinking.webp](thinking.webp) | [thinking.png](thinking.png) | 4 s | 48 |
| Idea | [idea.webp](idea.webp) | [idea.png](idea.png) | 3 s | 36 |
| Working | [working.webp](working.webp) | [working.png](working.png) | 4 s | 48 |
| Pickup | [pickup.webp](pickup.webp) | [pickup.png](pickup.png) | 2 s | 48 |

`manifest.json` records the palette, dimensions and per-state timing. Every
animation loops; Idea also returns to its starting pose. Thinking includes the
three moving thought dots, Idea the golden bulb, and Working the adjusted laptop.
Pickup is a new pose of the original 3D rig, exported onto the same pixel grid.
The 13-frame [lift strip](pickup-lift.webp) is a 400 ms rig transition into that
pose. CSS reverses from its current frame on release, including an early drop.
The suspended loop fades in only after the lift; the strip then hides so its
resting pose cannot show through the transparent loop. The latest activity returns
after the landing. Matching display-referred whites avoid a gray flash between
the existing activity art and the new captures.
Its editable source, provenance and regeneration instructions live in
[`source-assets/mascot`](../../../../../source-assets/mascot/README.md).
It is a transient drag interaction; the underlying activity stays current.

## Renderer use

The overlay declares its image URLs in an inert `<template>` in
`src/renderer/mascot.html`. Vite resolves those local `img` and `source` references;
reading the declarations does not fetch or decode the inactive animations. The
static markup stays in HTML and event listeners share an abortable lifetime,
keeping the complete mascot JavaScript within the original 6 KiB budget.

Display with a native `img`, explicit width and height, and `image-rendering: pixelated`.
Use an integer multiple of 96 pixels for enlarged previews. Preserve the shared
canvas and aspect ratio when switching states so the mascot does not jump.

Use the matching PNG for `prefers-reduced-motion: reduce`, when paused, and while
the companion is inactive or hidden. CSS cannot pause an animated WebP: switch its
source to the still frame. Use empty alternative text when the mascot is decorative;
otherwise describe the actual app state it represents. Drive state changes from
real app activity when connecting the companion to the interface.

The optional desktop overlay uses this final pixel pack. Its status mapping lives
in the runtime, and its image selection lives in `../../mascot/assets.ts`. No 3D
models, rendering libraries, alternate studies or preview application are needed
at runtime.
