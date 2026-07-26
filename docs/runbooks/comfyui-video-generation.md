# ComfyUI video generation — operation runbook

AAMP generation vertical slice 2. Covers configuration, local and remote
operation, model and node provenance, licensing, failure modes, and the exact
commands.

Companion documents: `docs/aamp-architecture.md` (blueprint),
`docs/adr/0005-aamp-creative-memory-and-real-media-architecture.md` (rationale),
`docs/runbooks/database-migrations.md` (the AAMP-1 step 1 counterpart).

## 1. What this slice does and does not prove

The chain **prompt → specialist agents → shot specifications → ComfyUI →
generated clips → FFmpeg renderer → actual-media QA → MP4** is implemented end
to end and is exercised by tests at every seam.

It has **not** been proven against a real model. No compatible ComfyUI endpoint
was reachable from this machine at implementation time, so no
model-generated frame has ever passed through it. See §7 for the exact
hardware finding. Every protocol test runs against an in-process fake server,
which proves the adapter speaks ComfyUI correctly and proves nothing at all
about video quality. Only `COMFYUI_INTEGRATION=1` (§6) can establish that.

## 2. Configuration

All values are read through `packages/config`'s validated schema. Adapter code
never reads `process.env`.

| Variable                    | Default                  | Meaning                                                                          |
| --------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| `VIDEO_GENERATION_PROVIDER` | `mock`                   | `mock` or `comfyui`.                                                             |
| `COMFYUI_BASE_URL`          | —                        | e.g. `http://127.0.0.1:8188`. Required when `comfyui`. Must be `http:`/`https:`. |
| `COMFYUI_OUTPUT_TIMEOUT_MS` | `900000`                 | End-to-end deadline for one shot, not a per-request timeout.                     |
| `COMFYUI_WORKFLOW_PROFILE`  | `LTX_2_3_DRAFT`          | Profile key. Validated against the registry at construction.                     |
| `COMFYUI_CLIENT_ID`         | `combat-creative-os`     | Client identity ComfyUI associates the queue/socket with.                        |
| `COMFYUI_API_KEY`           | —                        | Optional. Only for endpoints behind an authenticating proxy.                     |
| `COMFYUI_OUTPUT_DIR`        | `.aamp-output/generated` | Where retrieved clips land. Repository-relative unless absolute.                 |

**Fail-closed behaviour.** Two combinations are refused at startup rather than
degraded silently:

- `VIDEO_GENERATION_PROVIDER=mock` with `NODE_ENV=production`. The mock returns
  metadata-only placeholders; a production process running it would deliver a
  fabricated advertisement while every gate reported success.
- `VIDEO_GENERATION_PROVIDER=comfyui` with no `COMFYUI_BASE_URL`.

`createVideoGenerationProvider` re-checks both at construction, so neither the
Worker nor the CLI can be talked into the mock by configuration alone.

`COMFYUI_API_KEY` is a secret: it lives only in the git-ignored `.env`, is
absent from every client bundle, and is covered by `createLogger`'s pino
redaction. `.env.example` carries names and explanations only.

## 3. Workflow profiles

Profiles are provider-owned and versioned. **Callers cannot author graphs** —
an API client that could post its own node graph could execute arbitrary Python
on the render host. `submit()` accepts the vendor-neutral request shape and a
profile key; the graph is built inside the profile.

### `LTX_2_3_DRAFT` — `templateStatus: SIGNATURES_VERIFIED_NOT_EXECUTED`

Fast iteration profile. Text-to-video and image-to-video, vertical 9:16, short
shots, explicit seed/frame-rate/dimensions.

- Model: `ltx-2-19b-distilled` — <https://huggingface.co/Lightricks/LTX-Video>
- Licence: LTX-Video Open Weights Licence (use-based restrictions annex).
  Recorded as permitting commercial output; **confirm the current terms before
  any commercial delivery**.
- Expected files: `models/checkpoints/ltx-2-19b-distilled.safetensors`,
  `models/text_encoders/gemma-3-12b-it-qat-q4_0-unquantized`
- Hardware floor: **12 GB VRAM** (FP8), 32 GB RAM, 100 GB disk —
  <https://docs.comfy.org/tutorials/video/ltx/ltx-2>
