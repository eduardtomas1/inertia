# Beautiful UI primitive mapping

Inertia ports the Beautiful UI motion implementation onto real agent state. For
compatible surfaces, the duration, delay, easing, stagger, transform, blur, and
opacity behavior is copied exactly; only the data binding and Inertia-specific
layout change. It does not add a component gallery or simulate data that the
local runtime does not own. Motion pauses with the document and has a
`prefers-reduced-motion` fallback.

The exact motion contract includes the 650 ms Drive/Dots and 950 ms Orbit pixel
sequences; 1.4 s label shimmer; 320 ms reasoning rows with 120 ms staggering;
420 ms streamed-word blur; 350 ms approval-page entrance and 300 ms pager-dot
interpolation; 300 ms tool disclosures with 80 ms staggering; 450 ms task rows
with 80 ms staggering; 180 ms prompt popovers; 400 ms context cards with 100 ms
staggering and 700 ms source reveal; 300 ms filter-row collapse; and 500 ms
insight-meter interpolation. The shared ease curve is
`cubic-bezier(0.23, 1, 0.32, 1)` wherever the reference uses its EASE constant.

The live integration keeps motion tied to authoritative runtime updates. Newly
appended commentary words use stable spans only for the most recent 96 words,
new tool actions enter as they join the execution stream, and delegated-agent
rows reuse the task grammar for running, waiting, completed, and failed states.
Status text remains visible beside every decorative mark, so color and motion
are never the only signals.

| Beautiful UI reference | Inertia surface                       | Product adaptation                                                                                                                                                          |
| ---------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading State          | Active response timeline              | Dots, Drive, and Orbit reflect waiting, tool execution, and reasoning. The video-like Surfer treatment is omitted because it does not communicate a distinct runtime state. |
| Thinking               | Reasoning summary and work disclosure | Staggered, expandable reasoning steps with a stable active marker.                                                                                                          |
| Streaming Text         | Final answer and commentary stream    | Incremental markdown plus a bounded escaped-text fast path, caret, code/table stabilization, copy actions, and durable follow-ups.                                         |
| Approval Card          | Approval and input-request cards      | Privileged actions remain explicit; multi-question requests use a paged, keyboard-native flow that preserves answers.                                                       |
| Tool Chips             | Work log and changed-files summary    | Compact categorized tool rows with visual state marks, expandable technical output, truthful warning states, and per-file insertion/deletion totals.                        |
| Task Rows              | Plan, goal, and delegated-agent rows  | Connected status rows with pending, running, waiting, completed, blocked, and failed states.                                                                                |
| Chat                   | Conversation workspace                | The primary product surface already provides provider-aware chat, live work, history, and a composer.                                                                       |
| Prompt Bar             | Composer                              | `@` file context, `/` commands, attachments, model/reasoning/access controls, skills, dictation-ready input, and follow-up queuing.                                         |
| Recommendation Card    | Approval and selection-review answers | Agent proposals can be accepted, revised, or denied; no confidence score is invented when providers do not supply one.                                                      |
| Context Cards          | Composer and sent-message attachments | Bounded file/image context is grouped, typed, sized, previewable, and removable before submission.                                                                          |
| Diff Table             | Changes panel                         | Proposed edits are represented by authoritative Git diffs with file/hunk review, notes, revision requests, and reversible selection actions.                                |
| Records Table          | Usage breakdown                       | Keyboard-scrollable model/day records with provider identity, coverage, token share, and request totals.                                                                    |
| Filter Table           | Changes review toolbar                | Live All, Unreviewed, and Reviewed chips include current hunk counts and update the diff without losing review state.                                                       |
| Sidebar Nav            | Project and activity sidebars         | Existing workspace navigation, recent tasks, unread/pinned state, compact mode, and project/repository identity remain authoritative.                                       |
| Search                 | Command palette and project search    | Existing keyboard command palette and bounded project-file search provide live filtering and empty states.                                                                  |
| Flowchart              | Plan panel and subagent tree          | Connected steps and nested agent traces expose real execution order and status without pretending to be a workflow editor.                                                  |
| Insight Cards          | Usage overview                        | Provider cards and the keyboard-scrubbable daily chart surface measure local usage and expose coverage limitations.                                                         |
| Code Block             | Response markdown                     | Streaming-safe highlighted code, wrapping, copy, file identity, and open-file actions.                                                                                      |
| Fine-tune Card         | Composer and appearance settings      | Existing model, reasoning, access, density, scale, and theme controls adjust real application behavior. A design-property inspector is intentionally out of scope.          |
| Selection Actions      | Diff review                           | Line/range selection supports Ask, Request revision, Revert, Note, and Add to prompt with Git-layer revalidation.                                                           |

The mapping is deliberately semantic at the data layer, not approximate at the
motion layer: a reference is incorporated when it improves a real Inertia
workflow, and declined when it would require fabricated confidence, data, or
capability.
