# Runbook — the locked-storyboard motion proof (Storyboard-02)

`pnpm aamp:flagship2` animates a locked ten-panel storyboard into one 15-second
1080×1920 master and proves, scene by scene, that it executed the storyboard
rather than reinterpreting it.

It runs through the **same composition root** as the flagship v1 command: the
zero-cost footage-first preview does the rendering, unchanged. What differs is
where the pixels come from and what may be said about them.

---

## 1. The rights position, which is the opposite of v1's

This is the one thing to understand before anything else.

|                | Storyboard-01                           | Storyboard-02                                                  |
| -------------- | --------------------------------------- | -------------------------------------------------------------- |
| Class          | `REFERENCE_ONLY`                        | `STORYBOARD_INTERNAL_REVIEW_ONLY`                              |
| Its pixels     | may **never** reach an output           | **are** the primary visual source                              |
| What is proven | by checksum, that no frame was rendered | that every panel is declared, and that Storyboard-01 is absent |
| Parser         | `storyboard-package.ts`                 | `storyboard-v2.ts`                                             |

The two parsers are deliberately separate modules. Collapsing them into one
with a flag would put a switch between "these bytes may never be rendered" and
"these bytes are what we render", and that is the last switch in this
repository anybody should be able to flip by accident.

What replaces exclusion here is **declaration**. A panel becomes production
media only as an asset that says, in its id, its description, its restrictions
and every provenance record it touches:

- provenance `STORYBOARD_PANEL`, animated for one internal-review motion proof;
- **not** licensed public-production media, with no model or property releases;
- every phone screen in it is concept UI, declared `PRODUCT_MOCKUP`;
- approved channel `INTERNAL_REVIEW`, and **not** public-release ready.

The run additionally proves, by hashing every file in the staging root against
Storyboard-01's frame checksums, that Storyboard-01 contributed nothing.

## 2. Running it

```powershell
pnpm aamp:flagship2 `
  --storyboard C:\Users\rtayl\Desktop\Combat-Reviews-Flagship-Storyboard-02 `
  --work-pack C:\Users\rtayl\Desktop\Combat-Reviews-Work-01 `
  --storyboard-01 C:\Users\rtayl\Desktop\Combat-Reviews-Flagship-Storyboard-01 `
  --output-dir .aamp-output\combat-reviews-flagship-02
```

`--storyboard-01` is optional; supplying it turns "Storyboard-01 was not used"
from an absence into a proof. The work pack supplies the brand mark and the
temporary audio only — no footage from it appears in the cut.

The last line on stdout is the master's path. Everything else goes to stderr.

## 3. The locked ten-scene contract

Scene order, roles and slots are constants in `storyboard-v2.ts`, not
configuration. The package, the plan and the fidelity report are all checked
against them.

| #   | Slot        | Scene                     | Headline                                 |
| --- | ----------- | ------------------------- | ---------------------------------------- |
| 1   | 0.00–1.10   | `NOTIFICATION_HOOK`       | FIGHTS THIS WEEKEND                      |
| 2   | 1.10–2.30   | `COMBAT_SPORT_BREADTH`    | EVERY COMBAT SPORT.                      |
| 3   | 2.30–3.80   | `EVENT_DISCOVERY`         | EVERY FIGHT. ONE PLACE.                  |
| 4   | 3.80–5.10   | `RANKINGS_RESEARCH`       | CHECK THE RANKINGS.                      |
| 5   | 5.10–6.60   | `FIGHTER_COMPARISON`      | READ THE FIGHT.                          |
| 6   | 6.60–8.00   | `FREE_PREDICTION`         | MAKE YOUR PICK. / FREE PREDICTION        |
| 7   | 8.00–8.90   | `PREDICTION_SUBMITTED`    | PREDICTION SUBMITTED                     |
| 8   | 8.90–10.70  | `PREDICTOR_STATUS_REWARD` | BUILD YOUR RECORD.                       |
| 9   | 10.70–12.70 | `COMMUNITY_DISCUSSION`    | JOIN THE DEBATE.                         |
| 10  | 12.70–15.00 | `BRAND_CTA`               | NEVER MISS FIGHT NIGHT. / EXPLORE EVENTS |

A reordered package, a scene off its slot, a gap, or a beat bound to a panel
that is not its own fails the run.

## 4. Two factual corrections, made in the panel's own typography

The storyboard asserts two things that cannot be verified. Both were corrected
**in the panel**, changing only the unverifiable element and leaving the scene,
its timing and its composition alone. The corrected panels live in the
package's `frames-corrected/` and are the ones actually rendered.

| Panel    | Before                   | After                  | Why                                                            |
| -------- | ------------------------ | ---------------------- | -------------------------------------------------------------- |
| FRAME-01 | `12 FIGHTS THIS WEEKEND` | `FIGHTS THIS WEEKEND`  | no verified feed backs a count of 12                           |
| FRAME-07 | `PICK LOCKED`            | `PREDICTION SUBMITTED` | no evidence shows the product locks a prediction at submission |

The number was erased by per-row interpolation between two ink-free anchor
columns and the bell glyph re-seated before the remaining word, so the
storyboard's own condensed face is untouched. The pill was rebuilt from its own
rounded caps about the same centre, at the same height, and the replacement
label typeset into it.

The verifier refuses a declared correction whose corrected panel is
byte-identical to the original — a correction that changed nothing is a
correction that did not happen.

