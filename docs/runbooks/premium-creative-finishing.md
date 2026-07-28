# Premium creative finishing

`pnpm aamp:finish` is the directed-revision pass that runs **after** a master
exists and before anyone calls it finished. It exists because the pipeline
works and the advertisement does not yet look like one — and because the usual
way that gets fixed ("make it punchier", one person re-cutting until it feels
right) leaves nothing anybody can audit, repeat or disagree with.

Three properties are load-bearing. Everything else in this document follows
from them.

- **Vague feedback is refused, not interpreted.** Every defect carries a time
  range, a category, what was observed and what must change. "Make it punchier"
  cannot become a render decision, so the schema will not accept it.
- **One axis is compared at a time.** Hook, then pacing, then audio, then CTA —
  in that order, each against a settled version of everything before it. Three
  hooks × two pacings × two mixes × two CTAs is twenty-four renders and a
  reviewer who cannot hold the comparison in their head.
- **Nothing here scores creative quality on the system's behalf.** Measured
  checks come from the produced file. Craft dimensions are
  `HUMAN_JUDGEMENT_REQUIRED` and carry no number, and no function in this
  repository produces, suggests or defaults one.

## 1. What it costs

Nothing. No reasoning provider, no generation provider, no database client and
no composition root is constructed anywhere in `apps/aamp-cli/src/finishing/` —
`finishing-source-hygiene.test.ts` asserts the imports, and the whole suite runs
with `REASONING_PROVIDER=claude` and no API key, where a campaign run exits 3.

A finishing round is footage you already have, a plan a person already wrote,
that person's judgement, and FFmpeg.

## 2. The shape of a round

```
aamp:finish brief      → a critique skeleton, pinned to one plan and one master
aamp:finish open       → a run directory, if the critique matches what it names
  for each of HOOK, PACING, AUDIO, CTA:
    aamp:finish directives → a skeleton for the stage the run is actually at
    aamp:finish propose    → control + your alternatives, all rendered and measured
    aamp:finish select     → the human decision; pins the approved bytes
aamp:finish scorecard  → an empty premium scorecard for the finished master
aamp:finish finalize   → the verdict, and every blocker by name
```

`inspect` reads a run at any point and decides nothing.

## 3. Opening a round

```sh
pnpm aamp:finish brief \
  --request apps/aamp-cli/examples/combat-reviews-preview.request.json \
  --plan    apps/aamp-cli/examples/combat-reviews-preview.plan.json \
  --master  .aamp-output/<run>/deliverable/<master>.mp4 \
  --out     finishing-brief.json
```

Fill in every `TODO`, then:

```sh
pnpm aamp:finish open \
  --request apps/aamp-cli/examples/combat-reviews-preview.request.json \
  --plan    apps/aamp-cli/examples/combat-reviews-preview.plan.json \
  --brief   finishing-brief.json \
  --assets  packages/media/fixtures/preview-asset-root \
  --output-dir .aamp-output
```

`open` refuses (exit 20) unless the critique is about **this** plan and **this**
master: the plan's canonical checksum and the master's byte checksum both have
to match what the brief pins. A critique of a different cut would be answered by
changing this one, which is the failure a pinned brief exists to prevent.

Two checksum notions are in play and they are not interchangeable:

| Thing                                 | Checksum                       |
| ------------------------------------- | ------------------------------ |
| A plan (opening, candidate, approved) | sha256 over **canonical JSON** |
| A master MP4                          | sha256 over the **file bytes** |

The `brief` command computes both, so you never have to.

## 4. Directives — where the alternatives come from

This is the question worth being precise about. The system "produces controlled
alternatives" — produced from what?

Not from taste it invented. A **directive set** is authored by the same named
person who wrote the critique, and states, per candidate, a list of structural
operations on the approved plan:

```jsonc
{
  "directiveVersion": 1,
  "stage": "HOOK",
  "authoredBy": "A Reviewer",
  "authoredAt": "2026-07-28T09:05:00.000Z",
  "basePlanSha256": "…", // what these were written against
  "candidates": [
    {
      "candidateId": "straight-in",
      "label": "Straight in on the count",
      "rationale": "Land the number before the viewer decides to scroll.",
      "addressesDefectIds": ["slow-open"],
      "operations": [{ "kind": "SET_HOOK_LATENCY", "latencySeconds": 0 }],
    },
  ],
}
```

The operation vocabulary is closed and **structural**. There is no operation
that writes a caption, a headline, a hook line or a script beat:
`SET_CAPTION_ENTRANCE` changes how a line arrives and cannot change what it
says. A finishing pass re-expresses approved material; the moment it can author
new copy it is a rewrite wearing a revision's clothes.

