# Agent-led product-launch creative orchestration

`pnpm aamp:launch` runs a **product-launch** campaign the way an agency runs a
pitch: several genuinely competing concepts are developed, assessed and put in
front of a named human, and nothing is produced until that person chooses one.

The division of labour is the point of the milestone:

| Who                   | Owns                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| The specialist agents | Every creative decision: the idea, the structure, the arc, the direction, the claims they choose to make.          |
| Application code      | Constraints and orchestration: the brief, the approved inventory, the governance, the comparison, the persistence. |
| A named human         | Which concept proceeds, or that none does.                                                                         |

Nothing in `apps/aamp-cli/src/launch/` contains a concept, a hook, a caption, a
beat or a timing — `launch-source-hygiene.test.ts` asserts that against the
source itself.

---

## 1. Scope

This milestone is for **launching and showcasing the product and the brand**.
`CAMPAIGN_MODES` has exactly one member, `PRODUCT_LAUNCH`, and a request without
a `productLaunch` block is refused by name rather than planned as an ordinary
campaign. Event-specific promotion, paid direct response, creator distribution
and UGC are later modes; they are deliberately not listed as values nothing
implements.

## 2. The chain

```
campaign request (+ productLaunch brief)
  → approved production-asset manifest
  → approved product captures (aamp:capture-app session)
  → merged asset manifest (captures substituted by id)
  → governed Creative Memory (approved benchmark profile, per role)
  → Campaign Strategist  ── once
  → Creative Director    ── once per candidate slot, each told what is taken
  → concept validation (claims cite real facts; citations name given references)
  → deterministic distinctness comparison
  → per-concept benchmark assessment + originality report
  → HUMAN CONCEPT GATE  ── inspect / revise / select / reject
  → selected-concept handoff
  → Script & Timing Director → Shot Prompt Engineer → source selection
  → render manifest → FFmpeg → actual-media QA
```

The last four steps are the **existing** path, unchanged: the approved strategy
and concept are passed to `planCampaign` as `preplanned`, so the two upstream
agents are not re-run. Re-running them would produce a different concept from
the one a human approved, which is the one failure a concept gate exists to
prevent.

## 3. The brief

Add a `productLaunch` block to an ordinary campaign request:

```json
{
  "requestVersion": 1,
  "name": "example-product-launch",
  "workspaceId": "…",
  "campaignId": "…",
  "brandName": "Example Product",
  "campaignPrompt": "…the brief, in the requester's own words…",
  "objective": "…",
  "targetAudience": "…",
  "platform": "TIKTOK",
  "targetDurationSeconds": 15,
  "productFacts": [{ "id": "coverage", "label": "Coverage", "detail": "…" }],
  "cta": { "headline": "Download Free", "durationSeconds": 3 },
  "brandKit": { "logoAssetId": "logo" },
  "productLaunch": {
    "campaignMode": "PRODUCT_LAUNCH",
    "positioning": "what the product is positioned as",
    "desiredAudiencePerception": "what they should believe afterwards",
    "prohibitedClaims": ["…never claim this, in any wording…"],
    "creativeConstraints": ["…"],
    "brandIdentity": {
      "voice": "…",
      "personalityAttributes": ["…"],
      "prohibitedTone": ["…"]
    },
    "requiredVariants": [
      { "id": "short", "label": "Six second cutdown", "durationSeconds": 6, "purpose": "…" }
    ],
    "conceptCandidateCount": 4,
    "benchmarkProfileName": "launch-benchmark",
    "approvedReviewerIds": ["reviewer-1"],
    "budgetCeilingCents": 5000,
    "requiredCaptureIds": ["app-information", "app-prediction"]
  },
  "sourceAssetManifest": "assets.json",
  "captureManifest": "captures.json"
}
```

`productFacts` are the only source of truth about the product. A concept's
`factualProductClaims` must cite one by id, and a claim that cites nothing is
refused as an invented claim — this is why the launch path formats the factual
constraints as `PRODUCT [coverage] — Coverage: …`, so the agent can see the id
it must cite.

`requiredVariants` are recorded and assessed, not rendered: this milestone
produces the master only, and a concept that cannot survive the shortest variant
is a feasibility finding a reviewer sees before choosing.

## 4. Commands

```powershell
pnpm aamp:launch plan `
  --request examples/example-launch.request.json `
  --assets  examples/example-assets.json `
  --captures .aamp-output/captures/session.json `
  --benchmark-profile launch-benchmark `
  --output-dir .aamp-output/launch

pnpm aamp:launch inspect --run <run-directory>

