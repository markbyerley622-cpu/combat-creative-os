# Storyboard motion quality gate

`pnpm aamp:motion-review` is the pass that happens between "a clip exists for
this scene" and "this clip renders". It measures every resolved moving clip
locally, shows a person what it found beside the approved keyframe, records
their decision immutably, and refuses the final render until every moving scene
carries a standing approval of the exact bytes that will be used.

It constructs no provider, reads no API key and makes no network request. The
`aamp:motion-review` script does not even load `.env`, so a credential is not
merely unread on this path — it is not in the process.

Related: `docs/runbooks/ltx-storyboard-to-video.md` (how a scene gets a clip in
the first place), `docs/runbooks/locked-storyboard-motion-proof.md` (how the
ten scenes are locked), `docs/runbooks/zero-cost-footage-first-preview.md` (the
render path everything hands off to).

---

## 1. What it measures, and what it deliberately does not

Every number comes from FFmpeg reading the file on this machine. **None of them
is evidence about creative quality.** No deterministic measurement of whether a
shot is beautiful, whether a face is convincing, whether a hand has five fingers
or whether the story lands exists, and inventing one would put the single figure
nobody could check at the centre of the report.

What the measurements do establish is narrower and worth establishing: the file
decodes, it is the right length, it is not black at either end, it is not a held
frame wearing a video container, it did not come from a previews folder, and its
opening composition either is or is not the approved keyframe's.

Checks come in two tiers, and the difference is **who can clear them**.

| Tier                | Meaning                                         | Cleared by                                  |
| ------------------- | ----------------------------------------------- | ------------------------------------------- |
| `BINDING_TECHNICAL` | the file is unusable                            | nothing — a different clip is needed        |
| `FIDELITY_FINDING`  | the file is usable and disagrees with the brief | a named reviewer, who must name the finding |

### Binding technical checks

`FILE_PRESENT_AND_NON_EMPTY`, `DECODABLE_VIDEO_STREAM`, `MEASURED_GEOMETRY`,
`MEASURED_FRAME_RATE`, `MEASURED_DURATION`, `MEASURED_VIDEO_CODEC`,
`MEASURED_PIXEL_FORMAT`, `NO_BLACK_OPENING`, `NO_BLACK_ENDING`,
`NOT_FROZEN_OVER_EDIT_INTERVAL`, `NO_CORRUPT_FRAMES`,
`SUFFICIENT_MOTION_FOR_DECLARED_REQUIREMENT`, `SOURCE_COVERS_EDIT_INTERVAL`,
`NOT_A_PREVIEW_OR_CONTACT_SHEET_ASSET`, `CHECKSUM_AND_PROVENANCE_RECORDED`.

A check that could not be taken is `NOT_MEASURED` and is **never** a pass — the
preview path's rule, and it holds here for the same reason: an unmeasurable
binding property is not a satisfied one.

### Fidelity findings

`FIRST_FRAME_MATCHES_AUTHORITATIVE_KEYFRAME` and `DELIVERS_WITHOUT_UPSCALE`.
Both are real disagreements with the brief that a person has to rule on. A model
may have animated a tighter, better shot than the approved plate; a 1920×1080
plate cropped to 9:16 may still be the right picture. Neither is a decision code
may make on a reviewer's behalf, and neither may be skipped: an approval is
refused while a finding is open and unnamed, and the reviewer states which one
they are accepting with `--acknowledge <FINDING_ID>`.

---

## 2. The two measurements that needed calibrating

Both were calibrated against real material, and both **replaced a naive version
that did not work**. The naive versions are recorded here because they look
correct and are not.

### Motion energy — is this a clip or a held frame?

The obvious measure is the mean luma of the frame-to-frame difference. It fails:

| clip                                    | naive mean difference |
| --------------------------------------- | --------------------- |
| a still image encoded to h264 at CRF 18 | **1.22**              |
| a genuine slow push-in                  | **1.31**              |

The signal is buried in quantisation noise, so any threshold on that measure
passes a slideshow.

Zeroing every per-pixel difference at or below `MOTION_NOISE_CUTOFF` (16) before
averaging separates them completely:

| clip                  | thresholded measure |
| --------------------- | ------------------- |
| the same still        | **0.0000**          |
| the same slow push-in | **1.72**            |
| a hard impact         | **11.53**           |

Sampled at `MOTION_SAMPLE_FPS` (8) rather than the source rate, so a slow move
accumulates between compared frames, and at 192 px wide the whole pass is cheap.

Floors by declared camera motion — all far below the slowest real movement
measured and all far above a held frame:

