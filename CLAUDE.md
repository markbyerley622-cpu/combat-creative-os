# Combat Creative OS — persistent rules

This file is the operating contract for anyone (human or agent) working in
this repository. It is deliberately short — for the full design rationale
see `docs/architecture.md` and `docs/adr/`.

Current state: **M14 (production hardening) done, plus the post-M14 foundation
audit repair** — corrective maintenance, not a feature milestone. **AAMP-0
(architecture and delivery blueprint) is documented** in
`docs/aamp-architecture.md` and `docs/adr/0005-aamp-creative-memory-and-real-media-architecture.md`.

**AAMP-1 step 1 (live PostgreSQL migration baseline) is done** — Docker Compose
runs `postgres` healthy, and the first real Prisma migration
(`packages/database/prisma/migrations/20260726053508_init/`) is generated,
applied, drift-checked and committed. It changed no application code. Runbook:
`docs/runbooks/database-migrations.md`; accounting: `docs/architecture.md` §8's
AAMP-1 step 1 entry.

**AAMP-1 step 2 (verified Clerk authentication) is done** — see
`docs/adr/0006-clerk-identity-with-postgresql-authorization.md` and
`docs/architecture.md` §8's AAMP-1 step 2 entry.

**AAMP real-media vertical slice 1 (real FFmpeg advertisement rendering) is
done** — the system produces a genuine playable 1080×1920 MP4 from a render
manifest. See the "Real media rendering" section below and
`docs/architecture.md` §8's vertical-slice-1 entry.

**AAMP generation vertical slice 2 (ComfyUI video generation gateway) is
done** — but read what it does and does not prove. **Proven:** real FFmpeg
rendering (a genuine playable 1080×1920 h264 MP4 passing actual-media QA,
measured by ffprobe), the full `pnpm aamp:generate` chain end to end, and
ComfyUI protocol integration against a fake protocol server. **Not proven:**
real AI video generation — **no model-generated frame has ever passed through
this code**, because this machine has a 4 GB GPU against a 12 GB floor and
**cannot execute either intended quality profile**, and no endpoint is
configured. Also note **mock reasoning ignores the campaign prompt**: it
replays committed golden fixtures. See the "ComfyUI video generation" section
below, `docs/runbooks/comfyui-video-generation.md` and `docs/architecture.md`
§8's vertical-slice-2 entry.

**Real prompt-driven source-based advertisement generation is done** — a
natural-language brief plus a library of owned assets now produces a
prompt-specific vertical advertisement with no GPU and no generated footage.
See the "Prompt-driven source generation" section below and
`docs/runbooks/prompt-driven-advertisement-generation.md`.

**Creative Memory lawful benchmark ingestion is done** — reference
advertisements can be catalogued link-only or analysed locally, segmented into
scenes with real detection, measured, annotated and projected to FiftyOne, all
permanently separated from production. See the "Creative Memory" rules below
and `docs/runbooks/creative-memory-ingestion.md`.

**Creative Memory retrieval is done, with one profile proven and two not** —
`STRUCTURAL_BASELINE_V1` (real, deterministic, non-neural) is proven end to end
against live Qdrant; the Qwen3-VL 2B and 8B profiles are implemented behind
typed endpoint adapters and **unproven**, because no endpoint was available.
See the "Creative Memory retrieval" rules below and
`docs/runbooks/creative-memory-retrieval.md`.

**Role-specific Creative Memory injection and agency benchmark governance is
done** — `pnpm aamp:generate --creative-memory required|optional|off` retrieves
role-specific, agent-safe craft intelligence and injects it into the four
planning agents, under an approved, versioned benchmark profile, with a
deterministic originality gate. **Proven:** four distinct role-appropriate
contexts, determinism, the three modes, the agent-safe boundary on real
retrieved material, governance and workspace isolation, a HIGH originality
result blocking before any render, and an ON-versus-OFF comparison that changes
hook strategy, beat plan, a transition decision, the shot specification and the
render manifest. **Not proven:** creative quality — the comparison is driven by
a deterministic fixture provider that derives from measurements, so it
demonstrates the mechanism and says nothing about how a real model would use
the context. See the "Creative Memory injection" rules below and
`docs/runbooks/creative-memory-retrieval.md` §§16–22.

**The production AAMP composition root and operational doctor are done** —
`aamp:generate` now builds every collaborator through one canonical factory,
derives a typed execution mode from the dependencies that were actually built,
and writes a sealed run-provenance record. `pnpm aamp:doctor` is a read-only
preflight. **Proven against live local infrastructure:** Docker PostgreSQL and
Qdrant, real FFmpeg 8.1.2, four synthetic references ingested/approved/indexed,
four approved benchmark profiles, and a full `--execution-mode local-production
--creative-memory required` run producing an ffprobe-verified 1080×1920 MP4 at
exactly 15.000 s. **Not proven:** `PRODUCTION` mode has never executed (no
`ANTHROPIC_API_KEY` here) — only its refusal is proven — and creative quality
is still a committed fixture. See the "Production composition root" rules below,
`docs/architecture.md` §8's entry, and
`docs/runbooks/prompt-driven-advertisement-generation.md` §§10–14.

**The controlled creative benchmark runner is done** — `pnpm aamp:benchmark`
runs the same campaign twice (Creative Memory `off`, then `required`) against
identical, hashed, deep-frozen inputs and compares nineteen dimensions.
**Proven live:** two genuine ffprobe-verified 1080×1920 MP4s at 15.000 s, both
QA `PASS`; twelve of nineteen dimensions changed, including hook strategy, hook
latency (3.767 s → 1.0 s), beat count (4 → 8), camera movement, motion design
and the manifest checksum; the OFF arm performed zero retrievals and the
REQUIRED arm eleven across three references and all four planning roles.
**Not proven:** creative quality — the reasoning is the deterministic
context-aware fixture. See the "Controlled creative benchmark" rules below and
`docs/runbooks/creative-benchmark.md`.

**AAMP-1 step 3 (durable `SERIALIZABLE` budget enforcement) is done** —
`checkAndReserveBudget`'s M14 compensating guard is removed, and every
applicable budget policy is now loaded, summed, decided and written inside one
PostgreSQL `SERIALIZABLE` transaction. **Proven against live PostgreSQL:**
twenty concurrent distinct-key reservations accept exactly the four that fit;
twelve same-key retries produce one reservation; all four levels enforce their
own limit and a refusal writes nothing anywhere; sixteen callers using opposing
scope orders commit with the database's deadlock counter unmoved; settlement,
release and replay are idempotent; a cross-workspace reservation reveals
nothing. **Not proven:** no application process runs against live Postgres in
normal operation, so the Worker's use of this under a real Temporal server is
still unexercised. See the "Budget enforcement" rules below,
`docs/architecture.md` §8's AAMP-1 step 3 entry and
`docs/runbooks/database-migrations.md` §9.

**The zero-cost footage-first creative preview is done** — a person authors the
creative decisions as a validated plan and the pipeline executes them
deterministically, with **no reasoning provider and no generation provider
constructed at all**. **Proven live:** an ffprobe-verified 1080×1920 h264/AAC
MP4 at exactly 15.000 s passing all 37 binding QA checks, measured at −13.8
LUFS against a −14 target with zero clipped samples; the run succeeds in an
environment where `REASONING_PROVIDER=claude` is set with no API key (a
campaign run exits 3 there); two runs of the same plan produce a byte-identical
master; real black/freeze/scene detection drove a non-zero, black-avoiding
in-point; and a QA failure sent the master to `rejected/` with a non-zero exit
code. **Not proven:** creative quality — a human made those judgements, and the
example runs against synthetic `lavfi` media. See the "Zero-cost footage-first
preview" rules below and `docs/runbooks/zero-cost-footage-first-preview.md`.

**Read-only Combat Reviews live-UI capture and production-asset ingestion is
done** — `pnpm aamp:capture-app` photographs approved public screens with a
read-only Chromium, redacts identity and community writing, converts the images
into content-addressed, rights-controlled production assets, and merges them
over the synthetic UI stills so the existing footage-first preview renders from
real product screens. **Proven live:** three real screens captured from
`globalfight.onrender.com` at exactly 1080×1920 (`LIVE_CAPTURE_PROVEN`), with
the disabled discussion screen skipped and four cross-origin requests refused.
**Proven against the local fixture site:** GET/HEAD-only enforcement with the
server independently confirming no mutation arrived, a page that tries to
submit its own form three ways failing to, cross-origin and non-anchor
navigation refusal, byte-identical screenshots across runs, required-redaction
failure, duplicate-content refusal, and the whole chain ending in an
ffprobe-verified 1080×1920 MP4 at 15.000 s with QA `PASS`. **Not proven:** that
any rights declaration is _true_ — the tool enforces its host, term and version
and cannot verify the claim; and nothing here touches private pages, because
there is no login path. See the "Live-UI capture" rules below and
`docs/runbooks/combat-reviews-live-ui-capture.md`.

**Premium licensed media acquisition is done** — `pnpm aamp:media` searches,
evaluates, acquires and ingests legally usable footage, images and audio through
official provider APIs only, and emits a production-asset manifest the existing
generator accepts unchanged. **Proven offline:** the full chain against a
deterministic fixture server and FFmpeg `lavfi` media, producing a manifest the
existing `parseProductionAssetManifest` accepts; the approval gate refusing a
skipped station, an expired approval, a wrong-run approval and an over-reaching
one; a 200 response that cannot be measured leaving zero assets;
`INTERNAL_EVALUATION` refused by name from a campaign manifest. **Proven
read-only against the operator's real external candidate library:** 115 of 115
SHA-256 checksums recalculated and agreeing, zero mismatches, zero candidates
above `RIGHTS_REVIEW_REQUIRED`. **Not proven: no live provider API has ever been
contacted** — no key is configured here, so all five adapters carry
`responseContractStatus: DOCUMENTED_NOT_EXECUTED`, and no third-party media has
been downloaded. See the "Media acquisition" rules below and
`docs/runbooks/premium-media-acquisition.md`.

**Agent-led product-launch creative orchestration is done** — `pnpm aamp:launch`
lets the existing specialist agents develop, compete, assess and refine
product-launch concepts behind a mandatory human concept gate, then hands the
approved one to the existing script, shot, render and QA path unchanged.
**Proven offline, with no paid call:** three to five structured concepts from the
existing Creative Director; the campaign prompt, the id-carrying factual
constraints and the prohibited claims present in every planning invocation's
input; role-specific Creative Memory under an approved profile with references
staying analysis-only; a duplicating provider's set refused as
`INSUFFICIENTLY_DISTINCT`; `render` before selection exiting 15; a revision
writing v2 while v1 stays byte-identical; superseded, stale-brief,
cross-workspace and unapproved-reviewer selections each refused with their own
code; an inspection-only required capture and an `ANALYSIS_ONLY` asset refused
before any agent ran; and, with FFmpeg present, an ffprobe-verified 1080×1920
MP4 at 15 s with QA `PASS`. **Not proven:** creative quality — every test runs
against a deterministic launch fixture provider, and no paid model has produced
a launch concept in this repository. See the "Product-launch orchestration"
rules below and `docs/runbooks/agent-led-product-launch.md`.

**The premium creative finishing workflow is done** — `pnpm aamp:finish` is the
directed-revision pass that runs after a master exists and before anyone calls it
finished. A named reviewer files a timestamped critique; the system produces
controlled alternatives along one axis at a time from that reviewer's own
structural directives, renders each through the existing preview path, and a
person picks between them. **Proven live, against real FFmpeg:** one round
rendering eight candidates, all four stages settled in order on recorded human
decisions, a control rendered beside every alternative with QA `PASS` on both,
each stage's approved plan carried forward as the next stage's base, an
ffprobe-verified 1080×1920 master at the requested duration, two of the new
finishing decorations surviving into the finished cut, `PREMIUM_READY` reached
only with a submitted human scorecard, and a provenance trail naming every
decision and its author. **Proven with no FFmpeg:** sixteen distinct refusals,
from vague feedback to approved bytes changed after the decision. **Not proven:**
creative quality — every craft score in every test is a number a fixture reviewer
wrote, and nothing here has finished a master from a real campaign run. See the
"Creative finishing" rules below and
`docs/runbooks/premium-creative-finishing.md`.

**The storyboard-driven flagship advertisement is done** — `pnpm aamp:flagship`
turns the verified eight-panel storyboard, the real Combat Reviews material and
an authored plan into one master through the existing preview path, unchanged.
**Proven live, against real FFmpeg and the operator's real packs:** an
ffprobe-verified 1080×1920 h264/yuv420p MP4 at exactly 15.000 s with AAC stereo
at 48 kHz and QA `PASS`; eight beats landing exactly on the storyboard's eight
slots; four real product screens on screen; every storyboard frame absent from
the output by checksum **and** by path, proven before the render over the
staging root and again after it over the render manifest; the corrected CTA;
and byte-identical re-rendering. **Proven with fixtures, no Desktop and no
network:** 63 contract tests plus a 9-test acceptance suite that runs with
`REASONING_PROVIDER=claude` and no API key. **Not proven:** creative quality —
seven of the ten scorecard dimensions carry `HUMAN_JUDGEMENT_REQUIRED` and no
number, and the master is blocked from any agency-grade claim by its temporary
audio alone. See the "Flagship advertisement" rules below and
`docs/runbooks/flagship-advertisement.md`.

**The locked ten-panel storyboard motion proof is done** — `pnpm aamp:flagship2`
animates an operator-supplied storyboard into one 15-second master through the
same composition root, and proves scene by scene that it executed the storyboard
rather than reinterpreting it. **Proven live:** an ffprobe-verified 1080x1920
h264/yuv420p MP4 at exactly 15.000 s, AAC stereo 48 kHz, faststart, QA `PASS`
over 32 binding checks at -13.5 LUFS with zero clipped samples; ten scenes in the
locked order on the locked slots with no gap; every scene rendering its own
panel; both factual corrections applied inside the panel's own typography; and
Storyboard-01 proven absent by checksum across all 19 staged files. **Proven with
fixtures:** 35 contract tests covering package verification, every way its rights
can be overstated, reordering, slot drift, panel declarations, fidelity pass and
its failure modes, both panel treatments, and every promoting flag refused.
**Not proven:** creative quality, and the animation's sufficiency — every panel
is a single still, so the bell does not swing, the ranking rows do not reveal
individually and the logo does not build. See the "Locked-storyboard proof" rules
below and `docs/runbooks/locked-storyboard-motion-proof.md`.

