# Creative Memory — lawful benchmark ingestion

How reference advertisements are catalogued, analysed and browsed, and — more
importantly — how they are kept permanently separate from anything this system
publishes.

Companion documents: `docs/runbooks/prompt-driven-advertisement-generation.md`
(the production side), `docs/architecture.md` §8.

## 1. Three statements that govern everything here

1. **Public availability is not permission.** That an advertisement can be
   watched on a public page says nothing about the right to copy, store or
   reuse it. A link-only record exists precisely so a reference can be
   catalogued without asserting a right nobody granted.
2. **Ingestion grants no output rights.** Nothing in this subsystem can make a
   reference usable in a produced advertisement. Not a rights classification,
   not a processing state, not human approval. Material for output is ingested
   separately through the production-asset system, which performs its own
   independent rights check.
3. **Creative Memory extracts principles, not assets.** The durable output of
   studying a reference is a _transferable principle_ and its paired
   _prohibited direct similarity_ — what may be learned, and what must not be
   copied. The two are stored together because a lesson without its boundary is
   an invitation to imitate.

**Semantic retrieval is not implemented.** This milestone is ingestion and
structural extraction only. There are no embeddings, no vector store, no
reranking, and no agent can query this library — Creative Memory results reach
an agent only as Activity-resolved context, which no code does yet.

## 2. Architectural separation

| Concern           | Production side                                | Reference side                                                           |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| Domain contracts  | `production-assets.ts`                         | `@combat/domain`'s `creative-memory.ts`                                  |
| Tables            | `assets`, `license_records`                    | `reference_*` (separate namespace)                                       |
| Repository        | `asset-repository.ts`                          | `reference-repository.ts`                                                |
| Rights vocabulary | `OWNED`, `COMMISSIONED`, `LICENSED_FOR_OUTPUT` | `LINK_ONLY`, `ANALYSIS_ONLY`, `LICENSED_FOR_ANALYSIS`, `OWNED_REFERENCE` |
| Storage           | `.aamp-output/`                                | `.aamp-reference-analysis/`                                              |

The two rights vocabularies share **no** output-permitting value.
`LICENSED_FOR_OUTPUT` and `PRODUCTION_ASSET` are deliberately absent from the
reference enum and from the Prisma enum, so a reference cannot even be _spelled_
in a way the renderer would accept. `referenceGrantsNoOutputRights()` is total
over the enum, and a test asserts it stays total as the enum grows.

FiftyOne is a **disposable projection**. PostgreSQL is canonical for rights,
provenance, annotations and state; the dataset can be deleted and rebuilt at any
time without losing anything. Qdrant is not implemented.

## 3. Link-only versus local analysis

**Link-only** (`LINK_ONLY`) registers metadata, an official URL and annotations,
and acquires no bytes. Scene extraction is impossible and no technical or craft
measurement is ever produced — fabricating a duration for a file we do not hold
would be inventing evidence. The manifest schema refuses a link-only entry that
supplies a local path or a checksum.

**Local analysis** (`ANALYSIS_ONLY`, `LICENSED_FOR_ANALYSIS`, `OWNED_REFERENCE`)
covers a file the operator lawfully possesses. It is validated, inspected,
segmented, and derived from — and **never modified**.

Nothing in this repository downloads, scrapes or automates access to any
advertisement. Acquiring a copy is an operator decision made outside this
system, on a legal basis recorded as `accessBasis`.

## 4. Manifest format

```json
{
  "manifestVersion": 1,
  "library": "Combat Reviews benchmark study library",
  "workspaceId": "…uuid…",
  "references": [
    {
      "referenceId": "stable-key",
      "title": "…",
      "brand": "…",
      "agency": "…",
      "director": "…",
      "officialUrl": "https://…",
      "localAnalysisPath": "./refs/ad.mp4",
      "accessBasis": "OPERATOR_LAWFUL_COPY",
      "rightsClassification": "ANALYSIS_ONLY",
      "rightsHolder": "Third party",
      "permittedUses": ["private structural analysis"],
      "prohibitedUses": ["no use in any produced advertisement or other output"],
      "jurisdictionNotes": "…",
      "businessRoles": ["MOTION_AND_TRANSITIONS"],
      "expectedChecksumSha256": "…optional…",
      "annotation": {
        "authorId": "…",
        "transferablePrinciple": "…",
        "prohibitedDirectSimilarity": "…",
        "reviewerConfidence": "HIGH"
      }
    }
  ]
}
```