- Node classes, verified against `comfy_extras/nodes_lt.py`, `nodes.py` and
  `comfy_extras/nodes_video.py`: `CheckpointLoaderSimple`, `CLIPTextEncode`,
  `EmptyLTXVLatentVideo(width,height,length,batch_size)`,
  `LTXVConditioning(positive,negative,frame_rate)`,
  `ModelSamplingLTXV(model,max_shift,base_shift)`,
  `LTXVImgToVideo(positive,negative,vae,image,width,height,length,batch_size,strength)`,
  `KSampler`, `VAEDecode`, `LoadImage`, `CreateVideo`, `SaveVideo`.

`SIGNATURES_VERIFIED_NOT_EXECUTED` is a deliberate distinction: every node
class and input name was read out of ComfyUI's source, and the graph is
well-formed against those signatures, but it has never been executed. Raise it
to `EXECUTED_AGAINST_LIVE_SERVER` only after §6 passes on a real endpoint.

### `HUNYUAN_VIDEO_1_5_QUALITY` — `templateStatus: REQUIRES_LIVE_VERIFICATION`

Declared, **not selectable**. `buildGraph` throws and `validateEnvironment`
returns incompatible even on a fully-equipped endpoint.

Its models, node classes, licence and hardware floor are all recorded from
official sources. What could not be established from those sources is how the
two text encoders (`qwen_2.5_vl_7b_fp8_scaled`, `byt5_small_glyphxl_fp16`) are
loaded and combined in the native template. Shipping a guessed graph as a
working profile is exactly what "never claim support merely because a profile
exists" forbids, so it refuses instead.

- Hardware floor: **24 GB VRAM** —
  <https://blog.comfy.org/p/hunyuanvideo-15-native-support>
- Licence: Tencent HunyuanVideo Community Licence. `permitsCommercialOutput:
false` — treat commercial delivery as blocked pending review.

No third-party custom nodes or workflow packs are imported. Nothing is
downloaded or executed automatically; model files are an operator step.

## 4. Local ComfyUI operation

1. Confirm the GPU clears the profile's floor (§3). Below it, generation either
   OOMs or silently falls back to a quality nobody signed off on.
2. Install ComfyUI and the profile's model files into the folders listed above.
3. Start ComfyUI (`python main.py --listen 127.0.0.1 --port 8188`).
4. Set `VIDEO_GENERATION_PROVIDER=comfyui` and `COMFYUI_BASE_URL` in `.env`.
5. Verify before spending GPU time — `verifyEnvironment()` checks
   `/object_info` for every required node class and `/system_stats` for VRAM,
   and names exactly what is missing.

## 5. Remote ComfyUI operation

Identical, except `COMFYUI_BASE_URL` points at the remote origin and
`COMFYUI_API_KEY` is set if the endpoint is behind an authenticating proxy. The
adapter is transport-agnostic; `http:` is upgraded to `ws:` and `https:` to
`wss:` for progress monitoring.

A rented GPU endpoint costs money. Set `costCentsPerSecond` on the provider so
the budget ledger records real spend instead of a zero.

## 6. Commands

```sh
# Deterministic fixture media (no rights question, git-ignored)
pnpm aamp:fixtures

# Render an existing manifest with real FFmpeg
pnpm aamp:render --manifest packages/media/fixtures/combat-reviews-15s.manifest.json

# The full chain: prompt -> agents -> ComfyUI -> FFmpeg -> QA -> MP4
pnpm aamp:generate --manifest apps/aamp-cli/examples/combat-reviews-15s.generation.json

# Agents only, no generation and no endpoint required
pnpm aamp:generate --manifest apps/aamp-cli/examples/combat-reviews-15s.generation.json --plan-only

# The binding real-generation acceptance test (opt-in, never in CI)
COMFYUI_INTEGRATION=1 COMFYUI_BASE_URL=http://host:8188 \
  pnpm --filter @combat/providers test:comfyui
```

`FFMPEG_PATH` / `FFPROBE_PATH` pin the toolchain when the binaries are not on
`PATH` — common on Windows, where winget installs to a package directory it
does not link.

The integration test verifies the endpoint, checks nodes and VRAM, submits one
minimal generation, retrieves real bytes, ffprobes the result, and proves
**non-zero motion** by running the clip through `mpdecimate` and asserting more
than one frame survives — a model that returned a frozen frame passes a
"file exists" check and fails this one. It removes only its own temporary
directory.

