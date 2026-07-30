# Runbook — Scene-1 LTX acceptance

`pnpm aamp:ltx-scene-01` proves **one** scene: the authoritative high-quality
Scene-1 plate, one capped LTX 2.3 Fast generation, the raw portrait clip, a
local technical and visual inspection, a post-LTX Combat Reviews notification
composite, a comparison gallery, and a human review left open in `PENDING`.

It does not render the fifteen-second advertisement and it does not generate
Scenes 2–10.

---

## 1. Status — what is proven and what is not

**Proven, at zero cost, against the in-process fake LTX server and real
FFmpeg:** the whole chain end to end — upload ticket, signed PUT with every
required header, submit, `pending → processing → completed`, download,
checksum verification, ffprobe measurement, motion inspection, six-frame
contact sheet, notification composite, comparison gallery and a `PENDING`
review record. Also proven: the cost ceiling refusing before anything is
staged, a 402 mapping to its own exit code with **zero** submissions, a missing
key refusing with zero network requests, one-request enforcement, deterministic
plate discovery with every ambiguity refused, and no credential or signed URL in
any artefact.

**Proven against the live `api.ltx.io` — the real generation happened.** One
capped `ltx-2-3-fast` request produced a genuine 1080x1920 clip:

|                       |                                                                    |
| --------------------- | ------------------------------------------------------------------ |
| Billable submissions  | **1 of 1 authorised**                                              |
| Charged               | **36¢** against a **40¢** ceiling (`DECLARED_RATE_CARD`)           |
| Network requests      | 11 — ticket, PUT, submit, polls, one download                      |
| Raw clip              | `raw/scene-01-raw-ecc2dcb54f794957.mp4`                            |
| sha256                | `ecc2dcb54f7949578add46ba0f47fe5a5c1fca2163ab99b4faa62fe3d6155da7` |
| Measured              | 1080x1920, h264, yuv420p, 24.000 fps, 6.042 s, **no audio stream** |
| First-frame agreement | **0.9988** against FRAME-01 (floor 0.85)                           |
| Motion energy         | **2.0534** (floor 0.30 — the picture genuinely moves)              |
| Binding checks        | 17 of 17 `PASS`, zero measured defects                             |
| Technical verdict     | `TECHNICALLY_VALID`                                                |
| Review                | `PENDING` — no reviewer, no verdict                                |

The plate uploaded through the signed PUT on `storage.googleapis.com`, the job
was created, polled to `completed`, and the result downloaded from the same host
under the separate result allowance. No credential, signed URL or query string
reached any artefact.

### The clip is technically valid and it does not execute the brief

This is the part a technical report would miss, and it is why nothing is
approved. Measured facts first, then what a person can see:

**What the brief asked for:** "The camera pushes in very slowly, about three
percent across the shot, holding the same framing and eyeline", and "the subject
remains focused on the phone", with "no dramatic head turn".

**What the clip does:**

- **The push is roughly 1.75x, not 3%.** At 0.50 s the head and both shoulders
  are in frame; by 5.54 s the frame is cropped above the mouth and **the
  subject's eyes have left the picture entirely**, with the handset filling the
  lower two-thirds. That is major composition drift, not a restrained move.
- **The subject lifts his gaze to the lens** for roughly the first two seconds
  before returning to the phone, against an explicit instruction to stay on the
  device with no dramatic head turn.

**What is correct, and worth saying:** identity is stable throughout — same
face, hair, beard and clothing as the plate; hands and fingers are plausible
with no duplication or melting; the phone stays rigid, rectangular and
**rear-facing**, exactly as Scene 1 requires; the black-and-deep-red palette
holds; and there is no invented lettering, mark, interface or notification
anywhere in frame. The prompt gate worked: nothing the model could have
fabricated was asked for.

**Recommendation on the evidence: reject on composition drift.** No retry was
made and none may be made automatically — a regeneration is a decision to spend
again, and it belongs to a person. The single authorised submission for this
milestone is now spent.