| Operation                              | Axis          |
| -------------------------------------- | ------------- |
| `SET_HOOK_LATENCY`                     | HOOK          |
| `RETIME_BEAT`, `SET_BEAT_MOTION`       | PACING        |
| `SET_BEAT_TRANSITION`                  | TRANSITION    |
| `SET_CAPTION_ENTRANCE`                 | TYPOGRAPHY    |
| `SET_BEAT_IN_POINT`, `SET_BEAT_SOURCE` | IN_POINT_CROP |
| `ADD_DECORATION`, `CLEAR_DECORATIONS`  | PRODUCT_HOLD  |
| `SET_MIX`, `SET_BEAT_SOURCE_AUDIO`     | AUDIO         |
| `SET_CTA_TIMING`                       | CTA           |

Each stage owns a primary axis and may move a fixed set of dependent ones — you
cannot change a hook without being allowed to change where the clip starts:

| Stage  | Compares | May also move                         |
| ------ | -------- | ------------------------------------- |
| HOOK   | HOOK     | IN_POINT_CROP, TYPOGRAPHY, TRANSITION |
| PACING | PACING   | TRANSITION, PRODUCT_HOLD              |
| AUDIO  | AUDIO    | —                                     |
| CTA    | CTA      | TYPOGRAPHY, PRODUCT_HOLD              |

An operation outside the stage's set is refused (exit 21), as is a candidate
that never moves the primary axis — that is a variation of a dependent variable
dressed as a competitor, and the stage would settle nothing.

## 5. Proposing and comparing

```sh
pnpm aamp:finish propose --run <run> --directives HOOK.directives.json
```

The run adds `control` — the approved plan, unchanged — itself. A comparison
without the current cut in it asks "which of these three?" when the honest
question is "any of these three, or what you already have?"

Every candidate renders through the **existing zero-cost preview path**,
unchanged: the same asset-root preflight, the same rights enforcement, the same
deterministic segment selection, the same actual-media QA. A candidate rendered
through a shortcut would be judged against a standard the finished master never
has to meet.

Two candidates that produce byte-identical plans are refused: a reviewer
comparing identical files learns nothing while believing they have.

Open `stages/<STAGE>/comparison.html`. No server, no network, no script; every
authored string escaped. It states what changed and never says which is better.

## 6. Selecting

```sh
pnpm aamp:finish select --run <run> \
  --candidate straight-in --reviewer "A Reviewer" --reason why.txt \
  [--feedback carried-forward-notes.json]
```

There is no `--latest`, no default and no "highest-scoring candidate". A
selection records the reviewer, the instant, the reason in their own words and
the **checksum of the approved plan**, and that checksum is verified against the
file every time it is read back — a plan edited after approval is refused with
exit 24 rather than rendered.

A candidate that never produced a master cannot be selected: a selection is a
judgement about a file that exists.

The approved plan becomes the next stage's base. That is read from the
selection, not from a "current plan" file some command keeps up to date — the
file would eventually disagree with the decision, and the decision is the thing
with a name on it.

## 7. The premium verdict

```sh
pnpm aamp:finish scorecard --run <run> --out scorecard.json   # empty
# a person fills it in
pnpm aamp:finish finalize --run <run> --scorecard scorecard.json
```

`PREMIUM_READY` requires **all** of:

1. every stage settled by a recorded human selection;
2. actual-media QA `PASS` on the finished master;
3. a scorecard written against **that** master's checksum;
4. every gated dimension at or above the brief's `gatedDimensionMinimum`;
5. the reviewer's overall score at or above `overallHumanMinimum`;
6. every `BLOCKING` defect in the brief recorded as resolved by the reviewer.

Anything missing gives `NOT_PREMIUM_READY` (exit 26) with each blocker named. A
verdict that said only "not ready" would send a reviewer back to guess which of
six conditions failed, and the usual outcome of that is the condition being
removed rather than met.

The gated dimensions are `FIRST_FRAME_STOPPING_POWER`, `HOOK_CLARITY`,
`PRODUCT_COMPREHENSION`, `EDIT_RHYTHM` and `CTA_CONVICTION` — not all nine, so
that a brief is not refused for the dimension it never cared about. Every
verdict carries `agencyGradeClaim: NOT_ASSESSED` and `requiresHumanApproval`.

## 8. The finishing decorations

The motion-treatment catalogue gained five treatments for this milestone
(`MOTION_TREATMENT_CATALOGUE_VERSION` is now **2**):

| Treatment       | What it does                                                               |
| --------------- | -------------------------------------------------------------------------- |
| `FOCUS_DIM`     | Dims everything outside a region — four filled boxes, not an alpha mask    |
| `TAP_INDICATOR` | An expanding, fading square pulse — a tap                                  |
| `LIGHT_SWEEP`   | A restrained band travelling across a region                               |
| `EDGE_VIGNETTE` | Restrained luminance falloff. Whole frame only                             |
| `FILM_GRAIN`    | Restrained temporal grain, so flat gradients do not band. Whole frame only |

