## Summary

<!-- Explain the user-visible outcome and why this change is needed. -->

## Verification

<!-- List focused tests and the result of `npm run check`. Explain any platform or provider surface that was not exercised. -->

- [ ] Focused tests pass.
- [ ] `npm run check` passes.
- [ ] Provider changes pass `npm run test:portable`.
- [ ] Packaging or release changes preserve package smoke, Electron fuse, checksum, and provenance checks.

## Safety and privacy

- [ ] I did not include credentials, tokens, private prompts, proprietary source, repository or account identifiers, full local paths, unredacted logs, diagnostics, screenshots, or recordings.
- [ ] New logs and errors redact secrets and private workspace data.
- [ ] Git and filesystem changes preserve containment, symlink safety, and unrelated user work.
- [ ] Dependency changes include the lockfile and any required third-party notice updates.
- [ ] Database migrations are append-only, transactional, and tested against an older fixture.

<!-- Remove checklist items that are genuinely not applicable, and explain why. Do not paste private diagnostics into this public pull request. -->