**LTX storyboard-to-video rendering is integrated, and no paid call has ever
been made** — `pnpm aamp:storyboard-video` resolves a source for every locked
scene, prices the run, and hands prepared clips to the existing flagship render
path unchanged. **Proven offline, with zero spend:** the full LTX client against
an in-process fake server (upload ticket, signed PUT with every required header,
submit, `pending → processing → completed`, download, and 401/402/429/malformed/
expired/timeout/cancellation each mapped to its own exit code); no credential or
signed URL in any return value, message or artefact; a second run making zero
further requests; the cost ceiling refusing before the first upload; deprecated
`ltx-2-fast`/`ltx-2-pro` refused by name; minimum-duration selection and
non-destructive trimming; exact-UI scenes structurally unable to reach a
provider; and a `--dry-run` against the operator's real folders that read no key,
made no request and priced the run at 180¢ fast / 240¢ pro. **Not proven: no
live LTX API call has ever been made from this repository** — no `LTXV_API_KEY`
is configured, every adapter carries `DOCUMENTED_NOT_EXECUTED`, and **no
LTX-driven master exists**. See the "LTX storyboard-to-video" rules below and
`docs/runbooks/ltx-storyboard-to-video.md`.

**The storyboard motion quality gate is done** — `pnpm aamp:motion-review`
measures every resolved moving clip locally, shows a person what it found beside
the approved keyframe, records their decision immutably, and the final render
fails closed until every moving scene carries a standing approval of the exact
bytes that will be used. **Proven live against the operator's real material,
read-only and at zero cost:** scenes 1 and 7 `MANUAL_LTX_STUDIO`, scene 2 the
acquired plate, 3/4/6/10 deterministic, 5/8/9 missing generation at 108¢ — and
both hand-animated clips surfaced as landscape 1920×1080 against portrait plates
with keyframe layout agreement 0.4432 and 0.1441 against a floor of 0.85, so
neither opens on the approved composition. **Proven with fixtures and the fake
LTX server, no paid call:** an ffprobe-verified 15.000 s 1080×1920 h264/AAC
master with QA `PASS` reached only after a rejected scene was replaced and the
replacement approved, plus 51 contract tests and 6 source-hygiene tests. **Not
proven:** creative quality — the gate proves a named person decided about
specific bytes, not that they were right. See the "Motion quality gate" rules
below and `docs/runbooks/storyboard-motion-quality-gate.md`.

**The continuous product motion compositor is done** — `pnpm aamp:product-motion`
renders a 5–6 second Product Motion Proof in which real captured Combat Reviews
interface pixels are composited onto a photographed handset _after_ the camera
move, so type never warps. **Proven live:** an ffprobe-verified 1080×1920
h264/yuv420p MP4 at exactly 5.600 s, AAC stereo 48 kHz, faststart, actual-media
QA `PASS` including the frozen-frame walk; seven product states and seven accents
on one continuous timeline; two cuts measuring 0.09 px of screen-centre
displacement; both screens verified against plate pixels; and frames inspected at
every state and transition showing no warped type, no slipped placement and no
exposed empty screen. **Not proven:** creative quality — nothing here measures
it. **Standing limitations, recorded every run:** the plates are 941×1672 and
upscale before the move, the audio is temporary synthetic material, the
photographic layer is a still under a camera move, and the interface comes from
the existing approved captures because the live application was unreachable. See
the "Product motion compositor" rules below and
`docs/runbooks/product-motion-proof.md`.

**The mobile-native correction is done** — proof-01 was rejected on visual
acceptance: headings clipped at the right edge, black bands, controls that read
as a desktop dashboard squeezed into a phone. Two of the three root causes were
real. The captures were _not_ taken at a desktop breakpoint (360×640 CSS at DPR
3 is a phone width); the defects came from sizing the interface canvas from the
**projected quadrilateral** and then making short captures fit it by scaling up,
cropping horizontally and replicating edge rows. `pnpm aamp:product-motion` now
lays every product document out at a canonical **393 CSS px** mobile viewport
and maps the whole rectangle through the homography. **Proven live:** an
ffprobe-verified 1080×1920 h264/AAC MP4 at exactly 5.600 s, QA `PASS`; zero
horizontal overflow and zero clipped elements across all three documents;
bottom navigation visible and no wide-breakpoint navigation anywhere; hero
mapping uniformity 1.0003. See the rules below and
`docs/runbooks/product-motion-proof.md`.

**The first real paid AAMP storyboard-to-LTX generation is done, and a named
reviewer rejected the take.** `pnpm aamp:ltx-scene-01` turned the authoritative
FRAME-01 plate into a genuine 1080x1920 clip on one capped `ltx-2-3-fast`
request. **Proven live:** exactly **1 of 1** authorised billable submission;
**36¢** charged against a **40¢** ceiling; the plate uploaded through a signed
PUT on `storage.googleapis.com` and the result downloaded from the same host
under a _separate_ grant; an ffprobe-verified 1080x1920 h264/yuv420p MP4 at
24.000 fps and 6.042 s with **no audio stream**; first-frame agreement
**0.9988** and motion energy **2.0534**; 17 of 17 binding checks `PASS`; the
post-LTX `FIGHTS THIS WEEKEND` notification composited over real generated
footage; and no credential, signed URL or query string in any artefact.
**Rejected by Riki Taylor** for `COMPOSITION_DRIFT` and `GAZE_LIFT` — the brief
asked for a ~3% push holding the framing and the model delivered roughly 1.75x,
ending with the subject's eyes outside frame, plus a gaze lift to the lens in
the opening seconds. The decision is recorded in the append-only motion-review
ledger; the take is not reused. Identity, hands, rear-facing phone rigidity and
the absence of invented graphics were all correct. See the "Scene-1 acceptance"
rules below and `docs/runbooks/ltx-scene-01-acceptance.md`.

**The Scene-1 notification has been redesigned, at zero cost.** The prototype —
a `drawbox` rectangle with one line of subtitle type over it — is replaced by a
`LAYERED_SURFACE_COMPOSITE`: mark, header, timestamp, headline, supporting line,
surface, radius, shadow and accent edge laid out as one document, rasterised to
a transparent sheet by a real layout engine, and composited as a single
assembled unit. `pnpm aamp:notification-proof` proves it over the Scene-1 slot
without constructing a provider, reading a credential or making a request.
**Proven live, 0¢:** an ffprobe-verified 1080×1920 proof; 27 of 27 frames with
**zero** overlapping subject content and worst-case clearance 34px above and
35px below the whole occupied rectangle, shadow included; 23 frames carrying the
card at a minimum ink coverage of 0.1103, so no frame is an empty panel; exactly
one accent excursion peaking at 0.417s; identical surface coverage at the settle
and on the final frame, so no fade-out; and two renders of the same plan hashing
to the same bytes — fourteen measured rows, all `OBSERVED`. **Not proven:**
creative quality — nine rows carry `HUMAN_JUDGEMENT_REQUIRED` and no number, and
the picture underneath remains the rejected take. See the "Scene-1 notification
treatment" rules below and `docs/runbooks/ltx-scene-01-acceptance.md` §10.

**Scenes 8 and 9 carry their authored `HANDHELD_DRIFT` in two stages.** The
provider has no handheld value, so it is asked for `static` and AAMP supplies
the drift deterministically afterwards — scene 8 a smooth 2% push preserving the
predictor-rank interface space, scene 9 a smooth 1% leftward drift preserving
the phone geometry and discussion-interface region. Neither is substituted with
`dolly_in`, `dolly_out` or any other LTX move. **The FFmpeg execution of the
second stage is not implemented yet and neither scene has been generated.**

## Scene-1 notification treatment — permanent rules

- **The card is one document, laid out once and rasterised before FFmpeg is
  invoked.** A `drawbox` rectangle with a subtitle line over it was the
  prototype; it could not express a radius, a translucent surface, a shadow, a
  second line of type or a mark placed against the type. Never reintroduce a
  treatment where the surface and its contents are drawn by two mechanisms that
  have to be kept in agreement by hand — that is what `MARK_LEFT_FRACTION` and
  `TYPE_LEFT_FRACTION` existed for, and they are gone because there is now one
  mechanism.
- **No authored string reaches FFmpeg at all.** Not as filter grammar, and not
  as a subtitle file named from a filter argument. The copy becomes pixels in
  `notification-surface.ts` and the compositor never sees it. This is strictly
  stronger than the rule it replaces; do not weaken it back to escaping.
- **`drawbox` still cannot animate**, and the entrance is still a series of
  complete states on disjoint `enable` windows. What changed is that each state
  is rendered at its own transform, so type is rasterised sharp at every size it
  is seen at rather than resampled from one master.
- **Every state is a complete card, and the step count is matched to the frame
  grid.** There is no assembly stage and no frame on which the surface exists
  and its contents do not — a blank rectangle is not expressible. A step count
  that does not divide onto the grid shows one state twice while skipping
  another, which reads as a dropped frame.
- **Placement is measured against the picture, never against a declared face
  box.** A declared rectangle is a claim, and a claim checked against itself
  always passes. Rows carrying any pixel at or above the subject-content luma
  threshold are lit subject; the treatment's whole occupied rectangle — shadow
  and accent glow included — must lie inside one contiguous clean run, on
  **every** frame of the source, with clearance. Measuring the composited output
  instead would find the card and report it as the subject.
- **The occupied rectangle is what is checked, never the card alone.** The
  shadow offsets downward and the entrance offsets the card downward, so the
  occupied rectangle's centre is not the card's centre. A check that passed on
  the card while the shadow hung over the phone would be checking the wrong
  rectangle — and the push-in narrows that gap as the shot runs, which is how
  17px of clearance was found on the last frame and nowhere else.
- **The measurement says what it cannot establish.** That the clean run it found
  is the gap between the face and the phone rather than some other empty region
  is a person reading a picture. The nearest rows of subject content above and
  below are recorded per frame so a reviewer can check that reading in numbers.
- **An unmeasurable row fails the run.** `notMeasuredCount` gates the exit code
  beside `measuredDefectCount`. A proof that could not take its own measurements
  is not a proof, and a report counting only defects called one clean while five
  of its claims were unknown.
- **Each measurement section carries its own not-measured reason.** One failed
  section must never discard the ones that succeeded — that understates what is
  known, which is its own kind of dishonest report.
- **`crop` on a chroma-subsampled format snaps to even dimensions.** Convert to
  RGB _before_ cropping when the region has an odd dimension; a five-pixel
  accent band comes back four pixels tall and the stream is then the wrong
  length. The frame-count check is what catches it — keep it.
- **The pulse is counted as excursions, not as local maxima.** A rise that
  plateaus across a frame boundary is a measurement artefact, not a second
  pulse. One contiguous run above the halfway mark between rest and peak is what
  a viewer calls "it flashed once".
- **The accent holds at rest into the cut; there is no fade-out.** Its resting
  rectangle is recorded as the match-transition seed for Scene 2 rather than
  left to be re-derived. Nothing in this milestone renders that transition.
- **The proof path cannot spend money, structurally.** No provider construction,
  no credential, no cost function, no `fetch(` — asserted over the modules by
  name in `scene-acceptance-source-hygiene.test.ts`. It takes no cost ceiling
  because a ceiling would imply there was something to cap.
- **The proof composites over a rejected take, and says so everywhere.** The
  Scene-1 clip stands rejected for `COMPOSITION_DRIFT` and `GAZE_LIFT`; it is
  compositing material here and never a production source. Every artefact
  records the rejection rather than quietly dropping it.
- **The brief owns every word, colour, distance and timing**, including the
  ranges the visual specification fixes — a height outside 190–220px or a radius
  outside 28–36px is refused by the schema rather than rendered. Adding or
  changing a state model, easing, pulse shape or surface layout is a
  `NOTIFICATION_TREATMENT_VERSION` bump, not an edit in place.

## Scene-1 LTX acceptance — permanent rules

- **A signing host outside the allowlist is a decision, not an obstacle.** The
  guard refusing `storage.googleapis.com` is why the first live attempt cost
  nothing instead of sending owned media to an unverified host. It was then
  authorised **by a person, narrowly**: `LTX_ALLOWED_UPLOAD_HOSTS` holds that one
  exact hostname, matched by **equality**, for **uploads only**, over **HTTPS
  only**. Never make it a suffix — `.googleapis.com` admits every Google API host
  and `storage.googleapis.com` as a suffix admits
  `attacker.storage.googleapis.com`. Never extend it to result downloads: a
  download is a different operation with a different risk, and an upload
  allowance that quietly covered it would be the widening this guard exists to
  prevent. Never add a per-invocation override or let a host arrive from
  configuration.
- **A motion the provider cannot express is either routed in two stages or
  refused — never substituted.** `HANDHELD_DRIFT` routes: the provider is asked
  for `static` and a deterministic post-motion supplies the authored drift.
  Routing is an explicit contract, not a fallback: a caller that does not
  declare it will apply the second stage is **refused**, because a bare `static`
  would be a locked-off shot labelled as a moving one. `toLtxCameraMotion`
  cannot resolve a routed motion at all — only `routeLtxCameraMotion` can — so
  no code path can obtain `static` for a drift by accident.
- **A routed scene must state its second stage, and a native scene must not.**
  `parseSceneManifest` enforces both, so every reader of a manifest gets the
  rule. The post-motion block is authored: treatment, magnitude, direction,
  what must be preserved and what is prohibited are all a person's words, with
  no defaults — a drift nobody specified is a drift nobody approved. The
  treatment vocabulary is closed and contains only smooth deterministic
  transforms: no rotation, no random shake, nothing that could differ between
  two runs of the same plan.
- **The camera-motion vocabulary is provider-neutral and stays whole.** LTX
  accepting eight strings is not a reason to delete a move from AAMP.
  `ltx/camera-motion.ts` is the single serialization boundary, and it maps only
  pairs that are **the same physical move**: `SLOW_PUSH_IN → dolly_in`,
  `SLOW_PULL_OUT → dolly_out`, the two lateral tracks to `dolly_left`/`dolly_right`,
  `STATIC → static`. A tilt is a rotation and a jib is a translation, so
  `TILT_UP`/`TILT_DOWN` are **refused, not mapped to `jib_up`/`jib_down`** —
  nearest-looking is not equivalent. `HANDHELD_DRIFT` and the two orbits have no
  counterpart at all. `CRANE_DOWN` is not in `CAMERA_MOTIONS`, so there is
  nothing to map; were it added as a vertical camera descent, `jib_down` would
  be its defensible equivalent.
