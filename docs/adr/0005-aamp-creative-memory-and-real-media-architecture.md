# ADR-0005: Creative Memory, real generation, and deterministic composition as three separate layers

Status: Accepted
Date: 2026-07-26

## Context

M0–M14 and the post-M14 audit repair produced a complete, tested control plane —
a 20-stage campaign state machine with three unbypassable human gates, fourteen
specialist agents behind a validated envelope, an append-only budget ledger,
asset provenance, audited RBAC, and deterministic mocks for every provider
category. It produces no media. `MotionGraphicsProvider.fetchRenderOutput` is
documented "Never real bytes — returns metadata only"; `VideoGenerationProvider`
has no real adapter; and no reference material is retained, indexed or
retrievable anywhere in the system.

AAMP (`docs/aamp-architecture.md`) plans the path from that control plane to a
genuine, downloadable, human-approved 9:16 Combat Reviews advertisement. Doing so
requires three capabilities the foundation does not have — a lawful reference
knowledge layer, a real generation gateway, and real media composition — plus a
way to decide whether the output is actually acceptable.

The tempting shape is one layer: a strong video model, prompted well, producing
finished ads. This ADR records why the architecture is deliberately not that, and
why each seam sits where it does.

## Decision

Build AAMP as **three separate layers behind the existing provider interfaces**,
with a fourth, independent acceptance mechanism:

1. **Creative Memory** (AAMP-2) — a lawful, rights-aware reference library with
   bounded, cited retrieval. It informs planning. It never produces output.
2. **Generation** (AAMP-3) — ComfyUI as a single open-source gateway behind the
   unchanged `VideoGenerationProvider`, producing candidate shots.
3. **Deterministic composition** (AAMP-4) — FFmpeg-based assembly, overlays,
   typography, captions, CTA, audio mix and delivery encode behind the unchanged
   `MotionGraphicsProvider`/`MediaProvider` seams.
4. **Actual-media QA** (AAMP-4/§9.3) — measurements taken from the produced file,
   binding regardless of any model's or agent's opinion, and separate from human
   approval, which remains mandatory.

## Rationale

### Why Creative Memory is separate from generation

They answer different questions and carry different risk. Creative Memory answers
"what structurally works in this category" — hook taxonomy, cut rhythm, caption
cadence, CTA onset. Generation answers "produce this specific shot". Fusing them
would mean the only way to use reference knowledge is to condition a model on
reference material, which is exactly the path that turns lawful analysis into
derivative output. Keeping them separate lets retrieval return **non-expressive
structural descriptors** to a planning agent while the generation layer never
sees the reference at all.

The separation also has an operational payoff: Creative Memory can be rebuilt,
re-embedded, re-indexed, rolled back or switched to a different vector store
without touching a single generation path, and generation can be benchmarked and
swapped without invalidating the knowledge layer. And because retrieval is
additive, an outage degrades to today's behaviour — empty context — rather than
blocking a campaign.

### Why generation is separate from deterministic composition

Generation is stochastic, expensive, slow and unrepeatable. Composition must be
exact, cheap, fast and byte-reproducible. Typography, captions, safe areas, logo
placement, CTA timing and delivery specification are **contractual**, not
creative: a caption that drifts two frames or a CTA that ends 200 ms early is a
delivery defect, and no amount of model quality makes a sampled process
dependable at that tolerance. Model-generated text in a frame is treated as a
defect (`typography contamination` must measure exactly zero for caption-bearing
profiles) precisely because typography belongs to the deterministic layer.

Separating them also makes replay honest: composition is a pure function of
(timeline, brand-kit version, delivery-profile version), so its output is
content-addressed and a workflow replay dedupes instead of re-rendering — which
is impossible for a sampler with a seed and a GPU queue.

### Why actual-media QA is separate from model-output acceptance

A model's self-report, and an agent's multimodal assessment of a frame, are both
evidence. Neither is a measurement. Duration, resolution, frame rate, codec,
pixel format, black/frozen runs, caption presence and timing, safe-area
compliance, audio presence, clipping and integrated loudness are all decidable
from the file with ffprobe and FFmpeg filters, and those decisions are binding.
Agent findings remain advisory and are recorded as such.

