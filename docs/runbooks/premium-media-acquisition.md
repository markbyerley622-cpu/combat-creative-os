# Premium licensed media acquisition

`pnpm aamp:media` finds, evaluates, acquires and ingests legally usable premium
footage, images and audio, and turns it into a production-asset manifest the
existing advertisement generator accepts unchanged.

This runbook covers provider setup, every command, the external pilot-pack
import, the source-quality profile, the licence policy, human approval, the
production-versus-reference separation, credits and attribution, the difference
between private evaluation and production output, exactly which live tests were
performed, and what is still unproven.

---

## 1. The one thing to understand first

**Acquisition grants no output rights.** Nothing in this pipeline makes
third-party material usable in a published advertisement. A candidate becomes
usable only when a named person records an approval against that specific item,
for specific usages, on specific platforms, with an effective date. There is no
flag, no environment variable and no code path in this repository that
fabricates, defaults, infers or bypasses that approval.

A policy outcome of `AUTOMATICALLY_ELIGIBLE` means _the licence rules raised no
objection_. It is not permission.

---

## 2. Two benchmarks, deliberately not the same thing

Do not confuse these. They measure different things and live in different
systems.

|            | **Source-footage benchmark**                                                                     | **Creative benchmark**                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| What       | `COMBAT_REVIEWS_PREMIUM_SOURCE_V1`                                                               | Creative Memory                                                                                                                                     |
| Measures   | resolution, frame rate, codec, bitrate, black/freeze, scene structure, crop safety, edit utility | hook strength, narrative construction, pacing, shot rhythm, transition discipline, typography, motion design, sound design, CTA timing, originality |
| Applies to | the raw material you acquire                                                                     | the advertisement you make                                                                                                                          |
| Rights     | production material; may enter an output manifest after approval                                 | `ANALYSIS_ONLY`; may **never** enter an output manifest                                                                                             |
| Where      | `apps/aamp-cli/src/media/source-quality.ts`                                                      | `docs/runbooks/creative-memory-retrieval.md`                                                                                                        |

Agents apply _principles_ retrieved from Creative Memory to _separately
licensed_ production assets. Nothing acquired through `aamp:media` is ever
indexed into Creative Memory — `mediaAcquisitionGrantsNoReferenceUse` is total
over the provider enum and always returns true.

---

## 3. Provider setup

Copy `.env.example` to `.env` and fill in the keys you have. **Every key is
optional.** An unset key means that provider reports `NOT_CONFIGURED` and
contributes nothing to a search. Nothing falls back to scraping a page and
nothing invents a catalogue entry.

| Provider          | Kinds            | Key               | Where to get it                                                |
| ----------------- | ---------------- | ----------------- | -------------------------------------------------------------- |
| Pexels            | video, image     | `PEXELS_API_KEY`  | https://www.pexels.com/api/ — free, self-service               |
| Pixabay           | video, image     | `PIXABAY_API_KEY` | https://pixabay.com/api/docs/ — free, self-service             |
| DVIDS             | video, image     | `DVIDS_API_KEY`   | https://api.dvidshub.net/ — issued to identified organisations |
| Wikimedia Commons | video, image     | none              | no key required                                                |
| Openverse         | image, **audio** | none              | anonymous access is rate-limited                               |

Check what is configured:

```sh
pnpm aamp:media providers
```

Other settings: `MEDIA_ACQUISITION_TIMEOUT_MS` (default 20 000),
`MEDIA_ACQUISITION_MAX_DOWNLOAD_BYTES` (default 512 MB),
`MEDIA_ACQUISITION_USER_AGENT` (Wikimedia's policy makes a descriptive,
contactable agent a condition of access), `MEDIA_ACQUISITION_OUTPUT_DIR`
(default `.aamp-output/acquired-assets`, git-ignored).

### Sources that are not integrated, and will not be

YouTube, TikTok, Instagram, Facebook, UFC, ONE Championship, DAZN, the Internet
Archive and social-media mirrors have **no adapter**, and asking for one by name
returns the reason rather than "unknown provider":

```sh
pnpm aamp:media search --query x --kind video --providers youtube
#   refused: "youtube" is not integrated and will not be: the standard YouTube
#   licence grants rights to YouTube, not to third parties, and downloading is a
#   terms violation
```

