# Routing and orchestration

This document describes Auto routing (the smart model chooser), how it fits
the runtime that already exists, and the phased plan for the pickers and the
orchestrator layer that build on it. Release 1 ships the routing core
described in [What ships first](#what-ships-first-routing-core).

## What already exists

- **One validated route change.** A chat's model is its `modelSelection`. A
  change goes through `conversation.update`, which validates the selection
  (`validateSelection`), resolves the provider route (`resolveModelRoute`) and
  decides whether the provider session can continue
  (`resolveContinuationDecision`). The update is refused during an active run
  and on Duo-locked judge chats. A provider change becomes a Context handoff
  at the next turn.
- **Several paths queue turns.** `message.send`, `todo.start`, agent-thread
  create and send, Duo, Private Connect, queued follow-ups and limit-reset
  dispatch all reach `turns.queue`. Per-turn request preparation is too late
  for routing because it already requires the chat's provider to match, so
  routing runs before the queue step.
- **Delegation primitives.** The `inertia.orchestration` capability pack lets
  a native agent create and steer other chats under strict limits (depth 2,
  three active children, bounded creates and mutations per turn, every
  mutation approved by the user, children cancelled with the parent turn).
  Duo is a durable, restart-safe fan-out-then-judge coordinator. Isolated runs
  execute a provider read-only with timeouts and output caps.
- **Usage data.** Provider rate-limit windows (`usedPercent`, `resetsAt`),
  usage-limited turn evidence and per-turn token usage are already collected.

## Design

Three independently toggleable features, all off by default. Runtime logic
lives in `src/server`; the renderer only edits settings and shows state.

### Auto routing

A chat in **Auto** has no fixed model: the runtime chooses one for each new
message and records why. Choosing a model, reasoning level or Fast mode turns
Auto off for that chat, saved or still a draft (one click overrides). Turning
Auto on or off is allowed during a run because it only affects the next
message. Auto can be the default for new chats.

The pipeline is deterministic and testable:

1. **Catalog.** Candidates are the enabled providers' advertised models and
   reasoning levels, plus enabled custom backends. Hard filters: signed in and
   runnable, model still advertised, reasoning level offered, Fast mode
   offered when requested, images or scanned PDF pages attached ⇒ the model
   reads images, the provider's per-message image limit holds, account
   not usage limited and above the quota reserve, weight not Never, and the
   authoritative selection validator accepts the route.
2. **Features.** Extracted locally from the message: length, lines, code
   blocks, stack traces, attachment kinds, referenced files and chats, keyword
   classes (fix/debug → debugging, implement/add → feature, explain/why →
   question, review/audit → review, compare/research → research,
   plan/design → planning, typo/rename → small edit), depth or brevity cues,
   first turn or follow-up, prior turn count, whether the previous turn
   failed, and the previous routed tier.
3. **Picker.** One interface, `(input) => Promise<{ tier, taskKind,
   confidence, trace }>`. A picker returns a tier and a task kind, never a
   model id, so a hallucinated model slug is impossible by construction.
4. **Tier presets.** Four tiers — Light, Standard, Heavy, Max — each an
   ordered list of presets (provider, backend, model, reasoning, Fast mode)
   weighted Prefer, Normal, Less often or Never. A tier the user has not
   customised is derived from the live catalog: Light is a provider's
   lowest-ranked model at its lowest reasoning, Standard its default model at
   its default reasoning, Heavy its highest-ranked model at high reasoning and
   Max that model at its highest reasoning with Fast mode off. The user's
   default provider is preferred.
5. **Constraint solver.** Score = weight rank (Prefer 3, Normal 2, Less 1)
   minus a stickiness penalty for leaving the chat's provider (sticky mode
   only, and only once the chat has turns) minus a small penalty for low
   remaining quota. Ties keep preset order. Below the confidence threshold the
   fallback tier applies, and the decision is marked low confidence only when
   that changes the tier. A tier without a valid candidate steps toward
   Standard one tier at a time, then any tier, then keeps the current route.
   While the chat's provider is being checked (install or sign-in probe, or an
   unresponsive CLI) the current route stays.
6. **Apply.** The chosen selection goes through the same conversation update
   service that the renderer's `conversation.update` uses, so provider-session
   reset and the continuation decision are identical to a manual change. A
   refused update keeps the current route and records why. The chat is re-read
   just before the update, so a mode or model change made meanwhile wins. If
   the routed route then fails provider readiness, the previous route is
   restored through the same service (outcome `kept`) and checked as usual.
   Routing never fails the user's message.

**Mid-chat policy.** Sticky by default: Auto stays on the chat's provider and
still adjusts model and reasoning within it. When the chosen tier has nothing
on that provider, the fallback tiers are tried there first; Auto leaves the
provider only when no tier has a candidate on it.
Rebalance removes the provider penalty. Every switch is visible on the
composer badge and in the turn's recorded decision.