Note that first-frame agreement of 0.9988 is not in tension with this. It
measures the _opening_ composition against the plate, which is excellent; drift
is what happens after, and no automated measure in this repository scores it.

### Recorded decisions

**Scene 1 — REJECTED by Riki Taylor**, for `COMPOSITION_DRIFT` and `GAZE_LIFT`,
recorded in the append-only motion-review ledger against the run's own review
identity. The take is not approved and is not reused in the final
advertisement. Regeneration needs a materially smaller push held to the
approved framing, with the eyeline kept down on the device throughout — and it
is a fresh, separately authorised paid request.

```sh
pnpm aamp:ltx-scene-01 decide --verdict REJECTED   --reviewer "<name>" --feedback "<what was observed and what must change>"
```

The `decide` subcommand reads no key and makes no request: recording a
rejection can never spend money, and the regeneration it implies is a separate
deliberate act.

**Scenes 8 and 9 — two-stage `HANDHELD_DRIFT`.** The authored creative
intention is preserved rather than substituted: the provider is asked for
`static`, and AAMP supplies the drift afterwards.

| Scene | Provider | Post-motion                                                  | Preserves                                          |
| ----- | -------- | ------------------------------------------------------------ | -------------------------------------------------- |
| 8     | `static` | smooth **2%** push, no rotation, no shake, no drift          | the right-side predictor-rank interface space      |
| 9     | `static` | smooth **1%** drift **left**, no zoom, no rotation, no shake | the phone geometry and discussion-interface region |

Neither is mapped to `dolly_in`, `dolly_out` or any other LTX move. **The FFmpeg
execution of the second stage is not implemented, and neither scene has been
generated.** What exists today is the typed contract, its enforcement and its
tests.

### The two transfer-host grants, and why there are two

`LTX_ALLOWED_UPLOAD_HOSTS` and `LTX_ALLOWED_RESULT_HOSTS` each permit the single
exact hostname `storage.googleapis.com`, matched by **equality**, over **HTTPS
only**, each for **its own operation only**.

They are two lists holding the same string on purpose. Upload and download are
different operations with different risks — one sends owned media out, the other
pulls in the bytes that become an advertisement — so a grant for one must never
be inherited by the other. `assertTransferUrlAllowed` takes the purpose as a
**required argument with no default**: there is no generally-trusted transfer
host, and no call site can forget to say what it is doing.

Neither grant is a wildcard, neither covers a subdomain, and a redirect away
from either target is refused rather than followed — following one would carry
the bytes, and the upload ticket's signature headers, to a host that never
passed the allowlist. Fifteen focused tests hold it, including
`storage.googleapis.com.example.com`, `attacker.storage.googleapis.com`,
`storage-googleapis.com`, `www.googleapis.com` and `storage.cloud.google.com`.

### The camera-motion boundary

AAMP's motion vocabulary is provider-neutral and was **not** narrowed to suit
one vendor. `packages/providers/src/ltx/camera-motion.ts` is the single place it
is translated into the eight values the live API named in its own 400 response.

Mapped, because each pair is the same physical move:

| Internal              | LTX           |
| --------------------- | ------------- |
| `STATIC`              | `static`      |
| `SLOW_PUSH_IN`        | `dolly_in`    |
| `SLOW_PULL_OUT`       | `dolly_out`   |
| `LATERAL_TRACK_LEFT`  | `dolly_left`  |
| `LATERAL_TRACK_RIGHT` | `dolly_right` |

Refused, with a typed `UNSUPPORTED_PROVIDER_CAMERA_MOTION` raised **before any
network access** — before the upload, before the submission, before a byte
leaves the process. The failure names the value and names `ltx-hosted`:

