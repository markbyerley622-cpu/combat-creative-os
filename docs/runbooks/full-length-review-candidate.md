# The full-length review candidate

`pnpm aamp:full-review` assembles the whole fifteen-second Storyboard-02 cut —
selective LTX motion, deterministic Combat Reviews interface, the locked
notification treatment, real acquired footage, continuous transitions and the
available audio — into one master **so that a person can judge it**.

It is not a production master. It approves nothing. Every moving scene in it is
recorded as `PENDING_HUMAN_REVIEW`.

---

## 1. Why this is a separate command

`aamp:storyboard-video` refuses to composite a moving scene without a standing
human approval of the exact bytes. That has not changed, there is no flag on it
that changes it, and this milestone did not weaken it.

But the artefact those decisions are made _from_ did not exist. Scene-to-scene
continuity, pacing and the nine transitions between shots are not visible in ten
isolated clips, and requiring the approvals first would mean approving the parts
before anybody could see the whole.

So there are two commands and two output intents, fixed in source with no flag
reaching either:

|                         | `aamp:storyboard-video` | `aamp:full-review`             |
| ----------------------- | ----------------------- | ------------------------------ |
| output intent           | `PRODUCTION_MASTER`     | `FULL_LENGTH_REVIEW_CANDIDATE` |
| unreviewed moving scene | refused                 | rendered, recorded pending     |
| technically broken clip | refused                 | **refused**                    |
| approves anything       | never                   | never                          |

The line between them is the one the inspection tiers already draw.
`BINDING_TECHNICAL` means the file is unusable — wrong geometry, no motion, a
broken download — and a reviewer looking at it is being asked the wrong
question, so it blocks both. `NOT_REVIEWED` means nobody has decided yet, which
is precisely the state a review candidate exists to resolve.

## 2. What the run does, in order

Everything that can refuse the run happens before anything costs money.

1. **Stages the ten authoritative plates.** `FRAME1PLATE` … `FRAME10PLATE` are
   discovered in the operator's read-only marketing folder, every ambiguity
   refused, and copied into run-owned `FRAME-01` … `FRAME-10`. Each copy is
   re-hashed from the bytes that landed and compared to its source before
   anything uses it. Nothing is written, renamed, moved or deleted in the
   operator's folder.
2. **Verifies the storyboard package** and reads the ordered scene manifest.
3. **Resolves a source for every scene** through the existing five-level
   precedence, and **gates every prompt**.
4. **Prices the run** and checks _two_ ceilings: `--max-cost-cents` and
   `--max-generations`. They fail differently — a routing mistake that turns
   four deterministic scenes into generations stays under a generous cost
   ceiling while quadrupling the number of paid requests — so both are checked
   before the first upload.
5. **Generates**, once per scene, with no automatic retry.
6. **Inspects every resolved moving clip** and evaluates the motion gate.
7. **Trims** each moving source to its beat plus transition handles.
8. **Applies the authored second stage** to every routed scene.
9. **Renders** through the existing flagship path, unchanged.
10. **Writes the reports.**

## 3. The command

```sh
pnpm aamp:full-review \
  --storyboard  "<Storyboard-02 package>" \
  --storyboard-01 "<Storyboard-01 package>" \
  --plates-dir  "<the operator's FRAME1PLATE…FRAME10PLATE folder>" \
  --footage-pack "<the acquisition pack>" \
  --work-pack    "<the pack holding asset-root/assets.json>" \
  --audio-benchmark "<a completed audio benchmark, optional>" \
  --output-dir  ".aamp-output/combat-reviews-storyboard-02-full-review" \
  --provider ltx-hosted --model ltx-2-3-fast \
  --max-cost-cents 180 --max-generations 5 \
  --dry-run
```

`--dry-run` reads no API key at all. That is a property of the code — the key is
read once, in the CLI, and only when the run is live — rather than a promise in
the help text.

Drop `--dry-run` to execute. The credential is verified by existence and
non-zero length only; it is never printed, logged or written to any artefact.

## 4. Scene routing on this campaign

