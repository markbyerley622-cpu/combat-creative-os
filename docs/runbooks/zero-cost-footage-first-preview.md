# Runbook — zero-cost footage-first creative preview

The strongest Combat Reviews advertisement this repository can produce without
an API key, a GPU, a model download or a paid provider of any kind.

The creative decisions are made by **a person**, written down as a validated
plan, and executed deterministically. No reasoning provider and no
video-generation provider is constructed, so neither can be called.

---

## 1. What this mode is, and what it is not

|                         |                                  |
| ----------------------- | -------------------------------- |
| Execution mode          | `HUMAN_ASSISTED_PREVIEW`         |
| Planning source         | `HUMAN_SUPPLIED_STRUCTURED_PLAN` |
| Paid provider calls     | `0`                              |
| `isRealCampaignRun`     | `false`                          |
| Requires human approval | always                           |

**It is** a real 1080×1920 h264/AAC MP4, cut from real owned footage, with real
motion, real captions, a real audio mix, and every binding property measured
from the produced file.

**It is not** a campaign result. The pipeline did not originate the creative —
a person did — so nothing about the output is evidence that the system can
plan an advertisement on its own. It is also not an approval: `PASS` means the
file is technically what it claims to be, not that it is any good.

The three neighbouring modes remain unchanged:

- `FIXTURE` replays committed creative and **ignores the campaign prompt**.
- `LOCAL_PRODUCTION` has a model plan against live local infrastructure.
- `PRODUCTION` is everything real, and refuses every substitute.

A human-authored plan can reach none of them, and none of them can be reached
by this mode — the mode is decided by where the creative came from, not by how
much infrastructure was running.

---

## 2. Prerequisites

- **FFmpeg and ffprobe.** Anything else is optional.
- No database, no Qdrant, no Temporal, no API key, no GPU.

```powershell
$env:FFMPEG_PATH  = 'C:\path\to\ffmpeg.exe'   # only if not on PATH
$env:FFPROBE_PATH = 'C:\path\to\ffprobe.exe'
```

Generate the synthetic asset root the committed example runs against. It is
git-ignored: no external, licensed or copyrighted media is ever committed.

```powershell
pnpm aamp:fixtures
```

---

## 3. The asset root

An asset root is a directory the operator supplies. The layout is:

```
<asset-root>/
  brand/          logo lockups, designed end cards
  app-ui/         app captures
  combat-clips/   owned or licensed footage
  audio/          music beds and sound-design cues
  references/     ANALYSIS-ONLY — never enters an output
```

Preflight validates, for every asset the manifest declares:

- **canonical containment** — the path is resolved _and_ `realpath`-ed, so a
  symlink inside the root pointing outside it is refused;
- existence, non-emptiness, checksum, media kind, codec, dimensions, duration,
  frame rate and audio presence, all **measured** with ffprobe;
- **duplicate content** — the same bytes under two ids;
- **sufficiency** — a clip shorter than the plan's shortest beat;
- **rights** — only `OWNED`, `COMMISSIONED` and `LICENSED_FOR_OUTPUT`, and only
  with `permittedOutputUse: true`.

Anything under `references/` is **counted and refused**, whatever its declared
rights say. That is structural: a benchmark clip relabelled `OWNED` still
cannot reach a render manifest.

Preflight is all-or-nothing. A library listing one unusable asset is a library
to fix, not one to quietly proceed with.

---

## 4. Writing a plan

Start from a deterministic skeleton derived from the request:

```powershell
pnpm aamp:generate `
  --request apps/aamp-cli/examples/combat-reviews-preview.request.json `
  --emit-plan-template > my-plan.json
```

Every prose field says `TODO`. That is deliberate — a template that rendered
as-is would make this mode's claim untrue on first use.

A plan carries: strategy, creative direction, the hook, the beats (timing,
source selector, motion treatment, transition, caption, decorations, audio
cues), the CTA and its hold, the audio design, the factual constraints and the
brand constraints. See
`apps/aamp-cli/examples/combat-reviews-preview.plan.json` for a finished one.

**A plan is refused unless it is complete and belongs to this brief:**