- **An unsupported motion is a typed `UNSUPPORTED_PROVIDER_CAMERA_MOTION`
  raised before any network access**, naming the value and `ltx-hosted`. Never
  silently omit the field, never substitute `static`, and never let the prose
  prompt carry it as a hidden fallback — a request whose structured field and
  prose disagree lets the model follow either. No internal enum name may ever
  reach the wire, and no speed, strength or intensity field is invented to carry
  "slow": the API defines none, and a fabricated field is a guess with a number
  in it.
- **Upload and result hosts are two grants, never one.**
  `LTX_ALLOWED_UPLOAD_HOSTS` and `LTX_ALLOWED_RESULT_HOSTS` hold the same string
  today and must stay separate lists, so removing or adding one permission
  cannot silently move the other. `assertTransferUrlAllowed` takes the purpose
  as a **required argument with no default** — there is no generally-trusted
  transfer host, and no call site can inherit a grant by forgetting to say what
  it is doing.
- **A redirect away from a signed upload target is refused, never followed.**
  `redirect: 'manual'` plus an explicit refusal, because following one would
  carry the bytes _and the ticket's signature headers_ to a host that never
  passed the allowlist — the one move that walks around the check entirely. Both
  shapes are handled: a verbatim 3xx and the opaque-redirect filtered response
  whose status is 0.
- **Exactly one billable request, structurally.**
  `OneRequestVideoGenerationProvider` wraps the real adapter and permits one
  `submit`; a different idempotency key is refused, a repeat of the same one is
  answered from the first handle. Polling, fetching and usage are free
  operations against a job already bought and are never counted as requests.
  There is no retry, no second variation, no alternate model and no fallback
  provider — a rejection never buys a replacement on its own.
- **Everything that can refuse happens before anything costs money**, and the
  cost check happens before anything is even staged or resampled. `--dry-run`
  reads no API key at all, which is a property of the code rather than a promise
  in the help text, and `CountingFetch` proves the request count is zero rather
  than asserting it.
- **The rate card is a maximum, never a provider-reported charge.** The
  documented LTX status contract carries no billed-amount field, so
  `cost-report.json` states the computed maximum, its `DECLARED_RATE_CARD`
  basis and the enforced ceiling as three separate facts. Never infer, round or
  fabricate a charge.
- **Discovery refuses every ambiguity rather than resolving it.** Two files
  resolving to one frame, a plate-shaped name with an unusable extension, a
  landscape plate, a symlink leaving the folder, an undecodable file — each is
  refused by name, and a plate-shaped file is never silently reported as
  missing. The operator's folder is read-only: the plate is copied out and the
  copy re-hashed before anything uses it.
- **`generated-clips/` is refused by location, not by filename.** The landscape
  `FRAME-01.mp4` and `FRAME-07.mp4` failed portrait fidelity and are
  permanently rejected; a structural rule survives a rename and a filename does
  not.
- **The upload resample is declared, never claimed as detail.** The plates are
  941×1672 and delivery is 1080×1920, so the staged upload records the method,
  both scale factors, the anisotropy and `createsNewDetail: false` explicitly.
- **The notification is composited after LTX and could not have been
  generated.** The model is asked for a clean plate and never sees a card, a
  mark or lettering. `drawbox` cannot animate, so the entrance settles across
  disjoint `enable` windows; the mark is the owned asset overlaid from its own
  file; the headline travels in a generated ASS file and never becomes filter
  grammar; and it carries no number, because no verified event count exists.
- **Scene 1 contains no display, and the report says so rather than omitting
  it.** The plate is shot with the rear of the phone toward the viewer, so the
  blank-screen and four-corner checks are `NOT_APPLICABLE` with their reason,
  and what Scene 1 requires instead is that the phone's silhouette, rear
  surface, rigidity and orientation survive. **Active-display corner tracking
  belongs to Scenes 3, 4, 6 and 10** — never add it as a Scene-1 requirement.
- **The run approves nothing, and cannot.** The human review record is `PENDING`
  with a null reviewer, verdict and date; no flag writes one;
  `safeAsProductionSource` is never true from a run. The identity is the
  existing `reviewIdentitySha256`, so a later decision binds to the same four
  inputs a production approval binds to.
- **Eight observations carry `HUMAN_JUDGEMENT_REQUIRED` and no number** —
  identity, hand anatomy, phone rigidity, the blink, the push, the rim light,
  hallucinated graphics and realism against the plate. No measurement of any of
  them exists here, and inventing one would put the single unverifiable figure
  into the report a person relies on.
- **The brief owns the creative; this code owns the discipline.** Every prompt,
  headline, colour and timing lives in
  `campaigns/combat-reviews-flagship-02/scene-01-ltx-acceptance.json` with a
  named author. `scene-acceptance-source-hygiene.test.ts` asserts no creative
  literal is assigned anywhere in the module, that only one file constructs the
  provider, that only the entry point reads the credential, and that no operator
  path is hardcoded.
- **This milestone renders no master and generates no other scene.** Scenes 2–10
  and the fifteen-second cut are out of scope, and every artefact says so
  explicitly rather than leaving it to be inferred.

## Product motion compositor — permanent rules

- **The interface is composited after the photographic move, never before.**
  Compositing first scales the type by the camera's own zoom factor, and soft
  type reads as an enlarged screenshot rather than a screen. The plate moves,
  the four screen corners are carried through the _same_ zoom analytically, and
  the interface is warped once at delivery resolution. Both are readings of one
  formula on purpose; two implementations would agree until the first fix.
- **A pan that `zoompan` would clamp is refused.** The framing clamps at the
  plate edge and the corner arithmetic does not, so the interface would drift
  off the handset in a way that looks like a calibration fault rather than a
  framing one. The refusal names the zoom that would make the pan legal.
- **A declared screen is verified against the plate's own pixels, and a screen
  that fails is refused by name.** Dark and uniform are what separate an unlit
  screen from the background, from the phone's body, and from a screen that
  already carries an interface. **Never add a fallback that lays a full-frame
  screenshot over the plate** — it passes every technical gate while showing an
  interface that is not on the handset. Rim contrast is measured and never
  gates: on black glass against a black set the bezel and the screen are within
  a few luma levels, and a floor there would refuse the plates this exists for.
- **Calibration is not evidence about placement.** It proves the region is a
  blank dark rectangle, not that it is the _right_ rectangle. The gallery
  overlay is generated on every run for exactly that reason, and it is built
  from the same `perspective` call the composite uses.
- **The interface layer moves captured pixels and never draws an interface.**
  The only marks are rectangles in the brand accent. No text, label, number or
  interface element is drawn by this pipeline — a re-typeset rankings table is
  an invented rankings table, however carefully it is copied.
- **`drawbox` cannot animate, so an accent only appears while its document is at
  rest** — never during a scroll and never during a push-up entrance. An accent
  may span consecutive states only if they all show the same document at the
  same resting scroll.
- **The transition vocabulary is closed and contains no dissolve.** `OPENING`,
  `SCREEN_POSITION_MATCH_CUT`, `TAP_CUT`, and it lists only what is implemented.
  Dissolving between two product states says they are interchangeable; the point
  of a demonstration is that one leads to the next.
- **A push-up holds the outgoing layer underneath until the incoming one covers
  the canvas.** Otherwise the band not yet reached is the black base, and the
  handset appears to go blank mid-transition.
- **An FFmpeg filter output label may be consumed exactly once.** Two states on
  one document is the normal case here; without an explicit `split` every later
  state renders black _while the graph still succeeds_. Found with the accents
  drawing perfectly over an empty screen.
- **One FFmpeg invocation per shot, then the concat demuxer.** Compiling every
  shot into one `filter_complex` buffers looped stills without bound — measured
  at 1.5 GB resident for a five-second cut at a tenth of the CPU doing useful
  work.
- **The QA descriptor manifest must declare that the picture moves.** QA excludes
  scenes declaring stillness from the frozen-frame walk, so a descriptor claiming
  `STATIC` switches off the one check that catches this proof failing at its own
  purpose.
- **Three coordinate systems, kept apart.** The **CSS viewport** decides which
  breakpoint renders and nothing else does; **device pixels** are a fidelity
  multiplication that cannot affect layout; the **projected quadrilateral** is
  the output of a camera and may never be an input to layout.
  `canonicalMobileViewport` takes a scalar and cannot be handed a quad, so the
  conflation that produced the first proof's clipped headings is not
  expressible.
- **The canonical CSS width is 393 px, for every document, on every plate.**
  Only the viewport _height_ follows the calibrated screen, because these
  stylised plates draw handsets at about 2.86:1 and a taller screen genuinely
  shows more of the same mobile layout. Never widen the CSS viewport to fill a
  screen — that changes the breakpoint, which is the whole defect.
- **Extra height is filled with more real content, never by scaling.** There is
  no `fit`, no `headroom`, no crop and no edge replication left in
  `UiDocument`, and their absence is what makes "no black bands, nothing
  clipped" structural rather than a promise. A document narrower or shorter
  than the screen is refused by name.
- **`devicePixelRect` refuses an odd dimension rather than nudging the CSS
  viewport.** 393 × 3 is 1179 and h264 cannot encode it; the scale factor moved
  to 4, the width did not move to 394.
- **`measureMappingUniformity` reports, it never corrects.** It runs after the
  document is sized and its result is written to the report — a plate whose
  glass is drawn more elongated than a real device cannot carry a
  correctly-proportioned layout at full coverage, and an operator is told that
  in numbers rather than discovering it in the frames.
- **Layout is measured in the page, not asserted.** `scrollWidth` against
  `clientWidth`, every element's box against the viewport, the bottom
  navigation present, no wide-breakpoint navigation. A document that fails is
  refused.
- **The bottom navigation is a fixed composited layer.** It is `position:
fixed` on a phone, and a full-page screenshot bakes a fixed element in
  wherever it sat when the capture began — it would ride up the screen as the
  content scrolls.
- **Offline documents are `PRODUCT_MOCKUP`, never captures.** When the live
  application is unreachable they are reconstructed from its own visual system,
  navigation, brand mark and the content the approved captures show — and every
  artefact says so. The check against the live host is made **once**, read-only
  and mobile-emulated; there is no retry loop.
- **Nothing on this path constructs a provider, opens a database or makes a
  network request**, and asset roots are supplied at invocation so no operator
  pack path is ever committed. `product-motion-source-hygiene.test.ts` asserts
  all of it.

## Motion quality gate — permanent rules

- **A deterministic measurement is never evidence about creative quality.**
  Nothing here scores a shot, a face, a hand or a story, and no function may be
  added that does. Every craft judgement is a named person's recorded decision.
  The gate's own report carries that notice; do not remove it.
- **Two tiers, and the difference is who can clear them.**
  `BINDING_TECHNICAL` means the file is unusable and no approval clears it;
  `FIDELITY_FINDING` means the file is usable and disagrees with the brief,
  which is a person's call. An approval is refused while a finding is open and
  unnamed. Never promote a finding to binding to "make the gate stricter" — that
  removes the human decision the finding exists to force.
- **An unmeasurable binding check is not a satisfied one.** `NOT_MEASURED`
  carries its reason and is never a pass, the same rule the preview path holds.
- **The naive measurements do not work, and the replacements are calibrated
  against real material.** Mean frame difference scores a still 1.22 and a real
  slow push-in 1.31; whole-frame similarity scores a clip 0.871 against its own
  keyframe and 0.871 against a different scene's. Do not "simplify" the
  noise-cutoff motion measure or the luma-layout correlation back to either.
  Changing a floor or the profile is a `MOTION_INSPECTION_PROFILE_VERSION` /
  `MOTION_REQUIREMENT_PROFILE_VERSION` bump.
- **An approval is bound to four inputs, never to a scene number** — the clip's
  bytes, the authoritative keyframe, the generation prompt and the scene
  contract. Change one and it stops applying, and the gate names which moved.
  The scene's prose `intent` is deliberately outside the digest, and so is the
  inspection: measurements move with the FFmpeg build, and an approval that
  evaporated on a patch release would train reviewers to click through.
- **The ledger is append-only, self-verifying and never edited.** A changed mind
  is a new line naming the one it supersedes. A line whose recorded id does not
  match its content was tampered with and is refused on read; a malformed line
  is an error, because treating it as an unreviewed scene would silently discard
  a human judgement.
- **Feedback is refused, never interpreted.** A whole-field mood cannot become
  the recorded reason for a decision, and a rejection must say what was observed
  and what must change — it is an instruction to spend money regenerating.
- **The gate runs before anything is trimmed, staged or composited**, and there
  is no `--skip-review`, `--force` or environment variable. A gate with a bypass
  is a gate that gets bypassed on the afternoon somebody needs the file quickly.
- **A still is never asked for a motion approval.**
  `DETERMINISTIC_MOTION_GRAPHICS` and `REAL_PRODUCT_CAPTURE` have no generated
  motion to review, and asking would train reviewers to approve without looking.
- **Regeneration bypasses the cache for the scenes it names.** Every cache-key
  input of a rejected clip is unchanged, so without `bypassCache` the lookup
  hits and the regeneration the reviewer asked for silently does not happen.
  `--regenerate-rejected` resolves the ledger **before** the cost estimate, so
  refused scenes are priced into the ceiling the operator authorises.
- **There is one source-resolution stage.** `source-resolution-stage.ts` is
  called by both the run and the review. Never add a second resolver: two that
  agree today would disagree after the first fix, and the review would then be
  reviewing clips that are not the ones being rendered.
- **Nothing on the review path constructs a provider or reads a credential.** No
  provider factory, no database client, no `fetch`; the entry point hands in two
  FFmpeg locations rather than `process.env`, and `aamp:motion-review` omits
  `--env-file` so `.env` never loads. `motion-review-source-hygiene.test.ts`
  asserts all of it — keep it passing rather than exempting a file.

## LTX storyboard-to-video — permanent rules