This also fixes a real accountability problem: if acceptance depended on the same
model family that produced the work, a systematic model failure would be
systematically invisible. Measurement is the only check whose failure mode is
independent of the generator's. Concretely, the licensing check that
`docs/architecture.md` §7.2 item 1 has carried open since M11 becomes a joined
database query over `LicenseRecord`, not a rubric line a model can score
generously.

### Why raw text-to-video alone is insufficient for premium advertising

Six specific reasons, each observed in the requirements rather than assumed:

1. **Exact durations.** Deliverables are 15.000 s / 10.000 s / 6.000 s. Video
   models produce approximate lengths.
2. **Legible product truth.** The Combat Reviews UI must be the _real_ UI. A model
   asked to render an app screen invents one; that is a product misrepresentation,
   not a stylistic miss.
3. **Typography and captions.** Burned-in captions are mandatory in the delivery
   profile and must sit inside a safe area with a defined contrast ratio and
   minimum dwell. Models hallucinate text.
4. **Brand lockups.** Logo geometry, colour tokens and clear-space rules are
   specified, measurable and non-negotiable.
5. **Licensing.** Every shipping frame must trace to an owned or licensed source.
   A purely generative pipeline has no provenance story for the material that
   shaped it.
6. **CTA timing.** "Visible in the final two seconds for any variant ≥ 10 s" is a
   frame-level contract.

Text-to-video is excellent at the thing it is good at — plausible motion and
controlled shots — and is used for exactly that.

### Why the architecture is open-source-first

Four reasons, in order of weight:

1. **Cost control at iteration volume.** Advertising production is a
   many-candidates-per-shot activity. Per-second hosted pricing makes the
   iteration loop the dominant cost; self-hosted compute makes it a fixed one.
2. **Data residency for licensed footage.** Owned and licensed combat footage can
   be used as generation control input only if it is not redistributed to a third
   party. A self-hosted ComfyUI keeps that lawful; a hosted API changes the
   analysis and requires a separate decision.
3. **Reproducibility.** Pinned model weights, hashed workflow JSON and recorded
   seeds make a candidate reconstructible years later. A hosted model can change
   underneath a version string.
4. **No hard external dependency.** CLAUDE.md's standing rule is that local
   development and CI run with zero paid keys. Open-source-first keeps that true
   as real media arrives.

Open-source-first is not open-source-only: the existing `ReasoningProvider` may
be Anthropic's API, and a hosted generation provider remains addable behind the
same interface if the benchmark and the licensing analysis support it.

### Why providers remain replaceable

The foundation's provider interfaces were built vendor-neutral by construction —
`VideoGenerationProvider` explicitly so "a local ComfyUI/Wan adapter can be added
later without touching `ShotGenerationWorkflow`", and `MotionGraphicsProvider` so
"a different renderer (aerender, ffmpeg concat, a hosted editor API) can be
substituted behind the same interface". AAMP validates that claim rather than
revising it: ComfyUI enters as an adapter with **no required interface method
added**, and FFmpeg composition enters as a `MotionGraphicsProvider`
implementation.

The generative-model landscape turns over on a timescale of months. Any
architecture that lets a model's idiosyncrasies leak into the workflow layer buys
a rewrite every time the frontier moves. Replaceability is also what makes the
benchmark meaningful — swapping a model must be a configuration change, or the
comparison is not actionable.

### Why lawful reference analysis differs from copying or republishing

Analysing an advertisement to extract that it opens with a face-to-camera claim
at 0.4 s, cuts every 0.8 s, runs captions at 3.2 words per second and places its
CTA at 78% of duration produces **facts about structure**. Those facts are not
the work. Reproducing its shots, its copy, its distinctive look or its branded
lockup would be — and the architecture makes that structurally hard rather than
discouraged:

- retrieval returns derived descriptors plus at most `topK` bounded citations,
  never an ordered shot list from a single source;
- `shot-prompt-engineer` — the one agent whose output drives pixels — receives no
  transcript text and no brand names;