pnpm aamp:launch revise `
  --run <run-directory> `
  --concept <concept-id> `
  --feedback feedback.txt `
  --reviewer <user-id>

pnpm aamp:launch select `
  --run <run-directory> `
  --concept <concept-id> `
  --reviewer <user-id>

pnpm aamp:launch reject `
  --run <run-directory> `
  --reviewer <user-id> `
  --feedback feedback.txt

pnpm aamp:launch render --run <run-directory>
```

`--output-dir` is the **root** the run directory is created inside; `plan`
prints the exact run directory, and that is what every other command takes as
`--run`.

`inspect`, `select` and `reject` construct **no provider at all** — they never
call `createAampDependencies`, so a reviewer reading concepts and approving one
cannot spend money. That is a property of the object graph, not a promise.

`--fixture-demo` runs the deterministic launch fixture instead of a paid model.
Every artefact of such a run says `FIXTURE`, `isRealCampaignRun: false` and
`DEMONSTRATION ONLY`, and `--execution-mode production` refuses it outright.

## 5. What the agents produce

Each concept is a validated `LaunchConcept`:

- a title, a central idea, and the audience response it intends;
- seven **structural axes**, each a value from a closed vocabulary plus the
  agent's own direction for it — narrative structure, emotional arc, product
  presence, interface presentation, pacing, sound design, end frame;
- the relationship between the culture and the product;
- cinematography, motion-design and typography direction;
- the asset roles it needs, each REQUIRED or PREFERRED;
- every factual claim, each citing the product fact that makes it true;
- the implications it must never be read as making;
- its originality rationale and, for each craft pattern it took from Creative
  Memory, the reference it came from and how it was applied;
- a feasibility assessment naming the captures it cannot be produced without.

The closed vocabularies exist so distinctness can be compared deterministically
rather than by an arbitrary embedding threshold. Choosing among them, and
everything said about the choice, is the agent's work.

## 6. Distinctness

`assessLaunchConceptDistinctness` compares eight axes: the seven vocabulary
values by equality, and the central idea by content-word overlap (the same
technique the originality evaluator uses for copied phrasing).

- **Every pair** must differ on at least **3 of 8** axes. Below that the pair is
  `superficiallyDuplicated` and the whole set is refused.
- Central ideas at or above **0.6** overlap count as the same axis value.
- **The set** must vary on at least **4 of 8** axes, which catches four
  candidates that are the same shape with different words even when no single
  pair collides.

The report names every pair, every shared axis and every differing one, so a
refusal is explainable to whoever wrote the concepts. Exit code **14**.

## 7. Benchmark assessment

Ten dimensions per concept, each carrying a `basis` that says what it rests on:

| Dimension             | Basis                             |
| --------------------- | --------------------------------- |
| STRATEGIC_CLARITY     | `HUMAN_JUDGEMENT_REQUIRED`        |
| PRODUCT_COMPREHENSION | `DETERMINISTIC_STRUCTURAL_SIGNAL` |
| EMOTIONAL_IMPACT      | `HUMAN_JUDGEMENT_REQUIRED`        |
| BRAND_DISTINCTIVENESS | `HUMAN_JUDGEMENT_REQUIRED`        |
| NARRATIVE_COHERENCE   | `HUMAN_JUDGEMENT_REQUIRED`        |
| VISUAL_FEASIBILITY    | `MEASURED_FROM_INVENTORY`         |
| ASSET_FEASIBILITY     | `MEASURED_FROM_INVENTORY`         |
| SOUND_OPPORTUNITY     | `MEASURED_FROM_INVENTORY`         |
| ORIGINALITY_RISK      | `DETERMINISTIC_STRUCTURAL_SIGNAL` |
| PLATFORM_SUITABILITY  | `DETERMINISTIC_STRUCTURAL_SIGNAL` |

A dimension whose basis is `HUMAN_JUDGEMENT_REQUIRED` carries the verdict
`NOT_ASSESSED`, and the schema refuses any other value for it. Nothing here
predicts conversion or performance, and `agencyGradeClaim` is a literal with one
value: `NOT_ASSESSED`.

A concept is **not selectable** when it states a prohibited claim outright, when
the approved inventory cannot produce it, or when the deterministic originality
gate returned HIGH. It is never unselectable for a taste reason — that is the
reviewer's decision, not the system's.

## 8. The human gate

- Concept versions are **written once**. `writeConceptVersion` refuses to
  overwrite; a revision is version N+1 carrying `supersedesVersion`, and version
  N stays on disk exactly as the reviewer read it.
- A revision goes **back through the agent**: the reviewer's feedback travels in
  the Creative Director's existing `revisionFeedback` field. No code path edits
  concept JSON.
- A selection names the reviewer, the instant, and the **checksum** of the exact
  concept bytes approved. A concept edited afterwards is refused at render.
- Refusals are typed and distinct: `SUPERSEDED_VERSION`, `STALE_CAMPAIGN_PROMPT`,
  `CROSS_WORKSPACE`, `WRONG_CAMPAIGN`, `REVIEWER_NOT_APPROVED`, `NOT_SELECTABLE`,
  `ALREADY_SELECTED`, `UNKNOWN_CONCEPT`, `UNKNOWN_VERSION`.
- A reviewer may reject the whole set with written feedback; the run is then
  closed and nothing from it can be selected.

`render` without a recorded selection exits **15** and names the command to run.

## 9. Run directory

```
launch-run.json                       the run manifest, written before any model runs
campaign-request.json                 the request, verbatim
production-assets.merged.json         the approved library with captures substituted
capture-verification.json             eligible, review-required, required, merged
strategy.json                         the strategy the whole competition was built on
concept-set.json                      the candidate ids, in the order produced
distinctness-report.json              every pair, every axis
concepts/<id>.v<n>.json               one immutable concept version
concepts/<id>.v<n>.assessment.json    its benchmark assessment and originality report
concepts/<id>.v<n>.director.json      the full agent result, for the handoff
concept-ledger.json                   the append-only index of versions
creative-memory-provenance.json       every retrieval, the governing profiles, the notice
decisions/NNN-<kind>.json             one immutable human decision
concept-selection.json                written once, never overwritten
handoff.json                          what was handed to production, and on whose authority
render/                               the existing campaign run: manifest, QA, the MP4
```

## 10. Exit codes

| Code | Meaning                                                        |
| ---- | -------------------------------------------------------------- |
| 0    | success                                                        |
| 2    | invalid request, brief/flag disagreement, unenforceable budget |
| 3    | real reasoning required and unavailable                        |
| 4    | asset rights insufficient                                      |
| 5    | production assets or required product captures missing         |
| 6    | planning failure                                               |
| 7/8  | rendering failure / QA failure                                 |
| 9    | benchmark profile or Creative Memory unavailable               |
| 10   | originality risk blocked every concept                         |
| 11   | requested execution mode not attained                          |
| 12   | a collaborator could not be constructed                        |
| 13   | fewer than three valid concepts                                |
| 14   | the concepts are not distinct                                  |
| 15   | rendering attempted with no human selection                    |
| 16   | the concept version is superseded, or the brief changed        |
| 17   | provenance missing or checksum mismatch                        |
| 18   | the gate refused this decision                                 |

## 11. Budget

The brief's `budgetCeilingCents` is **enforced, not recorded**. A real run
computes a maximum from operator-declared rates
(`BENCHMARK_INPUT_COST_CENTS_PER_MTOK` / `..._OUTPUT_...`), prints it before the
first call, and refuses if it exceeds the ceiling. Without declared rates there
is no ceiling to check against, so a paid run is refused rather than authorised
against an unknown number. A `--fixture-demo` run makes no paid call at all and
records `paidProviderCallsPossible: false`.

## 12. Tests

```powershell
pnpm --filter aamp-cli test          # orchestration, refusals, source hygiene
pnpm --filter @combat/domain test    # distinctness and gate rules, pure

