# Runbook — the storyboard-driven flagship advertisement

`pnpm aamp:flagship` turns a verified eight-panel storyboard, a library of real
Combat Reviews material and an authored creative plan into one 15-second
1080×1920 master, with the evidence for every claim made about it.

It is a **vertical production** command, not an infrastructure one. Everything
that makes the advertisement — asset preflight, rights enforcement,
deterministic segment selection, the motion catalogue, the filter graph,
actual-media QA — is the existing zero-cost footage-first preview
(`docs/runbooks/zero-cost-footage-first-preview.md`), called unchanged. What
this milestone adds is the storyboard contract around it.

---

## 1. What it does, in order

1. **Verifies the storyboard package.** Eight panels, contiguous timings
   tiling exactly 15 s, every frame re-hashed against the package's own
   `source-checksum.txt`, and `REFERENCE_ONLY` / `outputEligible: false`
   required at package level _and_ on every frame.
2. **Loads the committed campaign source** — the brief, the authored plan, the
   approved production treatment and the recorded substitutions.
3. **Holds the copy to what can be verified.** Every authored string is walked
   against a closed prohibited-claim vocabulary. A refusal names the field, the
   match, the reason and what to write instead.
4. **Proves the plan executes the storyboard.** Eight beats whose settled
   starts and ends land on the storyboard's eight slots.
5. **Builds the declared discussion mockup** — geometry plus the real mark, no
   text of any kind.
6. **Reconciles assets across every declared pack**, read-only, hashing every
   media file it finds, and records what was considered as well as what won.
7. **Stages** only what the cut uses into a root the run owns, verifying every
   copy's checksum against the original's.
8. **Proves nothing reference-shaped can reach the encoder** — every file in
   the staging root, before FFmpeg is invoked.
9. **Renders** through the preview path, unchanged.
10. **Proves it again** over the render manifest that was actually used.
11. **Samples review frames**, writes the gallery and the contact sheet.
12. **Scores** the 100-point agency benchmark scorecard.
13. **Writes** run provenance and a self-checksummed sidecar.

## 2. Running it

```sh
pnpm aamp:flagship `
  --storyboard C:\Users\rtayl\Desktop\Combat-Reviews-Flagship-Storyboard-01 `
  --work-pack C:\Users\rtayl\Desktop\Combat-Reviews-Work-01 `
  --premium-pack C:\Users\rtayl\Desktop\Combat-Reviews-Premium-Pack-01 `
  --pilot-pack C:\Users\rtayl\Desktop\Combat-Reviews-Pilot-01 `
  --output-dir .aamp-output\combat-reviews-flagship-01