`prohibitedUses` **must** explicitly prohibit output use, and `permittedUses`
must **not** contain anything output-like. Both are enforced at parse time.

## 5. Role taxonomy

`CAMPAIGN_STRATEGY`, `CREATIVE_DIRECTION`, `SCRIPT_AND_TIMING`,
`REFERENCE_INTELLIGENCE`, `PREVISUALISATION`, `VIDEO_PRODUCTION`,
`MOTION_AND_TRANSITIONS`, `SOUND_AND_MUSIC`, `VISUAL_QUALITY_CONTROL`,
`CONTINUITY_AND_EDITORIAL`, `COPY_AND_BRAND_CONTROL`, `PLATFORM_OPTIMISATION`,
`PERFORMANCE_ANALYSIS`. A reference may demonstrate several.

## 6. Ingestion state machine

```
REGISTERED ──(link-only stops here)
    │
 VALIDATED ── path safety, existence, size, checksum, duplicate check
    │
 INSPECTED ── ffprobe geometry, codecs, duration
    │
 SEGMENTED ── scene boundaries persisted
    │
TRANSCRIBED ── only when a transcript was genuinely produced
    │
REVIEW_REQUIRED ── analysis complete, awaiting a human
    │
READY_FOR_RETRIEVAL ── a human approved the annotations
```

`FAILED` is reachable from any step and records a typed reason.
`PROJECTED` marks a reference exported to FiftyOne.

**`READY_FOR_RETRIEVAL` does not mean output-permitted.** It means the analysis
finished and a person read it.

## 7. Commands

```powershell
# Synthetic, repository-safe fixtures (no third-party material)
node apps/aamp-cli/dist/creative-memory/generate-reference-fixtures.js

# Register link-only references — acquires no media
pnpm aamp:reference register --manifest apps/aamp-cli/examples/reference-library.manifest.json

# Ingest local references: validate, inspect, segment, derive, measure
pnpm aamp:reference ingest --manifest apps/aamp-cli/examples/reference-library.manifest.json `
  --analysis-dir .aamp-reference-analysis

# Browse and review
pnpm aamp:reference list    --workspace <uuid> [--state REVIEW_REQUIRED] [--role MOTION_AND_TRANSITIONS]
pnpm aamp:reference inspect --workspace <uuid> --reference <key>
pnpm aamp:reference approve --workspace <uuid> --annotation <uuid>

