# Creative Memory — multimodal indexing, Qdrant retrieval and reranking

Making the reference library searchable. Companion to
`docs/runbooks/creative-memory-ingestion.md`, which covers how references get
into it.

## 1. Four statements that govern everything here

1. **Structural retrieval is real, but non-neural.** `STRUCTURAL_BASELINE_V1`
   genuinely ranks references on this machine with no model weights, no GPU and
   no endpoint. It is lexical and structural, not semantic: a query must share
   vocabulary with the reviewed annotations. It is labelled
   `NON_NEURAL_STRUCTURAL_BASELINE` wherever it surfaces.
2. **Qwen quality is unproven.** The 2B and 8B profiles are implemented behind
   typed endpoint adapters and have **never been run against a real endpoint**
   from this repository. Until the opt-in binding test passes, no claim about
   their retrieval quality is supported.
3. **Retrieval grants no output rights.** Indexing, retrieving, reranking and
   returning a reference changes nothing about what it may be used for. Agency
   media remains analysis-only.
4. **Agent injection is implemented, and proves mechanism rather than quality.**
   The four planning agents on the `aamp:generate` path receive role-specific,
   governed, agent-safe context (§§16–22). What is proven is that it reaches the
   right agent, changes the plan and the render manifest, and cannot leak
   expressive material. Nothing here supports a claim about creative quality.

## 2. Architecture

```
query + filters
  → eligibility gate (PostgreSQL: workspace, READY_FOR_RETRIEVAL, approved annotation)
  → query embedding (profile-selected provider)
  → Qdrant candidate search (payload filter: workspace, role, platform)
  → re-check eligibility against PostgreSQL
  → reranking (neural when configured, structural otherwise — always labelled)
  → composite scoring + source diversification
  → ADMIN or AGENT_SAFE projection
```

**PostgreSQL remains canonical** for rights, provenance, annotations and state.
**Qdrant holds vectors and filterable payload only** — no path, no URL, no
credential, no transcript, no bytes. Eligibility is recomputed from PostgreSQL
_after_ the vector search, so a reference withdrawn since indexing disappears
from results immediately rather than at the next reindex.

## 3. Collection versioning

A collection name encodes everything a vector must agree on:

```
creative_memory__<profile>__rev_<model revision>__d<dimension>__s<document schema version>
creative_memory__structural_baseline_v1__rev_v1__d288__s1
```

Vectors from different models, revisions, dimensions or document schemas can
therefore never share a collection: a mismatch becomes a _missing_ collection
rather than silently incoherent neighbours. Bumping any component creates a new
collection and leaves the old one intact for rollback.
`ensureCollection` additionally refuses an existing collection whose width
disagrees with the profile.

Point IDs are deterministic from `workspaceId + sceneId + profile`, so
re-indexing overwrites rather than accumulating.

## 4. Retrieval profiles

| Profile                         | Model                                         | Dimension | Neural | Status                                  |
| ------------------------------- | --------------------------------------------- | --------- | ------ | --------------------------------------- |
| `STRUCTURAL_BASELINE_V1`        | none                                          | 288       | no     | **Proven** — real, deterministic, local |
| `QWEN3_VL_2B_QUALITY_V1`        | `Qwen/Qwen3-VL-Embedding-2B` + `-Reranker-2B` | 2048      | yes    | **Unproven** — needs an endpoint        |
| `QWEN3_VL_8B_REMOTE_QUALITY_V1` | `Qwen/Qwen3-VL-Embedding-8B` + `-Reranker-8B` | 4096      | yes    | **Unproven** — remote only              |