| camera motion                                           | floor |
| ------------------------------------------------------- | ----- |
| `STATIC`                                                | 0.15  |
| `SLOW_PUSH_IN`, `SLOW_PULL_OUT`, `TILT_UP`, `TILT_DOWN` | 0.30  |
| `HANDHELD_DRIFT`, `LATERAL_TRACK_*`, `ORBIT_*`          | 0.45  |

`STATIC` is deliberately not zero: a locked-off frame is still a frame in which
the subject moves.

### Keyframe agreement — did this clip start from the approved plate?

Whole-frame difference fails here too, and more embarrassingly:

| pair                                                     | mean-difference similarity |
| -------------------------------------------------------- | -------------------------- |
| clip 1's first frame vs **its own** keyframe             | 0.871                      |
| clip 1's first frame vs a **different** scene's keyframe | 0.871                      |
| clip 7 vs its own keyframe                               | 0.915                      |
| clip 7 vs a different keyframe                           | 0.930 (higher)             |

Both images are dark and high-contrast, so a global mean measures exposure, not
composition. Pearson correlation over raw pixels is no better (0.232 matched
against 0.210 mismatched).

Comparing the **layout of light** does work. Both images are taken to delivery
framing — scaled to cover 1080×1920 and centre-cropped, so the comparison is
against the picture that will actually be on screen — reduced to a 4×8 grid of
cell means, and the two grids correlated. Correlation is invariant to brightness
and contrast, which is exactly the invariance wanted.

| pair                                             | layout correlation |
| ------------------------------------------------ | ------------------ |
| the approved frame vs a 6% push-in of itself     | **0.984**          |
| the approved frame vs a different approved frame | **0.001 – 0.019**  |

Floor: `KEYFRAME_LAYOUT_AGREEMENT_FLOOR` = **0.85**.

It answers one question — did this clip start from the approved plate — and says
nothing about whether what follows is any good. It is asked only of clips that
were animated from a keyframe; an acquired photographic original was never
supposed to match one, and the check reports `NOT_APPLICABLE` rather than
producing a finding whose only honest resolution is "not applicable".

---

## 3. What invalidates an approval

An approval is not stored against a scene number. It is stored against the
digest of four things, and applies only while that digest still matches disk:

1. the **clip's bytes** — a regeneration, a re-download, a re-trim;
2. the **authoritative keyframe** — the approved art changed;
3. the **generation prompt** — the scene was asked for differently;
4. the **scene contract** — its slot, mode, camera motion, accepted footage
   roles, and its typography and product-UI preservation flags.

Change any one and the earlier judgement describes something that no longer
exists, so it stops applying and the gate says which input moved. The scene's
prose `intent` is deliberately **not** in the digest: it is documentation, and a
reviewer's judgement about the picture is not invalidated by somebody improving
a sentence about it.

The identity is deliberately not a hash of the inspection. Measurements move
with the FFmpeg build; the four inputs above do not. An approval that evaporated
because a patch release changed a frame-rate rounding would train reviewers to
click through the gate.

---

## 4. The ledger

`<review-dir>/motion-review-ledger.jsonl`. JSON Lines, appended to, never
rewritten.

- **Every decision ever recorded stays.** A changed mind is a new line naming
  the one it supersedes, so the record shows both judgements — an audit that
  only shows the current answer cannot distinguish "approved once" from
  "approved after two rejections".
- **Every line carries the digest of its own content**, so a hand-edited
  approval is refused on read rather than honoured.
- **A malformed line is an error, not an empty ledger.** Continuing as though
  the scene had never been reviewed would silently discard a human judgement.
- **Recording the identical decision twice is a no-op**, because a reviewer
  re-running the same command has not made a second judgement.
- It holds no path, URL or credential — only checksums, a reviewer's name and
  their words — and it is walked by `assertStoryboardVideoArtefactSafe` before
  every write.