### Pickers

- **Rules** (built in, default): a heuristic classifier over the local
  features. Offline and free. Confidence is the margin between the two best
  tier scores, normalised to 0–1.
- **Jev** (planned): a hosted decision model asked narrow Choice/Score
  questions over a structured state. Opt-in, consent dialog showing the exact
  payload, privacy mode that sends only the feature digest, key in the
  main-process credential vault, strict response validation, timeouts and the
  rules picker as fallback. Deterministic fixtures for success, failure,
  timeout, malformed and oversized responses.
- **Model** (planned): an isolated read-only run on a cheap model of a
  provider the user already uses, returning constrained JSON.

### Orchestrator layer (planned)

A chat switched to **Orchestrate** becomes a coordinator; the runtime runs
the plan. It extends the existing orchestration capability pack (plan tasks,
delegate, wait, status) and follows the Duo coordinator pattern: durable plan
and step tables, request-derived ids for idempotency, restart recovery and
settlement hooks. The runtime, not the prompt, enforces concurrency slots,
depth, the privilege ceiling (a child never exceeds its parent's access),
isolation per step, health monitoring, bounded and untrusted results, and
approval aggregation at the coordinator so a supervised child never blocks
unseen. Finished steps go to review, not done. Role routing reuses the tier
presets: planner on Heavy, implementers on Standard, a reviewer on a
different provider.

## Phasing

| # | Release | Value |
|---|---------|-------|
| 1 | Routing core: rules picker, Auto route, decision badge, Settings → Routing | Auto routing works offline |
| 2 | Re-route on usage limit | Replaces the manual "Continue with another model" when enabled |
| 3 | Jev picker with consent, privacy mode and vault key | Hosted decisions |
| 4 | Model picker through isolated runs | No new third party |
| 5 | Orchestrator core: coordinator, plan and step tables, slots, recovery | Delegation that survives restarts |
| 6 | Orchestrator UI: plan tree, approvals strip, rollup | Visible multi-agent work |
| 7 | Pipelines and role routing | Code-driven workflows |
| 8 | Routing report and suggested rules | Feedback loop |

## What ships first: routing core

- **Contracts.** `src/shared/routing/` holds the pure policy: vocabulary and
  strict settings schema (`routing-policy.ts`), feature extraction
  (`routing-features.ts`), the rules picker (`routing-rules-picker.ts`), the
  catalog and default preset derivation (`routing-catalog.ts`) and candidate
  filtering, scoring and the fallback chain (`routing-planner.ts`).
- **Runtime.** `RouteAdvisor` (`src/server/runtime/routing/`) builds the
  catalog, runs the picker and planner, validates every candidate with the
  authoritative selection validator and applies the result through
  `ConversationUpdateService`, which the `conversation.update` handler also
  uses.
- **Where it runs.** Only `message.send` (a fresh user message, with turn
  admission held, after attachment and document preparation and immediately
  before provider readiness) and `todo.start` (the task's first turn, whose
  routed route must pass the same readiness check). Duo stays explicit
  because comparison is the point. Queued follow-ups keep the route they were
  queued for, limit-reset and restart-continuation dispatches keep their
  recorded route, and Private Connect and agent-thread creates and sends keep
  their explicit routes in this release.
- **Persistence.** Migration 99 adds `app_state.routing_settings_json`
  (bounded to 64 KiB), `conversations.routing_mode` (`manual` or `auto`,
  default `manual`) and `agent_turns.routing_json` (bounded to 4 KiB). Every
  existing chat stays manual.
- **Recorded decision.** Each routed turn stores `{ picker, tier, taskKind,
  confidence, outcome, reason, previousRoute }`, where outcome is `applied`,
  `kept`, `fallback` or `low-confidence`. The composer badge reads
  "Auto · model" beside the effort control; its tooltip shows the full route
  with effort, the latest decision and the override hint, one per line.
- **New chats.** With **Use Auto for new chats**, chats created from the
  composer and tasks start in Auto; their initial model is still the normal
  new-chat default until the first message is routed.

## Invariants

- Pickers return tiers, never model ids; tiers map only to validated catalog
  entries.
- An automatic change never bypasses `validateSelection →
  resolveModelRoute → resolveContinuationDecision`, never runs during an
  active run and never discards a provider session outside the validated
  update path.
- Routing never fails the user's message; failures keep the current route
  and say why.
- Features never leave the runtime process in this release. A hosted picker
  must be opt-in, show its payload and keep credentials in the vault.
- Settings input and stored JSON are strictly validated and bounded; unknown
  keys are refused.
- Everything is off by default and enforced by the runtime; the renderer only
  hides or shows UI.
