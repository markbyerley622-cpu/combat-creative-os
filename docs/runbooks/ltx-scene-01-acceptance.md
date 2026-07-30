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

**Proven against the live `api.ltx.io`, at zero cost:**

- the endpoint exists and accepts the configured credential;
- `POST /v1/upload` returns a signed upload ticket, and it signs to
  **`storage.googleapis.com`**;
- **the FRAME-01 plate uploaded successfully** through that signed PUT, with
  every required header, after the exact-hostname authorisation below was added.
  This is the first time this repository has moved bytes to a live generation
  provider.

**Not proven — the milestone is blocked at the submission, and no money has
been spent.** `POST /v2/image-to-video` was called once and answered
**HTTP 400** before any job existed:

```
Invalid input for 'camera_motion': Invalid option: expected one of
"dolly_in"|"dolly_out"|"dolly_left"|"dolly_right"|"jib_up"|"jib_down"|"static"|"focus_shift"
```

So: three network requests in total (ticket, PUT, submit); **zero billable
submissions**; **nothing charged**; no job created, no clip downloaded, no
composite, no gallery. `LTX_RESPONSE_CONTRACT_STATUS` stays
`DOCUMENTED_NOT_EXECUTED` and **no LTX-driven Scene-1 clip exists.**

Nothing was retried. The single authorised generation submission is still
entirely unspent.

### The one decision this is waiting on

**`CAMERA_MOTIONS` and the live API's vocabulary are different sets, and
reconciling them is a creative decision, not a rename.** This repository's
closed vocabulary is `STATIC`, `SLOW_PUSH_IN`, `SLOW_PULL_OUT`,
`HANDHELD_DRIFT`, `LATERAL_TRACK_LEFT`, `LATERAL_TRACK_RIGHT`, `TILT_UP`,
`TILT_DOWN`, `ORBIT_LEFT`, `ORBIT_RIGHT`. The API's is the eight values above.
Four map cleanly — `SLOW_PUSH_IN → dolly_in`, `SLOW_PULL_OUT → dolly_out`,
`TILT_UP → jib_up`, `TILT_DOWN → jib_down`, `STATIC → static`, and the two
lateral tracks to `dolly_left`/`dolly_right`. **`HANDHELD_DRIFT`, `ORBIT_LEFT`
and `ORBIT_RIGHT` have no counterpart at all**, and this repository's own rule
is that a closed vocabulary listing what is not implemented is decoration. So
the decision is what happens to those three: refused by name, or removed from
the vocabulary.

Scene 1 itself needs only `SLOW_PUSH_IN → dolly_in`. The rest of the set is what
makes this a decision rather than a one-line edit, because the next nine scenes
will use it.

Until that is settled, rerunning this command reaches the same 400 at the same
cost: nothing.

### What was authorised, and how narrowly

`LTX_ALLOWED_UPLOAD_HOSTS` permits the single exact hostname
`storage.googleapis.com`, for **uploads only**, over **HTTPS only**, matched by
**equality** rather than by suffix. It is not a wildcard, it does not extend to
subdomains, it does not extend to result downloads, and a redirect away from the
upload target is refused rather than followed. Nine focused tests hold each of
those, including the lookalikes `storage.googleapis.com.example.com`,
`attacker.storage.googleapis.com` and `storage-googleapis.com`.

**A result download signed to that host is still refused**, deliberately: a
download is a different operation with a different risk, and extending an upload
allowance to it silently is exactly the kind of widening this guard exists to
prevent. If the vendor signs results there too, that is the operator's next
explicit decision after the one above.

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

**There is no exact provider-reported cost.** The documented LTX status contract
carries no billed-amount field, so the charge is computed from the declared rate
card and labelled `DECLARED_RATE_CARD`. It is the maximum the run could have
cost, not a figure the provider reported. `cost-report.json` states the two
separately and never infers one from the other.

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