Feedback is refused rather than interpreted. A whole-field mood ("bad", "make it
punchier") cannot become the recorded reason for a decision, and a rejection
needs at least 30 characters saying what was observed and what must change —
it is an instruction to spend money regenerating, and the next person has to
know what to change. Prose that merely _contains_ a vague word is never blocked.

---

## 5. Commands

All examples use the operator's real folders. Every one of them is read-only on
those folders; artefacts are written under `.aamp-output/`, which is git-ignored.

### Report the current state (spends nothing)

```sh
node apps/aamp-cli/dist/storyboard-video/motion-review-main.js status \
  --storyboard  "C:\Users\rtayl\Desktop\Combat-Reviews-Flagship-Storyboard-02" \
  --frames-dir  "C:\Users\rtayl\OneDrive\Desktop\NOISE\COMBAT REVIEWS\MARKETING\generated-clips" \
  --pre-generated-clips-dir "C:\Users\rtayl\OneDrive\Desktop\NOISE\COMBAT REVIEWS\MARKETING\generated-clips" \
  --footage-pack "C:\Users\rtayl\Desktop\Combat-Reviews-Flagship-Footage-02" \
  --work-pack    "C:\Users\rtayl\Desktop\Combat-Reviews-Work-01" \
  --review-dir   ".aamp-output/storyboard-02-motion-review" \
  --model ltx-2-3-fast
```

(`pnpm aamp:motion-review status …` is the same command through the package
script.)

### Inspect and write the gallery

Replace `status` with `inspect`. Add `--json` for the machine-readable form.
The gallery lands at
`.aamp-output/storyboard-02-motion-review/motion-review-gallery.html` and opens
from the filesystem with no server, no script and no network request.

### Approve a scene

```sh
pnpm aamp:motion-review approve --scene 1 \
  --reviewer "Riki Taylor" \
  --feedback "the opening frame is the approved plate and the push is the one the scene asks for" \
  --acknowledge DELIVERS_WITHOUT_UPSCALE \
  --acknowledge FIRST_FRAME_MATCHES_AUTHORITATIVE_KEYFRAME \
  … the same path flags as above
```

Every open fidelity finding must be named or the approval is refused, and the
refusal prints what each finding observed against what was expected.

### Reject a scene

```sh
pnpm aamp:motion-review reject --scene 8 \
  --reviewer "Riki Taylor" \
  --feedback "the push overshoots and the plate drifts off the protected right third by 0.6s; hold the move at 60% and re-seat the frame" \
  … the same path flags as above
```

### Read the whole record

```sh
pnpm aamp:motion-review ledger --review-dir ".aamp-output/storyboard-02-motion-review"
```

### Selective regeneration of only what a reviewer refused

```sh
pnpm aamp:storyboard-video \
  --storyboard  … --frames-dir … --footage-pack … --work-pack … \
  --output-dir  ".aamp-output/storyboard-02-run" \
  --review-dir  ".aamp-output/storyboard-02-motion-review" \
  --provider ltx-hosted --model ltx-2-3-fast --max-cost-cents 120 \
  --regenerate-rejected
```

`--regenerate-rejected` reads the ledger, finds the scenes whose standing
decision is `REJECTED`, and adds them to the regeneration set **before** the
cost estimate is computed — so what a reviewer refused is priced into the
ceiling the operator authorises rather than discovered after the estimate was
printed. `--regenerate-scene <n>` remains available for naming one explicitly.

Both flags also **bypass the generation cache** for the named scenes. Without
that, a rejected scene would re-resolve to the very clip that was rejected:
every cache-key input is unchanged, so the lookup is a hit and the regeneration
silently does not happen.

### The final render

The same `pnpm aamp:storyboard-video` command without `--regenerate-rejected`.
There is no flag that skips the gate.

---

## 6. What the gate refuses, and what it says

Six statuses, six genuinely different operator actions. A message that said only
"not ready" would get the condition removed rather than met, so every scene
names what happened and what to do about it.

| status                          | means                                                        | exit   |
| ------------------------------- | ------------------------------------------------------------ | ------ |
| `APPROVED`                      | a standing approval of these exact bytes                     | clears |
| `REJECTED`                      | a reviewer refused this clip; the remedy repeats their words | 38     |
| `NOT_REVIEWED`                  | nobody has looked at it                                      | 38     |
| `APPROVAL_SUPERSEDED_BY_CHANGE` | approved, then an input moved — and it says which            | 38     |
| `TECHNICALLY_INVALID`           | a binding check failed or could not be taken                 | 39     |
| `MISSING_SOURCE`                | no moving source resolved at all                             | 39     |

The gate runs after generation and **before anything is trimmed, staged or
composited**, so a blocked run has produced no timeline and no file. The failure
message says so explicitly. When a run is blocked it still writes
`motion-gate-blocked.json` and the gallery, so the operator has what they need
to act rather than only an error.

Scenes whose source is a still the render path animates itself —
`DETERMINISTIC_MOTION_GRAPHICS` and `REAL_PRODUCT_CAPTURE` — are never asked for
a motion approval. There is no generated motion to review, and asking would
train reviewers to approve without looking.

---

## 7. Real Storyboard-02 state, measured 2026-07-29

Read-only, zero paid calls, nothing on the operator's folders altered.

| scene       | source                                                        | status           | note                                   |
| ----------- | ------------------------------------------------------------- | ---------------- | -------------------------------------- |
| 1           | `PRE_GENERATED_MANUAL_CLIP` (`MANUAL_LTX_STUDIO`)             | `NOT_REVIEWED`   | two open fidelity findings             |
| 2           | `ACQUIRED_PRODUCTION_FOOTAGE` `CRF02-BOXING_ACTION-PX4761763` | `NOT_REVIEWED`   | technically sound, no findings         |
| 3, 4, 6, 10 | `DETERMINISTIC_MOTION_GRAPHICS`                               | `NOT_REVIEWABLE` | animated from the approved panel       |
| 5, 8, 9     | `LTX_GENERATED`                                               | `MISSING_SOURCE` | 36¢ each, 108¢ total at `ltx-2-3-fast` |
| 7           | `PRE_GENERATED_MANUAL_CLIP` (`MANUAL_LTX_STUDIO`)             | `NOT_REVIEWED`   | two open fidelity findings             |

Measured on the three clips that resolve:

| scene | geometry                                 | motion energy        | keyframe agreement      | verdict                         |
| ----- | ---------------------------------------- | -------------------- | ----------------------- | ------------------------------- |
| 1     | 1920×1080, 24 fps, 6.042 s, h264/yuv420p | 0.4097 (floor 0.30)  | **0.4432** (floor 0.85) | `TECHNICALLY_SOUND`, 2 findings |
| 2     | 4096×2160, 25 fps, 8.880 s, h264/yuv420p | 11.4292 (floor 0.15) | not applicable          | `TECHNICALLY_SOUND`             |
| 7     | 1920×1080, 24 fps, 6.042 s, h264/yuv420p | 17.3092 (floor 0.15) | **0.1441** (floor 0.85) | `TECHNICALLY_SOUND`, 2 findings |

**The finding that matters.** Both hand-animated LTX Studio clips are landscape
1920×1080 while their keyframes are portrait 1080×1920, and neither opens on the
approved composition. Scene 1's clip is a tight crop on the face where the plate
is a wider portrait framing; scene 7's agrees with its plate barely at all.
Centre-cropping either to 9:16 — which is what the trim stage does — yields a
narrow vertical slice of a wide frame, not the shot that was approved. Both also
fail `DELIVERS_WITHOUT_UPSCALE`, because a 1080-tall source enlarges into a
1920-tall delivery.

Neither is a defect in the file, which is why neither blocks by itself: they are
findings a named person has to accept or refuse. Before this milestone the
pipeline would have rendered both without anybody being told.

---

## 8. Tests

```sh
# contracts, refusals and identity rules — no FFmpeg, no provider, no key
pnpm --filter aamp-cli exec vitest run src/storyboard-video/motion-review-contracts.test.ts

# the object-graph guarantees: no provider, no credential read, no fetch
pnpm --filter aamp-cli exec vitest run src/storyboard-video/motion-review-source-hygiene.test.ts

# the whole path against real FFmpeg and the in-process fake LTX server
pnpm --filter aamp-cli exec vitest run src/storyboard-video/motion-review-acceptance.test.ts
```

The acceptance suite needs a real FFmpeg and **skips loudly** without one. It
builds its own storyboard package, keyframes, manual clips, footage pack and
work pack, and proves: ten scene sources resolve; a run with nothing reviewed
refuses before FFmpeg composition starts; one rejected scene blocks it;
replacing that scene invalidates the earlier decision and leaves every other
approval standing; approving the replacement unblocks it; and the finished
master is a genuine 15.000 s 1080×1920 h264/AAC file passing actual-media QA,
with provenance naming every source and its approver, no preview or
contact-sheet material in the render manifest, and no credential in any
artefact. No paid call is made: the run is handed a provider built against the
fake server through the injection seam that exists for exactly this.

---

## 9. What is not proven

- **Creative quality.** Nothing here measures it and nothing here claims to.
  Every craft judgement in the system is a named person's recorded decision.
- **That an approval was a good decision.** The gate proves a person made one
  about specific bytes at a specific time. It cannot prove they were right.
- **Anything about the live LTX API.** No live call has been made from this
  repository; `LTX_RESPONSE_CONTRACT_STATUS` stays `DOCUMENTED_NOT_EXECUTED`.
- **That the two hand-animated clips are usable.** The gate has surfaced the
  question. Answering it is the operator's, and the honest answer may be that
  those two scenes need re-animating at delivery framing.