```

`--work-pack` must contain `asset-root/assets.json`. `--premium-pack` and
`--pilot-pack` are optional; a pack that is not present is recorded as a
finding rather than treated as an error, so "we had nothing for this beat" is
always a checked claim.

The last line on stdout is the master's path. Everything else goes to stderr.

## 3. The labels, and why no flag can change them

Every run writes:

```
executionMode:      HUMAN_ASSISTED_PREVIEW
outputUse:          INTERNAL_REVIEW
isRealCampaignRun:  false
paidProviderCalls:  0
```

These are module constants, not options. The command's whole flag surface is
where the storyboard is, where the packs are and where the output goes: there
is no `--execution-mode`, no `--allow-paid-providers`, no `--output-use`, and
an unrecognised flag is refused by name rather than ignored. A test asserts
each promoting flag is rejected.

Nothing on this path constructs a reasoning provider, a generation provider or
a database client, and a source-level test asserts none of the modules can
even import one. The acceptance suite runs with `REASONING_PROVIDER=claude`
and no API key — a configuration in which a campaign run exits 3.

## 4. The storyboard is REFERENCE_ONLY, proven twice

The package declares it; that is a promise. This milestone also wants
evidence, so exclusion is proven by **content and location**, twice:

- **Before the render**, over the staging root — the only media root the
  renderer may read. Every file is hashed and compared to every storyboard
  checksum. A reference frame could not enter the output even through a
  manifest defect.
- **After the render**, over the render manifest that was actually used. Every
  source is re-hashed from disk rather than trusted from its
  `expectedChecksum`, because the manifest is the thing being checked.

Both proofs land in `reference-exclusion-proof.json`. A violation throws: there
is no mode in which a run continues having failed to show reference material
stayed out.

## 5. Factual corrections

The storyboard's panels carry placeholder data, and the panels say so in their
own `factualClaimsRequiringValidation`. `factual-sanitisation.ts` turns that
list into refusals. The gate **refuses, it never rewrites** — silently deleting
"12" and rendering "FIGHT EVENTS THIS WEEKEND" would be application code
editing the advertisement's copy.

It walks authored strings only. A real product capture showing real fighters on
a real card is the product being honest about itself and is not the gate's
business.

Corrections made for this cut:

| Storyboard                                | Rendered                              | Why                             |
| ----------------------------------------- | ------------------------------------- | ------------------------------- |
| "12 FIGHT EVENTS THIS WEEKEND"            | no count at all                       | no verified live feed           |
| "IRON CLASH 28", "J. NOVAK", "R. ALVAREZ" | nothing                               | invented promotion and fighters |
| "62% / 34,587 VOTES", "2.3k votes"        | the real split, inside a real capture | fabricated community data       |
| "PREDICTIONS CLOSE IN 02:14:32"           | nothing                               | invented deadline               |
| "DOWNLOAD FREE" + two store badges        | "OPEN COMBAT REVIEWS"                 | no verified public listing      |
| "FightFan88", "StrikerX", …               | no identity of any kind               | invented handles                |
| "SAT, MAY 24" and the event module        | nothing                               | fictional scheduling            |

The approved call to action is **NEVER MISS FIGHT NIGHT.** / **OPEN COMBAT
REVIEWS** / _Every combat sport. One place._

## 6. The discussion PRODUCT_MOCKUP

Combat Reviews' discussion region returns an "unavailable" state to the
read-only capture path, so no usable real capture exists. The beat is built
instead, and what makes that honest is what the mockup does **not** contain:

- **No text.** Not one glyph — no handle, comment, count, timestamp or topic.
  Every word the beat says arrives through the caption track, which passes the
  prohibited-claim gate like any other copy.
- **No invented brand.** The one non-geometric element is the real, `OWNED`
  Combat Reviews mark, composited from the logo file.
- **No claim to be a capture.** Provenance class `PRODUCT_MOCKUP`, stated in
  the asset id, the description, the restrictions and
  `product-mockup-provenance.json`.

It is declared `role: BRAND_CARD`, not `APP_SCREENSHOT` — calling a designed
graphic a screenshot would make the vocabulary itself say something untrue.

## 7. The scorecard

100 points across ten dimensions, split structurally:

- **Three are verifiable** (product comprehension 15, music and sound design 7,
  originality/platform/CTA 5 — 27 points). They score, and each states the
  facts it read.
- **Seven are craft judgements** (73 points). They carry
  `HUMAN_JUDGEMENT_REQUIRED` and `awardedPoints: null` — not 0, because a zero
  is a judgement too and nobody made it.

`AGENCY_GRADE` is unreachable from here by construction. The best a run can
reach is `AWAITING_HUMAN_CRAFT_REVIEW`; a temporary-audio master is
`BLOCKED_FROM_AGENCY_GRADE` regardless of what anyone scores. No function in
this repository produces, suggests or defaults a craft score.

## 8. Audio is temporary, and that is a blocking defect

No real music or sound-effect file exists in any pack — `audio/music` and
`audio/sfx` are empty in both the premium and pilot packs, and the work pack's
WAVs are declared `TEMPORARY` synthetic `lavfi` sources. So:

- the master carries temporary audio and says so in every artefact;
- `MUSIC_SOUND_DESIGN` scores **0 of 7**, not partial credit — synthetic tones
  are not a mix, and a partial score would make the number mean the opposite of
  what a reader assumes;
- `TEMPORARY_AUDIO` is a blocking defect on the scorecard.

The absence of real music does not block seeing the visual cut. It does block
calling it finished.

## 9. The one new media primitive

`MOTION_TREATMENT_CATALOGUE_VERSION` is **3**. The flagship added a `GRADE`
family with two entries:

- `BRAND_NOIR` — contrast, crushed blacks, reduced saturation. Unifies without
  tinting.
- `BRAND_EMBER` — the same, plus a red lift through the shadows and midtones
  only. The highlights are left alone, so a grade never becomes a colour cast.

Grades are a separate family from scene treatments because grading is
orthogonal to movement. `scenes[].grade` is a strictly additive v2 field and
`manifestVersion: 1` refuses it by name.

Product screens are deliberately left **ungraded**: legibility of the real
interface outranks palette unity, and a tinted screenshot misrepresents the
product. A test asserts every product beat in the committed plan is ungraded.

Also added: optional `brandConstraints.logoWindows` on the plan, so the mark
can be taken off screen while a product screenshot is being read. Absent keeps
the previous behaviour — the whole cut.

## 10. Artefacts

Written to `--output-dir`:

| File                                                                 | What it holds                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------- |
| `<name>-<hash>.mp4`                                                  | the master                                              |
| `<name>-<hash>.mp4.qa.json`                                          | actual-media QA, the binding measurements               |
| `flagship-gallery.html`                                              | the review page — no script, no network                 |
| `flagship-contact-sheet.png`                                         | one sampled frame per beat                              |
| `asset-reconciliation.json`                                          | the beat-by-beat table, plus every candidate considered |
| `storyboard-verification.json`                                       | frame checksums and the claims needing validation       |
| `storyboard-conformance.json`                                        | the eight slots the plan landed on                      |
| `reference-exclusion-proof.json`                                     | both proofs                                             |
| `product-mockup-provenance.json`                                     | what the mockup is and is not                           |
| `agency-scorecard.json`                                              | the 100-point scorecard                                 |
| `flagship-provenance.json` + `.checksum.json`                        | the sealed run record                                   |
| `render-manifest.json`, `storyboard.json/html`, `audio-plan.json`, … | the preview path's own artefacts                        |

`.aamp-output/` is git-ignored. No media, no run output and nothing from an
external pack is ever committed.

## 11. Determinism

Same inputs and same toolchain produce a byte-identical master. The staging
step is idempotent by content — a staged file that already hashes correctly is
left alone, so a second run costs no copying. The acceptance suite renders
twice and asserts both the master checksum and the render manifest (every
source checksum included) are identical.

## 12. Tests

- `src/flagship/flagship-contracts.test.ts` — 63 tests, no FFmpeg, always runs
  in CI. Storyboard integrity, prohibited claims, storyboard conformance,
  reference exclusion, reconciliation and staging, mockup geometry, the
  scorecard, and the flags that cannot promote a label.
- `src/flagship/flagship-acceptance.test.ts` — 9 tests, needs a real FFmpeg and
  **skips loudly** without one. Builds its own storyboard, library and plan in
  a temporary directory; never reads the operator's Desktop.

## 13. What this proves, and what it does not

**Proven.** A genuine ffprobe-verified 1080×1920 h264/yuv420p MP4 at exactly
15.000 s with AAC stereo at 48 kHz, faststart, passing actual-media QA; eight
beats landing exactly on the storyboard's eight slots; every storyboard frame
absent from the output by checksum and by path, proven before and after the
render; the corrected CTA; a mockup with no fabricated identity in it; zero
paid provider calls as a property of the object graph; and byte-identical
re-rendering.

**Not proven.** Creative quality. Seven of the ten scorecard dimensions carry
no number because no machine can supply one. The cut is `INTERNAL_REVIEW`, it
is not agency-grade, and it is blocked from that claim by its temporary audio
alone.