No `yt-dlp`, `gallery-dl`, browser scraper or unofficial downloader is installed
or used, and none may be added.

---

## 4. The commands

Seven commands over one acquisition run. They are separate rather than one
pipeline because the step between `inspect` and `approve` is **a person reading
a licence** — a single end-to-end command would have to either stop and wait or
skip it, and stopping in the middle of a pipeline is how "just press enter"
becomes the approval step.

### Search

```sh
pnpm aamp:media search \
  --query "boxing training cinematic" \
  --kind video \
  --orientation portrait \
  --providers pexels,pixabay,dvids,wikimedia
```

Optional: `--min-width`, `--min-height`, `--min-duration`, `--max-duration`,
`--page`, `--per-page`, `--json`.

Writes `.aamp-output/media-runs/<run-id>/` containing `run.json`,
`gallery.html` and `approval-template.json`. The run id is derived from the
request and the date, so re-running the same search overwrites its own artefacts
rather than leaving a drift of near-identical runs.

### Search by known provider asset id

When a review that happened elsewhere already named the exact items — a
shortlist, a contact-sheet pass, a colleague's list — a keyword query cannot
reliably reach them. `--ids` resolves them directly:

```sh
pnpm aamp:media search --ids 8745104,8745106,8473149 --kind video --providers pexels
```

It produces the same run, gallery and approval template as a keyword search,
and confers exactly the same thing: nothing above `RIGHTS_REVIEW_REQUIRED`.
The recorded `request.query` says `provider-asset-ids: …` rather than a keyword
nobody typed.

**Exactly one provider must be named.** An asset id is provider-scoped — id
`8745106` is a different item at every provider — and guessing which one the
operator meant is how the wrong footage gets acquired. Each id is resolved
independently, so one unreachable item is reported as its own problem and does
not discard the ones that resolved.

### Import an external candidate pack

```sh
pnpm aamp:media import-pack --path "C:\path\to\Candidate-Pack" [--measure]
```

Read-only. See §5.

### Inspect (measure the bytes)

```sh
pnpm aamp:media inspect --run <run-id> [--candidate <id>]
```

Measures every candidate with a local file against the source-quality profile
and rewrites the gallery. Search candidates are metadata only until acquired, so
they report `not measured` — accurately.

### Gallery

```sh
pnpm aamp:media gallery --run <run-id>
```

Regenerates `gallery.html`. Open it with a double-click. It shows, per
candidate: preview (local thumbnails embedded; remote previews are **links you
click**, because the page makes no network request on its own), provider,
creator, duration, resolution, the source-quality measurements, the five scores,
licence, attribution, risk flags, suggested campaign role, rejection and review
reasons, and the candidate id.

### Approve

Edit `approval-template.json` — replace every `TODO`, put your own name in
`approvedBy`, delete every candidate you are not approving — then:

```sh
pnpm aamp:media approve --run <run-id> --selection <approval-file>
```

### Acquire

```sh
pnpm aamp:media acquire \
  --run <run-id> \
  --selection <approval-file> \
  --output-dir .aamp-output/acquired-assets
```

Downloads only what the approval covers, hashes it, writes it under a
content-addressed filename, measures it with ffprobe and FFmpeg, and promotes it
only if it survives. `--accept-below-profile` keeps material that measures below
the profile — recorded on the asset, never inferred.

**The rendition downloaded is the rendition the approval selected.** A rendition
label is not a unique key: Pexels returns six renditions for one video all
labelled `unlabelled`, and several labelled `hd`. `resolveSelectedRendition`
therefore resolves a label with the same largest-area rule `selectBestRendition`
uses when the selection is recorded, so the two agree by construction rather
than by a provider happening to label uniquely. Found against the live API: a
2160×3840 approval downloaded 360×640, and the quality profile then refused the
result for being below the source floor — blaming the source rather than the
resolution.

### Build the manifest

```sh
pnpm aamp:media build-manifest \
  --run <run-id> \
  --output .aamp-output/acquired-assets/production-assets.json \
  --base-manifest packages/media/fixtures/preview-assets.json \
  --usage organic-social
```

Optional: `--bindings <file>` to bind assets to story beats, `--library`,
`--asset-dir`, `--usage paid-social|internal-evaluation`.

