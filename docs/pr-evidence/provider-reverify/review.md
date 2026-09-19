# Provider update recovery review

Reviewed against main `19d8015735cae6f2bbbec2a46d78ebc6903c2f2d` with Node 22.23.2 on macOS ARM64.

Two regressions were reproduced against the original PR before correction:

- Sends arriving together could start redundant refreshes. A send arriving after discovery but before metadata publication could skip the pending refresh and see an incomplete catalog. Sends now join one pending verification per provider through publication; other providers remain independent.
- A removed CLI selected through PATH retained the old physical installation identity while probing its replacement. Lease settlement quarantined this legitimate relocation. A changed installation now discards capability evidence before resolving the configured command again, as at startup. Existing use leases and quarantine are retained; a replacement still needs successful discovery and protocol verification.

The executable-replacement fixture now runs on Windows too, using a staged copy of Node instead of a POSIX-only launcher. A subsequent broken protocol probe must refuse admission. A hanging verification must release the prepared message and never queue a prompt after its preparation deadline.

Validation:

- Original PR negative controls: both new regression scenarios failed.
- Focused provider refresh, installation, lease and turn preparation coverage: 92 tests passed.
- `VITEST_MAX_WORKERS=4 npm run check`: passed; 9,262 tests passed, 145 platform/optional tests skipped. Quality checks and production build passed with unchanged renderer budgets.

- `npm run test:portable`: 1,391 passed and 9 platform/optional tests skipped across 101 files.

Hosted Linux and Windows execution remains required, including the new Windows executable replacement fixture. No installed user provider or account was used by the deterministic fixtures.
