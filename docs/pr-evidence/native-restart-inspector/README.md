# Native restart inspector cleanup

## Change and failed-before control

Fixture restart requested application quit without the final-exit inspector
closure already used by prepared fixture cleanup. A real Electron control that
keeps an independent main-process debugger attached failed with `forced/settled`
on the original restart helper. Sharing the final-exit observer makes that
control pass: the old process exits with code zero and no signal, the debugger
closes, and a new process presents a usable composer.

The application still owns cleanup and exit. The inspector closes only when
that path reaches `process.exit`; neither requesting quit nor rejecting cleanup
detaches it or bypasses cleanup. Prepared cleanup retains its receipt gate and
its existing exit path. This change touches fixture helpers and tests only.

## Final local verification

Node 22.23.2, macOS ARM64, original worker counts and zero native retries:

- Focused lifecycle/cleanup contracts: 41 tests passed.
- Native inspector/window controls: all five passed in 9.0 seconds.
- Full `npm run check` components: quality, 9,994 full tests plus seven child
  controls, and fresh build passed. Full tests took 418.35 seconds at two workers;
  146 skips and renderer bundle budgets were unchanged.
- All 19 specs calling fixture restart, plus the prior failed activity lifecycle
  spec: display 24 passed, isolated 18 passed, runtime recovery two passed.
- The seven specs containing the eight newly failed ARM teardown cases: all
  21 scenarios passed locally with the original two-worker policy in 26.5 seconds.

## Hosted evidence and limits

Main `89b6ab0b74e4349bc26383954b9e4c503c891da3`, CI `35999329890`, attempt 3:

- Intel Electron browser lifecycle failed at its first restart with the same
  `forced/settled` outcome. The hosted trace does not identify the exact native
  shutdown phase, so the local control demonstrates a defect without proving
  that it caused the hosted event.
- ARM Electron passed display tests, then eight isolated scenarios required
  forced termination after confirmed privileged cleanup. All eight recorded
  window destruction (or no retained window), the native exit call, the app quit
  listener tail and native exit returning. None recorded a post-cleanup window
  creation or activation. The bounded samples did not produce stacks before
  their existing two-second deadline. This remains a separate unresolved cause;
  a local pass does not establish that this change fixes it.
- Intel packaging passed its tests, package smoke, fuses and signatures, then
  failed the performance artifact upload with `ETIMEDOUT` during CreateArtifact.
  That transport failure does not establish a package defect.

The full Intel and ARM trace archives and raw job logs were saved outside the
repository. Earlier Linux animation and Windows ARM mascot failures are not
attributed to this correction. Other native platforms require hosted CI.
Assertions, exit proof, runtime identity, transport settlement, deadlines,
samples, workers and budgets are unchanged. No production behavior, dependency,
release metadata, migration, packaging or provider protocol changes are made.