---

## 5. The external pilot-pack import

The importer reads an operator-assembled candidate folder that lives **outside**
the repository and is not version-controlled. Any equivalent folder path works;
no user-specific path is hardcoded anywhere in application logic.

It reads `source-candidates.csv`, `acquisition-log.csv`, `asset-inventory.csv`,
`rights-inventory.csv`, `candidates/licence-evidence/` and the candidate media
paths.

**It writes nothing to the pack.** Nothing is renamed, moved, deleted or
modified. Every guarantee:

- **Every path is untrusted.** Resolved _and_ `realpath`-ed, then re-checked for
  containment. A traversal (`..\..\Windows`) is `PATH_ESCAPE`; a symlink inside
  the pack pointing outside it is `SYMLINK_ESCAPE`; an absolute path is refused.
- **Checksums are recalculated, never read.** The CSV's `sha256` is compared
  against the recalculation; a disagreement is a `CHECKSUM_MISMATCH` problem and
  the _recalculated_ value is what travels onward.
- **Duplicates are detected by content**, not by filename.
- **Identifiers are cross-checked** across all four CSVs. An acquisition row for
  a candidate the catalogue does not list, a rights row for an asset the
  inventory does not list, an inventory row with no rights row, and a candidate
  with two download rows are all reported.
- **`references/` is refused as production media**, by _location_, before any
  rights column is consulted. A row declaring `CC0` for a file under
  `references/` is still refused.
- **Media is inspected through the existing ffprobe/FFmpeg utilities**, with
  `--measure`. Without it, the checksum is still recalculated and every
  measurement-derived field is `null` and says why.
- **External absolute paths stay in private provenance.**
  `private-provenance.json` is the only artefact permitted to hold a local path;
  `run.json`, the gallery, the credits and the manifest never do.
- **No credential or protected direct-download URL is ever persisted.**
- **Nothing imported is output-eligible.** Every candidate lands at
  `RIGHTS_REVIEW_REQUIRED` at best. A candidate the rights policy rejects stops
  at `METADATA_VERIFIED`.
- **A broken row does not stop the import.** Per-record problems are named and
  the rest of the library is imported.

---

## 6. The source-quality profile

`COMBAT_REVIEWS_PREMIUM_SOURCE_V1`. Every value is measured from the actual
bytes — never a declared width, a catalogued duration or a claimed frame rate.

### Measured

Codec and container, width, height, duration, frame rate, pixel format, bitrate,
decode failure, black-frame ratio, freeze ratio, scene count, scene changes per
minute, longest usable run, duplicate-content checksum, vertical-crop
feasibility, audio-stream presence, loudness and clipped samples where audio
exists.

### Minimum technical requirements

- No source below **1920×1080** (in either orientation) unless explicitly
  approved for a small overlay, which is recorded with the operator's written
  reason.
- **4K preferred** — a long edge below 3840 px clears the floor but is flagged.
- **An upscale never satisfies the resolution requirement.** A 1280×720 source
  scaled to 1920×1080 is still a 720-line source, and the refusal says so.
- Frame rate at least **24 fps**.
- No zero-byte or undecodable file.
- Watermark and burned-in-text status is **never claimed automatically**;
  uncertain watermark or logo status is a human check on every item.
- Footage with less than **2 seconds** of usable run requires explicit
  justification.
- Excessive black or freeze (> 25% each) fails.
- An unsupported codec or container fails **here**, before a render is
  attempted.

### The five scores

`technicalQualityScore`, `editUtilityScore`, `verticalSuitabilityScore`,
`rightsConfidenceScore`, `overallSourceScore` — separate fields, because they
answer different questions and one number would hide which failed. All are
deterministic functions of measurements and rights outcomes; nothing reads a
clock.

Ranked higher: clean movement, usable shot length, crop safety, shot variety,
source resolution, low compression damage, editing flexibility.

**No machine-measured "cinematic quality" is reported anywhere**, because no
reliable measurement of it exists. `humanChecksRequired` names what a person
must judge: watermarks, burned-in captions, third-party logos, and whether the
shot actually reads as premium. Human creative scoring stays separate.

### The vertical-crop measurement worth knowing