# the render demonstration, opt-in because CI never invokes FFmpeg:
$env:FFMPEG_PATH = '…\ffmpeg.exe'; $env:FFPROBE_PATH = '…\ffprobe.exe'
pnpm --filter aamp-cli test
```

## 13. What is proven, and what is not

**Proven.** Three to five structured concepts authored by the existing Creative
Director agent; the campaign prompt, the product truths and the prohibited
claims reaching every planning agent's input; role-specific Creative Memory
injected under an approved benchmark profile with references staying
analysis-only; a set of superficial rewrites refused; per-concept assessment and
originality persisted; rendering impossible before selection; a revision going
back through the agent and creating an immutable superseding version; superseded,
stale, cross-workspace and unapproved-reviewer selections refused; the approved
concept reaching script and shot planning with its provenance intact; and — with
FFmpeg present — an ffprobe-verified 1080×1920 h264 MP4 at 15 s passing
actual-media QA from synthetic `lavfi` sources.

**Not proven.** Creative quality. Every test above runs against a deterministic
fixture reasoning provider, which demonstrates the mechanism and says nothing
about how a real model would use the brief or the benchmark context. No paid
model has produced a launch concept in this repository. Until a real reasoning
run happens and a human reviews the result, the quality of what this system
produces is unknown, and no artefact it writes claims otherwise.
