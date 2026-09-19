# Usage and chat palette review

Reconciled with main `19d8015735cae6f2bbbec2a46d78ebc6903c2f2d`.

The new message-action color originally lived only in handwritten CSS while the Theme Library calculated its own copy. Palette regeneration could leave the chat and preview inconsistent. The color now belongs to `buildPaletteTokens`, and previews consume that same token. Generation and native palette coverage include it for every family and appearance.

Kept main's renderer budgets, removing the original PR's unnecessary increases. Main/detached startup JavaScript is unchanged. Core adds 440 bytes, entry CSS adds 645 bytes and theme CSS adds 232 bytes; all remain inside existing budgets. Exact measurements are in `renderer-bundle.json`.

Validation on Node 22.23.2/macOS ARM64:

- 86 focused quota, palette generation and Theme Library tests passed.
- Full `VITEST_MAX_WORKERS=4 npm run check`: 9,264 tests passed, 145 platform/optional tests skipped; quality checks and production build passed.
- Message-action text contrast over a 10% tinted hover background exceeds 4.5:1 against app, surface and muted surfaces in every theme/appearance (minimum 4.62:1).
- 13 native Electron scenarios passed: all ten palettes, theme persistence after restart, responsive Environment geometry/keyboard access, and pooled-account/consent/composer Limits flows in light, dark and narrow layouts.
- Inspected native Ocean light and compact dark screenshots; no overlap or clipping regression found. Native screenshots are saved alongside this review.

Hosted Linux and Windows UI execution remains required. Original screenshot comparisons in this directory are renderer harness captures; the two `native-*.png` files come from the actual Electron application.