- `campaignPromptSha256` must equal the request's prompt hash — a plan written
  against a different brief is named and refused, not rendered;
- `campaignId`, `workspaceId`, `targetDurationSeconds`, the CTA duration and
  the logo asset must all match the request;
- beat indices are contiguous from 0, only the first beat has no
  `transitionIn`, and the last beat is the `CTA` beat;
- beats minus transition overlaps must land **exactly** on the requested
  duration;
- `authoredBy` is required — this mode's whole claim is that a person made
  these decisions;
- no field may ask for imitation of an agency, studio or existing campaign.

### Motion treatments

Selected by key from the versioned catalogue
(`packages/media/src/render/motion-treatments.ts`):

| Family     | Keys                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scene      | `STATIC_HOLD`, `PUSH_IN`, `PULL_OUT`, `LATERAL_LEFT`, `LATERAL_RIGHT`, `APP_SCREENSHOT_PARALLAX`, `FRAMED_PHONE_UI`, `SAFE_SPEED_RAMP`, `IMPACT_FREEZE`, `IMPACT_FLASH` |
| Transition | `CUT`, `CROSSFADE`, `DIP_TO_BLACK`, `WHIP_PAN`, `IMPACT_CUT`, `MASKED_UI_REVEAL`                                                                                        |
| Decoration | `BRAND_COLOUR_CALLOUT`, `ACCENT_OUTLINE`                                                                                                                                |
| Typography | captions `FADE`/`RISE`/`POP`/`SNAP`; CTA `RISE_AND_SCALE`/`FADE_HOLD`/`SNAP_HOLD`                                                                                       |

Each declares which source kinds it accepts. A parallax on a video source is
refused when the manifest is parsed, not twenty seconds into an encode.

### Audio cues

Roles: `FIGHT_BELL`, `CROWD`, `IMPACT`, `UI_CLICK`, `CONFIRMATION_PULSE`,
`CTA_EMPHASIS`. Each has house rules — a gain range, fades, a maximum
duration, and whether it may duck the music bed. A gain outside its range is
clamped and the original recorded; a source longer than the role allows is
trimmed. A role that never ducks cannot be talked into ducking.

---

## 5. Running it

```powershell
pnpm aamp:generate `
  --request apps/aamp-cli/examples/combat-reviews-preview.request.json `
  --assets apps/aamp-cli/examples/combat-reviews-preview-assets.json `
  --asset-root packages/media/fixtures/preview-asset-root `
  --plan-file apps/aamp-cli/examples/combat-reviews-preview.plan.json `
  --output-dir .aamp-output/human-assisted-preview
```

Before any work, the command prints:

```
PAID PROVIDER CALLS DISABLED
AUTONOMOUS REASONING NOT USED
OUTPUT IS A HUMAN-ASSISTED PREVIEW