- **The five-level source precedence is a statement about truthfulness, not
  quality.** A real product capture, then a full-resolution rights-cleared
  original, then footage animated from the approved keyframe, then deterministic
  motion graphics, then refusal. **There is no still-image fallback for a
  required moving source** — a generated scene that silently becomes a held
  frame still passes every technical gate and is not the advertisement that was
  approved.
- **Previews and contact sheets are refused by location.** `candidates/`,
  `work/`, `shortlists/`, `generation-briefs/` and `brief/` are excluded before
  any rights column is consulted, the same structural rule `references/` gets.
  Only `approved-free-originals/` may render, only with an evidence JSON, and
  only with its SHA-256 recalculated from the bytes.
- **`MANUAL_LTX_STUDIO` and `AAMP_LTX_HOSTED_PROVIDER` are different facts and
  never collapse.** Clips the operator animated by hand are real footage and are
  reused free — and nothing in this repository may describe them as generated by
  this pipeline. Counting hand-made footage toward a claim about what the
  automated path can do would make the claim untrue. They are regenerated only
  when `--regenerate-scene` names them.
- **Critical UI never reaches a generative model, structurally.**
  `preserveExactTypography` or `preserveExactProductUi` makes
  `LTX_IMAGE_TO_VIDEO` unreachable for that scene, refused at parse time rather
  than by a downstream check that could be forgotten. A model asked to redraw a
  rankings table invents its contents.
- **The prompt gate refuses, it never rewrites.** Records, rankings, dates,
  counts, literal copy, the mark, the CTA and the product interface are refused
  by name with what to write instead. The prohibition clause is exempt from the
  content rules — a prohibition necessarily names what it forbids — and nothing
  else is.
- **Everything that can refuse the run happens before anything that costs
  money.** Storyboard, scene manifest, keyframes, prompts, sources and the cost
  ceiling, all before the first byte is uploaded. `--dry-run` reads no API key
  at all, which is a property of the code rather than a promise in the help
  text.
- **No automatic paid retry, ever.** A failed generation stays failed until a
  person reruns that scene. Retrying a billable request is how a transient blip
  becomes a doubled invoice.
- **LTX bills the clip it produced, so the estimate is a maximum, not a
  forecast.** Every generated scene is priced at the full duration requested,
  because a scene keeping two seconds of a six-second generation still paid for
  six. `LTX_PRICING_PROFILE_VERSION` travels in every estimate.
- **A cache hit makes no network call at all** — not a status check, not a
  re-download — and it is byte-verified on every read. The key covers every
  input that could change the output; an altered file is a miss, not a hit.
- **The credential never leaves the client, and no artefact holds a signed
  URL.** `assertStoryboardVideoArtefactSafe` walks everything before it is
  written and fails closed on credential-shaped values as well as forbidden
  keys. Every URL that reaches a message is reduced to host and pathname first.
- **`responseContractStatus` stays `DOCUMENTED_NOT_EXECUTED`** until an opt-in
  live test passes against the real API. The fake server is not evidence about
  `api.ltx.io`, and CI never contacts a provider.
- **The render is not reimplemented.** `runFlagshipV2` gained exactly two
  optional seams — `planPath` and `generatedSceneMedia` — and both default to
  the old behaviour, so every plan written before this milestone renders
  identically. A generated scene stages under the asset id the plan already
  binds, so preflight, rights, segment selection, the filter graph and
  actual-media QA all run unchanged.

## Locked-storyboard proof — permanent rules

- **Storyboard-01 and Storyboard-02 have opposite rights positions, and they get
  separate parsers.** `REFERENCE_ONLY` means its pixels may never be rendered and
  `reference-exclusion.ts` proves it by checksum. `STORYBOARD_INTERNAL_REVIEW_ONLY`
  means the panels _are_ the primary visual source. Never collapse the two into
  one parser with a flag: that would put a switch between "these bytes may never
  be rendered" and "these bytes are what we render".
- **What replaces exclusion is declaration, and it never travels alone.** Every
  panel asset carries `STORYBOARD_PANEL` provenance, "not licensed
  public-production media", "every phone screen is concept UI declared
  `PRODUCT_MOCKUP`" and "INTERNAL_REVIEW only" in its restrictions, and
  `isPublicReleaseReady: false` in every artefact. A panel is `role: BRAND_CARD`,
  never `APP_SCREENSHOT` — designed art is not a capture.
- **The run proves Storyboard-01 is absent.** Every file in the staging root is
  hashed against Storyboard-01's frame checksums before FFmpeg is invoked. "We
  did not use it" is a claim; the hash is the evidence.
- **The ten scenes, their roles and their slots are constants, not
  configuration.** `LOCKED_SCENE_ROLES` and `LOCKED_SCENE_SLOTS` are checked
  against the package, the plan and the finished cut. A reordered package, a
  scene off its slot, a gap, or a beat bound to a panel that is not its own fails
  the run.
- **A correction changes only the unverifiable element.** Both were made inside
  the panel in its own typography — the count erased by interpolation between
  ink-free anchors with the bell re-seated, the pill rebuilt from its own rounded
  caps about the same centre. A declared correction whose corrected panel is
  byte-identical to the original is refused: a correction that changed nothing
  did not happen.
- **A contained panel may never be cropped.** The push is bounded so that the
  panel's width fraction times the maximum push stays under 1.0. Widening either
  without re-checking that product would start cropping the composition the
  milestone exists to preserve.
- **Deterministic upscaling is declared, never claimed as detail.** Panels are
  staged at a 3x lanczos resample so they clear the asset root's minimum delivery
  width — the guard is respected rather than relaxed — and
  `panelPreparation.createsNewDetail: false` is written explicitly.
- **The fidelity report is structural and scores nothing.** It measures scene
  presence, order, timing, panel binding and headline integrity. It does not
  score how good the animation is, because no measurement of that exists and an
  invented number would be the one figure in the report nobody could check.
- **The three new plan flags default to the old behaviour.**
  `cta.renderEndCard`, `brandConstraints.showLogoOverlay` and the decoration
  window fields are all opt-out or optional, so every plan written before this
  milestone renders exactly as it did. Never change one of those defaults.
- **Adding a panel treatment is a `MOTION_TREATMENT_CATALOGUE_VERSION` bump.**
  It is 4 as of this milestone.

**The next milestone is AAMP-1 step 4** — `apps/worker` against a live Temporal
server (`docs/aamp-architecture.md` §6 task 6).

## Flagship advertisement — permanent rules

- **The storyboard is REFERENCE_ONLY, and that is proven twice, by content and
  by location.** A package edited to say `outputEligible: true` — at package
  level or on one frame — is refused by name, not silently downgraded. Every
  file in the staging root is hashed against every storyboard checksum
  **before** FFmpeg is invoked, and every manifest source is **re-hashed from
  disk** afterwards rather than trusted from its `expectedChecksum`, because
  the manifest is the thing being checked. A violation always throws; there is
  no mode in which a run continues having failed to show reference material
  stayed out.
- **The prohibited-claim gate refuses, it never rewrites.** Deleting "12" and
  rendering "FIGHT EVENTS THIS WEEKEND" would be application code editing the
  advertisement's copy. Every rule names the claim it protects against and what
  to write instead, because a refusal an author cannot argue with is one they
  work around. It walks **authored strings only** — a real capture showing real
  fighters is the product being honest about itself.
- **No store badge and no download promise**, because no verified public
  listing exists. The approved CTA is `NEVER MISS FIGHT NIGHT.` /
  `OPEN COMBAT REVIEWS` / "Every combat sport. One place."
- **The labels are constants, not options.** There is no `--execution-mode`, no
  `--allow-paid-providers` and no `--output-use` on this path, and an
  unrecognised flag is refused by name. Nothing here constructs or can import a
  reasoning provider, a generation provider or a database client; the
  acceptance suite runs where a campaign run exits 3.
- **A mockup is honest by what it does not contain.** The discussion
  `PRODUCT_MOCKUP` carries **no text at all** — no handle, comment, count,
  timestamp or topic — so it cannot fabricate user-generated content however
  its JSON describes it. Its only non-geometric element is the real `OWNED`
  mark. It is `role: BRAND_CARD`, never `APP_SCREENSHOT`: calling a designed
  graphic a screenshot would make the vocabulary itself say something untrue.
- **External packs are read-only, always.** Selected media is _copied_ into a
  staging root the run owns and the copy's checksum is re-computed and compared
  before it stands. Staging is idempotent by content, so a second run copies
  nothing. Never write, rename, move or delete inside a pack, and never
  hardcode a pack path into application logic.
- **Do not declare an asset missing until every pack has been checked.**
  Discovery is exhaustive and the reconciliation table records what was passed
  over as well as what won — a table of winners with no losers is not an
  explanation. An absent pack is a recorded finding, not an error.
- **Substitutions are authored, never inferred.** What a beat could not have
  and why the thing it got is honest instead is a creative judgement;
  `asset-substitutions.json` holds it in the author's own words and application
  code only records it.
- **Product screens are never graded.** Legibility of the real interface
  outranks palette unity, and a tinted screenshot misrepresents the product.
  Footage is graded so eight separately-shot licensed plates read as one film.
- **`AGENCY_GRADE` is unreachable by construction.** Seven of the ten scorecard
  dimensions, worth 73 of 100 points, carry `HUMAN_JUDGEMENT_REQUIRED` and
  `awardedPoints: null` — not 0, because a zero is a judgement too and nobody
  made it. The best a run reaches is `AWAITING_HUMAN_CRAFT_REVIEW`. Temporary
  audio scores **0 of 7** rather than partial credit and blocks the gate on its
  own: synthetic `lavfi` tones are not a mix, and a partial score would make the
  number mean the opposite of what a reader assumes.
- **Adding or changing a grade is a `MOTION_TREATMENT_CATALOGUE_VERSION`
  bump.** It is 3 as of this milestone. Grades are a separate family from scene
  treatments because grading is orthogonal to movement; folding them together
  would multiply every key by every grade and leave the first unenumerated
  combination ungraded.
- **CI never reads the operator's Desktop.** Every contract is proven against
  fixtures and temporary directories; the acceptance suite builds its own
  storyboard, library and plan, needs a real FFmpeg, and skips **loudly**
  without one.

## Creative finishing — permanent rules

- **Vague feedback is refused, not interpreted.** Every defect carries a time
  range, a category, what was observed and what must change. The vague-phrase
  check fires on the whole field being a mood and nothing else, so a reviewer
  writing prose is never blocked — but "make it punchier" cannot become a render
  decision, and the schema will not accept it.
- **The reviewer authors the alternatives; application code owns the
  discipline.** A `StageDirectiveSet` states the structural operations per
  candidate. The operation vocabulary is closed and contains nothing that writes
  a caption, headline, hook line or script beat — `SET_CAPTION_ENTRANCE` changes
  how a line arrives, never what it says. No timing, gain, opacity or intensity
  literal may be assigned to a plan field anywhere in
  `apps/aamp-cli/src/finishing/`; `finishing-source-hygiene.test.ts` asserts it.
  A "sensible default" alternative added to unblock a demo is the system writing
  the advertisement again.
- **`HOOK → PACING → AUDIO → CTA`, in that order.** The hook decides whether
  anything after it is seen; the CTA depends on everything before it. Comparing
  a stage against an unsettled earlier one is comparing a variable against a
  variable, and is refused by name. Each stage owns a primary axis and a fixed
  set of dependent ones; an operation outside the set is refused, and so is a
  candidate that never moves the primary axis.
- **The run adds the control itself.** `control` is a reserved id, and it is the
  approved plan unchanged. A comparison without the current cut in it asks
  "which of these three?" when the honest question is "any of these three, or
  what you already have?"
- **Every candidate renders through the existing preview path, unchanged.** Same
  preflight, same rights enforcement, same deterministic segment selection, same
  actual-media QA. A candidate rendered through a shortcut would be judged
  against a standard the finished master never has to meet. Two candidates
  producing byte-identical plans are refused.
- **Editing refuses rather than repairs.** A retime names the beat that gives
  the time back; a donor that cannot afford it, a beat that does not exist, or
  an asset the brief never approved is refused with the reviewer's own
  vocabulary. The edited plan is re-parsed through `parseHumanPlan`, so there is
  no privileged path around the schema for plans this code produced.
- **A selection is the only way a stage settles.** No `--latest`, no default,
  no highest-scoring candidate. It pins the reviewer, the instant, the reason in
  their own words and the checksum of the approved plan, and that checksum is
  re-verified on every read. A candidate that never produced a master cannot be
  selected — a selection is a judgement about a file that exists.
- **A finishing artefact is written once.** An identical rewrite is idempotent
  and fine; a different one is refused by name. The directives file is written
  only after the proposal stands, so a refused set cannot block the corrected
  one.
- **Nothing scores creative quality on the system's behalf.** Craft dimensions
  carry `HUMAN_JUDGEMENT_REQUIRED` and no number, and no function in this
  repository produces, suggests or defaults one. `PREMIUM_READY` needs a passing
  QA, a scorecard written against that master's checksum, every gated dimension
  over the brief's own threshold, and every `BLOCKING` defect recorded as
  resolved — with each missing condition named, because a bare "not ready" gets
  the condition removed rather than met.
- **Nothing on this path constructs a provider.** No reasoning provider, no
  generation provider, no database client, no composition root. The suite runs
  with `REASONING_PROVIDER=claude` and no API key, where a campaign run exits 3.
- **`drawbox` cannot animate, and the catalogue must not pretend it can.** Its
  `t` in an expression is the _thickness_, not the timestamp, and it has no
  per-frame evaluation mode — an `x='10+100*t'` resolves once against the wrong
  variable and never moves, with no error. Movement is a series of
  statically-positioned boxes with disjoint `enable` windows. Verified against
  FFmpeg 8.1.2, and found the hard way.
- **A whole-frame finish refuses a partial rectangle.** `EDGE_VIGNETTE` and
  `FILM_GRAIN` act on the entire picture; silently widening a region would make
  the artefact describe a cut nobody authored.
- **Adding or changing a treatment is a `MOTION_TREATMENT_CATALOGUE_VERSION`
  bump.** It is 2 as of this milestone. A storyboard citing v1 describes a
  catalogue with five fewer ways to treat a frame, and two catalogues that
  cannot be told apart in the artefacts citing them are one bug away from
  disagreeing.

## Product-launch orchestration — permanent rules

