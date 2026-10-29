# Custom agents: characters and inline calls

All ten screenshot categories from PR #684 are restored with fresh captures.
The earlier four filenames are retained as aliases to the new full-app views.

| Capture | Scenario |
| --- | --- |
| [01](01-settings-empty.png) | Empty library and presets |
| [02](02-settings-editor.png) | Editor, larger mark gallery and 128 px character preview |
| [03](03-settings-list.png) | Six agents with unframed 64 px characters |
| [04](04-composer-calling-menu.png) | `/calling` suggestions |
| [05](05-composer-chip.png) | Selected agent and draft, retained after reload |
| [06](06-transcript-live.png) | Running called agent, child task, activity and stop control |
| [07](07-transcript-done.png) | Completed call and subsequent in-role Writer call |
| [08](08-settings-import-notice.png) | Import conflict renamed to `investigator-2` |
| [09](09-settings-light.png) | Agent library in light appearance |
| [10](10-marks-family.png) | All twelve bundled WebPs, without frames |
| [11](11-editor-light.png) | Enlarged gallery in light appearance |
| [12](12-transcript-expanded-light.png) | Expanded result in light appearance |
| [13](13-transcript-narrow.png) | Expanded result at 1000 px viewport width |

## Design reference

The called-agent presentation follows T3 Code's
[`SubagentTimelineLink`](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/chat/V2LifecycleRow.tsx):
a compact identity/detail row with status, elapsed time and a trailing chevron.
Inertia keeps its expandable report, child tasks and stop action. The surrounding
card, accent edge, haze and avatar frame are removed. Only the character's small
lift remains while working; reduced motion disables it.

## Capture scope

Inertia Browser captured the production `App` and its real settings, composer
and transcript components in a local Vite fixture. The fixture replaces the
runtime connection and desktop bridge with synthetic agents, conversation
turns and subagent events. Create/update/import commands mutate this fixture
in memory; the import dialog result is simulated. It does not run a real
provider, read user conversations, or exercise native Electron IPC.

The gallery sheet displays the actual twelve bundled WebPs. All other captures
show the full production app shell. Standard captures are 1512×868; the editor
views are 1512×1180 to show the complete form, and the narrow transcript is
1000×868. No compositing or retouching is applied to the screenshots.

The real controls were exercised for edit → choose mark → save, `/calling`
suggestions → select → reload with the selected agent, and transcript
collapse/expand. DOM tests cover keyboard selection, stop handling, auto-collapse,
focus restoration and remembered disclosure state.

Snapshot audits report no unnamed controls. They do flag existing focusable
shell containers as overlapping their descendants, narrow sidebar separators,
and partially visible rows at scroll boundaries. Visual review checked the
changed controls for actual overlap and clipping in both themes and at the
narrower transcript viewport.

After capture, the chat-row character was reduced from 56 px to 36 px and
its spacing tightened. The light-theme focus/running accent selector was also
corrected. Captures 06, 07, 12 and 13 still show the earlier chat size and need
refreshing; the browser reached its per-turn tool limit. The final changes are
checked by the focused tests and production build, without a new visual check.

## Validation

- 57 focused settings, composer, called-agent and attribution-badge tests pass
  across four files after the final resize.
- `npm run check:quality` passes after the final changes.
- `npm run build:bundle` passes, including the renderer budget checks.
- The first combined `npm run check` was terminated with SIGTERM (exit 143).
  The standalone full suite then completed: 17,786 tests passed, 107 skipped and
  two avatar-size assertions failed. The badge test still expected 18 px, and
  the running suite used the earlier 56 px transcript module while the test
  had changed to 36 px. Both files pass in the fresh 57-test focused run. The
  complete suite was not repeated after the final resize.
- The six-model Blender artifact review passes.

Final measurements: 40,313 bytes of deferred custom-agent settings JavaScript,
2,478,858 bytes of core JavaScript and 242,951 bytes of entry CSS. The measured
JavaScript deltas (+147 / +59) are recorded without additional headroom.

Packaged Electron, live provider calls, Windows and macOS were not exercised
for this presentation update.