execution mode:        HUMAN_ASSISTED_PREVIEW
paid calls possible:   NO — no reasoning provider and no generation provider is constructed
plan file:             …
asset root:            …
output directory:      …
output-eligible assets: 14
analysis-only refs:     1 (counted, never resolved, never eligible for output)
expected artefacts:     …
```

---

## 6. In-point selection

The previous limitation was that every video scene began at `inSeconds: 0` — a
clip could only ever contribute its own opening, a second beat on the same clip
repeated it exactly, and any slate or fade-up went straight to the front of the
cut.

Each clip is now analysed with FFmpeg (`blackdetect`, `freezedetect` and
scene-change detection, read from lavfi's machine-readable `metadata` stream),
and each beat gets a window chosen from the whole runtime:

- candidate in-points are the measured scene boundaries, plus a coarse grid;
- a window over black, over frozen picture, or over footage an earlier beat
  already took is **rejected**, not merely scored down;
- transition handles are required either side;
- a beat may pin its own in-point, and the selector then _verifies_ it rather
  than overriding it;
- scoring is a pure function of the measurements and the plan; ties break on
  the earlier in-point, so two runs agree byte for byte.

`source-selection-report.json` records the analysis, the winning window, the
reasons it won, and the alternatives that were rejected with why.

---

## 7. Artefacts

Written to the run directory. Everything below `storyboard.html` exists before
FFmpeg runs, so a reviewer can see the cut that is about to be made.

| File                                   | What it is                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `creative-plan.json`                   | the validated plan, verbatim                                                                                                           |
| `asset-preflight.json`                 | every measured fact about the library                                                                                                  |
| `asset-provenance.json`                | rights, owner, checksum per asset                                                                                                      |
| `agent-outputs.json`                   | the plan projected onto the pipeline's shape; `reasoningProviderCalls: 0`                                                              |
| `originality-report.json`              | the governance gate, run before selection                                                                                              |
| `source-selection-report.json`         | clip analysis, chosen windows, rejected alternatives                                                                                   |
| `render-manifest.json`                 | the v2 manifest the renderer consumed                                                                                                  |
| `audio-plan.json`                      | the mix decisions, and a notice that QA's measurements are the binding ones                                                            |
| `storyboard.json`                      | per beat: timestamp, duration, role, source, checksum, rights, in/out, caption, transition, motion, CTA state, audio events, reasoning |
| `storyboard.html`                      | the same, as a page that opens from the filesystem — no server, no network, no script                                                  |
| `contact-sheet.png`                    | one frame per beat, at the in-point the cut will use                                                                                   |
| `render-summary.json`                  | measured output properties, QA verdict, the caveat                                                                                     |
| `*.mp4` + `*.qa.json` + `*.asset.json` | the master, its measurements, its asset record                                                                                         |

Artefacts carry no credential, no environment value, no absolute path and
nothing derived from reference material. `assertStoryboardSafe` walks the
storyboard and fails closed.

---

## 8. What QA measures

37 binding checks, every one from the produced file:

- exact duration, resolution, aspect ratio, frame rate, pixel format;
- video and audio codec, audio-stream presence;
- **faststart**, read from the container's atom table rather than from the flag
  that was requested;
- caption presence and timing, CTA presence, **CTA hold duration**, safe-area
  compliance;
- first/final frame not blank, and a **black/freeze walk** across the body of
  the cut — skipping windows the manifest _declared_ still, because a held end
  card is intentional;
- **integrated loudness, loudness range, true peak, clipping, longest silence,
  channel layout and sample rate**, from a decode of the master;
- rights eligibility, provenance completeness, output checksum and readability;
- storyboard-to-render agreement on beat count, duration and rights.

A measurement that could not be taken is reported with its exact reason and is
**never a pass** — an unmeasurable binding property is not a satisfied one.

**A binding failure sends the master to `rejected/`**, marks the asset record
`FAILED`, returns exit code 8, and never reports READY.

---

## 9. Exit codes

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | rendered; requires human approval                                          |
| 2    | the request or the plan is invalid                                         |
| 4    | an asset's rights forbid output, or reference material was in the manifest |
| 5    | a source is missing, unusable, or has no legal segment                     |
| 6    | the edit could not be built                                                |
| 7    | FFmpeg failed                                                              |
| 8    | a binding QA check failed                                                  |
| 10   | originality risk is HIGH; nothing was rendered                             |
| 11   | `--execution-mode` named a tier a human-authored plan cannot reach         |

---

## 10. Tests

```powershell
pnpm --filter @combat/media test    # catalogue, clip analysis, audio measurement, QA
pnpm --filter aamp-cli test         # plan, preflight, selection, storyboard, acceptance
```

The live acceptance test needs FFmpeg and the generated asset root, and skips
loudly when either is absent. It runs with `REASONING_PROVIDER=claude` and **no
API key** — a configuration a campaign run refuses outright — which is what
proves no provider was constructed.

---

## 11. Limitations

- **Creative quality is a human judgement.** A person wrote the plan; whether
  it is a good advertisement is not something this pipeline measures or claims.
- The committed example runs against **synthetic** `lavfi` media, not real
  Combat Reviews footage. It demonstrates the mechanism.
- Nothing here is evidence about autonomous reasoning, which this mode does not
  use, or about AI video generation, which it does not perform.
- Creative Memory is not consulted in this mode: there is no agent to inject
  context into.