- **The agents own the creative; application code owns the constraints; a named
  human owns the decision.** No concept, title, hook, caption, beat plan or
  timing literal may exist in `apps/aamp-cli/src/launch/` —
  `launch-source-hygiene.test.ts` asserts it, and a template assigned to a
  creative field must interpolate its input. A "temporary" default concept added
  to unblock a demo is the system writing the advertisement again.
- **`CAMPAIGN_MODES` lists only what is implemented.** `PRODUCT_LAUNCH` is the
  single member. Event promotion, paid direct response, creator distribution and
  UGC get their mode when they get the behaviour that makes it mean something; a
  discriminator every check accepts is decoration.
- **Distinctness is deterministic and explainable.** Seven closed-vocabulary
  axes compared by equality plus the central idea by content-word overlap; every
  pair must differ on at least 3 of 8 and the set must vary on at least 4. No
  embedding threshold — a number nobody can justify is not a governance rule.
  The report names every pair and every axis, because a refusal a person cannot
  argue with is one they work around.
- **The competition's only cross-candidate influence is the agent's own
  output.** `occupiedStructuralPositions` is built from what earlier slots
  emitted. Application code never states what a concept should be, only that
  this one must not repeat the last one.
- **A claim cites a supplied product fact or it is an invented claim.** The
  launch path formats constraints as `PRODUCT [id] — Label: detail` so the agent
  can cite the id; `formatFactualConstraints` stays untouched because a frozen
  prompt version describes its exact format. A concept that fails validation is
  rejected with a reason, never repaired — repairing it would mean writing it.
- **An assessment says what it rests on.** Four dimensions are craft judgements
  and carry `HUMAN_JUDGEMENT_REQUIRED` with verdict `NOT_ASSESSED`; the schema
  refuses any other verdict for them. Nothing predicts conversion or
  performance, and `agencyGradeClaim` has exactly one value. A concept is
  unselectable only for a stated prohibited claim, an inventory that cannot
  produce it, or a HIGH originality verdict — never for taste.
- **A concept version is written once.** A revision is version N+1 with
  `supersedesVersion`, produced by re-invoking the Creative Director through
  `revisionFeedback`. No route, CLI or helper edits concept JSON. Version N stays
  on disk exactly as the reviewer read it.
- **Nothing renders without a recorded selection.** `requireSelection` is the
  only way to obtain one, and there is no flag, default or "latest concept"
  fallback. The selection pins the reviewer, the instant and the checksum of the
  approved bytes; a concept edited afterwards is refused at render.
- **`inspect`, `select` and `reject` construct no provider.** They never call
  `createAampDependencies`, so a reviewer approving a concept cannot spend money
  — a property of the object graph, not a promise.
- **The handoff re-runs nothing upstream.** The approved strategy and concept
  reach `planCampaign` as `preplanned`. Re-running the Strategist or Creative
  Director would produce a different concept from the one a human approved,
  which is the failure a concept gate exists to prevent.
- **Only the merged, capture-substituted manifest reaches production**, and it is
  re-parsed through `parseProductionAssetManifest`, so an analysis-only,
  unknown-rights or inspection-only asset cannot enter it. A required capture
  that is inspection-only is refused **by name**; a capture the run never needed
  is recorded as refused rather than silently dropped.
- **The budget ceiling is enforced, not recorded.** A paid run computes a maximum
  from operator-declared rates and refuses above the ceiling; with no declared
  rates there is no ceiling, so the run is refused rather than authorised against
  an unknown number.
- **A fixture launch run is a demonstration everywhere it travels.**
  `isRealCampaignRun: false`, `FIXTURE`, `DEMONSTRATION ONLY`, and
  `--execution-mode production` refuses it. The launch fixture provider derives
  everything from its input and lives outside `packages/providers`, so no worker
  configuration can select it.
- **Variant rendering is out of scope for this milestone.**
  `requiredVariants` is recorded and assessed; only the master is rendered, and
  no artefact implies otherwise.

## Media acquisition — permanent rules

- **Acquisition grants no output rights, and neither does a download.** A
  candidate becomes usable only through a named human approval recorded against
  that specific item. `AUTOMATICALLY_ELIGIBLE` means "the policy raises no
  objection" — it is not permission, and the reason text says so. No flag, no
  environment variable and no code path fabricates, defaults or infers an
  approval; `buildApprovalTemplate` emits `TODO` in every prose field precisely
  so an unedited template is not one.
- **No lifecycle station may be skipped.** `RIGHTS_REVIEW_REQUIRED` is mandatory
  rather than a branch — even a CC0 item passes through it, because the record
  that somebody looked at _this item's_ rights is the artefact, not the outcome.
  `DOWNLOADED` and `INSPECTED` are separate because bytes arriving says nothing
  about what is in them. `assertLifecycleTransition` names what was skipped.
- **Measurements beat declarations, including about what the file _is_.** A
  catalogue row saying `video` over a JPEG made the profile refuse 60 real files
  for carrying the `mjpeg` codec. `detectedMediaKind` comes from the probe and
  governs the evaluation; `declaredMediaKindMismatch` records the disagreement.
  Still detection is by **container** (`image2`, `*_pipe`) — ffprobe gives a JPEG
  a synthetic 0.04 s duration and no `nb_frames`, so a frame-count heuristic
  reads it as a video.
- **Rejection is absolute, review is sticky, eligibility is the residue.** A
  refused licence ends the evaluation; one review trigger makes the whole
  decision `REVIEW_REQUIRED` however many clean facts sit beside it. There is no
  scoring, no threshold and no majority — "two of three risk fields are fine" is
  not a rights position.
- **`CC_BY_SA` is review-required, never refused and never automatic.**
  Share-alike binds the _finished advertisement_, and how this repository's
  output is licensed is not a decision code makes.
- **DVIDS is public domain only when the item says so at item level.** It hosts
  separately copyrighted contractor and commercial material too, so silence is
  ambiguous and ambiguity is refused. A commercial credit line outranks a
  public-domain field. Every DVIDS item carries the non-endorsement obligation
  and forces human review, always.
- **Openverse aggregates, so downloads are restricted to known upstream hosts.**
  Its `url` points at whichever third party holds the file; following it blindly
  would turn a search response into arbitrary outbound requests. It has **no
  video**, and a video request is refused by name rather than returning an empty
  page — an empty page would misrepresent the catalogue.
- **Adapters are thin and make no policy.** They translate one provider's shape
  into the normalized contracts and nothing else. Rights decisions and quality
  scores live above them, once, so five providers cannot become five policies.
- **Never claim a contract is verified when it is not.**
  `responseContractStatus` is `DOCUMENTED_NOT_EXECUTED` until an opt-in live test
  passes against the real API. CI never contacts a provider and never spends a
  quota; the fixture server is not evidence about a live API.
- **Never integrate YouTube, TikTok, Instagram, Facebook, UFC, ONE, DAZN, the
  Internet Archive or a social-media mirror**, and never install `yt-dlp`,
  `gallery-dl`, a browser scraper or an unofficial downloader. `REFUSED_SOURCES`
  states each refusal as data so an operator gets the reason, not "unknown
  provider".
- **Every provider URL is untrusted input.** Host allowlists per provider and per
  purpose, redirects followed by hand and re-validated at every hop, no literal
  addresses, no loopback outside a test, no credentials in a URL, bodies bounded
  while streaming, and bytes sniffed — a `.mp4` that is an HTML quota page is a
  failure, not a video.
- **No artefact holds a credential, a signed URL or a local path.** Two of the
  three keyed providers authenticate by **query parameter**, so no artefact ever
  holds a URL with a query string; provenance keeps a host and a pathname.
  `assertMediaArtefactSafe` walks everything before it is written and fails
  closed. `private-provenance.json` is the only file permitted local absolute
  paths, and it is still walked for credentials.
- **The external pack is read-only, and its paths are untrusted.** Nothing is
  written, renamed, moved or deleted. Every path is resolved _and_ `realpath`-ed
  and re-checked for containment; checksums are recalculated, never read;
  `references/` is refused as production media by **location**, before any rights
  column is consulted. Never hardcode a user-specific pack path into application
  logic.
- **`INTERNAL_EVALUATION` is a different kind of permission, not a weaker
  grade.** It is refused **by name** from a campaign manifest — never filtered —
  and produces a demonstration labelled in both the library name and every
  affected asset's restrictions.
- **Licence families project onto the existing rights vocabulary.** CC0 becomes
  `LICENSED_FOR_OUTPUT`; there is no acquisition-shaped rights class. Adding one
  would mean every existing check had to learn about it, and the one that forgot
  would be the hole. The production manifest never learns an acquisition was
  involved.
- **Acquired production media is never indexed into Creative Memory.**
  `mediaAcquisitionGrantsNoReferenceUse` is total over the provider enum; keep it
  total. Pexels footage is not a benchmark advertisement.
- **The source-footage benchmark and the creative benchmark are different
  things.** This profile measures resolution, frame rate, codec, black/freeze,
  crop safety and edit utility. It reports **no** cinematic-quality score,
  because no reliable machine measurement of one exists; `humanChecksRequired`
  names what a person must judge, on every item.
- **The gallery makes no network request on its own.** Remote previews are links
  a person clicks; only local media is embedded. No script, no server, and every
  third-party string escaped.
- **Nothing on this path constructs a provider.** No reasoning provider, no
  generation provider, no database client, no paid call. `paidProviderCalls: 0`
  is a fact about the object graph, written explicitly rather than inferred.

## Live-UI capture — permanent rules

- **A URL is not a licence, and the code says so structurally.** Without an
  `AppCaptureRightsDeclaration` every captured asset is `REVIEW_REQUIRED`,
  carries a `null` rights classification, and `mergeCapturedAssets` **refuses**
  it by name rather than skipping it. Never add a path that infers rights from
  reachability, and never let a skip stand in for a refusal.
- **`OWNED_UI_CAPTURE` and `LICENSED_UI_CAPTURE` are declaration bases, not
  rights classes.** They project onto the existing `OWNED` /
  `LICENSED_FOR_OUTPUT` vocabulary, and the production manifest never learns a
  capture was involved. Adding a capture-shaped class to the production rights
  enum would mean every existing check had to learn about it, and the one that
  forgot would be the hole.
- **Read-only is a property of the object graph.** One route handler over every
  request continues GET and HEAD and aborts the rest; the same handler enforces
  the host allowlist. `FOLLOW_LINK` never clicks — it reads the anchor's `href`,
  verifies it, and navigates. An init script cancels `submit` in the capture
  phase and neutralises `HTMLFormElement.submit`, `requestSubmit`,
  `window.open` and `navigator.sendBeacon`. Never add a click, a `fill`, a
  `press`, or a step kind that could express one.
- **The `page` event fires for our own `newPage()`.** Popup detection must
  discriminate on `opener()`. Without that check the adapter closes its own
  page and every navigation dies with `ERR_ABORTED` — found the hard way.
- **Control detection matches whole path segments, never substrings.** A
  substring rule refuses `/events/post-fight-analysis` for containing "post",
  and a deny-list that fires on ordinary content is one operators work around.
  The accessible name is matched as prose; the `href` never is.
- **`APP_DISCUSSION_SANITISED` is off unless enabled by name.** `enabled` is
  optional precisely so its absence is a decision. An enabled discussion screen
  must declare at least one required redaction selector — "sanitised" is a
  claim about identifiers having been removed, and an unenforced claim is not
  one.
- **A required redaction selector that matched nothing fails the screen.** The
  page changed shape and something that had to be hidden was not. Deleting the
  selector to clear the error is deleting the check.
- **No raw DOM, ever.** No artefact holds page text, markup, headers, cookies or
  storage. `assertCaptureArtefactSafe` walks every artefact before it is
  written and fails closed on emails, bearer tokens, JWTs, credential query
  strings and a forbidden-key list that includes `html`, `outerHTML` and
  `textContent`. Keep both lists exhaustive when adding a field.
- **Query strings are dropped, never filtered.** A filter needs a list of the
  parameter names that carry secrets, and that list is always one deployment
  behind. Provenance records a pathname and a `queryPresent` boolean.
- **Screenshots are content-addressed and never silently overwritten.**
  `<assetId>-<first 16 of sha256>.png`; an existing file is verified to hold
  those bytes before it is reused. Empty, undersized, undecodable and
  duplicate-content screenshots are refused — a page that failed to render is
  still a valid, tiny PNG, and two screens with identical bytes are usually one
  screen that never changed.
- **The merge replaces by id and preserves plan bindings.** `role`, `beats` and
  `tags` come from the manifest; `path`, `checksum` and measured dimensions come
  from the capture. It never appends: an id no beat references would change the
  library without changing the advertisement. The merged document is re-parsed
  through `parseProductionAssetManifest`, so it faces exactly the same rules as
  a hand-written one.
- **Nothing on this path constructs a provider.** No reasoning provider, no
  generation provider, no database client, no paid call. The integration test
  runs with `REASONING_PROVIDER=claude` and no API key.
- **CI never contacts the deployed site.** Every browser-side guarantee is
  proven against `src/capture/fixture-site.ts`. The live test is opt-in
  (`AAMP_LIVE_CAPTURE=1`), reports `LIVE_CAPTURE_PROVEN` only after capturing
  the configured real host, and names its exact blocker otherwise. It runs
  inspection-only.
- **TLS verification, CSP and certificate checking are never relaxed**, and no
  credential, cookie or browser profile is ever accepted, stored or persisted.

## Zero-cost footage-first preview — permanent rules

- **`HUMAN_ASSISTED_PREVIEW` is decided by where the creative came from, not by
  how much infrastructure ran.** Its evidence value `HUMAN_SUPPLIED_PLAN` is
  permitted by no other mode, and it permits no other reasoning value — so a
  model-planned run can never be labelled a preview and a preview can never be
  labelled PRODUCTION. It also requires `videoGeneration: NOT_REQUIRED`.
  `satisfiesExecutionFloor` matches it **exactly**, never by rank: it is a
  different kind of run, not a weaker tier.
- **No reasoning provider is constructed in this mode — not even a fixture
  one.** `AampDependencies.reasoningProvider` is optional and a path that needs
  one calls `requireReasoningProvider`. "Zero reasoning calls" is a property of
  the object graph: there is nothing to call. Never add a provider here "just in
  case", and never route the preview into the agent planning path.
