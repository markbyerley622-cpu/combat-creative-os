# Runbook — LTX storyboard-to-video rendering

`pnpm aamp:storyboard-video` turns the locked Storyboard-02 art direction, the
ten approved production keyframes and the acquired footage pack into one
15-second 1080×1920 master, through the existing flagship render path.

## 1. What is proven and what is not

**Proven, offline, with no paid call:**

- the LTX client end to end against an in-process fake server — upload ticket,
  signed `PUT` with every required header, submit, poll through
  `pending → processing → completed`, download, and the failure mapping for
  401 / 402 / 429 / malformed / expired / timeout / cancellation;
- that no credential and no signed URL reaches a return value, an error message
  or an artefact;
- the generation cache: a second run over unchanged inputs makes **zero**
  further requests and spends nothing;
- the cost ceiling refusing **before** the first upload;
- `--dry-run` reading no API key, making no request and spending nothing —
  verified against the operator's real folders;
- deprecated `ltx-2-fast` / `ltx-2-pro` refused by name;
- minimum-duration selection and non-destructive trimming;
- exact-UI and brand scenes being structurally unable to reach a generation
  provider;
- the five-level source precedence, including refusal rather than a silent
  slideshow when a required moving source is missing.

**Not proven:**

- **no live LTX API call has ever been made from this repository.** No
  `LTXV_API_KEY` is configured. Every adapter carries
  `responseContractStatus: DOCUMENTED_NOT_EXECUTED`, and the fake server is not
  evidence about `api.ltx.io`.
- the full LTX-driven master. No end-to-end render driven by pipeline-generated
  footage has been produced, so nothing here may be described as a finished
  LTX-driven advertisement.
- creative quality, which is a human judgement and is not scored.

## 2. Inputs

| Flag                        | What it is                                                          |
| --------------------------- | ------------------------------------------------------------------- |
| `--storyboard`              | the verified ten-panel Storyboard-02 package (locked art direction) |
| `--frames-dir`              | the ten approved production keyframes, `FRAME-01`…`FRAME-10`        |
| `--footage-pack`            | the acquisition pack; only `approved-free-originals/` may render    |
| `--pre-generated-clips-dir` | hand-animated clips; defaults to `<frames-dir>/generated-clips`     |
| `--work-pack`               | the pack holding `asset-root/assets.json` (logo, music, SFX)        |
| `--output-dir`              | where the run writes                                                |
| `--provider ltx-hosted`     | the generation provider                                             |
| `--model`                   | `ltx-2-3-fast` or `ltx-2-3-pro`                                     |
| `--max-cost-cents`          | hard ceiling, checked before any upload                             |

The keyframe folder is read-only and is **not** required to be tidy: files that
are not `FRAME-NN.(png|jpg|jpeg)` are ignored and listed. A missing number or
two files claiming the same number is a refusal, never a guess.

## 3. Source precedence

Per scene, in this order:

1. **`REAL_PRODUCT_CAPTURE`** — an exact Combat Reviews screen capture.
2. **`ACQUIRED_PRODUCTION_FOOTAGE`** — a full-resolution, rights-cleared
   original from `approved-free-originals/`, with its SHA-256 recalculated.
3. **animated from `FRAME-NN`** — either `PRE_GENERATED_MANUAL_CLIP`
   (`MANUAL_LTX_STUDIO`, reused free) or `LTX_GENERATED`
   (`AAMP_LTX_HOSTED_PROVIDER`, paid).
4. **`DETERMINISTIC_MOTION_GRAPHICS`** — exact typography, product UI and CTA.
5. **refusal.** There is no still-image fallback for a required moving source.

Everything under `candidates/`, `work/`, `shortlists/`, `generation-briefs/` and
`brief/` is refused **by location** before any rights column is read. Previews
and contact sheets are never render sources.

## 4. The current Storyboard-02 resolution

With the operator's real packs and no hand-animated clips present:

| Scene | Role                    | Source                                                          |
| ----- | ----------------------- | --------------------------------------------------------------- |
| 1     | NOTIFICATION_HOOK       | `LTX_GENERATED`                                                 |
| 2     | COMBAT_SPORT_BREADTH    | `ACQUIRED_PRODUCTION_FOOTAGE` (`CRF02-BOXING_ACTION-PX4761763`) |
| 3     | EVENT_DISCOVERY         | `DETERMINISTIC_MOTION_GRAPHICS`                                 |
| 4     | RANKINGS_RESEARCH       | `DETERMINISTIC_MOTION_GRAPHICS`                                 |
| 5     | FIGHTER_COMPARISON      | `LTX_GENERATED`                                                 |
| 6     | FREE_PREDICTION         | `DETERMINISTIC_MOTION_GRAPHICS`                                 |
| 7     | PREDICTION_SUBMITTED    | `LTX_GENERATED`                                                 |
| 8     | PREDICTOR_STATUS_REWARD | `LTX_GENERATED`                                                 |
| 9     | COMMUNITY_DISCUSSION    | `LTX_GENERATED`                                                 |
| 10    | BRAND_CTA               | `DETERMINISTIC_MOTION_GRAPHICS`                                 |