A 3840×2160 source crops to **1215 px** wide at 9:16 — clears the 1080 floor. A
1920×1080 source crops to **607 px** — it does not, and would have to be
upscaled. That number is why "it's HD, it'll be fine" is not a plan.

---

## 7. Licence policy

Version `MEDIA_RIGHTS_POLICY_V1`. Three rules, in order:

1. **Rejection is absolute.** Nothing later rescues it — not a clean
   measurement, not a high score.
2. **Review is sticky.** One trigger makes the whole decision
   `REVIEW_REQUIRED`, however many clean facts sit beside it.
3. **Automatic eligibility is the residue** — what is left when nothing
   objected, never something a fact affirmatively grants.

### Automatically eligible (after every other check)

CC0 · Public Domain · Public Domain Mark · US Government public domain · CC BY
(with a generated credit) · Pexels Licence · Pixabay Content Licence.

### Always review-required

CC BY-SA (share-alike binds the _finished advertisement_, and how this
repository's output is licensed is not a decision code makes) · identifiable
people · athlete or fighter likenesses · trademarks, logos and brands · military
personnel or markings · uncertain model or property releases · ambiguous
paid-advertising permission · any source-specific restriction phrase.

### Always rejected

NonCommercial · NoDerivatives · editorial-only · personal-use-only · restricted
· unknown · unverifiable · social-media rip · standard YouTube licence ·
copyrighted broadcast footage.

Every rejection names the specific term that blocked it.

### DVIDS is stricter than the rest

DVIDS hosts US Government public-domain work **and** separately copyrighted
contractor, coalition and commercial material. So the adapter inverts the usual
default: an item is public domain only when the response says so **at item
level**, matched against a closed list of values as a whole trimmed string. A
commercial credit line (`Getty`, `Reuters`, `Courtesy photo`, `©`) outranks a
public-domain field. Anything ambiguous is `UNKNOWN`, which the policy refuses.

Every DVIDS item also carries `recognizablePersonRisk: PRESENT`,
`endorsementRisk: HIGH` and a non-endorsement obligation that forces human
review, always. The journalist and unit credit is preserved even though public
domain does not compel one.

### Openverse aggregates, which changes the download rule

Openverse's `url` points at whichever upstream host holds the file. Following
that blindly would turn a search response into arbitrary outbound requests, so
downloads are restricted to a short allowlist of upstream hosts whose terms are
known (Wikimedia, Flickr, Freesound). Anything else is refused with the host
named. Openverse has **no video**, and a video request is refused by name rather
than returning an empty page.

---

## 8. Human approval

An approval record contains: candidate id, approver identity, approved usages
(`INTERNAL_EVALUATION` / `ORGANIC_SOCIAL` / `PAID_SOCIAL`), approved platforms,
effective date, expiry, evidence references, notes and a timestamp.

`approvedBy` has no default and never will. `notes` is required — an unexplained
approval is a rubber stamp. `aamp:media approve` refuses an approval that:

- names a candidate the run does not hold;
- was written against a different run;
- targets a candidate the rights policy rejected;
- targets a candidate not at `RIGHTS_REVIEW_REQUIRED` (a station was skipped);
- is out of date or not yet effective;
- claims a usage the policy did not leave open — the fix is to reconcile the
  policy reading, not the approval form;
- claims `PAID_SOCIAL` where the source's paid-advertising permission is not
  `PERMITTED`.

### The lifecycle, and why no state may be skipped

```
DISCOVERED → METADATA_VERIFIED → RIGHTS_REVIEW_REQUIRED
  → APPROVED_FOR_DOWNLOAD → DOWNLOADED → INSPECTED → OUTPUT_ELIGIBLE
```

`RIGHTS_REVIEW_REQUIRED` is a mandatory station rather than a branch: even a CC0
item passes through it, because the record that somebody looked at _this item's_
rights is the artefact, not the outcome. `DOWNLOADED` and `INSPECTED` are
separate because bytes arriving says nothing about what is in them.
`assertLifecycleTransition` refuses a skip and names what was skipped.
`REJECTED` is terminal and reachable from any station.

---

## 9. Private evaluation versus production output

`INTERNAL_EVALUATION` is **not a weaker production grade — it is a different
kind of permission.**

Material approved only for internal evaluation:

- is **refused by name** from a campaign manifest, so an operator is told which
  asset they cannot use rather than quietly getting a shorter library;
- builds only a visibly and structurally labelled demonstration: the manifest's
  `library` carries `— INTERNAL EVALUATION DEMONSTRATION`, and every affected
  asset carries the restriction `INTERNAL EVALUATION ONLY — this asset may not
appear in a published advertisement`;
- can never become a production campaign asset.

```sh
pnpm aamp:media build-manifest --run <id> --output <path> --usage internal-evaluation
```

---

## 10. Production versus reference separation

|                              | Production assets (this pipeline)                | Creative Memory references                 |
| ---------------------------- | ------------------------------------------------ | ------------------------------------------ |
| Rights vocabulary            | `OWNED` / `COMMISSIONED` / `LICENSED_FOR_OUTPUT` | `ANALYSIS_ONLY` and friends                |
| May enter an output manifest | yes, after approval                              | **never**                                  |
| Tables / storage             | `Asset`, `.aamp-output/acquired-assets/`         | `reference_*`, `.aamp-reference-analysis/` |
| Indexed into Qdrant          | **never**                                        | yes                                        |

Licence families project onto the **existing** rights vocabulary — a CC0 file
becomes `LICENSED_FOR_OUTPUT`, not a new `PUBLIC_DOMAIN_ACQUISITION` class.
Adding a class would mean every existing rights check had to learn about it, and
the one that forgot would be the hole. The production manifest never learns an
acquisition was involved.

Pexels, Pixabay, DVIDS, Wikimedia and Openverse production content is **never**
automatically indexed into Creative Memory.

---

## 11. Credits and evidence

`acquire` writes five files into the output directory:

| File                          | What it is for                                                             |
| ----------------------------- | -------------------------------------------------------------------------- |
| `acquired-assets.json`        | **canonical.** The full record; `build-manifest` reads this one.           |
| `credits.json`                | machine-readable credit entries                                            |
| `CREDITS.md`                  | what you publish — licence-required credits first, courtesy credits second |
| `rights-report.json`          | the rights position and every decision behind it                           |
| `acquisition-provenance.json` | the chain from delivered file back to origin                               |
| `source-quality-report.json`  | what was measured, what was not, and what a person must still check        |

The provenance chain preserved: finished MP4 → production manifest → asset id →
acquired asset → candidate → provider asset → landing page → creator → licence →
approval record → downloaded checksum → selected in/out points (recorded by the
existing render manifest).

**Nothing here holds a credential, a signed URL, a local path or a byte of
media.** `assertMediaArtefactSafe` walks every artefact before it is written and
fails closed on API keys, credentials in query strings, bearer tokens, JWTs,
private keys, email addresses, the forbidden-key list (including
`directDownloadUrl`, `signedUrl`, `downloadUrl`) and local absolute paths. Two
of the three keyed providers authenticate by **query parameter**, so provenance
records a host and a pathname and never a URL with a query string.

Licence evidence, media files, screenshots, credentials and generated output are
never placed in git — everything lands under the git-ignored `.aamp-output/`.

---

## 12. Feeding the existing generator

The manifest is accepted directly by the existing generation and rendering path.
`aamp:generate` is not duplicated, and neither is the renderer, the capture
implementation, Creative Memory or the asset repository.

```sh
pnpm aamp:media build-manifest --run <id> \
  --output .aamp-output/acquired-assets/production-assets.json \
  --base-manifest <your committed brand manifest>

pnpm aamp:generate --assets .aamp-output/acquired-assets/production-assets.json ...
```

The manifest is re-parsed through `parseProductionAssetManifest`, so it faces
exactly the same `.strict()` schema and cross-field rules as a hand-written one
— including the `ANALYSIS_ONLY` and `UNKNOWN_RIGHTS` refusals and the "at least
one LOGO" requirement.

Combined manifests are supported and are the intended shape: approved live
Combat Reviews UI captures, approved real combat footage, approved images,
approved music and approved SFX in one library. `--base-manifest` merges
acquisitions over an existing library; matching ids are **replaced** and their
plan bindings (`role`, `beats`, `tags`) are preserved, exactly as the capture
merge does.

The renderer prefers real production footage. AI-generated footage remains a
gap-filling option — unavailable hero shots, transitions, abstract backgrounds,
product-animation bridges — and does not replace authentic combat footage
automatically.

---

## 13. Tests

Ordinary tests make **zero network calls and zero paid calls**. Providers are
driven against a deterministic loopback fixture server
(`@combat/providers/testing`), and media is generated locally from FFmpeg
`lavfi` sources.

```sh
pnpm --filter @combat/providers test    # 96 media-acquisition tests
pnpm --filter aamp-cli test             # includes 80 media tests
```

Covered: every provider response normalization; missing API keys; pagination;
rate limits; timeouts; cancellation; malformed responses; provider error
mapping; SSRF protection; redirect-host escape; oversized files; invalid magic
bytes; path traversal and symlink escape; external-pack checksum verification;
duplicate detection; reference/production separation; the full licence
allow/review/reject matrix; paid-social restrictions; the recognizable-person
review requirement; DVIDS restrictions; CC BY attribution generation; CC BY-SA
review; NC/ND rejection; quality measurement against real bytes; the no-upscale
loophole; low-resolution rejection; black/freeze rejection; approval non-bypass;
`INTERNAL_EVALUATION` isolation; workspace isolation; provenance completeness;
secret and log redaction; that no production asset can enter Creative Memory;
and that the produced manifest is accepted by the existing generator.

### Live provider tests (opt-in, never in CI)

```sh
MEDIA_LIVE_TEST=1 pnpm --filter @combat/providers test:media-live
```

They skip **loudly**, naming exactly what was not exercised. They are
inspection-only: `search` and `healthcheck` only, no download, no spend, no
approval. Only a passing live test may raise an adapter's
`responseContractStatus` from `DOCUMENTED_NOT_EXECUTED` to
`EXECUTED_AGAINST_LIVE_API`.

---

## 14. What is proven, and what is not

### Proven

- **The full chain, end to end, offline**: search → rights policy → gallery →
  approval → acquire → measure → promote → manifest, with a real 3840×2160
  h264 clip measured by ffprobe and FFmpeg (`widthPx: 3840`, `frameRate: 30`,
  `blackRatio: 0`, `verticalCropWidthPx: 1215`), producing a manifest the
  **existing** `parseProductionAssetManifest` accepts unchanged.
- **The approval gate cannot be bypassed**: a candidate that never reached
  `APPROVED_FOR_DOWNLOAD` is refused with the skipped stations named; an
  expired, mis-targeted or over-reaching approval is refused; an approval file
  written against a different run is refused.
- **Provider success never marks an asset usable**: a download that returns 200
  with a plausible file but cannot be measured leaves zero assets and does not
  promote the candidate.
- **`INTERNAL_EVALUATION` isolation**: refused by name from a campaign manifest,
  and its demonstration manifest is labelled in both the library name and every
  affected asset's restrictions.
- **No credential reaches any artefact**: the fixture API key appears in no run
  record, gallery, template or report.
- **Read-only calibration against the real external pilot pack** — see §15.

### Not proven

- **No live provider API has been contacted.** No key is configured on this
  machine, so all five adapters carry
  `responseContractStatus: DOCUMENTED_NOT_EXECUTED`: their response schemas are
  a reading of published provider documentation, verified against a fixture
  server, and **not** against a live API. The opt-in live test is written and
  has never run.
- **No third-party media has been downloaded.** Every byte measured in the tests
  is FFmpeg `lavfi` output or a file already in the operator's own folder.
- **Creative quality is not measured and is not claimed.** The source profile is
  a technical and rights verdict only.
- **No rights declaration is verified to be _true_.** The policy enforces the
  terms it is told about; it cannot verify that a provider's licence statement
  is correct, and Openverse explicitly does not verify its upstreams'.
- **Watermark, burned-in-caption and logo presence are not detected.** They are
  human checks on every item, by design.

---

## 15. Read-only calibration against the external pilot pack

Run on 2026-07-27 against `C:\Users\rtayl\Desktop\Combat-Reviews-Pilot-01`.
Results were written only under `.aamp-output/`; **the external folder was not
modified**, and no candidate was approved.

|                                                                       |                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------- |
| candidate rows                                                        | 537                                                 |
| acquisition rows                                                      | 135                                                 |
| media files located                                                   | 115                                                 |
| media missing                                                         | 0                                                   |
| checksums **recalculated and verified** against `acquisition-log.csv` | 115                                                 |
| checksum mismatches                                                   | 0                                                   |
| duplicate content                                                     | 0                                                   |
| `references/` refused as production media                             | 0 (no reference row appears in the acquisition log) |
| licence-evidence files counted (never copied)                         | 42                                                  |
| candidates above `RIGHTS_REVIEW_REQUIRED`                             | **0**                                               |

The 135-versus-115 gap is fully explained: 20 candidates carry **two** download
rows each in `acquisition-log.csv`. Each is reported by candidate id with both
line numbers and which row the import used — a real finding about the pack that
the checksum verification alone would not have surfaced.

Every located file's SHA-256 was recalculated from the bytes and agreed with the
log, which is the strongest statement available here: the pack's own record of
what it downloaded is accurate.

### Source-quality measurement (`inspect`)

All 115 located files were measured with ffprobe and FFmpeg. The remaining 422
candidate rows have no local file and are reported `not measured`, accurately.

|                               |         |
| ----------------------------- | ------- |
| measured                      | 115     |
| meets profile                 | 17      |
| review required               | 3       |
| below profile                 | 95      |
| detected as `IMAGE` / `VIDEO` | 90 / 25 |
| **declared-kind mismatches**  | **60**  |

Of the 95 below-profile files, 94 are below the 1920×1080 source floor — mostly
preview-sized downloads rather than deliverable masters. One fails on frame
rate, one on usable run length and one on black content. The 17 that pass are
all high-resolution Wikimedia Commons stills (the largest, `WC-202`, measures
4863×6016 and scores 75 overall).

### A defect this calibration found

The first calibration run refused 60 files with _"the video codec `mjpeg` is not
one the renderer accepts"_ — a confident, precise, **wrong** answer. Those 60
files are catalogued as `media_kind: video` in `source-candidates.csv` and are
actually JPEGs, so the profile was applying the video floor to a still.

That was a declaration being treated as a measurement, which is the one thing
this profile exists not to do. The fix: `measureSourceMedia` now derives
`detectedMediaKind` from the probe and the evaluation is applied against **that**,
with the disagreement recorded on every affected item as
`declaredMediaKindMismatch` and surfaced as a review reason naming both values.

Detecting it correctly turned out to need the container name rather than the
frame count. ffprobe reports a JPEG as container `image2` with a **synthetic
0.04-second duration**, a `25/1` frame rate and no `nb_frames` field at all — so
the conventional "one frame and zero duration" heuristic reads a still as a
0.04-second video. `isStillImageContainer` matches `image2` and the `_pipe`
demuxers instead. This is exactly the class of thing a fixture-only suite does
not surface: it took a real library of somebody else's files.

---

## 16. Current limitations

1. **No provider API key is configured on this machine**, so no live search has
   ever run. Five adapters, zero executed contracts.
2. **DVIDS response field names are the least certain** of the five. The adapter
   handles `rights`, `copyright` and `usage` and treats the absence of all three
   as ambiguous — which fails safe, but means a live DVIDS run may classify
   everything `UNKNOWN` until the real field name is confirmed.
3. **Openverse downloads are limited to three upstream host families.** Anything
   else is refused by name and must be acquired deliberately by hand.
4. **Audio has one source.** Openverse is the only audio provider here; Pexels
   and Pixabay publish audio on their sites but expose no audio search API, and
   claiming otherwise would be a fabrication.
5. **`inspect` measures serially.** Two whole-clip decode passes per video over
   a hundred-file library is minutes of work; `--measure` on `import-pack` is
   off by default for the same reason.
6. **The pack importer does not read `campaign-notes.txt`,
   `collection-checklist.md`, `provider-access-blockers.md`,
   `reference-library.csv` or `candidate-gallery.html`.** They are operator
   documents, not machine inputs.
7. **No Prisma model was added.** Acquisition runs live on disk under
   `.aamp-output/`, like every other CLI-side artefact; the campaign-lifecycle
   tables remain keyed to `Campaign` rows only the workflow path creates.