- excerpts are hard-capped and delimited as untrusted data;
- every citation carries source, rights holder, licence type, usage class and
  restrictions as non-optional fields;
- and `usageClass: ANALYSIS_ONLY` material is rejected by the composition input
  resolver as a typed check, so it cannot reach an export even if a plan names it.

The distinction is enforced at the boundary where it matters — what may become
output — rather than by instructing a model to behave.

### Why the system remains hybrid rather than fully generative

Final quality comes from combining three sources by their strengths:

- **licensed/original footage and Combat Reviews app assets** for anything that
  must be true: the product, the brand, real combat;
- **AI-generated visuals** for concepts, transitions, controlled shots and
  variants — material that must be plausible, not factual;
- **deterministic rendering** for app overlays, typography, captions, CTA, timing
  and delivery — material that must be exact.

Each is used where its failure mode is acceptable. A fully generative pipeline
would apply a stochastic process to the parts of an advertisement that carry
factual and contractual obligations. The hybrid boundary is also what makes the
first genuine downloadable MP4 reachable without a GPU at all: licensed footage
plus deterministic composition is a complete path.

### Why human approval remains mandatory

Three reasons, none of which measurement removes:

1. **Legal accountability.** The system spends real money and ships under a real
   brand. Someone identifiable must sign off, and that signature must be an
   immutable record — which is why the three gates require a `HumanApproval` row,
   signalled only from `apps/api`, independently re-verified by the workflow.
2. **Measurement is necessary, not sufficient.** Every §9.3 check can pass on an
   advertisement that is on-brief, on-spec and still wrong for the moment — an
   inappropriate juxtaposition, a poorly-timed message, a fighter it should not
   feature this week.
3. **The unresolved licensing policy.** Until `docs/architecture.md` §7.2 item 1
   is answered, the human approver is the last licensing control. AAMP-4 makes
   the machine check exist; it does not make the policy exist.

Automating the gates away would also invert the system's core premise, recorded
in ADR-0001: this is a deterministic orchestrator over specialist agents
precisely because it is production infrastructure for a commercial advertising
pipeline, not a creative assistant.

## Consequences

**Accepted costs.** Four layers instead of one means more interfaces, more
entities and more tests. Creative Memory adds a Python-tool surface
(PySceneDetect, Whisper, Qwen3-VL) that must be mockable to keep CI free of GPUs
and models. Deterministic composition means the delivery contract is enforced
early and rigidly, so a legitimate creative exception requires a new
`DeliveryProfile` version rather than an edit.

**Preserved.** Every M0–M14 boundary: workflow files do no I/O; agents call
nothing; three human gates; workspace scoping; append-only budget ledger with a
single settlement path; asset provenance created with the asset; deterministic
mocks for everything; CI with no paid keys, no GPU and no external services.

**Deferred, deliberately.** Hardware selection, model defaults, hosting, the
authentication mechanism, music/SFX licensing, and the reference-sourcing policy
are decision _criteria_ in `docs/aamp-architecture.md`, not decisions taken here.
Creator distribution is designed to a boundary and explicitly unbuilt: nothing in
AAMP-1..5 may acquire an external publishing capability.

**Reversibility.** Creative Memory is additive and can be disabled without
blocking a campaign. Generation and composition both fall back to their existing
deterministic mocks by configuration. Index versions, workflow-template versions,
brand-kit versions and delivery-profile versions all roll back independently. The
only genuinely one-way change in AAMP is replacing the request-supplied `userId`
with real authentication — and that direction is the correct one.

## Related

- `docs/aamp-architecture.md` — the phase-by-phase blueprint this ADR justifies.
- ADR-0001 — deterministic orchestrator over specialist agents.
- ADR-0002 — the canonical 20-stage lifecycle and three-gate design.
- ADR-0003 / ADR-0004 — the agent runtime and the agent/Activity boundary that
  keep agents free of I/O, which §"Why Creative Memory is separate" depends on.
- `docs/architecture.md` §5 (provider interfaces), §7.1 items 1–3 (provider
  neutrality), §7.2 items 1–6 (open questions AAMP inherits).
