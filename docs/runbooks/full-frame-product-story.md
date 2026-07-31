# Full-frame product story — correcting the review candidate

`pnpm aamp:full-review --product-story <plan>` renders
`FULL_LENGTH_UI_COMPOSITED_REVIEW`: the same fifteen-second cut as the review
candidate, with every scene full-frame and the four product-interface scenes
carrying the real Combat Reviews mobile interface mapped onto photographed
handsets.

It is a **zero-cost** path. Nothing on it constructs a generation provider,
reads a credential or makes a network request, and the scenes it composites are
rerouted so they cannot require generation at all — which is why the run
completes with `--max-cost-cents 0 --max-generations 0`.

## What was wrong, and what each correction is

The previous candidate was rejected on eleven counts. Each is now a check in
`product-story-visible-defects-report.json`, answered from the structure of the
run rather than from a promise.

| Rejected                                                                              | Correction                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scenes 3, 4, 6, 10 were 470px landscape storyboard cards floating in a portrait frame | The operator's own portrait plate, cover-framed to 1080×1920, with a mobile-native document warped onto the handset's calibrated screen                           |
| Scene 6 carried a large red diagnostic rectangle                                      | The `ACCENT_OUTLINE` and `TAP_INDICATOR` decorations are gone; the selection, the fingertip and the button press happen inside the interface at native resolution |
| Scenes 8 and 9 had empty protected interface regions                                  | A result panel and a discussion panel, laid out by a real engine and composited whole; a reserved region with no treatment is refused at parse time               |
| Scene 9 carried an opaque vertical red bar                                            | The filled `LIGHT_SWEEP` is gone; the sweep is a feathered, masked gradient inside the rasterised sheet that crosses once and disappears                          |
| Predictor rank #27 → #18 was missing                                                  | Scene 8's reserved right-hand region carries it, the leaving rank rising out as the arriving one settles in                                                       |
| Prediction confirmation was unclear                                                   | Scene 7 carries `PREDICTION SUBMITTED` on one restrained red edge, entering immediately after the impact; the full-frame red flash is gone                        |
| 80–99% of sampled pixels below luma 16                                                | Per-scene endpoint-pinned `curves` grades, measured at each scene's opening, midpoint and ending, over the whole frame and over the subject region separately     |
| ~2.5 Mbps master                                                                      | `output.qualityCrf` (manifest v2) at 17; measured 3,760 kbps, 50% above the cut it replaces                                                                       |
| Read as a slideshow of clips and cards                                                | Every scene is a moving source; four transitions, no crossfade, no dip to black, no white flash                                                                   |

## Running it

```sh
pnpm aamp:full-review \
  --storyboard <Storyboard-02 package> \
  --plates-dir <FRAME1PLATE … FRAME10PLATE folder> \
  --footage-pack <footage acquisition pack> \
  --work-pack <asset pack holding asset-root/assets.json> \
  --output-dir .aamp-output/<run> \
  --product-story apps/aamp-cli/campaigns/combat-reviews-flagship-02/product-story.json \
  --notification-brief apps/aamp-cli/campaigns/combat-reviews-flagship-02/scene-01-ltx-acceptance.json \
  --audio-benchmark <audio benchmark folder> \
  --compare-with <the earlier master> \
  --provider ltx-hosted --model ltx-2-3-fast \
  --max-cost-cents 0 --max-generations 0
```

`--compare-with` is read only, to fill the "before" column of
`old-versus-new-gallery.html`. Invoke the entry point directly (rather than
through the `pnpm` script) if the run must not read `.env` at all — the script
passes `--env-file-if-exists=.env`, and a run that never reads the key is a
stronger guarantee than one that reads it and does not use it.

## Where the decisions live

`campaigns/combat-reviews-flagship-02/product-story.json` holds all of them:
the four-corner screen calibrations, the camera moves, the grades, the interface
timelines, every word each treatment puts on screen, the nine transitions, and
the named human authorisation for the `PRODUCT_MOCKUP` interfaces. Application
code owns the discipline and nothing else — it proves the quads are mappable,
that the interface covers the glass, that a grade cannot raise the black floor,
and that no scene is left with an empty handset or an empty reserved region.

## Permanent rules

These are recorded in `CLAUDE.md`. In short:

- **Nothing falls back to a storyboard panel.** An unmappable screen fails the
  run by name. A silent return to the card is the defect being corrected.
- **The CSS width is 393px on every plate**; only the viewport height follows
  the calibrated screen. Handing a device width to the browser as a viewport
  lays the product out at a desktop breakpoint — it did, and the interface
  rendered in the corner of a black field.
- **Every mark on screen is a design, not a `drawbox`.** The interface and the
  treatments are rasterised by a real layout engine before FFmpeg is invoked,
  frame by frame, from a clock-free driver. No authored string reaches the
  compositor.
- **A grade is `curves` with pinned endpoints, and it may only lift.** A
  `brightness` offset would raise the black floor, which is the grey-blacks the
  correction refuses.
- **Exposure is measured against two profiles.** A live-action scene fails when
  the subject is lost; a product-interface scene fails when the handset is
  showing nothing. Both are binding; an unmeasurable scene is never a passing
  one.
- **A video-sourced scene is never excluded from the frozen-frame walk.**
  `STATIC_HOLD` means "add no synthetic move", not "the picture does not move".
- **Samples are taken over a scene's own beat window**, never its transition
  handles.
- **Nothing here scores creative quality**, and no function may be added that
  does.

## What this does not establish

Creative quality, in every respect. The reports measure geometry, exposure and
delivery; whether the cut is any good is a person's judgement and is listed as
`HUMAN_JUDGEMENT_REQUIRED` wherever it arises. The interfaces are
`PRODUCT_MOCKUP`s authorised for internal review — not captures, and not
assertions about live data. The audio is still `AUDIO_TEMPORARY`: the benchmark
pack's report carries no final status, so the cut keeps the synthetic
placeholder bed. Nothing produced here is public-release ready, and every
moving scene the run did not composite remains `PENDING_HUMAN_REVIEW`.