One trap is worth recording, because it looks like it works. `drawbox` appears
to take expressions — and it does — but **its `t` is the thickness, not the
timestamp**, and it has no per-frame evaluation mode. `x='10+100*t'` therefore
resolves once, against the wrong variable, and draws a static box somewhere
nobody asked for. Verified against FFmpeg 8.1.2, not assumed: the box never
moves, and the frame measures black where the sweep should have been.

So the moving treatments are compiled as a series of statically-positioned
boxes, each enabled for its own slice of the window (twelve steps a second,
capped at 48). `EDGE_VIGNETTE` and `FILM_GRAIN` refuse a partial rectangle
outright rather than silently widening it — a manifest that gave one a region
asked for something the treatment cannot do.

## 9. Exit codes

| Code | Meaning                                                                     |
| ---- | --------------------------------------------------------------------------- |
| 0    | Success                                                                     |
| 7    | A stage produced no watchable candidate at all                              |
| 20   | The critique was refused — vague, contradictory, or not about this cut      |
| 21   | The directives were refused — wrong axis, wrong base plan, unapproved asset |
| 22   | A stage was taken out of order, or before it had a comparison               |
| 23   | Something needed a human selection that does not exist                      |
| 24   | A candidate is unknown, unwatched, or its bytes changed after approval      |
| 25   | A scorecard is required and none was submitted                              |
| 26   | Every stage settled, and the master still does not clear the bar            |

## 10. What is proven, and what is not

**Proven live, against real FFmpeg** (`finishing-acceptance.test.ts`, 8 rendered
candidates in one round): all four stages settled in order on recorded human
decisions; a control rendered beside every alternative with QA `PASS` on both;
each stage's approved plan carried forward as the next stage's base; a genuine
1080×1920 master at the requested duration; `FOCUS_DIM` and `LIGHT_SWEEP`
surviving into the finished cut; `PREMIUM_READY` reached only with the submitted
scorecard; a provenance trail naming every decision and its author; a comparison
page with no script, no network and no verdict language; and no absolute path in
the shared artefacts.

**Proven with no FFmpeg** (`finishing-gate.test.ts`, `finishing-refusals.test.ts`):
vague feedback, a defect with no duration, a defect past the end of the cut, a
brief that both approves and prohibits an asset, an out-of-order stage,
directives written against a plan the stage does not vary from, a selection with
no comparison, an unwatched candidate, an unknown candidate, approved bytes
changed after the fact, a rewritten artefact, a cross-axis operation, a
candidate that never moves the axis under comparison, a retime that empties its
donor, footage the brief never approved, and a scorecard written against a
different master.

**Not proven: creative quality.** Every craft score in every test is a number a
fixture reviewer wrote. The scorecard's entire purpose is that no code can
produce one, and the tests are no exception. Whether a finished cut is actually
good is a judgement this repository records and never makes.

## 11. The first real-media round

A round has now run against the real Combat Reviews Concept B v2 master — the
licensed Pexels footage and the read-only captures of the deployed application,
not `lavfi` fixtures. Twelve candidates across all four stages rendered, every
one an ffprobe-verified 1080×1920 h264/AAC MP4 at exactly 15.000 s with actual-
media QA `PASS`. The `control` candidate reproduced the existing B v2 master
**byte for byte**, which is the strongest available statement that this path
consumes a real campaign artefact without changing it. The round needed no
adapter: `brief`, `open`, `directives`, `propose`, `select` and `inspect` all
took the real request, plan and master exactly as the earlier milestone produced
them.

It found one defect. `select` **persisted `selection.json` before validating
it**: validation lived only in `readStageSelection`, so an over-long `reason`
was written to disk, every later read of the run then failed on it, and
`writeOnce` refused the corrected selection — the run was bricked by an artefact
the tool wrote itself. `writeStageSelection` now parses before it writes, and
`finishing-refusals.test.ts` covers the exact failure. This is the same
discipline `propose` already had, where the directives file is written only once
the proposal stands.

Two things worth knowing before authoring directives against real captures.
`addressesDefectIds` is checked against the **brief's** defects only, so a note
carried into the next stage through `--feedback` cannot be cited by a later
candidate. And `asset-provenance.json` enumerates the whole preflighted library
rather than the bound sources, so auditing rights from it alone reads as though
the cut used every available asset; `render-manifest.json`'s `sources` is what
actually reached FFmpeg.

Still not proven, and unchanged by that round: creative quality, and a finished
master — the real-media round deliberately stopped at the CTA human selection
gate, so no scorecard exists and no verdict was reached.