| scene | role                    | source            | provider camera motion | second stage                      |
| ----- | ----------------------- | ----------------- | ---------------------- | --------------------------------- |
| 1     | notification hook       | LTX generated     | `static`               | `SMOOTH_PUSH` 3%                  |
| 2     | combat-sport breadth    | acquired original | —                      | —                                 |
| 3     | event discovery         | storyboard panel  | —                      | —                                 |
| 4     | rankings research       | storyboard panel  | —                      | —                                 |
| 5     | fighter comparison      | LTX generated     | `static`               | —                                 |
| 6     | free prediction         | storyboard panel  | —                      | —                                 |
| 7     | prediction submitted    | LTX generated     | `static`               | —                                 |
| 8     | predictor status reward | LTX generated     | `static`               | `SMOOTH_PUSH` 2%                  |
| 9     | community discussion    | LTX generated     | `static`               | `SMOOTH_HORIZONTAL_DRIFT` 1% left |
| 10    | brand CTA               | storyboard panel  | —                      | —                                 |

Every paid submission asks for `static`. The moves that matter are either in the
subject or supplied deterministically afterwards.

## 5. Why Scene 1 is routed

The first live paid generation asked for a restrained push through the
provider's own `dolly_in`, with the magnitude in prose because the API defines
no field for it. It came back at roughly 1.75x, ending with the subject's eyes
outside frame, and a named reviewer rejected it for `COMPOSITION_DRIFT` and
`GAZE_LIFT`.

`CONTROLLED_PUSH_IN` is the conclusion drawn from that. It is a **routed**
motion: the provider is asked for a locked-off frame and AAMP performs the push
to the exact percentage a person wrote down. This is not a substitution — the
shot is still a push — it is a decision about which stage owns the number.

`SLOW_PUSH_IN` still maps to `dolly_in` and nothing was removed from the
vocabulary. Use it when the provider's own interpretation of a push is what you
want; use `CONTROLLED_PUSH_IN` when the magnitude is part of the art direction.

## 6. The deterministic second stage

`post-motion.ts` compiles an authored `postMotion` block into one FFmpeg pass on
the trimmed scene clip.

- **No border can be exposed.** Both treatments are crop-from-oversampled,
  never translate-the-frame: the source is scaled up once by a constant headroom
  factor and the delivery window is cropped out of the middle of it. There is no
  `pad`, no `fillborders` and no negative `overlay` offset in anything this
  module compiles.
- **The drift's magnification is constant.** `zoom` is a literal in the compiled
  expression, and `assertNoZoomOverTime` proves it about the grammar. The
  picture is at one scale from the first frame to the last, which is what "no
  zoom" means to a viewer.
- **Nothing else is expressible.** The compiled chain is checked against an
  allow-list of filters — `fps`, `scale`, `zoompan`, `setsar`, `setpts`,
  `format` — so a future edit reaching for `rotate` or `noise` fails a test
  rather than shipping a shake into an advertisement.
- **Easing is a pure function of the output frame index.** Smoothstep, so the
  move starts and stops without a flick and never overshoots. Two runs of the
  same plan over the same bytes produce the same bytes.
- **It may move the picture; it may never shorten the scene.** There is
  deliberately no `trim` in the chain: trimming to a nominal duration quantises
  onto the frame grid and can come back a few milliseconds short, which strips
  the transition handle the segment selector requires and makes the render
  refuse a scene whose picture is fine. The output duration is _measured_
  against the input's and a shortfall is refused by name. Found exactly that
  way.

### The preserved region

`preservedRegion` is a person's prose and prose cannot be checked. An optional
`preservedRegionRect` states the same region as fractions of the frame, and then
the check is real arithmetic against the tightest window the move ever reaches —
refused before FFmpeg is invoked, naming the magnitude that would be legal.

A drift is held to the **worse of its two extremes**, not the one it ends on: a
region hard against one edge survives the window at one end and is cropped by
the other, and checking only the end state would pass it.

Where no rectangle is supplied the record says `NOT_MEASURED` and names the
reason. An unmeasured check is never reported as a pass.

## 7. What the run writes

| artefact                           | what it answers                                               |
| ---------------------------------- | ------------------------------------------------------------- |
| `staged-plates.json`               | which ten plates, from where, at what checksum                |
| `storyboard-run-plan.json`         | every input, both ceilings, the output intent                 |
| `cost-estimate.json`               | the computed maximum, per scene, before any upload            |
| `source-decision-report.json`      | why each scene got the source it got, and what lost           |
| `scene-generation-records.json`    | bought versus used, per scene, with checksums                 |
| `post-motion-report.json`          | the authored intention, the executed geometry, both checksums |
| `motion-inspection-report.json`    | every binding and fidelity check per clip                     |
| `pending-human-review-ledger.json` | every scene still awaiting a named decision                   |
| `transition-report.json`           | every seam, its kind, and a luma measurement at its midpoint  |
| `ui-compositing-report.json`       | where the interface is and how it got there                   |
| `audio-report.json`                | whether benchmark audio was used, and the measured loudness   |
| `visible-defects-report.json`      | thirty scene instants measured, and what a person must judge  |
| `provenance.json`                  | the sealed record: intent, spend, provenance, caveat          |
| comparison gallery                 | the storyboard beside the finished cut                        |