- `HANDHELD_DRIFT` — the LTX vocabulary has no handheld quality.
- `ORBIT_LEFT`, `ORBIT_RIGHT` — it contains no arc around the subject.
- `TILT_UP`, `TILT_DOWN` — a **tilt** rotates the camera from a fixed position;
  a **jib** raises or lowers the whole camera. They are different moves, so
  `jib_up`/`jib_down` are the nearest-_looking_ values and are not substitutes.
- `CRANE_DOWN` — considered and deliberately not mapped. It is not a member of
  `CAMERA_MOTIONS` and no internal contract defines it, so the condition for
  mapping it to `jib_down` (an internal contract defining it as a vertical
  camera descent) is not met. Were it ever added as one, `jib_down` would be its
  defensible equivalent and the table above is where that would be recorded.

A refused value is never silently omitted, never replaced with `static`, and
never left to the prompt wording to imply — a request whose structured field and
prose disagree lets the model follow either.

"Slow" travels in the prose prompt, where it belongs. **No speed, strength or
intensity field is invented** to carry it, because the API defines none and a
fabricated field is a guess with a number in it.

---

## 2. Inputs

| Input                | Where                                                                             | Rule                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Authoritative plates | operator-supplied `--plates-dir`                                                  | `FRAME1PLATE.*` … `FRAME10PLATE.*`, case-insensitive, `.png/.jpg/.jpeg`, all ten, all portrait. Read-only. |
| Scene-1 brief        | `apps/aamp-cli/campaigns/combat-reviews-flagship-02/scene-01-ltx-acceptance.json` | Authored by a person. Every prompt, colour, timing and headline lives here.                                |
| Combat Reviews mark  | operator-supplied `--logo`                                                        | The owned asset, overlaid. Never redrawn.                                                                  |
| Credential           | `LTXV_API_KEY`                                                                    | Presence and non-zero length only. Never printed, logged, persisted or returned.                           |

**Permanently rejected, refused by location:** anything under a
`generated-clips/` directory. The previously delivered `FRAME-01.mp4` and
`FRAME-07.mp4` are landscape, failed portrait fidelity, and are refused by
directory segment rather than by filename — renaming one does not readmit it.

---

## 3. Commands

```sh
# Phase 1 — resolve, measure, price. No key is read, no request is made.
pnpm aamp:ltx-scene-01 \
  --plates-dir "<the high quality plate folder>" \
  --max-cost-cents 40 \
  --dry-run

# Phase 3 — the single authorised paid request.
pnpm aamp:ltx-scene-01 \
  --plates-dir "<the high quality plate folder>" \
  --logo "<asset-root>/brand/logo.png" \
  --max-cost-cents 40
```

`--max-cost-cents` is required. A spending ceiling that defaults is a ceiling
nobody chose. The effective ceiling is the lower of the flag and the brief's own
`maximumAuthorisedCostCents`.

---

## 4. What the dry run establishes

Against the operator's real folder, at zero cost:

```
all 10 plates present; FRAME-01 resolves to FRAME1PLATE.png (941x1672, PORTRAIT)
staging FRAME-01 for upload: 941x1672 resampled to 1080x1920 (lanczos, no new detail)
ltx-2-3-fast, 6s, 1080x1920, 24fps, generate_audio=false
1 request, maximum 36¢ against a 40¢ ceiling
billable requests 0 of 1 · network requests 0
```

FRAME-01 is `sha256 87f2d011a561d9b0…`. The plates are 941×1672 (FRAME9PLATE is
2160×3840); the upload image is a declared lanczos resample to 1080×1920 with an
anisotropy of 0.000531 and `createsNewDetail: false`. The generated clip is
bounded by the detail the plate already had, and the provenance says so rather
than leaving it to be inferred.

---

## 5. Costs

One 6-second `ltx-2-3-fast` generation at 1080×1920 is **36¢** against the
operator-declared rate card (`LTX_PRICING_PROFILE`, version 1), under a **40¢**
ceiling. The ceiling is checked **before** anything is staged, resampled or
uploaded.

