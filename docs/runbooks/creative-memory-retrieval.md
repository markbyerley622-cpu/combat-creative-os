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
4. **Agent injection is not implemented.** This milestone builds the retrieval
   layer; no specialist agent consumes it yet.

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
- No agent consumes retrieval results yet.
- FiftyOne cannot run on this machine's Python (§12).
