# Prompt-driven source-based advertisement generation

The `pnpm aamp:generate --request …` flow: a natural-language campaign brief
plus a library of real owned assets, producing a prompt-specific vertical
advertisement with no GPU, no ComfyUI and no generated footage.

Companion documents: `docs/runbooks/comfyui-video-generation.md` (the optional
generation source), `docs/architecture.md` §8.

## 1. Input to output

```
campaign request (prompt + product/event facts + brand kit)
  → real reasoning provider                     [refused if unavailable]
  → Campaign Strategist                         [receives the prompt verbatim]
  → Creative Director                           [receives the prompt verbatim]
  → Script and Timing Director                  [receives the prompt verbatim]
  → Shot-Prompt Engineer, once per shot         [receives the prompt verbatim]
  → source-asset selection                      [deterministic, rights-checked]
  → prompt-specific render manifest             [exact timeline, provenance per shot]
  → FFmpeg render                               [deterministic, existing renderer]
  → actual-media QA                             [measured from the produced file]
  → creative scorecard                          [heuristics + measured checks]
  → provenance report
  → downloadable MP4                            [pending human approval]
```

Every stage writes its artefact before the next begins, so a run that fails
halfway still shows what it planned, what it accepted and what it tried to cut.

## 2. The command

```powershell
pnpm aamp:generate `
  --request apps/aamp-cli/examples/combat-reviews-weekend.request.json `
  --assets  apps/aamp-cli/examples/combat-reviews-production-assets.json `
  --output-dir .aamp-output/runs