- **A plan is bound to one brief or it does not run.** `campaignPromptSha256`,
  `campaignId`, `workspaceId`, the duration, the CTA duration and the logo must
  all match the request. A plan that validates but was written for a different
  prompt would render perfectly and be the wrong advertisement.
- **A plan is attributable.** `authoredBy` is required, because the mode's
  entire claim is that a person made these decisions. Never add a default.
- **The template is a skeleton, never a runnable plan.** Every prose field says
  `TODO`. A template that rendered as-is would make the claim untrue on first
  use.
- **The plan carries the imitation prohibition**, because in this mode there is
  no prompt to carry it.
- **Preflight canonicalises before it trusts.** Resolve _and_ `realpath`, so a
  symlink inside the asset root pointing outside it is refused. Anything under
  `references/` is counted and refused entry to the production manifest
  whatever its declared rights say — that is the structural half of
  "analysis-only can never reach an output". Preflight is all-or-nothing.
- **In-points come from measurement, never from zero.** A window over measured
  black, frozen or already-used footage is _rejected_, not scored down;
  transition handles are required; a pinned in-point is verified, not
  overridden. Selection is pure, needs no model or network, and records every
  rejected alternative — a list of winners with no losers is not an explanation.
- **The motion-treatment catalogue is the single producer of motion grammar.**
  The filter graph builds none of its own, and v1 manifests compile through the
  same catalogue. Changing a treatment's filters is a
  `MOTION_TREATMENT_CATALOGUE_VERSION` bump, not an edit in place. Numbers reach
  filter text only through `num`, colours only through `hexToFfmpegColor*`.
- **Render manifest v2 is strictly additive and v1 is frozen.** One schema
  object, two versions: every v2 field is optional and `manifestVersion: 1`
  refuses each of them _by name_. Never widen v1.
- **The mix is data, not judgement.** Per-role gain clamps, trim ceilings,
  ducking permissions and fades are stated once in `CUE_MIX_RULES`. A role that
  never ducks cannot be talked into ducking by a plan. What is _measured_ is the
  finished master.
- **The storyboard is written before the render**, so a reviewer sees the
  intended cut and QA has something independent to compare the file against.
  `assertStoryboardSafe` fails closed on credentials, absolute paths and
  reference-analysis paths; `storyboard.html` opens with no server, no network
  and no script, and authored copy is escaped.
- **An unmeasurable binding property is not a satisfied one.** A QA check that
  could not be taken carries `notMeasuredReason` and is never a `PASS`. Never
  fabricate a measurement, and never report a manifest value as one.
- **The black/freeze walk skips what the manifest declared still.** A dip to
  black is black on purpose and a held end card is held on purpose; flagging
  either would make the check something operators learn to ignore.
- **A preview is never a campaign result.** `isRealCampaignRun: false`,
  `paidProviderCalls: 0`, `requiresHumanApproval: true` and the caveat are
  written explicitly into every artefact rather than left to be inferred.

## Budget enforcement — permanent rules (AAMP-1 step 3)

- **A reservation happens inside one `SERIALIZABLE` transaction, or it does not
  happen.** `reserveBudgetAcrossScopes` takes a `SerializableBudgetDataSource`;
  status, charge and release take the narrower `BudgetDataSource`. Never widen
  the reserving path to accept a handle that cannot serialize, and never add a
  non-transactional fallback — a compensating guard is only self-correcting if
  the process survives to write the compensation.
- **Every applicable level clears together.** A refusal at any scope writes
  nothing at any other. Never reintroduce a per-level loop with
  compensating RELEASE rows.
- **Policies are processed in policy-id order**, one lock order shared by every
  caller in the system. Changing that ordering reintroduces deadlocks between
  dispatches gated on overlapping scope sets.
- **Only contention retries.** Serialization aborts, deadlocks, Prisma `P2034`
  and a lost idempotency-key race are retryable; everything else propagates
  first time. An invalid request is refused before the transaction opens, so it
  can never be retried into existence.
- **Exhausted contention throws; it is never reported as `BUDGET_EXCEEDED`.**
  Callers treat a returned failure as a terminal business decision that fails
  the stage. Contention says nothing about the workspace's money.
- **Retries back off with jitter.** Retrying in lockstep is how a five-attempt
  bound was exhausted by eight concurrent dispatches; that was found against
  live PostgreSQL and cannot be found in memory.
- **`packages/database`'s repository layer stays vendor-neutral.** Only
  `client.ts` and `prisma-budget-transaction.ts` know Prisma exists.
- **The in-memory runner is a stricter fake, never evidence.** It serializes
  bodies absolutely and rolls back a failed one, so it can never produce a
  serialization abort. Only `budget-postgres-concurrency.test.ts` — opt-in,
  `pnpm --filter @combat/database test:postgres` — is evidence about PostgreSQL
  concurrency. CI never runs it.
- **Settlement stays the single closing path.** Charge the actual cost, release
  the reservation in full, both idempotent on `(policyId, idempotencyKey)` —
  unchanged from the post-M14 C-2 repair.

## Controlled creative benchmark — permanent rules

- **Difference is not improvement, and the system never says otherwise.**
  `COMPARISON_NOTICE` and the experiment's `interpretation` travel on every
  report. No field ranks the arms, and a test asserts no verdict word appears
  in the Markdown. Creative quality is recorded only in the human scorecard.
- **Both arms receive one frozen, hashed input.** The request is deep-frozen;
  the asset manifest is hashed by **bytes**, not by path. Each arm records what
  it actually received, and `assertArmsWereControlled` withholds the comparison
  when they disagree — comparing two different briefs is worse than not
  comparing, because it looks like evidence.
- **No mutable state crosses the arm boundary.** Separate run directories,
  workflow run ids, injectors and reasoning-provider instances. Sharing the
  database and Qdrant handles is fine; they are read-only here.
- **The comparison reads the artefacts on disk**, never in-memory state, so a
  finished experiment can be re-compared and an insufficient artefact is a
  defect found here.
- **A human score exists only because a person wrote it.** The runner emits an
  empty template; `aamp:benchmark score` validates a submitted file. Never add
  a function that produces, suggests or defaults a score.
- **Paid work needs four yeses**: a configured provider, an explicit
  `--allow-paid-providers`, a computable maximum cost printed _before_ the
  first call, and the authorisation recorded in provenance. Never default
  `BENCHMARK_INPUT_COST_CENTS_PER_MTOK` / `..._OUTPUT_...` — without them
  nothing is authorised, which is the point. Never hardcode a price table.
- **The benchmark uses the context-aware fixture, not the golden replay.** The
  replay provider ignores its input, so an ON/OFF comparison driven by it would
  show two identical plans and prove nothing. The context-aware fixture is a
  mechanism demonstration and is labelled as one everywhere.
- **`skipRender` is asked for, never inferred.** The result carries
  `renderSkipped`, because an absent output path is also what "QA never ran"
  looks like.

## Production composition root — permanent rules

- **There is one AAMP composition root.**
  `apps/aamp-cli/src/production/dependency-factory.ts` builds and owns every
  collaborator a campaign run uses. `generate-cli.ts` constructs no
  `PrismaClient`, `QdrantClient`, embedder or reasoning provider of its own.
  Adding a second construction site is how the execution-mode label stops being
  true.
- **The execution mode is derived from evidence, never from a flag.**
  `resolveAttainedExecutionMode` takes only `DependencyEvidence` and cannot see
  the requested mode. `--execution-mode` is a **floor**: it may refuse a run and
  may never promote its label. Keep it that way — a demonstration filed as a
  production result is the failure this whole module exists to prevent.
- **`PRODUCTION` refuses every substitute**: fixture reasoning, fixture
  generation, an in-memory store and any injected test collaborator, each with
  its own typed failure kind. A run a test could have substituted into is not a
  production run.
- **The factory imports no fixture.** Deterministic providers arrive through
  the `fixtures` seam, supplied by the CLI; a source-level test asserts no
  import in `dependency-factory.ts` can reach one. Do not import a fixture,
  mock or in-memory module there.
- **`NOT_REQUIRED`, `SIMULATED` and `UNAVAILABLE` are three different
  statements.** A source-only campaign genuinely needs no generation; a missing
  FFmpeg is not a substitute; an injected runner is. Never collapse them.
- **Resources close on success, failure and cancellation.** Construction keeps
  a closer stack and unwinds it if a later step throws; `close()` is idempotent
  and is called from the CLI's `finally`.
- **The doctor is read-only and reports everything.** It deliberately does not
  use the factory's fail-fast path — an operator fixing one blocker at a time is
  the failure it exists to avoid. No generation call, no spend, no database
  write, no render, no contact with the reasoning provider. Its only write is a
  probe file it removes. Statuses map to exit codes 0/1/2, and DEGRADED is
  non-zero on purpose.
- **Run provenance is durable, sealed and safe.** Every run writes a
  canonically-serialised, self-checksummed `aamp-run-provenance.json`.
  `assertRunProvenanceSafe` walks it against forbidden keys _and_
  credential-shaped values and fails closed; keep both lists exhaustive when
  adding a field. It records `requiresHumanApproval: true` and the cost basis
  explicitly rather than leaving either to be inferred.
- **No new Prisma model for CLI run provenance.** Every campaign-lifecycle
  table is keyed to a `Campaign` row only the workflow path creates, and those
  rows drive the three human gates. The record references the PostgreSQL rows
  that are already canonical instead of copying them.
- **An index entry claims `INDEXED` only after the Qdrant upsert returned.** A
  half-filled collection whose entries all say `INDEXED` fails silently and
  looks plausible, and the next run would skip exactly the missing scenes.
- **`aamp:reference ingest --force` refreshes declared manifest metadata** and
  nothing else. Analysis outcomes (`processingState`, `mediaAcquired`,
  `failureReason`) are results, not manifest values.

## Creative Memory — permanent rules (lawful benchmark ingestion)

- **Ingestion grants no output rights, ever.** No reference rights
  classification, processing state or human approval can make reference
  material usable in a produced advertisement. `READY_FOR_RETRIEVAL` means
  "analysed and reviewed", nothing more. Output material is ingested separately
  through the production-asset system.
- **The two rights vocabularies must never overlap.**
  `LICENSED_FOR_OUTPUT` and `PRODUCTION_ASSET` are absent from the reference
  enum and the Prisma enum by design, so a reference cannot be spelled in a way
  the renderer accepts. `referenceGrantsNoOutputRights()` is total over the
  enum; keep it total. Never add an output-permitting reference class.
- **Reference and production stay separate types, tables, repositories and
  storage namespaces.** `reference_*` tables, `reference-repository.ts`,
  `.aamp-reference-analysis/`. No relation crosses into `Asset`,
  `LicenseRecord` or `RenderJob`.
- **Public availability is not permission, and nothing is acquired
  automatically.** No scraping, no downloading, no browser automation. A
  link-only record acquires no bytes, permits no scene extraction, and must
  never be given a fabricated path, duration or measurement.
- **Originals are never modified.** Validation reads and hashes; every derived
  artefact is written elsewhere and records the source checksum, exact argv and
  tool version. A derived file whose origin cannot be named is
  indistinguishable from material of unknown rights.
- **Measurements and judgements are different records.** `ReferenceCraftMetrics`
  holds only computed facts. Subjective readings — "powerful", "premium",
  "engaging" — belong solely in an attributed, versioned `ReferenceAnnotation`,
  paired with the `prohibitedDirectSimilarity` that bounds them.
- **Never fabricate an unavailable analysis.** No transcriber means
  `TRANSCRIPTION_UNAVAILABLE`, not an empty or invented transcript.
- **FiftyOne is a disposable projection.** PostgreSQL is canonical for rights,
  provenance, annotations and state. Projection is idempotent; FiftyOne is
  never imported inside a Temporal workflow, and its absence is a typed error.
- **External detectors run at CLI/provider boundaries only**, with argument
  arrays and no shell, bounded time, cancellation and typed failures — and they
  never parse human-formatted terminal output when a machine-readable format
  exists.

## Prompt-driven source generation — permanent rules

- **A normal run requires genuine reasoning.** `REASONING_PROVIDER=mock` is
  refused (exit 3) unless the operator explicitly passes `--fixture-demo`.
  Fixture creative replays committed golden results and **ignores the campaign
  prompt entirely**, so it can never stand in for a campaign result. Never add
  a silent fallback from real reasoning to fixtures.
- **The brief reaches the agents verbatim.** `campaignPrompt` and ordered
  `factualConstraints` are typed inputs on all four planning agents; the
  derived `objective`/`keyMessages` are a summary, never a replacement. Every
  planning prompt version carries the shared brief-handling addendum.
- **No agency imitation, ever.** Creative intent is expressed as explicit
  properties — pacing, contrast, framing, typography, rhythm. Every planning
  prompt forbids naming or imitating an agency, studio or existing campaign.
- **Only `OWNED`, `COMMISSIONED` and `LICENSED_FOR_OUTPUT` may reach FFmpeg**,
  and only with `permittedOutputUse: true`. `ANALYSIS_ONLY` and
  `UNKNOWN_RIGHTS` are refused when the production manifest is parsed —
  benchmark and competitor material must never enter it. Expired licences,
  unsafe paths, checksum mismatches, missing files and kind mismatches are
  refused before or during resolution, never worked around.
- **Selection is deterministic and explainable.** Scores are pure functions of
  the request and manifest, ties break on asset id, nothing reads a clock.
  Every selection records why it won. When nothing fits, use the designed
  `BRAND_CARD` or raise the typed missing-source error — never substitute
  unrelated footage.
- **Measurements beat declarations.** Every accepted asset is probed with
  ffprobe; a declared duration or dimension that disagrees is recorded as a
  discrepancy and the measured value is what the timeline uses.
- **Technically valid, prompt-specific and agency-grade are three different
  claims.** QA measures the first and gates READY on it. Only a `REAL` run
  supports the second. The system never asserts the third: the scorecard always
  carries `agencyGradeClaim: NOT_ASSESSED` and `requiresHumanApproval: true`,
  and its dimension scores are structural heuristics, not quality judgements.
- **A QA failure prevents READY.** No heuristic score may override it.

## Real media rendering — permanent rules (vertical slice 1)

- **The render manifest is the only input.** `packages/media`'s versioned
  `RenderManifestV1Schema` is `.strict()` and validates cross-field rules,
  including that scene durations minus transition overlaps land **exactly** on
  the requested output duration. A new requirement is a new manifest version,
  never an edit to v1.
