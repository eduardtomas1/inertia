# Provider icon provenance

These local vectors identify the provider that owns a Work item. Their official
geometry and supplied colors are preserved; Inertia only scales them and swaps
vendor-provided light/dark variants where available. All marks remain the
property of their respective owners.

- `openai.svg`: OpenAI symbol from `openai/openai-assistants-quickstart` at
  commit `06fc2d444a5d41b574082080f4c7b2e48156b84f`, file
  `public/openai.svg` (MIT repository license). OpenAI's current mark terms and
  display guidance: <https://openai.com/brand/>.
- `anthropic.svg`: Anthropic/Claude mark from
  `anthropics/anthropic-sdk-typescript` at commit
  `ed02a89f5bad120c3191aa105820f33bfa14cef2`, file `.github/logo.svg` (MIT
  repository license). The supplied `#D97757` fill is unchanged.
- `cursor-light.svg` and `cursor-dark.svg`: the 2D cube light/dark SVGs from
  Cursor's official brand kit downloaded from <https://cursor.com/brand> on
  2026-08-11. The downloaded archive SHA-256 is
  `97488a7751914e60f9ff532bc33810cdeaebdddc017548abe6ca2bc29bbc3928`.
- `opencode-light.svg` and `opencode-dark.svg`: OpenCode identity marks from
  `anomalyco/opencode` at commit
  `9fdd4824d3c1e1c533a72359dd6c5f285ae9fc63`, files
  `packages/identity/mark-light.svg` and `packages/identity/mark.svg` (MIT
  repository license).
- `kimi.svg`: Kimi Code icon from `MoonshotAI/kimi-code` at commit
  `cfc335048378d3708666e11959c8d34507a1d659`, file
  `apps/vscode/resources/kimi-icon.svg` (MIT repository license; local SHA-256
  `39b9072b6d235732ecdc8e0aa39674bc64afaa09ff31f29ecc955d61dc4fdda5`).
  The geometry is unchanged; comments and multiline formatting were removed.

These assets are emitted into the packaged renderer for offline use; the
application does not request vendor-hosted images at runtime. The imports use
Vite's `?no-inline` form so the marks do not consume the entry JavaScript
budget. Their distributable license and trademark notices are maintained in
`resources/provider-icon-notices.txt` and appended to the packaged
`THIRD_PARTY_NOTICES.txt` during the existing notice-generation step.