## 7. Hardware finding (2026-07-26)

Inspection of the development machine:

| Fact               | Value                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| GPU                | NVIDIA GeForce GTX 1650 Ti, driver 560.70, CUDA 12.6                     |
| VRAM               | **4 GB**                                                                 |
| RAM                | 15.8 GB total                                                            |
| Disk               | 344 GB free                                                              |
| Docker             | 29.6.2, `nvidia-container-runtime` registered; Linux VM capped at 8.2 GB |
| ComfyUI            | not installed; no model files present                                    |
| `COMFYUI_BASE_URL` | not configured                                                           |

4 GB is below the lowest profile floor (12 GB) by a factor of three, and no
remote endpoint was configured. Execution mode is therefore `UNAVAILABLE`:
**`BLOCKED_BY_HARDWARE`** locally and **`BLOCKED_BY_MISSING_REMOTE_ENDPOINT`**
remotely. No model was downloaded, because none could run.

## 8. Failure modes

| Symptom                                          | Cause                                          | Behaviour                                                    |
| ------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------ |
| Startup refuses with `VIDEO_GENERATION_PROVIDER` | mock selected in production                    | Config refuses. Select `comfyui`.                            |
| Startup refuses with `COMFYUI_BASE_URL`          | `comfyui` with no endpoint                     | Config refuses rather than falling back to mock.             |
| `not a known workflow profile`                   | typo in `COMFYUI_WORKFLOW_PROFILE`             | Refused at construction.                                     |
| `REQUIRES_LIVE_VERIFICATION`                     | Hunyuan selected                               | Refused by design (§3).                                      |
| `PROVIDER_REJECTED` on submit                    | ComfyUI 400 — missing model file, unknown node | Non-retryable; fix the install.                              |
| `PROVIDER_TIMEOUT`                               | deadline passed                                | Retryable; the run is interrupted first so the GPU is freed. |
| `has no record of job …`                         | ComfyUI restarted and lost its queue           | Retryable; the attempt redispatches.                         |
| `completed with no video output`                 | graph produced no save-node artefact           | Non-retryable; the template is wrong.                        |
| `zero-byte file`                                 | download returned nothing                      | Non-retryable; never registered as an asset.                 |
| Attempt FAILED after success                     | ffprobe could not measure the clip             | Provider success alone never marks an asset READY.           |
| `no rights metadata`                             | reference asset has no `LicenseRecord`         | Fail-closed by design.                                       |
| `ANALYSIS_ONLY` refusal                          | reference is study-only material               | Refused before any byte is transmitted.                      |

## 9. Security properties

- **No arbitrary node execution.** Only server-owned, versioned profiles build
  graphs. There is no path from an API body to a ComfyUI node.
- **No arbitrary filesystem access.** Filenames returned by ComfyUI are used
  only as URL-encoded `/view` query parameters, never joined onto a local path.
  Destination filenames are derived from content checksums.
- **No authored text in paths or commands.** Prompt text travels only as a JSON
  value inside a node's `inputs`. The output filename prefix is a sha256 slice.
  Uploaded reference filenames are checksum-derived.
- **Every response is parsed.** `protocol.ts` is the parse boundary; a
  malformed body becomes a typed failure, never `undefined` three frames later.
- **Rights are enforced before transmission.** `ANALYSIS_ONLY`, missing rights
  metadata, an expired licence, or an unrecognised usage class all refuse
  before an upload is attempted.

## 10. Known limitations

- No real generation has occurred (§1, §7).
- `LTX_2_3_DRAFT`'s graph is unexecuted (§3).
- `HUNYUAN_VIDEO_1_5_QUALITY` is not selectable (§3).
- **Image-to-video through the Temporal path is not yet reachable.**
  `dispatchShotGenerationActivity` resolves each reference's rights from its
  `LicenseRecord`, but not its bytes: an `Asset` carries an `s3Key`, and
  materialising it to a local file needs the storage provider wired into that
  Activity. The adapter fails closed with a clear message. The CLI path _is_
  fully exercisable, because a generation manifest supplies real local paths.
- The CLI does not persist `Asset`/`AssetProvenance` rows; repository
  registration remains the Activity's job. The CLI writes its artefacts and the
  built render manifest to `.aamp-output/`.
- No live Temporal server is available here, so the wired Worker has not been
  run against one.