- **Licensing is enforced at source resolution, before FFmpeg exists.** Only
  `OWNED` and `LICENSED_FOR_OUTPUT` resolve; expiry is checked against a
  caller-supplied instant. An `ANALYSIS_ONLY` reference is refused with a typed
  error before the filesystem is touched or ffprobe is invoked. There is no
  other way for the renderer to learn a file path.
- **No authored string ever becomes filter grammar.** Captions, overlay copy and
  CTA text travel in a generated ASS file; only numbers and validated enum
  values are interpolated into `filter_complex`. FFmpeg runs with `cwd` set to
  the job directory and references that file by **bare filename** — a Windows
  `C:\…` path inside a filter argument collides with the `:` option separator.
- **Every binding QA fact is measured from the produced file** — ffprobe for
  container/codecs/geometry/duration, extracted RGB frames for blankness, CTA
  presence and caption presence. Never report a manifest value as a
  measurement. A report with any failed binding check sends the file to
  `rejected/` with `ingestionStatus: FAILED`; the deliverable path is reachable
  only through a passing report.
- **`packages/media` stays vendor-neutral and workspace-independent** (its only
  dependency is `zod`). The `MotionGraphicsProvider` adapter lives in
  `packages/providers`, which depends on `@combat/media` — that edge is
  deliberate and documented. `packages/domain` and `packages/media` still do not
  depend on each other; `RenderManifest`'s output block is kept _structurally_
  compatible with `VERTICAL_SHORT_FORM_V1`.
- **Never commit generated video, fixtures or copyrighted footage.**
  `.aamp-output/` and `packages/media/fixtures/generated/` are git-ignored.
  Fixture media is regenerated from FFmpeg `lavfi` sources with
  `pnpm aamp:fixtures`; the manifest that references it is committed, the media
  is not.
- **CI never invokes real FFmpeg.** The live integration test detects the binary
  and skips loudly when it is absent. Commands: `pnpm aamp:fixtures`, then
  `pnpm aamp:render --manifest packages/media/fixtures/combat-reviews-15s.manifest.json`.

## ComfyUI video generation — permanent rules (generation vertical slice 2)

- **Callers never author ComfyUI graphs.** Only server-owned, versioned
  profiles in `packages/providers/src/comfyui/workflow-profiles.ts` build a
  node graph; `submit()` takes the vendor-neutral request shape plus a profile
  key. A path from an API body to a ComfyUI node would be remote code
  execution on the render host.
- **Never invent node names, input names or workflow JSON.** Take them from
  ComfyUI's own source, the official model tutorials or maintained first-party
  examples, and record the source. A profile's `templateStatus` states how far
  verification got — `SIGNATURES_VERIFIED_NOT_EXECUTED` is not
  `EXECUTED_AGAINST_LIVE_SERVER`, and only a passing opt-in real integration
  test may raise it. A profile that cannot be established from official
  sources refuses to build a graph rather than shipping a guess.
- **No authored string becomes a path, filename or command.** Prompt text
  travels only as a JSON value inside a node's `inputs`. Output filename
  prefixes and uploaded reference filenames are checksum-derived. Filenames
  ComfyUI returns are used only as URL-encoded `/view` query parameters, never
  joined onto a local path.
- **Every response crosses `comfyui/protocol.ts`.** A shape this client does
  not expect is a typed failure at the boundary, never an `undefined` read
  three call frames later.
- **The job id is ComfyUI's `prompt_id`, derived from the idempotency key.**
  That is what makes polling survive a restart and a retry land on the same
  job instead of paying for a second render. Do not replace it with a random
  id or an in-memory handle.
- **Provider success never marks an asset READY.** Bytes are downloaded,
  hashed, and measured with ffprobe before persistence; an unreadable, empty
  or non-video result fails the attempt and releases its reservation.
  Measurements from the file are binding — never persist a requested value as
  if it were measured.
- **Rights are enforced before transmission.** `ANALYSIS_ONLY`, absent rights
  metadata, an expired licence and an unrecognised usage class all refuse
  before an upload is attempted. Only `OWNED`, `LICENSED_FOR_OUTPUT` and
  provenance-permitting `GENERATED` may be sent.
- **Production cannot select the mock.** `refineVideoGenerationConfig` refuses
  `mock` in production and refuses `comfyui` without an endpoint; the factory
  re-checks both. Never add a fallback that quietly substitutes the mock — a
  fabricated advertisement that passes every gate is the failure mode being
  guarded against.
- **CI never contacts a ComfyUI endpoint and never downloads a model.** The
  fake protocol server is for protocol tests only and is not evidence of
  working generation. The binding acceptance test is opt-in:
  `COMFYUI_INTEGRATION=1 pnpm --filter @combat/providers test:comfyui`.
- **Every `aamp:generate` result declares its execution mode.** The four modes
  (`REAL_REASONING_AND_REAL_GENERATION`,
  `REAL_REASONING_AND_FIXTURE_GENERATION`,
  `FIXTURE_REASONING_AND_REAL_GENERATION`,
  `FIXTURE_REASONING_AND_FIXTURE_GENERATION`) are derived from the selected
  providers, never set independently, so a label cannot disagree with what
  ran. The mode goes to stderr before and after the run, into `--json`, and
  into a `*.generation-provenance.json` sidecar carrying
  `isRealAdvertisement`. Never remove or soften these — a 1080×1920 MP4 with a
  `PASS` verdict reads as a finished advertisement, and in three of the four
  modes it is not one.
- **Fixture output is never presented as generation.**
  `FixtureVideoGenerationProvider` synthesises FFmpeg `lavfi` test patterns for
  demos only. It lives in `apps/aamp-cli`, outside `packages/providers`, so no
  `apps/worker` configuration value can select it, and it records
  `modelIdentifier: NONE-SYNTHETIC-TEST-PATTERN`. Do not move it into
  `packages/providers` or add it to `createVideoGenerationProvider`.
- **Requesting real generation without a working endpoint fails hard.** The CLI
  verifies nodes and VRAM before generating and exits 3 with the specific
  problems. Never add a fallback from `comfyui` to any fixture path.
- **Mock reasoning ignores the campaign prompt.** It replays committed golden
  fixtures, so it exercises plumbing and says nothing about creative quality.
  Never evaluate or report creative quality from a `FIXTURE_REASONING` run.

## Creative Memory retrieval — permanent rules

- **Retrieval grants no output rights.** Indexing, retrieving, reranking and
  returning a reference changes nothing about what it may be used for. Every
  search result carries that notice; do not remove it.
- **The agent-safe boundary is a separate type with a separate projection.**
  `AGENT_SAFE` results carry abstractions and measurements only — never a path,
  URL, byte, transcript, advertising copy, frame, logo or production-asset id.
  A test walks the serialised JSON against `AGENT_SAFE_FORBIDDEN_KEYS`; keep it
  exhaustive when adding a field.
- **Never report non-neural retrieval as neural.** `STRUCTURAL_BASELINE_V1` is
  labelled `NON_NEURAL_STRUCTURAL_BASELINE`, and a reranker that did not run
  must set `fallbackStatus` accordingly. A neural profile without an endpoint
  is refused at the config boundary rather than falling back silently.
- **Qwen quality is unproven until the opt-in binding test passes** against a
  real endpoint. Do not describe it as working.
- **PostgreSQL stays canonical; Qdrant holds vectors and filterable payload
  only.** No path, URL, credential, transcript or byte reaches Qdrant.
  Eligibility is recomputed from PostgreSQL after the vector search, so a
  withdrawn or unapproved reference disappears immediately.
- **A collection is keyed by profile, model revision, dimension and document
  schema version.** Never mix vectors across those; bump the name instead.
  Point ids are deterministic so re-indexing overwrites.
- **Refuse before writing**: wrong-width vectors, `NaN`/`Infinity` components,
  a collection whose dimension disagrees, an endpoint serving a different
  model. A half-filled collection of wrong vectors fails silently and looks
  plausible, which is worse than an empty one.
- **No model weights are ever downloaded.**
  `CREATIVE_MEMORY_MODEL_DOWNLOAD_POLICY` defaults to `deny`; keep it that way.
- **Do not default `QDRANT__SERVICE__API_KEY` to an empty value** — Qdrant
  treats empty as "auth enabled with an empty key" and 401s every data request
  while `/healthz` still answers.

## Creative Memory injection — permanent rules

- **Injection grants no output rights either.** A benchmark profile authorises
  influence on _planning_. It cannot make a reference renderable, no field in
  it can reach a render manifest, and every provenance artefact records
  `anyReferenceOutputEligible: false` explicitly rather than leaving it to be
  inferred.
- **Agents never query.** Context is resolved by the orchestrator immediately
  before each invocation and arrives as a typed field on that agent's own
  validated input. There is no agent tool, no second search, and no path from a
  prompt back into retrieval.
- **Every context is checked before every invocation.**
  `assertAgentSafeContext` walks the serialised envelope and fails closed.
  Prohibition fields (`usageDirective`, `notice`, `riskWarning`) are exempt from
  the imitation-phrase check _only_ — a prohibition necessarily names what it
  forbids. Keep the exemption to those fields.
- **Role scoping is the point.** Each of the four planning agents has its own
  versioned retrieval plan deciding which Creative Memory roles are queried and
  which observation fields it may be told. Never widen a plan's
  `permittedObservations` to "everything"; a camera move is not evidence about
  positioning.
- **A plan is versioned data, never edited in place.** Changing a plan changes
  what an approved campaign was planned against — bump `planVersion`, which
  travels in every context and every provenance record.
- **Governance may only tighten.** A benchmark profile can lower top-K, lower
  the context budget, lower items-per-reference and raise the diversity
  minimum. It may never loosen one, or approval becomes a way to buy more
  benchmark influence rather than less.
- **A profile row is written once.** A changed decision is a new version with
  `supersedesProfileId`; withdrawal is the only mutation and touches no
  governing field. The activation checksum covers governing fields alone, so it
  stays valid for the row's lifetime and a mismatch means tampering. Never add
  an update path that rewrites a governing field.
- **Approval is attributable or it does not happen.** An `APPROVED` profile
  without a reviewer and an approval instant is refused, and an inactive or
  unapproved profile can never govern a campaign. There is no auto-approval
  path, and `benchmark-seed` is a fixture convenience that still demands a named
  reviewer and activator.
- **Integrity failures are not availability failures.** A cross-workspace
  result and an unsafe context always throw, in every mode. Only missing
  profiles, retrieval outages, empty results, diversity failures and budget
  overflows degrade under `optional`.
- **No mode ever substitutes.** `required` exits 9 having produced nothing;
  `optional` records a typed `NOT_USED` reason; `off` performs no retrieval.
  Never add a fallback from a required-mode failure to fixture creative,
  generic benchmark text or a fabricated reference.
- **HIGH originality blocks before rendering; MEDIUM is recorded.** The gate
  runs after planning and before source selection, so a blocked run has
  produced no timeline and no file. `evaluateOriginality` may raise an agent's
  self-declared risk level and never lowers it. It is a governance signal, not
  comprehensive copyright detection, and every report says so.
- **The ON/OFF acceptance comparison proves mechanism, not quality.** Its
  reasoning provider is a deterministic fixture that derives from
  measurements. Never cite it as evidence about creative quality, and never
  move it into `packages/providers`.

## Authentication — permanent rules (AAMP-1 step 2, ADR-0006)

- **Clerk proves who; PostgreSQL decides what.** A verified session token yields
  exactly one fact — the Clerk subject. Role, workspace membership, permission
  and entitlement are **never** read from a token claim; they are resolved from
  `Membership` rows through the existing repository boundary, in the existing
  order (membership → permission → campaign ownership → child-resource
  association).
- **Never accept caller identity from request input.** No `userId` in a body,
  query string or unverified header, ever. Body schemas that could carry one are
  `.strict()`, and a source-level test asserts no route file reads `userId` from
  `request.body`/`request.query`.
- **`apps/api` authenticates in exactly one place** —
  `apps/api/src/authentication.ts`'s instance-wide `onRequest` hook, which runs
  before every handler, Zod parse, repository read and `roleHasPermission` call.
  It is default-deny; `PUBLIC_ROUTES` (`/health`, `/ready`) is the entire
  exemption list and adding to it removes authentication from that path.
  Route handlers take the caller from `requirePrincipal(request)` and nowhere
  else.
- **Clerk Organizations stay disabled.** Tenancy is `Workspace` + `Membership`.
  `VerifiedPrincipal` deliberately carries no workspace or organisation field.
- **The identity fakes are not selectable by configuration.**
  `@combat/auth/testing` is reachable only by a code import (tests and
  `dev-fake-server.ts`); no env var can choose a fake verifier in a real
  process. `apps/api` fails closed without `CLERK_SECRET_KEY`, in every
  environment. The dashboard never reads a secret key — it holds only the
  publishable key.
- **`packages/auth` owns the vendor seam.** Everything above
  `ClerkTokenVerifier`/`ClerkProfileDirectory` is vendor-neutral; only
  `clerk-adapter.ts` imports `@clerk/backend`.

## Post-M14 audit repair (current HEAD)

A read-only audit of the M14 tree returned FAIL. Six findings, all repaired.
Full accounting in `docs/architecture.md` §8's post-M14 entry.

**C-1 — the Worker registered no usable activity.** `apps/worker` passed
`@combat/workflows`' `activities` namespace to `Worker.create`, but that
namespace exports `create*Activity(deps)` _factories_, so not one proxied name
was registered and every workflow would have failed on its first Activity task
against a real Temporal server. Each workflow contract now also exports a
runtime name tuple, compile-time proven to cover its interface exactly
(`workflows/activity-name-contract.ts`); `createWorkerActivities(deps)`
(`packages/workflows/src/worker`) builds the real registration object from those
same contracts; `apps/worker` wires the concrete dependencies. There is no
second activity-name list anywhere. A conformance test asserts exact coverage in
both directions with named diagnostics — a future missing registration fails
before merge.

**C-2 — `spentCents` reported roughly double the real spend.** All three
settlement paths charged the actual cost but released only `estimated − actual`,
leaving the RESERVATION row standing beside its CHARGE; an under-estimated job
released nothing at all. `settleBudgetReservation` is now the single settlement
path — charge actual, release the reservation in full — and `chargeBudget` /
`releaseBudget` are idempotent on `(policyId, idempotencyKey)`. The test that
encoded the wrong total was corrected.