Cost at 1080×1920, 6-second minimum per generated scene:

- **`ltx-2-3-fast`** — 5 scenes × 6 s × 6¢ = **180¢**
- **`ltx-2-3-pro`** — 5 scenes × 6 s × 8¢ = **240¢**

Once `FRAME-01.mp4` and `FRAME-07.mp4` are placed in
`<frames-dir>/generated-clips/`, scenes 1 and 7 become
`PRE_GENERATED_MANUAL_CLIP` and drop out of the estimate: **3 scenes, 108¢
fast / 144¢ pro**, and the next scene the pipeline must generate becomes
**scene 5**.

## 5. Hand-animated clips

Frames 1 and 7 were animated interactively in LTX Studio. They are validated
with ffprobe, checksummed, and carry `provenance: MANUAL_LTX_STUDIO` in every
artefact.

**Nothing in this repository may describe them as generated by the AAMP
provider.** The milestone's claim is about what the automated path can do, and
counting hand-made footage toward it would make the claim untrue. They are
never regenerated unless `--regenerate-scene` names them explicitly.

## 6. Commands

Dry run (no key, no network, no spend):

```sh
pnpm aamp:storyboard-video \
  --storyboard "$HOME/Desktop/Combat-Reviews-Flagship-Storyboard-02" \
  --frames-dir "$HOME/OneDrive/Desktop/NOISE/COMBAT REVIEWS/MARKETING" \
  --footage-pack "$HOME/Desktop/Combat-Reviews-Flagship-Footage-02" \
  --work-pack "$HOME/Desktop/Combat-Reviews-Work-01" \
  --output-dir .aamp-output/storyboard-video-dryrun \
  --provider ltx-hosted --model ltx-2-3-fast \
  --max-cost-cents 400 --dry-run
```

First live test — one scene only, targeting the next required missing scene so
the paid test also produces footage the cut needs. With frames 1 and 7 already
animated, that scene is **5**:

```sh
LTXV_API_KEY=... pnpm aamp:storyboard-video \
  --storyboard "$HOME/Desktop/Combat-Reviews-Flagship-Storyboard-02" \
  --frames-dir "$HOME/OneDrive/Desktop/NOISE/COMBAT REVIEWS/MARKETING" \
  --footage-pack "$HOME/Desktop/Combat-Reviews-Flagship-Footage-02" \
  --work-pack "$HOME/Desktop/Combat-Reviews-Work-01" \
  --output-dir .aamp-output/storyboard-video-live-scene-05 \
  --provider ltx-hosted --model ltx-2-3-fast \
  --regenerate-scene 5 --max-cost-cents 40
```

The ceiling of 40¢ is deliberate: it covers exactly one 6-second `fast`
generation (36¢) and refuses anything larger.

Full render:

```sh
LTXV_API_KEY=... pnpm aamp:storyboard-video \
  --storyboard "$HOME/Desktop/Combat-Reviews-Flagship-Storyboard-02" \
  --frames-dir "$HOME/OneDrive/Desktop/NOISE/COMBAT REVIEWS/MARKETING" \
  --footage-pack "$HOME/Desktop/Combat-Reviews-Flagship-Footage-02" \
  --work-pack "$HOME/Desktop/Combat-Reviews-Work-01" \
  --storyboard-01 "$HOME/Desktop/Combat-Reviews-Flagship-Storyboard-01" \
  --output-dir .aamp-output/storyboard-video-full \
  --provider ltx-hosted --model ltx-2-3-fast \
  --max-cost-cents 200
```

## 7. Artefacts

`storyboard-run-plan.json`, `cost-estimate.json`,
`scene-generation-records.json`, `source-decision-report.json`,
`ltx-prompts/`, `generated-originals/`, `trimmed-scenes/`,
`derived-render-plan.json`, `render-manifest.json`, `provenance.json`,
the QA report beside the master, the comparison gallery, and the MP4.

Every artefact passes `assertStoryboardVideoArtefactSafe` before it is written.
No signed upload URL, result URL or credential is persisted anywhere.

## 8. Exit codes

`0` success · `2` invalid arguments · `20` invalid storyboard · `21` missing
frame · `22` unsupported model or duration · `23` missing key · `24` cost
ceiling exceeded · `25` upload failed · `26` job submission failed ·
`27` payment required · `28` rate limited · `29` generation failed ·
`30` polling timeout · `31` malformed response · `32` expired result ·
`33` download failed · `34` invalid generated media · `35` no usable source ·
`36` final render failure · `37` QA failure.
