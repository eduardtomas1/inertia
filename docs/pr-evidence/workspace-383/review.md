# Issue #383 verification

The original issue and its linked recording were reviewed on 2026-09-15.
After opening the local folder, the recording shows the new project in the
workspace header while the sidebar still shows the old project's filter and
threads. The reporter then opens the project picker and manually selects the
new project. PR #390 addresses this observed mismatch.

`project.create` already publishes the newly created project as active. The
fix makes the sidebar scope follow that new identity. Ordinary activation of
an existing project preserves the independently chosen filter. Keeping the
scope in AppLayout also covers additions while the sidebar is collapsed.

Review validation used the PR source integrated with reviewed PR #391 head
`3124882e9dbd5bbebe4ddb0528d53773c2f8bbed`:

- Focused renderer and legacy-upgrade tests: 66 passed in three files.
- Native Electron on macOS ARM64: both project-add scenarios passed. These
  exercise the actual import dialog, IPC, runtime and database. The filter
  follows a new folder; clicking New chat persists a conversation owned by
  that same active project. The checks also cover an addition through the
  command palette with the sidebar collapsed, a cancelled native picker and
  a rejected file path. Failed/cancelled imports retain the chosen scope and
  the next chat uses that project.
- Negative control: disabling only the new-project scope update makes both
  ordinary-add and collapsed-sidebar renderer regressions fail with the old
  project still selected. Restoring the update passes these checks.
- Initial loading, adding an inactive project, ordinary project activation,
  and an explicitly chosen All projects scope are covered by renderer tests.

The reporter's recording was used for private analysis only. The checked-in
screenshots contain disposable synthetic project data.

## Bundle measurements

Node 22.23.2, macOS ARM64, same installed lockfile graph and build commands.
The baseline is reviewed #391; the candidate adds #390. Measurements use the
repository's static import closure calculation, in emitted bytes.

| Measurement | Baseline | Candidate | Increase |
| --- | ---: | ---: | ---: |
| Main workbench first load | 810,794 | 811,095 | 301 |
| Core JavaScript | 2,114,728 | 2,115,046 | 318 |
| Detached chat first load | 620,226 | 620,226 | 0 |

The existing PR's revised caps cover the measured addition. Deferred route
caps, detached caps, runtime code and the dependency graph are unchanged.