# Project to FiftyOne
pnpm aamp:reference project --workspace <uuid> --output-dir .aamp-reference-analysis/_fiftyone
```

`FFMPEG_PATH` / `FFPROBE_PATH` pin the toolchain when the binaries are not on
`PATH`.

### Exit codes

| Code | Meaning                                  |
| ---- | ---------------------------------------- |
| 0    | success (a skipped duplicate is success) |
| 2    | invalid manifest                         |
| 3    | invalid rights                           |
| 4    | unsafe path                              |
| 5    | missing media                            |
| 6    | inspection failure                       |
| 7    | scene-detection failure                  |
| 8    | derivation failure                       |
| 9    | transcription unavailable when required  |
| 10   | persistence failure                      |

## 8. Scene detection

Two real providers, selected automatically:

- **`PySceneDetectProvider`** — preferred when installed. Pinned release
  **0.6.4**, `detect-adaptive`, CSV output parsed by column name.
  Install it yourself; nothing here downloads it:

  ```
  python -m pip install "scenedetect[opencv]==0.6.4"
  ```

- **`FfmpegSceneDetectionProvider`** — the fallback, and what runs on a machine
  where PySceneDetect was never installed. Uses FFmpeg's `select=gt(scene,T)`
  filter, read as machine-readable JSON via `ffprobe -of json`. This is why
  Creative Memory can segment references with no additional dependency.

Both use argument arrays without a shell, bounded execution time, cancellation,
and typed failures, and neither scrapes human-formatted terminal output.
`MockSceneDetectionProvider` is the deterministic fake for tests.

## 9. Optional transcription

A typed `TranscriptionProvider` boundary suitable for Whisper. Disabled by
default. `WhisperCliTranscriptionProvider` shells out to an **already installed**
`whisper` command and a model the operator already has; nothing downloads model
weights. Enable with `REFERENCE_WHISPER=1`.

When unavailable, the run records that fact and continues. **It never fabricates
a transcript** — a fabricated transcript is indistinguishable from a real one in
the database and would then be studied as evidence.

## 10. Deterministic craft measurements

Duration, scene count, first-cut timestamp, average/median/min/max scene
duration, cuts per second, scene-duration histogram, aspect ratio, resolution,
frame rate, video codec, audio presence and codec, average and peak bitrate,
silence intervals, black-frame intervals.

All are computed from the file or from detected boundaries. **No subjective
label is ever recorded as a measurement** — "powerful", "premium", "engaging"
are human readings and live only in an attributed, versioned
`ReferenceAnnotation`.

Silence and black-frame runs are read as ffprobe frame _metadata_ (`lavfi.
silence_start`, `lavfi.black_start`), not scraped from FFmpeg's log.

## 11. FiftyOne projection

`pnpm aamp:reference project` writes `fiftyone-samples.json` and a
`load_reference_library.py` loader. Projection is idempotent: samples are keyed
by `reference_key` and replaced, and keys no longer exported are deleted.
Link-only references are skipped rather than given a fabricated path. Every
sample carries `analysis_only: true` and `output_permitted: false`, and points at
the **analysis proxy**, never the original file.

```powershell
python -m pip install "fiftyone==1.0.1"
python .aamp-reference-analysis/_fiftyone/load_reference_library.py
fiftyone app launch combat_creative_reference_library
```

FiftyOne is never imported inside a Temporal workflow, and its absence produces
a typed `FiftyOneUnavailableError` rather than corrupting ingestion.

## 12. Provenance

Every derived byte — proxy, frame, scene clip — records the source checksum, the
exact argv that produced it, the tool version and the ingestion run. A derived
file whose origin cannot be named is indistinguishable from material of unknown
rights, which is the situation this subsystem exists to avoid.

## 13. Deletion and correction

- **Correct an annotation**: add a new one. Annotations are versioned and never
  edited in place, so a later reader can see what an earlier reviewer thought.
- **Re-ingest a reference**: run `ingest` again. Derived analysis is cleared and
  rewritten wholesale — scene indices shift when a detector or threshold
  changes, so a partial merge would strand old scenes.
- **Withdraw a reference**: delete its `reference_advertisements` row. Cascades
  remove scenes, frames, metrics, transcripts, annotations and derived rows.
  Then delete its directory under `.aamp-reference-analysis/` and re-run
  `project`, which removes the sample from FiftyOne.
- **A rights change**: withdraw and re-register with the corrected basis. Never
  edit a classification in place — the record of what was believed at ingestion
  time is itself evidence.

## 14. Current limitations

- **No semantic retrieval.** No embeddings, no Qdrant, no reranking, no agent
  access. That is the next milestone.
- Scene detection is a hard-cut detector; dissolves and gradual transitions are
  reported as a single scene.
- Confidence scores are not populated by the FFmpeg detector (the filter emits
  boundaries, not per-cut scores).
- Peak bitrate is measured from video packets only.
- PySceneDetect, Whisper and FiftyOne are all uninstalled here, so the adaptive
  detector, transcription and the browser UI are unexercised on this machine.
  The FFmpeg detector, frame extraction and all craft measurements **are**
  exercised, against synthetic fixtures, in `ingestion-acceptance.test.ts`.
- Reference media is not uploaded to object storage; it stays where the operator
  put it, and derived analysis goes to a local directory.