**C-3 — registry conformance was cosmetic.** The M14 check matched only each
audited path's last URL segment against the router dump, plus a hardcoded route
count. `route-inventory.ts` now parses `printRoutes({ includeHooks: false })`
into full `(method, path)` pairs and compares them to `MUTATING_ROUTES` as exact
sets both ways. Every registry entry also gets a permission probe: accepted for
a role holding the audited permission with valid resource ownership, 403 with no
side effects for the most-privileged role lacking it.

**H-1** — the in-memory store now mirrors every `(campaignId, version)` family,
every per-job idempotency-key constraint and the one-job-per-specification
constraints, not just the three it had. **H-2** — `.github/workflows/ci.yml`
runs the documented validation commands; nothing else. **H-3** —
`dev-fake-server.ts` gained campaigns parked at `HUMAN_SHOT_SELECTION` and
`FINAL_APPROVAL`, and the Playwright suite covers both gates: the UI is
reachable, gate-advancing controls stay disabled until the required state
exists, and the request behind each control is refused server-side when sent
directly.

## M14 — production hardening & operational safety

**Authorization audit.** All 18 mutating `apps/api` endpoints are enumerated in
a typed registry (`apps/api/src/route-authorization.ts`) carrying the exact
`Permission` from the canonical `@combat/domain` matrix, the target resource and
the required ownership checks. The registry is executable: tests assert it
matches the routes Fastify registered, that every permission exists in the
matrix, that every campaign-scoped mutation verifies campaign ownership, and
that `ANALYST` holds no mutating permission — so an endpoint added without a
registry entry fails the suite rather than shipping unaudited.

**Three authorization defects found and fixed.** (1) Five shot-review mutations
accepted a body-supplied `setId` verified only against the _workspace_, letting
a privileged caller mutate one campaign's selection set through another
campaign's route in the same tenant. (2) Performance ingestion pinned a
client-supplied `creativeVariantId`/`variantAssetId` as provenance without
checking it belonged to the path campaign. Both now run
`assertBelongsToCampaign`. (3) `/shot-review/comment` required `SELECT_SHOTS`;
narrowed to `PROVIDE_CANDIDATE_FEEDBACK`.

**Two budget defects found and fixed.** `checkAndReserveBudget` was an
unguarded read-then-write: concurrent _distinct-key_ reservations could both
observe headroom and over-spend the cap, and concurrent _same-key_ retries
crashed on the unique constraint instead of resolving idempotently. Now a
constraint violation resolves to the winner's row, and after insert the ledger
prefix up to the new reservation is re-summed so the row that actually crossed
the cap is compensated while earlier writers stand (first-writer-wins). **The
durable fix is a `SERIALIZABLE` transaction in Postgres**, which cannot be
exercised without a live database — the compensating guard is what is tested.

**Also hardened.** Crash-point replay for both dangerous windows (worker dies
after persistence before dispatch; after dispatch before persistence) — no
duplicate provider submission, charge or derived asset. Signal resilience —
duplicate, late, wrong-gate, non-pending, forged and pre-gate signals each
cross the gate at most once and poison nothing. `workerEnvSchema` now **fails
closed** when `REASONING_PROVIDER=claude` has no `ANTHROPIC_API_KEY`, instead of
silently degrading production to the deterministic mock. `createLogger` gained
pino redaction (it previously had **none**) covering credentials, connection
strings, auth headers and model payloads, while leaving correlation identifiers
readable. The in-memory store now mirrors the `Asset` uniqueness constraint, so
a missing checksum-dedup can no longer pass tests while failing on Postgres.

**Remaining production blockers — as recorded at M14, with authentication now
closed by AAMP-1 step 2.** Caller authentication was the standing blocker here;
it is resolved (see the AAMP-1 step 2 note and ADR-0006 above), so the paragraph
below stands except for that item. The audit repair makes the Worker's
activity _registration_ correct and provable without a Temporal server; it does
not prove the Worker runs against one, because none is available here.
Database migrations are no longer outstanding — AAMP-1 step 1 applied the first
one — but no application process has been pointed at live Postgres yet, so every
test still runs against the in-memory store. Also outstanding: live
Temporal/MinIO/ffmpeg, real Veo/Runway/ComfyUI adapters (only the deterministic
mock — do not connect one or spend money without an explicit, separate
decision), real export/render implementation, real ad-platform integration, and
**Final QA still performs no licensing check** (`docs/architecture.md` §7.2
item 1). See §8's M14 entry for the full accounting, including exactly what is
enforced in code versus deferred. `apps/api/src/dev-fake-server.ts`
(in-memory-backed) is what both `apps/api`'s own tests and `apps/dashboard`'s
Playwright suite run against. Anthropic is reachable via `@combat/providers`'s
`ClaudeReasoningProvider`, but only when explicitly configured; the default
`mock` provider is what every automated test uses.

## AAMP — permanent engineering rules

These rules govern **every** AAMP milestone (AAMP-1 live infrastructure, AAMP-2
Creative Memory, AAMP-3 real generation, AAMP-4 real composition/export, AAMP-5
human review and campaign proof, and the deferred creator-distribution work).
They sit alongside — never above — the boundary, security, migration,
provider-adapter and workflow-idempotency rules below. Full blueprint:
`docs/aamp-architecture.md`; rationale: `docs/adr/0005-aamp-creative-memory-and-real-media-architecture.md`.

### Boundaries

- Preserve existing domain, provider, activity, workflow, approval, budget,
  provenance and tenancy boundaries unless a documented ADR deliberately
  changes one.
- Introduce real integrations **behind existing provider interfaces** wherever
  technically valid — a new capability is an adapter plus, at most, additive
  optional fields, not a new seam.
- Agents never call providers, databases, storage, workflows or other agents
  directly. Creative Memory results reach an agent only as Activity-resolved
  `AgentInput.context` material — never as an agent-initiated query or tool.
- Preserve all three existing human gates, unchanged and non-bypassable:
  concept approval, shot selection, final approval.
- Every external operation must have typed input/output, idempotency,
  provenance, bounded retries, structured failure handling, deterministic mock
  tests and explicit cost/storage controls.

### Cost, credentials and mock mode

- Do not introduce paid APIs, real credentials, model downloads or
  infrastructure until the relevant implementation milestone explicitly
  authorises them.
- Every real-media milestone must preserve mock mode, so CI and local tests run
  with no GPU access, no external services and no paid credentials.

### Output quality

- Final-output quality is a **hybrid** system:
  - licensed/original footage and Combat Reviews app assets where appropriate;
  - AI-generated visuals for concepts, transitions, controlled shots and
    variants;
  - deterministic rendering for app overlays, typography, captions, CTA, timing
    and delivery.
- Never call output agency-grade or production-ready solely because a video
  model generated it.
- Evaluate quality against actual frames, audio, timing, brand rules,
  licensing, delivery specifications and human approval — measurements from the
  produced file are binding; an agent's assessment is advisory.

### Reference material and licensing

- Never treat copyright-protected reference footage as reusable output
  material.
- Reference material may be analysed for pacing, hook structure, visual
  language, caption rhythm, editing patterns, storytelling structure and CTA
  treatment.
- Only owned, licensed, public-domain or explicitly authorised assets may enter
  final output.
- Every retrieved reference must preserve source, licence, rights, expiry,
  attribution and usage restrictions.

### End of every AAMP milestone

- Update relevant documentation.
- Review the complete diff.
- Run milestone-relevant tests.
- Run full repository validation only once at the end, and only when
  application code changed.
- Commit separately.
- Report only: commit hash, files changed, tests run, remaining limitations,
  and the exact next milestone.

## Context and token efficiency

- Read only files relevant to the active task.
- Search for relevant code before opening large files.
- Do not repeat architecture already documented.
- Keep progress explanations concise.
- Use package-level tests during implementation.
- Run the complete repository validation only once at the end.
- Do not print lengthy successful command output.
- When a command fails, inspect only the relevant error section.
- Use subagents only for independent, clearly bounded work.
- Do not make multiple agents inspect the same files.
- At the end of each milestone, update relevant documentation, commit the
  work and report only:
  - commit hash
  - files changed
  - tests run
  - remaining limitations
  - next milestone

## Architecture boundaries

- **Temporal workflow files never do I/O.** Files under
  `packages/workflows/src/workflows/*` may only import `@temporalio/workflow`
  and type-only activity signatures — no `fetch`, `Date.now()`,
  `Math.random()`, filesystem, or network access. All I/O lives in
  `packages/workflows/src/activities/*`.
- **Specialist agents never call other agents or the database directly.**
  An agent is `(validated input) → (validated output)` plus one reasoning
  call. Only the orchestrator (workflows/activities) sequences agents and
  persists their output. This is why the system is an orchestrator over
  specialist agents rather than a free-form multi-agent chat — see
  `docs/adr/0001-specialist-workflows-over-freeform-chat.md`.
- **`apps/dashboard` holds no business logic.** No direct DB access, no
  Temporal client, no provider calls. Every command/query goes through
  `apps/api`. UI visibility is never authorization — every permission check
  happens server-side in `apps/api`.
- **Dependency direction**: `workflows` → `domain` only. `activities` →
  `agents`, `providers`, `media`, `database`. `agents` → `agent-runtime` +
  `domain` (not `database`, not `providers` directly). `packages/testing` is
  a leaf: other packages may depend on it for test helpers; it depends on
  nothing else in the workspace, to keep the dependency graph acyclic.
  `apps/worker` is the Worker-side composition root: it may depend on
  `database`, `providers` and `agents` to construct the concrete collaborators
  `createWorkerActivities` injects, the same way `apps/api` does. It holds no
  business logic of its own.
- Every entity that isn't global reference data carries a `workspaceId`.
  Single-workspace MVP now; the schema and repository layer already require
  scoping — see `docs/architecture.md` §4.4.

## Coding conventions

- TypeScript strict mode is non-negotiable (`tsconfig.base.json`) — do not
  add `// @ts-ignore` or loosen a compiler flag to work around an error;
  fix the type.
- Packages compile to CommonJS (`dist/`) via `tsc`; consuming packages import
  the compiled output, not source paths, across package boundaries.
- No default exports for shared modules — named exports only, so refactors
  and greps stay predictable.
- Prefer small, focused files per concern (one interface/one mock per
  provider, one repository per aggregate) over grab-bag "utils" files.

## Required validation commands

Before reporting any change complete, run (scoped to what you touched, or
the whole tree for cross-cutting changes):

```sh
pnpm typecheck     # turbo run typecheck across the workspace
pnpm lint          # turbo run lint
pnpm test          # turbo run test (Vitest)
pnpm build         # turbo run build
pnpm format:check  # prettier --check .
```

Dashboard end-to-end coverage: `pnpm --filter dashboard test:e2e` (Playwright;
builds and boots the app first — see `apps/dashboard/playwright.config.ts`).

`.github/workflows/ci.yml` runs exactly these commands on every push and pull
request — nothing else. Keep the two in step: a command added here belongs
there, and no deployment, secret, paid service or external infrastructure
belongs in that workflow.

If a command can't be run because required local infrastructure isn't
available (no Docker, no live Postgres/Temporal), say so explicitly rather
than silently skipping it or claiming it passed.

## Security rules

- No secret, API key, or token is ever hardcoded or committed. `.env` is
  git-ignored; only `.env.example` (placeholders only, no real credentials)
  is committed.
- Every mutating `apps/api` route checks the caller's role against
  `packages/domain`'s permission matrix (`roleHasPermission`) before doing
  anything else.
- Every `packages/database` repository function that touches a
  workspace-owned table takes `workspaceId` as its first argument and folds
  it into the query — never look up such a row by id alone.
- The three human approval signals (`approveConcept`, `selectShots`,
  `approveFinal`) are dispatched only from `apps/api`. No other app, no
  workflow/activity code, and no "dev convenience" path may fire them
  automatically.
- Provider credentials (once real adapters exist) are read only via
  `packages/config`'s validated env schema — never read `process.env`
  directly in adapter code.

## Migration rules

- Prisma schema changes go through `pnpm --filter @combat/database run
migrate` (`prisma migrate dev`) against a live Postgres — never hand-edit
  files under `packages/database/prisma/migrations/`.
- Every new table modeling workspace-owned data gets a `workspaceId` column
  and an index on it, unless it's the tenancy root (`Workspace` itself).
- Run `pnpm db:generate` after any schema change before typechecking/building
  — generated Prisma client types must stay in sync with the schema.

## Provider-adapter rules

- Every provider category (video generation, design, motion graphics,
  review, storage, reasoning) is accessed through the interface in
  `packages/providers`, never through a direct SDK call from an activity.
- Every real adapter must have a working deterministic mock before or
  alongside it — mocks are not an afterthought, they're how local dev and CI
  run without paid API keys.
- Mocks perform no real network I/O and must be deterministic (no
  wall-clock-dependent assertions, no reliance on external services).
- After Effects/`aerender` is never containerized — it is addressed only
  through `MotionGraphicsProvider` as an external Windows render worker.
- Do not connect a real video-generation provider (Veo/Runway) or spend
  money through one without an explicit, separate decision to do so.

## Workflow-idempotency rules

- Every provider/DB call made from an activity is wrapped with an
  idempotency key derived from `(workflowRunId, stage, entityId, attempt)`.
  Retries and workflow replays must never double-submit paid work.
- Every generation/render dispatch is preceded by a budget check at every
  applicable level (workspace, campaign, shot, provider) — see the
  `Budget`/`BudgetLedger` design in `docs/architecture.md` §4.3. A budget
  reservation is written before dispatch; a charge or release closes it out.
  No budget ledger row is ever mutated in place.
- Bound retries explicitly (no unbounded regeneration loops) and escalate to
  a human state rather than retrying forever.

## Documentation expectations

- A structural change (new package/app, new workflow stage, changed service
  boundary, changed dependency direction) updates `docs/architecture.md` in
  the same change — don't let the doc drift from what's actually built.
- A decision that reverses or narrows something the architecture doc states
  as resolved gets a note in §7 (or a new ADR if the reasoning is
  substantial), not a silent edit.
- Comments in code explain _why_, not _what_ — don't restate what
  well-named code already shows; do explain a non-obvious constraint,
  invariant, or workaround.