**There is no exact provider-reported cost, and the live run confirmed it.**
The completed job's status body carried no billed-amount field, so the charge is
computed from the declared rate card and labelled `DECLARED_RATE_CARD`. The
executed run was charged **36¢** on that basis against a **40¢** ceiling.
`cost-report.json` states the ceiling, the computed maximum, the charge and its
basis as four separate facts and never infers one from another.

---

## 6. Artefacts

Written under `.aamp-output/storyboard-02-ltx-scene-01-acceptance/` (git-ignored):

| File                                     | What it holds                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `scene-01-run-plan.json`                 | Every plate with its checksum, the request, the cost, the staging and the cache key. Written before any request. |
| `generation-prompt.txt` / `.sha256.json` | The exact submitted prompt and its digest.                                                                       |
| `raw/scene-01-raw-<sha>.mp4`             | The clip exactly as it arrived. Nothing trimmed or graded.                                                       |
| `inspection/`                            | Six evenly spaced frames, the contact sheet, the keyframe preview.                                               |
| `technical-inspection.json`              | Every measured check, plus the whole-clip motion and first-frame agreement.                                      |
| `visual-defects.json`                    | What was measured, what could not be, and what only a person can answer.                                         |
| `composited/scene-01-composited.mp4`     | The notification composited **after** generation.                                                                |
| `scene-01-comparison.html`               | Plate · raw · composited, side by side. No script, no network.                                                   |
| `provider-provenance.json`               | Job lifecycle, checksums, request count, what was and was not generated.                                         |
| `cost-report.json`                       | Ceiling, maximum, charge and its basis.                                                                          |
| `human-review-record.json`               | `PENDING`. No reviewer, no verdict, no date.                                                                     |

---

## 7. Exit codes

Shared with `aamp:storyboard-video` (`storyboard-video/failures.ts`), so a
script driving either reads one table. The ones this path reaches:

`0` success · `2` bad arguments · `20` invalid brief · `21` plate missing,
ambiguous, landscape or undecodable · `22` unsupported model/duration ·
`23` no API key · `24` cost ceiling · `25`–`33` transport, submission, billing,
throttling, generation, timeout, malformed response, expiry, download ·
`34` the bytes are not a playable portrait clip · `36` composite or render.

---

## 8. Recording the review

The run never approves anything. A decision is recorded through the existing
gate, against the same identity a production approval binds to:

```sh
pnpm aamp:motion-review decide --scene 1 --reviewer "<name>" \
  --verdict APPROVED --feedback "<what you observed>"
```

An approval is bound to four inputs — the clip's bytes, the authoritative plate,
the prompt and the scene contract. Change any one and it stops applying.

---

## 9. Scene-1 composition, and what it does _not_ require

The authoritative plate is shot over the subject's hands with the **rear** of
the phone toward the viewer. There is no display in frame. So Scene 1 requires
the phone's **silhouette, rear surface, rigidity and orientation** to survive,
and it does **not** require a blank active screen or four trackable display
corners — those are recorded `NOT_APPLICABLE` with the reason, not quietly
dropped.

Active-display corner tracking belongs to Scenes 3, 4, 6 and 10, where the
screen faces the viewer.

The notification is a **screen-space** graphic composited after generation. It
is not seated inside the phone, and the brief records why in the author's own
words.

---

## 10. Deferred production defects

Carried forward as mandatory requirements for the eventual fifteen-second
master. None is reopened here, and Product Motion Proof-02 is not re-rendered.

- Refuse unnaturally elongated handset plates for final product shots.
- Replace empty schedule-card image regions with real or explicitly designed
  product artwork.
- Eliminate the prediction-to-leaderboard black seam.
- Scene 6 must show genuine finger contact, potentially through a separately
  approved LTX plate animation.
- Prediction selection and confirmation must be visibly distinct.
- Scene 8 must animate an actual rank improvement, not merely scroll a
  leaderboard.
- Use generated photographic motion where the story requires physical movement.
- Premium audio is deferred until picture lock.
