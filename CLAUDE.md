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

**The next milestone is AAMP-1 step 4** — `apps/worker` against a live Temporal
server (`docs/aamp-architecture.md` §6 task 6).

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