```

`--assets` and `--output-dir` are optional; the request names both. Additional
flags: `--plan-only` (stop after planning), `--fixture-demo` (see §4), `--json`.

The brief lives in a **separate text file** referenced by `promptFile`, so a
multi-paragraph brief with quotes, dollar signs and line breaks never has to
survive PowerShell quoting.

### Exit codes

| Code | Meaning                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------- |
| 0    | success — rendered and QA-passed, pending human approval                                             |
| 2    | invalid campaign request (unreadable, malformed, or bad configuration)                               |
| 3    | real reasoning unavailable                                                                           |
| 4    | invalid asset rights (`ANALYSIS_ONLY`, `UNKNOWN_RIGHTS`, withheld use, expired licence)              |
| 5    | missing production assets (file absent, unsafe path, checksum mismatch, no usable source for a shot) |
| 6    | planning failure (an agent failed, or the timeline could not be built)                               |
| 7    | rendering failure                                                                                    |
| 8    | QA failure — a file was produced but it is **not** READY                                             |

## 3. Example campaign request

```json
{
  "requestVersion": 1,
  "name": "combat-reviews-weekend",
  "workspaceId": "…uuid…",
  "campaignId": "…uuid…",
  "brandName": "Combat Reviews",
  "promptFile": "./combat-reviews-weekend.prompt.txt",
  "objective": "Drive free app installs from fans planning their weekend",
  "targetAudience": "Combat sports fans aged 18-34",
  "platform": "TIKTOK",
  "targetDurationSeconds": 15,
  "productFacts": [
    {
      "id": "predictions",
      "label": "Predictions",
      "detail": "Users submit predictions before each card."
    }
  ],
  "eventFacts": [
    { "id": "weekend-count", "label": "Events this weekend", "detail": "12 events are scheduled." }
  ],
  "cta": {
    "headline": "Download Free",
    "subline": "Every event. Every round.",
    "durationSeconds": 3
  },
  "brandKit": { "logoAssetId": "logo-primary", "safeAreaBottomPx": 420 },
  "sourceAssetManifest": "./combat-reviews-production-assets.json",
  "generation": { "source": "SOURCE_ONLY", "generatedShotCount": 0 }
}
```

`generation.source` is `SOURCE_ONLY` by default. `COMFYUI` additionally
generates shots and requires a working endpoint — see the ComfyUI runbook.

## 4. Execution modes

| Mode           | How                                               | What it proves                                                                                                                     |
| -------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `REAL`         | `REASONING_PROVIDER=claude` + `ANTHROPIC_API_KEY` | A prompt-specific campaign result. Still requires human approval.                                                                  |
| `FIXTURE_DEMO` | `--fixture-demo`                                  | The pipeline works. **The creative is replayed from committed fixtures and ignores the campaign prompt.** Never a campaign result. |

**A normal run refuses mock reasoning.** The previous milestone made fixtures
the default because the generic mock could not satisfy the agent schemas; that
is now the wrong default, because this milestone's entire claim is that the ad
is specific to the prompt. Without a real provider the run **exits 3** and names
the two ways forward. Fixture reasoning is never substituted silently, and
every artefact of a demo run is stamped `DEMONSTRATION ONLY`.

## 5. Example asset manifest

```json
{
  "manifestVersion": 1,
  "library": "Combat Reviews owned production library",
  "assets": [
    {
      "id": "screen-predictions",
      "path": "./screens/predictions.png",
      "kind": "IMAGE",
      "role": "APP_SCREENSHOT",
      "description": "Community predictions screen",
      "rights": {
        "classification": "OWNED",
        "owner": "Combat Reviews",
        "permittedOutputUse": true
      },
      "beats": ["PREDICTION"],
      "tags": ["predictions", "picks"],
      "checksumSha256": "…optional…"
    }
  ]
}
```

Roles: `SOURCE_CLIP`, `APP_SCREENSHOT`, `BRAND_CARD`, `LOGO`, `MUSIC`.
Beats: `HOOK`, `EVENT_DETAIL`, `INFORMATION`, `PREDICTION`, `DISCUSSION`, `CTA`.

## 6. Rights rules

**Permitted for output:** `OWNED`, `COMMISSIONED`, `LICENSED_FOR_OUTPUT` — and
only when `permittedOutputUse` is also `true`, because a licence covering
internal review but not paid media is a real and common case.

**Refused, always:**

- `ANALYSIS_ONLY` — benchmark advertisements, competitor reels and any other
  study-only reference. These may be analysed for pacing and structure and
  **must never enter a production asset manifest**. Refused at parse time, so no
  later stage can let one slip through.
- `UNKNOWN_RIGHTS` — "we're not sure" is the state real libraries are actually
  in, and treating it as permission is how unlicensed footage ships.
- Expired licences, missing files, empty files, unsafe paths that escape the
  allowed roots, checksum mismatches, and files that decode as a different media
  kind than declared.

Rights and containment are checked **before** any byte is read. Every accepted
asset is measured with ffprobe; declared metadata that disagrees is recorded as
a discrepancy, and the measured value is what the timeline uses.

## 7. Selection

Deterministic by construction: every score is a pure function of the request
and the manifest, ties break on asset id, and nothing consults a clock or a
random source. The same approved request against the same library always
produces the same edit — otherwise a human approval would mean nothing.

Scoring considers declared beat, asset role against beat (footage opens,
app screens inform), orientation, resolution, relevance to the campaign's own
facts, and a penalty for reuse. Each selection records why it won, in
`source-selection.json`.

Successive `FEATURE` shots walk `INFORMATION → PREDICTION → DISCUSSION`, which
is what turns generic feature beats into the requested story arc.

When nothing fits, the selector uses a designed `BRAND_CARD` and flags the
scene as a fallback; with no brand card available it raises a typed
missing-source error. It never substitutes unrelated footage.

## 8. Run directory

One directory per run, containing: the final MP4, `campaign-request.json`,
`agent-outputs.json`, `render-manifest.json`, `source-selection.json`,
`asset-provenance.json`, the actual-media QA report, `creative-scorecard.json`,
`execution-mode.json` and `run-summary.json`. No secret is written to any of
them; a test asserts it.

## 9. Three different claims about output quality

These are not the same thing and the system keeps them apart:

- **Technically valid** — the file is 1080×1920 H.264/AAC at the requested
  duration and passes actual-media QA. This is **measured** and binding. A QA
  failure means the run is `REJECTED` and never READY, whatever any score says.
- **Prompt-specific** — the creative was produced by a real reasoning model
  from this campaign's brief and facts. True only in `REAL` mode. Proven at the
  input boundary by `prompt-propagation.test.ts`.
- **Agency-grade** — a human creative judgement. **The system never claims
  it.** `creative-scorecard.json` always carries `agencyGradeClaim:
"NOT_ASSESSED"` and `requiresHumanApproval: true`; its dimension scores are
  structural heuristics, and a high score means only "nothing structurally
  wrong was detected".

No prompt in this repository names or imitates an advertising agency. Creative
intent is expressed as explicit properties — pacing, contrast, framing,
typography, rhythm — and every planning agent is instructed accordingly.

## 10. Current limitations

- Fixture-demo creative ignores the campaign prompt entirely (§4).
- The acceptance fixture runs in `FIXTURE_DEMO`, so it proves the pipeline, not
  prompt-specificity of copy; the propagation tests cover that separately.
- Sources are trimmed from their start (`inSeconds: 0`); there is no shot-level
  in-point search within a long clip yet.
- Scene audio is not mixed — only a music bed, and no voiceover.
- No `Asset`/`AssetProvenance` rows are written; the run directory is the record
  and repository persistence remains the Activity path's job.
- Loudness is normalised but not measured back out of the file.
- Real AI video generation remains unproven on this hardware — see the ComfyUI
  runbook.