## 5. How a landscape panel fills a 9:16 frame

The panels are landscape (470×378 and shorter). `COVER` would crop away most of
a composition that is the whole point of the exercise, so two new catalogue
treatments contain them instead:

- **`STORYBOARD_PANEL_2_5D`** — the panel at 96% of frame width over a blurred,
  darkened backplate built from its own pixels, each with its own zoom, so the
  two planes separate. The push is bounded so that 96% × maximum push stays
  under 1.0: a panel that grew past the frame edge would be a composition being
  cropped, which this milestone may not do.
- **`STORYBOARD_SLICE_REVEAL`** — the same composition, with the panel cut into
  five vertical slices revealed in sequence across the first 60% of the scene.
  Scene 2's five discipline slices are already in the art; this makes them
  arrive rhythmically rather than all at once.

`MOTION_TREATMENT_CATALOGUE_VERSION` is **4**.

Panels are staged at a 3× lanczos resample so they clear the asset root's
minimum delivery width and so the renderer scales _down_ into the frame. That
guard is respected rather than relaxed. The resample creates no detail that was
not in the panel, and `panelPreparation.createsNewDetail: false` says so in
provenance.

## 6. Three narrow, additive plan flags

All three default to the existing behaviour, so every plan written before this
milestone renders exactly as it did.

- `cta.renderEndCard` — false when the final beat already _is_ the end card. A
  locked panel carrying the mark, the headline and the button would otherwise
  be hidden under a second card the renderer drew on top of it.
- `brandConstraints.showLogoOverlay` — false when the panels carry their own
  branding. `logoWindows` can narrow when the mark appears but cannot say
  never, because an empty array already means "the whole cut".
- `decorations[].startOffsetSeconds` / `durationSeconds` — some decorations are
  events rather than states. A tap indicator that sits on screen for a whole
  shot is not a tap, and a confirmation flash lasting a second and a half is
  not a flash.

## 7. Artefacts

Written to `--output-dir`:

| File                                           | What it holds                                    |
| ---------------------------------------------- | ------------------------------------------------ |
| `<name>-<hash>.mp4`                            | the master                                       |
| `<name>-<hash>.mp4.qa.json`                    | actual-media QA, the binding measurements        |
| `storyboard-comparison-gallery.html`           | side-by-side panel vs output keyframe, per scene |
| `output-keyframes/`                            | ten keyframes, one per scene                     |
| `storyboard-panels/`                           | the panel each keyframe is compared against      |
| `storyboard-fidelity-report.json`              | scene presence, order, timing, panel binding     |
| `storyboard-verification.json`                 | panel checksums and the rights position          |
| `factual-sanitisation-report.json`             | the gate result and both panel corrections       |
| `asset-gap-report.json`                        | what each scene would need to stop being a proof |
| `human-review-scorecard.json`                  | 100 points, craft dimensions left null           |
| `flagship2-provenance.json` + `.checksum.json` | the sealed run record                            |

`.aamp-output/` is git-ignored. No media, no panel and nothing from an external
pack is ever committed.

## 8. What the fidelity report does and does not do

It is structural, because the acceptance conditions are structural: a missing
scene, a reordering, a gap, a rewritten headline, an unrelated asset standing
in for a panel. Any of those fails the run and the command exits non-zero.

It does **not** score how good the animation is. That is a craft judgement, it
belongs to a person, and a number invented there would be the one figure in the
report nobody could check. The same applies to the scorecard: seven of its ten
dimensions carry `HUMAN_JUDGEMENT_REQUIRED` and no number, and `AGENCY_GRADE`
is unreachable from this path by construction.

## 9. Audio

Temporary, and declared as such everywhere. Every audio asset in the work pack
is synthetic `lavfi` material; no real music or sound-effect file exists in any
available pack. The mix is measured from the finished file — roughly −14 LUFS
integrated, true peak inside the ceiling, zero clipped samples, AAC stereo at
48 kHz — but a measured mix of placeholder sounds is still placeholder sound.
`TEMPORARY_AUDIO` is a blocking defect on the scorecard.

## 10. Tests

`src/flagship/flagship-v2-contracts.test.ts` — 35 tests, no FFmpeg, always runs
in CI: package verification and every way it can be overstated or reordered,
panel declarations, the committed plan's ten beats and locked slots, fidelity
pass and its three failure modes, both panel treatments' containment and slice
sequencing, and every promoting flag refused.

The rendered master is proven by running the command; there is no separate
acceptance suite, because the fidelity report _is_ the acceptance check and it
runs on every invocation.

## 11. What this proves, and what it does not

**Proven.** A genuine ffprobe-verified 1080×1920 h264/yuv420p MP4 at exactly
15.000 s with AAC stereo at 48 kHz and faststart, passing actual-media QA; ten
scenes in the locked order on the locked slots with no gap; every scene
rendering its own panel; both factual corrections applied in the panel's own
typography; Storyboard-01 absent by checksum; zero paid provider calls as a
property of the object graph.

**Not proven.** Creative quality, and the animation's sufficiency. Every panel
is a single still: the bell does not swing, the ranking rows do not reveal
individually, the discussion feed does not scroll and the logo does not build.
Those are recorded per scene in `asset-gap-report.json` as remaining mismatches
against the storyboard's stated motion intent, along with the production asset
each one would need.