Model IDs and dimensions are from the official repository
(<https://github.com/QwenLM/Qwen3-VL-Embedding>, verified 2026-07-27). The
rerankers score relevance from the generation probability of `yes`/`no` tokens.
**The official repository documents `transformers` and vLLM serving and no
HTTP API**, so the request/response shape this adapter expects is a
_repository-defined_ contract, not an official one:

```
POST {endpoint}/v1/embeddings   { model, inputs: [{ text, instruction, images: [base64] }] }
  → { model, data: [{ embedding: number[] }] }

POST {endpoint}/v1/rerank       { model, query, instruction, documents: [{ id, text }] }
  → { model, results: [{ id, score }] }
```

Normalisation is not specified upstream, so the adapter does not assume it: it
normalises defensively where the profile claims normalised output.

`checkHealth()` confirms the endpoint serves the exact model at the exact
width **before** indexing. A mismatch fails there rather than half-filling a
collection with the wrong model's vectors.

### `STRUCTURAL_BASELINE_V1` — what it actually does

Two blocks per vector: a 256-wide hashed bag-of-terms over the reviewed
annotations (sublinear weighting, sign hashing, a crude stemmer), and a
32-wide structured block holding measured craft statistics (cut density, scene
count, first cut, product-reveal and CTA timing, orientation, pacing band).
Deterministic, so the same scene always yields the same vector.

## 5. Model download policy

```
CREATIVE_MEMORY_MODEL_DOWNLOAD_POLICY=deny   # default
CREATIVE_MEMORY_MODEL_CACHE_DIR=.aamp-model-cache
```

**No code path in this repository downloads model weights.** The setting exists
so a future one cannot be added without an operator deliberately flipping it.
Endpoint credentials are read only through the validated config schema and are
redacted from every error, log line, generated artefact and Qdrant payload.

Other configuration: `CREATIVE_MEMORY_EMBEDDING_PROFILE`,
`CREATIVE_MEMORY_EMBEDDING_ENDPOINT`, `CREATIVE_MEMORY_RERANKER_ENDPOINT`,
`CREATIVE_MEMORY_EMBEDDING_API_KEY`, `CREATIVE_MEMORY_BATCH_SIZE`,
`CREATIVE_MEMORY_TIMEOUT_MS`, `QDRANT_URL`, `QDRANT_API_KEY`.

Selecting a neural profile without an endpoint is refused at the config
boundary — falling back to the baseline would mean a collection labelled
`QWEN3_VL_2B_QUALITY_V1` holding non-neural vectors.

## 6. Qdrant infrastructure

```powershell
docker compose -f infrastructure/docker-compose.yml up -d qdrant
```

Pinned `qdrant/qdrant:v1.12.4`, named volume `qdrant-data`, health check,
bound to `127.0.0.1` only. Existing Postgres, Temporal and MinIO volumes are
untouched.

**`QDRANT__SERVICE__API_KEY` is deliberately not defaulted.** Qdrant treats an
_empty_ value as "authentication enabled with an empty key", which makes every
data request return 401 while `/healthz` keeps answering — a confusing failure
that looks like a client bug. To enable auth, set a real value in an override
file or the shell and set `QDRANT_API_KEY` to match.

## 7. Commands

```powershell
# Index with the local structural baseline (no GPU, no endpoint, no download)
pnpm aamp:reference index --workspace <uuid> --profile STRUCTURAL_BASELINE_V1

# Force re-embedding of everything
pnpm aamp:reference reindex --workspace <uuid>

# Collection health and point count
pnpm aamp:reference index-status --workspace <uuid>

# Agent-safe search
pnpm aamp:reference search `
  --workspace <uuid> `
  --query "high-impact vertical fight-night hook that reveals the product quickly" `
  --role SCRIPT_AND_TIMING `
  --platform INSTAGRAM_REELS `
  --mode AGENT_SAFE `
  --top-k 8

# Admin search
pnpm aamp:reference search `
  --workspace <uuid> `
  --query "rapid impact transitions and animated app UI" `
  --role MOTION_AND_TRANSITIONS `
  --mode ADMIN `
  --top-k 8

# Remove one reference's vectors
pnpm aamp:reference remove-from-index --workspace <uuid> --reference <key>
```

### Exit codes

| Code | Meaning                        |
| ---- | ------------------------------ |
| 0    | success                        |
| 2    | invalid query                  |
| 3    | unauthorized workspace         |
| 11   | embedding provider unavailable |
| 12   | incompatible model profile     |
| 13   | Qdrant unavailable             |
| 14   | indexing failure               |
| 15   | reranking failure              |
| 16   | no eligible references         |

## 8. The agent-safe result contract

`AGENT_SAFE` results carry **only** abstractions and measurements: reference and
scene IDs, role tags, platform, craft metrics, pacing, hook mechanism,
narrative structure, camera/transition/typography/sound descriptors,
product-reveal and CTA timing, the transferable principle, its paired
prohibited direct similarity, retrieval and reranking scores, and provenance
identifiers.

They must never contain local paths, raw bytes, downloadable URLs, transcript
reproduction, advertising copy, music, reusable frames, logo assets or
production-asset identifiers. A test walks the serialised payload key by key
and value by value against `AGENT_SAFE_FORBIDDEN_KEYS` and path/URL/media
patterns — checking the actual JSON rather than the type, because the risk is a
field added later that the type permits and nobody re-reads.

`ADMIN` results add title, brand, agency, campaign, official URL, analysis
thumbnail, scene timings, reviewer notes and diagnostics. They are for humans.

## 9. Reranking and fallback semantics

`STRUCTURAL_RERANKER_V1` scores lexical overlap using the same tokeniser and
stemmer as the structural embedder; the pipeline composes that with role,
platform, pacing, hook and reviewer-confidence signals.

**If neural reranking did not happen, the result says so.** `fallbackStatus` is
part of the contract, travels into every result's explanation, and is exposed in
`AGENT_SAFE` output too. A neural reranker that errors falls back to structural
reranking labelled `FALLBACK_STRUCTURAL_RERANKING` — never silently reported as
neural.

Every result carries a real scoring breakdown (`vectorRecallScore`,
`rerankScore`, role/platform/pacing/hook matches, diversity adjustment,
reviewer confidence, final rank, profiles, fallback status). There is
deliberately **no generated natural-language explanation**: a sentence about a
score is a plausible-sounding restatement, not evidence.

## 10. Defaults and bounds

Retrieve up to 40 candidates, rerank, return up to 8, at most 2 scenes from one
advertisement. Hard maximums: 2000-character query, 200 candidates, 50 results.
All configurable within those bounds.

## 11. Rights and isolation guarantees

- Only `READY_FOR_RETRIEVAL` references with an approved annotation are indexed
  or returned.
- Workspace isolation is enforced twice: a Qdrant payload filter _and_ a
  PostgreSQL-side eligibility recomputation.
- Reference rights classifications remain output-forbidding; nothing in
  retrieval can change that.
- No source bytes, paths, URLs or credentials are written to Qdrant.
- Vectors containing `NaN`/`Infinity`, or of the wrong width, are refused
  before the write.

## 12. FiftyOne compatibility decision

**Decision: keep the `1.0.1` pin unchanged; do not upgrade in this milestone.**

Verified from PyPI metadata (2026-07-27):

- `fiftyone==1.0.1` declares `requires_python: ">=3.9"` with classifiers for
  Python **3.9, 3.10 and 3.11 only — not 3.12**.
- This repository's Python is **3.12.10**.
- Current FiftyOne (1.19.0) declares `requires_python: ">=3.10"` with a 3.12
  classifier, and the current docs state "FiftyOne currently requires Python
  3.10 - 3.12".

So the pinned version **cannot install on this machine's Python**. It was not
upgraded because upgrading was explicitly not to be done blindly and the
projection behaviour cannot be re-verified here — FiftyOne is not installed,
and installing it is a download this milestone does not permit. The two
supported paths, both documented rather than silently chosen:

1. Use a Python **3.11** virtual environment with `fiftyone==1.0.1` (the
   version the projection code was written against), or
2. Upgrade the pin to a 3.12-supporting release **after** re-verifying the
   projection behaviour in `fiftyone-projection.ts`.

Retrieval does not depend on FiftyOne. Search results can be exported as a
result manifest for human inspection; FiftyOne is never the retrieval engine.

## 13. Deletion and reindex

- **Reindex**: `pnpm aamp:reference reindex --workspace <uuid>` re-embeds and
  overwrites in place (point IDs are deterministic).
- **Staleness**: any change to a contributing annotation, transcript, frame or
  craft metric changes the embedding input hash, which is what marks a vector
  stale and makes the next index re-embed it.
- **Remove a reference**: `remove-from-index`, then optionally withdraw the
  reference itself per the ingestion runbook.
- **Change profile or document schema**: bump the revision or schema version;
  a new collection is created and the old one remains for rollback.

## 14. Testing

- **Benchmark** (`retrieval-benchmark.test.ts`): three deliberately distinct
  synthetic references with objectively-known expected top-one results, plus
  filter, diversification, idempotence, staleness, deletion, workspace
  isolation and agent-safe boundary assertions. Uses an in-process Qdrant
  stand-in for speed — it proves _ranking_, not integration.
- **Live acceptance** (`qdrant-acceptance.test.ts`): **real Qdrant**. Creates a
  versioned collection, indexes, runs all three benchmark searches, proves
  persistence across a fresh client, removes a reference's points, and checks
  dimension refusal and typed outage failure. Skips loudly when Qdrant is not
  reachable; deletes only its own test collection.
- **Qwen binding** (`qwen-binding.test.ts`): opt-in, requires configured
  endpoints, skips loudly otherwise. Until it passes, Qwen retrieval is
  unproven.

## 15. Current limitations

- Qwen 2B and 8B are implemented but unproven; no endpoint was available.
- The structural baseline is lexical: it cannot resolve synonyms, so a query
  using vocabulary absent from the annotations will not match well.
- Image modality is unused by the baseline (`maxImagesPerInput: 0`); analysis
  frames are only embedded by an image-capable profile.
- Index state is persisted by schema and repository but the CLI does not yet
  write `creative_memory_index_entries` rows — indexing currently reports
  outcomes and writes to Qdrant, with the `recordEntry` hook available for the
  Prisma-backed writer.
- FiftyOne cannot run on this machine's Python (§12).
- Creative Memory now reaches the four planning agents — see §§16–21. Creative
  _quality_ under injection is unproven; only the mechanism is.

---

## 16. Role-specific injection — what reaches which agent

Retrieval answers "what is similar". Injection decides **which agent is told
what**, under an approved benchmark profile. Each of the four planning agents
on the `aamp:generate` path has its own versioned retrieval plan
(`packages/domain/src/schemas/creative-memory-retrieval-plans.ts`).

| Agent role               | Plan key                          | Creative Memory roles queried                                            | Query built from                                                     | Observations it may be told                                                      | Top-K / budget  |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------- |
| `CAMPAIGN_STRATEGIST`    | `CAMPAIGN_STRATEGIST_CRAFT_V1`    | `CAMPAIGN_STRATEGY`, `PERFORMANCE_ANALYSIS`                              | brief, objective, audience, facts, platform, duration, CTA           | `hookMechanism`, `narrativeStructure`                                            | 4 / 6 000 chars |
| `CREATIVE_DIRECTOR`      | `CREATIVE_DIRECTOR_CRAFT_V1`      | `CREATIVE_DIRECTION`, `COPY_AND_BRAND_CONTROL`, `VISUAL_QUALITY_CONTROL` | brief, strategist output, brand system, facts, platform, duration    | `hookMechanism`, `narrativeStructure`, `typographyBehaviour`, `soundProgression` | 4 / 8 000 chars |
| `SCRIPT_TIMING_DIRECTOR` | `SCRIPT_TIMING_DIRECTOR_CRAFT_V1` | `SCRIPT_AND_TIMING`, `PLATFORM_OPTIMISATION`                             | brief, concept output, duration, platform, CTA, facts                | `narrativeStructure`, `transitionCategory`                                       | 5 / 8 000 chars |
| `SHOT_PROMPT_ENGINEER`   | `SHOT_PROMPT_ENGINEER_CRAFT_V1`   | `MOTION_AND_TRANSITIONS`, `PREVISUALISATION`, `CONTINUITY_AND_EDITORIAL` | brief, concept output, **the specific shot**, platform, brand system | `cameraMovement`, `transitionCategory`, `typographyBehaviour`                    | 3 / 5 000 chars |

The Shot-Prompt Engineer retrieves **per shot**, so a hook and a CTA get
different context.

Every plan also fixes its candidate count, items-per-reference cap, minimum
distinct references, minimum governance status (`APPROVED_AND_ACTIVE`),
tie-break (`RANK_THEN_REFERENCE_ID_THEN_SCENE_ID`) and fallback
(`CONTINUE_WITHOUT_CONTEXT` — escalated to a run failure by `required` mode).

**Platform is not a hard filter.** It is written into the query text and
rewarded by scoring. A hard platform filter on a small library silently empties
the context, and hook latency, cut density and transition mechanics transfer
across vertical short-form platforms.

**A plan is versioned data, never edited in place.** Changing one changes what
an approved campaign was planned against; bump `planVersion`, which travels in
every context and every provenance record.

## 17. The agent-safe context envelope

`CreativeMemoryContext` is the only thing an agent receives. Per item:

- `referenceId`, `annotationId`, `annotationVersion`, `sceneId`
- `contributingRole`, `retrievalScore`, `rerankScore`, `finalRank`
- `measurements` — durations, scene count, cuts per second, average scene
  length, first-cut latency, aspect ratio, pacing, product-reveal and CTA
  seconds, and the reference's ordered scene-duration sequence
- `observations` — only the fields the role's plan permits
- `craftPrinciple` (the approved `transferablePrinciple`, verbatim)
- `intendedApplication` (system-authored, per role)
- `riskWarning` (the reviewer's `prohibitedDirectSimilarity`)

Plus the plan and profile identity, retrieval/reranking profile,
`fallbackStatus`, the query hash, the role's focus areas, the standing usage
directive and the rights notice.

**Never present:** file paths, URLs, media bytes, transcripts, advertising
copy, lyrics or music, logos, credentials, exact frame sequences, production
asset ids, brand, title, campaign or agency. Agency and source identity remain
available in administrator-facing governance and `ADMIN` retrieval results and
must not enter an agent prompt.

`assertAgentSafeContext` walks the serialised envelope before **every** agent
invocation and throws `UNSAFE_AGENT_CONTEXT`. It checks
`AGENT_SAFE_FORBIDDEN_KEYS`, path/URL/media-filename patterns and imitation
phrasing. `usageDirective`, `notice` and `riskWarning` are exempt from the
imitation check alone — a prohibition necessarily names what it forbids.

## 18. Benchmark governance — the approval flow

A profile is what a named human approved. Rows are never rewritten.

```sh
# 1. Create + approve + activate one profile per specialist role.
pnpm aamp:reference benchmark-seed \
  --workspace <uuid> --reviewer <reviewer-id> --activated-by <operator-id> \
  [--name combat-reviews-benchmark] [--platform TIKTOK]

# 2. Inspect what exists, with reviewer, activation and checksum.
pnpm aamp:reference benchmark-list --workspace <uuid> [--role CAMPAIGN_STRATEGIST]

# 3. Ask what would govern a specific campaign right now, and if nothing, why.
pnpm aamp:reference benchmark-resolve \
  --workspace <uuid> --campaign <uuid> --role CAMPAIGN_STRATEGIST [--platform TIKTOK]

# 4. Withdraw. The only mutation, and it touches no governing field.
pnpm aamp:reference benchmark-withdraw --workspace <uuid> --profile <uuid>
```

Rules the repository enforces:

- An `APPROVED` profile must name a reviewer and an approval instant.
- A profile cannot be active unless it is approved.
- A new version supersedes the active one and deactivates it, recording
  `supersedesProfileId` on the new row.
- `governingChecksumSha256` covers governing fields only — so withdrawal keeps
  it valid, and a mismatch means the row was edited outside the repository.
  A mismatched row is refused with `CHECKSUM_MISMATCH`.
- A profile may only **tighten** a plan: lower top-K, lower the context budget,
  lower items-per-reference, raise the diversity minimum.
- Cross-workspace profiles are invisible.

`benchmark-seed` is a fixture convenience, not an auto-approval path: it still
demands a named reviewer and activator and refuses without them.

## 19. CLI usage

```sh
pnpm aamp:generate --request <campaign-request.json> \
  --creative-memory required|optional|off \
  [--assets <production-assets.json>] [--output-dir <dir>] [--plan-only] [--json]
```

| Mode            | Behaviour                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `off` (default) | No retrieval. Byte-identical to the pre-injection baseline. Needs no database, no Qdrant and no profile.                        |
| `optional`      | Uses context where a governed, eligible one exists; otherwise continues and records a typed `NOT_USED` reason.                  |
| `required`      | Retrieval, an approved profile and eligible role-specific context are mandatory. Any failure exits **9** before any agent runs. |

`required` and `optional` need `DATABASE_URL` (the library, its approved
annotations and its profiles live in PostgreSQL) and a reachable Qdrant.

Exit codes added by this milestone:

| Code | Meaning                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------- |
| `9`  | `CREATIVE_MEMORY_UNAVAILABLE` — required mode could not obtain governed context. Nothing ran.           |
| `10` | `ORIGINALITY_RISK_BLOCKED` — a HIGH originality result stopped planning before any source was selected. |

## 20. Originality, divergence and the gate

Each of the four agents returns `creativeMemoryDivergence`: the principles it
used (cited by reference id), the campaign-specific transformation, elements
deliberately changed, prohibited elements avoided, a self-assessed risk level
and a rationale.

`evaluateOriginality` reads the structured outputs deterministically:

| Signal                      | Severity | Fires when                                                              |
| --------------------------- | -------- | ----------------------------------------------------------------------- |
| `COPIED_REFERENCE_PHRASE`   | HIGH     | 8+ consecutive words reproduced from a reference craft note             |
| `IDENTICAL_BEAT_SEQUENCE`   | HIGH     | the planned beat lengths reproduce a reference's scene sequence         |
| `NAMED_AGENCY_IMITATION`    | HIGH     | an affirmative instruction to imitate an agency, studio or campaign     |
| `FORBIDDEN_FIELD_IN_OUTPUT` | HIGH     | a path, URL or media filename in an output field                        |
| `AGENT_DECLARED_HIGH_RISK`  | HIGH     | the agent assessed itself as HIGH                                       |
| `SINGLE_SOURCE_DEPENDENCE`  | MEDIUM   | every cited principle came from one reference while others were offered |
| `MISSING_DIVERGENCE_RECORD` | MEDIUM   | context was injected but no record came back                            |
| `UNKNOWN_REFERENCE_CITED`   | MEDIUM   | a citation names a reference that was not in that agent's context       |

HIGH blocks; MEDIUM is recorded and flagged for human review; LOW continues.
The evaluator may raise an agent's declared level and never lowers it. Negated
sentences are excluded from the imitation check, because an agent restating its
constraints is complying, not instructing.

**This is a governance signal, not comprehensive copyright, plagiarism or
similarity detection**, and every report says so.

## 21. Failure modes and run artefacts

Typed injection failures: `MISSING_APPROVED_PROFILE`, `RETRIEVAL_UNAVAILABLE`,
`NO_ELIGIBLE_REFERENCES`, `CROSS_WORKSPACE_RESULT`, `UNSAFE_AGENT_CONTEXT`,
`CONTEXT_BUDGET_OVERFLOW`, `SOURCE_DIVERSITY_FAILURE`,
`ORIGINALITY_RISK_BLOCKED`, `STALE_PROFILE_OR_ANNOTATION`,
`MALFORMED_RETRIEVAL_RESPONSE`.

`CROSS_WORKSPACE_RESULT` and `UNSAFE_AGENT_CONTEXT` are **integrity** failures
and always throw, in every mode. The rest are availability failures and degrade
under `optional` to a recorded `NOT_USED` reason
(`NO_APPROVED_PROFILE`, `RETRIEVAL_UNAVAILABLE`, `NO_ELIGIBLE_REFERENCES`,
`NO_ROLE_MATCHED_REFERENCES`, `COLLECTION_NOT_PERMITTED`,
`CONTEXT_BUDGET_OVERFLOW`, `SOURCE_DIVERSITY_FAILURE`,
`STALE_PROFILE_OR_ANNOTATION`, `MALFORMED_RETRIEVAL_RESPONSE`).

Every run directory gains two artefacts:

- `creative-memory-provenance.json` — mode, status, one audit record per agent
  invocation (plan key and version, benchmark profile with reviewer, activation
  and checksum, reference roles queried, query hash and length, retrieval and
  reranking profile, fallback status, collection, candidates retrieved,
  effective limits, distinct references, items dropped for budget, context hash,
  and per item the reference id, annotation id and version, scene id,
  contributing role, scores and rank), the divergence records, the originality
  summary, and `anyReferenceOutputEligible: false`.
- `originality-report.json` — the full assessment and its signals.

`run-summary.json` gains a `creativeMemory` block carrying the mode, the roles
that had context, the originality risk level and whether human review is
required.

**Nothing forbidden is persisted in these artefacts**: they carry ids, scores,
hashes and measurements, never retrieved prose or expressive content.

## 22. What injection proves and what it does not

**Proven** (`injection.test.ts`, `injection-acceptance.test.ts`,
`creative-memory-modes.test.ts`, plus the domain and repository suites):

- four agents receive four different role-appropriate contexts
- the same request and index state produce deterministic contexts
- different briefs produce different retrieval queries
- `required`, `optional` and `off` behave exactly as specified
- a retrieval outage cannot silently activate fixture creative
- transcripts, URLs, paths, bytes, copy, logos, credentials and media fields
  cannot cross the agent-safe boundary
- only `READY_FOR_RETRIEVAL` references with approved annotations are used
- only approved, active, same-workspace benchmark profiles govern a campaign
- cross-workspace references and profiles are invisible
- source-diversity rules are enforced
- a HIGH originality result blocks with FFmpeg never invoked and no render
  manifest written; MEDIUM is recorded for review
- ON versus OFF changes hook strategy, beat plan, a transition decision, the
  shot specification and the render manifest, and the manifest still contains
  only output-eligible sources

**Not proven:**

- **creative quality.** The ON/OFF comparison is driven by a deterministic
  fixture provider that derives from measurements. It demonstrates the
  mechanism, not judgement, and says nothing about how a real reasoning model
  would use this context.
- **agency-grade output.** Nothing here assesses that, and nothing should claim
  it.
- **Qwen retrieval quality** — still unproven, no endpoint (§4, §15).
- **behaviour against live PostgreSQL** — superseded by §23; see below.

## 23. Live PostgreSQL and Qdrant (production composition root, 2026-07-27)

The gap above is closed. `pnpm aamp:generate` now composes its collaborators
through `apps/aamp-cli/src/production/dependency-factory.ts`, which is the only
place a real `PrismaClient` or `QdrantClient` is built for a campaign run, and
the whole chain has been exercised against live local services.

**Index-entry persistence, finally wired.** `creative_memory_index_runs` and
`creative_memory_index_entries` were created by the retrieval migration and
`indexWorkspace` had always accepted `recordEntry`/`previousHash` seams for
them — but nothing passed those seams. The tables stayed empty and every
re-index re-embedded every scene. `pnpm aamp:reference index` now writes them
through `packages/database`'s `creative-memory-index-repository.ts`, so a
second run skips unchanged scenes.

**An entry claims `INDEXED` only after the point is in the collection.** The
previous ordering recorded `INDEXED` at embed time, so a Qdrant failure
mid-batch left rows claiming a scene was searchable when nothing had been
written for it — and the next run, seeing an unchanged input hash, would skip
exactly the scenes that were missing. A half-filled collection that looks
complete is precisely the failure this area's rules single out. Entries are now
written after the upsert returns; a refused batch is recorded `FAILED` with
`UPSERT_FAILED`, and the next run re-embeds it.

**Failure detail is redacted before persistence.** A provider's own error text
is the likeliest carrier of an endpoint credential into durable storage, and it
arrives already stringified, so a field-name allowlist cannot help. URLs,
key-shaped tokens and anything introduced by the words _api key_, _token_,
_password_ or _secret_ are removed, and the detail is length-bounded.

**`aamp:reference workspace-ensure`.** The tenancy root had no creation path
anywhere in the repository — every runbook assumed a workspace nothing could
create. It is idempotent by id and refuses a slug already held by a different
workspace.

**`--force` now refreshes declared metadata.** Re-ingesting an existing
reference previously reused the stored row untouched, so an operator who
corrected `businessRoles` and re-ran got a fresh analysis attached to the stale
roles — and a role a retrieval plan queries would silently never match. Under
`--force` the declared fields are updated; analysis outcomes are not.

**Proven live.** Docker PostgreSQL and Qdrant; four synthetic references
ingested, annotated, approved and indexed into
`creative_memory__structural_baseline_v1__rev_v1__d288__s1` (11 scenes, 288
dimensions); a second index run skipping all 11; four approved benchmark
profiles resolved from PostgreSQL; all four planning agents receiving
role-appropriate context retrieved from live Qdrant; and the whole run
producing an ffprobe-verified 1080×1920 MP4. Still unproven: Qwen retrieval
quality (no endpoint), and creative quality (the reasoning is still a fixture).
