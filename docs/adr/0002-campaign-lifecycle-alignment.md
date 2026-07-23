# ADR-0002: Align the implemented campaign lifecycle with the production workflow

Status: Accepted
Date: 2026-07-23

## Context

`docs/architecture.md` §3.1 originally sketched an illustrative 19-stage
campaign production pipeline (`INTAKE` through `DELIVERED`) with three
structurally-unbypassable human approval gates (concept, shot selection,
final master) and an explicit decision to keep performance analysis **out**
of that pipeline, running instead as a separate, independently-triggered
`PerformanceAnalysisWorkflow` over completed campaign/distribution records —
specifically so the production workflow could complete without waiting days
or weeks for advertising results.

A subsequent domain-modeling milestone implemented a persistence layer and
state machine for this pipeline (`packages/domain/src/workflow`,
`packages/database`'s transition service) but did so from a re-derived
17-stage list rather than the original 19-stage design. A read-only
reconciliation against docs/architecture.md found several unintended
deviations in that implementation:

- `PERFORMANCE_COLLECTION` and `ITERATION_PLANNING` were added as stages
  _inside_ the linear campaign-production state machine — a direct reversal
  of §3.1's explicit decoupling rationale.
- `VISUAL_QC` and `CONTINUITY_CHECK` were collapsed into a single
  `AUTOMATED_QA` stage, losing the distinct revision routing the original
  design gave each (they fail for different reasons and need different
  regeneration instructions).
- `SOUND_DESIGN` was dropped as a distinct stage.
- `VARIANT_GENERATION`/`VARIANT_QA` were dropped as distinct stages, along
  with their retry loop.
- The approval-gate set had grown from 3 to 5 (adding `STRATEGY` and
  `SCRIPT` gates not in the original design).

This ADR records the correction.

## Decision

The canonical campaign-production state machine is now the following
**20-stage** pipeline (`packages/domain/src/workflow/campaign-stage.ts`,
mirrored exactly in `packages/database/prisma/schema.prisma`'s
`CampaignStage` enum):

```
DRAFT -> STRATEGY_REVIEW -> CONCEPT_REVIEW -> SCRIPT_REVIEW -> ASSET_COLLECTION
  -> PROMPTING -> SHOT_GENERATION -> VISUAL_QA -> CONTINUITY_QA
  -> HUMAN_SHOT_SELECTION -> COMPOSITING -> ROUGH_CUT -> SOUND_DESIGN -> FINAL_QA
  -> FINAL_APPROVAL -> VARIANT_GENERATION -> VARIANT_QA -> EXPORTING
  -> READY_FOR_DISTRIBUTION -> DISTRIBUTED
```

1. **`PERFORMANCE_COLLECTION` and `ITERATION_PLANNING` are not
   campaign-production stages.** They do not appear in `CampaignStage` at
   all. Performance analysis remains a separate, decoupled
   `PerformanceAnalysisWorkflow` operating on completed campaign and
   distribution records, exactly as originally decided in §3.1. The
   production workflow reaches a terminal state (`DISTRIBUTED`) and
   completes without waiting on advertising results.
2. **`VISUAL_QA` and `CONTINUITY_QA` remain separate stages**, each with its
   own bounded-retry revision edge back to `SHOT_GENERATION`
   (`visualQARetryAllowed` / `continuityQARetryAllowed`, both capped at
   `MAX_SHOT_GENERATION_ATTEMPTS = 3`) — they fail for different reasons
   (visual defect vs. cross-shot continuity conflict) and are tracked
   independently.
3. **`SOUND_DESIGN` remains a distinct stage**, with its own typed-failure
   routing (see below).
4. **`VARIANT_GENERATION` and `VARIANT_QA` remain distinct stages**, with
   their own retry loop (`VARIANT_QA -> VARIANT_GENERATION` on failure).
5. **`EXPORTING`, `READY_FOR_DISTRIBUTION`, and `DISTRIBUTED` remain
   distinct.**
6. **The only mandatory human approval gates are three**, matching the
   original architecture exactly:
   - `CONCEPT_REVIEW -> SCRIPT_REVIEW` (gate `CONCEPT`)
   - `HUMAN_SHOT_SELECTION -> COMPOSITING` (gate `SHOT_SELECTION`)
   - `FINAL_APPROVAL -> VARIANT_GENERATION` (gate `FINAL`)

   `ApprovalGate` (`packages/domain/src/schemas/shared-enums.ts`) is `CONCEPT
| SHOT_SELECTION | FINAL` — no `STRATEGY` or `SCRIPT` gate value exists.

7. **`STRATEGY_REVIEW` and `SCRIPT_REVIEW` are checkpoint stages, not
   approval gates.** Their forward edges require only that the relevant
   upstream artifact exists (`conceptDrafted`, `scriptDrafted`) — no
   `HumanApproval` record is created or checked. This is deliberate, not an
   oversight: a future decision may add a real approval or automated-check
   entity here, but none exists yet, so none is required. `SCRIPT_REVIEW`'s
   sole revision edge (`SCRIPT_REVIEW -> CONCEPT_REVIEW`) is consequently the
   **one** transition in the table with an empty `requiredFacts` list — every
   other transition has at least one real, DB-derived prerequisite.
8. **No transition bypasses a mandatory gate.** Every path into
   `SCRIPT_REVIEW`, `COMPOSITING`, or `VARIANT_GENERATION` from an _earlier_
   stage passes through its gated edge; the only edges that re-enter a
   stage just downstream of a gate are revision loops that already passed
   that gate once (e.g. `VARIANT_QA -> VARIANT_GENERATION`), which is a
   retry, not a bypass. See `transition-rules.test.ts`'s
   `'mandatory human approval gates'` suite for the executable proof.

### Typed failure routing

Three stages have more than one valid revision target and are disambiguated
by a **typed failure category**, not caller say-so:

| Stage            | Targets                                         | Driven by                                                                                                   |
| ---------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `COMPOSITING`    | `HUMAN_SHOT_SELECTION` or `COMPOSITING` (retry) | `QualityFailure.category`: `SHOT_UNUSABLE` or `COMPOSITING_TECHNICAL`                                       |
| `SOUND_DESIGN`   | `ROUGH_CUT` or `SOUND_DESIGN` (retry)           | `QualityFailure.category`: `EDIT_TIMING` or `AUDIO_TECHNICAL`                                               |
| `FINAL_QA`       | `COMPOSITING`, `ROUGH_CUT`, or `SOUND_DESIGN`   | `QualityFailure.category`: `COMPOSITING_TECHNICAL`, `EDIT_TIMING`, or `AUDIO_TECHNICAL`                     |
| `FINAL_APPROVAL` | `COMPOSITING`, `ROUGH_CUT`, or `SOUND_DESIGN`   | `HumanApproval.repairTarget`, human-selected, required exactly when `gate=FINAL` and `decision != APPROVED` |

`packages/domain/src/workflow/quality-failure-routing.ts` is the single
source of truth mapping each category to its target stage; the database
layer's fact derivation (`transition-facts.ts`) never hardcodes this mapping
a second time. `QualityAssessment.subjectStage` (a new nullable
`CampaignStage` column) disambiguates which stage's output a given asset-based
assessment concerns, since `COMPOSITING`/`ROUGH_CUT`/`SOUND_DESIGN`/`FINAL_QA`
now share the same generic assessment subject shape.

`ROUGH_CUT`'s single revision target (`-> COMPOSITING`) and `EXPORTING`'s
technical-retry loop (`-> EXPORTING`) and `DISTRIBUTED`'s reversion
(`-> READY_FOR_DISTRIBUTION`) do not need category disambiguation — each has
exactly one target, gated on a simple existence/status fact instead.

## Consequences

- `ApprovalGate`, `QualityFailureCategory`, `CampaignStage` (Zod and Prisma),
  `TransitionFacts`, and `CAMPAIGN_TRANSITIONS` all changed. This is a
  pre-migration correction: no live migration had been applied in this
  environment (no Docker, no local Postgres), so `schema.prisma` was edited
  directly rather than through a rewritten migration history — see
  `docs/domain-model.md` §8.
- The transition table grew from 24 entries (16 forward + 8 revision) to 38
  (19 forward + 19 revision) to represent the restored stages and typed
  routing. Every entry is exercised by the exhaustive valid/invalid sweeps in
  both `packages/domain`'s and `packages/database`'s test suites.
- `HumanApproval` gained one nullable field (`repairTarget`), used and
  validated only for `gate=FINAL` rejections.
- `QualityAssessment` gained one nullable field (`subjectStage`).
- Two documented MVP heuristics from the prior milestone are retained
  unchanged in spirit: fact derivation checks for the _existence_ of a
  matching row rather than resolving "the current, most-recent state" with
  full precision in every case, and some signals (e.g.
  `distributionFailureDetected` and `variantQAFailed` both currently read
  `CreativeVariant.status === 'FAILED'`) share an underlying data source
  because no more specific entity exists yet — see `docs/domain-model.md` §5
  for the complete, current list.

## Alternatives considered

- **Patch the prior 17-stage implementation's documentation only** (the
  originally proposed smallest repair) — rejected once the reconciliation
  surfaced that the 17-stage machine wasn't merely differently-named but
  actively contradicted a settled architectural decision (performance
  analysis decoupling) and dropped real routing capability (continuity vs.
  visual QC, audio vs. edit revision, variant QA retry). A documentation
  note cannot fix a behavioral gap in what ships.
- **Keep 5 approval gates (adding STRATEGY/SCRIPT)** — rejected per this
  ADR's decision 9/10 equivalent: broadening the gate set was never a
  requirement, only an artifact of over-generalizing "review stage" to mean
  "approval gate" during the prior implementation.