## 8. Audio

The completed benchmark is used **only** if its final report says the model
chain finished _and_ its mixes directory holds audio. Anything else and the cut
is marked `AUDIO_TEMPORARY` and carries the work pack's synthetic placeholder
bed and cues.

That is a deliberate three-condition test rather than a presence check: a
benchmark whose report still says `IN PROGRESS` has not finished, and putting
its intermediate material into a cut labelled as the reviewable one would
misrepresent both.

## 8a. The cache, and what it cost to find out it was broken

**A re-run must be free. It was not, and nobody noticed for two runs.**

`generateSceneClip` wrote each generated clip to `<run>/generated-originals/`
but recorded its cache entry as `originals/<file>` — a path the cache resolves
against its _own_ directory, `<run>/generation-cache/`. The file was therefore
never where the entry said it was. Every lookup read a missing file, correctly
concluded "there is no usable cached clip", and bought the scene again. Nothing
failed and nothing warned, because a miss is a legitimate outcome.

Two things were changed so it cannot recur:

- **The recorded path is derived, not composed.** `cacheRelativePath` computes
  it with `relative()` from where the bytes actually landed, so the entry is a
  fact about the file rather than a second description of it.
  `generation-cache.test.ts` exercises the whole round trip — write, record,
  reopen from disk, look up — because a test that only checked what `record`
  stored would have passed throughout.
- **The cost estimate consults the cache.** It previously counted every
  generating scene as a purchase, so the printed maximum and _both_ ceilings
  described a run that was not the one about to happen: they could not tell a
  free re-run from a second full one. `findCachedScenes` runs before the
  estimate, using the same key the generation stage uses, and a cached scene is
  priced at 0¢ with its reason stated.

The consequence of that fix is a real guarantee an operator can use: **run with
`--max-cost-cents 0 --max-generations 0`**. If any scene would actually be
bought, the run refuses before the first upload. If everything is cached, it
renders for nothing. That is now the correct way to re-render an existing run.

## 9. Standing limitations

These are properties of the material and the path, recorded every run rather
than discovered in the frames.

- **Creative quality is not assessed.** Nothing in this repository measures it.
  Every craft judgement in the reports carries `HUMAN_JUDGEMENT_REQUIRED` and no
  number.
- **The interface scenes render the storyboard's own art**, not a sharp
  mobile-native screen composited onto a handset. The operator's plates for
  those scenes are photographic handsets with **blank** screens — shot for an
  interface to be composited onto — and the compositor that would map a 393 CSS
  px document through the handset's homography is not on this path. A scene that
  declares exact product UI therefore renders the source that _contains_ the
  product, even though it is the lower-resolution one: a beautiful empty handset
  is not a demonstration of an application.
- **Scenes 8 and 9 sit on plates that were sent to a generative model.** The
  prompt forbids altering any panel, label or numeral in them, and nothing here
  measures whether the returned pixels obeyed. A reviewer must look.
- **A visible change of predictor rank is not rendered.** No source shows two
  ranking states, and drawing them would be this pipeline inventing product UI —
  which every rule in this repository forbids. It needs either a real capture of
  both states or the screen compositor above.
- **The audio is temporary** unless a completed benchmark was supplied.

## 10. After the review

Watch the cut. Then, per scene:

```sh
pnpm aamp:motion-review inspect --scene <n>
pnpm aamp:motion-review approve --scene <n>   # or: reject --scene <n>
```

An approval binds to four inputs — the clip's bytes, the authoritative keyframe,
the generation prompt and the scene contract — so it stops applying if any of
the four moves, and the gate names which one did.

Once every moving scene carries a standing approval, `pnpm aamp:storyboard-video`
produces the master. A rejection never buys a replacement on its own: rerun that
scene with `--regenerate-scene <n>` when you have decided to pay again.
